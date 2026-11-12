# MCP servers (Settings → Integrations)

Sprint 7.8 (obj 900620). An admin can connect any remote MCP server to a
workspace. Card sessions (Claude, Codex, Grok) and chat bots in that workspace
then get its tools. Nothing else on the platform sees it.

This builds on the Sprint 7 connector work and does not replace it. Catalog
entries come from the connector registry (`ConnectorDefinition.mcp_url`, 7.1 /
7.4). OAuth uses the existing DCR/CIMD client (`connectors/dcr-client.ts`,
7.3). Credentials live in the native secrets store.

## Connecting a server

Settings → Integrations → **New Integration** → **Browse integrations** → **Add as workspace MCP server**
(catalog entry) or **Any remote MCP server → Paste a URL** (obj 900682 moved the entry point; the dialog
is unchanged). The Integrations bot connects servers through the same code — see
[INTEGRATIONS-BOT.md](./INTEGRATIONS-BOT.md).

1. **Pick a source.** Paste a URL, or choose a catalog connector that publishes a
   remote MCP endpoint (Notion, Linear, Atlassian, Sentry, …).
2. **Detect authentication** (`POST /api/mcp-servers/detect`). The server sends
   an MCP `initialize` and reads the reply:
   - `200` → **no auth**.
   - `401` with `WWW-Authenticate: Bearer resource_metadata=…`, or with RFC 9728
     protected-resource metadata → **OAuth 2.1**. The authorization server's
     RFC 8414 metadata picks the registration method:
     - `client_id_metadata_document_supported` → **CIMD**: this install's
       client metadata document at `/api/mcp-servers/oauth/client-metadata`
       is the client ID.
     - otherwise `registration_endpoint` → **DCR** (RFC 7591).
     - neither → **guided**: the admin creates an OAuth app with the
       provider and pastes its client ID (and secret, if it has one). The
       dialog shows the redirect URI to register.
   - `401` with no OAuth metadata → **API key / bearer token**. The header
     name can be changed (default `Authorization: Bearer …`).
   The admin can override the detected method.
3. **Connect.** OAuth sends the browser to the provider and comes back to
   `/api/mcp-servers/oauth/callback`. PKCE and the `resource` parameter are
   always sent, and the state is signed and bound to the server row. Every other
   method is tested straight away.

**Test connection** (`POST /api/mcp-servers/:id/test`) runs `initialize`, then
`notifications/initialized`, then `tools/list` (paginated). It shows the server
name and version, the tool count, and each tool's name and description. Failures
are reported as one of `unreachable`, `blocked` (URL refused by the guard),
`auth_required`, `auth_failed`, `protocol` (not an MCP server / protocol
mismatch) or `server_error`, each with a plain-language message.

Transport: Streamable HTTP is tried first. JSON and `text/event-stream` replies
are both accepted, and `Mcp-Session-Id` is honoured. If the server answers
`POST` with 404/405, the client falls back to legacy HTTP+SSE (`GET` the event
stream, wait for the `endpoint` event, then `POST` to it). The transport that
worked is saved on the row and passed to sessions (`type: http` or `sse`).

## Scoping and permissions

- Each connection belongs to **one workspace** (`workspace_mcp_servers.workspace`).
  The dialog defaults to the workspace picked in the app.
- **Admin only** to add, change, test, sign in or remove (`requireAdmin`). Agent
  API keys and session tokens are refused, as on every other admin route. Any
  member of the workspace can list its servers. Nobody can list another
  workspace's servers (403).
- **Per-tool toggles:** turned-off tools are passed to Claude as
  `--disallowedTools mcp__<server>__<tool>`, to Codex/Grok as `disabled_tools`,
  and are left out of chat bots' tool lists.
- A server can be turned off without being removed.

## Where it is injected

