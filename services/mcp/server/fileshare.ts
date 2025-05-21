import { v4 as uuidv4 } from "uuid";
import {
  FileShareMessage,
  ClientInitiateUploadMessage,
  ServerUploadReadyMessage,
  ClientFileDataMessage,
  // ClientUploadCompleteMessage, // Will be implicitly handled by ClientFileData for non-chunked
  ServerUploadCompleteMessage,
  ServerErrorStateMessage,
  FileMetadata,
} from "../../../shared/fileshare.ts";
import {
  saveFileMetadata,
  updateFileStatus,
  getFileMetadata,
  saveFileData,
  // deleteFileData, // For cleanup on error/close
} from "../../database.ts";

// For small files, we might not need a complex in-memory UploadState if we handle one file per connection session simply.
// If multiple uploads per connection or more complex state is needed, this would be used.
// interface UploadState {
//   resourceId: string;
//   filename: string;
//   filetype: string;
//   size: number;
//   apiKey: string;
//   status: "pending" | "uploading" | "completed" | "failed";
// }
// const activeUploads = new Map<string, UploadState>(); // Key: resourceId or a session-based key

const MAX_FILE_SIZE_BYTES = 60 * 1024; // Max size for single KV entry (60KB to be safe)
const SHARED_DOWNLOAD_BASE_URL = Deno.env.get("PUBLIC_HOSTNAME") 
    ? `https://${Deno.env.get("PUBLIC_HOSTNAME")}/shared`
    : "http://localhost:8000/shared";


// Helper to convert base64 string to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  try {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    console.error("[Fileshare] Error decoding base64 string:", e.message);
    throw new Error("Invalid base64 data");
  }
}

