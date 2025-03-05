import { FreshContext } from "$fresh/server.ts";
import * as base58 from "$std/encoding/base58.ts";
import { ADMIN_KEY } from "../shared/admin.ts";

export const handler = (req: Request, _ctx: FreshContext): Response => {
  // 已经设置了 ADMIN_KEY, 重定向到 not-found
  if (ADMIN_KEY) {
    return Response.redirect(new URL("/not-found", req.url), 302);
  }
  // 未设置 ADMIN_KEY, 生成随机 listId 并重定向到 /:listId
  const listId = base58.encode(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(req.url);
  return Response.redirect(`${url.origin}/${listId}`, 302);
};
