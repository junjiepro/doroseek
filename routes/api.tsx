import { FreshContext, RouteConfig } from "$fresh/server.ts";
import loadBalancer from "../services/endpoint.ts";

export const handler = {
  POST(_req: Request, { params }: FreshContext) {
    return loadBalancer.handleRequest(params.path, _req);
  },
};

export const config: RouteConfig = {
  routeOverride: "/api/:path*",
};