| Consumer | How | Isolation |
|---|---|---|
| Card sessions (worker, follow-up, planner, reviewer, arena) | `buildSpawnEnv` → `spawnEnvFor(objective.workspace)` adds `CC_MCP_TOKEN_<id>` plus a descriptor that holds no secret. `spawnInTmux` writes it into the `--mcp-config` file. Header values are `${CC_MCP_TOKEN_<id>}` references, so **the config file holds no token**. Codex/Grok get the same data as TOML (`bearer_token_env_var` / `env_http_headers`). Jailed sessions get the file in their own HOME bind (`.cc/<session>.workspace-mcp.json`). | Keyed only on the card's workspace. A card with no workspace gets nothing. Platform entries (Playwright, Google Workspace) always win a name clash. |
| Chat bots | An agent file that lists `mcp` under `tools:` gets `mcp__<server>__<tool>` tools for the chat's workspace (`agent-chat/mcp-tools.ts`). | `callServerTool` re-checks the workspace on every call, so an invented tool name cannot reach another workspace's server. |
| Bot jobs | Run as cards, so they use the card path above. | Same. |

## Credentials

- All credentials are stored encrypted in the secrets store at the
  connection's workspace scope, under `CC_MCP_SERVER_<id>_*` keys. These
  include the API key, access and refresh tokens, and the DCR/guided client
  secret. `secrets-store.ts` treats that prefix as server-only: it is never
  bulk-injected into sessions and never served by the secrets broker.
- A session gets **only** the access token its config refers to. It never gets
  the refresh token or a client secret.
- API responses (`McpServerSummary`) have no field that can hold a value. They
  only report `has_credential`. Errors and logs carry no credential (asserted in
  `routes/mcp-servers.test.ts` and `services/workspace-mcp-servers.test.ts`).
- **Refresh:** a background tick (every 5 min, host instance only) refreshes
  OAuth access tokens that are close to expiry. Test and spawn also refresh on
  demand. A refresh that the server rejects sets status `needs_auth`, and the
  card shows **Needs sign-in** with a sign-in action.
- **Disconnect** deletes the row and every `CC_MCP_SERVER_<id>_*` secret. A
  session that is already running keeps its env until it respawns, the same as
  any rotated secret.

## URL safety (SSRF guard)

`mcp-servers/url-guard.ts` and `mcp-servers/safe-fetch.ts` apply to every
outbound request: detect, test, OAuth metadata, registration and token calls.

- Only `https:`. Plain `http:` is allowed only for loopback when
  `CC_MCP_ALLOW_LOCALHOST=1` or `NODE_ENV` is `development`/`test`.
- Credentials in the URL are rejected, and so are cloud metadata hostnames
  (`metadata.google.internal`, …).
- The hostname is resolved, and **every** address it resolves to is checked.
  Private (RFC 1918), CGNAT, link-local (including `169.254.169.254`),
  loopback, multicast, reserved and ULA ranges are refused, including IPv4
  addresses written in IPv6 form (`::ffff:a.b.c.d`). The check runs inside
  the socket's DNS `lookup` hook, so the address that is checked is the one
  that is dialled (no DNS-rebinding gap).
- Redirects are followed by hand, at most 3, and each hop is checked again;
  `Authorization` is dropped when a redirect leaves the origin. Response bodies
  are size-capped and every request has a timeout.

## Tests

- `mcp-servers/url-guard.test.ts`: URL validation and the SSRF guard.
- `mcp-servers/mcp-protocol.test.ts`: auth detection, `tools/list` parsing
  (pagination, malformed tools dropped), SSE framing.
- `services/workspace-mcp-servers.test.ts`: integration test against the local
  stub (`__fixtures__/stub-mcp-server.ts`) covering no-auth, bearer, OAuth
  (DCR, CIMD, guided), refresh, legacy SSE, storage redaction, workspace
  isolation, session config rendering and disconnect.
- `routes/mcp-servers.test.ts`: admin-only access, cross-workspace 403, no
  secrets in any response, and a real `buildSpawnEnv` showing that a card in
  workspace A does not get B's server.
- Screenshots: `tests/smoke/mcp-server-connect/`.
