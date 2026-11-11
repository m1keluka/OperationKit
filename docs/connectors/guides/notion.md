# Connect Notion

**Status: catalog entry only — not yet connectable through Settings → Connectors.**

Notion's `mcp.notion.com` supports OAuth 2.1 Dynamic Client Registration and Client ID
Metadata Documents, so in principle no developer-console app registration is ever
needed (verified directly against Notion's own OAuth metadata —
`docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md`, obj 900505). Driving that flow
needs a shared DCR client (`connectors/dcr-client.ts`, Sprint 7.3), which has not been
built yet — this card (Sprint 7.4) is scoped to the catalog entry, not that client.

## What works today

Notion also issues a plain **internal-integration MCP token** (Business/Enterprise
plans), which needs no OAuth at all:

1. In Notion, go to **Settings → Connections → Developer portal** and create a new
   **MCP token**.
2. Share the pages/databases agents need with that integration.
3. Store the token as a plain Settings → Secrets value (e.g. `NOTION_API_KEY` —
   already present in this workspace's secret set) and reference it from a Tool
   definition's `auth.secrets[].env`, the same way most non-Connectors integrations in
   this workspace already work.

Once Sprint 7.3 ships the DCR client, this connector can switch to the full OAuth
flow without changing its catalog identity (`id: 'notion'`).

See `app/server/src/connectors/defs/notion.ts` and
`app/server/src/connectors/lib/deferred-connector.ts`.
