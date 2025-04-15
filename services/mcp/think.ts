import { initializeMcpApiHandler } from "./mcp-api-handler.ts";
import { z } from "zod";

const mcpHandler = initializeMcpApiHandler(
  "think",
  (server) => {
    server.tool(
      "think",
      "Use the tool to think about something. It will not obtain new information or change the database, but just append the thought to the log. Use it when complex reasoning or some cache memory is needed.",
      {
        thought: z.string().describe("A thought to think about."),
      },
      (args) => {
        // Log the thought (this will be visible in the server logs but not to the user)
        console.info("Thinking process", { thought: args.thought });

        // Simply return the thought itself, as per Anthropic's blog post
        return args.thought;
      }
    );
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

export default mcpHandler;
