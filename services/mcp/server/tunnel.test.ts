import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
} from "https://deno.land/std@0.212.0/assert/mod.ts"; // Using a specific version for stability
import { mockKv } from "../../../test_utils/mock_kv.ts";
import * as db from "../../database.ts";
import {
  tunnelWebSocketHandler,
  activeTunnels, // For checking active connections
  // pendingHttpRequests // For later tests if needed
} from "./tunnel.ts";
import { TunnelRegistration, TunnelService }_from "../../../shared/tunnel.ts"; // Import shared types

// --- Test Setup ---
// Replace the real Deno KV with our mock before tests run
(db as any).db = mockKv; // This casts to 'any' to bypass type checking for the mock assignment

// --- Mock WebSocket ---
// A more sophisticated mock might be needed for complex interactions
// For now, this captures sent messages and allows manual triggering of events.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  remoteAddress = { hostname: "mock-client", port: 12345 }; // For Deno.upgradeWebSocket
  readyState: number = WebSocket.CONNECTING; // Deno uses numbers: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
  sentMessages: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  // Event handlers that the server-side code (tunnelWebSocketHandler) will set
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event | ErrorEvent) => void) | null = null;

  constructor() {
    MockWebSocket.instances.push(this);
    // Simulate connection opening shortly after creation
    // setTimeout(() => this.simulateOpen(), 0); // Let test trigger open explicitly
  }

  send(message: string) {
    this.sentMessages.push(message);
  }

  close(code?: number, reason?: string) {
    if (this.readyState === WebSocket.OPEN || this.readyState === WebSocket.CONNECTING) {
        this.readyState = WebSocket.CLOSING;
        // Simulate actual close event after a tick
        setTimeout(() => {
            this.readyState = WebSocket.CLOSED;
            this.closed = true;
            this.closeCode = code;
            this.closeReason = reason;
            if (this.onclose) {
                this.onclose(new CloseEvent("close", { code, reason }) as CloseEvent);
            }
        }, 0);
    }
  }
  
  // Test utility methods
  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    if (this.onopen) {
      this.onopen();
    }
  }

  simulateMessage(data: any) {
    if (this.readyState !== WebSocket.OPEN) throw new Error("WebSocket not open");
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data: JSON.stringify(data) }) as MessageEvent);
    }
  }
  
  simulateError(message = "Mock WebSocket error") {
    if (this.onerror) {
        this.onerror(new ErrorEvent("error", { message }));
    }
    // Typically, a close event follows an error event.
    if (this.readyState === WebSocket.OPEN || this.readyState === WebSocket.CONNECTING) {
        this.close(1006, "Simulated error then close");
    }
  }


  static resetInstances() {
    MockWebSocket.instances = [];
  }
}

// Mock Deno.upgradeWebSocket
const mockUpgradeWebSocket = (request: Request): { response: Response; socket: WebSocket } => {
  const mockSocket = new MockWebSocket();
  // The response here is what Fresh/Deno expects to complete the upgrade.
  // It typically has status 101 and specific headers.
  const headers = new Headers({
    "Upgrade": "websocket",
    "Connection": "Upgrade",
  });
  // Deno.upgradeWebSocket requires the Sec-WebSocket-Key and Sec-WebSocket-Accept headers
  // to be handled, but for mocking the server-side logic, we might not need to fully emulate this.
  // However, if the server-side logic *reads* these headers from the request, we'd need to mock them on `request`.
  if (request.headers.get("sec-websocket-key")) {
    headers.set("Sec-WebSocket-Accept", "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="); // Dummy accept value
  }

  return {
    response: new Response(null, { status: 101, headers }),
    socket: mockSocket as any, // Cast to WebSocket for the handler
  };
};

