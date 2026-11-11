# Connect HubSpot

HubSpot connects with a guided, self-registered OAuth app
(`auth_path: 'oauth_guided'`).

1. Go to <https://developers.hubspot.com/get-started> and create a developer app
   under your own HubSpot account.
2. Under the app's **Auth** tab, add this redirect URL:
   `https://<your-domain>/api/user/connector-oauth/hubspot/callback`
3. Add scopes `crm.objects.contacts.read`, `crm.objects.contacts.write`,
   `crm.objects.deals.read`, `crm.objects.deals.write`.
4. Copy the app's **Client ID** and **Client secret**.
5. In this app, go to Settings → Secrets and add:
   - `HUBSPOT_OAUTH_CLIENT_ID`
   - `HUBSPOT_OAUTH_CLIENT_SECRET`
6. Go to Settings → Connectors → HubSpot → **Connect HubSpot**.

**Simpler fallback for a single-workspace install:** instead of the OAuth app above,
HubSpot also supports **Private App tokens** (Settings → Integrations → Private Apps
in your HubSpot account). A private-app token can be stored as a plain Settings →
Secrets value (e.g. `HUBSPOT_PRIVATE_APP_TOKEN`) and used directly by a Tool, without
going through this Connectors row at all — pick whichever is less setup for your
install.

See `app/server/src/connectors/defs/hubspot.ts`.
