import { ServerWrapper } from "../../../shared/mcp.ts";
import sequentialthinking from "./sequentialthinking.ts";
import think from "./think.ts";
import proxy from "./proxy.ts";
// Import Deno-idiomatic handlers
import { tunnelWebSocketHandler } from "./tunnel.ts";
import { roomWebSocketHandler } from "./room.ts";
import { fileshareWebSocketHandler } from "./fileshare.ts"; // Added fileshare handler import
import { ServerResponseAdapter } from "../../../shared/mcp.ts";

const generateServer = (serverName: string): ServerWrapper | undefined => {
  switch (serverName) {
    case "sequentialthinking":
      return {
        name: serverName,
        server: sequentialthinking,
        destory: () => {},
      };
    case "think":
      return {
        name: serverName,
        server: think,
        destory: () => {},
      };
    case "proxy":
      return {
        name: serverName,
        server: proxy,
        destory: () => {},
      };
    case "tunnel":
      return {
        name: serverName,
        // This wrapper function makes tunnelWebSocketHandler fit the ServerWrapper type.
        // MCPService.handleRequest will need to identify "tunnel" WebSocket requests 
        // and call tunnelWebSocketHandler directly to correctly handle the Response object.
        server: (request: Request, responseAdapter: ServerResponseAdapter, pathParam?: string) => {
          if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            console.warn(
              `[MCP Server Index] Tunnel WebSocket upgrade attempted via ServerResponseAdapter. ` +
              `This route is not fully functional for WebSocket upgrades. ` +
              `MCPService.handleRequest should handle this path directly.`
            );
            // Call the actual handler to log messages and manage connections, 
            // but its Response object (for upgrade) is lost here.
            const upgradeResponse = tunnelWebSocketHandler(request, pathParam);
            // Send a generic error back via the adapter as the upgrade cannot be completed here.
            responseAdapter.send(
              JSON.stringify({ 
                error: "WebSocket upgrade for tunnel must be handled by MCPService.handleRequest returning the raw upgrade Response.",
                details: `Upgrade response status from handler: ${upgradeResponse.status}`
              }),
              500, // Internal Server Error or 501 Not Implemented
              { "Content-Type": "application/json" }
            );
          } else {
            // For non-WebSocket requests, tunnelWebSocketHandler returns a regular error Response.
            // We adapt this Response to the ServerResponseAdapter.
            const errorResponse = tunnelWebSocketHandler(request, pathParam); 
            errorResponse.text().then(body => {
              const headers: Record<string, string> = {};
              errorResponse.headers.forEach((val, key) => headers[key] = val);
              // Make sure status is not 101, as that's for upgrades.
              const status = errorResponse.status === 101 ? 400 : errorResponse.status;
              responseAdapter.send(body, status, headers);
            }).catch(e => {
              console.error("[MCP Server Index] Error processing non-websocket tunnel request:", e);
              responseAdapter.send(JSON.stringify({ error: "Internal server error" }), 500, { "Content-Type": "application/json" });
            });
          }
        },
        destory: () => {
          // Cleanup logic for activeTunnels if needed
        },
      };
    case "room":
      return {
        name: serverName,
        // This wrapper function makes roomWebSocketHandler fit the ServerWrapper type.
        // MCPService.handleRequest will need to identify "room" WebSocket requests 
        // and call roomWebSocketHandler directly to correctly handle the Response object.
        server: (request: Request, responseAdapter: ServerResponseAdapter, pathParam?: string) => {
          // pathParam here would be the roomId
          if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            console.warn(
              `[MCP Server Index] Room WebSocket upgrade attempted via ServerResponseAdapter. ` +
              `This route is not fully functional for WebSocket upgrades. ` +
              `MCPService.handleRequest should handle this path directly.`
            );
            const upgradeResponse = roomWebSocketHandler(request, pathParam || "default_room_id_error"); // pathParam is roomId
            responseAdapter.send(
              JSON.stringify({ 
                error: "WebSocket upgrade for room must be handled by MCPService.handleRequest returning the raw upgrade Response.",
                details: `Upgrade response status from handler: ${upgradeResponse.status}`
              }),
              500, 
              { "Content-Type": "application/json" }
            );
          } else {
            // For non-WebSocket requests, roomWebSocketHandler returns a specific error Response.
            const errorResponse = roomWebSocketHandler(request, pathParam || "default_room_id_error");
            errorResponse.text().then(body => {
              const headers: Record<string, string> = {};
              errorResponse.headers.forEach((val, key) => headers[key] = val);
              const status = errorResponse.status === 101 ? 400 : errorResponse.status; // Ensure 101 is not passed
              responseAdapter.send(body, status, headers);
            }).catch(e => {
              console.error("[MCP Server Index] Error processing non-websocket room request:", e);
              responseAdapter.send(JSON.stringify({ error: "Internal server error" }), 500, { "Content-Type": "application/json" });
            });
          }
        },
        destory: () => {
          // Cleanup logic for rooms if needed (e.g., closing all WebSockets, clearing rooms map)
          // For now, room management (including cleanup) is handled in room.ts.
        },
      };
    case "fileshare":
      return {
        name: serverName,
        // This wrapper function makes fileshareWebSocketHandler fit the ServerWrapper type.
        // MCPService.handleRequest will need to identify "fileshare" WebSocket requests 
        // and call fileshareWebSocketHandler directly to correctly handle the Response object.
        server: (request: Request, responseAdapter: ServerResponseAdapter, pathParam?: string) => {
          // pathParam could be "upload" or other actions if defined.
          if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            console.warn(
              `[MCP Server Index] Fileshare WebSocket upgrade attempted via ServerResponseAdapter. ` +
              `This route is not fully functional for WebSocket upgrades. ` +
              `MCPService.handleRequest should handle this path directly.`
            );
            // pathParam might be relevant here if different WebSocket endpoints for fileshare exist
            const upgradeResponse = fileshareWebSocketHandler(request, pathParam); 
            responseAdapter.send(
              JSON.stringify({ 
                error: "WebSocket upgrade for fileshare must be handled by MCPService.handleRequest returning the raw upgrade Response.",
                details: `Upgrade response status from handler: ${upgradeResponse.status}`
              }),
              500, 
              { "Content-Type": "application/json" }
            );
          } else {
            // For non-WebSocket requests, fileshareWebSocketHandler returns a specific error Response.
            const errorResponse = fileshareWebSocketHandler(request, pathParam);
            errorResponse.text().then(body => {
              const headers: Record<string, string> = {};
              errorResponse.headers.forEach((val, key) => headers[key] = val);
              const status = errorResponse.status === 101 ? 400 : errorResponse.status; // Ensure 101 is not passed
              responseAdapter.send(body, status, headers);
            }).catch(e => {
              console.error("[MCP Server Index] Error processing non-websocket fileshare request:", e);
              responseAdapter.send(JSON.stringify({ error: "Internal server error" }), 500, { "Content-Type": "application/json" });
            });
          }
        },
        destory: () => {
          // Cleanup logic for fileshare if needed
        },
      };
    default:
      return undefined;
  }
};

export default generateServer;
