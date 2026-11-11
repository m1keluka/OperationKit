# Connect Discord

Discord connects with a guided, self-registered OAuth app
(`auth_path: 'oauth_guided'`).

1. Go to <https://discord.com/developers/applications> and create a new application.
2. Under **OAuth2 → General**, add this redirect URL:
   `https://<your-domain>/api/user/connector-oauth/discord/callback`
3. Copy the **Client ID** and (under **OAuth2 → Client information**) reset/copy the
   **Client Secret**.
4. In this app, go to Settings → Secrets and add:
   - `DISCORD_OAUTH_CLIENT_ID`
   - `DISCORD_OAUTH_CLIENT_SECRET`
5. Go to Settings → Connectors → Discord → **Add to Discord**, and authorize it for
   the server(s) agents should read/post in.

**Simpler fallback for server-side automation:** under **Bot**, create a bot user and
copy its **token**. A bot token can be stored as a plain Settings → Secrets value
(e.g. `DISCORD_BOT_TOKEN` — already present in this workspace's secret set) and used
directly by a Tool, without the OAuth round-trip above.

See `app/server/src/connectors/defs/discord.ts`.
