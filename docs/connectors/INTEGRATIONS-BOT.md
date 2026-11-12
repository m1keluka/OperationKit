# Integrations: connected-only view, New Integration, and the Integrations bot

Objective #900682. Extends Sprint 7 (#900499, PR #681: the connector catalog and
its setup guides) and Sprint 7.8 (#900620, PR #713: connect any remote MCP
server). Nothing here re-implements either one.

## What the person sees

**Settings → Integrations** (`/settings/integrations`) lists **only what is connected**:

| Section | Source | "Connected" means |
|---|---|---|
| Accounts | `GET /api/connectors` | `status.state !== 'not_connected'` — an `error` account stays so its owner can fix or disconnect it |
| MCP servers | `GET /api/mcp-servers?workspace=` (#900620) | every server added to the workspace (a row only exists once someone connected it) |
| Built with the Integrations bot | `GET /api/integrations/builds?workspace=` | OperationKit Tools a bot scaffolded |

With nothing connected the page says so and offers **New Integration**.

**New Integration** (`?new=1`) offers two ways in:

1. **Browse integrations** (`?new=browse`) — everything not yet connected that has a guided setup:
   the #900499 catalog (each row shows its `docs/connectors/guides/<id>.md` guide), connected with
   the unchanged `ConnectorCard` (token form, OAuth sign-in, guided OAuth wizard, shared-app panel).
   Catalog entries that publish a remote MCP URL also get **Add as workspace MCP server**, which opens
   the unchanged 900620 `ConnectMcpServerDialog` pre-filled from the entry. **Any remote MCP server →
   Paste a URL** opens the same dialog empty.
2. **Make my own** (`?new=make`) — starts the Integrations bot.

The rule lives in one pure module: `app/client/src/components/connectors/integrationsView.ts`.

## The Integrations bot

"Make my own" posts `POST /api/integrations/builder {workspace, target?, docs?}` (signed-in admin).
The server files a normal board card, **Integrations bot: <target>**, registers it in
`integration_builder_cards`, and starts it (`startCreatedObjective`, the same create-and-start leg as
`POST /api/objectives {start:true}`). The browser goes straight to the card chat (`/o/<id>`). If the
session cap is hit, the card waits in the queue and the form says so.

The card's brief (`integrationBuilderBrief` in `app/server/src/services/integration-builder.ts`) makes
the session the bot:

1. **Ask** for whatever is missing — what to connect, a link to (or the text of) the API docs — then
   end the turn and wait for the reply in chat.
2. **Send the person to Browse** if the target already has a setup guide (the brief lists the catalog).
3. **Read the docs** and pick a path: a remote MCP server (preferred) or a plain REST API.
4. **Collect keys with the masked in-chat secret form**: `POST /api/objectives/:id/request-secret
   {name, reason, scope:"workspace"}` (#719065's request; companion card #900670 restyles the form —
   the request contract is unchanged). Never in a chat message. If `settings.session_secret_access` is
   off the request 404s and the brief tells the bot to ask for the key in Settings → Secrets instead.
5. **Build**:
   - MCP → `POST /api/integrations/builder/:id/detect` and `/mcp-server`. These call
     `detectResponse` / `connectMcpServer`, **extracted from** `routes/mcp-servers.ts` so the bot and the
     Settings dialog run the identical code (SSRF guard, server-side OAuth re-detect, credential under
     `CC_MCP_SERVER_<id>_*`). The bot passes `api_key_secret: "NAME"`; the server resolves the value from
     the card's **workspace** scope and never returns it. Sending `api_key` is a 400. OAuth servers are
     created `needs_auth`; the person presses **Sign in** on them in Settings.
   - REST → `POST /api/integrations/builder/:id/tool` → `okit new tool <name> --from-json -` with
     `kind: http-api` and `auth.secrets[].env` NAMES only (the Sprint 7.6 Tools-layer convention,
     [TOOLS-LAYER-WIRING.md](./TOOLS-LAYER-WIRING.md)). `dry_run: true` previews; exit 1 → 422, 2 → 409.
6. **Finish**: summarise what is connected and the secret NAMES, then end so the card goes to review.

Every success is recorded in `integration_builds` (`UNIQUE(workspace, kind, ref)`); disconnecting an
MCP server in Settings deletes its record.

## Who may call what

| Route | Caller |
|---|---|
| `POST /api/integrations/builder` | signed-in **admin** |
| `GET /api/integrations/builds?workspace=` | members of that workspace, or admin |
| `POST /api/integrations/builder/:id/{detect,mcp-server,tool}` | **only** card `:id`'s own `CC_SESSION_TOKEN`, or a signed-in admin |

A builder-route session token must be for that exact card, the card must be in
`integration_builder_cards` (a plain card's token gets 404), its **live** workspace must still be the
one the bot started in (moved → 403), and it must not be done/cancelled (409). The bot acts as the admin
who started it (audit `actorUserId`). `/api/integrations` is off the agent-key surface (agent-key-guard
default deny). Secrets: workspace scope only, and server-only names (`CC_MCP_SERVER_*`, service-only)
are refused.

Tests: `app/server/src/routes/integrations-builder.test.ts` (routes, confinement, no value in any
response), `app/client/src/components/settings/SettingsConnectors.test.tsx` and
`app/client/src/components/connectors/integrationsView.test.ts` (view rules + flows).