export function fileshareWebSocketHandler(
  request: Request,
  _pathParam?: string, // e.g., "upload", not strictly used if only one WebSocket endpoint for fileshare
  apiKey?: string,
): Response {
  if (!apiKey) {
    return new Response(
      JSON.stringify({
        type: "error",
        payload: { message: "API key is required for file sharing." },
      } as ServerErrorStateMessage),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response(
      JSON.stringify({
        type: "error",
        payload: { message: "WebSocket upgrade expected for file sharing." },
      } as ServerErrorStateMessage),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { response, socket } = Deno.upgradeWebSocket(request);

  // State for the current WebSocket connection (simplistic: one upload at a time per connection)
  let currentUploadResourceId: string | null = null;
  let currentUploadMetadata: FileMetadata | null = null;

  socket.onopen = () => {
    console.log(
      `[MCP Fileshare] WebSocket connection opened. API Key: ${apiKey}`,
    );
    // Optionally send a "connected" message or wait for ClientInitiateUploadMessage
  };

  socket.onmessage = async (event: MessageEvent) => {
    let msg: FileShareMessage;
    try {
      msg = JSON.parse(event.data as string) as FileShareMessage;
    } catch (e) {
      console.error("[MCP Fileshare] Failed to parse message:", event.data, e);
      socket.send(JSON.stringify({
        type: "error",
        payload: { message: "Invalid JSON message." },
      } as ServerErrorStateMessage));
      return;
    }

    console.log(`[MCP Fileshare] Received message (RID: ${currentUploadResourceId || "N/A"}):`, msg.type);

    switch (msg.type) {
      case "initiateUpload": {
        if (currentUploadResourceId) {
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: "An upload is already in progress on this connection." },
          } as ServerErrorStateMessage));
          return;
        }

        const initPayload = (msg as ClientInitiateUploadMessage).payload;
        if (!initPayload.filename || !initPayload.filetype || typeof initPayload.size !== 'number') {
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: "Invalid initiateUpload payload: filename, filetype, and size are required." },
          } as ServerErrorStateMessage));
          return;
        }

        if (initPayload.size > MAX_FILE_SIZE_BYTES) {
            socket.send(JSON.stringify({
                type: "error",
                payload: { message: `File size ${initPayload.size} exceeds maximum of ${MAX_FILE_SIZE_BYTES} bytes for non-chunked upload.` },
            } as ServerErrorStateMessage));
            return;
        }

        currentUploadResourceId = uuidv4();
        currentUploadMetadata = {
          resourceId: currentUploadResourceId,
          filename: initPayload.filename,
          filetype: initPayload.filetype,
          size: initPayload.size,
          status: "pending",
          apiKey: apiKey, // Associate with the API key from the connection
          createdAt: new Date().toISOString(),
        };

        try {
          await saveFileMetadata(currentUploadMetadata);
          const readyMessage: ServerUploadReadyMessage = {
            type: "uploadReady",
            payload: { resourceId: currentUploadResourceId },
          };
          socket.send(JSON.stringify(readyMessage));
          console.log(`[MCP Fileshare] Upload initiated for ${currentUploadResourceId} (${initPayload.filename}) by API Key ${apiKey}.`);
        } catch (dbError) {
          console.error("[MCP Fileshare] Failed to save initial file metadata:", dbError);
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: "Failed to initiate upload (database error)." },
          } as ServerErrorStateMessage));
          currentUploadResourceId = null;
          currentUploadMetadata = null;
        }
        break;
      }

      case "fileData": {
        const fileDataPayload = (msg as ClientFileDataMessage).payload;
        if (!currentUploadResourceId || !currentUploadMetadata || fileDataPayload.resourceId !== currentUploadResourceId) {
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: "Upload not initiated or resourceId mismatch." },
            resourceId: fileDataPayload.resourceId,
          } as ServerErrorStateMessage));
          return;
        }

        if (!fileDataPayload.data) {
            socket.send(JSON.stringify({
                type: "error",
                payload: { message: "fileData message missing 'data' field." },
                resourceId: currentUploadResourceId,
            } as ServerErrorStateMessage));
            return;
        }

        try {
          const fileBytes = base64ToUint8Array(fileDataPayload.data);
          if (fileBytes.byteLength !== currentUploadMetadata.size) {
            socket.send(JSON.stringify({
                type: "error",
                payload: { message: `File data size (${fileBytes.byteLength}) does not match initiated size (${currentUploadMetadata.size}).`},
                resourceId: currentUploadResourceId,
            } as ServerErrorStateMessage));
            // Optionally reset state or mark as failed
            return;
          }

          await saveFileData(currentUploadResourceId, fileBytes);
          await updateFileStatus(currentUploadResourceId, "completed");

          const downloadUrl = `${SHARED_DOWNLOAD_BASE_URL}/${currentUploadResourceId}`;
          const completeMessage: ServerUploadCompleteMessage = {
            type: "uploadComplete",
            payload: { resourceId: currentUploadResourceId, downloadUrl },
          };
          socket.send(JSON.stringify(completeMessage));
          console.log(`[MCP Fileshare] File ${currentUploadResourceId} uploaded and saved by API Key ${apiKey}. Download: ${downloadUrl}`);
          
          // Reset for next potential upload on this connection after successful completion
          currentUploadResourceId = null;
          currentUploadMetadata = null;

        } catch (error) { // Catches base64 decoding errors and DB errors
          console.error(`[MCP Fileshare] Error processing fileData for ${currentUploadResourceId}:`, error);
          await updateFileStatus(currentUploadResourceId, "failed").catch(e => console.error("Failed to update status to failed", e));
          socket.send(JSON.stringify({
            type: "error",
            payload: { message: `Failed to process file data: ${error.message}` },
            resourceId: currentUploadResourceId,
          } as ServerErrorStateMessage));
           // Keep currentUploadResourceId for potential cleanup in onclose/onerror
        }
        break;
      }
      // ClientUploadCompleteMessage is not strictly needed for non-chunked, as ClientFileData implies one shot.
      // If it were used, it would trigger the status update and ServerUploadCompleteMessage.

      default:
        console.log(`[MCP Fileshare] Unknown message type: ${msg.type}`);
        socket.send(JSON.stringify({
          type: "error",
          payload: { message: `Unknown message type: ${msg.type}` },
        } as ServerErrorStateMessage));
    }
  };

  socket.onclose = async (event: CloseEvent) => {
    console.log(
      `[MCP Fileshare] WebSocket closed (RID: ${currentUploadResourceId || "N/A"}). Code: ${event.code}, Reason: ${event.reason}`,
    );
    if (currentUploadResourceId && currentUploadMetadata && currentUploadMetadata.status === "pending") {
      // If upload was initiated but not completed, mark as failed or delete.
      console.log(`[MCP Fileshare] Cleaning up pending upload ${currentUploadResourceId} due to connection close.`);
      await updateFileStatus(currentUploadResourceId, "failed").catch(e => console.error("Failed to update status to failed on close", e));
      // Optionally delete the file data if any partial data could have been saved (not in current non-chunked model)
      // await deleteFileData(currentUploadResourceId);
    }
    currentUploadResourceId = null;
    currentUploadMetadata = null;
  };

  socket.onerror = (errorEvent: Event | ErrorEvent) => {
    const errorMessage = (errorEvent as ErrorEvent)?.message || "WebSocket error";
    console.error(
      `[MCP Fileshare] Error on WebSocket (RID: ${currentUploadResourceId || "N/A"}): ${errorMessage}`,
      errorEvent,
    );
    // onclose will usually follow and handle cleanup.
    // If not, ensure cleanup like in onclose.
    if (currentUploadResourceId && currentUploadMetadata && currentUploadMetadata.status === "pending") {
        console.error(`[MCP Fileshare] Error triggered cleanup for pending upload ${currentUploadResourceId}.`);
        updateFileStatus(currentUploadResourceId, "failed").catch(e => console.error("Failed to update status to failed on error", e));
    }
    currentUploadResourceId = null;
    currentUploadMetadata = null;
  };

  return response;
}
