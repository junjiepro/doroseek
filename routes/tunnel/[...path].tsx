import { FreshContext, Handlers } from "$fresh/server.ts";
import { v4 as uuidv4 } from "uuid";
import { getTunnel } from "../../services/database.ts";
import {
  getActiveTunnelSocket,
  pendingHttpRequests,
} from "../../services/mcp/server/tunnel.ts";

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

    // 2. Find the active WebSocket for the agent
    const agentSocket = getActiveTunnelSocket(tunnelId);
    if (!agentSocket || agentSocket.readyState !== WebSocket.OPEN) {
      // If socket not found or not open, perhaps update status again?
      // For now, assume status is accurate or will be updated by tunnel.ts on disconnect.
      return new Response(
        JSON.stringify({ error: "Tunnel agent not connected" }),
        {
          status: 502, // Bad Gateway
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    
    // 3. Handle WebSocket Upgrade Requests (Not implemented in this step)
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

    // 4. Handle HTTP Requests
    const requestId = uuidv4();
    const requestData = {
      method: req.method,
      path: servicePath, // Send the path within the service to the agent
      headers: Object.fromEntries(req.headers.entries()),
      body: await serializeRequestBody(req),
    };

    try {
      const responsePromise = new Promise<any>((resolve, reject) => {
        pendingHttpRequests.set(requestId, resolve);
        // Timeout for the request
        setTimeout(() => {
          if (pendingHttpRequests.has(requestId)) {
            pendingHttpRequests.delete(requestId);
            reject(new Error(`Request to agent timed out (requestId: ${requestId})`));
          }
        }, 30000); // 30 seconds timeout
      });

      agentSocket.send(JSON.stringify({
        type: "httpRequest",
        requestId: requestId,
        data: requestData,
      }));

      console.log(`[Tunnel Route] Forwarded HTTP request ${requestId} to tunnel ${tunnelId} for path ${servicePath}`);

      const agentResponse = await responsePromise;

      // Reconstruct and return the response
      const headers = new Headers(agentResponse.headers);
      // Ensure content-type is set if body is present, otherwise Fresh/Deno might default to text/plain
      if (agentResponse.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/octet-stream"); // Default if not specified
      }
      
      let responseBody: BodyInit | null = null;
      if (agentResponse.body) {
        // Assuming agent sends body as base64 string if it was binary, or plain text otherwise.
        // The client needs to decode if it was base64. This part needs careful handling
        // of content types and encoding between agent and server.
        // For now, if headers suggest base64, we should decode.
        // However, the browser will decode based on Content-Encoding, not this manual step.
        // Let's assume the agent sends back a string body that's either plain text or pre-encoded if it was binary.
        // If the original request body was base64 encoded by serializeRequestBody, 
        // the agent must decode it, make the request, get response, potentially encode its body to base64,
        // and send it back. Then here, we might need to decode it if it's intended to be binary.
        // This is simplified: assume body is directly usable or already base64 if it needs to be.
        
        // A simple check: if content type implies text, use as is. Otherwise, try to decode from base64.
        const respContentType = headers.get("content-type");
        if (respContentType && (respContentType.startsWith("text/") || respContentType.includes("json") || respContentType.includes("xml"))) {
            responseBody = agentResponse.body;
        } else {
            // Attempt to decode from base64 if it's not marked as text.
            // This assumes the agent *always* base64 encodes non-text bodies.
            try {
                // This will corrupt data if agentResponse.body is not actually base64
                // responseBody = Uint8Array.from(atob(agentResponse.body), c => c.charCodeAt(0));
                // For now, pass through. Agent and client must agree on encoding.
                responseBody = agentResponse.body; 
            } catch (e) {
                console.error(`[Tunnel Route] Error decoding base64 body for requestId ${requestId}:`, e);
                responseBody = agentResponse.body; // Fallback to original body
            }
        }
      }

      return new Response(responseBody, {
        status: agentResponse.status,
        headers: headers,
      });

    } catch (error) {
      console.error(`[Tunnel Route] Error processing request ${requestId} for tunnel ${tunnelId}:`, error);
      return new Response(
        JSON.stringify({ error: "Failed to proxy request to agent", details: error.message }),
        {
          status: 502, // Bad Gateway
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  },
};
