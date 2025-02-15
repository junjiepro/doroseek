import { FreshContext } from "$fresh/server.ts";
import * as base58 from "$std/encoding/base58.ts";

export const handler = (req: Request, _ctx: FreshContext): Response => {
  const listId = base58.encode(crypto.getRandomValues(new Uint8Array(16)));
  const url = new URL(req.url);
  return Response.redirect(`${url.origin}/${listId}`, 302);
};
