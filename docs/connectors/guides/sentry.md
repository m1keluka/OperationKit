# Connect Sentry

**Status: catalog entry only — not yet connectable through Settings → Connectors.**

Sentry's `mcp.sentry.dev` supports OAuth 2.1 Dynamic Client Registration and Client ID
Metadata Documents with no pre-registration step — Sentry's docs confirm "the first
connection will trigger an authentication flow"
(`docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md`, obj 900505). Driving that flow
needs the shared DCR client (Sprint 7.3), not built yet.

## What works today

The only documented fallback is Sentry's **CLI login**, which is a local/stdio MCP
mode, not applicable to this remote connector — so there is currently no working
connect path for this integration; it is catalog-only until Sprint 7.3 ships.

See `app/server/src/connectors/defs/sentry.ts` and
`app/server/src/connectors/lib/deferred-connector.ts`.
