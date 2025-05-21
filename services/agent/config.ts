// services/agent/config.ts

export interface AgentServiceConfig {
  id: string; // User-defined ID for the service, e.g., "my-web-app"
  name: string; // User-friendly name, e.g., "My Web Application"
  type: "http" | "tcp"; // Type of service
  local_host: string; // Hostname or IP of the local service, e.g., "localhost", "127.0.0.1"
  local_port: number; // Port of the local service
  subdomainOrPath: string; // Requested subdomain or path prefix on the relay
}

export interface AgentConfig {
  relayUrl: string; // Full WebSocket URL of the Doroseek relay, e.g., wss://example.com/mcp/tunnel/register
  apiKey: string; // API key for authenticating with the Doroseek relay
  services: AgentServiceConfig[]; // Array of services to be tunneled
}

export function loadAgentConfig(): AgentConfig | null {
  const agentModeEnabled = Deno.env.get("DOROSEEK_AGENT_MODE_ENABLED");
  if (agentModeEnabled !== "true") {
    // console.log("[Agent Config] Agent mode not enabled (DOROSEEK_AGENT_MODE_ENABLED !== 'true').");
    return null;
  }

  const relayUrl = Deno.env.get("DOROSEEK_RELAY_URL");
  const apiKey = Deno.env.get("DOROSEEK_AGENT_API_KEY");
  const servicesJson = Deno.env.get("DOROSEEK_AGENT_SERVICES_JSON");

  if (!relayUrl) {
    console.error(
      "[Agent Config] Missing required environment variable: DOROSEEK_RELAY_URL",
    );
    return null;
  }
  if (!apiKey) {
    console.error(
      "[Agent Config] Missing required environment variable: DOROSEEK_AGENT_API_KEY",
    );
    return null;
  }
  if (!servicesJson) {
    console.error(
      "[Agent Config] Missing required environment variable: DOROSEEK_AGENT_SERVICES_JSON",
    );
    return null;
  }

  // Validate relayUrl format
  if (!relayUrl.startsWith("ws://") && !relayUrl.startsWith("wss://")) {
    console.error(
      `[Agent Config] Invalid DOROSEEK_RELAY_URL format: "${relayUrl}". Must start with ws:// or wss://.`,
    );
    return null;
  }

  let services: AgentServiceConfig[];
  try {
    services = JSON.parse(servicesJson);
  } catch (e) {
    console.error(
      `[Agent Config] Failed to parse DOROSEEK_AGENT_SERVICES_JSON: ${e.message}`,
    );
    return null;
  }

  if (!Array.isArray(services) || services.length === 0) {
    console.error(
      "[Agent Config] DOROSEEK_AGENT_SERVICES_JSON must be a non-empty array.",
    );
    return null;
  }

  // Validate each service configuration
  for (const service of services) {
    if (
      !service.id || typeof service.id !== "string" ||
      !service.name || typeof service.name !== "string" ||
      !service.type || (service.type !== "http" && service.type !== "tcp") ||
      !service.local_host || typeof service.local_host !== "string" ||
      !service.local_port || typeof service.local_port !== "number" ||
      !service.subdomainOrPath || typeof service.subdomainOrPath !== "string"
    ) {
      console.error(
        `[Agent Config] Invalid service configuration in DOROSEEK_AGENT_SERVICES_JSON. ` +
        `Each service must have: id (string), name (string), type ('http'|'tcp'), ` +
        `local_host (string), local_port (number), subdomainOrPath (string). Found:`,
        service,
      );
      return null;
    }
    if (service.subdomainOrPath.includes("/") || service.subdomainOrPath.includes(" ")) {
         console.error(
            `[Agent Config] Invalid 'subdomainOrPath' for service '${service.id}': "${service.subdomainOrPath}". ` +
            `It should not contain '/' or spaces. It's used as a direct path segment or subdomain component.`
         );
         return null;
    }
  }

  console.log("[Agent Config] Agent configuration loaded successfully.");
  return {
    relayUrl,
    apiKey,
    services,
  };
}
