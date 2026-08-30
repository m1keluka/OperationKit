# Credentials & environment reference

Every credential and environment variable OperationKit reads, what it's for, where to
get it, and the minimum scope to grant. **You only need the seven core values in
[§1](#1-core-credentials-required) to run.** Everything else is optional and off by
default.

Two kinds of "secret" appear here:
- **Secrets you invent** (master keys, DB password, JWT secret) — generate strong random
  values, e.g. `openssl rand -hex 32`.
- **Secrets you obtain** (provider API keys, integration tokens) — created in a third-party
  dashboard; grant the *minimum* scope listed.

> **Verification.** Every variable in this doc appears in the real codebase. It was
> enumerated with
> `grep -rhoE "process\.env\.[A-Z0-9_]+" app/` plus the provider keys in
> [`docker-compose.yml`](../docker-compose.yml) and
> [`.env.example`](../.env.example). Tuning flags with safe defaults are catalogued in
> [`app/server/src/config.ts`](../app/server/src/config.ts). Nothing here is invented.

---

## 0. Secret management: `.env` is the primary path

**You do not need Doppler, Vault, or any secrets manager to run OperationKit.**

- **`.env` is the supported, primary path.** Copy `.env.example` to `.env`, fill in the
  core values, and `docker compose up -d`. Everything in this document can be supplied
  that way. Compose env wins wherever both sources define a variable.
- **The native secrets store** (Settings → Secrets in the app) covers integration
  credentials you would rather not keep in a file on disk. Values there are encrypted at
  rest with AES-256-GCM and hydrated at boot for variables not already set by compose.
- **[Doppler](https://doppler.com) is optional.** A few example scripts in `scripts/` and
  `app/server/scripts/` (for example `provision-scoped-doppler-tokens.ts`) assume a
  Doppler account and simply do nothing useful without one. That is expected: they are
  conveniences for operators who already use Doppler, not a requirement. If you do not
  have an account, ignore those scripts and the `DOPPLER_*` /
  `USE_SCOPED_DOPPLER_TOKENS` variables entirely — no feature in the default stack
  depends on them.

Whichever you pick: never commit `.env`, and rotate anything that has been in a shell
history or a screenshot.

---

## 1. Core credentials (REQUIRED)

> **What powers the agents is NOT in this table.** OperationKit's agent sessions are
> powered by a **Claude Code subscription** (Claude Pro/Max), authenticated per account
> via OAuth — see **[CLAUDE-CODE-AUTH.md](CLAUDE-CODE-AUTH.md)**. It is not an `.env`
> variable; sessions explicitly *unset* `ANTHROPIC_API_KEY` at spawn
> ([`session-manager.ts`](../app/server/src/services/session-manager.ts)). The provider
> **API keys** below are all **optional** and only power server-side helpers.

These are the values in [`.env.example`](../.env.example). The stack will not
start correctly without the invent-your-own secrets; the provider API keys
(`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`) are optional — see notes.

| Variable | Required | What it's for | Where to get it / how to set | Minimum scope | Default |
|----------|----------|---------------|------------------------------|---------------|---------|
| `ANTHROPIC_API_KEY` | ❌ Optional | **Not used by agent sessions** (they unset it — they use your Claude subscription instead; see [CLAUDE-CODE-AUTH.md](CLAUDE-CODE-AUTH.md)). Powers only the server-side session-intel summarizer (direct Anthropic Messages API) and, if you run the legacy LiteLLM proxy, its Anthropic model groups. Leave the placeholder to skip. | [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key. | A standard API key with model access + billing enabled. | placeholder ok |
| `GEMINI_API_KEY` | ⚠️ For default config | Google Gemini. Primary model of the `research` routing group (`gemini-2.0-flash`). | [Google AI Studio](https://aistudio.google.com/apikey) → Create API key. | API key with Generative Language API enabled. | — (set, or remove the Gemini entry from `config.yaml`) |
| `OPENAI_API_KEY` | ⚠️ Pass-through | Passed to the LiteLLM proxy so you can add OpenAI models. **Not referenced by the default `config.yaml` routing** — you can leave it as a placeholder if you don't add OpenAI models. | [platform.openai.com/api-keys](https://platform.openai.com/api-keys). | API key with model access. | placeholder ok |
| `LITELLM_MASTER_KEY` | ✅ **Yes** | Admin/API key for the LiteLLM proxy (`general_settings.master_key`). Anything calling the proxy authenticates with it. | **You invent it.** `openssl rand -hex 32`; conventionally prefix `sk-`. | n/a (self-generated) | — (must set) |
| `LITELLM_SALT_KEY` | ✅ **Yes** | Salt LiteLLM uses to encrypt provider keys it stores in its DB. **Do not change after first run** or stored keys can't be decrypted. | **You invent it.** `openssl rand -hex 32`. | n/a | — (must set) |
| `POSTGRES_PASSWORD` | ✅ **Yes** | Password for the `litellm-db` Postgres 16 instance; used in LiteLLM's `DATABASE_URL`. | **You invent it.** `openssl rand -hex 32`. | n/a | — (must set) |
| `CC_JWT_SECRET` | ✅ **Yes** | Signs the JWTs the command-center issues on login (`JWT_SECRET` inside the container). Rotating it logs everyone out. | **You invent it.** `openssl rand -hex 32`. | n/a | — (must set) |
| `GPU_OLLAMA_URL` | ❌ Optional | Base URL of a self-hosted [Ollama](https://ollama.com) server for the `code` group's local model. Empty ⇒ that group falls back to a hosted model. | Your Ollama host, e.g. `http://ollama:11434`. | n/a | empty |

## 2. Advanced integration credentials (OPTIONAL)

None of these are needed for a working install. They enable specific integrations and
are **disabled/blank by default**. Several are Example-internal integrations that most
self-hosters will never enable — clearly noted below. Set only the ones for features you
actually use.

### 2a. Data / auth integration — Supabase
| Variable | What it's for | Where to get it | Minimum scope | Default |
|----------|---------------|-----------------|---------------|---------|
| `SUPABASE_URL` | Base URL of your Supabase project (for integrations that read/write Supabase). | Supabase dashboard → Project Settings → API → Project URL. | Read-only URL, no secret. | unset |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase access for integration features. **Full-access key — treat as a root secret.** | Supabase → Project Settings → API → `service_role` key. | Grant only if you use Supabase-backed features; prefer scoped keys where possible. | unset |
| `SUPABASE_ACCESS_TOKEN` | Supabase **Management API** token (project/schema ops for advanced automation). Org-wide by default. | Supabase → Account → Access Tokens. | A personal access token scoped to the one project you use. | unset |

### 2b. Source control / webhooks
| Variable | What it's for | Where to get it | Minimum scope | Default |
|----------|---------------|-----------------|---------------|---------|
| `GITHUB_WEBHOOK_SECRET` | Verifies inbound GitHub webhook signatures (PR/CI events). | GitHub repo → Settings → Webhooks → set a secret; use the same string here. | Just a shared secret string you choose. | unset |
| `SUPABASE_WEBHOOK_SECRET` | Verifies inbound Supabase webhooks. Passed through in `docker-compose.yml` (defaults empty). | You set it on both the Supabase webhook and here. | Shared secret string. | empty |
| `EXAMPLE_PROJECT_WEBHOOK_SECRET` | **Example-internal.** Verifies a specific partner webhook. Ignore unless you run that integration. | Internal. | Shared secret string. | empty |

### 2c. Google / Gmail (OAuth)
| Variable | What it's for | Where to get it | Minimum scope | Default |
|----------|---------------|-----------------|---------------|---------|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client for Google sign-in / Google API access. | [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials → OAuth client ID (Web). | OAuth client; add only the scopes the feature needs. | unset |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Secret paired with the OAuth client above. | Same screen as the client ID. | n/a | unset |
| `GMAIL_CLIENT_ID` | OAuth client used specifically for Gmail integration. | Google Cloud Console (as above); enable the Gmail API. | Minimum Gmail scopes for the feature (e.g. read-only if you only read). | unset |

### 2d. Email delivery & alerting — Resend
| Variable | What it's for | Where to get it | Minimum scope | Default |
|----------|---------------|-----------------|---------------|---------|
| `RESEND_API_KEY` | Sends transactional email / alerts via [Resend](https://resend.com). | Resend dashboard → API Keys. | **Sending** permission only; single verified domain. | unset |
| `ALERTS_ENABLED` | Master on/off for the alerting subsystem. | Set `true`/`1` to enable. | n/a | off |
| `ALERTS_FROM_EMAIL` | From-address for alert emails. | An address on your Resend-verified domain. | n/a | unset |
| `ALERTS_TO_EMAIL` | Where alerts are sent. | Your inbox. | n/a | unset |
| `ALERTS_API_TOKEN` | Bearer token protecting the internal alerts endpoint. | **You invent it.** `openssl rand -hex 32`. | n/a | unset |

### 2e. Messaging & meeting integrations
| Variable | What it's for | Where to get it | Minimum scope | Default |
|----------|---------------|-----------------|---------------|---------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot for notifications/agent chat. | Telegram [@BotFather](https://t.me/BotFather) → `/newbot`. | Bot token only. | unset |
| `TELEGRAM_ROLODEX_OWNER_ID` | Telegram user ID allowed to talk to the bot. | Your numeric Telegram ID (e.g. via @userinfobot). | n/a | unset |
| `MENTOR_TELEGRAM_OWNER_USERNAME` | Owner username for the mentor Telegram path. | Your Telegram @username. | n/a | unset |
| `GRANOLA_API_KEY` | Pulls meeting notes from [Granola](https://granola.ai). | Granola account settings / API access. | Read access to your notes. | unset |
| `GRANOLA_WORKSPACE` | Which Granola workspace to read. | Granola workspace slug/ID. | n/a | unset |

### 2f. Monitoring & internal service tokens
| Variable | What it's for | Where to get it | Minimum scope | Default |
|----------|---------------|-----------------|---------------|---------|
| `UPTIMEROBOT_API_KEY` | Reads uptime status from [UptimeRobot](https://uptimerobot.com). | UptimeRobot → My Settings → API. | **Read-only** monitor-specific key. | unset |
| `SECRETS_MASTER_KEY` | Encryption key for the native scoped-secrets store (`USE_SCOPED_SECRETS`, off by default). Only needed if you migrate off the default secret model. | **You invent it.** `openssl rand -hex 32`. | n/a | unset |
| `TEST_CRED_ENCRYPTION_KEY` | Encrypts stored test credentials used by verification flows. | **You invent it.** | n/a | unset |
| `INTERNAL_API_SECRET` | Shared secret for server-to-server internal API calls. | **You invent it.** | n/a | unset |
| `MENTOR_SERVICE_TOKEN` | Auth token for the mentor service path. | **You invent it.** | n/a | unset |
| `CHANGELOG_TOKEN` | Protects the changelog publishing endpoint. | **You invent it.** | n/a | unset |
| `CHANGELOG_PUBLIC` | Whether the changelog is publicly readable. | `true`/`false`. | n/a | off |

### 2g. Doppler (optional secrets manager — mounted, not an env var)
OperationKit can source secrets (e.g. `SUPABASE_SERVICE_KEY`) at process start via
[Doppler](https://doppler.com) instead of the `.env` file. This is **not** a plain env
var: a Doppler **service token** is written to `~/.doppler/.doppler.yaml` on the host and
mounted read-only into the container, where `doppler run --` injects the managed vars.
The host-side setup is covered by [`install.sh`](../install.sh). For a normal self-host you
can ignore Doppler entirely and use `.env`.
Provision that token yourself on the host if you want it; `./install.sh` does not.
For a normal self-host you can ignore Doppler entirely and use `.env`.

## 3. Operational / tuning env vars (NOT credentials)

These control behavior, budgets, and feature gates. **All have safe defaults** — you do
not set them to run OperationKit. They are defined and documented inline in
[`app/server/src/config.ts`](../app/server/src/config.ts). Change them only when you know
you want to. Grouped by purpose:

- **Paths** (override the Operator-host defaults in `docker-compose.yml`): `PROJECTS_DIR`,
  `AI_WORKSPACE_DIR`, `SECOND_BRAIN_DIR`, `TRANSCRIPT_DIR`, `ASSISTANT_DIR`, `USER_HOME`,
  `CC_REPO_DIR`, `DB_PATH`, `CC_OBJ_MEMORY_BASE`, `OBJ_SNAPSHOT_DIR`, `DESIGN_REGISTRY_FILE`,
  `SECOND_BRAIN_ROOT`, `VAULT_PATH`, `VAULT_UID`, `VAULT_GID`.
- **Server**: `PORT` (default 3002), `NODE_ENV`, `CORS_ORIGINS`, `CC_API_BASE`, `HARNESS_REPO`.
- **Spawn / runaway caps**: `SPAWN_MAX_TURNS` (150), `MAX_TURNS_AUTO_CONTINUE` (3),
  `SPAWN_MAX_OUTPUT_TOKENS` (32000), `WATCHDOG_IDLE_FORCE_MS`, `WATCHDOG_WALLCLOCK_MS`,
  `DELEGATOR_BACKSTOP_MS`.
- **Budgets / ceilings**: `OBJECTIVE_CEILING_NORMAL_USD`, `OBJECTIVE_CEILING_HIGH_USD`,
  `OBJECTIVE_CEILING_ULTRACODE_USD`, `STRATEGY_CEILING_*_USD`, `STRATEGY_MAX_PROJECTS`.
- **Session mining / strategy promotion**: `SESSION_MINING_MIN_RECURRENCE` (3),
  `SESSION_MINING_LOOKBACK_DAYS` (30), `SESSION_MINING_MAX_SURFACED` (5), `CC_STRATEGY_TIER`,
  `STRATEGY_PROMOTE_01_*`, `STRATEGY_PROMOTE_12_*`, `STRATEGY_PROMOTE_23_*`.
- **Feature gates (default OFF)**: `CC_ARENA_ENABLED`, `CC_CANARY_HARNESS_ENABLED`/`_KILLED`,
  `CC_KITCHEN_LOOP_ENABLED`/`_KILLED`/`_REVIEW_ENFORCE`, `CC_UAT_GATE_ENABLED`/`_BLOCKING`/`_KILLED`,
  `DREAM_CYCLE_ENABLED`, `JARVIS_NUDGE_ENABLED`.
- **UI / preview / outcome gates**: `UI_GATE_MODE`, `UI_GATE_FILE`, `UI_CONFORMANCE_SCRIPT`,
  `PREVIEW_BASE_URL`, `PREVIEW_SPOOL_DIR`, `PREVIEW_SPOOL_RUNNER`, `PREVIEW_SPOOL_RUN_AS`,
  `PREVIEW_SPOOL_HOST_KICK`, `PREVIEW_SPOOL_KICK_IMAGE`, `OUTCOME_MARKER`, `OUTCOME_ARTIFACT`,
  `OUTCOME_DATA`, `OUTCOME_MIN_BYTES`, `OUTCOME_MIN_ROWS`.
- **Local models / rolodex / triage**: `OLLAMA_URL`, `OLLAMA_MODEL`, `TRIAGE_MODEL`,
  `ROLODEX_MODEL`, `ROLODEX_AGENT_FILE`, `ROLODEX_LISTEN_PORT`, `ROLODEX_SOCKET_PATH`.
- **Spawn-env scoping cutover flags (Operator-gated, keep OFF)**: `USE_SCOPED_DOPPLER_TOKENS`,
  `SCOPE_SUPABASE_ACCESS_TOKEN`, `USE_SCOPED_SECRETS`, `PROVISION_SCOPED_DOPPLER_COMMIT`.
  These are irreversible migration switches documented in the in-repo cutover runbooks;
  do **not** flip them without reading those. Leaving them unset = current, correct behavior.

> If a var here isn't obvious from its name, its authoritative definition (with a comment)
> is in `app/server/src/config.ts`. When in doubt, leave it unset.

## 4. Golden rules

- **Never commit `.env`.** It's git-ignored for a reason.
- **Rotate the secrets you invent** if a box is ever compromised — especially
  `CC_JWT_SECRET`, `LITELLM_MASTER_KEY`, and `POSTGRES_PASSWORD`.
- **Grant least privilege** on every obtained key: read-only where reading is all a
  feature does, single-project/single-domain scoping where the provider allows it.
- **`LITELLM_SALT_KEY` is write-once** — changing it after first run orphans encrypted
  provider keys in LiteLLM's DB.
- Read **[SECURITY.md](../SECURITY.md)** for the full trust model before exposing the app.
