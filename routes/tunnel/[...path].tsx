import { FreshContext, Handlers } from "$fresh/server.ts";
import { v4 as uuidv4 } from "uuid";
import { getTunnel } from "../../services/database.ts";
import {
  getActiveTunnelSocket,
  pendingHttpRequests, // This is for responses from locally connected agents
} from "../../services/mcp/server/tunnel.ts";
import { RELAY_INSTANCE_ID } from "../../lib/utils.ts";
import {
  postHttpRequestToChannel,
  BroadcastHttpRequestMessage, // Type for messages sent over BroadcastChannel
} from "../../services/inter_instance_comms.ts";
import {
  addPendingForwardedRequest,
  ForwardedResponseData, // Type for responses received via BroadcastChannel
} from "../../services/forwarded_request_registry.ts";
import { getTunnelOwnerInstance } from "../../services/tunnel_registry.ts";

const LOCAL_AGENT_HTTP_REQUEST_TIMEOUT_MS = 30000; // 30 seconds for local agent HTTP requests

// Helper to serialize request body to a suitable format (string or base64 for binary)
async function serializeRequestBody(request: Request): Promise<string | null> {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  // For binary data, it's better to handle as ArrayBuffer and then convert to base64
  // For simplicity here, assuming text-based bodies primarily, or that agent handles base64.
  // A more robust solution would check Content-Type.
  const contentType = request.headers.get("content-type");
  if (contentType && (contentType.includes("application/json") || contentType.includes("text/"))) {
    return await request.text();
  } else if (request.body) {
    // For other types, attempt to read as ArrayBuffer and convert to base64
    try {
      const buffer = await request.arrayBuffer();
      // Deno.Buffer.from(buffer).toString("base64") - Deno specific
      // For standard JS: btoa(String.fromCharCode(...new Uint8Array(buffer)))
      // However, btoa can have issues with binary strings. A proper base64 library or Uint8Array to base64 string function is better.
      // For now, let's use a simple placeholder for base64 encoding.
      // This is a simplified base64 encoding. For production, use a robust library.
      const base64Body = btoa(new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''));
      return base64Body;
    } catch (e) {
      console.error("Error reading request body as ArrayBuffer for base64 encoding:", e);
      return await request.text(); // Fallback to text if arrayBuffer fails
    }
  }
  return null; // No body
}


