import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertArrayIncludes,
} from "https://deno.land/std@0.212.0/assert/mod.ts";
// No KV interaction for rooms currently, but if history or persistent rooms are added, mockKv would be needed.
// import { mockKv } from "../../../test_utils/mock_kv.ts";
// import * as db from "../../database.ts";

import {
  roomWebSocketHandler,
  // 'rooms' map is internal to room.ts, testing via WebSocket interactions
} from "./room.ts";
import {
  RoomMessage,
  ServerUserJoinedMessage,
  ServerUserLeftMessage,
  ServerChatMessage,
  ServerRoomInfoMessage,
  ClientChatMessage,
} from "../../../shared/room.ts";

// --- Mock WebSocket ---
// Simplified for room tests, focusing on message exchange and lifecycle.
class MockRoomWebSocket {
  static instances: MockRoomWebSocket[] = [];
  public readyState: number = WebSocket.CONNECTING;
  public sentMessages: RoomMessage[] = []; // Store parsed messages
  public closed: boolean = false;
  public closeCode?: number;

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event | ErrorEvent) => void) | null = null;

  constructor() {
    MockRoomWebSocket.instances.push(this);
  }

  send(message: string) {
    try {
      this.sentMessages.push(JSON.parse(message) as RoomMessage);
    } catch (e) {
      console.error("MockWebSocket: Failed to parse outgoing message", message, e);
      // Store as raw if parsing fails, or throw depending on test needs
      this.sentMessages.push({ type: "raw_unparsed", payload: message } as any);
    }
  }

  close(code?: number, _reason?: string) {
    if (this.readyState === WebSocket.OPEN || this.readyState === WebSocket.CONNECTING) {
      this.readyState = WebSocket.CLOSING;
      setTimeout(() => { // Simulate async close
        this.readyState = WebSocket.CLOSED;
        this.closed = true;
        this.closeCode = code;
        if (this.onclose) {
          this.onclose(new CloseEvent("close", { code }) as CloseEvent);
        }
      }, 0);
    }
  }

  // Test utility methods
  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    if (this.onopen) this.onopen();
  }

  simulateMessage(data: ClientChatMessage | any) { // Allow sending other types for testing errors
    if (this.readyState !== WebSocket.OPEN) throw new Error("WebSocket not open for simulating message");
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data: JSON.stringify(data) }) as MessageEvent);
    }
  }
  
  simulateError(message = "Mock WebSocket error") {
    if (this.onerror) {
        this.onerror(new ErrorEvent("error", { message }));
    }
    if (this.readyState === WebSocket.OPEN || this.readyState === WebSocket.CONNECTING) {
        this.close(1006, "Simulated error then close");
    }
  }


  static resetInstances() {
    MockRoomWebSocket.instances = [];
  }

  // Helper to find a message of a specific type
  findMessage<T extends RoomMessage>(type: T["type"]): T | undefined {
    return this.sentMessages.find(msg => msg.type === type) as T | undefined;
  }
}

// Mock Deno.upgradeWebSocket
const mockRoomUpgradeWebSocket = (_request: Request): { response: Response; socket: WebSocket } => {
  const mockSocket = new MockRoomWebSocket();
  const headers = new Headers({ "Upgrade": "websocket", "Connection": "Upgrade" });
  return {
    response: new Response(null, { status: 101, headers }),
    socket: mockSocket as any,
  };
};

