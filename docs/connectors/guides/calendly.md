# Connect Calendly

Calendly connects with a personal access token (`auth_path: 'api_key'`).

1. Go to <https://calendly.com/integrations/api_webhooks> and under **Personal Access
   Tokens**, click **Create New Token**. Copy it.
2. (Optional, for verifying inbound booking webhooks) scroll to **Webhook
   Subscriptions**, create one, and copy the **signing key** it shows.
3. Paste the access token — and the signing key, if you created one — into
   Settings → Connectors → Calendly in this app.

See `app/server/src/connectors/defs/calendly.ts`.
