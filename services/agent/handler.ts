// services/agent/handler.ts
import { AgentServiceConfig } from "./config.ts";
import {
  AgentHttpRequest,
  AgentHttpResponse,
  // HttpRequestData, // Not directly used here, but part of AgentHttpRequest
  HttpResponseData,
} from "../../shared/tunnel.ts";
import {
  AgentPongMessage,
  LocalServiceStatus,
} from "../../shared/health.ts"; // For health check responses
import { AgentConnector } from "./connector.ts";

const LOCAL_SERVICE_HEALTH_CHECK_TIMEOUT_MS = 3000; // 3 seconds for local check

// Helper to decode base64 string to Uint8Array, if needed for request body
// (Assuming server sends body as base64 string for binary, or plain string for text)
function tryDecodeBase64(data: string | null | undefined, contentType?: string): BodyInit | null | undefined {
  if (data === null || data === undefined) return data;

  // Heuristic: if content type is not text-like, assume it might be base64
  const isTextLike = contentType && (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("application/x-www-form-urlencoded")
  );

  if (!isTextLike) {
    try {
      // Check if it looks like base64 before attempting to decode
      // A more robust check might involve regex or checking padding, but atob handles most cases.
      const binaryString = atob(data);
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
    } catch (e) {
      // console.warn("[Agent Handler] Failed to decode base64 body, treating as plain text:", e.message);
      // Fallback to using data as is if it's not valid base64 or if atob fails.
      // This might happen if server sends plain text for an unknown binary type.
    }
  }
  return data; // Return as string if text-like or if base64 decoding failed
}


// Helper to serialize response body (string or base64 for binary)
async function serializeResponseBody(response: Response): Promise<string | null> {
    if (response.status === 204 || response.status === 304) return null; // No content

    const contentType = response.headers.get("content-type");
    const isTextLike = contentType && (
        contentType.startsWith("text/") ||
        contentType.includes("json") ||
        contentType.includes("xml") ||
        contentType.includes("application/x-www-form-urlencoded")
    );

    if (isTextLike) {
        return await response.text();
    } else {
        // For binary data, convert to base64
        try {
            const buffer = await response.arrayBuffer();
            if (buffer.byteLength === 0) return null;
            // Standard way to base64 encode ArrayBuffer in modern JS environments
            const uint8Array = new Uint8Array(buffer);
            let binaryString = '';
            uint8Array.forEach((byte) => {
                binaryString += String.fromCharCode(byte);
            });
            return btoa(binaryString);
        } catch (e) {
            console.error("[Agent Handler] Error reading response body as ArrayBuffer for base64 encoding:", e);
            // Fallback or throw error
            return await response.text(); // Or handle as error
        }
    }
}


export class AgentRequestHandler {
  private servicesConfig: AgentServiceConfig[];
  private connector: AgentConnector;

  constructor(
    servicesConfig: AgentServiceConfig[],
    connector: AgentConnector,
  ) {
    this.servicesConfig = servicesConfig;
    this.connector = connector;
    console.log("[Agent Handler] Initialized with service configurations:", servicesConfig.map(s => s.id || s.name));
  }

