# Connect Supabase

Supabase connects with a personal or service-role access token
(`auth_path: 'api_key'`) — the same credential type this repo already uses for its
own Supabase deploys (see `SUPABASE_ACCESS_TOKEN` and `scripts/supabase-deploy.sh`),
scoped per person rather than shared.

1. Go to <https://supabase.com/dashboard/account/tokens> and create a new access
   token. Copy it.
2. (Optional) note a default project ref if agents mostly work in one project.
3. Paste the token — and the project ref, if set — into
   Settings → Connectors → Supabase in this app.

See `app/server/src/connectors/defs/supabase.ts`.
