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
    inputs.map((input: Omit<EndpointListItem, "createdAt" | "updatedAt">) => [
      "list",
      listId,
      input.id!,
    ])
  );

  const op = db.atomic();

  inputs.forEach(
    (input: Omit<EndpointListItem, "createdAt" | "updatedAt">, i: number) => {
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
    }
  );
  op.set(["list_updated", listId], true);
  await op.commit();
  loadBalancer.removeEndpoint(listId);
}

export async function writeKeys(
  listId: string,
  inputs: KeyInputSchema
): Promise<void> {
  const currentEntries = await db.getMany(
    inputs.map((input: Omit<EndpointKey, "createdAt" | "updatedAt">) => [
      "key",
      listId,
      input.id!,
    ])
  );

  const op = db.atomic();

  inputs.forEach(
    (input: Omit<EndpointKey, "createdAt" | "updatedAt">, i: number) => {
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
    }
  );
  op.set(["list_updated", listId], true);
  await op.commit();
}

// Tunnel specific KV operations
import { TunnelRegistration } from "../shared/tunnel.ts";

const TUNNELS_PREFIX = "tunnels";
const TUNNELS_BY_API_KEY_PREFIX = "tunnels_by_apiKey";
const TUNNELS_BY_AGENT_ID_PREFIX = "tunnels_by_agentId"; // If agentId is different from apiKey

/**
 * Saves a new tunnel registration to Deno KV.
 * @param tunnelData The tunnel registration data.
 */
export async function saveTunnel(
  tunnelData: TunnelRegistration
): Promise<void> {
  const { tunnelId, apiKey, agentId } = tunnelData;
  const tunnelKey = [TUNNELS_PREFIX, tunnelId];
  const byApiKeyKey = [TUNNELS_BY_API_KEY_PREFIX, apiKey, tunnelId];
  const byAgentIdKey = [TUNNELS_BY_AGENT_ID_PREFIX, agentId, tunnelId]; // Assuming agentId might be distinct

  const op = db
    .atomic()
    .set(tunnelKey, tunnelData)
    .set(byApiKeyKey, tunnelData) // Store full data or just a reference { tunnelId, createdAt }
    .set(byAgentIdKey, tunnelData); // Same here

  await op.commit();
}

/**
 * Retrieves a tunnel registration by its ID.
 * @param tunnelId The ID of the tunnel.
 * @returns The tunnel registration data or null if not found.
 */
export async function getTunnel(
  tunnelId: string
): Promise<TunnelRegistration | null> {
  const tunnelKey = [TUNNELS_PREFIX, tunnelId];
  const result = await db.get<TunnelRegistration>(tunnelKey);
  return result.value;
}

/**
 * Updates the status of a tunnel.
 * @param tunnelId The ID of the tunnel.
 * @param status The new status.
 */
export async function updateTunnelStatus(
  tunnelId: string,
  status: TunnelRegistration["status"]
): Promise<boolean> {
  const tunnelKey = [TUNNELS_PREFIX, tunnelId];
  const tunnel = await getTunnel(tunnelId);
  if (!tunnel) {
    console.warn(`Tunnel not found for status update: ${tunnelId}`);
    return false;
  }

  const updatedTunnel: TunnelRegistration = { ...tunnel, status };

  // Need to update all related keys if they store full data
  const byApiKeyKey = [TUNNELS_BY_API_KEY_PREFIX, tunnel.apiKey, tunnelId];
  const byAgentIdKey = [TUNNELS_BY_AGENT_ID_PREFIX, tunnel.agentId, tunnelId];

  const op = db
    .atomic()
    .set(tunnelKey, updatedTunnel)
    .set(byApiKeyKey, updatedTunnel)
    .set(byAgentIdKey, updatedTunnel);

  const commitResult = await op.commit();
  return commitResult.ok;
}

/**
 * Retrieves all tunnels registered by a specific API key.
 * @param apiKey The API key.
 * @returns An array of tunnel registrations.
 */
export async function getTunnelsByApiKey(
  apiKey: string
): Promise<TunnelRegistration[]> {
  const tunnels: TunnelRegistration[] = [];
  const iter = db.list<TunnelRegistration>({
    prefix: [TUNNELS_BY_API_KEY_PREFIX, apiKey],
  });
  for await (const entry of iter) {
    tunnels.push(entry.value);
  }
  return tunnels;
}

/**
 * Deletes a tunnel registration from Deno KV.
 * @param tunnelId The ID of the tunnel to delete.
 */
