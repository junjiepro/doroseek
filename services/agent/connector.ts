// services/agent/connector.ts
import { AgentConfig, AgentServiceConfig } from "./config.ts";
import {
  TunnelMessage,
  AgentHttpRequest,
} from "../../shared/tunnel.ts";
import { AgentPingMessage } from "../../shared/health.ts"; // For handling ping from relay
import type { AgentRequestHandler } from "./handler.ts"; // Type import for handler reference

// Define specific message types used by the agent for clarity (if not directly using shared types)
interface AgentRegisterMessage {
  type: "register";
  data: {
    services: Array<{
      type: "http" | "tcp"; // Matching TunnelService in shared/tunnel.ts
      local_port: number;
      subdomain_or_path: string;
    }>;
  };
}

interface ServerRegisteredMessage {
  type: "registered"; // Matches ServerRegistrationResponse in shared/tunnel.ts
  data: {
    tunnelId: string;
    public_base_url: string;
  };
}
interface ServerReconnectedMessage {
    type: "reconnected"; // Matches ServerReconnectResponse
    data: {
        tunnelId: string;
        message: string; // And potentially other fields like public_base_url if it can change
    }
}


interface AgentHeartbeatMessage {
  type: "heartbeat";
}

interface ServerErrorMessageForAgent {
    type: "error";
    error: string; // Matches ErrorMessage in shared/tunnel.ts
    requestId?: string;
}


// Type guard for ServerRegisteredMessage
function isServerRegisteredMessage(msg: any): msg is ServerRegisteredMessage {
    return msg && msg.type === "registered" && msg.data && 
           typeof msg.data.tunnelId === 'string' && 
           typeof msg.data.public_base_url === 'string';
}

// Type guard for ServerReconnectedMessage
function isServerReconnectedMessage(msg: any): msg is ServerReconnectedMessage {
    return msg && msg.type === "reconnected" && msg.data && 
           typeof msg.data.tunnelId === 'string';
}

// Type guard for Heartbeat (ack from server)
function isHeartbeatAckMessage(msg: any): msg is { type: "heartbeat_ack" } {
    return msg && msg.type === "heartbeat_ack";
}

// Type guard for ServerErrorMessageForAgent
function isServerErrorMessage(msg: any): msg is ServerErrorMessageForAgent {
    return msg && msg.type === "error" && typeof msg.error === 'string';
}

// Type guard for AgentPingMessage
function isAgentPingMessage(msg: any): msg is AgentPingMessage {
    return msg && msg.type === "ping" && typeof msg.healthCheckJobId === 'string';
}


export class AgentConnector {
  private config: AgentConfig;
  private socket: WebSocket | null = null;
  private isConnected: boolean = false;
  private isRegistered: boolean = false;
  private tunnelId: string | null = null;
  private publicBaseUrl: string | null = null;
  private retryCount: number = 0;
  private heartbeatIntervalId: number | null = null;
  private reconnectTimeoutId: number | null = null;

  // Reference to the request handler for callbacks (like health checks)
  public agentRequestHandler: AgentRequestHandler | null = null; 

  public onReady: (() => void) | null = null;
  public onHttpRequest: ((message: AgentHttpRequest) => Promise<void> | void) | null = null;

  constructor(config: AgentConfig) { // Handler will be set via property or a setter method
    this.config = config;
    console.log("[Agent Connector] Initialized with Relay URL:", config.relayUrl);
  }
  
  // Setter for request handler to avoid circular dependencies if handler also needs connector
  public setRequestHandler(handler: AgentRequestHandler): void {
    this.agentRequestHandler = handler;
  }


