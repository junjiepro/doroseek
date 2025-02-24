import { EndpointList, EndpointListItem } from "../shared/api.ts";
import { z } from "zod";
import loadBalancer from "./endpoint.ts";

export const db = await Deno.openKv();
export const inputSchema = z.array(
  z.object({
    id: z.string(),
    setting: z.string(),
    name: z.string(),
    endpoint: z.string(),
    apiKey: z.string(),
    enabled: z.boolean(),
    models: z.array(z.string()),
  })
);
export type InputSchema = z.infer<typeof inputSchema>;

export async function loadList(
  id: string,
  consistency: "strong" | "eventual"
): Promise<EndpointList> {
  const out: EndpointList = {
    items: [],
  };

  const it = db.list(
    { prefix: ["list", id] },
    {
      reverse: true,
      consistency,
    }
  );
  for await (const entry of it) {
    const item = entry.value as EndpointListItem;
    item.id = entry.key[entry.key.length - 1] as string;
    item.versionstamp = entry.versionstamp!;
    out.items.push(item);
  }

  return out;
}

export async function writeItems(
  listId: string,
  inputs: InputSchema
): Promise<void> {
  const currentEntries = await db.getMany(
    inputs.map((input: EndpointListItem) => ["list", listId, input.id])
  );

  const op = db.atomic();

  inputs.forEach((input: EndpointListItem, i) => {
    if (!input.setting) {
      op.delete(["list", listId, input.id]);
    } else {
      const current = currentEntries[i].value as EndpointListItem | null;
      const now = Date.now();
      const createdAt = current?.createdAt ?? now;

      const item: EndpointListItem = {
        setting: input.setting,
        name: input.name,
        endpoint: input.endpoint,
        apiKey: input.apiKey,
        enabled: input.enabled,
        models: input.models,
        createdAt,
        updatedAt: now,
      };
      op.set(["list", listId, input.id], item);
    }
  });
  op.set(["list_updated", listId], true);
  await op.commit();
  loadBalancer.removeEndpoint(listId);
}
