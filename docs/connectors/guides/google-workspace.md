# Connect Google Workspace

Google Workspace connects via sign-in (`auth_path: 'oauth_guided'`), through an
OAuth app this install owns.

1. Make sure the server has `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`
   configured (Settings → Secrets) — until then the connector shows as unavailable.
2. In Settings → Connectors → Google Workspace, click **Sign in with Google**.
3. Approve the requested scopes (Gmail, Calendar, Drive) on Google's consent screen.

See `app/server/src/connectors/defs/google-workspace.ts`.
