# Security

OperationKit is a **self-hosted, single-tenant operator tool**. It runs AI coding agents as jobs on a machine you control. It is **not** a multi-tenant SaaS.

If you would not give someone SSH on this host, do not give them a login that can spawn sessions.

## Threat model (honest)

| Assumption | What it means |
| --- | --- |
| Trusted operators | Anyone who can spawn a session is trusted with the host. Agent CLIs run with auto-approval (`--dangerously-skip-permissions` / Grok `--always-approve`). |
| Docker socket | The default compose file mounts `/var/run/docker.sock`. That is equivalent to host root. Do not onboard untrusted users onto the same instance. |
| Shared container | Claude/Codex/Grok home directories and host project mounts are visible inside the same container. Workspaces are a SQL filter, not a jail. |
| Disk trust | SQLite and session transcripts sit on disk. Encrypt the disk; there is no whole-database encryption. PATs, Google refresh tokens, and the secrets store use AES-256-GCM. |
| Single node | Login throttling and webhook dedupe are in-process. One Node process, one host. |

A later “PE diligence” pass is: dedicated tenant, MFA/SSO, socket-less member sessions, scoped spawn env, transcript encryption. None of that is this baseline.

## What this baseline does ship

- TLS at the edge (Caddy), HSTS, CSP, `X-Frame-Options: DENY`, `nosniff`, `Permissions-Policy`
- Express hides `X-Powered-By` and repeats those headers (so localhost / a stale Caddyfile still look respectable)
- httpOnly, `Secure` (production), `SameSite=strict` session cookies
- bcrypt passwords; missing-user 401s still run a dummy compare
- **No git-committed JWT fallback.** `JWT_SECRET` is required at boot (min 16 chars, not a placeholder)
- Login throttle: 10 failures / 15 min per IP+username, 30 / 15 min per IP
- GitHub webhook HMAC (`GITHUB_WEBHOOK_SECRET`)
- Optional UptimeRobot webhook token (`UPTIMEROBOT_WEBHOOK_TOKEN` as `?token=` on the webhook URL)
- Localhost-only internal APIs also require `INTERNAL_API_SECRET`
- SSH for session git: `StrictHostKeyChecking=accept-new` and `IdentitiesOnly=yes`
- Workspace-scoped board APIs; WebSocket auth via the same cookie

## Production env

Set these before exposing the app. Compose maps `CC_JWT_SECRET` → `JWT_SECRET` inside the container.

| Variable | Required | Notes |
| --- | --- | --- |
| `CC_JWT_SECRET` / `JWT_SECRET` | yes | `openssl rand -base64 48` |
| `INTERNAL_API_SECRET` | yes in production | Gates `/api/internal/*` even from localhost |
| `GITHUB_WEBHOOK_SECRET` | if you use the GitHub webhook | HMAC-SHA256 |
| `UPTIMEROBOT_WEBHOOK_TOKEN` | recommended | Put `?token=…` on the UptimeRobot webhook URL. Unset = route stays open and the server logs a warning |
| `CORS_ORIGINS` | if your public origin is not the default | Comma-separated |

See `.env.example`. Never commit `.env`.

## Reporting a vulnerability

Please **do not** open a public issue for an exploitable bug.

- GitHub: private vulnerability report on this repository
- Or email the maintainers listed on the repo

We will acknowledge, fix, and credit (unless you ask not to).

## Self-host checklist

1. Bind the app to localhost; put TLS in front (the Caddyfile in `config/caddy/` is the reference).
2. Generate `CC_JWT_SECRET` and `INTERNAL_API_SECRET`. Confirm the process will not boot without them.
3. Pre-populate `~/.ssh/known_hosts` on the host (`ssh-keyscan github.com`) — the `.ssh` mount is read-only, so `accept-new` cannot append.
4. Set `UPTIMEROBOT_WEBHOOK_TOKEN` and `GITHUB_WEBHOOK_SECRET` if those routes are reachable.
5. Change the seed password immediately (`changeme` in `app/server/src/db/seed.ts` is a first-boot default).
6. Do not publish the Docker socket to a network, and do not add untrusted session spawners.

## Known gaps (documented, not hidden)

- Docker socket = host root
- Sibling OAuth homes in one container
- No MFA / SSO / passkeys
- Spawn env scoping for docker.sock / sibling homes is still the admin-only default
- UptimeRobot token is optional until you set it, because UR cannot HMAC
