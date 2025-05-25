import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.212.0/assert/mod.ts";
import { FreshContext, Handlers } from "$fresh/server.ts";
import { handler } from "./[resourceId].tsx"; // Assuming the file is named [resourceId].tsx
import { mockKv } from "../../test_utils/mock_kv.ts";

// Mock dependencies from services/database.ts
import * as db from "../../services/database.ts";
import { FileMetadata } from "../../shared/fileshare.ts";

// --- Test Setup ---
// Replace the real Deno KV with our mock
(db as any).db = mockKv;

// --- Mocks for Database Functions ---
// Store mock data here for getFileMetadata and getFileData
let mockFileMetadataDb: Record<string, FileMetadata> = {};
let mockFileDataDb: Record<string, Uint8Array> = {};

const originalGetFileMetadata = db.getFileMetadata;
const originalGetFileData = db.getFileData;

// --- Test Suite ---
Deno.testSuite("Resource Sharing Download Route (/shared/[resourceId].tsx)", async (t) => {
  t.beforeEach(() => {
    mockKv.clear(); // Clear the general mock KV store if it's used by other db functions
    mockFileMetadataDb = {}; // Clear specific file metadata mock
    mockFileDataDb = {};   // Clear specific file data mock

    // Mock database functions used by the route handler
    (db as any).getFileMetadata = async (resourceId: string): Promise<FileMetadata | null> => {
      return mockFileMetadataDb[resourceId] || null;
    };
    (db as any).getFileData = async (resourceId: string): Promise<Uint8Array | null> => {
      return mockFileDataDb[resourceId] || null;
    };
  });

  t.afterAll(() => {
    // Restore original functions
    (db as any).getFileMetadata = originalGetFileMetadata;
    (db as any).getFileData = originalGetFileData;
    mockKv.clear();
  });

  // Helper to call the route's GET handler
  const callGetHandler = async (resourceId: string): Promise<Response> => {
    const req = new Request(`http://localhost/shared/${resourceId}`);
    const ctx = {
      params: { resourceId },
      // Add other FreshContext properties if needed
    } as unknown as FreshContext;
    if (typeof handler === "function" || !handler.GET) {
        throw new Error("Handler is not a Handlers object with a GET method");
    }
    return await handler.GET(req, ctx);
  };

  await t.step("Successful File Download", async () => {
    const resourceId = "test-file-123";
    const fileContent = "This is a test file.";
    const fileData = new TextEncoder().encode(fileContent);
    const metadata: FileMetadata = {
      resourceId,
      filename: "test.txt",
      filetype: "text/plain",
      size: fileData.byteLength,
      status: "completed",
      apiKey: "any-api-key",
      createdAt: new Date().toISOString(),
    };

    mockFileMetadataDb[resourceId] = metadata;
    mockFileDataDb[resourceId] = fileData;

    const response = await callGetHandler(resourceId);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("Content-Type"), "text/plain");
    assertEquals(response.headers.get("Content-Disposition"), `attachment; filename="${metadata.filename}"`);
    assertEquals(response.headers.get("Content-Length"), metadata.size.toString());

    const responseBody = await response.text();
    assertEquals(responseBody, fileContent);
  });

  await t.step("File Not Found - Metadata Missing", async () => {
    const resourceId = "nonexistent-file";
    const response = await callGetHandler(resourceId);
    assertEquals(response.status, 404);
    const body = await response.json();
    assertEquals(body.error, "File not found.");
  });

  await t.step("File Not Found - Data Missing (metadata exists)", async () => {
    const resourceId = "metadata-only-file";
    const metadata: FileMetadata = {
      resourceId,
      filename: "incomplete.dat",
      filetype: "application/octet-stream",
      size: 100,
      status: "completed", // Status is completed, but data is missing
      apiKey: "any-api-key",
      createdAt: new Date().toISOString(),
    };
    mockFileMetadataDb[resourceId] = metadata;
    // mockFileDataDb[resourceId] remains undefined

    const response = await callGetHandler(resourceId);
    assertEquals(response.status, 500, "Should be server error if data is missing for completed file");
    const body = await response.json();
    assertStringIncludes(body.error, "File data not found, though metadata exists.");
  });

  await t.step("File Not Ready - Status Not Completed", async () => {
    const resourceId = "pending-file";
    const metadata: FileMetadata = {
      resourceId,
      filename: "pending.dat",
      filetype: "application/octet-stream",
      size: 0,
      status: "pending", // Not completed
      apiKey: "any-api-key",
      createdAt: new Date().toISOString(),
    };
    mockFileMetadataDb[resourceId] = metadata;

    const response = await callGetHandler(resourceId);
    assertEquals(response.status, 403, "Should be Forbidden if status is not completed");
    const body = await response.json();
    assertStringIncludes(body.error, "File status is 'pending', not available for download.");
  });

  await t.step("Download with Special Characters in Filename", async () => {
    const resourceId = "file-special-chars";
    const filename = "test file with spaces & symbols!.txt";
    const fileContent = "Special chars test.";
    const fileData = new TextEncoder().encode(fileContent);
    const metadata: FileMetadata = {
      resourceId,
      filename,
      filetype: "text/plain",
      size: fileData.byteLength,
      status: "completed",
      apiKey: "any-api-key",
      createdAt: new Date().toISOString(),
    };

    mockFileMetadataDb[resourceId] = metadata;
    mockFileDataDb[resourceId] = fileData;

    const response = await callGetHandler(resourceId);
    assertEquals(response.status, 200);
    assertEquals(
        response.headers.get("Content-Disposition"), 
        `attachment; filename="${encodeURIComponent(filename)}"`,
        "Filename in Content-Disposition should be URI encoded"
    );
    const responseBody = await response.text();
    assertEquals(responseBody, fileContent);
  });
  
  await t.step("Missing Resource ID in Path", async () => {
    // This scenario is typically handled by Fresh routing itself if the param is required.
    // However, if the handler was called with ctx.params.resourceId being undefined/empty:
    const req = new Request(`http://localhost/shared/`); // No resourceId
    const ctx = { params: { resourceId: "" } } as unknown as FreshContext;
     if (typeof handler === "function" || !handler.GET) {
        throw new Error("Handler is not a Handlers object with a GET method");
    }
    const response = await handler.GET(req, ctx);
    assertEquals(response.status, 400);
    const body = await response.json();
    assertEquals(body.error, "Resource ID is missing.");
  });

});
