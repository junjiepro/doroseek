import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.212.0/assert/mod.ts";
import { mockKv } from "../../../test_utils/mock_kv.ts";
import * as db from "../../database.ts";
import {
  fileshareWebSocketHandler,
} from "./fileshare.ts";
import {
  FileShareMessage,
  ClientInitiateUploadMessage,
  ServerUploadReadyMessage,
  ClientFileDataMessage,
  ServerUploadCompleteMessage,
  FileMetadata,
  ServerErrorStateMessage,
} from "../../../shared/fileshare.ts";

// --- Test Setup ---
(db as any).db = mockKv; // Replace real Deno KV with mock

// --- Mock WebSocket for Fileshare ---
class MockFileShareWebSocket {
  static instances: MockFileShareWebSocket[] = [];
  public readyState: number = WebSocket.CONNECTING;
  public sentMessages: FileShareMessage[] = [];
  public closed: boolean = false;
  public closeCode?: number;

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event | ErrorEvent) => void) | null = null;

  constructor() {
    MockFileShareWebSocket.instances.push(this);
  }

  send(message: string) {
    try {
      this.sentMessages.push(JSON.parse(message) as FileShareMessage);
    } catch (e) {
      console.error("MockFileShareWebSocket: Failed to parse outgoing message", message, e);
      this.sentMessages.push({ type: "raw_unparsed", payload: message } as any);
    }
  }

  close(code?: number, _reason?: string) {
     if (this.readyState === WebSocket.OPEN || this.readyState === WebSocket.CONNECTING) {
      this.readyState = WebSocket.CLOSING;
      setTimeout(() => {
        this.readyState = WebSocket.CLOSED;
        this.closed = true;
        this.closeCode = code;
        if (this.onclose) {
          this.onclose(new CloseEvent("close", { code }) as CloseEvent);
        }
      }, 0);
    }
  }

  simulateOpen() {
    this.readyState = WebSocket.OPEN;
    if (this.onopen) this.onopen();
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
     if (this.readyState === WebSocket.OPEN || this.readyState === WebSocket.CONNECTING) {
        this.close(1006, "Simulated error then close");
    }
  }


  static resetInstances() {
    MockFileShareWebSocket.instances = [];
  }

  findMessage<T extends FileShareMessage>(type: T["type"]): T | undefined {
    return this.sentMessages.find(msg => msg.type === type) as T | undefined;
  }
}

const mockFileShareUpgradeWebSocket = (_request: Request): { response: Response; socket: WebSocket } => {
  const mockSocket = new MockFileShareWebSocket();
  const headers = new Headers({ "Upgrade": "websocket", "Connection": "Upgrade" });
  return {
    response: new Response(null, { status: 101, headers }),
    socket: mockSocket as any,
  };
};

