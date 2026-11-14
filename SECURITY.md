# Security

OperationKit is **self-hosted, multi-tenant work infrastructure**. It runs AI coding agents as jobs on a machine you control, with workspace-level isolation between teams or business units. It is **not** a multi-tenant SaaS run by someone else. You run the instance, so you decide who shares it.

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
- Internal APIs (`/api/internal/*`): a request must be credentialled (`X-Internal-Secret` =
  `INTERNAL_API_SECRET`, or the scoped `OBJECTIVES_API_TOKEN`) **or** a genuine on-box caller
  (socket-based origin check; forwarding headers can only make a request less trusted). Set
  `INTERNAL_API_REQUIRE_SECRET=1` to drop the on-box allowance everywhere.
- Internal **board reads** (`GET /api/internal/objectives*`, `/strategies*`) additionally resolve an
  authenticated PRINCIPAL and authorize the rows (obj 900321): a card session presents the
  objective-scoped `X-CC-Session-Token` it is spawned with and is confined to its card's workspace,
  re-checking workspace AND user membership on every request; a sandboxed session peer with no token
  is refused even though it is network-local. `CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL=1` (or settings
  `internal_board_require_principal`) additionally withdraws the bare on-box allowance for those reads.
- Automatic knowledge-base retrieval (the spawn-prompt path) is **filtered** to the card's workspace,
  not merely boosted toward it, and the retrieved text is injected inside an untrusted-content frame.
- **Card browser lockdown** (obj 900024). The Chromium that review/QA sessions drive runs
  **non-root** (`ccuser`) with its **OS sandbox ON** — `--no-sandbox` is passed only on an
  explicit, logged operator opt-out. Its network egress goes through a loopback guard
  (`services/browser-egress-proxy.ts`) that Chromium is pointed at with `--proxy-server`, so
  **only allowed origins** are reachable: by default this install's own domain plus localhost
  (preview servers), and nothing else. Cloud instance metadata (`169.254.169.254` and
  friends) and the private network are refused by host **and** by resolved address, so an
  allowlisted name that resolves into them is still blocked (DNS rebinding / SSRF). The guard
  re-checks every redirect hop and pins DNS; Playwright's own `--allowed-origins` is passed
  too but is explicitly *not* a security boundary per its own documentation, so it is
  defence-in-depth, not the control. Playwright and `@playwright/mcp` are **pinned**
  (`lib/browser-pins.ts`, asserted against `app/Dockerfile` in CI) instead of resolving
  `@latest` at every spawn. Configure per install with `BROWSER_*` in `client.conf`;
  `install/verify.sh` check 9 proves sandbox-on, non-root, blocked-off-allowlist and
  allowed-still-works on the live install. See
  [docs/wiki/Card-Browser-Lockdown.md](docs/wiki/Card-Browser-Lockdown.md).
  Current pins: Playwright **1.65.0** → Chromium **158.0.8127.18**, `@playwright/mcp` **0.0.85**.
  **Update path:** bump `PLAYWRIGHT_VERSION` / `PLAYWRIGHT_MCP_VERSION` in `app/Dockerfile` and
  `app/server/src/lib/browser-pins.ts`, then `sudo bash install/update.sh --config client.conf`
  (rebuilds the image and prints the versions now running) and `install/verify.sh`. Step-by-step:
  [Updating the card browser](docs/wiki/Card-Browser-Lockdown.md#updating-the-card-browser).
- SSH for session git: `StrictHostKeyChecking=accept-new` and `IdentitiesOnly=yes`
- Workspace-scoped board APIs; WebSocket auth via the same cookie

## Production env

Set these before exposing the app. Compose maps `CC_JWT_SECRET` → `JWT_SECRET` inside the container.

| Variable | Required | Notes |
| --- | --- | --- |
| `CC_JWT_SECRET` / `JWT_SECRET` | yes | `openssl rand -base64 48` |
| `INTERNAL_API_SECRET` | yes in production | Credential for `/api/internal/*`. On its own it does NOT displace the on-box allowance — set `INTERNAL_API_REQUIRE_SECRET=1` for that |
| `GITHUB_WEBHOOK_SECRET` | if you use the GitHub webhook | HMAC-SHA256 |
| `UPTIMEROBOT_WEBHOOK_TOKEN` | recommended | Put `?token=…` on the UptimeRobot webhook URL. Unset = route stays open and the server logs a warning |
| `CORS_ORIGINS` | if your public origin is not the default | Comma-separated |
| `CARD_BROWSER_*` | no (safe defaults) | Card browser lockdown. `SANDBOX`/`EGRESS_GUARD` default on; `ALLOW_PRIVATE_NETWORK`/`ALLOW_METADATA` default off. Set from `client.conf` `BROWSER_*` by the installer — see [Card-Browser-Lockdown](docs/wiki/Card-Browser-Lockdown.md) |

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
7. Leave `BROWSER_SANDBOX` and the card browser egress guard on, and keep Playwright pinned to a release whose Chromium is at or above current Chrome stable (`install/update.sh` prints what you are running).

## Known gaps (documented, not hidden)

- Docker socket = host root
- The card browser is sandboxed and egress-restricted, but still shares the app container. Moving it to its own secret-free container is the structural fix and is not in this baseline
- The card browser may reach `localhost` by default (preview review needs it); set `BROWSER_ALLOW_LOOPBACK="off"` on installs that never preview locally
- Sibling OAuth homes in one container
- No MFA / SSO / passkeys
- Spawn env scoping for docker.sock / sibling homes is still the admin-only default
- UptimeRobot token is optional until you set it, because UR cannot HMAC
