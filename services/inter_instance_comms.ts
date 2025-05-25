// services/inter_instance_comms.ts
import { RELAY_INSTANCE_ID } from "../lib/utils.ts";
import {
  REQUEST_FORWARDING_CHANNEL_NAME,
  RESPONSE_FORWARDING_CHANNEL_NAME,
  TUNNEL_ACTIVITY_CHANNEL_NAME,
  HEALTH_CHECK_REQUEST_CHANNEL_NAME, // New
  HEALTH_CHECK_RESPONSE_CHANNEL_NAME, // New
} from "./broadcast_channels.ts";
import {
  BroadcastHealthCheckMessage, // New from shared/health.ts
  BroadcastHealthCheckResponseMessage, // New from shared/health.ts
  HealthStatusReport, // Used by health check response
} from "../../shared/health.ts"; // Assuming path to shared/health.ts

// Define the expected structure of broadcast messages
interface BaseBroadcastMessage {
  originalInstanceId: string;
  targetInstanceId?: string;
}

export interface BroadcastHttpRequestMessage extends BaseBroadcastMessage {
  type: "httpRequest";
  tunnelId: string;
  requestId: string;
  // Serialized request data (method, path, headers, body)
  // This should align with AgentHttpRequestData in shared/tunnel.ts
  requestData: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: string | null;
  };
}

export interface BroadcastHttpResponseMessage extends BaseBroadcastMessage {
  type: "httpResponse";
  tunnelId: string; // For context, though response is routed by requestId
  requestId: string;
  // Serialized response data (status, headers, body)
  // This should align with HttpResponseData in shared/tunnel.ts
  responseData: {
    status: number;
    headers: Record<string, string>;
    body?: string | null;
  };
}

export interface TunnelActivityMessage extends BaseBroadcastMessage {
  type: "tunnelActivity";
  activity: "connected" | "disconnected";
  tunnelId: string;
  // instanceId and timestamp are part of the originalInstanceId and server-generated
}


// --- BroadcastChannel Instances ---
let requestForwardingChannel: BroadcastChannel | null = null;
let responseForwardingChannel: BroadcastChannel | null = null;
let tunnelActivityChannel: BroadcastChannel | null = null;
let healthCheckRequestChannel: BroadcastChannel | null = null; // New
let healthCheckResponseChannel: BroadcastChannel | null = null; // New

/**
 * Handles incoming broadcasted HTTP requests.
 * This instance will check if it's the target or if it manages the tunnelId.
 * If so, it will try to forward the request to the local agent.
 */
