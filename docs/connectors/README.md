# Adding a connector

A connector links an outside account (GitHub, Google Workspace, Slack, Microsoft 365, an MCP
server…) to a person, so their agents can work in it. People manage them in
**Settings → Connectors**. How that page works for them is in
[You → Connectors](../product/04-you.md#connectors).

**One connector is one file.** Put it in `app/server/src/connectors/defs/` and default-export a
`ConnectorDefinition` (`app/server/src/connectors/types.ts`). The server finds every file in that
folder when it starts. There is no list to update, and the Settings page draws the card from what
the file describes — no client code.

## What the file provides

| Field | What it is |
| --- | --- |
| `id` | Stable name used in URLs and access rules, e.g. `slack`. Lower-case and dashes. Never change it once people have connected. |
| `name`, `description` | The card title and one plain sentence about what connecting lets agents do. |
| `products` | Optional parts it unlocks, shown as chips (Google Workspace lists Gmail, Calendar, Drive). |
| `connect` | Either `{ kind: 'token', fields: [...] }` (paste a key) or `{ kind: 'oauth', button_label }` (sign in on the provider's site). |
| `auth_path` | **Required.** One of `'dcr_mcp' \| 'oauth_guided' \| 'api_key' \| 'self_hosted_aggregator'` — which of the catalog's four UX flows this integration uses (Sprint 7 integrations proposal, PR #681, §3). Today's connectors map onto `connect.kind`: a `{ kind: 'token' }` connector is `'api_key'`, a `{ kind: 'oauth' }` connector this install owns is `'oauth_guided'`. `'dcr_mcp'` and `'self_hosted_aggregator'` are for later connectors that don't fit either shape yet — see the proposal before using them. |
| `setup_guide` | Optional path to a walkthrough, e.g. `docs/connectors/guides/github.md`. Omit until a guide exists; a stub is fine. |
| `mcp_url`, `oauth`, `api_key_fields` | Optional, informational extras for the matching `auth_path` (`dcr_mcp`, `oauth_guided`, `api_key` respectively) — see `app/server/src/connectors/types.ts`. None of these are read by any UI yet; a guided wizard is a later follow-up card. |
| `availability()` | Optional. Return `{ ok: false, reason }` when the server is not set up yet (for example a missing OAuth client). The card shows the reason instead of a connect button. |
| `status(ctx)` | Describe the person's connection: state, who it is connected as, a few label/value rows. **Never include the credential.** |
| `readCredential(ctx, use)` | Optional. The environment variables this connector contributes to a session. Call it only through `readConnectorCredential()` (`connectors/registry.ts`) — see "A connection belongs to one person" below. |
| `connectWithFields(ctx, fields)` | For token connectors: test the key, store it encrypted, return the new status. |
| `startOAuth(ctx)` | For sign-in connectors: return the provider URL to send the browser to. Your callback route stores the grant and redirects to `/settings/connectors`. |
| `check(ctx)` | Optional. Re-test a stored connection ("Check connection"). |
| `disconnect(ctx)` | Delete the stored credential, and revoke it at the provider when that is possible. |
| `order` | Optional sort position on the page. |

## Rules

- **Store credentials encrypted, server-side.** Use `encryptField` / `decryptField` from
  `app/server/src/services/crypto.ts`, the same as secrets.
- **Never return or log a credential.** `status()` is a description of a connection, not the
  connection. The API test in `routes/connectors.test.ts` checks the GitHub token never comes back;
  copy that check for your connector.
- **A connection belongs to one person, and that is checked for you.** Every read of a stored
  credential goes through `canUseConnectorCredential` (`app/server/src/services/connector-guard.ts`),
  which refuses unless the asking principal is the owner — or a key or session acting for the owner.
  **An administrator role grants nothing here**: administering the install is not the same as being
  every user. If your connector contributes anything to a session, implement `readCredential` and
  let `readConnectorCredential()` call it; the guard runs first and your function is simply never
  reached on a refusal. Do not read your own table from a spawn path.
- **Respect "Who can use it".** The same guard applies the person's own rules — which agents, which
  workspaces (`app/server/src/connectors/access.ts`), and whether work somebody else assigned to
  them may use the connection at all (off by default). No rule means allowed, so connections keep
  working until someone limits them.
- **Every refusal is on the record.** A withheld credential writes a `connector_access_log` row —
  who asked, whose connection, which connector, why, and the key's label when there was one. It
  never stores a value. Admins read the tail at `GET /api/secrets/connector-denials`.
- **Plain words.** The description and any error a person can see should make sense to someone
  who has never seen the code.

## Smallest example

```ts
// app/server/src/connectors/defs/slack.ts
import type { ConnectorDefinition } from '../types.js'
import { NOT_CONNECTED } from '../types.js'

const slack: ConnectorDefinition = {
  id: 'slack',
  name: 'Slack',
  description: 'Lets agents post updates to your channels.',
  auth_path: 'api_key',
  connect: {
    kind: 'token',
    fields: [{ key: 'token', label: 'Bot token', placeholder: 'xoxb-…', secret: true }],
  },
  status: ctx => NOT_CONNECTED,            // read your table here
  async connectWithFields(ctx, fields) {   // test + encrypt + store here
    return { ok: false, error: 'Not built yet.' }
  },
  async disconnect(ctx) {},                // delete your row here
}

export default slack
```

Restart the server (`self-deploy.sh backend`) and the card appears in Settings → Connectors.
