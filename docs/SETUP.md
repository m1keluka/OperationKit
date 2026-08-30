# Setup — from keys to a running board

This is the complete give-keys → running walkthrough for OperationKit V1. A competent
developer should get to a working board without any tribal knowledge. If anything here
is wrong or unclear, that's a bug — please [open an issue](../CONTRIBUTING.md).

There are two paths:

- **Recommended (hands-off):** the DigitalOcean installer — see
  **[DIGITALOCEAN.md](DIGITALOCEAN.md)**. It provisions the droplet, Docker, Caddy + TLS,
  and the whole stack for you. If you just want it running on a fresh cloud box, start there
  and come back to this doc only for the "first login" and "first objective" sections.
- **Manual (any Linux host / local):** everything below.

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|-------|
| Linux host | Ubuntu 24.04 is the tested target. Any modern Linux with Docker works for a manual run. |
| Docker Engine + Compose v2 | `docker --version` and `docker compose version` must both work. Install via [Docker's official repo](https://docs.docker.com/engine/install/). |
| ~4 GB RAM, 2 vCPU, 20 GB disk | Baseline for the three containers. More headroom if you run many concurrent agents. |
| A **Claude Code subscription** (Pro or Max) | **This is how agent sessions are powered — the recommended primary path.** You authenticate it into an account home via OAuth (no per-token API billing); see **[CLAUDE-CODE-AUTH.md](CLAUDE-CODE-AUTH.md)**. Add more subscriptions later for higher throughput. |
| `ANTHROPIC_API_KEY` (optional) | Powers only a small server-side summarizer, **not** the agent sessions (they unset it). Leave the placeholder if you don't need it. OpenAI/Gemini keys are also optional — see [CREDENTIALS.md](CREDENTIALS.md). |
| A domain + DNS (public deploys only) | Only if you want TLS via Caddy. Local runs work over `127.0.0.1` with no domain. |

> **Heads up — host paths (V1 rough edge).** The committed
> [`docker-compose.yml`](../docker-compose.yml) bind-mounts a set of workspace
> directories from `/home/operator/...` on the host into the container. The server reads
> these locations from environment variables with sane fallbacks
> ([`app/server/src/config.ts`](../app/server/src/config.ts): `PROJECTS_DIR`,
> `AI_WORKSPACE_DIR`, `SECOND_BRAIN_DIR`, `TRANSCRIPT_DIR`, `USER_HOME`, …). On your own
> box you'll either use the **DigitalOcean installer** (which creates those directories for you) or
> adjust the bind-mount paths in `docker-compose.yml` to real directories on your host
> and/or override the `*_DIR` env vars. This is one of the things V1 is actively
> smoothing out — see [CONTRIBUTING.md](../CONTRIBUTING.md) if you want to help.

### 1a. Any Debian/Ubuntu VPS (not just DigitalOcean)

Nothing in this guide is DigitalOcean-specific. [DIGITALOCEAN.md](DIGITALOCEAN.md) is a
convenience runbook for one provider; the steps below work on Hetzner, Vultr, Linode,
Scaleway, OVH, a bare-metal box, or a VM on your own hardware, as long as the host is a
recent Debian or Ubuntu with root/sudo.

Before you continue with step 2 on such a host:

1. **Create a non-root user** with sudo and log in as it — the stack expects a normal user
   home, not `/root`:
   ```bash
   adduser operator && usermod -aG sudo operator
   ```
2. **Install Docker Engine + Compose v2** from
   [Docker's official repo](https://docs.docker.com/engine/install/), then
   `usermod -aG docker operator` and re-login.
3. **Open only what you need.** Ports 80 and 443 if you are terminating TLS with Caddy;
   nothing else. The app binds to `127.0.0.1` by default — keep it that way.
   ```bash
   ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable
   ```
4. **Create the host directories** the compose file bind-mounts (the DigitalOcean
   installer does this for you; here you do it once):
   ```bash
   mkdir -p ~/data/operationkit ~/ai-workspace ~/second-brain ~/projects ~/transcripts
   ```
   If your username is not `operator`, either adjust the `/home/operator/...` paths in
   `docker-compose.yml` to your real home, or set `PROJECTS_DIR`, `AI_WORKSPACE_DIR`,
   `SECOND_BRAIN_DIR`, and `TRANSCRIPT_DIR` in `.env` to match — see the heads-up above.
5. **Point a DNS A record** at the host if you want TLS. Skip for a localhost-only run.

Then carry on from step 2. Everything after this point is provider-agnostic. The only
thing you give up versus the DigitalOcean path is `install.sh` doing steps 1–4 for you.

## 2. Clone the repo

```bash
git clone https://github.com/m1keluka/OperationKit.git
cd OperationKit
```

## 3. Create your `.env`

```bash
cp .env.example .env
```

`.env.example` contains the **seven core values** the stack cannot start without:

```dotenv
# LiteLLM
LITELLM_MASTER_KEY=sk-change-me-to-something-secure
LITELLM_SALT_KEY=sk-change-me-salt-key
POSTGRES_PASSWORD=change-me-db-password

# LLM Provider Keys (ALL OPTIONAL — agent sessions use your Claude subscription,
# not these. See docs/CLAUDE-CODE-AUTH.md. ANTHROPIC_API_KEY powers only the
# server-side summarizer; leave the placeholder to skip it.)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
GEMINI_API_KEY=AIza...

# OperationKit
CC_JWT_SECRET=change-me-to-a-random-string

# GPU Droplet (future, leave empty for now)
GPU_OLLAMA_URL=
```

Fill each value. **[docs/CREDENTIALS.md](CREDENTIALS.md) tells you exactly what each one
is, where to obtain it, and the minimum scopes to grant.** Two quick tips:

- Generate the secrets you invent yourself (`LITELLM_MASTER_KEY`, `LITELLM_SALT_KEY`,
  `POSTGRES_PASSWORD`, `CC_JWT_SECRET`) with something strong, e.g.:
  ```bash
  openssl rand -hex 32     # run once per secret
  ```
  `LITELLM_MASTER_KEY` conventionally starts with `sk-`.
- Leave `GPU_OLLAMA_URL` empty unless you're running a self-hosted Ollama model — the
  `code` routing group falls back to a hosted model when it's unset.

> Everything beyond these seven is **optional** and off by default (integrations like
> Supabase, Gmail, Telegram, Resend, and a long list of tuning flags). You do **not**
> need any of them for a first run. They're all catalogued in [CREDENTIALS.md](CREDENTIALS.md).

**Never commit `.env`** — it's git-ignored, and it holds live keys.

## 4. Start the stack

```bash
docker compose up -d
```

Compose brings the services up in dependency order: `litellm-db` (Postgres) →
`litellm` (proxy) → `command-center` (the app). First run pulls images and builds the
app container, so give it a few minutes.

Watch it come up:

```bash
docker compose ps
docker compose logs -f command-center
```

> **Authenticate a Claude subscription (required before any objective will run).**
> Agent sessions are powered by a Claude Pro/Max subscription, not by an API key. Once
> the stack is up, authenticate at least one account (`a`) — the quickest path is the
> helper:
> ```bash
> # Pass --home to match the bind-mount in docker-compose.yml
> ./scripts/claude-auth.sh a --home /home/operator/.ccuser-a
> # Headless / token-based auth:
> # ./scripts/claude-auth.sh a --setup-token --home /home/operator/.ccuser-a
> # For accounts b..e replace 'a' and '.ccuser-a' accordingly.
> # Manual hosts that remapped the compose bind-mount paths: adjust --home to match.
> ```
> Full details, scaling to multiple subscriptions, and manual methods are in
> **[CLAUDE-CODE-AUTH.md](CLAUDE-CODE-AUTH.md)**. No accounts authenticated ⇒ objectives
> queue but no session can start.

## 5. Health check

Both services expose the health endpoints Compose itself uses:

```bash
curl -f http://127.0.0.1:3002/api/health          # command-center → expect HTTP 200
curl -f http://127.0.0.1:4000/health/liveliness    # litellm proxy → expect HTTP 200
```

If `command-center` isn't healthy, check `docker compose logs command-center`. The most
common first-run causes are a missing/blank core value in `.env` or a bind-mount path
in `docker-compose.yml` that doesn't exist on your host (see the host-paths note in §1).

## 6. Seed the first user

The app ships with no users until you seed them:

```bash
docker compose exec command-center npm run seed
```

This creates an **admin** user `admin` / `changeme` (and a sample member user `ava`).
The seed script prints `Change passwords after first login!` — do exactly that.

## 7. Log in

Open **http://127.0.0.1:3002** in your browser (or `https://your-domain` if you set up
Caddy). Log in with:

- **Username:** `admin`
- **Password:** `changeme`

Then immediately change the password from the account/settings UI. Login issues a JWT
signed with your `CC_JWT_SECRET`; if you rotate that secret later, everyone is logged out.

## 8. Create your first workspace and objective

1. **Create a workspace.** A workspace scopes objectives, users, and (optionally)
   integration credentials to a project or team. As the admin you already have access to
   the seeded workspaces; create a new one for your own project from the board UI.
2. **Create an objective.** An objective is a unit of work you hand to the platform —
   a goal statement plus acceptance criteria. Give it a clear title and a concrete
   "done when…" description.
3. **Let it run.** The orchestrator decomposes the objective, spawns worker agent
   sessions, and moves the card across the board as work progresses through execution
   and review. Watch cost accrue against the objective's budget.

For deeper background on objective types and the planning model, see
[docs/PLANNING-AND-OBJECTIVE-TYPES.md](PLANNING-AND-OBJECTIVE-TYPES.md) and
[docs/terminology-glossary.md](terminology-glossary.md).

## 9. (Public deploys) put it behind TLS

For a real internet-facing deployment, the app ports stay bound to `127.0.0.1` and
**Caddy** on the host terminates TLS and reverse-proxies to `:3002`. The DigitalOcean
installer (`sudo ./install.sh`) installs Caddy, configures a firewall (ufw: 22/80/443),
and generates the Caddyfile for your domain — see [docs/DIGITALOCEAN.md](DIGITALOCEAN.md).
**Read [SECURITY.md](../SECURITY.md) before exposing the board.**

---

## Troubleshooting first-run

| Symptom | Likely cause / fix |
|---------|--------------------|
| `command-center` container restarts / unhealthy | Missing or blank core value in `.env`; run `docker compose logs command-center`. |
| Health check on `:3002` fails but container is up | Give it `start_period` (~15s) to boot; re-curl. Check the log for a bind-mount path error. |
| LLM calls fail with auth errors | Bad/absent provider key in `.env`. LiteLLM does **not** retry auth errors — fix the key and `docker compose restart litellm`. |
| Bind-mount / `no such file or directory` on start | A `/home/operator/...` path in `docker-compose.yml` doesn't exist on your host — create the directory, edit the path, or use the DigitalOcean installer which creates them automatically. |
| Can't log in after changing `CC_JWT_SECRET` | Expected — rotating the JWT secret invalidates existing tokens. Log in again. |

Still stuck? Open a **bug report** (see [.github/ISSUE_TEMPLATE](../.github/ISSUE_TEMPLATE)).
Onboarding friction is a first-class V1 bug — tell us where you got stuck.
