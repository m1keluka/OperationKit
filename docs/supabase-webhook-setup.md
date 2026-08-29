# Supabase → Command Center Client Sync

Real-time sync from `example-platform` Supabase `public.clients` to the Command
Center SQLite mirror + the vault narrative at
`workspaces/example/clients/<slug>/profile.md`.

## Architecture

```
Supabase clients INSERT/UPDATE/DELETE
          │
          ▼ (HTTP POST, Supabase Database Webhook)
https://cc.example.com/api/webhooks/supabase
          │
          ├── upsert CC SQLite clients (match by supabase_id)
          ├── write workspaces/example/clients/<slug>/profile.md frontmatter
          └── broadcast `client_updated` via WebSocket
```

A nightly cron (`scripts/reconcile-clients.sh`, 00:05 America/New_York) repeats
the same POST for every active Supabase record, catching any webhook drops or
out-of-band DB edits. Drift is reported to
`~/second-brain/workspaces/example/daily/YYYY-MM-DD-reconcile.md`.

## Required secrets

Compose env wins; otherwise the native secrets store (Settings → Secrets). See
`docs/product/06-operating.md`.

| Var | Used by | Source |
|---|---|---|
| `SUPABASE_WEBHOOK_SECRET` | Webhook handler + reconcile script | docker-compose env (from host shell) |
| `SUPABASE_URL` | Reconcile script only | Settings → Secrets |
| `SUPABASE_SERVICE_KEY` | Reconcile script only | Settings → Secrets |

Generate the webhook secret once:

```bash
openssl rand -hex 32
```

Add it under Settings → Secrets **or** to `/home/operator/env-master/*.env` so
`docker-compose.yml` picks it up from the host shell. New sessions pick up
store keys on spawn; compose env needs a Node restart.

## Create the Supabase webhook

1. Log in to the `example-platform` Supabase project.
2. **Database → Webhooks → Create a new hook.**
3. Name: `command-center-clients-sync`.
4. Table: `public.clients`.
5. Events: check `Insert`, `Update`, `Delete`.
6. Type: **HTTP Request**.
7. Method: `POST`.
8. URL: `https://cc.example.com/api/webhooks/supabase`.
9. HTTP Headers — add two:
   - `Content-Type`: `application/json`
   - `x-webhook-secret`: _(the value you generated above)_
10. HTTP Params: leave empty.
11. Save.

Test immediately: edit any row in `public.clients` (e.g. toggle `status`) and
confirm the corresponding `workspaces/example/clients/<slug>/profile.md` frontmatter
updates within a few seconds.

## Manual test (no Supabase access)

```bash
# From the droplet (uses the same secret the webhook expects)
SECRET="$(doppler secrets get SUPABASE_WEBHOOK_SECRET --plain)"
curl -sS -X POST http://localhost:3002/api/webhooks/supabase \
  -H "Content-Type: application/json" \
  -H "x-webhook-secret: $SECRET" \
  -d '{
    "type": "UPDATE",
    "table": "clients",
    "schema": "public",
    "record": {
      "id": "00000000-0000-0000-0000-000000000001",
      "company_name": "Example4",
      "contact_email": "test@example4.com",
      "status": "active",
      "billing_type": "retainer",
      "monthly_amount": 5000
    },
    "old_record": null
  }'
```

Expected response:
```json
{ "ok": true, "type": "UPDATE", "cc_client_id": 42, "slug": "example4",
  "created": false, "vault_path": "/home/operator/second-brain/workspaces/example/clients/example4/profile.md",
  "vault_created": false }
```

## Install the nightly reconcile cron

```bash
bash /home/operator/projects/command-center-infra/scripts/install-reconcile-clients-cron.sh
```

This writes a cron entry that runs at 00:05 America/New_York. Manual trigger:

```bash
bash /home/operator/projects/command-center-infra/scripts/reconcile-clients.sh
```

Logs: `/home/operator/transcripts/reconcile-clients.cron.log` (rolling) and
`/home/operator/transcripts/reconcile-clients-YYYY-MM-DD.log` (per-run).
Reports:  `~/second-brain/workspaces/example/daily/YYYY-MM-DD-reconcile.md`.

## Field mapping

| Supabase `clients` | CC `clients` | Notes |
|---|---|---|
| `id` (uuid) | `supabase_id` | Stable join key |
| `company_name` | `name`, `slug` (slugified) | |
| `contact_email` | `email` | |
| `status` (`onboarding`/`active`/`inactive`) | `supabase_status`; `campaign_status` derives | `active` → `active`; everything else → `paused` |
| `billing_type` | `billing_type` | |
| `monthly_amount` | `monthly_amount` | |
| — | `last_synced_at` | ISO timestamp of this sync |

The vault profile.md frontmatter receives `supabase_id`, `cc_client_id`,
`name`, `status`, `billing_type`, `monthly_amount`, `contact_email`,
`last_synced_at`. The markdown body below the frontmatter is preserved on
every write.

## Example Project

`POST /api/webhooks/example-project` is stubbed; returns `501 Not Implemented`
until `example-project-platform` is ready. It expects a separate
`EXTRA_WEBHOOK_SECRET` so the two workspaces rotate secrets
independently.

## Troubleshooting

- **401 Invalid webhook secret** — Supabase is posting; the `x-webhook-secret`
  header doesn't match `SUPABASE_WEBHOOK_SECRET`. Compare exact values.
- **503 SUPABASE_WEBHOOK_SECRET not configured** — env var never reached the
  Node process. Verify: `docker exec command-center tsx /app/server/src/scripts/secrets-get.ts SUPABASE_WEBHOOK_SECRET >/dev/null && echo OK`.
- **Reconcile creates rows that a webhook already synced** — expected and
  harmless; the handler is idempotent on `supabase_id`.
- **CC row has `supabase_status=deleted`** — the nightly reconcile flagged a
  CC row whose `supabase_id` is gone from Supabase. Inspect the daily
  reconcile report for the slug; hard-delete manually if the removal was
  intentional.
