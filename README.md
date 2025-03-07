# `Doroseek`

Access all your AI endpoints with the same base URL and API key. And you can
share the `Doroseek` API key with others to access the endpoints.

A simple app built with Deno and Fresh.

## Features

- Manage endpoints and API keys
- Generate `Doroseek` API keys
- Assign alias to models
- Global persistent data (settings) and real-time collaboration using Deno KV
- Sends updates (settings) from server to clients using EventSource (server-sent
  events)

## Running locally

### Configuration

By default, the project allows any key to create its corresponding settings, if
you need to restrict access to only a specific key, you need to set the
`ADMIN_KEY` environment variable

```sh
# .env
ADMIN_KEY=the_admin_key_here
```

Set the db if needed

```ts
// services/database.ts
export const db = await Deno.openKv("./db");
```

### Running

To run the app locally, you will need to install Deno. Then run from the root of
this repository:

```
deno task start
```
