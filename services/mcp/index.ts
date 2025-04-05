import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import loadBalancer from "../endpoint.ts";
import * as Servers from "./server.ts";

class MCPService {
  private transports: { [sessionId: string]: SSEServerTransport } = {};
  private servers: { [sessionId: string]: McpServer } = {};

  async handleRequest(url: string, request: Request): Promise<Response> {
    // 处理请求并转发
    const origin = new URL(request.url);
    const pass = await checkAuth(url, origin.searchParams.get("_apiKey")!);
    if (pass) {
      switch (url) {
        // 消息
        case "messages": {
          const sessionId = origin.searchParams.get("sessionId") ?? "";
          const transport = this.transports[sessionId];
          if (transport) {
            const res = new Response();
            await transport.handlePostMessage(request, res);
            return res;
          } else {
            return new Response(
              JSON.stringify({ error: "No transport found for sessionId" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
        }
        default: {
          const server = Servers[url as keyof typeof Servers];
          if (server) {
            const res = new Response();
            const transport = new SSEServerTransport("/messages", res);
            this.transports[transport.sessionId] = transport;
            transport.onclose = () => {
              delete this.transports[transport.sessionId];
              delete this.servers[transport.sessionId];
            };
            await server.connect(transport);
            return res;
          } else {
            return new Response(JSON.stringify({ error: "Not found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
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
  if (url === "messages") return true;

  const config = await loadBalancer.loadEndpointConfig(apiKey);

  if (!config) return false;

  return true;
};

const mcpService = new MCPService();

export default mcpService;
