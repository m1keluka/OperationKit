# Connect DocuSeal

DocuSeal connects with an API key (`auth_path: 'api_key'`), hosted or self-hosted.

1. In DocuSeal, go to **Settings → API** and generate a key. Copy it.
2. If you self-host DocuSeal, also note your instance's base URL.
3. Paste the API key — and the base URL, if self-hosted — into
   Settings → Connectors → DocuSeal in this app.

See `app/server/src/connectors/defs/docuseal.ts`.
