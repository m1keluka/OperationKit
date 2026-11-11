# Connect ClickUp

ClickUp connects with a personal API token (`auth_path: 'api_key'`).

1. In ClickUp, go to **Settings → Apps** and copy your personal **API Token** (starts
   with `pk_`).
2. Paste it into Settings → Connectors → ClickUp → **API token** in this app.

A personal token carries that person's own permissions — agents can only reach the
spaces/lists the connecting account can.

See `app/server/src/connectors/defs/clickup.ts`.
