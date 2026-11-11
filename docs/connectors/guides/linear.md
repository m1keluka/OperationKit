# Connect Linear

**Status: catalog entry only — not yet connectable through Settings → Connectors.**

Linear's `mcp.linear.app` supports OAuth 2.1 Dynamic Client Registration and Client ID
Metadata Documents — Linear's own docs state "the interactive setup flow uses OAuth
2.1 with dynamic client registration" (verified directly,
`docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md`, obj 900505). Driving that flow
needs the shared DCR client (Sprint 7.3), not built yet.

## What works today

Linear also accepts a plain **bearer token / Linear API key**, no OAuth needed:

1. In Linear, go to **Settings → API → Personal API keys** and create a key.
2. Store it as a plain Settings → Secrets value and reference it from a Tool
   definition's `auth.secrets[].env`.

Once Sprint 7.3 ships the DCR client, this connector can switch to the full OAuth
flow without changing its catalog identity (`id: 'linear'`).

See `app/server/src/connectors/defs/linear.ts` and
`app/server/src/connectors/lib/deferred-connector.ts`.
