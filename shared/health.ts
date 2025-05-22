// shared/health.ts

// --- Relay-to-Agent Messages ---
export interface AgentPingMessage {
  type: "ping";
  healthCheckJobId: string; // Unique ID for this health check operation
}

// --- Agent-to-Relay Messages ---
export type LocalServiceStatus = "ok" | "error" | "unconfigured" | "timeout";

export interface AgentPongMessage {
  type: "pong";
  healthCheckJobId: string;
  localServiceStatus: LocalServiceStatus;
}

// --- Inter-Instance (BroadcastChannel) Messages ---

// Sent by the instance that received the API request to the instance owning the tunnel agent
export interface BroadcastHealthCheckMessage {
  type: "forwardHealthCheck";
  healthCheckJobId: string; // Corresponds to the jobId in forwarded_request_registry
  originalInstanceId: string; // Instance that received the API request
  targetInstanceId?: string; // Instance believed to own the tunnel (can be omitted for general broadcast)
  tunnelId: string;
}

// Overall status report for the health check
export interface HealthStatusReport {
  tunnelId: string;
  tunnelStatus: "connected" | "disconnected" | "unknown"; // Status of WebSocket to agent
  localServiceStatus: LocalServiceStatus | "unknown" | "agent_unresponsive"; // Status of agent's local service
  checkedByInstanceId: string; // Instance that performed the check (or tried to)
  timestamp: string; // ISO 8601
}

// Sent by the instance that performed the check (or attempted to) back to the original instance
export interface BroadcastHealthCheckResponseMessage {
  type: "forwardHealthCheckResponse";
  healthCheckJobId: string; // Corresponds to the jobId in forwarded_request_registry
  originalInstanceId: string; // Instance that performed the check (sender of this message)
  targetInstanceId: string; // Instance that initially requested the health check (receiver of this message)
  statusReport: HealthStatusReport;
}

// Union type for health-related messages if needed, though channels might be specific
export type HealthCheckRelatedBroadcastMessage =
  | BroadcastHealthCheckMessage
  | BroadcastHealthCheckResponseMessage;
