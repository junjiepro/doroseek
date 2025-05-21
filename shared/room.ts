// --- Room MCP Message Types ---

// Client to Server Messages
export interface ClientJoinRoomMessage {
  type: "joinRoom";
  payload: {
    roomId: string; // Already part of the URL path, but can be in payload for consistency
    userId?: string; // Optional: client can suggest, server can override/generate
    // metadata?: any; // e.g., user display name
  };
}

export interface ClientLeaveRoomMessage {
  type: "leaveRoom"; // Typically handled by WebSocket close, but explicit message can exist
  payload: {
    roomId: string;
    userId: string;
  };
}

export interface ClientChatMessage {
  type: "chatMessage";
  payload: {
    roomId: string;
    // userId is typically known by the server from the WebSocket session
    message: string;
    // timestamp can be added by server upon receiving or by client
  };
}

// Server to Client Messages
export interface ServerUserJoinedMessage {
  type: "userJoined";
  payload: {
    roomId: string;
    userId: string;
    timestamp: string; // ISO 8601
    // userCount: number; // Optional
    // metadata?: any; // User display name, etc.
  };
}

export interface ServerUserLeftMessage {
  type: "userLeft";
  payload: {
    roomId: string;
    userId: string;
    timestamp: string; // ISO 8601
    // userCount: number; // Optional
  };
}

export interface ServerChatMessage {
  type: "chatMessage";
  payload: {
    roomId: string;
    fromUserId: string;
    message: string;
    timestamp: string; // ISO 8601
  };
}

export interface ServerRoomInfoMessage {
  // Sent to a user when they join a room
  type: "roomInfo";
  payload: {
    roomId: string;
    users: { userId: string; /* metadata?: any */ }[]; // List of users currently in the room
    history?: ServerChatMessage["payload"][]; // Optional: recent chat history
  };
}

export interface ServerErrorMessage {
    type: "error";
    payload: {
        message: string;
        roomId?: string;
        originalAction?: string; // e.g., "joinRoom", "chatMessage"
    }
}

// Union type for all possible messages related to rooms (can be expanded)
export type RoomMessage =
  | ClientJoinRoomMessage
  | ClientLeaveRoomMessage
  | ClientChatMessage
  | ServerUserJoinedMessage
  | ServerUserLeftMessage
  | ServerChatMessage
  | ServerRoomInfoMessage
  | ServerErrorMessage;
