# Connect Microsoft 365

Microsoft 365 connects with a guided, self-registered Azure AD app
(`auth_path: 'oauth_guided'`) — this install's own app, no shared Example app.

1. Sign in to <https://portal.azure.com> and go to **Azure Active Directory → App
   registrations → New registration**.
2. Choose **Accounts in any organizational directory and personal Microsoft accounts**
   (or narrower, if you only want your own tenant).
3. Add this redirect URI (type: **Web**):
   `https://<your-domain>/api/user/connector-oauth/microsoft-365/callback`
4. Under **Certificates & secrets**, create a new client secret and copy its value
   immediately (it is shown once).
5. Under **API permissions**, add Microsoft Graph delegated permissions matching the
   connector's scopes: `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`,
   `Files.ReadWrite`, `offline_access`.
6. Copy the **Application (client) ID** from the Overview page.
7. In this app, go to Settings → Secrets and add:
   - `MICROSOFT_365_OAUTH_CLIENT_ID`
   - `MICROSOFT_365_OAUTH_CLIENT_SECRET`
8. Go to Settings → Connectors → Microsoft 365 → **Sign in with Microsoft**.

See `app/server/src/connectors/defs/microsoft-365.ts`.
