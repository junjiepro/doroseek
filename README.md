# `Doroseek`

A simple AI app built with Deno and Fresh.

1. Access all your OpenAI Compatible endpoints with the same base URL and API
   key. And you can share the `Doroseek` API key with others to access the
   endpoints.
2. As MCP server with several build-in server.

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
  - route
    - `/mcp/{server}/sse?apiKey={apiKey}`

## Running locally

### Configuration

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

### Running

To run the app locally, you will need to install Deno. Then run from the root of
this repository:

```sh
deno task start
```
