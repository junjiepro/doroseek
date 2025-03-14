import { EndpointKey, EndpointList, EndpointListItem } from "../shared/api.ts";
import { z } from "zod";
import loadBalancer from "./endpoint.ts";

export const db = await Deno.openKv();
export const itemInputSchema = z.array(
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
export const keyInputSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    parentId: z.string(),
    enabled: z.boolean(),
  })
);
export type ItemInputSchema = z.infer<typeof itemInputSchema>;
export type KeyInputSchema = z.infer<typeof keyInputSchema>;

export async function loadList(
  id: string,
  consistency: "strong" | "eventual",
  onlyItems = false
): Promise<EndpointList> {
  const out: EndpointList = {
    keys: [],
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

  if (onlyItems) return out;

  const keyIt = db.list(
    { prefix: ["key", id] },
    {
      reverse: true,
      consistency,
    }
  );
  for await (const entry of keyIt) {
    const key = entry.value as EndpointKey;
    key.id = entry.key[entry.key.length - 1] as string;
    key.versionstamp = entry.versionstamp!;
    out.keys.push(key);
  }

  return out;
}

export async function getParentKey(id: string): Promise<string | null> {
  const key = await db.get(["parentkey", id]);
  return key.value as string | null;
}

export async function writeItems(
  listId: string,
  inputs: ItemInputSchema
): Promise<void> {
  const currentEntries = await db.getMany(
    inputs.map((input: EndpointListItem) => ["list", listId, input.id])
  );

  const op = db.atomic();

  inputs.forEach((input: EndpointListItem, i: number) => {
    if (!input.setting) {
      op.delete(["list", listId, input.id!]);
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
      op.set(["list", listId, input.id!], item);
    }
  });
  op.set(["list_updated", listId], true);
  await op.commit();
  loadBalancer.removeEndpoint(listId);
}

export async function writeKeys(
  listId: string,
  inputs: KeyInputSchema
): Promise<void> {
  const currentEntries = await db.getMany(
    inputs.map((input: EndpointKey) => ["key", listId, input.id])
  );

  const op = db.atomic();

  inputs.forEach((input: EndpointKey, i: number) => {
    if (!input.name) {
      op.delete(["key", listId, input.id!]);
      op.delete(["parentkey", input.id!]);
      loadBalancer.removeKey(input.id!);
    } else {
      const current = currentEntries[i].value as EndpointKey | null;
      const now = Date.now();
      const createdAt = current?.createdAt ?? now;

      const item: EndpointKey = {
        name: input.name,
        parentId: listId,
        enabled: input.enabled,
        createdAt,
        updatedAt: now,
      };
      op.set(["key", listId, input.id!], item);
      if (item.enabled) {
        op.set(["parentkey", input.id!], listId);
      } else {
        op.delete(["parentkey", input.id!]);
        loadBalancer.removeKey(input.id!);
      }
    }
  });
  op.set(["list_updated", listId], true);
  await op.commit();
}
