import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { Socket } from "node:net";
import { Readable } from "node:stream";
import { ServerOptions } from "@modelcontextprotocol/sdk/server/index.js";
import { Buffer } from "node:buffer";
import { db } from "../database.ts";

interface SerializedRequest {
  requestId: string;
  url: string;
  method: string;
  body: string;
  headers: IncomingHttpHeaders;
}

const maxDuration = 60;

export function initializeMcpApiHandler(
  serverPath: string,
  initializeServer: (server: McpServer) => void,
  serverOptions: ServerOptions = {}
) {
  let servers: McpServer[] = [];

  return async function mcpApiHandler(req: Request, res: ServerResponse) {
    const url = new URL(req.url || "", "https://example.com");
    if (url.pathname === `/mcp/${serverPath}/sse`) {
      console.log("Got new SSE connection");

      const transport = new SSEServerTransport(
        `/mcp/${serverPath}/message`,
        res
      );
      const sessionId = transport.sessionId;
      const server = new McpServer(
        {
          name: `mcp server ${serverPath} on doroseek`,
          version: "0.1.0",
        },
        serverOptions
      );
      initializeServer(server);

      servers.push(server);

      server.server.onclose = () => {
        console.log("SSE connection closed");
        servers = servers.filter((s) => s !== server);
      };

      let logs: {
        type: "log" | "error";
        messages: string[];
      }[] = [];
      // This ensures that we logs in the context of the right invocation since the subscriber
      // is not itself invoked in request context.
      function logInContext(severity: "log" | "error", ...messages: string[]) {
        logs.push({
          type: severity,
          messages,
        });
      }

      const interval = setInterval(() => {
        for (const log of logs) {
          console[log.type].call(console, ...log.messages);
        }
        logs = [];
      }, 100);

      const stream = db.watch([["requests", sessionId]]).getReader();
      // Handles messages originally received via /message
      const handleMessage = async () => {
        while (true) {
          try {
            if ((await stream.read()).done) {
              return;
            }

            const message = (
              await db.get(["requests", sessionId], { consistency: "strong" })
            ).value as string;
            if (!message) continue;
            console.log("Received message from KV", message);
            logInContext("log", "Received message from KV", message);
            const request = JSON.parse(message) as SerializedRequest;

            // Make in IncomingMessage object because that is what the SDK expects.
            const req = createFakeIncomingMessage({
              method: request.method,
              url: request.url,
              headers: request.headers,
              body: request.body,
            });
            const syntheticRes = new ServerResponse(req);
            let status = 100;
            let body = "";
            syntheticRes.writeHead = (statusCode: number) => {
              status = statusCode;
              return syntheticRes;
            };
            syntheticRes.end = (b: unknown) => {
              body = b as string;
              return syntheticRes;
            };
            await transport.handlePostMessage(req, syntheticRes);

            await db.set(
              ["responses", sessionId, request.requestId],
              JSON.stringify({
                status,
                body,
              }),
              { expireIn: maxDuration * 1000 }
            );

            if (status >= 200 && status < 300) {
              logInContext(
                "log",
                `Request ${sessionId}:${request.requestId} succeeded: ${body}`
              );
            } else {
              logInContext(
                "error",
                `Message for ${sessionId}:${request.requestId} failed with status ${status}: ${body}`
              );
            }
          } catch (e) {
            console.error(`Error get message, requests ${sessionId}`, e);
          }
        }
      };
      handleMessage();
      console.log(`Subscribed to requests:${sessionId}`);

      let timeout: number;
      let resolveTimeout: (value: unknown) => void;
      const waitPromise = new Promise((resolve) => {
        resolveTimeout = resolve;
        timeout = setTimeout(() => {
          resolve("max duration reached");
        }, (maxDuration - 5) * 1000);
      });

      async function cleanup() {
        clearTimeout(timeout);
        clearInterval(interval);
        stream.cancel();
        console.log("Done");
        res.statusCode = 200;
        res.end();
      }
      req.signal.addEventListener("abort", () =>
        resolveTimeout("client hang up")
      );

      await server.connect(transport);
      const closeReason = await waitPromise;
      console.log(closeReason);
      await cleanup();
    } else if (url.pathname === `/mcp/${serverPath}/message`) {
      console.log("Received message");

      const body = await req.text();

      const sessionId = url.searchParams.get("sessionId") || "";
      if (!sessionId) {
        res.statusCode = 400;
        res.end("No sessionId provided");
        return;
      }
      const requestId = crypto.randomUUID();
      const serializedRequest: SerializedRequest = {
        requestId,
        url: req.url || "",
        method: req.method || "",
        body: body,
        headers: Object.fromEntries(req.headers.entries()),
      };

      // Handles responses from the /sse endpoint.
      const stream = db
        .watch([["responses", sessionId, requestId]])
        .getReader();
      const handleMessage = async () => {
        while (true) {
          try {
            if ((await stream.read()).done) {
              return;
            }
            const message = (
              await db.get(["responses", sessionId, requestId], {
                consistency: "strong",
              })
            ).value as string;
            if (!message) continue;
            clearTimeout(timeout);
            const response = JSON.parse(message) as {
              status: number;
              body: string;
            };
            res.statusCode = response.status;
            res.end(response.body);
          } catch (e) {
            console.error(
              `Error get message, responses ${sessionId} ${requestId}`,
              e
            );
          }
        }
      };
      handleMessage();

      // Queue the request in KV so that a subscriber can pick it up.
      // One queue per session.
      await db.set(["requests", sessionId], JSON.stringify(serializedRequest), {
        expireIn: maxDuration * 1000,
      });
      console.log(`Published requests:${sessionId}`, serializedRequest);

      let timeout = setTimeout(async () => {
        stream.cancel();
        res.statusCode = 408;
        res.end("Request timed out");
      }, 10 * 1000);

      res.on("close", async () => {
        clearTimeout(timeout);
        stream.cancel();
      });
    } else {
      res.statusCode = 404;
      res.end("Not found");
    }
  };
}

// Define the options interface
interface FakeIncomingMessageOptions {
  method?: string;
  url?: string;
  headers?: IncomingHttpHeaders;
  body?: string | Buffer | Record<string, any> | null;
  socket?: Socket;
}

// Create a fake IncomingMessage
function createFakeIncomingMessage(
  options: FakeIncomingMessageOptions = {}
): IncomingMessage {
  const {
    method = "GET",
    url = "/",
    headers = {},
    body = null,
    socket = new Socket(),
  } = options;

  // Create a readable stream that will be used as the base for IncomingMessage
  const readable = new Readable();
  readable._read = (): void => {}; // Required implementation

  // Add the body content if provided
  if (body) {
    if (typeof body === "string") {
      readable.push(body);
    } else if (Buffer.isBuffer(body)) {
      readable.push(body);
    } else {
      readable.push(JSON.stringify(body));
    }
    readable.push(null); // Signal the end of the stream
  }

  // Create the IncomingMessage instance
  const req = new IncomingMessage(socket);

  // Set the properties
  req.method = method;
  req.url = url;
  req.headers = headers;

  // Copy over the stream methods
  req.push = readable.push.bind(readable);
  req.read = readable.read.bind(readable);
  req.on = (event: string, listener: (...args: any[]) => void) => {
    readable.on(event, listener);
    return req;
  };
  req.pipe = readable.pipe.bind(readable);

  return req;
}
