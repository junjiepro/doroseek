// services/broadcast_channels.ts

/**
 * BroadcastChannel name for forwarding HTTP requests from a relay instance
 * that received the public request to the specific relay instance that has
 * the active WebSocket connection to the target local agent.
 */
export const REQUEST_FORWARDING_CHANNEL_NAME = "doroseek-tunnel-requests";

/**
 * BroadcastChannel name for forwarding HTTP responses from the relay instance
 * connected to the local agent back to the relay instance that originally
 * received the public request and is holding the client's HTTP connection open.
 */
export const RESPONSE_FORWARDING_CHANNEL_NAME = "doroseek-tunnel-responses";

/**
 * BroadcastChannel name for notifying other instances about changes in
 * active tunnel connections (e.g., an agent connects or disconnects from an instance).
 * This allows instances to maintain a more accurate distributed map of tunnelId-to-instanceId.
 */
export const TUNNEL_ACTIVITY_CHANNEL_NAME = "doroseek-tunnel-activity";

/**
 * BroadcastChannel name for forwarding health check requests (ping initiations)
 * from the instance that received the API request to the instance owning the tunnel agent.
 * (Could also reuse REQUEST_FORWARDING_CHANNEL_NAME if message types are distinguishable)
 */
export const HEALTH_CHECK_REQUEST_CHANNEL_NAME = "doroseek-health-check-requests";

/**
 * BroadcastChannel name for forwarding health check responses (status reports)
 * from the instance that performed the check back to the instance that
 * originally received the API request.
 */
export const HEALTH_CHECK_RESPONSE_CHANNEL_NAME = "doroseek-health-check-responses";