  public async handleHealthCheckPing(healthCheckJobId: string): Promise<void> {
    console.log(`[Agent Handler] Handling health check ping. Job ID: ${healthCheckJobId}`);
    let status: LocalServiceStatus = "unconfigured";

    if (this.servicesConfig.length > 0) {
      // Check the first configured service
      const serviceToCheck = this.servicesConfig[0];
      // For HTTP services, construct a base URL to ping.
      // For TCP, a different mechanism would be needed (not implemented here).
      if (serviceToCheck.type === "http") {
        const localCheckUrl = `http://${serviceToCheck.local_host}:${serviceToCheck.local_port}`;
        console.log(`[Agent Handler] Pinging local service ${serviceToCheck.id} at ${localCheckUrl}`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), LOCAL_SERVICE_HEALTH_CHECK_TIMEOUT_MS);

        try {
          const response = await fetch(localCheckUrl, {
            method: "HEAD", // Use HEAD for a lightweight check
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (response.ok || response.status < 500) { // Consider any non-5xx as "ok" for basic reachability
            status = "ok";
            console.log(`[Agent Handler] Local service ${serviceToCheck.id} responded OK (${response.status}) to HEAD request.`);
          } else {
            status = "error";
            console.warn(`[Agent Handler] Local service ${serviceToCheck.id} responded with error: ${response.status}`);
          }
        } catch (error) {
          clearTimeout(timeoutId);
          if (error.name === "AbortError") {
            status = "timeout";
            console.warn(`[Agent Handler] Local service ${serviceToCheck.id} timed out.`);
          } else {
            status = "error";
            console.error(`[Agent Handler] Error checking local service ${serviceToCheck.id}:`, error.message);
          }
        }
      } else {
        // For non-HTTP services, or if a more specific check is needed.
        // For now, if it's not HTTP, we can't check it with fetch.
        console.warn(`[Agent Handler] Cannot perform health check for non-HTTP service type: ${serviceToCheck.type}`);
        status = "unconfigured"; // Or a new status like "type_not_supported_for_check"
      }
    } else {
      console.log("[Agent Handler] No services configured for health check.");
      status = "unconfigured";
    }

    const pongMessage: AgentPongMessage = {
      type: "pong",
      healthCheckJobId,
      localServiceStatus: status,
    };
    this.connector.send(pongMessage as any); // Cast to TunnelMessage or ensure send() accepts AgentPongMessage
    console.log(`[Agent Handler] Sent pong for Job ID ${healthCheckJobId} with status: ${status}`);
  }


  public async handleIncomingRequest(message: AgentHttpRequest): Promise<void> {
    const { requestId, data: requestData } = message;
    const { method, path: incomingPath, headers: rawHeaders, body: rawBody } = requestData;

    console.log(`[Agent Handler] Handling request ${requestId}: ${method} ${incomingPath}`);

    // 1. Find Target Service
    let targetService: AgentServiceConfig | undefined;
    let localPath = incomingPath; // Path to be forwarded to the local service

    for (const service of this.servicesConfig) {
      const servicePrefix = `/${service.subdomainOrPath}`;
      if (incomingPath.startsWith(servicePrefix)) {
        targetService = service;
        localPath = incomingPath.substring(servicePrefix.length) || "/"; // Ensure path starts with /
        break;
      }
      // Handle root path if subdomainOrPath is empty or matches root (less common for multiple services)
      // For now, requires explicit prefix match.
    }

    if (!targetService) {
      console.warn(`[Agent Handler] No matching service found for path: ${incomingPath} (Req ID: ${requestId})`);
      this.sendErrorResponse(requestId, 404, "Target service not found for the given path.");
      return;
    }

    // 2. Construct Local URL
    const localUrl = `http://${targetService.local_host}:${targetService.local_port}${localPath}`;
    console.log(`[Agent Handler] Forwarding request ${requestId} to local URL: ${localUrl}`);

    // 3. Prepare Request for Local Fetch
    const requestHeaders = new Headers();
    for (const [key, value] of Object.entries(rawHeaders)) {
      // Filter out problematic headers like 'host' or other hop-by-hop headers if necessary.
      // `fetch` generally handles 'host' correctly by using the URL's host.
      // Content-Length will be set by `fetch` based on the body.
      if (key.toLowerCase() !== "host" && key.toLowerCase() !== "content-length") {
        requestHeaders.set(key, value);
      }
    }
    
    // Decode body if it was base64 encoded
    const requestBody = tryDecodeBase64(rawBody, requestHeaders.get("content-type") || undefined);

    try {
      // 4. Make Local HTTP Request
      const localResponse = await fetch(localUrl, {
        method: method,
        headers: requestHeaders,
        body: requestBody, // `fetch` handles null/undefined body correctly
        redirect: "manual", // Handle redirects manually if needed, or let them be followed
      });

      // 5. Process Local Response
      const responseStatus = localResponse.status;
      const responseHeadersObj: Record<string, string> = {};
      localResponse.headers.forEach((value, key) => {
        responseHeadersObj[key] = value;
      });
      
      const responseBodyString = await serializeResponseBody(localResponse);

      const httpResponseData: HttpResponseData = {
        status: responseStatus,
        headers: responseHeadersObj,
        body: responseBodyString,
      };

      this.sendHttpResponse(requestId, httpResponseData);
      console.log(`[Agent Handler] Responded to relay for request ${requestId} with status ${responseStatus}`);

    } catch (error) {
      console.error(`[Agent Handler] Error fetching local service for request ${requestId} (${localUrl}):`, error);
      // Determine error type for appropriate status code
      let errorStatus = 502; // Bad Gateway by default for network errors to local service
      let errorMessage = "Error connecting to local service.";
      if (error instanceof TypeError && error.message.includes("fetch failed")) { // Deno specific for network errors
         errorMessage = `Local service connection refused or unavailable at ${targetService.local_host}:${targetService.local_port}.`;
         errorStatus = 503; // Service Unavailable
      } else if (error.message.includes("Host not found")) { // Example for DNS-like issues
         errorMessage = `Local service host '${targetService.local_host}' not found.`;
         errorStatus = 502;
      }
      this.sendErrorResponse(requestId, errorStatus, errorMessage, error.message);
    }
  }

  private sendHttpResponse(requestId: string, data: HttpResponseData): void {
    const responseMessage: AgentHttpResponse = {
      type: "httpResponse",
      requestId: requestId,
      data: data,
    };
    this.connector.send(responseMessage as any); // Cast to TunnelMessage
  }

  private sendErrorResponse(requestId: string, statusCode: number, publicMessage: string, internalDetails?: string): void {
    console.warn(`[Agent Handler] Sending error for Req ID ${requestId}: ${statusCode} - ${publicMessage}`, internalDetails || "");
    const errorResponseData: HttpResponseData = {
      status: statusCode,
      headers: { "Content-Type": "application/json" },
      // It's often better not to send detailed internal error messages to the original client.
      // The relay server might also choose to sanitize this.
      body: JSON.stringify({ error: publicMessage, details: internalDetails }),
    };
    this.sendHttpResponse(requestId, errorResponseData);
  }
}