export const handler: Handlers = {
  async ALL(req: Request, ctx: FreshContext) {
    const url = new URL(req.url);
    const fullPath = ctx.params.path; // This is everything after /tunnel/

    // Example path structure: /tunnel/:tunnelId/service/path/to/resource
    // or /tunnel/:tunnelId/ (if service path is at root)
    const [tunnelId, ...servicePathParts] = fullPath.split("/");
    const servicePath = "/" + servicePathParts.join("/");

    if (!tunnelId) {
      return new Response(JSON.stringify({ error: "Tunnel ID missing in path" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 1. Validate TunnelId and its status
    const tunnelInfo = await getTunnel(tunnelId);
    if (!tunnelInfo) {
      return new Response(JSON.stringify({ error: "Tunnel not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (tunnelInfo.status !== "connected") {
      return new Response(
        JSON.stringify({ error: `Tunnel not connected. Status: ${tunnelInfo.status}` }),
        {
          status: 503, // Service Unavailable
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 2. Determine which instance holds the agent's WebSocket connection
    const agentSocket = getActiveTunnelSocket(tunnelId); // Check local first
    const owningInstanceId = await getTunnelOwnerInstance(tunnelId); // Check distributed registry

    if (agentSocket && agentSocket.readyState === WebSocket.OPEN) {
      // Agent is connected to THIS instance. Proceed with local forwarding.
      console.log(`[Tunnel Route] Agent for ${tunnelId} is local. Proceeding with direct forwarding.`);
    } else if (owningInstanceId && owningInstanceId !== RELAY_INSTANCE_ID) {
      // Agent is connected to ANOTHER instance. Forward request via BroadcastChannel.
      console.log(`[Tunnel Route] Agent for ${tunnelId} is on instance ${owningInstanceId}. Forwarding request.`);
      
      // WebSocket Upgrade Requests cannot be easily forwarded across instances.
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        console.warn(`[Tunnel Route] WebSocket upgrade request for remote tunnel ${tunnelId} cannot be forwarded.`);
        return new Response(
          JSON.stringify({ error: "WebSocket proxying for remote tunnels not supported" }),
          { status: 501, headers: { "Content-Type": "application/json" } },
        );
      }
      
      const jobId = uuidv4(); // Unique ID for this forwarded request-response cycle
      const serializedBody = await serializeRequestBody(req);
      const broadcastRequestData: BroadcastHttpRequestMessage["requestData"] = {
        method: req.method,
        path: servicePath,
        headers: Object.fromEntries(req.headers.entries()),
        body: serializedBody,
      };

      try {
        const responsePromise = addPendingForwardedRequest(jobId);
        
        postHttpRequestToChannel({
          // type: "httpRequest", // Type is part of BroadcastHttpRequestMessage, not needed here
          tunnelId: tunnelId,
          requestId: jobId, // Use jobId as requestId for inter-instance comms
          targetInstanceId: owningInstanceId, // Target the specific instance
          requestData: broadcastRequestData,
        });

        console.log(`[Tunnel Route] Broadcasted HTTP request ${jobId} to instance ${owningInstanceId} for tunnel ${tunnelId}`);
        
        const forwardedResponse: ForwardedResponseData = await responsePromise;

        const responseHeaders = new Headers(forwardedResponse.headers);
        // Body is already string or null (potentially base64 for binary from other instance)
        return new Response(forwardedResponse.body, {
          status: forwardedResponse.status,
          headers: responseHeaders,
        });

      } catch (error) {
        console.error(`[Tunnel Route] Error during inter-instance request forwarding for ${jobId} (Tunnel ${tunnelId}):`, error);
        return new Response(
          JSON.stringify({ error: "Failed to forward request to remote agent instance", details: error.message }),
          { status: 504, headers: { "Content-Type": "application/json" } }, // Gateway Timeout
        );
      }
    } else {
      // Agent not connected locally, and not found (or found on this instance but socket is bad) in distributed registry
      console.warn(`[Tunnel Route] Agent for tunnel ${tunnelId} not found or not connected. Local check: ${agentSocket ? agentSocket.readyState : 'no socket'}. Distributed check: ${owningInstanceId}`);
      return new Response(
        JSON.stringify({ error: "Tunnel agent not connected or tunnel owner unknown" }),
        { status: 502, headers: { "Content-Type": "application/json" } }, // Bad Gateway
      );
    }
    
    // 3. Handle WebSocket Upgrade Requests (Only for local agents now)
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      console.log(`[Tunnel Route] WebSocket upgrade request for ${tunnelId}${servicePath} - Not yet implemented.`);
      // Here, one would Deno.upgradeWebSocket(req) and then orchestrate proxying
      // between the resulting socket and the agentSocket via a new type of message.
      return new Response(
        JSON.stringify({ error: "WebSocket proxying not implemented" }),
        {
          status: 501, // Not Implemented
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // 4. Handle HTTP Requests (This block is now only for LOCAL agents)
    // If agentSocket is local and open, this code runs.
    // If forwarded, the logic above handles it.
    
    const localRequestId = uuidv4(); // Use a different name to avoid confusion with inter-instance 'jobId'
    const localRequestData = {
      method: req.method,
      path: servicePath,
      headers: Object.fromEntries(req.headers.entries()),
      body: await serializeRequestBody(req),
    };

    try {
      // This promise is for local agent communication
      const responseFromAgentPromise = new Promise<any>((resolve, reject) => {
        pendingHttpRequests.set(localRequestId, resolve); // Uses the map from tunnel.ts
        setTimeout(() => {
          if (pendingHttpRequests.has(localRequestId)) {
            pendingHttpRequests.delete(localRequestId);
            reject(new Error(`Request to local agent timed out (requestId: ${localRequestId})`));
          }
        }, LOCAL_AGENT_HTTP_REQUEST_TIMEOUT_MS); 
      });

      agentSocket!.send(JSON.stringify({ // agentSocket is confirmed to be local and open here
        type: "httpRequest",
        requestId: localRequestId,
        data: localRequestData,
      }));

      console.log(`[Tunnel Route] Forwarded local HTTP request ${localRequestId} to tunnel ${tunnelId} for path ${servicePath}`);

      const agentResponse = await responseFromAgentPromise;

      // Reconstruct and return the response from the local agent
      const responseHeaders = new Headers(agentResponse.headers);
      if (agentResponse.body && !responseHeaders.has("Content-Type")) {
        responseHeaders.set("Content-Type", "application/octet-stream"); 
      }
      
      // Body from agent is already string or null (potentially base64 encoded)
      // The logic for handling base64 decoding on client side or here remains the same.
      // For simplicity, passing through as is for now.
      const responseBody = agentResponse.body;

      return new Response(responseBody, {
        status: agentResponse.status,
        headers: responseHeaders,
      });

    } catch (error) {
      console.error(`[Tunnel Route] Error processing local request ${localRequestId} for tunnel ${tunnelId}:`, error);
      return new Response(
        JSON.stringify({ error: "Failed to proxy request to local agent", details: error.message }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }
  },
};
