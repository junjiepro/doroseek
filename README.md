# `Doroseek`

A simple AI app built with Deno and Fresh.

1. Access all your OpenAI Compatible endpoints with the same base URL and API
   key. And you can share the `Doroseek` API key with others to access the
   endpoints.
2. As MCP server with several build-in servers.
3. As MCP Proxy server, connect to other MCP server.

![Home](/home.png)

## Features

- OpenAI Compatible endpoints
  - Manage endpoints and API keys
  - Generate `Doroseek` API keys
  - Assign alias to models
  - route
    - manage route: `/{key}`
    - OpenAI Compatible route: `/api`
- MCP SSE Server
  - sequentialthinking -
    [Sequential Thinking](https://github.com/modelcontextprotocol/servers/blob/main/src/sequentialthinking)
  - think -
    [Think Tool MCP Server](https://github.com/PhillipRt/think-mcp-server)
  - route
    - `/mcp/{server}/sse?apiKey={apiKey}`
- MCP Proxy Server
  - route
    - stdio:
      `/mcp/proxy/sse?apiKey={apiKey}&transport=stdio&command=&args=&env=`
    - sse: `/mcp/proxy/sse?apiKey={apiKey}&transport=sse&url=`
  - examples
    - [Sequential Thinking](https://github.com/modelcontextprotocol/servers/blob/main/src/sequentialthinking):
      `/mcp/proxy/sse?apiKey={apiKey}&transport=stdio&command=npx&args=-y @modelcontextprotocol/server-sequential-thinking&env={}`

---

## New Core Features (MCP Based)

`Doroseek` now includes several powerful MCP-based services for advanced use cases:

1.  **Intranet Penetration (Tunneling):** Expose local services to the internet.
2.  **Multi-User Communication Rooms:** Enable real-time communication between multiple clients.
3.  **Resource Sharing:** Upload and share small files or data snippets.

These features leverage WebSockets for real-time communication and Deno KV for persistence where applicable.

### 1. Intranet Penetration (Tunneling)

**Concept:**
This feature allows you to expose services running on your private network (e.g., a local development server, a database, or any TCP/HTTP service) to the public internet through a secure tunnel established with your `Doroseek` instance.

**Local Agent:**
To use this feature, a **local agent** (client software) must be run on the machine where the private services are accessible. `Doroseek` itself can also run in this "Agent Mode". For details on configuring and running `Doroseek` as a local agent, see the [Agent Mode](#agent-mode) section below. The agent is responsible for connecting to a remote `Doroseek` instance (acting as a relay), managing the tunnel, and forwarding traffic between the relay and the local services.

**Registration Process (Agent to Relay):**

1.  **Connection:** The local agent establishes a WebSocket connection to the `Doroseek` MCP server:
    ```
    wss://your-doroseek-instance/mcp/tunnel/register?apiKey=<your_api_key>
    ```
    An API key is mandatory for registration.

2.  **Registration Message:** After the WebSocket connection is established, the agent sends a `register` message. This message details the services it wishes to expose.
    *Example `register` message from agent:*
    ```json
    {
      "type": "register",
      "data": {
        "services": [
          { "type": "http", "local_port": 3000, "subdomain_or_path": "my-web-app" },
          { "type": "http", "local_port": 8080, "subdomain_or_path": "api-service" }
          // Other types like 'tcp' might be supported by the agent protocol in the future.
        ]
      }
    }
    ```

3.  **Server Response:** Upon successful registration, `Doroseek` responds with a `registered` message containing the unique `tunnelId` and the public base URL for accessing the tunneled services.
    *Example `registered` message from server:*
    ```json
    {
      "type": "registered",
      "data": {
        "tunnelId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
        "public_base_url": "https://your-doroseek-instance/t/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      }
    }
    ```

**Accessing Tunneled Services:**
Once the tunnel is established, your local services can be accessed via the public URLs derived from the `public_base_url` and the `subdomain_or_path` defined during registration. For example, if `your-doroseek-instance` is `example.com` and a service was registered with `subdomain_or_path: 'my-web-app'`, it might be accessible via:
```
https://example.com/t/<tunnelId>/my-web-app/...
```
The exact URL structure depends on how the public-facing routing (`/t/:tunnelId/...`) is configured to map to specific services.

**Local Agent Responsibilities (High-Level):**
*   Initiate and maintain the WebSocket connection to `/mcp/tunnel/register`.
*   Send the `register` message with service definitions.
*   Listen for `httpRequest` messages from `Doroseek` over the WebSocket. Each `httpRequest` message will contain:
    *   `requestId`: A unique ID for the request.
    *   `data`: An object with `method`, `path`, `headers`, and `body` of the incoming public request.
*   Upon receiving an `httpRequest`, the agent makes a corresponding request to its local service (e.g., `http://localhost:3000/some/path`).
*   Once the local service responds, the agent sends an `httpResponse` message back to `Doroseek` over the WebSocket, including the original `requestId` and the response details (status, headers, body).
*   (WebSocket proxying through the tunnel is planned for future enhancements but is currently stubbed in `Doroseek`'s public-facing tunnel route).

### 2. Multi-User Communication Rooms

**Concept:**
Enable real-time, bi-directional communication between multiple clients. This can be used as a backend for features like live chat in web applications, collaborative editing, or other multi-user interactive experiences.

**Connecting to a Room:**
Clients connect to a room using a WebSocket connection. The `roomId` is specified in the path.

*   **WebSocket Endpoint:**
    ```
    wss://your-doroseek-instance/mcp/room/:roomId?apiKey=<optional_api_key>
    ```
*   **Authentication:**
    *   **Anonymous Access:** Currently, clients can connect without an API key.
    *   **API Key Authenticated Access:** If an `apiKey` is provided in the query string, it is validated. This allows associating users with an API key owner if needed.

**Core Functionality:**

*   **Joining a Room:** A user joins a room by successfully establishing a WebSocket connection to the room's endpoint.
    *   On join, the server sends a `ServerRoomInfoMessage` to the joining user, containing a list of users already in the room.
    *   Other users in the room receive a `ServerUserJoinedMessage`.
*   **Leaving a Room:** When a user's WebSocket connection is closed, they are automatically removed from the room.
    *   Other users in the room receive a `ServerUserLeftMessage`.
*   **Sending Chat Messages:** Clients send chat messages over the WebSocket.
    *Example `ClientChatMessage` from client:*
    ```json
    {
      "type": "chatMessage",
      "payload": {
        "roomId": "your-target-room-id", // Though roomId is in path, can be in payload
        "message": "Hello everyone!"
      }
    }
    ```
*   **Receiving Messages:** Clients listen for messages from the server.
    *   `ServerChatMessage`: A chat message sent by another user in the room.
        ```json
        {
          "type": "chatMessage",
          "payload": {
            "roomId": "the-room-id",
            "fromUserId": "user-id-of-sender",
            "message": "Hello everyone!",
            "timestamp": "2023-01-01T12:00:00.000Z"
          }
        }
        ```
    *   `ServerUserJoinedMessage`: Notifies that a new user has joined.
    *   `ServerUserLeftMessage`: Notifies that a user has left.

**Conceptual Client-Side Interaction Example (JavaScript):**
```javascript
const roomId = "my-chat-room";
const apiKey = "your-optional-api-key"; // Or leave undefined for anonymous
const socket = new WebSocket(`wss://your-doroseek-instance/mcp/room/${roomId}?apiKey=${apiKey}`);

socket.onopen = () => {
  console.log("Connected to room:", roomId);
  // Send a chat message
  socket.send(JSON.stringify({
    type: "chatMessage",
    payload: { roomId, message: "Hi from client!" }
  }));
};

socket.onmessage = (event) => {
  const serverMessage = JSON.parse(event.data);
  console.log("Received message:", serverMessage);
  if (serverMessage.type === "chatMessage") {
    // Display chat: serverMessage.payload.fromUserId, serverMessage.payload.message
  } else if (serverMessage.type === "userJoined") {
    // Update user list
  } // etc.
};

socket.onclose = () => {
  console.log("Disconnected from room:", roomId);
};

socket.onerror = (error) => {
  console.error("WebSocket error:", error);
};
```

### 3. Resource Sharing

**Concept:**
Allows users to upload small files or data snippets (e.g., configuration files, JSON data, small images) to `Doroseek` and share them via a unique, publicly accessible URL.

**Upload Process (MCP WebSocket):**

1.  **Endpoint:** Connect via WebSocket to `/mcp/fileshare/upload`.
    ```
    wss://your-doroseek-instance/mcp/fileshare/upload?apiKey=<your_api_key>
    ```
    A valid API key is **required** for uploading files.

2.  **Message Flow:**
    *   **Client -> Server: `ClientInitiateUploadMessage`**
        The client first sends a message to initiate the upload, providing metadata about the file.
        ```json
        {
          "type": "initiateUpload",
          "payload": {
            "filename": "config.json",
            "filetype": "application/json",
            "size": 1024 // Size in bytes
          }
        }
        ```
    *   **Server -> Client: `ServerUploadReadyMessage`**
        If the server accepts the upload (e.g., size is within limits), it responds with a unique `resourceId`.
        ```json
        {
          "type": "uploadReady",
          "payload": {
            "resourceId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          }
        }
        ```
    *   **Client -> Server: `ClientFileDataMessage`**
        The client sends the actual file data, base64 encoded.
        ```json
        {
          "type": "fileData",
          "payload": {
            "resourceId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            "data": "eyJrZXkiOiAidmFsdWUifQ==" // Base64 encoded content of the file
          }
        }
        ```
    *   **Server -> Client: `ServerUploadCompleteMessage`**
        Upon successfully saving the file data, the server confirms completion and provides the download URL.
        ```json
        {
          "type": "uploadComplete",
          "payload": {
            "resourceId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            "downloadUrl": "https://your-doroseek-instance/shared/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
          }
        }
        ```

**Download Process (HTTP GET):**

*   **URL Format:** Files can be downloaded via a simple HTTP GET request to:
    ```
    https://your-doroseek-instance/shared/:resourceId
    ```
*   **Authentication:** By default, downloading does not require an API key. The link is publicly accessible if known.

**Limitations:**
*   **File Size Limit:** Currently, this feature is intended for **small files**. Due to the use of Deno KV as a backend for storing file data directly, individual file sizes are effectively limited to Deno KV's value size limit, which is typically around **60KB**. Uploads exceeding this will be rejected. Chunked uploading for larger files is a potential future enhancement.

## Running locally

This section describes running `Doroseek` in its default **Server Mode**. For running `Doroseek` as a local agent for the Tunneling feature, see the [Agent Mode](#agent-mode) section.

### Server Mode Configuration

copy .env.example to .env

```sh
# .env
ADMIN_KEY=the_admin_key_here
MCP_MAX_DURATION=60
```

By default, the project allows any key to create its corresponding settings, if
you need to restrict access to only a specific key, you need to set the
`ADMIN_KEY` environment variable.

The MCP SSE connection can keep `MCP_MAX_DURATION` second.

Set the db if needed

```ts
// services/database.ts
export const db = await Deno.openKv("./db");
```

### Running in Server Mode

To run the app in its default server mode, ensure `DOROSEEK_AGENT_MODE_ENABLED` is not set to `"true"`.
You will need to install Deno. Then run from the root of this repository:

```sh
deno task start
```

---

## Agent Mode (for Intranet Penetration)

`Doroseek` can also operate in **Agent Mode**. In this mode, it does not start the Fresh web server. Instead, it acts as a local client agent that connects to a remote `Doroseek` instance (acting as a relay server) to expose services from your private network to the internet.

This is an alternative running mode to its default server mode. When Agent Mode is enabled and configured correctly, `Doroseek` will exclusively perform agent duties.

### Agent Mode Configuration

To enable and configure Agent Mode, you need to set the following environment variables:

*   **`DOROSEEK_AGENT_MODE_ENABLED`**:
    *   Set to `"true"` to enable Agent Mode. If this is not set to `"true"`, `Doroseek` will attempt to start in Server Mode.

*   **`DOROSEEK_RELAY_URL`**:
    *   The WebSocket URL of the remote `Doroseek` instance (acting as the relay server) to which this agent should connect. This URL should point to the relay's tunnel registration endpoint.
    *   *Example:* `wss://your-remote-doroseek.com/mcp/tunnel/register`

*   **`DOROSEEK_AGENT_API_KEY`**:
    *   The API key that this agent will use to authenticate with the remote `Doroseek` relay server. This API key must be recognized and authorized by the relay server.

*   **`DOROSEEK_AGENT_SERVICES_JSON`**:
    *   A JSON string defining an array of local services that this agent should expose through the tunnel.
    *   Each service object in the array must have the following fields:
        *   `id` (string): A unique identifier for the service (chosen by you, e.g., "my-web").
        *   `name` (string): A user-friendly name for the service (e.g., "My Local Web Server").
        *   `type` (string): The type of service. Currently, only `"http"` is supported by the agent's HTTP handler.
        *   `local_host` (string): The hostname or IP address of the local service (e.g., `"localhost"`, `"127.0.0.1"`).
        *   `local_port` (number): The port number on which the local service is running (e.g., `8080`).
        *   `subdomainOrPath` (string): A string that will be used by the relay server to form the public URL for this service. It should not contain `/` or spaces. It effectively becomes a path segment on the relay's public tunnel URL.
            *   For example, if the relay provides a base URL like `https://<relay-public-domain>/t/<tunnelId>`, and you set `subdomainOrPath` to `"myweb"`, your service will be accessible at `https://<relay-public-domain>/t/<tunnelId>/myweb/...`.

    *   **Example `DOROSEEK_AGENT_SERVICES_JSON` value:**
        ```json
        [
          {
            "id": "web1",
            "name": "My Local Web Server",
            "type": "http",
            "local_host": "localhost",
            "local_port": 8080,
            "subdomainOrPath": "myweb"
          },
          {
            "id": "api2",
            "name": "Backend API",
            "type": "http",
            "local_host": "127.0.0.1",
            "local_port": 3000,
            "subdomainOrPath": "myapi"
          }
        ]
        ```
        To set this as an environment variable, the JSON string typically needs to be compact (no newlines) and properly escaped if set in certain shell environments. For example, in a `.env` file or shell:
        `DOROSEEK_AGENT_SERVICES_JSON='[{"id":"web1","name":"My Local Web Server","type":"http","local_host":"localhost","local_port":8080,"subdomainOrPath":"myweb"},{"id":"api2","name":"Backend API","type":"http","local_host":"127.0.0.1","local_port":3000,"subdomainOrPath":"myapi"}]'`

### Running in Agent Mode

1.  Set all the required environment variables listed above. Ensure `DOROSEEK_AGENT_MODE_ENABLED` is set to `"true"`.
2.  Run the application using the standard command:
    ```sh
    deno task start
    ```
3.  If the configuration is valid, `Doroseek` will start in Agent Mode. You will **not** see the usual Fresh server startup logs (e.g., "Listening on http://localhost:8000/").
4.  Instead, look for log messages indicating Agent Mode operation, such as:
    *   `[Main] Doroseek starting in Agent Mode.`
    *   `[Agent Config] Agent configuration loaded successfully.`
    *   `[Agent Connector] Initialized with Relay URL: wss://your-remote-doroseek.com/mcp/tunnel/register`
    *   `[Agent Connector] Attempting to connect to ...`
    *   `[Agent Connector] WebSocket connection established.`
    *   `[Agent Connector] Sent registration request: ...`
    *   `[Agent Connector] Successfully registered. Tunnel ID: <your-tunnel-id>, Public URL: <your-public-base-url>`
    *   `[Main] Agent is connected and registered with the relay.`
    *   `[Main] Tunnel ID: <your-tunnel-id>`
    *   `[Main] Public Base URL: <your-public-base-url>`
    *   `  - Service 'My Local Web Server' (web1) accessible via: <your-public-base-url>/myweb`
    *   `  - Service 'Backend API' (api2) accessible via: <your-public-base-url>/myapi`

### Interaction with the Relay (Agent Perspective)

*   The agent (this `Doroseek` instance running in Agent Mode) establishes a WebSocket connection to the `DOROSEEK_RELAY_URL`, which should be the `/mcp/tunnel/register` endpoint of a remote `Doroseek` instance running in Server Mode.
*   It sends a registration message detailing the local services defined in `DOROSEEK_AGENT_SERVICES_JSON`.
*   The remote relay server, upon successful registration, provides the agent with a unique `tunnelId` and a `public_base_url`.
*   Subsequently, when the relay server receives public HTTP requests matching the tunnel, it forwards these requests (as `httpRequest` messages) to the agent over the established WebSocket tunnel.
*   The agent processes these `httpRequest` messages, makes requests to the configured local services, and sends `httpResponse` messages back to the relay.
