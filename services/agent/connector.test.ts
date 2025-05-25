import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertMatch,
  fail,
} from "https://deno.land/std@0.212.0/assert/mod.ts";
import { delay } from "https://deno.land/std@0.212.0/async/delay.ts";
import { FakeTime } from "https://deno.land/std@0.212.0/testing/time.ts";

import { AgentConnector } from "./connector.ts";
import { AgentConfig, AgentServiceConfig } from "./config.ts";
import {
  TunnelMessage,
  AgentHttpRequest,
  ServerRegistrationResponse,
  ServerReconnectResponse,
  ErrorMessage as ServerErrorMessage,
} from "../../shared/tunnel.ts"; // Shared types

// --- Mock WebSocket ---
// This will be a global mock for WebSocket constructor
let mockWebSocketInstances: MockRelayWebSocket[] = [];

class MockRelayWebSocket {
  public static serverShouldRejectRegistration = false;
  public static serverShouldSendErrorOnRegister = false;
  public static serverErrorMessage = "Registration denied by mock server";
  
  public url: string;
  public readyState: number = WebSocket.CONNECTING;
  public sentMessages: any[] = []; // Store parsed JSON messages
  public closeCalledWith?: { code?: number; reason?: string };

  // Event handlers that the AgentConnector will set
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event | ErrorEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    mockWebSocketInstances.push(this);
    // Simulate async connection opening
    setTimeout(() => this.simulateOpen(), 0);
  }

  send(message: string) {
    const parsedMessage = JSON.parse(message);
    this.sentMessages.push(parsedMessage);

    // Simulate server responses based on client message type
    if (parsedMessage.type === "register") {
      if (MockRelayWebSocket.serverShouldRejectRegistration) {
        // Simulate server closing connection due to registration failure
        setTimeout(() => this.simulateClose(1008, "Policy Violation: Registration rejected"), 10);
        return;
      }
      if (MockRelayWebSocket.serverShouldSendErrorOnRegister) {
         setTimeout(() => this.simulateMessageFromServer({
            type: "error",
            error: MockRelayWebSocket.serverErrorMessage,
         } as ServerErrorMessage), 10);
         return;
      }
      const response: ServerRegistrationResponse = {
        type: "registered",
        data: {
          tunnelId: `fake-tunnel-${Date.now()}`,
          public_base_url: `https://fake-relay.com/t/fake-tunnel-${Date.now()}`,
        },
      };
      setTimeout(() => this.simulateMessageFromServer(response), 10);
    } else if (parsedMessage.type === "heartbeat") {
      setTimeout(() => this.simulateMessageFromServer({ type: "heartbeat_ack" }), 0);
    }
  }

  close(code?: number, reason?: string) {
    this.closeCalledWith = { code, reason };
    if (this.readyState === WebSocket.OPEN || this.readyState === WebSocket.CONNECTING) {
      this.readyState = WebSocket.CLOSING;
      setTimeout(() => {
        this.readyState = WebSocket.CLOSED;
        if (this.onclose) {
          this.onclose(new CloseEvent("close", { code, reason, wasClean: true }) as CloseEvent);
        }
      }, 0);
    }
  }

  // Test utility methods
  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    if (this.onopen) this.onopen();
  }

  simulateMessageFromServer(data: TunnelMessage | {type: "heartbeat_ack"} | ServerErrorMessage ) {
    if (this.readyState !== WebSocket.OPEN) return; // Or throw
    if (this.onmessage) {
      this.onmessage(new MessageEvent("message", { data: JSON.stringify(data) }) as MessageEvent);
    }
  }

  simulateErrorEvent(message = "Mock WebSocket network error") {
    if (this.onerror) {
      this.onerror(new ErrorEvent("error", { message }));
    }
    // Network errors typically cause an unclean close
     if (this.readyState === WebSocket.OPEN || this.readyState === WebSocket.CONNECTING) {
      this.readyState = WebSocket.CLOSING; // Should go to CLOSING then CLOSED
      setTimeout(() => {
        this.readyState = WebSocket.CLOSED;
        if (this.onclose) {
            this.onclose(new CloseEvent("close", { code: 1006, reason: message, wasClean: false }) as CloseEvent);
        }
      }, 0);
    }
  }
  
  simulateClose(code = 1000, reason = "Server initiated close", wasClean = true) {
     if (this.readyState === WebSocket.OPEN || this.readyState === WebSocket.CONNECTING) {
        this.readyState = WebSocket.CLOSING;
        setTimeout(() => {
            this.readyState = WebSocket.CLOSED;
            if (this.onclose) {
                this.onclose(new CloseEvent("close", {code, reason, wasClean}) as CloseEvent);
            }
        }, 0);
     }
  }


  static getInstances(): MockRelayWebSocket[] { return mockWebSocketInstances; }
  static clearInstances(): void { mockWebSocketInstances = []; }
  static resetServerBehavior(): void {
    MockRelayWebSocket.serverShouldRejectRegistration = false;
    MockRelayWebSocket.serverShouldSendErrorOnRegister = false;
    MockRelayWebSocket.serverErrorMessage = "Registration denied by mock server";
  }
}

