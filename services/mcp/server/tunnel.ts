import { v4 as uuidv4 } from "uuid";
import {
  saveTunnel,
  getTunnel,
  updateTunnelStatus,
  // deleteTunnel, // Not used in this step, but good to have
} from "../../database.ts"; // Adjusted path assuming database.ts is in services/
import { TunnelRegistration, TunnelService } from "../../../shared/tunnel.ts"; // Adjusted path

// This Map will store active WebSocket connections for tunnels, now mapping tunnelId to WebSocket.
export const activeTunnels = new Map<string, WebSocket>();

// Map to store resolvers for pending HTTP requests proxied to agents.
// Key: requestId, Value: function to resolve the promise with the HTTP response from the agent.
export const pendingHttpRequests = new Map<
  string,
  (responsePayload: {
    status: number;
    headers: Record<string, string>;
    body: string; // Assuming body is base64 encoded string for binary data
  }) => void
>();

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
      `[MCP Tunnel] WebSocket connection opened. Path: ${urlPath}, API Key: ${apiKey}`,
    );
    if (urlPath !== "register") {
      // This is an incoming connection attempt for an existing tunnelId
      currentTunnelId = urlPath || null;
      if (!currentTunnelId) {
        socket.send(JSON.stringify({ type: "error", error: "Tunnel ID missing in path." }));
        socket.close(1008, "Tunnel ID missing");
        return;
      }
      const existingTunnel = await getTunnel(currentTunnelId);
      if (!existingTunnel || existingTunnel.apiKey !== apiKey) {
        socket.send(JSON.stringify({ type: "error", error: "Tunnel not found or unauthorized." }));
        socket.close(1008, "Tunnel unauthorized");
        return;
      }
      // If authorized, mark as connected and add to activeTunnels
      activeTunnels.set(currentTunnelId, socket);
      await updateTunnelStatus(currentTunnelId, "connected");
      console.log(`[MCP Tunnel] Agent reconnected to existing tunnel: ${currentTunnelId}`);
      socket.send(JSON.stringify({ type: "reconnected", data: { tunnelId: currentTunnelId, message: "Reconnected successfully." } }));
    }
    // If urlPath === "register", we wait for the agent to send a registration message.
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
        activeTunnels.set(currentTunnelId, socket); // Add to active tunnels map
        
        const publicBaseUrl = `https://${PUBLIC_HOSTNAME}/t/${currentTunnelId}`; // Example base URL
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
      // This is an HTTP response from the agent for a proxied request
      const resolver = pendingHttpRequests.get(msg.requestId);
      if (resolver) {
        resolver(msg.data as {status: number; headers: Record<string, string>; body: string;});
        pendingHttpRequests.delete(msg.requestId);
      } else {
        console.warn(
          `[MCP Tunnel] Received httpResponse for unknown requestId: ${msg.requestId}`,
        );
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
      `[MCP Tunnel] WebSocket closed for TunnelID: ${currentTunnelId || "N/A"}. Code: ${event.code}, Reason: ${event.reason}`,
    );
    if (currentTunnelId) {
      activeTunnels.delete(currentTunnelId);
      try {
        // Check if tunnel still exists before updating status (it might have been deleted)
        const existingTunnel = await getTunnel(currentTunnelId);
        if (existingTunnel) {
          await updateTunnelStatus(currentTunnelId, "disconnected");
          console.log(
            `[MCP Tunnel] Status for tunnel ${currentTunnelId} updated to 'disconnected'.`,
          );
        } else {
          console.log(
            `[MCP Tunnel] Tunnel ${currentTunnelId} not found. No status update needed.`,
          );
        }
      } catch (dbError) {
        console.error(`[MCP Tunnel] Failed to update status for tunnel ${currentTunnelId} on close:`, dbError);
      }
    }
  };

  socket.onerror = async (errorEvent: Event | ErrorEvent) => {
    const errorMessage = (errorEvent as ErrorEvent)?.message || "WebSocket error";
    console.error(
      `[MCP Tunnel] Error on WebSocket for TunnelID: ${currentTunnelId || "N/A"}: ${errorMessage}`,
      errorEvent,
    );
    if (currentTunnelId) {
      activeTunnels.delete(currentTunnelId);
      try {
        const existingTunnel = await getTunnel(currentTunnelId);
        if (existingTunnel) {
          await updateTunnelStatus(currentTunnelId, "disconnected");
          console.log(
            `[MCP Tunnel] Status for tunnel ${currentTunnelId} updated to 'disconnected' due to error.`,
          );
        }
      } catch (dbError) {
        console.error(`[MCP Tunnel] Failed to update status for tunnel ${currentTunnelId} on error:`, dbError);
      }
    }
    // Socket will usually fire 'onclose' after 'onerror'
  };

  return response;
}
