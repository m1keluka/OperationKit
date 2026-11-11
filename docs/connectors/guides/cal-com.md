# Connect Cal.com

Cal.com connects with an API key (`auth_path: 'api_key'`), hosted or self-hosted.

1. In Cal.com, go to **Settings → Developer → API keys** and create a new key. Copy
   it.
2. If you self-host Cal.com, also note your instance's base URL (e.g.
   `https://cal.yourcompany.com/api`).
3. Paste the API key — and the base URL, if self-hosted — into
   Settings → Connectors → Cal.com in this app.

See `app/server/src/connectors/defs/cal-com.ts`.
