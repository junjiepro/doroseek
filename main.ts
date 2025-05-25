/// <reference no-default-lib="true" />
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/// <reference lib="dom.asynciterable" />
/// <reference lib="deno.ns" />
/// <reference lib="deno.unstable" />

import { start } from "$fresh/server.ts";
import manifest from "./fresh.gen.ts";
import freshConfig from "./fresh.config.ts"; // Renamed to avoid conflict with agent 'config'

// Imports for Agent Mode
import { loadAgentConfig, AgentConfig } from "./services/agent/config.ts";
import { AgentConnector } from "./services/agent/connector.ts";
import { AgentRequestHandler } from "./services/agent/handler.ts";

// Imports for Inter-Instance Communication (Server Mode)
import { initializeBroadcastListeners } from "./services/inter_instance_comms.ts";

async function main() {
  // Attempt to load agent configuration
  const agentConfig: AgentConfig | null = loadAgentConfig();

  if (agentConfig) {
    // Agent mode is enabled and configuration is valid
    console.log("[Main] Doroseek starting in Agent Mode.");

    // 1. Create AgentConnector
    const agentConnector = new AgentConnector(agentConfig);

    // 2. Create AgentRequestHandler
    const agentRequestHandler = new AgentRequestHandler(
      agentConfig.services,
      agentConnector,
    );

    // 3. Register the request handler with the connector
    // The handler's 'this' context needs to be bound correctly.
    agentConnector.onHttpRequest = agentRequestHandler.handleIncomingRequest.bind(
      agentRequestHandler,
    );
    // Set the request handler on the connector for other callbacks like health checks
    agentConnector.setRequestHandler(agentRequestHandler);
    
    agentConnector.onReady = () => {
        console.log("[Main] Agent is connected and registered with the relay.");
        const tunnelInfo = agentConnector.getTunnelInfo();
        if (tunnelInfo.tunnelId && tunnelInfo.publicBaseUrl) {
            console.log(`[Main] Tunnel ID: ${tunnelInfo.tunnelId}`);
            console.log(`[Main] Public Base URL: ${tunnelInfo.publicBaseUrl}`);
            // Log service URLs
            agentConfig.services.forEach(service => {
                console.log(`  - Service '${service.name}' (${service.id}) accessible via: ${tunnelInfo.publicBaseUrl}/${service.subdomainOrPath}`);
            });
        }
    };


    // 4. Start the agent connector
    try {
      await agentConnector.connect(); // connect() is not async, but future versions might be.
                                  // The process stays alive due to the WebSocket connection.
      console.log("[Main] Agent connector initiated connection sequence.");
      // The Deno process will stay alive as long as the WebSocket connection
      // (or its reconnection attempts) are active. No need for an artificial loop.
    } catch (error) {
      console.error("[Main] Error starting Agent Connector:", error);
      // Depending on the error, Deno might exit or the connector's retry might handle it.
      // If connect() itself throws synchronously and critically, process might exit if not caught broadly.
    }
  } else {
    // Agent mode is not enabled or configuration is invalid. Start Fresh server.
    // loadAgentConfig() already logs reasons for invalid config or if agent mode is not enabled.
    console.log("[Main] Doroseek starting in Server Mode.");
    
    // Initialize BroadcastChannel listeners for inter-instance communication
    initializeBroadcastListeners();
    
    // Start the Fresh server
    await start(manifest, freshConfig);
  }
}

// Start the application
main().catch(err => {
    console.error("[Main] Critical error during startup:", err);
    Deno.exit(1);
});
