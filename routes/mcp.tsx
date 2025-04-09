import { FreshContext, RouteConfig } from "$fresh/server.ts";
import mcpService from "../services/mcp/index.ts";

export const handler = {
  GET(_req: Request, { params }: FreshContext) {
    return mcpService.handleRequest(params.path, _req);
  },
  POST(_req: Request, { params }: FreshContext) {
    return mcpService.handleRequest(params.path, _req);
  },
};

export const config: RouteConfig = {
  routeOverride: "/mcp/:path*",
};
