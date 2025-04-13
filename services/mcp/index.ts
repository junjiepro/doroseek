import loadBalancer from "../endpoint.ts";
import generateServer from "./server.ts";
import { createServerResponseAdapter } from "./server-response-adapter.ts";

class MCPService {
  async handleRequest(url: string, request: Request): Promise<Response> {
    // 处理请求并转发
    const origin = new URL(request.url);
    const paths = url.split("/");
    const end = paths.pop() ?? "";
    const serverName = paths.join("/");
    const pass = await checkAuth(end, origin.searchParams.get("apiKey")!);
    if (pass) {
      if (end === "message" || end === "sse") {
        const server = generateServer(serverName);
        if (server) {
          return createServerResponseAdapter(request.signal, (res) => {
            server.server(request, res);
          });
        } else {
          return new Response(
            JSON.stringify({ error: "MCP Server Not found" }),
            {
              status: 404,
              headers: { "Content-Type": "application/json" },
            }
          );
        }
      } else {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    } else {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
}

const checkAuth = async (end: string, apiKey: string) => {
  if (end === "message") return true;
  if (!apiKey) return false;

  const config = await loadBalancer.loadEndpointConfig(apiKey);

  if (!config) return false;

  return true;
};

const mcpService = new MCPService();

export default mcpService;
