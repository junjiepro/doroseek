import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
  assertNotEquals,
} from "https://deno.land/std@0.212.0/assert/mod.ts";
import { AgentRequestHandler } from "./handler.ts";
import { AgentConnector } from "./connector.ts";
import { AgentConfig, AgentServiceConfig } from "./config.ts";
import {
  AgentHttpRequest,
  AgentHttpResponse,
  TunnelMessage,
} from "../../shared/tunnel.ts";

// --- Mock AgentConnector ---
class MockConnector {
  public sentMessages: (AgentHttpResponse | TunnelMessage)[] = [];
  public config: AgentConfig; // Add config if handler needs it via connector

  constructor(config: AgentConfig) {
    this.config = config; // In case handler needs to access connector's config
  }

  send(message: AgentHttpResponse | TunnelMessage) {
    this.sentMessages.push(message);
  }

  // Add other methods if AgentRequestHandler uses them
  isReady(): boolean { return true; }
  getTunnelInfo() { return { tunnelId: "mock-tunnel-id", publicBaseUrl: "mock-url" }; }

  static reset() {
    // no static instances to clear, just ensure tests create new ones
  }
}

// --- Mock fetch ---
let mockFetchResponses: Map<string, { status: number; headers: Record<string, string>; body: BodyInit | null; delay?: number }> = new Map();
let originalFetch: typeof fetch;

function mockFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
  const responseConfig = mockFetchResponses.get(url) || 
                         mockFetchResponses.get("*"); // Fallback to wildcard

  if (!responseConfig) {
    console.error(`[Mock Fetch] No response configured for URL: ${url}. Configured URLs:`, Array.from(mockFetchResponses.keys()));
    return Promise.resolve(new Response("Mock fetch error: No response configured", { status: 500 }));
  }

  const headers = new Headers(responseConfig.headers);
  const response = new Response(responseConfig.body, {
    status: responseConfig.status,
    headers: headers,
  });

  if (responseConfig.delay) {
    return new Promise(resolve => setTimeout(() => resolve(response), responseConfig.delay));
  }
  return Promise.resolve(response);
}


