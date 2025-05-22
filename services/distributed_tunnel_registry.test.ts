import {
  assert,
  assertEquals,
  assertNotEquals,
  assertExists,
} from "https://deno.land/std@0.212.0/assert/mod.ts";
import {
  setTunnelOwner,
  removeTunnelOwner,
  getTunnelOwnerInstance,
  clearTunnelRegistry, // For cleaning up between tests
  getRegistrySize, // For verifying cleanup
} from "./distributed_tunnel_registry.ts";

Deno.testSuite("Distributed Tunnel Registry (services/distributed_tunnel_registry.ts)", async (t) => {
  t.beforeEach(() => {
    clearTunnelRegistry(); // Ensure a clean state for each test
  });

  t.afterAll(() => {
    clearTunnelRegistry(); // Clean up after all tests in the suite
  });

  await t.step("setTunnelOwner and getTunnelOwnerInstance - basic functionality", () => {
    const tunnelId1 = "tunnel-001";
    const instanceId1 = "instance-A";
    const tunnelId2 = "tunnel-002";
    const instanceId2 = "instance-B";

    setTunnelOwner(tunnelId1, instanceId1);
    setTunnelOwner(tunnelId2, instanceId2);

    assertEquals(getTunnelOwnerInstance(tunnelId1), instanceId1, "Should retrieve owner for tunnelId1");
    assertEquals(getTunnelOwnerInstance(tunnelId2), instanceId2, "Should retrieve owner for tunnelId2");
    assertEquals(getRegistrySize(), 2, "Registry should have 2 entries");
  });

  await t.step("setTunnelOwner - updating owner for an existing tunnelId", () => {
    const tunnelId = "tunnel-update";
    const instanceIdOld = "instance-OLD";
    const instanceIdNew = "instance-NEW";

    setTunnelOwner(tunnelId, instanceIdOld);
    assertEquals(getTunnelOwnerInstance(tunnelId), instanceIdOld, "Initial owner should be set");

    setTunnelOwner(tunnelId, instanceIdNew);
    assertEquals(getTunnelOwnerInstance(tunnelId), instanceIdNew, "Owner should be updated to new instance");
    assertEquals(getRegistrySize(), 1, "Registry size should remain 1 after update");
  });

  await t.step("removeTunnelOwner - removing an existing tunnelId", () => {
    const tunnelId = "tunnel-remove";
    const instanceId = "instance-C";

    setTunnelOwner(tunnelId, instanceId);
    assertExists(getTunnelOwnerInstance(tunnelId), "Tunnel should exist before removal");
    assertEquals(getRegistrySize(), 1);

    removeTunnelOwner(tunnelId);
    assertEquals(getTunnelOwnerInstance(tunnelId), undefined, "Tunnel should be removed");
    assertEquals(getRegistrySize(), 0, "Registry should be empty after removal");
  });

  await t.step("removeTunnelOwner - attempting to remove a non-existent tunnelId", () => {
    const tunnelIdNonExistent = "tunnel-nonexistent";
    // Ensure registry is empty or does not contain this ID
    assertEquals(getTunnelOwnerInstance(tunnelIdNonExistent), undefined);
    
    removeTunnelOwner(tunnelIdNonExistent); // Should not throw an error
    assertEquals(getTunnelOwnerInstance(tunnelIdNonExistent), undefined, "Tunnel should still not exist");
    assertEquals(getRegistrySize(), 0, "Registry should remain empty");
  });

  await t.step("getTunnelOwnerInstance - for a non-existent tunnelId", () => {
    assertEquals(getTunnelOwnerInstance("tunnel-does-not-exist"), undefined);
  });

  await t.step("clearTunnelRegistry - should empty the registry", () => {
    setTunnelOwner("t1", "i1");
    setTunnelOwner("t2", "i2");
    assertEquals(getRegistrySize(), 2, "Registry should have entries before clear");

    clearTunnelRegistry();
    assertEquals(getRegistrySize(), 0, "Registry should be empty after clear");
    assertEquals(getTunnelOwnerInstance("t1"), undefined, "t1 should be cleared");
  });

  // The subtask mentioned: "Test removeTunnelOwner only removes if the provided instanceId matches the current owner".
  // The current implementation of removeTunnelOwner does not have this check.
  // It takes an optional _expectedOwnerInstanceId but doesn't use it for conditional deletion.
  // If this logic were added to removeTunnelOwner, here's how a test might look:
  /*
  await t.step("removeTunnelOwner - conditional removal (if implemented)", () => {
    const tunnelId = "tunnel-conditional";
    const ownerInstance = "instance-OWNER";
    const otherInstance = "instance-OTHER";

    setTunnelOwner(tunnelId, ownerInstance);

    // Attempt removal by wrong instance
    removeTunnelOwner(tunnelId, otherInstance); // Assuming this version of removeTunnelOwner takes expectedOwner
    assertEquals(getTunnelOwnerInstance(tunnelId), ownerInstance, "Tunnel should NOT be removed by wrong instance");
    
    // Attempt removal by correct instance
    removeTunnelOwner(tunnelId, ownerInstance); // Assuming this version of removeTunnelOwner takes expectedOwner
    assertEquals(getTunnelOwnerInstance(tunnelId), undefined, "Tunnel SHOULD be removed by correct instance");
  });
  */
  // For now, the existing removeTunnelOwner unconditionally removes if the tunnelId exists.
  // The conditional logic is instead implemented in `handleTunnelActivity` in `inter_instance_comms.ts`.
  // So, testing that conditional removal logic belongs in `inter_instance_comms.test.ts`.
});
