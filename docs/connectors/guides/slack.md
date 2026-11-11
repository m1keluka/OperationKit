# Connect Slack

Slack connects with a guided, self-registered OAuth app (`auth_path: 'oauth_guided'`)
— there is no shared Example app, and Slack does not support dynamic client registration.

1. Go to <https://api.slack.com/apps> and click **Create New App → From scratch**.
2. Under **OAuth & Permissions**, add this redirect URL (replace with your install's
   own domain):
   `https://<your-domain>/api/user/connector-oauth/slack/callback`
3. Under **Scopes → Bot Token Scopes**, add at least `channels:read`,
   `channels:history`, `chat:write`, `users:read` (the connector requests these by
   default — add more there and in `connectors/defs/slack.ts` if agents need them).
4. Under **Basic Information**, copy the **Client ID** and **Client Secret**.
5. In this app, go to Settings → Secrets and add:
   - `SLACK_OAUTH_CLIENT_ID`
   - `SLACK_OAUTH_CLIENT_SECRET`
6. Go to Settings → Connectors → Slack → **Add to Slack**.

No container restart is needed — new sessions pick up the secret on spawn; an admin
signing in fresh picks it up on the next OAuth attempt. See
`app/server/src/connectors/defs/slack.ts` and
`app/server/src/connectors/lib/oauth-guided-connector.ts`.