// --- Test Suite ---
Deno.testSuite("Fileshare Service (services/mcp/server/fileshare.ts)", async (t) => {
  const originalUpgradeWebSocket = (Deno as any).upgradeWebSocket;
  const originalEnvGet = Deno.env.get;

  t.beforeEach(() => {
    mockKv.clear();
    MockFileShareWebSocket.resetInstances();
    (Deno as any).upgradeWebSocket = mockFileShareUpgradeWebSocket;
    // Mock Deno.env.get for PUBLIC_HOSTNAME
    (Deno.env as any).get = (key: string) => {
        if (key === "PUBLIC_HOSTNAME") return "test.example.com";
        return originalEnvGet(key);
    };
  });

  t.afterAll(() => {
    (Deno as any).upgradeWebSocket = originalUpgradeWebSocket;
    (Deno.env as any).get = originalEnvGet; // Restore original
    mockKv.clear();
  });

  const connectClientAndOpen = (apiKey: string = "test-fs-apikey", pathParam?: string): MockFileShareWebSocket => {
    const mockRequest = new Request("http://localhost/mcp/fileshare/upload", { // pathParam isn't heavily used by handler yet
      headers: { "upgrade": "websocket", "sec-websocket-key": "test-key" },
    });
    fileshareWebSocketHandler(mockRequest, pathParam, apiKey);
    const ws = MockFileShareWebSocket.instances[MockFileShareWebSocket.instances.length - 1];
    ws.simulateOpen();
    return ws;
  };

  await t.step("Upload Initiation - Successful", async () => {
    const apiKey = "fs-init-key";
    const ws = connectClientAndOpen(apiKey);

    const initPayload: ClientInitiateUploadMessage["payload"] = {
      filename: "test.txt",
      filetype: "text/plain",
      size: 123,
    };
    ws.simulateMessage({ type: "initiateUpload", payload: initPayload } as ClientInitiateUploadMessage);
    await new Promise(r => setTimeout(r, 0)); // Allow async operations

    const readyMsg = ws.findMessage<ServerUploadReadyMessage>("uploadReady");
    assertExists(readyMsg, "Should receive uploadReady message");
    assertExists(readyMsg.payload.resourceId, "uploadReady payload should have resourceId");

    const metadata = await db.getFileMetadata(readyMsg.payload.resourceId);
    assertExists(metadata, "FileMetadata should be saved");
    assertEquals(metadata?.filename, initPayload.filename);
    assertEquals(metadata?.filetype, initPayload.filetype);
    assertEquals(metadata?.size, initPayload.size);
    assertEquals(metadata?.apiKey, apiKey);
    assertEquals(metadata?.status, "pending");
  });

  await t.step("Upload Initiation - File too large", async () => {
    const ws = connectClientAndOpen();
    const MAX_FILE_SIZE_BYTES = 60 * 1024;
    const initPayload: ClientInitiateUploadMessage["payload"] = {
      filename: "largefile.bin",
      filetype: "application/octet-stream",
      size: MAX_FILE_SIZE_BYTES + 1,
    };
    ws.simulateMessage({ type: "initiateUpload", payload: initPayload } as ClientInitiateUploadMessage);
    await new Promise(r => setTimeout(r, 0));

    const errorMsg = ws.findMessage<ServerErrorStateMessage>("error");
    assertExists(errorMsg, "Should receive an error message for large file");
    assertStringIncludes(errorMsg.payload.message, "exceeds maximum");
  });
  
  await t.step("Upload Initiation - Missing API Key (handler level)", async () => {
    const mockRequest = new Request("http://localhost/mcp/fileshare/upload", {
      headers: { "upgrade": "websocket", "sec-websocket-key": "test-key" },
    });
    // Call handler directly without API key
    const response = fileshareWebSocketHandler(mockRequest, "upload", undefined);
    assertEquals(response.status, 401);
    const body = await response.json();
    assertEquals(body.type, "error");
    assertEquals(body.payload.message, "API key is required for file sharing.");
  });


  await t.step("File Data Upload - Successful (non-chunked)", async () => {
    const apiKey = "fs-data-key";
    const ws = connectClientAndOpen(apiKey);

    // 1. Initiate
    const resourceId = "temp-rid-for-data-test"; // Predefined for easier testing or get from actual init
    const fileSize = 10; // bytes
    (ws as any).currentUploadResourceId = resourceId; // Simulate state after successful init
    (ws as any).currentUploadMetadata = { // Simulate state after successful init
        resourceId, filename: "data.bin", filetype: "application/octet-stream", size: fileSize,
        status: "pending", apiKey, createdAt: new Date().toISOString()
    } as FileMetadata;
    // In a real test, we'd get resourceId from ServerUploadReadyMessage
    // Forcing state for this focused test:
    await db.saveFileMetadata((ws as any).currentUploadMetadata);


    // 2. Send File Data
    const fileContent = "HelloDeno!"; // 10 bytes
    const base64Data = btoa(fileContent);
    const fileDataPayload: ClientFileDataMessage["payload"] = {
      resourceId,
      data: base64Data,
    };
    ws.simulateMessage({ type: "fileData", payload: fileDataPayload } as ClientFileDataMessage);
    await new Promise(r => setTimeout(r, 10)); // Allow async db operations

    const completeMsg = ws.findMessage<ServerUploadCompleteMessage>("uploadComplete");
    assertExists(completeMsg, "Should receive uploadComplete message");
    assertEquals(completeMsg.payload.resourceId, resourceId);
    assertStringIncludes(completeMsg.payload.downloadUrl, `/shared/${resourceId}`);

    const metadata = await db.getFileMetadata(resourceId);
    assertEquals(metadata?.status, "completed", "Metadata status should be 'completed'");

    const savedData = await db.getFileData(resourceId);
    assertExists(savedData, "File data should be saved");
    const decodedSavedData = new TextDecoder().decode(savedData);
    assertEquals(decodedSavedData, fileContent, "Saved file content should match original");
  });

  await t.step("File Data Upload - Size Mismatch", async () => {
    const ws = connectClientAndOpen();
    const resourceId = "rid-size-mismatch";
    const initiatedSize = 20;
    const actualDataSize = 10; // Mismatch

    (ws as any).currentUploadResourceId = resourceId;
    (ws as any).currentUploadMetadata = {
        resourceId, filename: "mismatch.txt", filetype: "text/plain", size: initiatedSize,
        status: "pending", apiKey: "any", createdAt: new Date().toISOString()
    } as FileMetadata;
    await db.saveFileMetadata((ws as any).currentUploadMetadata);

    const fileContent = "short data"; // 10 bytes
    const base64Data = btoa(fileContent);
    ws.simulateMessage({ type: "fileData", payload: { resourceId, data: base64Data } } as ClientFileDataMessage);
    await new Promise(r => setTimeout(r, 0));

    const errorMsg = ws.findMessage<ServerErrorStateMessage>("error");
    assertExists(errorMsg, "Should receive an error for size mismatch");
    assertStringIncludes(errorMsg.payload.message, "does not match initiated size");
    
    const metadata = await db.getFileMetadata(resourceId);
    // Status might remain 'pending' or become 'failed' depending on exact error handling in main code.
    // Current fileshare.ts does not explicitly set to 'failed' on size mismatch before saveFileData.
    // Let's assume it should not be 'completed'.
    assert(metadata?.status !== "completed", "Status should not be completed on size mismatch");
  });
  
  await t.step("File Data Upload - Invalid Base64 Data", async () => {
    const ws = connectClientAndOpen();
    const resourceId = "rid-invalid-b64";
    (ws as any).currentUploadResourceId = resourceId;
    (ws as any).currentUploadMetadata = {
        resourceId, filename: "invalid.txt", filetype: "text/plain", size: 10,
        status: "pending", apiKey: "any", createdAt: new Date().toISOString()
    } as FileMetadata;
    await db.saveFileMetadata((ws as any).currentUploadMetadata);

    ws.simulateMessage({ type: "fileData", payload: { resourceId, data: "This is not valid base64" } } as ClientFileDataMessage);
    await new Promise(r => setTimeout(r, 10));

    const errorMsg = ws.findMessage<ServerErrorStateMessage>("error");
    assertExists(errorMsg, "Should receive an error for invalid base64");
    assertStringIncludes(errorMsg.payload.message, "Invalid base64 data", "Error message should indicate base64 issue");
    
    const metadata = await db.getFileMetadata(resourceId);
    assertEquals(metadata?.status, "failed", "Status should be 'failed' after invalid base64 data error");
  });


  await t.step("Connection Close During Pending Upload - Marks as Failed", async () => {
    const apiKey = "fs-close-key";
    const ws = connectClientAndOpen(apiKey);

    // Initiate upload
    const initPayload: ClientInitiateUploadMessage["payload"] = {
      filename: "pending_close.dat", filetype: "application/octet-stream", size: 500,
    };
    ws.simulateMessage({ type: "initiateUpload", payload: initPayload });
    await new Promise(r => setTimeout(r, 0));
    const readyMsg = ws.findMessage<ServerUploadReadyMessage>("uploadReady");
    const resourceId = readyMsg!.payload.resourceId;
    assertExists(resourceId);

    // Simulate connection close before fileData is sent
    ws.close(1001, "Client going away");
    await new Promise(r => setTimeout(r, 10)); // Allow onclose handler to run

    const metadata = await db.getFileMetadata(resourceId);
    assertExists(metadata, "Metadata should still exist");
    assertEquals(metadata?.status, "failed", "Status should be 'failed' if closed while pending");
  });
  
  await t.step("Non-WebSocket Request - Handler returns error", () => {
    const mockRequestHttp = new Request("http://localhost/mcp/fileshare/upload", {});
    const response = fileshareWebSocketHandler(mockRequestHttp, "upload", "any-key");
    assertEquals(response.status, 400);
    return response.json().then(body => {
        assertEquals(body.type, "error");
        assertStringIncludes(body.payload.message, "WebSocket upgrade expected");
    });
  });

});
