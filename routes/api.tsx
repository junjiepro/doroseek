import { FreshContext, RouteConfig } from "$fresh/server.ts";

export const handler = {
  GET(_req: Request, { params }: FreshContext) {
    console.log(params);
    return new Response(params.path);
  },
};

export const config: RouteConfig = {
  routeOverride: "/api/:path*",
};