function handleBroadcastRequest(message: any): void {
  if (typeof message !== 'object' || message === null) {
    console.warn("[InterComms] Received non-object message on request channel:", message);
    return;
  }
  // Basic validation to ensure it's a message we might care about
  if (message.originalInstanceId === RELAY_INSTANCE_ID) {
    // console.log("[InterComms] Ignoring own broadcasted request message.");
    return; // Ignore messages broadcast by self
  }

  // More specific type check/validation would be good here
  const requestMessage = message as BroadcastHttpRequestMessage;
  console.log(
    `[InterComms] Received broadcasted HTTP request: ReqID ${requestMessage.requestId} for Tunnel ${requestMessage.tunnelId} (from instance ${requestMessage.originalInstanceId})`,
    // requestMessage.requestData // Potentially large, log selectively
  );

  // TODO (Step 3):
import { v4 as uuidv4 } from "uuid";
import {
  setTunnelOwner,
  removeTunnelOwner,
  getTunnelOwnerInstance,
} from "./distributed_tunnel_registry.ts";
import {
  forwardRequestToLocalAgent,
  initiateForwardedAgentHealthCheck, // New import from tunnel.ts
} from "../services/mcp/server/tunnel.ts";
import {
  resolveForwardedRequest,
  rejectForwardedRequest, // Now might be used if health check target instance cannot perform it
} from "./forwarded_request_registry.ts";


// --- HTTP Request/Response Message Handlers ---

/**
 * Handles incoming broadcasted HTTP requests.
 */
function handleBroadcastRequest(message: any): void {
  if (typeof message !== 'object' || message === null || message.type !== "httpRequest") {
    console.warn("[InterComms] Received invalid or non-httpRequest message on request channel:", message);
    return;
  }
  if (message.originalInstanceId === RELAY_INSTANCE_ID) return; // Ignore self

  const requestMsg = message as BroadcastHttpRequestMessage;
  console.log(
    `[InterComms] Received broadcasted HTTP request: JobID ${requestMsg.requestId} for Tunnel ${requestMsg.tunnelId} from instance ${requestMsg.originalInstanceId}. Target: ${requestMsg.targetInstanceId || 'any'}.`,
  );

  // If a targetInstanceId is specified and it's not this instance, ignore.
  if (requestMsg.targetInstanceId && requestMsg.targetInstanceId !== RELAY_INSTANCE_ID) {
    // console.log(`[InterComms] Ignoring request ${requestMsg.requestId} as it's targeted for instance ${requestMsg.targetInstanceId}.`);
    return;
  }

  // If no targetInstanceId, or if it matches this instance, check if this instance owns the tunnel.
  // We rely on forwardRequestToLocalAgent to check getActiveTunnelSocket.
  // It will also send a 502 back via broadcast if the agent is not connected here.
  
  // Generate a new requestId for communication with the local agent.
  // The original requestMsg.requestId is the "jobId" that the originalInstanceId is waiting on.
  const requestIdForAgent = uuidv4();

  const success = forwardRequestToLocalAgent(
    requestMsg.tunnelId,
    requestIdForAgent, // New ID for agent interaction
    requestMsg.requestId, // Original Job ID from the broadcasting instance
    requestMsg.originalInstanceId, // Instance that broadcasted the request
    requestMsg.requestData,
  );

  if (success) {
    console.log(`[InterComms] Accepted broadcasted request ${requestMsg.requestId}, forwarding to local agent for tunnel ${requestMsg.tunnelId} with new agentReqId ${requestIdForAgent}.`);
  } else {
    // forwardRequestToLocalAgent already logs a warning and sends a 502 broadcast response.
    console.warn(`[InterComms] Did not accept broadcasted request ${requestMsg.requestId} for tunnel ${requestMsg.tunnelId} (agent not local or not connected).`);
  }
}

/**
 * Handles incoming broadcasted HTTP responses.
 */
function handleBroadcastResponse(message: any): void {
  if (typeof message !== 'object' || message === null || message.type !== "httpResponse") {
    console.warn("[InterComms] Received invalid or non-httpResponse message on response channel:", message);
    return;
  }
  
  // message.originalInstanceId is the instance that handled the agent & sent this broadcast.
  // message.targetInstanceId is the instance that made the original public request and is waiting.
  
  if (message.targetInstanceId === RELAY_INSTANCE_ID) {
    // This message is intended for this instance.
    const responseMsg = message as BroadcastHttpResponseMessage;
    console.log(
      `[InterComms] Received broadcasted HTTP response for JobID ${responseMsg.requestId} (from instance ${responseMsg.originalInstanceId} for tunnel ${responseMsg.tunnelId}). Resolving in forwarded_request_registry.`,
    );
    resolveForwardedRequest(responseMsg.requestId, responseMsg.responseData);
  } else if (message.originalInstanceId === RELAY_INSTANCE_ID) {
    // This instance broadcasted this message, ignore.
    return;
  } else {
    // Not targeted at this instance and not self-originated (should be rare if targetInstanceId is always set by sender)
    // console.log(`[InterComms] Ignoring broadcasted HTTP response not targeted at this instance. Target: ${message.targetInstanceId}, JobID: ${message.requestId}`);
  }
}

/**
 * Handles tunnel activity notifications from other instances.
 */
function handleTunnelActivity(message: any): void {
  if (typeof message !== 'object' || message === null || message.type !== "tunnelActivity") {
    console.warn("[InterComms] Received invalid or non-tunnelActivity message on activity channel:", message);
    return;
  }
  if (message.originalInstanceId === RELAY_INSTANCE_ID) return; // Ignore self

  const activityMsg = message as TunnelActivityMessage; // Assume this type is defined or imported
  console.log(
    `[InterComms] Received tunnel activity: Tunnel ${activityMsg.tunnelId} ${activityMsg.activity} on instance ${activityMsg.originalInstanceId}. Updating distributed registry.`,
  );

  if (activityMsg.activity === "connected") {
    setTunnelOwner(activityMsg.tunnelId, activityMsg.originalInstanceId);
  } else if (activityMsg.activity === "disconnected") {
    const currentOwner = getTunnelOwnerInstance(activityMsg.tunnelId);
    if (currentOwner === activityMsg.originalInstanceId) {
      removeTunnelOwner(activityMsg.tunnelId);
    } else if (currentOwner) {
      console.log(`[InterComms] Ignoring disconnect for tunnel ${activityMsg.tunnelId} from ${activityMsg.originalInstanceId}, as current owner is ${currentOwner}.`);
    } else {
      removeTunnelOwner(activityMsg.tunnelId);
    }
  }
}

// --- Health Check Message Handlers ---

function handleBroadcastHealthCheckRequest(message: any): void {
  if (typeof message !== 'object' || message === null || message.type !== "forwardHealthCheck") {
    console.warn("[InterComms] Received invalid or non-forwardHealthCheck message on health request channel:", message);
    return;
  }
  if (message.originalInstanceId === RELAY_INSTANCE_ID) return; // Ignore self

  const healthReqMsg = message as BroadcastHealthCheckMessage;
  console.log(
    `[InterComms] Received broadcasted HealthCheck request: JobID ${healthReqMsg.healthCheckJobId} for Tunnel ${healthReqMsg.tunnelId} from instance ${healthReqMsg.originalInstanceId}. Target: ${healthReqMsg.targetInstanceId || 'any'}.`,
  );

  // If a targetInstanceId is specified and it's not this instance, ignore.
  if (healthReqMsg.targetInstanceId && healthReqMsg.targetInstanceId !== RELAY_INSTANCE_ID) {
    return;
  }

  // This instance should perform the health check on its local agent (if it owns the tunnel)
  // initiateForwardedAgentHealthCheck will check if agent is local and handle sending ping or responding if not.
  initiateForwardedAgentHealthCheck(
    healthReqMsg.tunnelId,
    healthReqMsg.healthCheckJobId, // This is the ID the original instance is waiting on
    healthReqMsg.originalInstanceId,
  );
}

function handleBroadcastHealthCheckResponse(message: any): void {
  if (typeof message !== 'object' || message === null || message.type !== "forwardHealthCheckResponse") {
    console.warn("[InterComms] Received invalid or non-forwardHealthCheckResponse message on health response channel:", message);
    return;
  }

  if (message.targetInstanceId === RELAY_INSTANCE_ID) {
    const healthResponseMsg = message as BroadcastHealthCheckResponseMessage;
    console.log(
      `[InterComms] Received broadcasted HealthCheck response for JobID ${healthResponseMsg.healthCheckJobId} (from instance ${healthResponseMsg.originalInstanceId}). Resolving in forwarded_request_registry.`,
    );
    // The `healthCheckJobId` here is the one the original requesting instance is waiting for.
    // The `statusReport` is already in the correct format for ForwardedResponseData (assuming it matches).
    // If ForwardedResponseData is more generic, we might need to adapt.
    // For now, let's assume statusReport can be directly used or adapted by resolveForwardedRequest if needed.
    resolveForwardedRequest(healthResponseMsg.healthCheckJobId, healthResponseMsg.statusReport as any);
  } else if (message.originalInstanceId === RELAY_INSTANCE_ID) {
    return; // Ignore self-broadcasted message
  }
}


/**
 * Initializes the BroadcastChannel listeners for inter-instance communication.
 */
export function initializeBroadcastListeners(): void {
  if (requestForwardingChannel || responseForwardingChannel || tunnelActivityChannel || healthCheckRequestChannel || healthCheckResponseChannel) {
    console.warn("[InterComms] Broadcast listeners (or some) already initialized.");
    return;
  }

  try {
    // HTTP Request/Response Channels
    if (!requestForwardingChannel) {
      requestForwardingChannel = new BroadcastChannel(REQUEST_FORWARDING_CHANNEL_NAME);
      requestForwardingChannel.onmessage = (event: MessageEvent) => handleBroadcastRequest(event.data);
      console.log(`[InterComms] Listening on request forwarding channel: ${REQUEST_FORWARDING_CHANNEL_NAME}`);
    }
    if (!responseForwardingChannel) {
      responseForwardingChannel = new BroadcastChannel(RESPONSE_FORWARDING_CHANNEL_NAME);
      responseForwardingChannel.onmessage = (event: MessageEvent) => handleBroadcastResponse(event.data);
      console.log(`[InterComms] Listening on response forwarding channel: ${RESPONSE_FORWARDING_CHANNEL_NAME}`);
    }
    // Tunnel Activity Channel
    if (!tunnelActivityChannel) {
      tunnelActivityChannel = new BroadcastChannel(TUNNEL_ACTIVITY_CHANNEL_NAME);
      tunnelActivityChannel.onmessage = (event: MessageEvent) => handleTunnelActivity(event.data);
      console.log(`[InterComms] Listening on tunnel activity channel: ${TUNNEL_ACTIVITY_CHANNEL_NAME}`);
    }
    // Health Check Channels
    if (!healthCheckRequestChannel) {
      healthCheckRequestChannel = new BroadcastChannel(HEALTH_CHECK_REQUEST_CHANNEL_NAME);
      healthCheckRequestChannel.onmessage = (event: MessageEvent) => handleBroadcastHealthCheckRequest(event.data);
      console.log(`[InterComms] Listening on health check request channel: ${HEALTH_CHECK_REQUEST_CHANNEL_NAME}`);
    }
    if (!healthCheckResponseChannel) {
      healthCheckResponseChannel = new BroadcastChannel(HEALTH_CHECK_RESPONSE_CHANNEL_NAME);
      healthCheckResponseChannel.onmessage = (event: MessageEvent) => handleBroadcastHealthCheckResponse(event.data);
      console.log(`[InterComms] Listening on health check response channel: ${HEALTH_CHECK_RESPONSE_CHANNEL_NAME}`);
    }
    console.log(`[InterComms] Instance ${RELAY_INSTANCE_ID} broadcast listeners initialized.`);
  } catch (error) {
    console.error("[InterComms] Failed to initialize BroadcastChannel listeners:", error);
  }
}

/**
 * Closes all active BroadcastChannel instances.
 * Useful for graceful shutdown.
 */
export function closeBroadcastChannels(): void {
  requestForwardingChannel?.close(); requestForwardingChannel = null;
  responseForwardingChannel?.close(); responseForwardingChannel = null;
  tunnelActivityChannel?.close(); tunnelActivityChannel = null;
  healthCheckRequestChannel?.close(); healthCheckRequestChannel = null;
  healthCheckResponseChannel?.close(); healthCheckResponseChannel = null;
  console.log("[InterComms] All broadcast channels closed.");
}

// --- Functions to post messages ---

export function postHttpRequestToChannel(message: Omit<BroadcastHttpRequestMessage, 'originalInstanceId'>): void {
    if (!requestForwardingChannel) {
        console.error("[InterComms] Request forwarding channel not initialized. Cannot post message.");
        return;
    }
    const fullMessage: BroadcastHttpRequestMessage = {
        ...message,
        originalInstanceId: RELAY_INSTANCE_ID,
    };
    requestForwardingChannel.postMessage(fullMessage);
}

export function postHttpResponseToChannel(message: Omit<BroadcastHttpResponseMessage, 'originalInstanceId'>): void {
    if (!responseForwardingChannel) {
        console.error("[InterComms] Response forwarding channel not initialized. Cannot post message.");
        return;
    }
    const fullMessage: BroadcastHttpResponseMessage = {
        ...message,
        originalInstanceId: RELAY_INSTANCE_ID,
    };
    responseForwardingChannel.postMessage(fullMessage);
}

export function postTunnelActivityToChannel(message: Omit<TunnelActivityMessage, 'originalInstanceId'>): void {
    if (!tunnelActivityChannel) {
        console.error("[InterComms] Tunnel activity channel not initialized. Cannot post message.");
        return;
    }
    const fullMessage: TunnelActivityMessage = {
        ...message,
        originalInstanceId: RELAY_INSTANCE_ID,
    };
    tunnelActivityChannel.postMessage(fullMessage);
}

export function postHealthCheckToChannel(message: Omit<BroadcastHealthCheckMessage, 'originalInstanceId'>): void {
    if (!healthCheckRequestChannel) {
        console.error("[InterComms] Health check request channel not initialized. Cannot post message.");
        return;
    }
    const fullMessage: BroadcastHealthCheckMessage = {
        ...message,
        originalInstanceId: RELAY_INSTANCE_ID,
    };
    healthCheckRequestChannel.postMessage(fullMessage);
}

export function postHealthCheckResponseToChannel(message: Omit<BroadcastHealthCheckResponseMessage, 'originalInstanceId'>): void {
    if (!healthCheckResponseChannel) {
        console.error("[InterComms] Health check response channel not initialized. Cannot post message.");
        return;
    }
    const fullMessage: BroadcastHealthCheckResponseMessage = {
        ...message,
        originalInstanceId: RELAY_INSTANCE_ID,
    };
    healthCheckResponseChannel.postMessage(fullMessage);
}

// Optional: Add graceful shutdown handling
// Deno.addSignalListener("SIGINT", closeBroadcastChannels);
// globalThis.addEventListener?.("unload", closeBroadcastChannels);