// --- Test Suite ---
Deno.testSuite("Agent Request Handler (services/agent/handler.ts)", async (t) => {
  const serviceConfigs: AgentServiceConfig[] = [
    { id: "s1", name: "WebService", type: "http", local_host: "localhost", local_port: 3000, subdomainOrPath: "web" },
    { id: "s2", name: "ApiService", type: "http", local_host: "127.0.0.1", local_port: 8080, subdomainOrPath: "api" },
    { id: "s3", name: "RootService", type: "http", local_host: "localhost", local_port: 9000, subdomainOrPath: "" }, // For testing root path if subdomainOrPath is empty
  ];
  const agentConfig: AgentConfig = { // Needed for MockConnector
    relayUrl: "wss://mock.relay", apiKey: "mock-key", services: serviceConfigs
  };


  t.beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;
    mockFetchResponses.clear();
    MockConnector.reset();
  });

  t.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  await t.step("Successful GET request forwarding", async () => {
    const mockConnector = new MockConnector(agentConfig);
    const handler = new AgentRequestHandler(serviceConfigs, mockConnector as any);

    const localUrl = `http://${serviceConfigs[0].local_host}:${serviceConfigs[0].local_port}/data?param=1`;
    mockFetchResponses.set(localUrl, {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Custom-Header": "TestValue" },
      body: JSON.stringify({ message: "Success" }),
    });

    const incomingRequest: AgentHttpRequest = {
      type: "httpRequest",
      requestId: "req-get-1",
      data: {
        method: "GET",
        path: "/web/data?param=1", // Path includes subdomainOrPath
        headers: { "accept": "application/json" },
        body: null,
      },
    };

    await handler.handleIncomingRequest(incomingRequest);

    assertEquals(mockConnector.sentMessages.length, 1);
    const responseMessage = mockConnector.sentMessages[0] as AgentHttpResponse;
    assertEquals(responseMessage.type, "httpResponse");
    assertEquals(responseMessage.requestId, "req-get-1");
    assertEquals(responseMessage.data.status, 200);
    assertEquals(responseMessage.data.headers["content-type"], "application/json");
    assertEquals(responseMessage.data.headers["x-custom-header"], "TestValue");
    assertEquals(JSON.parse(responseMessage.data.body as string).message, "Success");
  });

  await t.step("Successful POST request with JSON body (text)", async () => {
    const mockConnector = new MockConnector(agentConfig);
    const handler = new AgentRequestHandler(serviceConfigs, mockConnector as any);
    const requestPayload = { data: "sample" };

    const localUrl = `http://${serviceConfigs[1].local_host}:${serviceConfigs[1].local_port}/submit`;
    mockFetchResponses.set(localUrl, {
      status: 201,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "new-resource" }),
    });

    const incomingRequest: AgentHttpRequest = {
      type: "httpRequest",
      requestId: "req-post-1",
      data: {
        method: "POST",
        path: "/api/submit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestPayload), // Body sent as string by relay
      },
    };

    await handler.handleIncomingRequest(incomingRequest);

    assertEquals(mockConnector.sentMessages.length, 1);
    const responseMessage = mockConnector.sentMessages[0] as AgentHttpResponse;
    assertEquals(responseMessage.data.status, 201);
    assertEquals(JSON.parse(responseMessage.data.body as string).id, "new-resource");
  });
  
  await t.step("POST request with base64 encoded binary body", async () => {
    const mockConnector = new MockConnector(agentConfig);
    const handler = new AgentRequestHandler(serviceConfigs, mockConnector as any);
    
    // Simulate binary data (e.g., small image) being sent as base64 from relay
    const originalBinaryData = new Uint8Array([1, 2, 3, 4, 5]);
    let base64BodyFromRelay = '';
    originalBinaryData.forEach(byte => base64BodyFromRelay += String.fromCharCode(byte));
    base64BodyFromRelay = btoa(base64BodyFromRelay);


    const localUrl = `http://${serviceConfigs[0].local_host}:${serviceConfigs[0].local_port}/binary-upload`;
    // Mock fetch should receive the raw Uint8Array after base64 decoding
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
        if (url === localUrl && init?.body instanceof Uint8Array) {
            assert(init.body.byteLength === originalBinaryData.byteLength, "Byte length mismatch");
            for(let i=0; i<originalBinaryData.length; i++) {
                assertEquals((init.body as Uint8Array)[i], originalBinaryData[i], `Byte mismatch at index ${i}`);
            }
            return Promise.resolve(new Response("OK", { status: 200 }));
        }
        return Promise.resolve(new Response("Mock fetch error: Unexpected binary body or URL", { status: 500 }));
    };


    const incomingRequest: AgentHttpRequest = {
      type: "httpRequest",
      requestId: "req-b64-1",
      data: {
        method: "POST",
        path: "/web/binary-upload",
        headers: { "content-type": "application/octet-stream" }, // Indicate binary type
        body: base64BodyFromRelay,
      },
    };

    await handler.handleIncomingRequest(incomingRequest);

    assertEquals(mockConnector.sentMessages.length, 1);
    const responseMessage = mockConnector.sentMessages[0] as AgentHttpResponse;
    assertEquals(responseMessage.data.status, 200);
  });

  await t.step("Response with binary body (base64 encoded back to relay)", async () => {
    const mockConnector = new MockConnector(agentConfig);
    const handler = new AgentRequestHandler(serviceConfigs, mockConnector as any);

    const binaryResponseData = new Uint8Array([10, 20, 30]);
    let expectedBase64ResponseBody = '';
    binaryResponseData.forEach(byte => expectedBase64ResponseBody += String.fromCharCode(byte));
    expectedBase64ResponseBody = btoa(expectedBase64ResponseBody);

    const localUrl = `http://${serviceConfigs[0].local_host}:${serviceConfigs[0].local_port}/get-binary`;
    mockFetchResponses.set(localUrl, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
      body: binaryResponseData,
    });

    const incomingRequest: AgentHttpRequest = {
      type: "httpRequest", requestId: "req-get-bin-1",
      data: { method: "GET", path: "/web/get-binary", headers: {}, body: null },
    };
    await handler.handleIncomingRequest(incomingRequest);

    assertEquals(mockConnector.sentMessages.length, 1);
    const responseMessage = mockConnector.sentMessages[0] as AgentHttpResponse;
    assertEquals(responseMessage.data.status, 200);
    assertEquals(responseMessage.data.headers["content-type"], "application/octet-stream");
    assertEquals(responseMessage.data.body, expectedBase64ResponseBody, "Response body to relay should be base64");
  });


  await t.step("Error: No matching service found", async () => {
    const mockConnector = new MockConnector(agentConfig);
    const handler = new AgentRequestHandler(serviceConfigs, mockConnector as any);
    const incomingRequest: AgentHttpRequest = {
      type: "httpRequest", requestId: "req-err-1",
      data: { method: "GET", path: "/nonexistent/path", headers: {}, body: null },
    };
    await handler.handleIncomingRequest(incomingRequest);

    assertEquals(mockConnector.sentMessages.length, 1);
    const responseMessage = mockConnector.sentMessages[0] as AgentHttpResponse;
    assertEquals(responseMessage.data.status, 404);
    assertStringIncludes(JSON.parse(responseMessage.data.body as string).error, "Target service not found");
  });

  await t.step("Error: Local service fetch fails (connection refused)", async () => {
    const mockConnector = new MockConnector(agentConfig);
    const handler = new AgentRequestHandler(serviceConfigs, mockConnector as any);
    
    // Override global fetch to simulate network error
    const originalFetchTemp = globalThis.fetch;
    globalThis.fetch = (_input, _init) => Promise.reject(new TypeError("fetch failed")); // Deno throws TypeError for network errors

    const incomingRequest: AgentHttpRequest = {
      type: "httpRequest", requestId: "req-err-2",
      data: { method: "GET", path: "/web/resource", headers: {}, body: null },
    };
    await handler.handleIncomingRequest(incomingRequest);
    globalThis.fetch = originalFetchTemp; // Restore

    assertEquals(mockConnector.sentMessages.length, 1);
    const responseMessage = mockConnector.sentMessages[0] as AgentHttpResponse;
    assertEquals(responseMessage.data.status, 503, "Status should be 503 for fetch failed");
    const body = JSON.parse(responseMessage.data.body as string);
    assertStringIncludes(body.error, "Local service connection refused");
  });

  await t.step("Error: Local service returns an error status (e.g., 500)", async () => {
    const mockConnector = new MockConnector(agentConfig);
    const handler = new AgentRequestHandler(serviceConfigs, mockConnector as any);

    const localUrl = `http://${serviceConfigs[0].local_host}:${serviceConfigs[0].local_port}/server-error`;
    mockFetchResponses.set(localUrl, {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Internal Server Error" }),
    });

    const incomingRequest: AgentHttpRequest = {
      type: "httpRequest", requestId: "req-err-3",
      data: { method: "GET", path: "/web/server-error", headers: {}, body: null },
    };
    await handler.handleIncomingRequest(incomingRequest);

    assertEquals(mockConnector.sentMessages.length, 1);
    const responseMessage = mockConnector.sentMessages[0] as AgentHttpResponse;
    assertEquals(responseMessage.data.status, 500);
    assertEquals(JSON.parse(responseMessage.data.body as string).error, "Internal Server Error");
  });
  
  await t.step("Path stripping for service matching", async () => {
    const mockConnector = new MockConnector(agentConfig);
    const handler = new AgentRequestHandler(serviceConfigs, mockConnector as any);

    const localUrlRoot = `http://${serviceConfigs[0].local_host}:${serviceConfigs[0].local_port}/`; // expecting "/"
    const localUrlWithPath = `http://${serviceConfigs[0].local_host}:${serviceConfigs[0].local_port}/specific/page`;
    
    mockFetchResponses.set(localUrlRoot, { status: 200, headers: {}, body: "root page" });
    mockFetchResponses.set(localUrlWithPath, { status: 200, headers: {}, body: "specific page" });

    // Test request to just the service prefix
    let incomingRequest: AgentHttpRequest = {
      type: "httpRequest", requestId: "req-path-1",
      data: { method: "GET", path: "/web", headers: {}, body: null }, // Should map to "/" locally
    };
    await handler.handleIncomingRequest(incomingRequest);
    assertEquals(mockConnector.sentMessages[0].data.status, 200);
    assertEquals(mockConnector.sentMessages[0].data.body, "root page");
    
    mockConnector.sentMessages = []; // Clear for next test

    // Test request to service prefix with trailing slash
    incomingRequest = {
      type: "httpRequest", requestId: "req-path-2",
      data: { method: "GET", path: "/web/", headers: {}, body: null }, // Should also map to "/" locally
    };
    await handler.handleIncomingRequest(incomingRequest);
    assertEquals(mockConnector.sentMessages[0].data.status, 200);
    assertEquals(mockConnector.sentMessages[0].data.body, "root page");

    mockConnector.sentMessages = [];

    // Test request to service prefix with sub-path
    incomingRequest = {
      type: "httpRequest", requestId: "req-path-3",
      data: { method: "GET", path: "/web/specific/page", headers: {}, body: null },
    };
    await handler.handleIncomingRequest(incomingRequest);
    assertEquals(mockConnector.sentMessages[0].data.status, 200);
    assertEquals(mockConnector.sentMessages[0].data.body, "specific page");
  });

});
