# Telegram Rolodex Bot (Phase 5 Personal CRM)

A single-owner Telegram bot that lets Mike manage his contacts vault via chat. Runs as a sibling process inside the `command-center` container, spawned by the main server (`services/rolodex-supervisor.ts`).

## Architecture

```
Telegram → cc.example.com/telegram/rolodex
           → Caddy (unix//home/operator/projects/.cc-rolodex.sock)
           → this process (node:http on unix socket)
           → Anthropic Messages API (tool-use loop, system prompt = ~/ai-workspace/agents/rolodex.md)
           → tools call http://127.0.0.1:3002/api/internal/vault/*
           → contacts_index + vault markdown files
```

State is in the `rolodex_threads` SQLite table (one row per Telegram chat). The bot itself is stateless — restart safe.

## Files

- `index.ts` — the only source file. Webhook handler, Anthropic loop, tool dispatcher, Telegram client. Zero npm deps; uses only `node:*` builtins + `fetch`.
- `README.md` — this file.

The CC internal API endpoints used by the bot live in `app/server/src/routes/internal-vault.ts`.

## Deploy steps (one-time)

After the code changes ship in `mode=backend` (which restarts the server and starts the supervisor):

### 1. Add the secrets

Settings → Secrets (or compose env):

| Var | Value |
|-----|-------|
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/BotFather) → /newbot |
| `TELEGRAM_ROLODEX_OWNER_ID` | Mike's Telegram user ID (numeric, e.g. `123456789`). Get it from [@userinfobot](https://t.me/userinfobot). |

New sessions pick up store keys on spawn. Compose-only vars need a Node restart (`quick-deploy.sh backend`), not a container rebuild.

### 2. Deploy the Caddyfile change

The repo's `config/caddy/Caddyfile` now path-routes `/telegram/rolodex*` to the unix socket. Apply on the host:
```bash
sudo cp /home/operator/projects/command-center-infra/config/caddy/Caddyfile /etc/caddy/Caddyfile
sudo caddy reload --config /etc/caddy/Caddyfile
```

### 3. Register the webhook with Telegram

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'content-type: application/json' \
  -d '{"url":"https://cc.example.com/telegram/rolodex","drop_pending_updates":true}'
```

Verify it stuck:
```bash
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | jq
```

### 4. Smoke test

Open the bot in Telegram, send "hi". Owner gets the help text. A non-owner gets the polite refusal.

## Troubleshooting

**Bot is silent**
- Check container logs: `docker logs command-center | grep -E 'rolodex|supervisor'`
- Supervisor logs "disabled — TELEGRAM_BOT_TOKEN or TELEGRAM_ROLODEX_OWNER_ID not set" → step 1 didn't take.
- Supervisor spawns but sibling exits immediately → check `ANTHROPIC_API_KEY` is set in the container env.

**Caddy can't reach the socket (502 from Telegram side)**
- The socket file at `/home/operator/projects/.cc-rolodex.sock` must exist and be world-rw (0666). Owned by `root` (container runs as root by default).
- If your Caddy runs as a non-root user that can't open the socket, set `ROLODEX_LISTEN_PORT=3030` in Doppler instead. Then update the Caddyfile to `reverse_proxy localhost:3030` and add `127.0.0.1:3030:3030` to `docker-compose.yml`. That second change requires `docker compose up -d` (recreate, kills sessions).

**Wrong account on Telegram**
- Re-check `TELEGRAM_ROLODEX_OWNER_ID` — must be the numeric user ID, not the username.

**Want to disable temporarily**
- Unset `TELEGRAM_BOT_TOKEN` in Doppler and restart the container. The supervisor logs "disabled" and no sibling starts.
- Or: `curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook"` to silence inbound from Telegram's side without touching the server.

## Tunables (env vars)

| Var | Default | Notes |
|-----|---------|-------|
| `ROLODEX_MODEL` | `claude-sonnet-4-6` | Anthropic model. Swap to `claude-opus-4-7` for harder reasoning. |
| `ROLODEX_SOCKET_PATH` | `/home/operator/projects/.cc-rolodex.sock` | Where the bot listens. Must match the Caddyfile upstream. |
| `ROLODEX_LISTEN_PORT` | (unset) | If set, listen on TCP 127.0.0.1:PORT instead of the socket. |
| `ROLODEX_AGENT_FILE` | `/home/operator/ai-workspace/agents/rolodex.md` | System prompt path. Hot-reloaded on file mtime change. |
| `CC_API_BASE` | `http://127.0.0.1:3002` | CC internal API base for tool dispatch. |
