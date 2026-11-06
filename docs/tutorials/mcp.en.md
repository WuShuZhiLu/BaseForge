# MCP Server installation and usage

> Connect Claude Code, Cursor, VS Code, and other MCP clients to BaseForge so they can search, read, and maintain notes within the permissions you grant.

[Back to tutorials](./README.md) · [简体中文](./mcp.md) · [Package README](../../packages/baseforge-mcp/README.md)

## What you need to know

- The MCP server is a **single file**: `packages/baseforge-mcp/dist/baseforge-mcp.mjs`, with all dependencies bundled in. No `npm install` is required to use it.
- Only two environment variables are needed: `BASEFORGE_URL` (BaseForge address) and `BASEFORGE_API_TOKEN` (Personal Access Token).
- Replace every `/absolute/path/...` placeholder with the real absolute path on your computer.
- When BaseForge runs on a NAS or another server, `BASEFORGE_URL` must be reachable from the computer running the AI client, for example `http://192.168.1.20:3001`.
- Permissions come entirely from the Token: create a dedicated restricted Token per AI client (limited notebooks, minimal scopes) and never store an administrator password in the MCP configuration.

## Five-minute setup

### 1. Verify the BaseForge server

Open the server from the same computer that runs your MCP client:

```text
http://192.168.1.20:3001
```

Use `http://localhost:3001` only when BaseForge runs on that same computer.

### 2. Check Node.js 20+

```bash
node --version
```

### 3. Create a Personal API Token

In BaseForge, go to `Settings → Personal Access Tokens → Create Token`:

1. Create one Token per AI client, e.g. "Claude Code" or "Cursor".
2. Enable only the scopes you actually need, e.g. `notes:read`, `notes:write`.
3. Choose "Limited notebooks" as the resource scope, set each notebook to read-only or read-write, and optionally include child notebooks.
4. Set a sensible expiration; revoke immediately if leaked.

Copy the Token, e.g. `nkn_xxxxxxxxxxxxxxxxx`. It is usually shown only once.

### 4. Configure the client

All clients point to the single file `packages/baseforge-mcp/dist/baseforge-mcp.mjs`:

#### Claude Code

```bash
claude mcp add baseforge --scope user \
  --env BASEFORGE_URL=http://192.168.1.20:3001 \
  --env BASEFORGE_API_TOKEN=nkn_xxx \
  -- node "C:\Users\YourName\Base-Notes\packages\baseforge-mcp\dist\baseforge-mcp.mjs"
```

#### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "baseforge": {
      "command": "node",
      "args": ["C:\\Users\\YourName\\Base-Notes\\packages\\baseforge-mcp\\dist\\baseforge-mcp.mjs"],
      "env": {
        "BASEFORGE_URL": "http://192.168.1.20:3001",
        "BASEFORGE_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

#### VS Code / GitHub Copilot (`.vscode/mcp.json`)

The top-level key is `servers`, not `mcpServers`:

```json
{
  "servers": {
    "baseforge": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\Users\\YourName\\Base-Notes\\packages\\baseforge-mcp\\dist\\baseforge-mcp.mjs"],
      "env": {
        "BASEFORGE_URL": "http://192.168.1.20:3001",
        "BASEFORGE_API_TOKEN": "nkn_xxx"
      }
    }
  }
}
```

#### Other clients

Any stdio-capable client uses the same structure: `command: node` + the absolute path of the single file + the two env vars. On Windows, `\` must be escaped as `\\`; on Linux/macOS, absolute paths must start with `/`.

Restart the client completely and confirm `baseforge` started in its MCP settings.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `BASEFORGE_URL` | BaseForge server address | `http://localhost:3001` |
| `BASEFORGE_API_TOKEN` | Personal API Token (required; startup fails with a clear error when missing) | — |

## Verification

After restarting the client, confirm `baseforge_list_notebooks` appears in the tool list, then run a read-only test:

```text
Please use the BaseForge MCP to list the notebooks I can access. Do not modify anything.
```

If reads succeed but writes fail, the Token scopes or notebook resource grants are insufficient — this is the intended security enforcement.

## Troubleshooting

### Missing BASEFORGE_API_TOKEN

Create a Token under `Settings → Personal Access Tokens` and put it into the client config's `env`.

### BASEFORGE_URL unreachable

- Same machine: `http://localhost:3001`.
- NAS: `http://<NAS-LAN-IP>:3001`.
- Verify the address in a browser on the client machine first.

### 401 or 403

- 401: Token wrong, expired, or revoked.
- 403: Token scopes or notebook resource grants denied the request. Fix the least-privilege configuration instead of using an administrator password.

### Tools do not appear

1. Confirm the absolute path of the single file exists (update it if the repository moved);
2. Fully restart the client;
3. Restart Server / Reset Cached Tools in the client.

## Security notes

- Effective permission = user ACL ∩ Token scopes ∩ Token notebook grants, all enforced server-side; a restricted Token cannot reach unauthorized notebooks even if MCP is bypassed and the REST API is called directly.
- Tokens appear in client config files; never commit Token-bearing `mcp.json` files to public repositories.
- Use one Token per Agent for easy revocation and auditing.

See [MCP Token notebook resource scope](./mcp-token-resource-scope.md) for the detailed authorization design.

## Next steps

- [OpenAPI guide](./api.md)
- [SDK tutorial](./sdk.md)
