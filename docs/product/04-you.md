# You

Settings → **You** is the identity page. It is not Secrets and it is not Dashboard seats.

## API key

Generate. Copy. Paste into Grok Bot or any agent as `Authorization: Bearer cc_live_…`. We show the full key **once**. Generate new to rotate (old key dies). Revoke to kill it.

## Connectors

Settings → **Connectors** is where you link the outside accounts agents work in for you. Each connector shows whether it is connected, as whom, and when it was last checked.

- **GitHub** — paste a fine-grained personal access token. Pull requests and commits on cards assigned to you use that login and email. **Check connection** re-tests it. Disconnecting here does not cancel the token on GitHub; do that there too.
- **Google Workspace** — **Sign in with Google** covers Gmail, Calendar and Drive (including Docs and Sheets). Sessions acting as you send email and work with files as that Google account. Disconnecting cancels the sign-in at Google.

**Who can use it.** Every connector has a "Who can use it" panel. Leave it on **All agents** / **All workspaces**, or pick specific ones. A session only receives the connection when it starts, and only if its agent and workspace are allowed. Picking none keeps the account connected but out of every session.

**What agents can see.** Nothing. Keys and sign-ins are stored encrypted on your server, shown back only as a summary (who it is, the last four characters), and handed to a session as an environment variable at start. No page or API returns the value.

When a card is assigned to someone, it uses the assignee's connections; the creator's are the fallback.

Adding a new kind of connector (Slack, Microsoft 365, an MCP server) is one file on the server — see [Adding a connector](../connectors/README.md).

## Personal secrets

Key/value, encrypted, never shown again. These are **yours**. Organization keys live on the Secrets tab. Both inject into the session env when a card starts. Connectors inject the same way. There is no Doppler CLI in the session.
