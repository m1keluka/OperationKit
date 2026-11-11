# Connect Linear

Linear connects with sign-in (`auth_path: 'dcr_mcp'`) — this install registers itself
against Linear's own hosted MCP server (`mcp.linear.app`) the first time anyone clicks
Connect. There is no central Example app and nothing to pre-register: Linear's own docs
state the interactive flow "uses OAuth 2.1 with dynamic client registration" (verified
in
[`docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md`](../DCR-CIMD-VENDOR-VERIFICATION.md)),
so Command Center registers this install the moment it's needed and reuses that
registration afterward.

1. In Settings → Connectors → Linear, click **Connect Linear**.
2. Approve the request on Linear's own consent screen.

If registration or sign-in fails (network issue, or the vendor's support partially
changes), paste a Linear API key instead (Linear → Settings → API → Personal API keys),
as the token fallback. See `app/server/src/connectors/defs/linear.ts`.
