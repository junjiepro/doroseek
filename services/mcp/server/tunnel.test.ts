import {
import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertObjectMatch,
} from "https://deno.land/std@0.212.0/assert/mod.ts";
import { spy, stub, returnsNext } from "https://deno.land/std@0.212.0/testing/mock.ts";
import { FakeTime } from "https://deno.land/std@0.212.0/testing/time.ts";
import { mockKv } from "../../../test_utils/mock_kv.ts";
import * as db from "../../database.ts";
import {
  tunnelWebSocketHandler,
  activeTunnels,
  pendingHttpRequests,
  forwardRequestToLocalAgent,
  performLocalAgentHealthCheck,
  initiateForwardedAgentHealthCheck,
  PendingRequestInfo, // Export this if not already
  AgentHttpResponsePayload, // Export this if not already
} from "./tunnel.ts";
import { TunnelRegistration, TunnelService } from "../../../shared/tunnel.ts";
import { AgentPingMessage, AgentPongMessage, HealthStatusReport, LocalServiceStatus } from "../../../shared/health.ts";
import * as interComms from "../../inter_instance_comms.ts"; // To mock post... functions
import { RELAY_INSTANCE_ID } from "../../../lib/utils.ts"; // To check against self ID

// --- Test Setup ---
(db as any).db = mockKv;

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

// --- New Tests for Inter-Instance Communication Aspects ---

