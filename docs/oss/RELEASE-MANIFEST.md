# OperationKit — OSS Release Manifest

**Status:** contract for the OSS V1 cut of `command-center-infra` → public
`github.com/your-org/OperationKit`.
**Owner:** W1 (security audit). The docs + installer workers rely on this file
as the include/exclude/genericize contract.

Every top-level path and every Example-internal integration is classified as:

- **SHIP** — core, publish as-is (generic, no private data).
- **OPTIONAL** — publish but **disabled by default**; gated by an env flag /
  opt-in installer. Each row names the gate.
- **EXCLUDE** — must be **removed or genericized before the repo goes public**
  (Example-customer-specific, embedded private ops, or real PII/infra). None of
  these are *live secrets* (the working tree and full git history are secret-clean
  — see the W1 report), but they are private/business-specific and must not ship
  verbatim.

> **Security note:** no item below is a credential. The secret scan (working tree
> + 684-commit history) is clean; `.env` is untracked. EXCLUDE here means
> "private/business-specific," not "leaked secret." No git-history rewrite is
> required.

---

## Top-level paths

| Path | Class | Notes / gate |
|------|-------|--------------|
| `app/` | **SHIP** | Core platform (client + server + shared). Individual Example-wired *services inside* it are classified in the integrations table below; the app itself is generic. |
| `app/telegram-rolodex/` | **OPTIONAL** | Standalone Telegram contact-bot process. Gate: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ROLODEX_OWNER_ID` (self-skips if unset). Genericize the README (references Example). |
| `config/litellm/` | **SHIP** | Model-group config; all keys are `os.environ/*` indirection. Generic. |
| `config/caddy/` | **OPTIONAL** | Reverse-proxy config; genericize the hardcoded `cc.example.com` vhost to a `${DOMAIN}` placeholder before ship. |
| `docker-compose.yml` | **SHIP** | All secrets are `${VAR}` interpolation. Doppler mount lines are commented/optional. Generic. |
| `design/` | **SHIP** | Design assets. (Verify no client logos before ship.) |
| `docs/` | **SHIP** (mostly) | Architecture/PRD/enablement docs. Genericize `example.com` references; see EXCLUDE rows for `showcase-small-things.md`. |
| `scripts/` | **MIXED** | Deploy/ops scripts — many generic, several Example-wired. Itemized below. |
| `spec/` | **SHIP** | Product/spec docs (review for client names). |
| `tests/` | **SHIP** | Vitest suites + committed smoke evidence. |
| `.env.example` | **SHIP** | Placeholders only (`change-me`, `sk-ant-...`). Generic. |
| `.gitignore` | **SHIP** | Hardened (W1). |
| `.githooks/` | **SHIP** | `pre-push` harness gate + `pre-commit` secret-block (W1). |
| `.github/workflows/` | **MIXED** | `test.yml` + `secret-scan.yml` → SHIP. `weekly-security-review.yml` → EXCLUDE (below). |
| `.gitleaks.toml` | **SHIP** | W1 secret-scan config. |
| `SECURITY.md` | **SHIP** | W1 threat model. |
| `CLAUDE.md` | **EXCLUDE / genericize** | Contains private infra: droplet IP `203.0.113.10`, `cc.example.com`, the full Doppler/Supabase project-ref table (real refs), client slugs. Rewrite to a generic self-host guide before public. |

---

## `scripts/` itemization

### SHIP (generic ops)
`backup-db.sh`, `deploy.sh`, `drift-check.sh`, `quick-deploy.sh`,
`self-deploy.sh`, `preview-deploy.sh`, `preview-spool-runner.sh`,
`preview-teardown.sh`, `install-preview-spool.sh`, `install-harness-hooks.sh`,
`apply-branch-protection.sh`, `rollout-branch-protection.sh`,
`branch-protection-ruleset*.json`, `setup-playwright-mcp.sh`,
`supabase-deploy.sh` (generic multi-project wrapper; registry lives outside the
repo), `notify-failure.sh`, `pick-claude-account.sh`, `setup-claude-account.sh`,
`split-unknown-account.cjs`, `run-claude-host.sh`, `run-claude-scheduled.sh`,
`test-fifo-spawn.sh`, `ui-conformance.sh`, `mint-service-token.sh`,
`restore-objectives-snapshot.cjs`, `pyramid-create.sh`.
*(Genericize stray `example.com`/second-brain path references where present, e.g. `quick-deploy.sh`, `preview-deploy.sh`, `rollout-branch-protection.sh`, `ui-conformance.sh`, `update-active-state.sh`.)*

### OPTIONAL (gated, self-skip when unconfigured)
| Script(s) | Gate / opt-in |
|-----------|---------------|
| `run-gmail-triage.sh`, `setup-gmail-oauth.sh` | `GMAIL_CLIENT_ID` (+ OAuth setup). Gmail triage. |
| `run-granola-ingest.sh`, `setup-granola-mcp.sh` | `GRANOLA_API_KEY` / `GRANOLA_WORKSPACE`. |
| `setup-hermes.sh` + `hermes-seeds/*` | Hermes orchestration agent (opt-in install). Seeds need genericizing — see EXCLUDE. |
| `reconcile-clients.sh`, `install-reconcile-clients-cron.sh` | Supabase reconcile. Requires `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` + cron opt-in; hardcodes example `public.clients` + `second-brain/workspaces/example` — genericize table/paths. |
| `campaign-audit.sh`, `install-campaign-audit-cron.sh` | Campaign audit. Same Supabase-clients coupling + `/campaign-audit` skill; genericize before enabling. |
| `secrets-import-from-doppler.mjs` (+ `.d.mts`) | Doppler scoped-token import. Gate: `USE_SCOPED_DOPPLER_TOKENS` / `DOPPLER_TOKEN`. |
| `dream-cycle.sh`, `install-dream-cycle-cron.sh` | Gate: `DREAM_CYCLE_ENABLED`. |
| `loop-closer-nudge.mjs` | Gate: `JARVIS_NUDGE_ENABLED`. |
| `cron-health-check.sh`, `install-cron-health-cron.sh`, `install-daily-log-cron.sh`, `generate-daily-digest.sh`, `vps-schedule.sh`, `fix-vps-cron.sh`, `update-active-state.sh` | Ops cron glue; opt-in installers. Genericize `brand-domain`/second-brain paths. |
| `inbox-triage-himalaya.sh` | himalaya CLI mail triage; opt-in. |
| `start-openhands.sh` | OpenHands co-service; opt-in. |

### EXCLUDE (Example-specific — remove or genericize before public)
| Path | Why |
|------|-----|
| `scripts/hermes-seeds/USER.md` | Real personal bio/PII about the operator (name, businesses, working hours, comms prefs). Replace with a generic template. |
| `scripts/hermes-seeds/MEMORY.md` | Hardcodes `cc.example.com` + Example ops rules. Genericize to a blank template. |
| `scripts/security/weekly-security-review.sh` | Hardcodes the 5 canonical **Example** repos, `second-brain` digest paths, and the board API. Example-internal; genericize or drop. |
| `scripts/sync-showcase.sh` | Example showcase sync (business-specific). |

---

## Example-internal integrations (feature-level)

| Integration | Class | Gate (env flag) | Notes |
|-------------|-------|-----------------|-------|
| Gmail triage (`services/gmail-triage.ts`) | **OPTIONAL** | `GMAIL_CLIENT_ID` (OAuth) | Self-skips without creds. |
| Telegram rolodex (`app/telegram-rolodex/`, `services/rolodex-supervisor.ts`) | **OPTIONAL** | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ROLODEX_OWNER_ID` | Separate process; supervisor no-ops if unset. |
| Granola ingest (`services/granola-*.ts`, `routes/granola-content.ts`, `GranolaPage.tsx`, `scripts/granola-ingest.ts`) | **OPTIONAL** | `GRANOLA_API_KEY` / `GRANOLA_WORKSPACE` | Meeting-notes ingest. |
| Doppler scoped tokens (`services/doppler-scoped-tokens.ts`, `provision-scoped-doppler-tokens.ts`) | **OPTIONAL** | `USE_SCOPED_DOPPLER_TOKENS`, `DOPPLER_TOKEN`, `PROVISION_SCOPED_DOPPLER_COMMIT` | Off → uses `.env`/compose vars. |
| Native scoped secrets store (`services/secrets-store.ts`, `secrets-crypto.ts`) | **SHIP** | `USE_SCOPED_SECRETS` (off → env vars) | Generic AES-256-GCM store (the Doppler replacement). Core. |
| Supabase reconcile (`reconcile-clients.sh`, `routes/webhooks.ts` supabase path) | **OPTIONAL** | `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` + `SUPABASE_WEBHOOK_SECRET` | Example `clients` schema coupling — genericize. |
| Campaign audit (`scripts/campaign-audit.sh`, `/campaign-audit` skill) | **OPTIONAL** | Supabase creds + cron opt-in | Example campaign schema — genericize. |
| Weekly cross-repo security review (`weekly-security-review.yml` + `.sh`) | **EXCLUDE** | schedule commented; self-hosted runner | Hardcodes 5 Example repos + droplet-local paths. Genericize or drop. |
| Test-credentials registry (`services/crypto.ts`, `docs/testing/*`) | **SHIP** | `TEST_CRED_ENCRYPTION_KEY` | Generic per-project non-prod test-cred store; docs reference env-var *names* only. |
| Mentor / notifier Telegram (`services/mentor-session.ts`, `notifier.ts`) | **OPTIONAL** | `MENTOR_TELEGRAM_OWNER_USERNAME` / Telegram token | Genericize owner-username default. |
| Arena / canary / UAT / kitchen-loop harnesses | **OPTIONAL** | `CC_ARENA_ENABLED`, `CC_CANARY_HARNESS_ENABLED`, `CC_UAT_GATE_ENABLED`, `CC_KITCHEN_LOOP_ENABLED` | Off by default; enablement docs in `docs/*-ENABLEMENT.md`. |
| Alerts | **OPTIONAL** | `ALERTS_ENABLED` | |

---

## Genericization TODOs (owned by the genericize/docs workers, not W1)

1. **`CLAUDE.md`** — strip droplet IP `203.0.113.10`, `cc.example.com`, real
   Supabase-ref table, client slugs → generic self-host guide.
2. **`config/caddy/Caddyfile`** — `cc.example.com` → `${DOMAIN}`.
3. **`hermes-seeds/USER.md` + `MEMORY.md`** — replace with blank templates.
4. **`reconcile-clients.sh` / `campaign-audit.sh`** — abstract the Example
   `clients`/`campaign_audits` schema + `second-brain/workspaces/example` paths.
5. **`weekly-security-review.*`** — parameterize the repo list or drop.
6. Sweep remaining `example.com` / `admin@example.com` / `<your-supabase-ref>`
   references across `docs/`, `scripts/`, and server config (see W1 report for the
   file list) → generic placeholders.
