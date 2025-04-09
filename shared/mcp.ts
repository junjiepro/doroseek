import { type ServerResponse } from "node:http";

export interface ServerWrapper {
  name: string;
  server: (req: Request, res: ServerResponse) => Promise<void>;
  destory: () => void;
}