Deno.testSuite("Tunnel Service - Inter-Instance Aspects", async (t) => {
  let postTunnelActivitySpy: any;
  let postHttpResponseSpy: any;
  let postHealthCheckResponseSpy: any;
  let originalUpgradeWebSocket: any;
  let fakeTime: FakeTime;


  t.beforeEach(() => {
    mockKv.clear();
    MockWebSocket.resetInstances();
    activeTunnels.clear();
    pendingHttpRequests.clear();
    (db as any).db = mockKv; // Ensure mockKv is reassigned if db module was re-evaluated

    postTunnelActivitySpy = spy(interComms, "postTunnelActivityToChannel");
    postHttpResponseSpy = spy(interComms, "postHttpResponseToChannel");
    postHealthCheckResponseSpy = spy(interComms, "postHealthCheckResponseToChannel");
    
    originalUpgradeWebSocket = (Deno as any).upgradeWebSocket;
    (Deno as any).upgradeWebSocket = mockUpgradeWebSocket;
    fakeTime = new FakeTime();
  });

  t.afterEach(async () => {
    postTunnelActivitySpy.restore();
    postHttpResponseSpy.restore();
    postHealthCheckResponseSpy.restore();
    (Deno as any).upgradeWebSocket = originalUpgradeWebSocket;
    await fakeTime.restore();
  });

  const setupRegisteredTunnel = async (tunnelId: string, apiKey: string): Promise<MockWebSocket> => {
    const mockRequest = new Request("http://localhost/mcp/tunnel/register", {
      headers: { "upgrade": "websocket", "sec-websocket-key": "test-key" },
    });
    tunnelWebSocketHandler(mockRequest, "register", apiKey);
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    ws.simulateOpen();
    ws.simulateMessage({
      type: "register",
      data: { services: [{ type: "http", local_port: 3000, subdomain_or_path: "test" }] },
    });
    await fakeTime.runMicrotasks(); // Process registration
    // Clear spy calls from registration to focus on subsequent actions
    postTunnelActivitySpy.calls = []; 
    return ws;
  };


  await t.step("Tunnel Activity - Announces 'connected' on new registration", async () => {
    await setupRegisteredTunnel("tunnel-act-conn", "api-key-act");
    
    assertSpyCalls(postTunnelActivitySpy, 1);
    const activityArgs = postTunnelActivitySpy.calls[0].args[0];
    assertEquals(activityArgs.type, "tunnelActivity");
    assertEquals(activityArgs.activity, "connected");
    assertEquals(activityArgs.tunnelId, JSON.parse(MockWebSocket.instances[0].sentMessages[0]).data.tunnelId);
  });

  await t.step("Tunnel Activity - Announces 'connected' on reconnection", async () => {
    const tunnelId = "tunnel-act-reconn";
    const apiKey = "api-key-reconn";
    await db.saveTunnel({ tunnelId, apiKey, agentId: apiKey, services: [], createdAt: "", status: "disconnected" });

    const mockRequest = new Request(`http://localhost/mcp/tunnel/${tunnelId}`, {
      headers: { "upgrade": "websocket", "sec-websocket-key": "test-key" },
    });
    tunnelWebSocketHandler(mockRequest, tunnelId, apiKey);
    const ws = MockWebSocket.instances[0];
    ws.simulateOpen(); // Triggers reconnection logic and announcement
    await fakeTime.runMicrotasks();

    assertSpyCalls(postTunnelActivitySpy, 1);
    const activityArgs = postTunnelActivitySpy.calls[0].args[0];
    assertEquals(activityArgs.activity, "connected");
    assertEquals(activityArgs.tunnelId, tunnelId);
  });

  await t.step("Tunnel Activity - Announces 'disconnected' on agent close", async () => {
    const ws = await setupRegisteredTunnel("tunnel-act-disc", "api-key-disc");
    const tunnelId = JSON.parse(ws.sentMessages[0]).data.tunnelId;
    postTunnelActivitySpy.calls = []; // Clear calls from setup

    ws.close(1000, "Agent disconnecting");
    await fakeTime.runMicrotasks(); // Allow onclose handler to run

    assertSpyCalls(postTunnelActivitySpy, 1);
    const activityArgs = postTunnelActivitySpy.calls[0].args[0];
    assertEquals(activityArgs.activity, "disconnected");
    assertEquals(activityArgs.tunnelId, tunnelId);
  });

  await t.step("HTTP Response Handling - Forwards response for 'forwarded' request via BroadcastChannel", async () => {
    const ws = await setupRegisteredTunnel("tunnel-fwd-resp", "api-key-fwd-resp");
    const tunnelId = JSON.parse(ws.sentMessages[0]).data.tunnelId;
    
    const agentRequestId = "agent-req-id-1";
    const originalJobId = "original-job-id-1";
    const originalInstanceId = "instance-origin";

    pendingHttpRequests.set(agentRequestId, {
      type: "forwarded",
      originalJobId,
      originalInstanceId,
    });

    const agentResponsePayload: AgentHttpResponsePayload = {
      status: 200,
      headers: { "x-agent-resp": "true" },
      body: "agent data",
    };
    ws.simulateMessage({ type: "httpResponse", requestId: agentRequestId, data: agentResponsePayload });
    await fakeTime.runMicrotasks();

    assertSpyCalls(postHttpResponseSpy, 1);
    const broadcastArgs = postHttpResponseSpy.calls[0].args[0];
    assertEquals(broadcastArgs.tunnelId, tunnelId);
    assertEquals(broadcastArgs.requestId, originalJobId); // Should be originalJobId
    assertEquals(broadcastArgs.targetInstanceId, originalInstanceId);
    assertObjectMatch(broadcastArgs.responseData, agentResponsePayload);
    assert(!pendingHttpRequests.has(agentRequestId), "Pending request should be cleared");
  });
  
  await t.step("forwardRequestToLocalAgent - Sends to local agent if connected", async () => {
    const ws = await setupRegisteredTunnel("fwd-to-local-tunnel", "fwd-to-local-key");
    const tunnelId = JSON.parse(ws.sentMessages[0]).data.tunnelId;
    ws.sentMessages = []; // Clear messages from setup

    const agentRequestId = "new-agent-req-id"; // This will be generated by forwardRequestToLocalAgent
    const originalJobId = "orig-job-fwd";
    const originalInstanceId = "orig-instance-fwd";
    const requestData = { method: "GET", path: "/data", headers: {}, body: null };

    // Need to mock uuidv4 if we want to predict agentRequestId
    const uuidStub = stub(crypto, "randomUUID", returnsNext([agentRequestId.replace("new-","")])); // Simplify, assume it's just the base

    const success = forwardRequestToLocalAgent(tunnelId, agentRequestId, originalJobId, originalInstanceId, requestData);
    uuidStub.restore();

    assert(success, "forwardRequestToLocalAgent should return true");
    assertEquals(ws.sentMessages.length, 1, "Agent should receive one message");
    const sentToAgent = JSON.parse(ws.sentMessages[0]);
    assertEquals(sentToAgent.type, "httpRequest");
    assertEquals(sentToAgent.requestId, agentRequestId);
    assertObjectMatch(sentToAgent.data, requestData);

    const pendingInfo = pendingHttpRequests.get(agentRequestId);
    assertExists(pendingInfo);
    assertEquals(pendingInfo?.type, "forwarded");
    if (pendingInfo?.type === "forwarded") {
      assertEquals(pendingInfo.originalJobId, originalJobId);
      assertEquals(pendingInfo.originalInstanceId, originalInstanceId);
    }
  });

  await t.step("forwardRequestToLocalAgent - Broadcasts 502 error if agent not connected", async () => {
    const tunnelId = "fwd-no-agent-tunnel";
    // Do not set up an active tunnel for tunnelId
    
    const agentRequestId = "agent-req-no-socket";
    const originalJobId = "orig-job-no-socket";
    const originalInstanceId = "orig-instance-no-socket";
    const requestData = { method: "GET", path: "/data", headers: {}, body: null };

    const success = forwardRequestToLocalAgent(tunnelId, agentRequestId, originalJobId, originalInstanceId, requestData);

    assert(!success, "forwardRequestToLocalAgent should return false");
    assertSpyCalls(postHttpResponseSpy, 1);
    const broadcastArgs = postHttpResponseSpy.calls[0].args[0];
    assertEquals(broadcastArgs.tunnelId, tunnelId);
    assertEquals(broadcastArgs.requestId, originalJobId);
    assertEquals(broadcastArgs.targetInstanceId, originalInstanceId);
    assertEquals(broadcastArgs.responseData.status, 502);
    assertStringIncludes(broadcastArgs.responseData.body!, `Agent for tunnel ${tunnelId} not connected`);
    assert(!pendingHttpRequests.has(agentRequestId), "No pending request should be stored if agent not found");
  });

  // --- Health Check related function tests ---
  await t.step("performLocalAgentHealthCheck - Agent connected and pongs", async () => {
    const ws = await setupRegisteredTunnel("health-local-pong", "health-key-pong");
    const tunnelId = JSON.parse(ws.sentMessages[0]).data.tunnelId;
    ws.sentMessages = []; // Clear setup messages

    const healthPromise = performLocalAgentHealthCheck(tunnelId);
    await fakeTime.runMicrotasks(); // Allow ping to be sent

    assertEquals(ws.sentMessages.length, 1);
    const pingMsg = JSON.parse(ws.sentMessages[0]) as AgentPingMessage;
    assertEquals(pingMsg.type, "ping");
    assertExists(pingMsg.healthCheckJobId);

    // Simulate agent pong
    const pongPayload: AgentPongMessage = {
      type: "pong",
      healthCheckJobId: pingMsg.healthCheckJobId,
      localServiceStatus: "ok",
    };
    ws.simulateMessage(pongPayload);

    const report = await healthPromise;
    assertEquals(report.tunnelId, tunnelId);
    assertEquals(report.tunnelStatus, "connected");
    assertEquals(report.localServiceStatus, "ok");
    assertEquals(report.checkedByInstanceId, RELAY_INSTANCE_ID);
  });

  await t.step("performLocalAgentHealthCheck - Agent connected but times out", async () => {
    const ws = await setupRegisteredTunnel("health-local-timeout", "health-key-timeout");
    const tunnelId = JSON.parse(ws.sentMessages[0]).data.tunnelId;
    
    const healthPromise = performLocalAgentHealthCheck(tunnelId);
    // Do not simulate pong, let timeout trigger
    await fakeTime.tickAsync(10000 + 500); // HEALTH_CHECK_AGENT_TIMEOUT_MS + buffer
    
    const report = await healthPromise;
    assertEquals(report.tunnelId, tunnelId);
    assertEquals(report.tunnelStatus, "connected");
    assertEquals(report.localServiceStatus, "agent_unresponsive");
  });

  await t.step("performLocalAgentHealthCheck - Agent not connected", async () => {
    const tunnelId = "health-local-no-agent";
    // No active tunnel for this ID
    const report = await performLocalAgentHealthCheck(tunnelId);
    assertEquals(report.tunnelId, tunnelId);
    assertEquals(report.tunnelStatus, "disconnected");
    assertEquals(report.localServiceStatus, "unknown");
  });

  await t.step("initiateForwardedAgentHealthCheck - Agent connected and pongs, broadcasts response", async () => {
    const ws = await setupRegisteredTunnel("health-fwd-pong", "health-key-fwd-pong");
    const tunnelId = JSON.parse(ws.sentMessages[0]).data.tunnelId;
    ws.sentMessages = []; // Clear setup messages
    postHealthCheckResponseSpy.calls = []; // Clear spy

    const originalJobId = "orig-hc-job-1";
    const originalInstanceId = "orig-hc-instance-1";

    initiateForwardedAgentHealthCheck(tunnelId, originalJobId, originalInstanceId);
    await fakeTime.runMicrotasks(); // Allow ping to be sent

    assertEquals(ws.sentMessages.length, 1);
    const pingMsg = JSON.parse(ws.sentMessages[0]) as AgentPingMessage;
    
    // Simulate agent pong
    ws.simulateMessage({ type: "pong", healthCheckJobId: pingMsg.healthCheckJobId, localServiceStatus: "ok" } as AgentPongMessage);
    await fakeTime.runMicrotasks(); // Allow pong processing and broadcast

    assertSpyCalls(postHealthCheckResponseSpy, 1);
    const broadcastArgs = postHealthCheckResponseSpy.calls[0].args[0];
    assertEquals(broadcastArgs.healthCheckJobId, originalJobId);
    assertEquals(broadcastArgs.targetInstanceId, originalInstanceId);
    assertEquals(broadcastArgs.statusReport.tunnelId, tunnelId);
    assertEquals(broadcastArgs.statusReport.tunnelStatus, "connected");
    assertEquals(broadcastArgs.statusReport.localServiceStatus, "ok");
  });
  
  await t.step("initiateForwardedAgentHealthCheck - Agent times out, broadcasts unresponsive", async () => {
    const ws = await setupRegisteredTunnel("health-fwd-timeout", "health-key-fwd-timeout");
    const tunnelId = JSON.parse(ws.sentMessages[0]).data.tunnelId;
    postHealthCheckResponseSpy.calls = [];

    const originalJobId = "orig-hc-job-timeout";
    const originalInstanceId = "orig-hc-instance-timeout";

    initiateForwardedAgentHealthCheck(tunnelId, originalJobId, originalInstanceId);
    await fakeTime.runMicrotasks(); // Send ping
    
    await fakeTime.tickAsync(10000 + 500); // HEALTH_CHECK_AGENT_TIMEOUT_MS + buffer
    await fakeTime.runMicrotasks(); // Process timeout

    assertSpyCalls(postHealthCheckResponseSpy, 1);
    const broadcastArgs = postHealthCheckResponseSpy.calls[0].args[0];
    assertEquals(broadcastArgs.healthCheckJobId, originalJobId);
    assertEquals(broadcastArgs.targetInstanceId, originalInstanceId);
    assertEquals(broadcastArgs.statusReport.localServiceStatus, "agent_unresponsive");
  });


  await t.step("initiateForwardedAgentHealthCheck - Agent not connected locally, broadcasts disconnected", async () => {
    const tunnelId = "health-fwd-no-agent";
    const originalJobId = "orig-hc-job-no-agent";
    const originalInstanceId = "orig-hc-instance-no-agent";
    postHealthCheckResponseSpy.calls = [];

    initiateForwardedAgentHealthCheck(tunnelId, originalJobId, originalInstanceId);
    await fakeTime.runMicrotasks();

    assertSpyCalls(postHealthCheckResponseSpy, 1);
    const broadcastArgs = postHealthCheckResponseSpy.calls[0].args[0];
    assertEquals(broadcastArgs.healthCheckJobId, originalJobId);
    assertEquals(broadcastArgs.targetInstanceId, originalInstanceId);
    assertEquals(broadcastArgs.statusReport.tunnelId, tunnelId);
    assertEquals(broadcastArgs.statusReport.tunnelStatus, "disconnected");
    assertEquals(broadcastArgs.statusReport.localServiceStatus, "unknown");
  });

});