// --- Test Suite ---
Deno.testSuite("Tunnel Service (services/mcp/server/tunnel.ts)", async (t) => {
  // Setup before each test in this suite
  const originalUpgradeWebSocket = (Deno as any).upgradeWebSocket; // Store original
  
  t.beforeEach(() => {
    mockKv.clear();
    MockWebSocket.resetInstances();
    activeTunnels.clear();
    // Replace Deno.upgradeWebSocket with our mock for each test
    (Deno as any).upgradeWebSocket = mockUpgradeWebSocket;
  });

  t.afterAll(() => {
    // Restore original Deno.upgradeWebSocket after all tests in this suite
    (Deno as any).upgradeWebSocket = originalUpgradeWebSocket;
    mockKv.clear(); // Final cleanup
  });

  // --- Test Cases ---
  await t.step("Agent Registration - Successful", async () => {
    const mockRequest = new Request("http://localhost/mcp/tunnel/register", {
      headers: { "upgrade": "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    const apiKey = "test-api-key-123";

    // Call the handler, which internally calls Deno.upgradeWebSocket (mocked)
    const response = tunnelWebSocketHandler(mockRequest, "register", apiKey);
    assertEquals(response.status, 101, "Should return 101 Switching Protocols");

    // Get the mock WebSocket instance created by mockUpgradeWebSocket
    assert(MockWebSocket.instances.length > 0, "MockWebSocket instance should have been created");
    const mockWs = MockWebSocket.instances[0];
    assertExists(mockWs, "Mock WebSocket instance should exist");

    // Simulate WebSocket connection opening
    mockWs.simulateOpen();

    // Simulate agent sending registration message
    const servicesToRegister: TunnelService[] = [
      { type: "http", local_port: 8080, subdomain_or_path: "my-service" },
    ];
    mockWs.simulateMessage({
      type: "register",
      data: { services: servicesToRegister },
    });

    // Assertions
    assertEquals(mockWs.sentMessages.length, 1, "Should send one message back to agent");
    const serverResponse = JSON.parse(mockWs.sentMessages[0]);
    assertEquals(serverResponse.type, "registered", "Response type should be 'registered'");
    assertExists(serverResponse.data.tunnelId, "Response should contain tunnelId");
    assertExists(serverResponse.data.public_base_url, "Response should contain public_base_url");

    const tunnelId = serverResponse.data.tunnelId;
    assert(activeTunnels.has(tunnelId), "Tunnel should be in activeTunnels map");
    assertEquals(activeTunnels.get(tunnelId), mockWs as any, "Active tunnel should be the mock WebSocket");

    // Verify data saved in Deno KV
    const tunnelData = await db.getTunnel(tunnelId) as TunnelRegistration | null;
    assertExists(tunnelData, "Tunnel data should be saved in KV");
    assertEquals(tunnelData?.apiKey, apiKey, "KV data should have correct apiKey");
    assertEquals(tunnelData?.agentId, apiKey, "KV data should have correct agentId (using apiKey)");
    assertEquals(tunnelData?.services.length, 1);
    assertEquals(tunnelData?.services[0].subdomain_or_path, "my-service");
    assertEquals(tunnelData?.status, "connected", "Tunnel status should be 'connected'");
  });

  await t.step("Agent Registration - Invalid Message (missing services)", async () => {
    const mockRequest = new Request("http://localhost/mcp/tunnel/register", {
      headers: { "upgrade": "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    const apiKey = "test-api-key-invalid-msg";

    tunnelWebSocketHandler(mockRequest, "register", apiKey);
    const mockWs = MockWebSocket.instances[0];
    mockWs.simulateOpen();
    mockWs.simulateMessage({ type: "register", data: {} }); // Missing 'services'

    assertEquals(mockWs.sentMessages.length, 1);
    const serverResponse = JSON.parse(mockWs.sentMessages[0]);
    assertEquals(serverResponse.type, "error");
    assert(serverResponse.error.includes("Invalid registration data"), "Error message should indicate invalid data");
    assertEquals(activeTunnels.size, 0, "No tunnel should be active after invalid registration");
  });
  
  await t.step("Agent Registration - API Key Missing (handler level)", async () => {
    const mockRequest = new Request("http://localhost/mcp/tunnel/register", {
      headers: { "upgrade": "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    // Call handler without apiKey
    const response = tunnelWebSocketHandler(mockRequest, "register", undefined);
    assertEquals(response.status, 401, "Should return 401 Unauthorized if API key is missing");
    const body = await response.json();
    assertEquals(body.error, "API key is required for tunnel operations.");
  });


  await t.step("Agent Reconnection - Successful", async () => {
    const existingTunnelId = "existing-tunnel-123";
    const apiKey = "reconnect-api-key";
    const initialTunnelData: TunnelRegistration = {
      tunnelId: existingTunnelId,
      apiKey: apiKey,
      agentId: apiKey,
      services: [{ type: "http", local_port: 8000, subdomain_or_path: "test" }],
      createdAt: new Date().toISOString(),
      status: "disconnected", // Simulate it was previously disconnected
    };
    await db.saveTunnel(initialTunnelData);

    const mockRequest = new Request(`http://localhost/mcp/tunnel/${existingTunnelId}`, {
      headers: { "upgrade": "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });

    tunnelWebSocketHandler(mockRequest, existingTunnelId, apiKey);
    const mockWs = MockWebSocket.instances[0];
    mockWs.simulateOpen(); // This triggers the reconnection logic in onopen

    // Assertions
    assertEquals(mockWs.sentMessages.length, 1, "Should send one message back to agent");
    const serverResponse = JSON.parse(mockWs.sentMessages[0]);
    assertEquals(serverResponse.type, "reconnected", "Response type should be 'reconnected'");
    assertEquals(serverResponse.data.tunnelId, existingTunnelId);

    assert(activeTunnels.has(existingTunnelId), "Reconnected tunnel should be in activeTunnels");
    const updatedTunnelData = await db.getTunnel(existingTunnelId);
    assertEquals(updatedTunnelData?.status, "connected", "Tunnel status in KV should be 'connected'");
  });
  
  await t.step("Agent Reconnection - Unauthorized (wrong API key)", async () => {
    const existingTunnelId = "existing-tunnel-auth-fail";
    const ownerApiKey = "owner-api-key";
    const attackerApiKey = "attacker-api-key";
    const initialTunnelData: TunnelRegistration = {
      tunnelId: existingTunnelId,
      apiKey: ownerApiKey, // Owned by ownerApiKey
      agentId: ownerApiKey,
      services: [{ type: "http", local_port: 8000, subdomain_or_path: "test" }],
      createdAt: new Date().toISOString(),
      status: "disconnected",
    };
    await db.saveTunnel(initialTunnelData);

    const mockRequest = new Request(`http://localhost/mcp/tunnel/${existingTunnelId}`, {
      headers: { "upgrade": "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });

    // Attempt reconnection with attackerApiKey
    tunnelWebSocketHandler(mockRequest, existingTunnelId, attackerApiKey); 
    const mockWs = MockWebSocket.instances[0];
    mockWs.simulateOpen();

    assertEquals(mockWs.sentMessages.length, 1, "Should send one error message");
    const serverResponse = JSON.parse(mockWs.sentMessages[0]);
    assertEquals(serverResponse.type, "error");
    assert(serverResponse.error.includes("Tunnel not found or unauthorized"), "Error should indicate unauthorized");
    
    assertEquals(mockWs.closed, true, "WebSocket should be closed by server");
    assertNotEquals(activeTunnels.has(existingTunnelId), true, "Tunnel should not be active");
    const tunnelData = await db.getTunnel(existingTunnelId);
    assertEquals(tunnelData?.status, "disconnected", "Tunnel status should remain disconnected");
  });


  await t.step("Connection Lifecycle - onclose updates status", async () => {
    // First, register a tunnel successfully
    const mockRequestReg = new Request("http://localhost/mcp/tunnel/register", {
      headers: { "upgrade": "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    const apiKey = "lifecycle-api-key";
    tunnelWebSocketHandler(mockRequestReg, "register", apiKey);
    const mockWs = MockWebSocket.instances[0];
    mockWs.simulateOpen();
    mockWs.simulateMessage({
      type: "register",
      data: { services: [{ type: "http", local_port: 3000, subdomain_or_path: "app" }] },
    });
    const regResponse = JSON.parse(mockWs.sentMessages[0]);
    const tunnelId = regResponse.data.tunnelId;
    assertExists(tunnelId, "Tunnel ID must exist after registration");
    
    // Verify initial status is connected
    let tunnelData = await db.getTunnel(tunnelId);
    assertEquals(tunnelData?.status, "connected", "Tunnel should be connected initially");
    assert(activeTunnels.has(tunnelId), "Tunnel should be active");

    // Simulate WebSocket close
    mockWs.close(1000, "Client disconnected normally");
    
    // Wait for async operations in onclose to complete (e.g., DB update)
    // This might require a small delay or a more robust way to await async handlers in tests.
    // For this mock, the setTimeout in MockWebSocket.close helps ensure onclose is processed.
    await new Promise(resolve => setTimeout(resolve, 10)); 


    assertNotEquals(activeTunnels.has(tunnelId), true, "Tunnel should be removed from activeTunnels after close");
    tunnelData = await db.getTunnel(tunnelId);
    assertEquals(tunnelData?.status, "disconnected", "Tunnel status in KV should be 'disconnected' after close");
  });
  
    await t.step("Connection Lifecycle - onerror updates status", async () => {
    const mockRequestReg = new Request("http://localhost/mcp/tunnel/register", {
      headers: { "upgrade": "websocket", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
    });
    const apiKey = "error-lifecycle-api-key";
    tunnelWebSocketHandler(mockRequestReg, "register", apiKey);
    const mockWs = MockWebSocket.instances[0];
    mockWs.simulateOpen();
    mockWs.simulateMessage({
      type: "register",
      data: { services: [{ type: "http", local_port: 3001, subdomain_or_path: "app-err" }] },
    });
    const regResponse = JSON.parse(mockWs.sentMessages[0]);
    const tunnelId = regResponse.data.tunnelId;
    assertExists(tunnelId);

    mockWs.simulateError("Simulated network error");
    await new Promise(resolve => setTimeout(resolve, 10));

    assert(!activeTunnels.has(tunnelId), "Tunnel should be removed from activeTunnels after error");
    const tunnelData = await db.getTunnel(tunnelId);
    assertEquals(tunnelData?.status, "disconnected", "Tunnel status should be 'disconnected' after error");
  });

});

// Note: getActiveTunnelSocket is implicitly tested by the registration and reconnection tests
// as they check the activeTunnels map. Direct test might be redundant here.
// HTTP Forwarding tests will be in a separate file for routes.
