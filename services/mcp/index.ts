import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import loadBalancer from "../endpoint.ts";
import generateServer from "./server.ts";
import { ServerWrapper } from "../../shared/mcp.ts";
import { createServerResponseAdapter } from "./server-response-adapter.ts";

class MCPService {
  private transports: { [sessionId: string]: SSEServerTransport } = {};
  private servers: { [sessionId: string]: ServerWrapper } = {};

  async handleRequest(url: string, request: Request): Promise<Response> {
    // 处理请求并转发
    const origin = new URL(request.url);
    const pass = await checkAuth(url, origin.searchParams.get("apiKey")!);
    if (pass) {
      const paths = url.split("/");
      const end = paths.pop();
      const serverName = paths.join("/");
      switch (end) {
        // message
        case "message": {
          const server = generateServer(serverName);
          if (server) {
            return createServerResponseAdapter(request.signal, (res) => {
              server.server(request, res);
            });
          } else {
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        // sse
        case "sse": {
          const server = generateServer(serverName);
          if (server) {
            return createServerResponseAdapter(request.signal, (res) => {
              server.server(request, res);
            });
          } else {
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
        default: {
          return new Response(JSON.stringify({ error: "Not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    } else {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}

const checkAuth = async (url: string, apiKey: string) => {
  if (!apiKey) return false;
  if (url === "message") return true;

  const config = await loadBalancer.loadEndpointConfig(apiKey);

  if (!config) return false;

  return true;
};

const mcpService = new MCPService();

export default mcpService;
