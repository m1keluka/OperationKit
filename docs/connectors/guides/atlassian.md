# Connect Atlassian (Jira, Confluence, Bitbucket)

**Status: catalog entry only — not yet connectable through Settings → Connectors.**

Atlassian's Rovo remote MCP server (`mcp.atlassian.com`) confirms OAuth 2.1 Dynamic
Client Registration (`registration_endpoint` present); CIMD support on that specific
issuer is **unconfirmed** — it is present on Atlassian's separate identity issuer
(`auth.atlassian.com`) but that does not guarantee it carries over
(`docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md`, obj 900505). Either way, driving
this needs the shared DCR client (Sprint 7.3), not built yet.

## What works today

No API-key fallback is documented for Rovo MCP, so there is currently no working
connect path for this integration — it is catalog-only. When Sprint 7.3 ships the DCR
client, re-verify CIMD support directly against `mcp.atlassian.com`'s own metadata
before wiring the connect flow (the verification doc explicitly flags this as
re-check-before-build).

See `app/server/src/connectors/defs/atlassian.ts` and
`app/server/src/connectors/lib/deferred-connector.ts`.
