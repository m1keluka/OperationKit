# Connect Notion

Notion connects with sign-in (`auth_path: 'dcr_mcp'`) — this install registers itself
against Notion's own hosted MCP server (`mcp.notion.com`) the first time anyone clicks
Connect. There is no central Example app and nothing to pre-register: Notion's own
authorization server supports Dynamic Client Registration and Client ID Metadata
Documents (verified in
[`docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md`](../DCR-CIMD-VENDOR-VERIFICATION.md)),
so Command Center registers this install the moment it's needed and reuses that
registration afterward.

1. In Settings → Connectors → Notion, click **Connect Notion**.
2. Approve the request on Notion's own consent screen.

If registration or sign-in fails (network issue, or the vendor's support partially
changes), paste a Notion MCP token instead: in Notion, go to the developer portal and
create a **New MCP token** (Business/Enterprise plans only), then use it as the token
fallback. See `app/server/src/connectors/defs/notion.ts`.
