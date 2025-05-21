import { v4 as uuidv4 } from "uuid";
import {
  RoomMessage,
  ServerUserJoinedMessage,
  ServerUserLeftMessage,
  ServerChatMessage,
  ServerRoomInfoMessage,
  ClientChatMessage,
  // ClientJoinRoomMessage, // Implicitly handled by WebSocket connection to roomId path
  // ClientLeaveRoomMessage, // Implicitly handled by WebSocket close
  ServerErrorMessage,
} from "../../../shared/room.ts";

interface RoomUser {
  userId: string;
  socket: WebSocket;
  apiKey?: string; // Optional: store if client is authenticated
  // metadata?: any; // e.g., display name
}

interface Room {
  roomId: string;
  users: Map<string, RoomUser>; // Map<userId, RoomUser>
  // history: ServerChatMessage["payload"][]; // Optional: for chat history
}

// In-memory store for active rooms
const rooms = new Map<string, Room>();

// Helper to broadcast messages to all users in a room
function broadcast(
  roomId: string,
  message: RoomMessage,
  excludeUserId?: string,
) {
  const room = rooms.get(roomId);
  if (!room) {
    console.warn(`[MCP Room] Attempted to broadcast to non-existent room: ${roomId}`);
    return;
  }

  const messageString = JSON.stringify(message);
  for (const user of room.users.values()) {
    if (user.userId !== excludeUserId && user.socket.readyState === WebSocket.OPEN) {
      try {
        user.socket.send(messageString);
      } catch (e) {
        console.error(
          `[MCP Room] Failed to send message to user ${user.userId} in room ${roomId}:`,
          e,
        );
        // Optionally, handle cleanup for broken sockets here, though onclose should also catch it.
      }
    }
  }
}

export function roomWebSocketHandler(
  request: Request,
  roomIdFromPath: string, // The roomId from the URL path, e.g., /mcp/room/:roomIdFromPath
  apiKey?: string, // API key if provided and validated by MCPService
): Response {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response(
      JSON.stringify({ error: "WebSocket upgrade expected" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { response, socket } = Deno.upgradeWebSocket(request);
  const userId = uuidv4(); // Generate a unique userId for this connection

  socket.onopen = () => {
    console.log(
      `[MCP Room] User ${userId} attempting to join room ${roomIdFromPath}. API Key: ${apiKey || "N/A"}`,
    );

    // Get or create the room
    let room = rooms.get(roomIdFromPath);
    if (!room) {
      room = {
        roomId: roomIdFromPath,
        users: new Map(),
        // history: [],
      };
      rooms.set(roomIdFromPath, room);
      console.log(`[MCP Room] Created new room: ${roomIdFromPath}`);
    }

    // Add user to room
    const roomUser: RoomUser = { userId, socket, apiKey };
    room.users.set(userId, roomUser);

    // Broadcast userJoined message to others in the room
    const userJoinedMessage: ServerUserJoinedMessage = {
      type: "userJoined",
      payload: {
        roomId: roomIdFromPath,
        userId: userId,
        timestamp: new Date().toISOString(),
      },
    };
    broadcast(roomIdFromPath, userJoinedMessage, userId); // Exclude self

    // Send roomInfo message to the newly joined user
    const usersInRoom = Array.from(room.users.values()).map((u) => ({
      userId: u.userId,
    }));
    const roomInfoMessage: ServerRoomInfoMessage = {
      type: "roomInfo",
      payload: {
        roomId: roomIdFromPath,
        users: usersInRoom,
        // history: room.history.slice(-50), // Send recent history if implemented
      },
    };
    socket.send(JSON.stringify(roomInfoMessage));

    console.log(`[MCP Room] User ${userId} successfully joined room ${roomIdFromPath}. Total users: ${room.users.size}`);
  };

  socket.onmessage = (event: MessageEvent) => {
    const room = rooms.get(roomIdFromPath);
    if (!room || !room.users.has(userId)) {
      // Should not happen if onopen logic is correct and user is not removed
      console.warn(`[MCP Room] Message from user ${userId} for room ${roomIdFromPath}, but user or room not found.`);
      const errMessage: ServerErrorMessage = { type: "error", payload: { message: "Room or user session not found."}};
      socket.send(JSON.stringify(errMessage));
      socket.close(1008, "Session error");
      return;
    }

    let parsedMessage: RoomMessage;
    try {
      parsedMessage = JSON.parse(event.data as string) as RoomMessage;
    } catch (e) {
      console.error("[MCP Room] Failed to parse client message:", event.data, e);
      const errMessage: ServerErrorMessage = { type: "error", payload: { message: "Invalid message format."}};
      socket.send(JSON.stringify(errMessage));
      return;
    }

    console.log(`[MCP Room] Message from user ${userId} in room ${roomIdFromPath}:`, parsedMessage);

    switch (parsedMessage.type) {
      case "chatMessage": {
        const clientMessage = parsedMessage as ClientChatMessage;
        const serverChatMessage: ServerChatMessage = {
          type: "chatMessage",
          payload: {
            roomId: roomIdFromPath,
            fromUserId: userId, // Server sets the fromUserId based on the connection
            message: clientMessage.payload.message,
            timestamp: new Date().toISOString(),
          },
        };
        broadcast(roomIdFromPath, serverChatMessage);
        // room.history.push(serverChatMessage.payload); // Add to history if implemented
        // if (room.history.length > 200) room.history.shift(); // Keep history bounded
        break;
      }
      // Handle other client message types like ClientLeaveRoomMessage if needed,
      // though leave is primarily handled by onclose.
      default:
        console.log(`[MCP Room] Unknown message type received from user ${userId}: ${parsedMessage.type}`);
        const errMessage: ServerErrorMessage = { type: "error", payload: { message: `Unknown message type: ${parsedMessage.type}`}};
        socket.send(JSON.stringify(errMessage));
    }
  };

  const handleLeave = () => {
    const room = rooms.get(roomIdFromPath);
    if (room && room.users.has(userId)) {
      room.users.delete(userId);
      console.log(`[MCP Room] User ${userId} left room ${roomIdFromPath}. Remaining users: ${room.users.size}`);

      const userLeftMessage: ServerUserLeftMessage = {
        type: "userLeft",
        payload: {
          roomId: roomIdFromPath,
          userId: userId,
          timestamp: new Date().toISOString(),
        },
      };
      broadcast(roomIdFromPath, userLeftMessage);

      // If room becomes empty, delete it
      if (room.users.size === 0) {
        rooms.delete(roomIdFromPath);
        console.log(`[MCP Room] Room ${roomIdFromPath} is empty and has been deleted.`);
      }
    }
  };

  socket.onclose = (event: CloseEvent) => {
    console.log(
      `[MCP Room] WebSocket closed for user ${userId} in room ${roomIdFromPath}. Code: ${event.code}, Reason: ${event.reason}`,
    );
    handleLeave();
  };

  socket.onerror = (errorEvent: Event | ErrorEvent) => {
    const errorMessage = (errorEvent as ErrorEvent)?.message || "WebSocket error";
    console.error(
      `[MCP Room] Error for user ${userId} in room ${roomIdFromPath}: ${errorMessage}`,
      errorEvent,
    );
    // onclose will typically follow an onerror event, so handleLeave() will be called there.
    // If not, ensure cleanup:
    // handleLeave(); // Call here if onclose isn't guaranteed after onerror.
  };

  return response;
}
