# Frozen contracts

A **refactor PR** may not change anything in this file. If a change is required, it is a product PR with its own tests and review.

## HTTP prefixes (mounted in `app/server/src/index.ts`)

| Prefix | Auth |
|---|---|
| `GET /api/health` | none |
| `GET /api/agent` | none (discovery) |
| `GET /api/openapi.json` | none (Agent API spec) |
| `/api/auth` | login + `/token` open; `/api-key` JWT; rest JWT or `cc_live_` API key |
| `/api/objectives` | JWT + ownership |
| `/api/objectives/search` | JWT |
| `/api/costs` | admin |
| `/api/docs` | JWT or `cc_live_` API key (tree, file, search) |
| `/api/mentor` | JWT + Assistant flag |
| `/api/assistant` | JWT |
| `/api/assistant` | JWT |
| `/api/status` | JWT |
| `/api/webhooks` | UptimeRobot (no JWT) |
| `/api/webhooks/github` | HMAC raw body |
| `/api/admin` | admin |
| `/api/admin/workspaces` | admin |
| `/api/admin/users` | admin |
| `/api/internal` | localhost + `INTERNAL_API_SECRET` |
| `/api/internal/routines` | localhost |
| `/api/internal/pr-health` | localhost |
| `/api/internal/operationkit` | localhost |
| `/api/internal/reviews` | localhost |
| `/api/internal/test-credentials` | localhost |
| `/api/internal/changelog` | localhost |
| `/api/intel` | admin |
| `/api/workspaces` | JWT |
| `GET /api/workspaces-config` | JWT (legacy `workspaces.json`) |
| `/api/models` | JWT / admin patch |
| `/api/contacts` | admin |
| `/api/meeting-queue` | JWT |
| `/api/loops` | admin |
| `/api/scratchpad` | JWT, per-user |
| `/api/granola-content` | admin |
| `/api/test-credentials` | workspace-admin |
| `/api/user/github-token` | JWT |
| `/api/user/google` | JWT (callback excepted) |
| `/api/secrets` | JWT |
| `/api/resource-assignments` | JWT |
| `/changelog` | token-gated public |
| `/api/public` | per-workspace ingest token + CORS |
| `/api/dev-items` | admin |
| `/api/dev-changelog` | admin |
| `/shell` | admin |
| `GET /api/objectives/:id/intel` | JWT + ownership |
| `GET /api/objectives/:id/timeline` | JWT + ownership |

Previously unmounted, now live: `/api/alerts` (JWT list/ack + bearer ingest), `/api/internal/vault/*` and `/api/internal/rolodex/history` (localhost, telegram-rolodex).

## WebSocket

| Path | Auth | Direction |
|---|---|---|
| `/ws` | JWT cookie | server → client board events |
| `/ws/shell` | JWT cookie, admin | node-pty bash |

## Objective status machine

`app/shared/types.ts` `ObjectiveStatus` + `app/shared/workflow.ts` `isTransitionAllowed`.

Statuses: `planning | queue | working | ai_review | review | done | cancelled`.

`cancelled` is a soft-retire terminal (reopenable to `working`/`queue`). Distinct from `done`.

Types: `project | bug | task` change which gates fire. Cap: `MAX_CONCURRENT_SESSIONS = 100`.

## Spawn

- Session ids: `cc-{objectiveId}-*`, `cc-plan-{objectiveId}-*`, `cc-review-{objectiveId}-*`
- Transcripts: `$TRANSCRIPT_DIR/{sessionId}.jsonl` (default `/home/operator/transcripts`)
- Worker spawn: tmux + Claude `--print` stream-json or Codex `exec`
- Account homes: `/home/ccuser-a` … `e`, `/home/ccuser-codex`
- PR isolation worktree: `/tmp/cc-worktree-{objective.id}/` (enforced in session-manager)

Do not change Claude/Codex CLI flags, tmux names, or injected env keys in a refactor PR.

## Database

- File: `DB_PATH` or `/app/data/command-center.db` (host `/home/operator/data/command-center`)
- Engine: SQLite WAL, `foreign_keys=ON`
- Migrations: additive `initDb()` in `app/server/src/db/index.ts` (no numbered SQL files)
- Do not add/drop columns, rebuild CHECK constraints, or change table names in a refactor PR

## Feature flags (settings KV / env)

Many loops boot but are **inert** until a setting is `1` (`canary_harness_enabled`, `kitchen_loop_enabled`, `ci_feedback_bridge_enabled`, `pr_health_watchdog_enabled`, `auto_merge_enabled`, `auto_deploy_enabled`, `dsr_*`, deterministic floor, …). Refactor PRs do not flip flags.
