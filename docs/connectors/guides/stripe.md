# Connect Stripe

**Status: catalog entry only — not yet connectable through Settings → Connectors.**

Stripe's auth server technically advertises an OAuth 2.1 `registration_endpoint`
(DCR), but Stripe's own docs steer every first-party MCP client through named-client
tooling (`stripe agent setup`, or the Cursor/Claude Code/Codex/VS Code deep-link
configs) rather than a generic authorize/token pair
(`docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md`, obj 900505). Stripe's classic
**Connect** OAuth product is a different thing entirely — platform onboarding of a
merchant account — not what an agent reading its own account's data needs, so wiring
that here would build the wrong feature.

## What works today

Use a Stripe **Agent API key**, not a legacy secret/restricted key:

1. In the Stripe Dashboard, go to **Developers → API keys** and create an
   **Agent**-tagged key (required for autonomous/headless clients — Stripe stops
   accepting un-tagged keys for MCP access starting **2026-11-30**).
2. Store it as a plain Settings → Secrets value and reference it from a Tool
   definition's `auth.secrets[].env`.

See `app/server/src/connectors/defs/stripe.ts` and
`app/server/src/connectors/lib/deferred-connector.ts`.
