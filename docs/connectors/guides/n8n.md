# Connect n8n

n8n connects with an API key and/or a workflow webhook URL
(`auth_path: 'api_key'`). n8n is treated here as an automation **target** agents can
call into — not a competing orchestrator for this app.

1. In n8n, go to **Settings → API** and create an API key. Copy it.
2. Note your n8n instance's base URL (e.g. `https://n8n.yourcompany.com`).
3. (Optional) if agents only need to trigger ONE workflow, copy that workflow's
   webhook URL instead of using the full API.
4. Paste the API key, base URL, and/or webhook URL into
   Settings → Connectors → n8n in this app.

See `app/server/src/connectors/defs/n8n.ts`.
