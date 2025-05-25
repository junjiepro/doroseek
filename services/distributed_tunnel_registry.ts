// services/distributed_tunnel_registry.ts

/**
 * In-memory map to store which relay instance owns the WebSocket connection for a given tunnel.
 * Key: tunnelId (string)
 * Value: ownerInstanceId (string) - RELAY_INSTANCE_ID of the instance owning the connection.
 */
const tunnelOwnershipRegistry = new Map<string, string>();

/**
 * Sets or updates the owner instance for a given tunnelId.
 * @param tunnelId The ID of the tunnel.
 * @param ownerInstanceId The RELAY_INSTANCE_ID of the instance that owns the WebSocket connection.
 */
export function setTunnelOwner(tunnelId: string, ownerInstanceId: string): void {
  tunnelOwnershipRegistry.set(tunnelId, ownerInstanceId);
  console.log(`[DistRegistry] Tunnel ${tunnelId} owner set/updated to instance ${ownerInstanceId}`);
}

/**
 * Removes a tunnel from the ownership registry.
 * Typically called when a tunnel's WebSocket connection is closed.
 * @param tunnelId The ID of the tunnel to remove.
 * @param ownerInstanceId (Optional) The instance ID that believes it's removing the tunnel.
 *                        This can be used for consistency checks, e.g., only allow removal if instanceId matches.
 *                        For simplicity, current implementation removes regardless if tunnelId matches.
 */
export function removeTunnelOwner(tunnelId: string, _expectedOwnerInstanceId?: string): void {
  if (tunnelOwnershipRegistry.has(tunnelId)) {
    // Optional: Check if _expectedOwnerInstanceId matches the stored one before deleting
    // if (_expectedOwnerInstanceId && tunnelOwnershipRegistry.get(tunnelId) !== _expectedOwnerInstanceId) {
    //   console.warn(`[DistRegistry] Attempt to remove tunnel ${tunnelId} by instance ${_expectedOwnerInstanceId} but current owner is ${tunnelOwnershipRegistry.get(tunnelId)}.`);
    //   return;
    // }
    tunnelOwnershipRegistry.delete(tunnelId);
    console.log(`[DistRegistry] Tunnel ${tunnelId} owner removed.`);
  } else {
    console.warn(`[DistRegistry] Attempted to remove owner for unknown tunnel: ${tunnelId}`);
  }
}

/**
 * Retrieves the RELAY_INSTANCE_ID of the instance that owns the WebSocket connection for a tunnel.
 * @param tunnelId The ID of the tunnel.
 * @returns The ownerInstanceId string if found, otherwise undefined.
 */
export function getTunnelOwnerInstance(tunnelId: string): string | undefined {
  return tunnelOwnershipRegistry.get(tunnelId);
}

/**
 * Clears all entries from the registry.
 * Useful for testing or specific reset scenarios.
 */
export function clearTunnelRegistry(): void {
  tunnelOwnershipRegistry.clear();
  console.log("[DistRegistry] Registry cleared.");
}

/**
 * Gets the current size of the registry.
 * @returns Number of tunnel ownerships tracked.
 */
export function getRegistrySize(): number {
  return tunnelOwnershipRegistry.size;
}

// Log current registry state periodically for debugging (optional)
// setInterval(() => {
//   if (tunnelOwnershipRegistry.size > 0) {
//     console.log("[DistRegistry] Current state:", Object.fromEntries(tunnelOwnershipRegistry));
//   }
// }, 60000);
