import { initializeMcpApiHandler } from "../mcp-api-handler.ts";
import { parse as shellParseArgs } from "shell-quote";
import { findActualExecutable } from "spawn-rx";
import mcpProxy from "../proxy.ts";
import { Transport } from "@modelcontextprotocol/sdk";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const SSE_HEADERS_PASSTHROUGH = ["authorization"];

const defaultEnvironment = {
  ...getDefaultEnvironment(),
  ...(Deno.env.get("MCP_ENV_VARS")
    ? JSON.parse(Deno.env.get("MCP_ENV_VARS")!)
    : {}),
};

const createTransport = async (req: Request): Promise<Transport> => {
  const url = new URL(req.url);
  const query = url.searchParams;

  const transportType = query.get("transport") as string;
  if (transportType === "stdio") {
    const command = query.get("command") as string;
    const origArgs = shellParseArgs(query.get("args") as string) as string[];
    const queryEnv = query.get("env")
      ? JSON.parse(query.get("env") as string)
      : {};
    const env = { ...Deno.env.toObject(), ...defaultEnvironment, ...queryEnv };

    const { cmd, args } = findActualExecutable(command, origArgs);

    console.log(`Stdio transport: command=${cmd}, args=${args}`);

    const transport = new StdioClientTransport({
      command: cmd,
      args,
      env,
      stderr: "pipe",
    });

    await transport.start();

    console.log("Spawned stdio transport");
    return transport;
  } else if (transportType === "sse") {
    const url = query.get("url") as string;
    const headers: HeadersInit = {
      Accept: "text/event-stream",
    };

    for (const key of SSE_HEADERS_PASSTHROUGH) {
      if (req.headers.get(key) === undefined) {
        continue;
      }

      const value = req.headers.get(key);
      headers[key] = Array.isArray(value) ? value[value.length - 1] : value;
    }

    console.log(`SSE transport: url=${url}, headers=${Object.keys(headers)}`);

    const transport = new SSEClientTransport(new URL(url), {
      eventSourceInit: {
        fetch: (url, init) => fetch(url, { ...init, headers }),
      },
      requestInit: {
        headers,
      },
    });
    await transport.start();

    console.log("Connected to SSE transport");
    return transport;
  } else {
    console.error(`Invalid transport type: ${transportType}`);
    throw new Error("Invalid transport type specified");
  }
};

const mcpHandler = initializeMcpApiHandler(
  "proxy",
  async (_, transport, req) => {
    const backingServerTransport = await createTransport(req);

    await transport.start();

    if (backingServerTransport instanceof StdioClientTransport) {
      backingServerTransport.stderr!.on("data", (chunk) => {
        transport.send({
          jsonrpc: "2.0",
          method: "notifications/stderr",
          params: {
            content: chunk.toString(),
          },
        });
      });
    }

    mcpProxy({
      transportToClient: transport,
      transportToServer: backingServerTransport,
    });

    console.log("Set up MCP proxy");

    return true;
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

export default mcpHandler;
