# Connect Airtable

Airtable connects with a personal access token (`auth_path: 'api_key'`).

1. Go to <https://airtable.com/create/tokens> and click **Create new token**.
2. Add the scopes agents need (e.g. `data.records:read`, `data.records:write`) and
   scope it to the specific base(s) they should touch — not every base you can see.
3. Copy the generated token.
4. Paste it into Settings → Connectors → Airtable → **Personal access token** in this
   app.

See `app/server/src/connectors/defs/airtable.ts`.