// --- Test Suite ---
Deno.testSuite("Room Service (services/mcp/server/room.ts)", async (t) => {
  const originalUpgradeWebSocket = (Deno as any).upgradeWebSocket;

  t.beforeEach(() => {
    MockRoomWebSocket.resetInstances();
    (Deno as any).upgradeWebSocket = mockRoomUpgradeWebSocket;
    // Clear internal 'rooms' map in room.ts - requires ability to reset module state or DI.
    // For now, tests assume clean state or test interactions between rooms if not reset.
    // A proper reset for 'rooms' map would require exporting a reset function from room.ts or DI.
    // Let's assume tests are ordered or designed to handle potentially shared 'rooms' state, or that rooms are uniquely named.
  });

  t.afterAll(() => {
    (Deno as any).upgradeWebSocket = originalUpgradeWebSocket;
  });

  const connectClient = (roomId: string, apiKey?: string): MockRoomWebSocket => {
    const mockRequest = new Request(`http://localhost/mcp/room/${roomId}`, {
      headers: { "upgrade": "websocket", "sec-websocket-key": "test-key" },
    });
    roomWebSocketHandler(mockRequest, roomId, apiKey);
    const ws = MockRoomWebSocket.instances[MockRoomWebSocket.instances.length - 1];
    ws.simulateOpen();
    return ws;
  };

  await t.step("User Joins Room - Receives RoomInfo, Others Receive UserJoined", async () => {
    const roomId = "test-room-join";
    
    // Client 1 joins
    const client1Ws = connectClient(roomId, "apikey1");
    const client1UserId = (client1Ws.findMessage<ServerRoomInfoMessage>("roomInfo")?.payload.users[0].userId);
    assertExists(client1UserId, "Client 1 should get a userId via roomInfo");

    // Client 1 should get roomInfo
    const roomInfo = client1Ws.findMessage<ServerRoomInfoMessage>("roomInfo");
    assertExists(roomInfo, "Client 1 should receive roomInfo");
    assertEquals(roomInfo?.payload.roomId, roomId);
    assertEquals(roomInfo?.payload.users.length, 1);
    assertEquals(roomInfo?.payload.users[0].userId, client1UserId);

    // Client 2 joins
    const client2Ws = connectClient(roomId, "apikey2");
    const client2UserId = (client2Ws.findMessage<ServerRoomInfoMessage>("roomInfo")?.payload.users.find(u => u.userId !== client1UserId)?.userId);
    assertExists(client2UserId, "Client 2 should get a userId");

    // Client 2 should get roomInfo with both users
    const roomInfo2 = client2Ws.findMessage<ServerRoomInfoMessage>("roomInfo");
    assertExists(roomInfo2);
    assertEquals(roomInfo2?.payload.users.length, 2);
    assertArrayIncludes(roomInfo2!.payload.users.map(u => u.userId), [client1UserId, client2UserId]);

    // Client 1 should receive userJoined for Client 2
    // Need to wait for broadcast to happen
    await new Promise(r => setTimeout(r, 10)); 
    const userJoinedMsgForClient1 = client1Ws.sentMessages
        .filter(msg => msg.type === "userJoined")
        .map(msg => msg as ServerUserJoinedMessage)
        .find(msg => msg.payload.userId === client2UserId);
    assertExists(userJoinedMsgForClient1, "Client 1 should receive userJoined for Client 2");
    assertEquals(userJoinedMsgForClient1?.payload.roomId, roomId);
    
    // Client 2 should NOT receive userJoined for itself (broadcast excludes self for join)
    const userJoinedMsgForClient2 = client2Ws.sentMessages
        .find(msg => msg.type === "userJoined" && (msg as ServerUserJoinedMessage).payload.userId === client2UserId);
    assertEquals(userJoinedMsgForClient2, undefined, "Client 2 should not receive userJoined for self");
  });

  await t.step("Chat Message Broadcasting - Message sent to all in room", async () => {
    const roomId = "test-room-chat";
    const client1Ws = connectClient(roomId, "apikey1");
    const client2Ws = connectClient(roomId, "apikey2");
    const client3Ws = connectClient(roomId, "apikey3"); // Bystander

    const client1UserId = client1Ws.findMessage<ServerRoomInfoMessage>("roomInfo")!.payload.users[0].userId;
    
    // Client 1 sends a chat message
    const chatMessagePayload: ClientChatMessage = {
      type: "chatMessage",
      payload: { roomId, message: "Hello everyone!" },
    };
    client1Ws.simulateMessage(chatMessagePayload);
    await new Promise(r => setTimeout(r, 10)); // Allow broadcast to process

    // Verify Client 1 (sender) receives their own message back (or not, depending on design - current design broadcasts to all)
    const chatMsgForClient1 = client1Ws.sentMessages.find(
        msg => msg.type === "chatMessage" && (msg as ServerChatMessage).payload.message === "Hello everyone!"
    ) as ServerChatMessage | undefined;
    assertExists(chatMsgForClient1, "Client 1 should receive the broadcasted chat message");
    assertEquals(chatMsgForClient1?.payload.fromUserId, client1UserId);

    // Verify Client 2 (receiver) receives the message
    const chatMsgForClient2 = client2Ws.sentMessages.find(
        msg => msg.type === "chatMessage" && (msg as ServerChatMessage).payload.message === "Hello everyone!"
    ) as ServerChatMessage | undefined;
    assertExists(chatMsgForClient2, "Client 2 should receive the chat message");
    assertEquals(chatMsgForClient2?.payload.fromUserId, client1UserId);
    assertEquals(chatMsgForClient2?.payload.roomId, roomId);

    // Verify Client 3 (bystander) also receives the message
    const chatMsgForClient3 = client3Ws.sentMessages.find(
        msg => msg.type === "chatMessage" && (msg as ServerChatMessage).payload.message === "Hello everyone!"
    ) as ServerChatMessage | undefined;
    assertExists(chatMsgForClient3, "Client 3 should receive the chat message");
  });

  await t.step("User Leaves Room - UserLeft broadcast, room deleted if empty", async () => {
    const roomId = "test-room-leave";
    const client1Ws = connectClient(roomId, "apikey1");
    const client2Ws = connectClient(roomId, "apikey2");
    
    const client1UserId = client1Ws.findMessage<ServerRoomInfoMessage>("roomInfo")!.payload.users[0].userId;
    // const client2UserId = client2Ws.findMessage<ServerRoomInfoMessage>("roomInfo")!.payload.users.find(u => u.userId !== client1UserId)!.userId;

    // Client 1 leaves
    client1Ws.close(1000, "User initiated disconnect");
    await new Promise(r => setTimeout(r, 10)); // Allow close and broadcast

    // Client 2 should receive userLeft for Client 1
    const userLeftMsg = client2Ws.sentMessages
        .filter(msg => msg.type === "userLeft")
        .map(msg => msg as ServerUserLeftMessage)
        .find(msg => msg.payload.userId === client1UserId);
    assertExists(userLeftMsg, "Client 2 should receive userLeft for Client 1");
    assertEquals(userLeftMsg?.payload.roomId, roomId);

    // Client 2 leaves, making room empty
    client2Ws.close(1000, "User initiated disconnect");
    await new Promise(r => setTimeout(r, 10));
    
    // To verify room deletion, we'd need to inspect the internal 'rooms' Map in room.ts,
    // or try to connect a new client and see if it's a new room (e.g., user list is 1).
    // For now, this aspect is harder to test without exposing 'rooms' or its state.
    // Let's connect a new client and check roomInfo.
    const client3Ws = connectClient(roomId, "apikey3");
    const roomInfo3 = client3Ws.findMessage<ServerRoomInfoMessage>("roomInfo");
    assertExists(roomInfo3, "Client 3 should receive roomInfo");
    assertEquals(roomInfo3?.payload.users.length, 1, "Room should be new/empty before client 3, so only client 3 is present");
    assertEquals(roomInfo3?.payload.users[0].userId, client3Ws.findMessage<ServerRoomInfoMessage>("roomInfo")!.payload.users[0].userId);
  });
  
  await t.step("Invalid Message Type - Server sends error", async () => {
    const roomId = "test-room-invalid-msg";
    const clientWs = connectClient(roomId, "apikey-err");
    
    clientWs.simulateMessage({ type: "unknownMessageType", payload: {} });
    await new Promise(r => setTimeout(r, 10));
    
    const errorMsg = clientWs.findMessage<ServerErrorMessage>("error");
    assertExists(errorMsg, "Client should receive an error message for unknown type");
    assertStringIncludes(errorMsg!.payload.message, "Unknown message type");
  });
  
  await t.step("Non-WebSocket Request - Handler returns error", () => {
    const mockRequestHttp = new Request("http://localhost/mcp/room/test-room", {
      // No upgrade header
    });
    const response = roomWebSocketHandler(mockRequestHttp, "test-room", "any-key");
    assertEquals(response.status, 400, "Should return 400 for non-WebSocket requests");
    return response.json().then(body => {
        assertEquals(body.error, "WebSocket upgrade expected");
    });
  });

});
