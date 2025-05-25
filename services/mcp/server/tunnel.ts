import { v4 as uuidv4 } from "uuid";
import {
  saveTunnel,
  getTunnel,
  updateTunnelStatus,
  // deleteTunnel, // Not used in this step, but good to have
} from "../../database.ts"; // Adjusted path assuming database.ts is in services/
import { TunnelRegistration, TunnelService } from "../../../shared/tunnel.ts"; // Adjusted path

import { RELAY_INSTANCE_ID } from "../../../lib/utils.ts"; // For identifying self
import {
  postTunnelActivityToChannel,
  postHttpResponseToChannel,
  // Types for broadcast messages if needed here, though mostly handled by inter_instance_comms
  postHealthCheckResponseToChannel, // New: For sending health check responses back to originating instance
} from "../../inter_instance_comms.ts"; // For announcing activity and sending responses
import {
  AgentPingMessage,
  AgentPongMessage,
  HealthStatusReport,
  LocalServiceStatus,
} from "../../../shared/health.ts"; // New: For health check message types

// This Map will store active WebSocket connections for tunnels, now mapping tunnelId to WebSocket.
export const activeTunnels = new Map<string, WebSocket>();

// --- Enhanced Pending HTTP Request Management ---
// Stores information about HTTP requests awaiting responses from local agents.
// This now needs to distinguish between requests originating locally on this instance
// and requests that were forwarded from another instance via BroadcastChannel.

interface LocalPendingRequest {
  type: "local";
  resolve: (responsePayload: AgentHttpResponsePayload) => void;
  reject: (error: Error) => void; // Added for timeout/error handling
  timeoutId: number;
}

interface ForwardedPendingRequestOriginInfo {
  type: "forwarded";
  originalJobId: string; // The ID of the request on the instance that received the public request
  originalInstanceId: string; // The RELAY_INSTANCE_ID of that instance
  // No local resolver/rejector needed here as response goes back via BroadcastChannel
}

export type PendingRequestInfo = LocalPendingRequest | ForwardedPendingRequestOriginInfo;

export const pendingHttpRequests = new Map<string, PendingRequestInfo>(); // Key: requestId sent to agent

// Structure for responses from agent (used in LocalPendingRequest resolver)
export interface AgentHttpResponsePayload {
  status: number;
  headers: Record<string, string>;
  body: string | null; // Body is already string (potentially base64) from agent
}

