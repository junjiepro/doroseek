import { ServerWrapper } from "../../../shared/mcp.ts";
import sequentialthinking from "./sequentialthinking.ts";
import think from "./think.ts";
import proxy from "./proxy.ts";

const generateServer = (serverName: string): ServerWrapper | undefined => {
  switch (serverName) {
    case "sequentialthinking":
      return {
        name: serverName,
        server: sequentialthinking,
        destory: () => {},
      };
    case "think":
      return {
        name: serverName,
        server: think,
        destory: () => {},
      };
    case "proxy":
      return {
        name: serverName,
        server: proxy,
        destory: () => {},
      };
    default:
      return undefined;
  }
};

export default generateServer;
