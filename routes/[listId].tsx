import { Head } from "$fresh/runtime.ts";
import { Handlers } from "$fresh/server.ts";
import EndpointListView from "../islands/EndpointListView.tsx";
import { db, inputSchema, loadList, writeItems } from "../services/database.ts";
import { EndpointList } from "../shared/api.ts";
import { ADMIN_KEY } from "../shared/admin.ts";

export const handler: Handlers = {
  GET: async (req, ctx) => {
    const listId = ctx.params.listId;
    if (ADMIN_KEY && listId !== ADMIN_KEY) {
      return Response.redirect(new URL("/not-found", req.url), 302);
    }
    const accept = req.headers.get("accept");
    const url = new URL(req.url);

    if (accept === "text/event-stream") {
      const stream = db.watch([["list_updated", listId]]).getReader();
      const body = new ReadableStream({
        async start(controller) {
          console.log(
            `Opened stream for list ${listId} remote ${
              JSON.stringify(ctx.remoteAddr)
            }`,
          );
          while (true) {
            try {
              if ((await stream.read()).done) {
                return;
              }

              const data = await loadList(listId, "strong");
              const chunk = `data: ${JSON.stringify(data)}\n\n`;
              controller.enqueue(new TextEncoder().encode(chunk));
            } catch (e) {
              console.error(`Error refreshing list ${listId}`, e);
            }
          }
        },
        cancel() {
          stream.cancel();
          console.log(
            `Closed stream for list ${listId} remote ${
              JSON.stringify(ctx.remoteAddr)
            }`,
          );
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
        },
      });
    }

    const startTime = Date.now();
    const data = await loadList(
      listId,
      url.searchParams.get("consistency") === "strong" ? "strong" : "eventual",
    );
    const endTime = Date.now();
    const res = await ctx.render({ data, latency: endTime - startTime });
    res.headers.set("x-list-load-time", "" + (endTime - startTime));
    return res;
  },
  POST: async (req, ctx) => {
    const listId = ctx.params.listId;
    if (ADMIN_KEY && listId !== ADMIN_KEY) {
      return Response.redirect(new URL("/not-found", req.url), 302);
    }
    const body = inputSchema.parse(await req.json());
    await writeItems(listId, body);
    return Response.json({ ok: true });
  },
};

export default function Home(
  { data: { data, latency } }: {
    data: { data: EndpointList; latency: number };
  },
) {
  return (
    <>
      <Head>
        <title>Doroseek</title>
      </Head>
      <div
        class="relative p-4 mx-auto max-w-screen-md dark:text-white h-[100vh] overflow-auto"
        style={{
          scrollbarWidth: "none",
        }}
      >
        <EndpointListView initialData={data} latency={latency} />
      </div>
    </>
  );
}