  public connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      console.log("[Agent Connector] Connection attempt ignored, already connected or connecting.");
      return;
    }

    // Clear any pending reconnection timeout if connect is called manually
    if (this.reconnectTimeoutId) {
        clearTimeout(this.reconnectTimeoutId);
        this.reconnectTimeoutId = null;
    }

    const fullRelayUrl = `${this.config.relayUrl}?apiKey=${this.config.apiKey}`;
    console.log(`[Agent Connector] Attempting to connect to ${fullRelayUrl} (Attempt: ${this.retryCount + 1})`);

    try {
      this.socket = new WebSocket(fullRelayUrl);
      this.socket.onopen = this.handleOpen.bind(this);
      this.socket.onmessage = this.handleMessage.bind(this);
      this.socket.onclose = this.handleClose.bind(this);
      this.socket.onerror = this.handleError.bind(this);
    } catch (error) {
      console.error("[Agent Connector] Error creating WebSocket:", error);
      this.scheduleReconnect(); // Still schedule a retry if WebSocket constructor fails
    }
  }

  private handleOpen(): void {
    this.isConnected = true;
    this.retryCount = 0; // Reset retry count on successful connection
    console.log("[Agent Connector] WebSocket connection established.");

    // Prepare registration message
    const registrationServices = this.config.services.map(s => ({
      // Map AgentServiceConfig to the format expected by the relay server
      type: s.type, // 'http' | 'tcp'
      local_port: s.local_port,
      subdomain_or_path: s.subdomainOrPath, // server expects subdomain_or_path
      // id and name from AgentServiceConfig are for agent's local reference, not sent
    }));

    const registrationMessage: AgentRegisterMessage = {
      type: "register",
      data: { services: registrationServices },
    };
    this.send(registrationMessage as any); // Cast to TunnelMessage for send method
    console.log("[Agent Connector] Sent registration request:", registrationMessage);

    // Start heartbeat
    if (this.heartbeatIntervalId) clearInterval(this.heartbeatIntervalId);
    this.heartbeatIntervalId = setInterval(() => {
      const heartbeat: AgentHeartbeatMessage = { type: "heartbeat" };
      this.send(heartbeat as any);
    }, 25000); // Send heartbeat every 25 seconds
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const message = JSON.parse(event.data as string); // Assuming all messages are JSON strings
      console.log("[Agent Connector] Received message:", message);

      if (isServerRegisteredMessage(message)) {
        this.tunnelId = message.data.tunnelId;
        this.publicBaseUrl = message.data.public_base_url;
        this.isRegistered = true;
        console.log(
          `[Agent Connector] Successfully registered. Tunnel ID: ${this.tunnelId}, Public URL: ${this.publicBaseUrl}`,
        );
        if (this.onReady) this.onReady();
      } else if (isServerReconnectedMessage(message)) {
        this.tunnelId = message.data.tunnelId;
        // publicBaseUrl might not change on simple reconnect, but handle if server sends it
        this.isRegistered = true; // Assume reconnected means registered state is restored
        console.log(`[Agent Connector] Reconnected successfully. Tunnel ID: ${this.tunnelId}. Message: ${message.data.message}`);
        if (this.onReady && !this.isConnected) { // If onReady was missed due to quick reconnect
             // This logic might need refinement based on how isConnected is managed during reconnect
        }
         if (this.onReady) this.onReady(); // Notify that we are ready again
      } else if (isHeartbeatAckMessage(message)) {
        // console.log("[Agent Connector] Received heartbeat acknowledgement.");
      } else if (isServerErrorMessage(message)) {
        console.error(
          `[Agent Connector] Received error from server: ${message.error}`,
          message.requestId ? `(Request ID: ${message.requestId})` : ""
        );
        // Specific error handling, e.g., if registration failed critically
        if (message.error.includes("Failed to register tunnel")) {
            // Stop retrying if registration is actively rejected by server
            console.error("[Agent Connector] Critical registration failure. Stopping retries.");
            if (this.heartbeatIntervalId) clearInterval(this.heartbeatIntervalId);
            if (this.reconnectTimeoutId) clearTimeout(this.reconnectTimeoutId);
            this.socket?.close(1008, "Registration failed by server"); // Close with policy violation or similar
            return; // Do not schedule reconnect for critical registration errors
        }

      } else if (message.type === "httpRequest" && this.isRegistered && this.tunnelId) {
        // This is where requests from the relay are handled
        if (this.onHttpRequest) {
          // Assuming onHttpRequest is async and we don't want to block other messages,
          // but also don't want to swallow errors from it.
          Promise.resolve(this.onHttpRequest(message as AgentHttpRequest)).catch(err => {
            console.error("[Agent Connector] Error in onHttpRequest handler:", err);
            // Optionally, send an error response back to the relay if possible,
            // though the request handler itself should manage sending responses.
          });
        } else {
          console.warn("[Agent Connector] Received httpRequest but no onHttpRequest handler is set.");
          // If no handler, we should probably send an error back to the relay for this request.
            // This is complex as the connector doesn't build HTTP responses.
            // The route handler on the relay side should have a timeout for the proxied request.
            console.error("[Agent Connector] Received httpRequest but no onHttpRequest handler is set. Cannot process.");
          }
        }
      } else if (isAgentPingMessage(message)) {
        if (this.agentRequestHandler) {
          // Do not await, let it run in background
          this.agentRequestHandler.handleHealthCheckPing(message.healthCheckJobId)
            .catch(err => {
                console.error("[Agent Connector] Error in handleHealthCheckPing:", err);
                // If handleHealthCheckPing itself fails before sending a pong, 
                // the relay will time out for this healthCheckJobId.
            });
        } else {
          console.warn("[Agent Connector] Received ping but no agentRequestHandler is set to handle it.");
          // Optionally send a pong with "error" or "unconfigured" status directly if no handler
          // This would require AgentConnector to construct AgentPongMessage.
        }
      } else {
        console.warn("[Agent Connector] Received unknown message type or unhandled message:", message);
      }
    } catch (e) {
      console.error("[Agent Connector] Error processing message:", event.data, e);
    }
  }

  private handleClose(event: CloseEvent): void {
    console.log(
      `[Agent Connector] WebSocket connection closed. Code: ${event.code}, Reason: "${event.reason}", Clean: ${event.wasClean}`,
    );
    this.isConnected = false;
    this.isRegistered = false; // Assume not registered on disconnect
    this.socket = null;
    if (this.heartbeatIntervalId) {
      clearInterval(this.heartbeatIntervalId);
      this.heartbeatIntervalId = null;
    }
    // Only schedule reconnect if not explicitly stopped (e.g., due to critical error handled in onmessage)
    // and if the close code isn't one that implies "do not retry" (e.g. 1008 policy violation after critical error)
    if (event.code !== 1008 || !event.reason?.includes("Registration failed by server")) {
        this.scheduleReconnect();
    } else {
        console.log("[Agent Connector] Not attempting reconnect due to specific close reason/code.");
    }
  }

  private handleError(event: Event | ErrorEvent): void {
    const errorMessage = (event as ErrorEvent)?.message || "Unknown WebSocket error";
    console.error("[Agent Connector] WebSocket error:", errorMessage, event);
    // handleClose will usually be called after an error, which handles reconnection.
    // If the socket is not null and readyState is not CLOSING/CLOSED, explicitly close.
    if (this.socket && this.socket.readyState !== WebSocket.CLOSING && this.socket.readyState !== WebSocket.CLOSED) {
        // this.socket.close(); // This would trigger handleClose
    } else if (!this.socket) { // If socket failed to even instantiate
        this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeoutId) { // Avoid multiple concurrent timeouts
        return;
    }
    const delay = Math.min(30000, (2 ** this.retryCount) * 1000);
    console.log(`[Agent Connector] Scheduling reconnection attempt ${this.retryCount + 1} in ${delay / 1000} seconds.`);
    this.reconnectTimeoutId = setTimeout(() => {
      this.retryCount++;
      this.reconnectTimeoutId = null;
      this.connect();
    }, delay);
  }

  public send(message: TunnelMessage | AgentRegisterMessage | AgentHeartbeatMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(message));
      } catch (e) {
        console.error("[Agent Connector] Error sending message:", e);
      }
    } else {
      console.warn("[Agent Connector] Cannot send message, WebSocket not connected or not open.", message.type);
    }
  }

  public getTunnelInfo(): { tunnelId: string | null; publicBaseUrl: string | null } {
    return {
      tunnelId: this.tunnelId,
      publicBaseUrl: this.publicBaseUrl,
    };
  }

  public isReady(): boolean {
    return this.isConnected && this.isRegistered;
  }

  public disconnect(): void {
    console.log("[Agent Connector] Disconnect requested.");
    if (this.reconnectTimeoutId) {
        clearTimeout(this.reconnectTimeoutId);
        this.reconnectTimeoutId = null;
    }
    if (this.heartbeatIntervalId) {
        clearInterval(this.heartbeatIntervalId);
        this.heartbeatIntervalId = null;
    }
    if (this.socket) {
        this.socket.onclose = () => {}; // Prevent handleClose from triggering reconnect
        this.socket.close(1000, "Client initiated disconnect");
        this.socket = null;
    }
    this.isConnected = false;
    this.isRegistered = false;
    this.retryCount = 0; // Reset retries for next manual connect
     console.log("[Agent Connector] Disconnected.");
  }
}
