import loadBalancer from "../endpoint.ts";
import generateServer from "./server/index.ts";
import { createServerResponseAdapter } from "./server-response-adapter.ts";
// Import the actual WebSocket handler functions
import { tunnelWebSocketHandler } from "./server/tunnel.ts";
import { roomWebSocketHandler } from "./server/room.ts";
import { fileshareWebSocketHandler } from "./server/fileshare.ts"; // Added fileshare handler

class MCPService {
  async handleRequest(url: string, request: Request): Promise<Response> {
    // 处理请求并转发
    const origin = new URL(request.url);
    const paths = url.split("/");
    const endPathPart = paths.pop() ?? ""; // This is the last part of the path, e.g., tunnelId or "register" or "message"
    const serverName = paths.join("/"); // This would be "tunnel" or "sequentialthinking", etc.

    // Authentication:
    // For tunnel registration, we might bypass or use a specific auth mechanism later.
    // For now, using existing checkAuth.
    const apiKey = origin.searchParams.get("apiKey") ?? undefined; // Ensure apiKey can be undefined
    const pass = await checkAuth(serverName, endPathPart, apiKey);

    if (pass) {
      // Handle tunnel requests
      if (serverName === "tunnel") {
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return tunnelWebSocketHandler(request, endPathPart, apiKey); // endPathPart is "register" or tunnelId
        } else {
          return tunnelWebSocketHandler(request, endPathPart, apiKey); // Handles non-WebSocket errors
        }
      } else if (serverName === "room") {
        // Handle room requests
        // The 'endPathPart' here is treated as the 'roomId'
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return roomWebSocketHandler(request, endPathPart, apiKey); // endPathPart is roomId
        } else {
          // Non-WebSocket requests to /mcp/room/* can be an error or serve info
          return roomWebSocketHandler(request, endPathPart, apiKey); // Handles non-WebSocket errors
        }
      } else if (serverName === "fileshare") {
        // Handle fileshare requests
        // The 'endPathPart' here could specify an action, e.g., "upload".
        if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return fileshareWebSocketHandler(request, endPathPart, apiKey);
        } else {
          // Non-WebSocket requests to /mcp/fileshare/* (e.g. for direct download link generation - not part of this subtask)
          // fileshareWebSocketHandler returns an error for non-WebSocket requests.
          return fileshareWebSocketHandler(request, endPathPart, apiKey);
        }
      } else if (endPathPart === "message" || endPathPart === "sse") {
        // Existing MCP routes
        const mcpServer = generateServer(serverName);
        if (mcpServer) {
          return createServerResponseAdapter(request.signal, (res) => {
            mcpServer.server(request, res);
          });
        } else {
          return new Response(
            JSON.stringify({ error: `MCP Server '${serverName}' Not found` }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      } else {
        // Fallback for unknown paths
        return new Response(
          JSON.stringify({ error: "MCP Endpoint Not found", path: url }),
          {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    } else {
      return new Response(JSON.stringify({ error: "MCP Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}

// Updated checkAuth for tunnel registration and other paths
const checkAuth = async (
  serverName: string,
  endPathPart: string,
  apiKey?: string
): Promise<boolean> => {
  if (serverName === "tunnel" && endPathPart === "register") {
    // For tunnel registration, an API key is required and must be valid.
    if (!apiKey) {
      console.log("[MCP Auth] Tunnel registration attempt without API key.");
      return false;
    }
    const config = await loadBalancer.loadEndpointConfig(apiKey);
    if (!config) {
      console.log(
        `[MCP Auth] Tunnel registration attempt with invalid API key: ${apiKey}`
      );
      return false;
    }
    // If we reach here, API key is present and valid for tunnel registration.
    return true;
  }

  // Existing logic for other MCP services like sequentialthinking
  if (endPathPart === "message" || endPathPart === "sse") {
    if (endPathPart === "message") return true;
    if (!apiKey) return false;
    const config = await loadBalancer.loadEndpointConfig(apiKey);
    return !!config;
  }

  // For other paths or future tunnel operations (like connecting to an existing tunnel),
  // an API key might also be required.
  if (serverName === "tunnel") {
    // For connecting to an existing tunnel via /mcp/tunnel/:tunnelId
    if (!apiKey) return false;
    const config = await loadBalancer.loadEndpointConfig(apiKey);
    return !!config;
  }

  // For room access, allow if an API key is provided and valid, or if no API key is given (public access).
  if (serverName === "room") {
    if (apiKey) {
      // If API key is provided, it must be valid
      const config = await loadBalancer.loadEndpointConfig(apiKey);
      if (!config) {
        console.log(
          `[MCP Auth] Room access attempt with invalid API key: ${apiKey}`
        );
        return false;
      }
    }
    return true; // Allow access (either anonymous or with valid key)
  }

  // For fileshare service, an API key is strictly required.
  if (serverName === "fileshare") {
    if (!apiKey) {
      console.log("[MCP Auth] Fileshare access attempt without API key.");
      return false;
    }
    const config = await loadBalancer.loadEndpointConfig(apiKey);
    if (!config) {
      console.log(
        `[MCP Auth] Fileshare access attempt with invalid API key: ${apiKey}`
      );
      return false;
    }
    return true;
  }

  // Default deny if no API key for other paths that might require it,
  // or if the path/service combination isn't explicitly handled above.
  if (!apiKey) return false;
  const config = await loadBalancer.loadEndpointConfig(apiKey);
  return !!config;
};

const mcpService = new MCPService();

export default mcpService;

// Helper to extract API key within tunnelWebSocketHandler, as checkAuth only returns boolean.
// This is a bit of a workaround. Ideally, checkAuth might return the apiKey string or throw an error.
// For now, tunnelWebSocketHandler will re-extract it.
// No, this is not needed here. The apiKey is already extracted in handleRequest.
// It needs to be *passed* to tunnelWebSocketHandler.
