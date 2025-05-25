import {
  assert,
  assertEquals,
  assertExists,
  assertSpyCall,
  assertSpyCalls,
  spy,
  stub,
} from "https://deno.land/std@0.212.0/testing/mock.ts";
import { FreshContext, Handlers } from "$fresh/server.ts";
import { handler } from "./status.tsx"; // Assuming the file is status.tsx
import { RELAY_INSTANCE_ID } from "../../../lib/utils.ts";

// Mock dependencies
import * as db from "../../../services/database.ts";
import * as tunnelRegistry from "../../../services/distributed_tunnel_registry.ts";
import * as tunnelService from "../../../services/mcp/server/tunnel.ts";
import * as fwdRegistry from "../../../services/forwarded_request_registry.ts";
import * as interComms from "../../../services/inter_instance_comms.ts";
import { HealthStatusReport } from "../../../shared/health.ts";
import { TunnelRegistration } from "../../../shared/tunnel.ts";

Deno.testSuite("Health Check API Route (/tunnel/:tunnelId/status.tsx)", async (t) => {
  let getTunnelStub: any;
  let getTunnelOwnerStub: any;
  let getActiveSocketStub: any;
  let performLocalCheckStub: any;
  let addPendingFwdReqStub: any;
  let postHealthCheckSpy: any;

  const mockTunnelId = "test-tunnel-health";
  const mockLocalInstanceId = RELAY_INSTANCE_ID; // Assume this is the current instance
  const mockRemoteInstanceId = "remote-instance-123";

  t.beforeEach(() => {
    getTunnelStub = stub(db, "getTunnel");
    getTunnelOwnerStub = stub(tunnelRegistry, "getTunnelOwnerInstance");
    getActiveSocketStub = stub(tunnelService, "getActiveTunnelSocket");
    performLocalCheckStub = stub(tunnelService, "performLocalAgentHealthCheck");
    addPendingFwdReqStub = stub(fwdRegistry, "addPendingForwardedRequest");
    postHealthCheckSpy = spy(interComms, "postHealthCheckToChannel");
  });

  t.afterEach(() => {
    getTunnelStub.restore();
    getTunnelOwnerStub.restore();
    getActiveSocketStub.restore();
    performLocalCheckStub.restore();
    addPendingFwdReqStub.restore();
    postHealthCheckSpy.restore();
  });

  const callHandler = async (tunnelIdParam: string = mockTunnelId): Promise<Response> => {
    const req = new Request(`http://localhost/tunnel/${tunnelIdParam}/status`);
    const ctx = { params: { tunnelId: tunnelIdParam } } as unknown as FreshContext;
     if (typeof handler === "function" || !handler.GET) {
        throw new Error("Handler is not a Handlers object with a GET method");
    }
    return await handler.GET(req, ctx);
  };

  await t.step("Tunnel not found in DB - returns 404", async () => {
    getTunnelStub.resolves(null);
    const response = await callHandler();
    assertEquals(response.status, 404);
    const body = await response.json();
    assertEquals(body.error, "Tunnel not found in database.");
  });

  await t.step("Scenario 1: Tunnel is local, agent connected, health check OK", async () => {
    getTunnelStub.resolves({ tunnelId: mockTunnelId, status: "connected" } as TunnelRegistration);
    getActiveSocketStub.returns({ readyState: WebSocket.OPEN }); // Mock WebSocket object
    getTunnelOwnerStub.returns(mockLocalInstanceId); // or undefined, and local socket found

    const localReport: HealthStatusReport = {
      tunnelId: mockTunnelId,
      tunnelStatus: "connected",
      localServiceStatus: "ok",
      checkedByInstanceId: mockLocalInstanceId,
      timestamp: new Date().toISOString(),
    };
    performLocalCheckStub.resolves(localReport);

    const response = await callHandler();
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body, localReport);
    assertSpyCalls(performLocalCheckStub, 1);
  });
  
  await t.step("Scenario 1.1: Tunnel is local, agent connected, health check returns agent_unresponsive", async () => {
    getTunnelStub.resolves({ tunnelId: mockTunnelId, status: "connected" } as TunnelRegistration);
    getActiveSocketStub.returns({ readyState: WebSocket.OPEN });
    getTunnelOwnerStub.returns(mockLocalInstanceId);

    const localReport: HealthStatusReport = {
      tunnelId: mockTunnelId,
      tunnelStatus: "connected",
      localServiceStatus: "agent_unresponsive",
      checkedByInstanceId: mockLocalInstanceId,
      timestamp: new Date().toISOString(),
    };
    performLocalCheckStub.resolves(localReport);

    const response = await callHandler();
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body, localReport);
  });


  await t.step("Scenario 2: Tunnel is on another instance, health check OK", async () => {
    getTunnelStub.resolves({ tunnelId: mockTunnelId, status: "connected" } as TunnelRegistration);
    getActiveSocketStub.returns(null); // Not local
    getTunnelOwnerStub.returns(mockRemoteInstanceId); // Owned by remote

    const remoteReport: HealthStatusReport = {
      tunnelId: mockTunnelId,
      tunnelStatus: "connected",
      localServiceStatus: "ok",
      checkedByInstanceId: mockRemoteInstanceId,
      timestamp: new Date().toISOString(),
    };
    // Simulate addPendingForwardedRequest resolving with the report
    let resolvePendingRequest: (report: HealthStatusReport) => void = () => {};
    const promise = new Promise<HealthStatusReport>((resolve) => { resolvePendingRequest = resolve; });
    addPendingFwdReqStub.returns(promise);

    const responsePromise = callHandler(); // Don't await yet

    // Allow callHandler to proceed to postHealthCheckToChannel and addPendingForwardedRequest
    await new Promise(r => setTimeout(r, 0)); 
    
    assertSpyCalls(postHealthCheckSpy, 1);
    const broadcastMsg = postHealthCheckSpy.calls[0].args[0];
    assertEquals(broadcastMsg.tunnelId, mockTunnelId);
    assertEquals(broadcastMsg.targetInstanceId, mockRemoteInstanceId);
    assertExists(broadcastMsg.healthCheckJobId);

    // Simulate the response coming back via BroadcastChannel and resolving the pending request
    resolvePendingRequest(remoteReport); 
    
    const response = await responsePromise;
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body, remoteReport);
  });

  await t.step("Scenario 3: Tunnel on another instance, times out", async () => {
    getTunnelStub.resolves({ tunnelId: mockTunnelId, status: "connected" } as TunnelRegistration);
    getActiveSocketStub.returns(null);
    getTunnelOwnerStub.returns(mockRemoteInstanceId);

    // Simulate addPendingForwardedRequest rejecting due to timeout
    addPendingFwdReqStub.rejects(new Error(`Forwarded request some-job-id timed out.`));

    const response = await callHandler();
    assertEquals(response.status, 504); // Gateway Timeout
    const body = await response.json();
    assertEquals(body.error, "Health check timed out waiting for response from target relay instance.");
    assertSpyCalls(postHealthCheckSpy, 1); // Check that we at least tried to forward
  });

  await t.step("Scenario 4: Tunnel not found locally, owner unknown/unresponsive", async () => {
    getTunnelStub.resolves({ tunnelId: mockTunnelId, status: "connected" } as TunnelRegistration);
    getActiveSocketStub.returns(null); // Not local
    getTunnelOwnerStub.returns(undefined); // Owner unknown

    const response = await callHandler();
    assertEquals(response.status, 200); // Route currently returns 200 with status "disconnected"
    const body: HealthStatusReport = await response.json();
    assertEquals(body.tunnelId, mockTunnelId);
    assertEquals(body.tunnelStatus, "disconnected"); // Or "unknown" based on logic
    assertEquals(body.localServiceStatus, "unknown");
    assertEquals(body.checkedByInstanceId, mockLocalInstanceId);
    assertSpyCalls(performLocalCheckStub, 0); // Should not perform local check
    assertSpyCalls(postHealthCheckSpy, 0); // Should not attempt to forward
  });
  
  await t.step("Scenario 4.1: Tunnel owner is this instance, but socket is not OPEN", async () => {
    getTunnelStub.resolves({ tunnelId: mockTunnelId, status: "connected" } as TunnelRegistration);
    getActiveSocketStub.returns({ readyState: WebSocket.CLOSED }); // Local but not open
    getTunnelOwnerStub.returns(mockLocalInstanceId); // This instance is the owner

    const response = await callHandler();
    assertEquals(response.status, 200); 
    const body: HealthStatusReport = await response.json();
    assertEquals(body.tunnelId, mockTunnelId);
    assertEquals(body.tunnelStatus, "disconnected"); 
    assertEquals(body.localServiceStatus, "unknown");
    assertEquals(body.checkedByInstanceId, mockLocalInstanceId);
    assertSpyCalls(performLocalCheckStub, 0); 
    assertSpyCalls(postHealthCheckSpy, 0);
  });

  await t.step("Missing tunnelId parameter - returns 400", async () => {
    const response = await callHandler(""); // Pass empty string for tunnelId
    assertEquals(response.status, 400);
    const body = await response.json();
    assertEquals(body.error, "Tunnel ID is missing.");
  });

});
