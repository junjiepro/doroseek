// services/forwarded_request_registry.ts

// Defines the structure of the response data expected from another instance
// This should align with what the HTTP response construction needs.
export interface ForwardedResponseData {
  status: number;
  headers: Record<string, string>; // Headers as a simple object
  body: string | null; // Body as string (potentially base64 encoded for binary)
}

interface PendingRequest {
  resolve: (responseData: ForwardedResponseData) => void;
  reject: (error: any) => void;
  timeoutId: number;
}

const pendingForwardedRequests = new Map<string, PendingRequest>();
const DEFAULT_FORWARDING_TIMEOUT_MS = 30000; // 30 seconds, same as agent timeout in route

/**
 * Adds a request to the pending registry and returns a Promise that will be
 * resolved or rejected when the response (or error) is received from another instance.
 * @param jobId A unique ID for this forwarded request.
 * @param timeoutMs Timeout duration in milliseconds.
 * @returns A Promise that resolves with ForwardedResponseData or rejects on error/timeout.
 */
export function addPendingForwardedRequest(
  jobId: string,
  timeoutMs: number = DEFAULT_FORWARDING_TIMEOUT_MS,
): Promise<ForwardedResponseData> {
  return new Promise<ForwardedResponseData>((resolve, reject) => {
    if (pendingForwardedRequests.has(jobId)) {
      // This should ideally not happen if jobIds are unique (e.g., UUIDs)
      reject(new Error(`Job ID ${jobId} already exists in pending requests.`));
      return;
    }

    const timeoutId = setTimeout(() => {
      if (pendingForwardedRequests.has(jobId)) { // Check if it wasn't already resolved/rejected
        pendingForwardedRequests.delete(jobId);
        console.warn(`[ForwardRegistry] Request ${jobId} timed out after ${timeoutMs}ms.`);
        reject(new Error(`Forwarded request ${jobId} timed out.`));
      }
    }, timeoutMs);

    pendingForwardedRequests.set(jobId, { resolve, reject, timeoutId });
    console.log(`[ForwardRegistry] Added pending forwarded request: ${jobId}, timeout: ${timeoutMs}ms`);
  });
}

/**
 * Resolves a pending forwarded request with the received response data.
 * @param jobId The unique ID of the forwarded request.
 * @param responseData The response data received from another instance.
 */
export function resolveForwardedRequest(
  jobId: string,
  responseData: ForwardedResponseData,
): void {
  const pending = pendingForwardedRequests.get(jobId);
  if (pending) {
    clearTimeout(pending.timeoutId);
    pending.resolve(responseData);
    pendingForwardedRequests.delete(jobId);
    console.log(`[ForwardRegistry] Resolved forwarded request: ${jobId}`);
  } else {
    console.warn(`[ForwardRegistry] Received resolution for unknown or timed-out job ID: ${jobId}`);
  }
}

/**
 * Rejects a pending forwarded request due to an error.
 * @param jobId The unique ID of the forwarded request.
 * @param error The error object or reason for rejection.
 */
export function rejectForwardedRequest(jobId: string, error: any): void {
  const pending = pendingForwardedRequests.get(jobId);
  if (pending) {
    clearTimeout(pending.timeoutId);
    pending.reject(error);
    pendingForwardedRequests.delete(jobId);
    console.log(`[ForwardRegistry] Rejected forwarded request: ${jobId}`, error);
  } else {
    console.warn(`[ForwardRegistry] Received rejection for unknown or timed-out job ID: ${jobId}`, error);
  }
}

// For testing or monitoring, if needed
export function getPendingRequestCount(): number {
  return pendingForwardedRequests.size;
}
