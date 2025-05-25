import { FreshContext, Handlers } from "$fresh/server.ts";
import { v4 as uuidv4 } from "uuid";
import { RELAY_INSTANCE_ID } from "../../../lib/utils.ts";
import { getTunnel } from "../../../services/database.ts";
import {
  getTunnelOwnerInstance,
  // setTunnelOwner, // Not directly used by this route
} from "../../../services/distributed_tunnel_registry.ts";
import {
  getActiveTunnelSocket,
  performLocalAgentHealthCheck,
} from "../../../services/mcp/server/tunnel.ts";
import {
  addPendingForwardedRequest,
  ForwardedResponseData, // This registry is generic enough for health check responses too
  // rejectForwardedRequest, // If we need to explicitly reject
} from "../../../services/forwarded_request_registry.ts";
import {
  postHealthCheckToChannel,
  // BroadcastHealthCheckMessage, // Type used internally by postHealthCheckToChannel
} from "../../../services/inter_instance_comms.ts";
import { HealthStatusReport } from "../../../shared/health.ts";

const HEALTH_CHECK_API_TIMEOUT_MS = 15000; // Total timeout for the API endpoint

export const handler: Handlers<HealthStatusReport | { error: string }> = {
  async GET(_req: Request, ctx: FreshContext) {
    const tunnelId = ctx.params.tunnelId;

    if (!tunnelId) {
      return new Response(JSON.stringify({ error: "Tunnel ID is missing." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Optional: Authentication/Authorization for this endpoint can be added here.
    // For now, assuming if tunnelId is valid, status can be checked.

    const tunnelInfoFromDb = await getTunnel(tunnelId);
    if (!tunnelInfoFromDb) {
      return new Response(JSON.stringify({ error: "Tunnel not found in database." }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const healthCheckJobId = uuidv4(); // Unique ID for this overall health check operation initiated by API

    const ownerInstanceId = getTunnelOwnerInstance(tunnelId);
    const localAgentSocket = getActiveTunnelSocket(tunnelId);

    let statusReport: HealthStatusReport;

    try {
      if (localAgentSocket && localAgentSocket.readyState === WebSocket.OPEN) {
        // Agent is connected to THIS instance. Perform local health check.
        console.log(`[API Status ${tunnelId}] Agent is local. Performing local health check. JobId: ${healthCheckJobId}`);
        statusReport = await performLocalAgentHealthCheck(tunnelId);
      } else if (ownerInstanceId && ownerInstanceId !== RELAY_INSTANCE_ID) {
        // Agent is (supposedly) connected to ANOTHER instance. Forward health check request.
        console.log(`[API Status ${tunnelId}] Agent on remote instance ${ownerInstanceId}. Forwarding health check. JobId: ${healthCheckJobId}`);
        
        const responsePromise = addPendingForwardedRequest(healthCheckJobId, HEALTH_CHECK_API_TIMEOUT_MS);
        
        postHealthCheckToChannel({
          // type: "forwardHealthCheck", // Implicit in the channel/handler
          healthCheckJobId: healthCheckJobId, // This is the ID the remote instance's response handler will use to find the promise
          originalInstanceId: RELAY_INSTANCE_ID,
          targetInstanceId: ownerInstanceId,
          tunnelId: tunnelId,
        });

        // The type from addPendingForwardedRequest is ForwardedResponseData,
        // but we expect a HealthStatusReport. We cast it, assuming the inter_instance_comms
        // and forwarded_request_registry handle this correctly.
        statusReport = await responsePromise as unknown as HealthStatusReport;
        
      } else {
        // Agent not connected locally, and no other owner known or owner is this instance but socket is bad.
        console.log(`[API Status ${tunnelId}] Agent not connected locally, owner unknown or socket bad. JobId: ${healthCheckJobId}`);
        statusReport = {
          tunnelId: tunnelId,
          tunnelStatus: "disconnected", // Or "unknown" if relying solely on registry
          localServiceStatus: "unknown",
          checkedByInstanceId: RELAY_INSTANCE_ID, // This instance made the determination
          timestamp: new Date().toISOString(),
        };
      }
    } catch (error) {
      console.error(`[API Status ${tunnelId}] Error during health check for JobId ${healthCheckJobId}:`, error);
      statusReport = {
        tunnelId: tunnelId,
        tunnelStatus: "unknown",
        localServiceStatus: "error", // Error during the check process itself
        checkedByInstanceId: RELAY_INSTANCE_ID,
        timestamp: new Date().toISOString(),
      };
      // Determine if a specific HTTP status for the error is better
      // For now, we'll return 200 with the error in the statusReport.
      // Or, could return 500 if it's an unexpected error.
      // If it's a timeout from addPendingForwardedRequest:
      if (error.message && error.message.includes("timed out")) {
         return new Response(JSON.stringify({ 
            error: "Health check timed out waiting for response from target relay instance.",
            tunnelId,
            details: error.message,
        }), {
            status: 504, // Gateway Timeout
            headers: { "Content-Type": "application/json" },
        });
      }
       return new Response(JSON.stringify({ 
            error: "Internal error during health check.",
            tunnelId,
            details: error.message,
        }), {
            status: 500, 
            headers: { "Content-Type": "application/json" },
        });
    }

    return new Response(JSON.stringify(statusReport), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  },
};
