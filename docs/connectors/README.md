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
| `availability()` | Optional. Return `{ ok: false, reason }` when the server is not set up yet (for example a missing OAuth client). The card shows the reason instead of a connect button. |
| `status(ctx)` | Describe the person's connection: state, who it is connected as, a few label/value rows. **Never include the credential.** |
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
- **Respect "Who can use it".** If your connector hands something to sessions at start, ask
  `isConnectorAllowed('<id>', userId, { agent, workspace })` (`app/server/src/connectors/access.ts`)
  first, the way GitHub and Google do in `services/session-spawn-env.ts`. No rule means allowed, so
  connections keep working until someone limits them.
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