// --- Test Suite ---
Deno.testSuite("Agent Connector (services/agent/connector.ts)", async (t) => {
  let originalWebSocket: typeof WebSocket;
  let fakeTime: FakeTime;

  const testServiceConfig: AgentServiceConfig[] = [
    { id: "s1", name: "Test Service 1", type: "http", local_host: "localhost", local_port: 8080, subdomainOrPath: "service1" },
  ];
  const testAgentConfig: AgentConfig = {
    relayUrl: "wss://mockrelay.example.com/mcp/tunnel/register",
    apiKey: "test-connector-apikey",
    services: testServiceConfig,
  };

  t.beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    (globalThis as any).WebSocket = MockRelayWebSocket;
    MockRelayWebSocket.clearInstances();
    MockRelayWebSocket.resetServerBehavior();
    fakeTime = new FakeTime(); // Initialize FakeTime for controlling timers
  });

  t.afterEach(async () => {
    globalThis.WebSocket = originalWebSocket;
    await fakeTime.restore(); // Restore real timers
  });

  await t.step("Connection and Successful Registration", async () => {
    const connector = new AgentConnector(testAgentConfig);
    let readyCalled = false;
    let onReadyTunnelId: string | null = null;
    connector.onReady = () => {
      readyCalled = true;
      onReadyTunnelId = connector.getTunnelInfo().tunnelId;
    };

    connector.connect();
    await fakeTime.runMicrotasks(); // Process WebSocket opening and message sending/receiving timeouts

    const wsInstances = MockRelayWebSocket.getInstances();
    assertEquals(wsInstances.length, 1, "WebSocket instance should be created");
    const mockWs = wsInstances[0];
    assert(mockWs.url.includes(testAgentConfig.apiKey), "API key should be in connection URL query");

    assertEquals(mockWs.sentMessages.length, 1, "Should send one registration message");
    const regMessage = mockWs.sentMessages[0];
    assertEquals(regMessage.type, "register");
    assertEquals(regMessage.data.services.length, 1);
    assertEquals(regMessage.data.services[0].subdomain_or_path, "service1");

    assert(connector.isReady(), "Connector should be ready after registration");
    assert(readyCalled, "onReady callback should be triggered");
    assertExists(onReadyTunnelId, "Tunnel ID should be set in onReady");
    assertExists(connector.getTunnelInfo().publicBaseUrl, "Public base URL should be set");
    
    connector.disconnect(); // Cleanup
  });

  await t.step("Heartbeat Mechanism", async () => {
    const connector = new AgentConnector(testAgentConfig);
    connector.connect();
    await fakeTime.runMicrotasks(); // Initial connection & registration

    const mockWs = MockRelayWebSocket.getInstances()[0];
    mockWs.sentMessages = []; // Clear initial registration message

    await fakeTime.tickAsync(25000); // Advance time to trigger first heartbeat
    assertEquals(mockWs.sentMessages.length, 1, "Should send one heartbeat message after ~25s");
    assertEquals(mockWs.sentMessages[0].type, "heartbeat");
    
    await fakeTime.runMicrotasks(); // Ensure heartbeat_ack is processed if server sends one

    mockWs.sentMessages = [];
    await fakeTime.tickAsync(25000); // Advance time for second heartbeat
    assertEquals(mockWs.sentMessages.length, 1, "Should send a second heartbeat message");
    assertEquals(mockWs.sentMessages[0].type, "heartbeat");
    
    connector.disconnect();
  });

  await t.step("Reconnection Logic on Unclean Disconnect", async () => {
    const connector = new AgentConnector(testAgentConfig);
    connector.connect();
    await fakeTime.runMicrotasks(); // Initial connection

    let wsInstance1 = MockRelayWebSocket.getInstances()[0];
    
    // Simulate unclean disconnect (e.g., network error)
    wsInstance1.simulateErrorEvent("Simulated network drop");
    await fakeTime.runMicrotasks(); // Process error and close events

    assertEquals(connector.isReady(), false, "Connector should not be ready after disconnect");

    // Advance time for first retry (2^0 * 1000ms = 1s)
    await fakeTime.tickAsync(1000); 
    await fakeTime.runMicrotasks();

    assertEquals(MockRelayWebSocket.getInstances().length, 2, "Should create a new WebSocket for retry");
    let wsInstance2 = MockRelayWebSocket.getInstances()[1];
    assertNotEquals(wsInstance1, wsInstance2, "Should be a new WebSocket instance");
    assertEquals(wsInstance2.sentMessages[0]?.type, "register", "Should attempt to re-register");
    
    // Simulate another failure
    wsInstance2.simulateErrorEvent("Simulated network drop again");
    await fakeTime.runMicrotasks();
    
    // Advance time for second retry (2^1 * 1000ms = 2s)
    await fakeTime.tickAsync(2000);
    await fakeTime.runMicrotasks();
    
    assertEquals(MockRelayWebSocket.getInstances().length, 3, "Should create a third WebSocket for another retry");
    let wsInstance3 = MockRelayWebSocket.getInstances()[2];
    assertEquals(wsInstance3.sentMessages[0]?.type, "register", "Should attempt to re-register again");

    // Now let registration succeed on the 3rd attempt
    // The mock server (MockRelayWebSocket) automatically sends 'registered' on 'register' message
    // so just need to ensure the connector processes it.
    await fakeTime.runMicrotasks(); // allow 'registered' message to be processed
    assert(connector.isReady(), "Connector should eventually become ready after successful retry");

    connector.disconnect();
  });
  
  await t.step("Server Rejects Registration - Connection Closed by Server", async () => {
    MockRelayWebSocket.serverShouldRejectRegistration = true;
    const connector = new AgentConnector(testAgentConfig);
    
    let closeEventReason = "";
    connector.connect(); // This will call the mocked WebSocket constructor
    
    // Need to access the ws instance to set its onclose for inspection
    // This is a bit tricky as connect() doesn't return the socket.
    // We rely on the mock storing instances.
    await fakeTime.runMicrotasks(); // Allow WebSocket to open and send register
    const wsInstance = MockRelayWebSocket.getInstances()[0];
    assertExists(wsInstance, "WebSocket instance was not created");

    // Override onclose for this test to capture reason
    const originalOnClose = wsInstance.onclose;
    wsInstance.onclose = (event: CloseEvent) => {
        closeEventReason = event.reason;
        if(originalOnClose) originalOnClose.call(wsInstance, event);
    };

    await fakeTime.tickAsync(100); // Allow server to process and close connection
    
    assert(!connector.isReady(), "Connector should not be ready if registration is rejected by close");
    assertEquals(closeEventReason, "Policy Violation: Registration rejected", "Close reason should indicate rejection");
    
    // Check if reconnection is attempted (it should be, as it's a server-side close, not a critical client error)
    MockRelayWebSocket.serverShouldRejectRegistration = false; // Allow next attempt to succeed for test cleanup
    await fakeTime.tickAsync(1000); // First retry
    await fakeTime.runMicrotasks();
    assert(MockRelayWebSocket.getInstances().length > 1, "Should attempt reconnection after server rejection close");
    
    connector.disconnect();
  });

  await t.step("Server Sends Error on Registration - Critical Error, No Retry", async () => {
    MockRelayWebSocket.serverShouldSendErrorOnRegister = true;
    MockRelayWebSocket.serverErrorMessage = "Failed to register tunnel - critical reason";
    const connector = new AgentConnector(testAgentConfig);

    connector.connect();
    await fakeTime.runMicrotasks(); // Allow connection and registration attempt
    await fakeTime.tickAsync(100); // Allow server to send error message and connector to process it

    assert(!connector.isReady(), "Connector should not be ready");
    const wsInstance = MockRelayWebSocket.getInstances()[0];
    assert(wsInstance.closeCalledWith, "WebSocket close should have been called by connector");
    assertEquals(wsInstance.closeCalledWith?.code, 1008);
    assertEquals(wsInstance.closeCalledWith?.reason, "Registration failed by server");

    // Verify no reconnection attempts are scheduled for this specific critical error
    const initialInstanceCount = MockRelayWebSocket.getInstances().length;
    await fakeTime.tickAsync(5000); // Advance time well past typical retry delays
    await fakeTime.runMicrotasks();
    assertEquals(MockRelayWebSocket.getInstances().length, initialInstanceCount, "Should not attempt reconnection on critical registration error");
    
    connector.disconnect(); // Ensure cleanup even if it didn't connect
  });


  await t.step("disconnect() method - Closes WebSocket and stops retries", async () => {
    const connector = new AgentConnector(testAgentConfig);
    connector.connect();
    await fakeTime.runMicrotasks(); // Connect

    const wsInstance1 = MockRelayWebSocket.getInstances()[0];
    assert(connector.isReady(), "Connector should be ready");

    // Simulate a disconnect that would trigger retries
    wsInstance1.simulateErrorEvent("Network error before manual disconnect");
    await fakeTime.runMicrotasks(); // Process error and schedule retry

    // Now, manually disconnect
    connector.disconnect();
    assert(!connector.isReady(), "Connector should not be ready after disconnect()");
    assert(wsInstance1.closeCalledWith?.code === 1000 || wsInstance1.readyState === WebSocket.CLOSED, "Original WebSocket should be closed by disconnect()");
    
    // Verify no new connection attempts are made after manual disconnect
    const instanceCountAfterDisconnect = MockRelayWebSocket.getInstances().length;
    await fakeTime.tickAsync(5000); // Advance time well past any retry schedule
    await fakeTime.runMicrotasks();
    assertEquals(MockRelayWebSocket.getInstances().length, instanceCountAfterDisconnect, "No new WebSocket instances should be created after disconnect()");
  });
  
  await t.step("Forwards httpRequest from relay to onHttpRequest callback", async () => {
    const connector = new AgentConnector(testAgentConfig);
    let receivedHttpRequest: AgentHttpRequest | null = null;
    
    connector.onHttpRequest = (message) => {
      receivedHttpRequest = message;
    };
    
    connector.connect();
    await fakeTime.runMicrotasks(); // Connect and register
    assert(connector.isReady(), "Connector should be ready");

    const mockWs = MockRelayWebSocket.getInstances()[0];
    const httpRequestPayload: AgentHttpRequest = {
      type: "httpRequest",
      requestId: "req-123",
      data: {
        method: "GET",
        path: "/test",
        headers: { "x-test": "true" },
        body: null,
      },
    };
    mockWs.simulateMessageFromServer(httpRequestPayload);
    await fakeTime.runMicrotasks(); // Process message

    assertExists(receivedHttpRequest, "onHttpRequest callback should have been triggered");
    assertEquals(receivedHttpRequest?.requestId, "req-123");
    assertEquals(receivedHttpRequest?.data.path, "/test");
    
    connector.disconnect();
  });

});
