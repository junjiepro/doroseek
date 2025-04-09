import { ServerWrapper } from "../../shared/mcp.ts";
import sequentialthinking from "./sequentialthinking.ts";

const generateServer = (serverName: string): ServerWrapper | undefined => {
  switch (serverName) {
    case "sequentialthinking":
      return {
        name: serverName,
        server: sequentialthinking,
        destory: () => {},
      };
    default:
      return undefined;
  }
};

export default generateServer;
