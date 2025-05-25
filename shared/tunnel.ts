export interface TunnelService {
  type: "http" | "tcp"; // Example types
  local_port: number;
  // PENDING_REMOVAL_local_host: string; // Assuming 'localhost' is implied or configured elsewhere
  subdomain_or_path: string; // e.g., "my-app" which could become my-app.tunnel.example.com or example.com/tunnel/my-app
}

export interface TunnelRegistration {
  tunnelId: string; // Unique ID for the tunnel
  agentId: string; // Identifier for the agent (can be the apiKey or a generated ID tied to the apiKey)
  apiKey: string; // The API key used to register the tunnel
  services: TunnelService[];
  createdAt: string; // ISO 8601 timestamp
  status: "connected" | "disconnected" | "pending"; // Status of the tunnel
}

// --- WebSocket Message Structures for Tunnel Communication ---

export interface AgentRegistrationRequest {
  // Sent by agent to server after WebSocket connection for "register" path
  type: "register";
  data: {
    services: TunnelService[];
    // agent_metadata?: any; // Optional: e.g., agent version, OS, etc.
  };
}

export interface ServerRegistrationResponse {
  // Sent by server to agent upon successful registration
  type: "registered";
  data: {
    tunnelId: string;
    public_base_url: string; // e.g., https://your-tunnel-domain.com/t/{tunnelId}
    // server_version?: string;
  };
}

export interface ServerReconnectResponse {
    type: "reconnected";
    data: {
        tunnelId: string;
        message: string;
    }
}

export interface HttpRequestData {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | null; // Body as string (potentially base64 encoded for binary)
}

export interface AgentHttpRequest {
  // Sent by server to agent
  type: "httpRequest";
  requestId: string;
  data: HttpRequestData;
}

export interface HttpResponseData {
  status: number;
  headers: Record<string, string>;
  body?: string | null; // Body as string (potentially base64 encoded for binary)
}

export interface AgentHttpResponse {
  // Sent by agent to server
  type: "httpResponse";
  requestId: string;
  data: HttpResponseData;
}

export interface HeartbeatMessage {
    type: "heartbeat" | "heartbeat_ack";
}

export interface ErrorMessage {
  type: "error";
  error: string;
  requestId?: string; // Optional: if error is related to a specific request
}

// General message type that can be any of the above
export type TunnelMessage =
  | AgentRegistrationRequest
  | ServerRegistrationResponse
  | ServerReconnectResponse
  | AgentHttpRequest
  | AgentHttpResponse
  | HeartbeatMessage
  | ErrorMessage;
