# Connect Intercom

Intercom connects with a guided, self-registered OAuth app
(`auth_path: 'oauth_guided'`).

1. Go to <https://app.intercom.com/a/developer-signup> (or your existing developer
   workspace) and create a new app.
2. Under **Authentication**, add this redirect URL:
   `https://<your-domain>/api/user/connector-oauth/intercom/callback`
3. Copy the **Client ID** and **Client Secret**.
4. In this app, go to Settings → Secrets and add:
   - `INTERCOM_OAUTH_CLIENT_ID`
   - `INTERCOM_OAUTH_CLIENT_SECRET`
5. Go to Settings → Connectors → Intercom → **Connect Intercom**.

**Simpler fallback for a single workspace:** Intercom also issues a long-lived
**access token** per app install (Developer Hub → your app → Authentication), which
can be stored as a plain Settings → Secrets value instead of going through OAuth.

See `app/server/src/connectors/defs/intercom.ts`.
