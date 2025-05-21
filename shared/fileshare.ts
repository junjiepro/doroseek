// --- File Sharing MCP Message Types ---

export interface FileMetadata {
  resourceId: string;
  filename: string;
  filetype: string;
  size: number; // Size in bytes
  status: "pending" | "completed" | "failed" | "uploading_chunked"; // Status of the file
  apiKey: string; // API key of the uploader
  createdAt: string; // ISO 8601 timestamp
  // For chunked uploads, add:
  // totalChunks?: number;
  // receivedChunks?: number;
}

// Client to Server Messages
export interface ClientInitiateUploadMessage {
  type: "initiateUpload";
  payload: {
    filename: string;
    filetype: string;
    size: number;
    // apiKey is typically derived from the WebSocket connection context by the server
  };
}

export interface ServerUploadReadyMessage {
  type: "uploadReady";
  payload: {
    resourceId: string;
    // For chunked or direct-to-blob, uploadUrl or other params might be here.
    // For simple KV, resourceId is the primary identifier.
  };
}

export interface ClientFileDataMessage {
  // For simple, non-chunked uploads, this will contain the whole file.
  // For chunked, it would have chunk info.
  type: "fileData";
  payload: {
    resourceId: string;
    data: string; // Base64 encoded file data
    // chunk?: number;
    // totalChunks?: number;
  };
}

export interface ClientUploadCompleteMessage {
  // May not be strictly needed for single-chunk/non-chunked uploads if ClientFileDataMessage implies completion.
  // But good for explicit signaling.
  type: "uploadComplete";
  payload: {
    resourceId: string;
  };
}

// Server to Client Messages
export interface ServerUploadCompleteMessage {
  type: "uploadComplete";
  payload: {
    resourceId: string;
    downloadUrl: string;
  };
}

export interface ServerErrorStateMessage {
  type: "error";
  payload: {
    resourceId?: string;
    message: string; // Renamed from 'error' to 'message' for clarity
    originalAction?: string;
  };
}

// Union type for all possible messages related to file sharing
export type FileShareMessage =
  | ClientInitiateUploadMessage
  | ServerUploadReadyMessage
  | ClientFileDataMessage
  | ClientUploadCompleteMessage
  | ServerUploadCompleteMessage
  | ServerErrorStateMessage;
