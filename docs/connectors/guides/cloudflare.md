# Connect Cloudflare

Cloudflare connects with an API token (`auth_path: 'api_key'`) — no OAuth app needed.

1. Go to <https://dash.cloudflare.com/profile/api-tokens> and click **Create Token**.
2. Use a scoped template (e.g. **Edit zone DNS**) or build a custom token limited to
   exactly the zones/permissions agents need — avoid the all-zones "Global API Key".
3. Copy the generated token.
4. Paste it into Settings → Connectors → Cloudflare → **API token** in this app.

See `app/server/src/connectors/defs/cloudflare.ts`.