// --- Health Check Management ---
interface LocalHealthCheckPending {
  type: "local_api_request"; // Health check initiated by an API call to this instance
  resolve: (report: HealthStatusReport) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

interface ForwardedHealthCheckPending {
  type: "forwarded_request"; // Health check forwarded from another instance
  originalInstanceId: string; // Instance that made the original API call
  originalHealthCheckJobId: string; // The ID the original instance is waiting on
  // No local promise resolver, response is sent via BroadcastChannel
}

export type PendingHealthCheckInfo = LocalHealthCheckPending | ForwardedHealthCheckPending;

// Map: healthCheckJobId (sent to agent) -> PendingHealthCheckInfo
export const pendingHealthChecks = new Map<string, PendingHealthCheckInfo>();
const HEALTH_CHECK_AGENT_TIMEOUT_MS = 10000; // 10 seconds for agent to respond to ping


/**
 * Retrieves an active WebSocket connection for a given tunnel ID.
 * @param tunnelId The ID of the tunnel.
 * @returns The WebSocket object if the tunnel is active, otherwise undefined.
 */
export function getActiveTunnelSocket(
  tunnelId: string,
): WebSocket | undefined {
  return activeTunnels.get(tunnelId);
}

// Define a structure for messages exchanged over WebSocket
interface WebSocketMessage {
  type: string;
  requestId?: string; // Used for correlating requests and responses
  data?: any;
  error?: string;
}

const PUBLIC_HOSTNAME = Deno.env.get("PUBLIC_HOSTNAME") || "localhost:8000"; // For constructing public URLs

/**
 * Handles incoming WebSocket upgrade requests for the tunnel service.
 */
export function tunnelWebSocketHandler(
  request: Request,
  urlPath?: string, // This will be "register" or a tunnelId
  apiKey?: string, // The API key associated with the request
): Response {
  if (!apiKey) { // Should have been caught by checkAuth, but as a safeguard
    return new Response(
      JSON.stringify({ error: "API key is required for tunnel operations." }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response(
      JSON.stringify({ error: "WebSocket upgrade expected" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const { response, socket } = Deno.upgradeWebSocket(request);
  let currentTunnelId: string | null = null; // To keep track of the tunnelId for this specific connection

  socket.onopen = async () => {
    console.log(
      `[MCP Tunnel] WebSocket connection opened by ${apiKey}. Path: ${urlPath}`,
    );
    if (urlPath !== "register") { // Attempting to connect to an existing tunnel
      currentTunnelId = urlPath || null;
      if (!currentTunnelId) {
        socket.send(JSON.stringify({ type: "error", error: "Tunnel ID missing." }));
        socket.close(1008, "Tunnel ID missing");
        return;
      }
      const existingTunnel = await getTunnel(currentTunnelId);
      if (!existingTunnel || existingTunnel.apiKey !== apiKey) {
        socket.send(JSON.stringify({ type: "error", error: "Tunnel not found or unauthorized." }));
        socket.close(1008, "Tunnel unauthorized");
        return;
      }
      
      activeTunnels.set(currentTunnelId, socket);
      await updateTunnelStatus(currentTunnelId, "connected");
      // Announce this tunnel connection activity to other instances
      postTunnelActivityToChannel({
        type: "tunnelActivity", // This is the message type for inter_instance_comms
        activity: "connected",
        tunnelId: currentTunnelId,
        // instanceId is added by postTunnelActivityToChannel as originalInstanceId
      });
      console.log(`[MCP Tunnel] Agent reconnected to existing tunnel: ${currentTunnelId} on instance ${RELAY_INSTANCE_ID}`);
      socket.send(JSON.stringify({ type: "reconnected", data: { tunnelId: currentTunnelId, message: "Reconnected successfully." } }));
    }
    // For "register" path, wait for agent's 'register' message in onmessage.
  };

  socket.onmessage = async (event: MessageEvent) => {
    let msg: WebSocketMessage;
    try {
      msg = JSON.parse(event.data as string);
    } catch (e) {
      console.error("[MCP Tunnel] Failed to parse message:", event.data, e);
      socket.send(JSON.stringify({ type: "error", error: "Invalid JSON message." }));
      return;
    }

    console.log(
      `[MCP Tunnel] Received message (TunnelID: ${currentTunnelId || "N/A"}):`,
      msg,
    );

    if (urlPath === "register" && msg.type === "register") {
      if (currentTunnelId) {
        socket.send(JSON.stringify({ type: "error", error: "Already registered." }));
        return;
      }
      const services = msg.data?.services as TunnelService[];
      if (!Array.isArray(services) || services.length === 0) {
        socket.send(JSON.stringify({ type: "error", error: "Invalid registration data: 'services' array is required." }));
        return;
      }
      // Validate services (basic validation here, can be expanded)
      for (const svc of services) {
        if (!svc.local_port || !svc.subdomain_or_path || !svc.type ) {
            socket.send(JSON.stringify({ type: "error", error: "Invalid service definition. Required: local_port, subdomain_or_path, type." }));
            return;
        }
      }


      currentTunnelId = uuidv4(); // Generate new tunnelId
      const tunnelData: TunnelRegistration = {
        tunnelId: currentTunnelId,
        agentId: apiKey, // Use apiKey as agentId
        apiKey: apiKey, // Store the apiKey
        services: services,
        createdAt: new Date().toISOString(),
        status: "connected", // Initial status upon successful registration and connection
      };

      try {
        await saveTunnel(tunnelData);
        activeTunnels.set(currentTunnelId, socket);
        
        // Announce new tunnel registration activity
        postTunnelActivityToChannel({
          type: "tunnelActivity",
          activity: "connected",
          tunnelId: currentTunnelId,
        });

        const publicBaseUrl = `https://${PUBLIC_HOSTNAME}/t/${currentTunnelId}`;
        socket.send(JSON.stringify({
          type: "registered",
          data: {
            tunnelId: currentTunnelId,
            public_base_url: publicBaseUrl, // Inform agent of its public endpoint base
            // Individual service URLs would be like: ${publicBaseUrl}/${service.subdomain_or_path}
          },
        }));
        console.log(
          `[MCP Tunnel] New agent registered. Tunnel ID: ${currentTunnelId}, API Key: ${apiKey}`,
        );
      } catch (dbError) {
        console.error("[MCP Tunnel] Failed to save tunnel registration:", dbError);
        socket.send(JSON.stringify({ type: "error", error: "Failed to register tunnel (database error)." }));
        currentTunnelId = null; // Reset on failure
      }
    } else if (msg.type === "heartbeat") {
      socket.send(JSON.stringify({ type: "heartbeat_ack" }));
    } else if (msg.type === "httpResponse" && msg.requestId && msg.data) {
        const pendingRequest = pendingHttpRequests.get(msg.requestId);
        if (pendingRequest) {
          pendingHttpRequests.delete(msg.requestId); // Remove once processed
          const responseData = msg.data as AgentHttpResponsePayload;
          if (pendingRequest.type === "local") {
            clearTimeout(pendingRequest.timeoutId);
            pendingRequest.resolve(responseData);
          } else if (pendingRequest.type === "forwarded") {
            postHttpResponseToChannel({
              tunnelId: currentTunnelId || "unknown_tunnel_id",
              requestId: pendingRequest.originalJobId,
              targetInstanceId: pendingRequest.originalInstanceId,
              responseData: responseData,
            });
          }
        } else {
          console.warn(`[MCP Tunnel] Received httpResponse for unknown agent requestId: ${msg.requestId}`);
        }
      } else if (msg.type === "pong" && (msg as any).healthCheckJobId) { // AgentPongMessage
        const pongMessage = msg as unknown as AgentPongMessage;
        const healthCheckJobIdForAgent = pongMessage.healthCheckJobId;
        const pendingCheck = pendingHealthChecks.get(healthCheckJobIdForAgent);

        if (pendingCheck) {
          pendingHealthChecks.delete(healthCheckJobIdForAgent);
          const statusReport: HealthStatusReport = {
            tunnelId: currentTunnelId!, // Should be set if we got a pong
            tunnelStatus: "connected",
            localServiceStatus: pongMessage.localServiceStatus,
            checkedByInstanceId: RELAY_INSTANCE_ID,
            timestamp: new Date().toISOString(),
          };

          if (pendingCheck.type === "local_api_request") {
            clearTimeout(pendingCheck.timeoutId);
            pendingCheck.resolve(statusReport);
            console.log(`[MCP Tunnel] Health check (local API) for ${currentTunnelId} completed via pong. JobId: ${healthCheckJobIdForAgent}`);
          } else if (pendingCheck.type === "forwarded_request") {
            postHealthCheckResponseToChannel({
              healthCheckJobId: pendingCheck.originalHealthCheckJobId, // Use the ID the original instance is waiting for
              targetInstanceId: pendingCheck.originalInstanceId,
              statusReport: statusReport,
              // originalInstanceId for BroadcastHealthCheckResponseMessage is RELAY_INSTANCE_ID, added by post... func
            });
            console.log(`[MCP Tunnel] Health check (forwarded) for ${currentTunnelId} completed. Response sent to instance ${pendingCheck.originalInstanceId}. OriginalJobId: ${pendingCheck.originalHealthCheckJobId}`);
          }
        } else {
          console.warn(`[MCP Tunnel] Received pong for unknown or timed-out healthCheckJobId: ${healthCheckJobIdForAgent}`);
        }
      } else {
        // Handle other message types or log if unknown
      if (!currentTunnelId) {
        socket.send(
          JSON.stringify({
            type: "error",
            error: "Tunnel not yet registered or identified.",
          }),
        );
        return;
      }
      console.log(
        `[MCP Tunnel] Unhandled message type or context for tunnel ${currentTunnelId}:`,
        msg,
      );
    }
  };

  socket.onclose = async (event: CloseEvent) => {
    console.log(
      `[MCP Tunnel] WebSocket closed for TunnelID: ${currentTunnelId || "N/A"} on instance ${RELAY_INSTANCE_ID}. Code: ${event.code}, Reason: ${event.reason}`,
    );
    if (currentTunnelId) {
      activeTunnels.delete(currentTunnelId);
      // Announce tunnel closure
      postTunnelActivityToChannel({
        type: "tunnelActivity",
        activity: "disconnected",
        tunnelId: currentTunnelId,
      });
      
      // Also update DB status
      try {
        const existingTunnel = await getTunnel(currentTunnelId);
        if (existingTunnel) {
          await updateTunnelStatus(currentTunnelId, "disconnected");
          console.log(`[MCP Tunnel] Status for tunnel ${currentTunnelId} updated to 'disconnected' in DB.`);
        }
      } catch (dbError) {
        console.error(`[MCP Tunnel] Failed to update DB status for tunnel ${currentTunnelId} on close:`, dbError);
      }

      // Reject any pending local requests for this tunnel
      pendingHttpRequests.forEach((pendingInfo, requestId) => {
        if (pendingInfo.type === "local") { // Only reject local promises
            // Check if this pending request was associated with the closing tunnel
            // This requires more context, e.g. storing tunnelId with pendingInfo or iterating activeTunnels.
            // For now, this is a simplification: if a tunnel closes, it might affect pending requests.
            // A more robust way would be to associate pending requests with their tunnelId.
            // However, the request to agent already happened. This is about the *response*.
            // If the socket to the agent closes, the agent can't respond.
            // The timeout mechanism in `routes/tunnel/[...path].tsx` for local requests should handle this.
            // For forwarded requests, the `inter_instance_comms` would handle timeouts if the target instance doesn't respond.
            // So, no explicit rejection here might be okay, relying on timeouts.
            // However, it's cleaner to reject if we know the agent for this request disconnected.
            // This requires linking requestId to currentTunnelId when storing in pendingHttpRequests.
            // For now, let's assume timeouts handle it.
            console.log(`[MCP Tunnel] Tunnel ${currentTunnelId} closed. Associated local request ${requestId} might time out if not already resolved.`);
        }
      });
    }
  };

  socket.onerror = async (errorEvent: Event | ErrorEvent) => {
    const errorMessage = (errorEvent as ErrorEvent)?.message || "WebSocket error";
    console.error(
      `[MCP Tunnel] Error on WebSocket for TunnelID: ${currentTunnelId || "N/A"} on instance ${RELAY_INSTANCE_ID}: ${errorMessage}`,
      errorEvent,
    );
    // onclose will usually follow an onerror event, so cleanup (including broadcast) is handled there.
    // If currentTunnelId is set and status was 'connected', onclose will broadcast 'disconnected'.
  };

  return response;
}

// Called by this instance's API route handler (/tunnel/:tunnelId/status)
export function performLocalAgentHealthCheck(
  tunnelId: string,
  // healthCheckJobIdForRoute: string, // This is the ID the API route handler uses for its forwarded_request_registry if it needs to forward
): Promise<HealthStatusReport> {
  return new Promise<HealthStatusReport>((resolve, reject) => {
    const agentSocket = getActiveTunnelSocket(tunnelId);
    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
      resolve({ // Resolve, not reject, as this is a status inquiry
        tunnelId: tunnelId,
        tunnelStatus: "disconnected", // Or "unknown" if not in activeTunnels at all
        localServiceStatus: "unknown",
        checkedByInstanceId: RELAY_INSTANCE_ID,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const agentPingJobId = uuidv4(); // Unique ID for this specific ping to agent
    const timeoutId = setTimeout(() => {
      if (pendingHealthChecks.has(agentPingJobId)) {
        pendingHealthChecks.delete(agentPingJobId);
        console.warn(`[MCP Tunnel] Health check ping to agent for tunnel ${tunnelId} (JobId: ${agentPingJobId}) timed out.`);
        resolve({
          tunnelId: tunnelId,
          tunnelStatus: "connected", // WS is connected, but agent didn't pong
          localServiceStatus: "agent_unresponsive",
          checkedByInstanceId: RELAY_INSTANCE_ID,
          timestamp: new Date().toISOString(),
        });
      }
    }, HEALTH_CHECK_AGENT_TIMEOUT_MS);

    pendingHealthChecks.set(agentPingJobId, {
      type: "local_api_request",
      resolve,
      reject, // Though we typically resolve with a status object
      timeoutId,
    });

    const pingMessage: AgentPingMessage = { type: "ping", healthCheckJobId: agentPingJobId };
    try {
      agentSocket.send(JSON.stringify(pingMessage));
      console.log(`[MCP Tunnel] Sent AgentPingMessage to tunnel ${tunnelId} (Agent Ping JobId: ${agentPingJobId}) for local API health check.`);
    } catch (e) {
      console.error(`[MCP Tunnel] Error sending ping to agent for tunnel ${tunnelId}:`, e);
      clearTimeout(timeoutId);
      pendingHealthChecks.delete(agentPingJobId);
      reject(new Error(`Failed to send ping to agent: ${e.message}`)); // This will be caught by route handler
    }
  });
}


// Called by inter_instance_comms when a broadcasted health check needs to be performed by this instance
export function initiateForwardedAgentHealthCheck(
  tunnelId: string,
  originalHealthCheckJobId: string, // The ID the original instance is waiting on (in its forwarded_request_registry)
  originalInstanceId: string,       // The instance that made the original API call
): void {
  const agentSocket = getActiveTunnelSocket(tunnelId);
  const reportTimestamp = new Date().toISOString();

  if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
    console.log(`[MCP Tunnel] Agent for tunnel ${tunnelId} not connected locally. Responding to forwarded health check for ${originalInstanceId}.`);
    const statusReport: HealthStatusReport = {
      tunnelId,
      tunnelStatus: "disconnected",
      localServiceStatus: "unknown",
      checkedByInstanceId: RELAY_INSTANCE_ID,
      timestamp: reportTimestamp,
    };
    postHealthCheckResponseToChannel({
      healthCheckJobId: originalHealthCheckJobId,
      targetInstanceId: originalInstanceId,
      statusReport: statusReport,
    });
    return;
  }

  const agentPingJobId = uuidv4(); // New ID for this specific ping to the agent
  pendingHealthChecks.set(agentPingJobId, {
    type: "forwarded_request",
    originalInstanceId,
    originalHealthCheckJobId,
  });

  // No timeout handling here for the PING itself to the agent in the context of a FORWARDED request.
  // If the agent doesn't PONG, the original instance's `addPendingForwardedRequest` timeout will trigger.
  // This simplifies logic here; this instance just tries to ping. If it fails to get a PONG,
  // no BroadcastHealthCheckResponse is sent, and the original requestor times out.
  // Alternatively, we could add a timeout here and send back a "agent_unresponsive" status.
  // For now, let's keep it simpler: successful pong -> broadcast response; no pong -> original requestor times out.
  // Adding a timeout here to send a specific "agent_unresponsive" status.
  const agentTimeoutId = setTimeout(() => {
      if (pendingHealthChecks.has(agentPingJobId)) {
          console.warn(`[MCP Tunnel] Timeout waiting for PONG from agent on tunnel ${tunnelId} for forwarded health check (AgentPingJobId: ${agentPingJobId}). Original Job ID: ${originalHealthCheckJobId}`);
          pendingHealthChecks.delete(agentPingJobId);
          const statusReport: HealthStatusReport = {
              tunnelId,
              tunnelStatus: "connected", // WS was connected
              localServiceStatus: "agent_unresponsive",
              checkedByInstanceId: RELAY_INSTANCE_ID,
              timestamp: new Date().toISOString(),
          };
          postHealthCheckResponseToChannel({
              healthCheckJobId: originalHealthCheckJobId,
              targetInstanceId: originalInstanceId,
              statusReport,
          });
      }
  }, HEALTH_CHECK_AGENT_TIMEOUT_MS);
  
  // Need to store this timeoutId if we want to clear it upon receiving a pong
  // Update PendingHealthCheckInfo for 'forwarded_request' to include this agentTimeoutId if we want to clear it.
  // For now, let's refine the PendingHealthCheckInfo for forwarded_request
  // Let's re-add timeoutId to ForwardedHealthCheckPending for this purpose
  const currentPendingCheck = pendingHealthChecks.get(agentPingJobId) as ForwardedHealthCheckPending | undefined;
  if(currentPendingCheck) { // Should always be true
      (pendingHealthChecks.set(agentPingJobId, {...currentPendingCheck, timeoutId: agentTimeoutId }) );
  }


  const pingMessage: AgentPingMessage = { type: "ping", healthCheckJobId: agentPingJobId };
  try {
    agentSocket.send(JSON.stringify(pingMessage));
    console.log(`[MCP Tunnel] Sent AgentPingMessage to tunnel ${tunnelId} (Agent Ping JobId: ${agentPingJobId}) for forwarded health check (Original JobId: ${originalHealthCheckJobId}).`);
  } catch (e) {
    console.error(`[MCP Tunnel] Error sending ping for forwarded health check on tunnel ${tunnelId}:`, e);
    clearTimeout(agentTimeoutId);
    pendingHealthChecks.delete(agentPingJobId);
    // Send error back to original instance
    const statusReport: HealthStatusReport = {
        tunnelId,
        tunnelStatus: "connected", // Socket was open but send failed
        localServiceStatus: "error", // Error trying to ping agent
        checkedByInstanceId: RELAY_INSTANCE_ID,
        timestamp: new Date().toISOString(),
    };
    postHealthCheckResponseToChannel({
        healthCheckJobId: originalHealthCheckJobId,
        targetInstanceId: originalInstanceId,
        statusReport,
    });
  }
}


// Function to be called by inter_instance_comms when a forwarded request needs to be sent to a local agent
export function forwardRequestToLocalAgent(
    tunnelId: string,
    requestIdForAgent: string, // This is the new ID for agent comms
    originalJobId: string, // This is the ID the original instance is waiting on
    originalInstanceId: string,
    requestData: any // Should be AgentHttpRequestData compatible
): boolean {
    const agentSocket = getActiveTunnelSocket(tunnelId);
    if (agentSocket && agentSocket.readyState === WebSocket.OPEN) {
        // Store info about the origin of this request
        pendingHttpRequests.set(requestIdForAgent, {
            type: "forwarded",
            originalJobId: originalJobId,
            originalInstanceId: originalInstanceId,
        });

        agentSocket.send(JSON.stringify({
            type: "httpRequest",
            requestId: requestIdForAgent,
            data: requestData,
        }));
        console.log(`[MCP Tunnel] Forwarded (from instance ${originalInstanceId}, job ${originalJobId}) to local agent for tunnel ${tunnelId} with new agentReqId ${requestIdForAgent}`);
        return true;
    } else {
        console.warn(`[MCP Tunnel] Cannot forward to local agent for tunnel ${tunnelId}: No active socket.`);
        // If no active socket, the instance that tried to forward this should be notified
        // so it can reject the original public request. This can be done by broadcasting
        // an error response back.
        postHttpResponseToChannel({
            tunnelId: tunnelId,
            requestId: originalJobId, // ID original instance is waiting on
            targetInstanceId: originalInstanceId,
            responseData: {
                status: 502, // Bad Gateway
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({error: `Agent for tunnel ${tunnelId} not connected to instance ${RELAY_INSTANCE_ID}`})
            }
        });
        return false;
    }
}