export async function deleteTunnel(tunnelId: string): Promise<void> {
  const tunnel = await getTunnel(tunnelId);
  if (!tunnel) {
    console.warn(`Tunnel not found for deletion: ${tunnelId}`);
    return;
  }

  const tunnelKey = [TUNNELS_PREFIX, tunnelId];
  const byApiKeyKey = [TUNNELS_BY_API_KEY_PREFIX, tunnel.apiKey, tunnelId];
  const byAgentIdKey = [TUNNELS_BY_AGENT_ID_PREFIX, tunnel.agentId, tunnelId];

  const op = db
    .atomic()
    .delete(tunnelKey)
    .delete(byApiKeyKey)
    .delete(byAgentIdKey);

  await op.commit();
  console.log(`Tunnel ${tunnelId} deleted successfully.`);
}

// --- File Sharing specific KV operations ---
import { FileMetadata } from "../shared/fileshare.ts";

const FILES_METADATA_PREFIX = "files_metadata";
const FILES_DATA_PREFIX = "files_data";

/**
 * Saves file metadata to Deno KV.
 * @param metadata The file metadata object.
 */
export async function saveFileMetadata(metadata: FileMetadata): Promise<void> {
  const metadataKey = [FILES_METADATA_PREFIX, metadata.resourceId];
  await db.set(metadataKey, metadata);
}

/**
 * Retrieves file metadata by its resource ID.
 * @param resourceId The ID of the resource.
 * @returns The file metadata or null if not found.
 */
export async function getFileMetadata(
  resourceId: string
): Promise<FileMetadata | null> {
  const metadataKey = [FILES_METADATA_PREFIX, resourceId];
  const result = await db.get<FileMetadata>(metadataKey);
  return result.value;
}

/**
 * Updates the status of a file in its metadata.
 * Also updates the timestamp.
 * @param resourceId The ID of the resource.
 * @param status The new status.
 */
export async function updateFileStatus(
  resourceId: string,
  status: FileMetadata["status"]
): Promise<boolean> {
  const metadata = await getFileMetadata(resourceId);
  if (!metadata) {
    console.warn(
      `[DB Fileshare] Metadata not found for status update: ${resourceId}`
    );
    return false;
  }

  const updatedMetadata: FileMetadata = {
    ...metadata,
    status,
    createdAt: new Date().toISOString(), // Or add an `updatedAt` field
  };
  await saveFileMetadata(updatedMetadata); // This overwrites existing metadata
  return true;
}

/**
 * Saves file data (as a single Uint8Array) to Deno KV.
 * WARNING: Deno KV has value size limits (typically 64KB). This is for small files.
 * @param resourceId The ID of the resource.
 * @param data The file data as a Uint8Array.
 */
export async function saveFileData(
  resourceId: string,
  data: Uint8Array
): Promise<void> {
  // Check size before attempting to save to avoid Deno KV errors for oversized values.
  // Deno KV values are typically limited to 64 KiB.
  if (data.byteLength > 60 * 1024) {
    // A bit less than 64KB to be safe
    console.warn(
      `[DB Fileshare] File data for ${resourceId} may exceed Deno KV size limits (${data.byteLength} bytes). Attempting to save anyway.`
    );
    // For production, throw an error or handle chunking.
    // throw new Error(`File size ${data.byteLength} exceeds 64KB limit for single KV entry.`);
  }
  const dataKey = [FILES_DATA_PREFIX, resourceId];
  await db.set(dataKey, data);
}

/**
 * Retrieves file data by its resource ID.
 * @param resourceId The ID of the resource.
 * @returns The file data as Uint8Array or null if not found.
 */
export async function getFileData(
  resourceId: string
): Promise<Uint8Array | null> {
  const dataKey = [FILES_DATA_PREFIX, resourceId];
  const result = await db.get<Uint8Array>(dataKey);
  return result.value;
}

/**
 * Deletes file metadata and data from Deno KV.
 * @param resourceId The ID of the resource to delete.
 */
export async function deleteFileData(resourceId: string): Promise<void> {
  const metadataKey = [FILES_METADATA_PREFIX, resourceId];
  const dataKey = [FILES_DATA_PREFIX, resourceId];

  const op = db.atomic().delete(metadataKey).delete(dataKey);
  await op.commit();
  console.log(
    `[DB Fileshare] File ${resourceId} (metadata and data) deleted successfully.`
  );
}
