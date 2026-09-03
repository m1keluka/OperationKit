# Module inventory

Snapshot of `origin/main`. `boot` = `startX()` from `app/server/src/index.ts`. `mounted` = `app.use` in that file. Unwired rows are **deferred delete**.

## Boot sequence (`app/server/src/index.ts`)

1. `bootstrapDopplerSecrets()` then `assertInternalApiSecret()`
2. `initDb()` — fatal on failure
3. `reconcileFromHistory` (account-router, last 7 days)
4. Express + `trust proxy` + CORS + GitHub raw webhook + JSON
5. Route mounts (below)
6. `initWebSocket`
7. Schedulers: `startPoller`, `startDreamCycleScheduler`, `startRoutineScheduler`, `startCanaryHarnessScheduler`, `startKitchenLoop`, `startAssistantNudgeScheduler`, `startCiFeedbackBridge`, `startDriftGuard`, `startObjectivesSafety`, `startPrHealthWatchdog`, `startHostBootDaemons`
8. `setQueueDrainCallback` → HTTP PATCH localhost internal status
9. listen `:3002` then `requeueParsedSessions`, `backfillDailyUsage`

Boot also calls `startRolodexSibling` after listen (no-ops unless Telegram env is set).

## Routes

| Path | File | Mounted | Purpose |
|---|---|---|---|
| `/api/auth` | `routes/auth.ts` | yes | login (cookie), `/token` (JWT), `/api-key` (`cc_live_` key in Settings → You), logout/me/users |
| `/api/agent`, `/api/openapi.json` | `routes/agent-api.ts` | yes | Agent API discovery + OpenAPI (no auth) |
| `/api/objectives/search` | `routes/objectives-search.ts` | yes | keyword + AI search (before `/:id`) |
| `/api/objectives` | `routes/objectives.ts` | yes | thin facade: `requireAuth` + register* (CRUD, status, output, control, planning, uploads) |
| `/api/objectives` | `routes/reviews.ts` | yes | AI-review iteration history |
| `/api/objectives` | `routes/corrections.ts` | yes | human mistake labels |
| `/api/costs` | `routes/costs.ts` | yes | spend summary/daily/range/by-objective/by-account |
| `/api/projects/:project/feed`, `/api/feed/all` | `routes/feed.ts` | yes | activity feed |
| `/api/docs` | `routes/docs.ts` | yes | vault tree + file R/W + search |
| `/api/mentor` | `routes/mentor.ts` | yes | Assistant threads |
| `/api/briefing` | `routes/briefing.ts` | yes | briefing |
| `/api/assistant` | `routes/assistant.ts` | yes | personal assistant config |
| `/api/status` | `routes/status.ts` | yes | UptimeRobot |
| `/api/webhooks` | `routes/webhooks.ts` | yes | UptimeRobot ingest |
| `/api/webhooks/github` | `routes/github-webhook.ts` | yes | PR-merged HMAC |
| `/api/admin` | `routes/admin.ts` | yes | accounts, system, agents, dream-cycle, skill-graph, cron, assistant ingest |
| `/api/admin/workspaces` | `routes/admin-workspaces.ts` | yes | workspace CRUD + membership + repos/integrations |
| `/api/admin/users` | `routes/admin-users.ts` | yes | user CRUD |
| `/api/internal` | `routes/internal.ts` | yes | thin facade: `isLocalhost` re-export + register* (deploy, create, preview, progress, gmail, Hermes, mentor, repos) |
| `/api/internal/routines` | `routes/internal-routines.ts` | yes | routines CRUD + run-now |
| `/api/internal/pr-health` | `routes/pr-health.ts` | yes | watchdog JSON + digest |
| `/api/internal/operationkit` | `routes/internal-operationkit.ts` | yes | OperationKit authoring |
| `/api/internal/reviews` | `routes/reviews.ts` | yes | criteria write |
| `/api/internal/test-credentials` | `routes/test-credentials.ts` | yes | plaintext fetch for reviewer |
| `/api/internal/changelog` | `routes/changelog.ts` | yes | collect/retranslate |
| `/api/intel` | `routes/intelligence.ts` | yes | blockers/conflicts/recent |
| `/api/workspaces` | `routes/workspaces.ts` | yes | membership-filtered list |
| `/api/models` | `routes/models.ts` | yes | model registry |
| `/api/contacts` | `routes/contacts.ts` | yes | vault CRM |
| `/api/meeting-queue` | `routes/meeting-queue.ts` | yes | Granola action items → objectives |
| `/api/loops` | `routes/loops.ts` | yes | operator loops markdown kanban |
| `/api/scratchpad` | `routes/scratchpad.ts` | yes | per-user markdown |
| `/api/granola-content` | `routes/granola-content.ts` | yes | drafts/hooks/ideas |
| `/api/test-credentials` | `routes/test-credentials.ts` | yes | encrypted CRUD |
| `/api/user/github-token` | `routes/user-github-token.ts` | yes | per-user PAT |
| `/api/user/google` | `routes/user-google.ts` | yes | Google OAuth |
| `/api/secrets` | `routes/secrets.ts` | yes | scoped secrets store |
| `/api/resource-assignments` | `routes/resource-assignments.ts` | yes | agent/skill assignment |
| `/changelog` | `routes/changelog.ts` | yes | public shipping page |
| `/api/public` | `routes/public-dev.ts` | yes | widget ingest |
| `/api/dev-items` | `routes/dev-items.ts` | yes | development board |
| `/api/dev-changelog` | `routes/dev-changelog.ts` | yes | internal changelog admin |
| `/shell` | `routes/shell.ts` | yes | admin shell.html |
| `/api/alerts` | `routes/alerts.ts` | yes | ingest (bearer) + list/ack (JWT) — AlertBell + notify-failure.sh |
| `/api/internal/vault/*`, `/api/internal/rolodex/history` | `routes/internal-vault.ts` | yes | telegram-rolodex tools (localhost) |

## Services (kernel)

| File | Boot | Purpose |
|---|---|---|
| `session-manager.ts` | used | spawn/stop/reviewer/planner facade (`ensureUser` + reaper + re-exports) |
| `session-followup.ts` | no | sendFollowUp + reopenObjective |
| `session-subsessions.ts` | no | planner + reviewer session spawn |
| `session-start.ts` | no | startSession + arena fan-out |
| `session-auto-resume.ts` | no | limit/overload/max-turns auto-resume |
| `session-telemetry.ts` | no | refusal/fallback JSONL scan |
| `session-control.ts` | no | interrupt/stop/state/list/queueFollowUp |
| `session-account-status.ts` | no | dashboard overlay + queue-drain callback |
| `rolodex-supervisor.ts` | yes | `startRolodexSibling` after listen |
| `state-poller.ts` | `startPoller` | poll timer + re-exports |
| `poller-loop.ts` | no | worker poll tick (`pollActiveSessions`) |
| `poller-decisions.ts` | no | pure poller decisions (repark, no-op, worker-end, bounce, watchdog) |
| `poller-ai-review.ts` | no | AI-review persist loop, cap-out, harness status, PR-linkage sweep |
| `poller-delegator.ts` | no | delegator parent lookup, continuation, reconcile/orphan/wedged sweeps |
| `poller-hygiene.ts` | no | queue-orphan drainer, top-level queue starter, auto-accept, digest |
| `poller-worker.ts` | no | live-session scans, limit/overload/turns death, floor wrappers, arena |
| `lib/is-localhost.ts` | used | loopback + Docker 172.x.0.1 origin check |
| `account-router.ts` | import side-effect | Claude seat rotation, spend caps, queue drain |
| `prompt-builder.ts` | no | worker prompt assembly |
| `stream-parser.ts` | prewarm | JSONL → SessionMessage |
| `session-intel.ts` | boot extract/backfill | transcript extract + daily ledger |
| `session-lease.ts` | no | concurrent-session leases |
| `session-spawn-clock.ts` | no | persisted spawn start times |
| `context-builder.ts` | no | prior intel into prompts |
| `delegation.ts` | no | wake/nudge delegator parents |
| `model-registry.ts` | no | DB models default/planner |
| `thread-timeline.ts` | no | collapse messages → segments |

## Services (gates / GitHub) — most flag-gated inert at boot

| File | Boot | Purpose |
|---|---|---|
| `pr-health-watchdog.ts` | `startPrHealthWatchdog` | reconcile red PRs (inert until setting) |
| `external-remediation.ts` | webhook | CI failure → resume worker (flag) |
| `ci-green-gate.ts` | poller | completion-boundary CI |
| `ci-feedback-bridge.ts` | `startCiFeedbackBridge` | vitest fail → objective (flag) |
| `deterministic-floor.ts` | poller | tsc/build/test under LLM reviewer (flag) |
| `uat-gate.ts` | poller | UAT gate (flag) |
| `outcome-verification.ts` | poller | outcome checks (flag) |
| `auto-merge.ts` | no | merge-on-green (flag, default off) |
| `auto-deploy.ts` | webhook | self-deploy on main merge (flag) |
| `false-pass.ts` | poller | gate false-pass detector |
| `pr-linkage.ts` / `pr-url.ts` / `objective-prs.ts` | no | PR ↔ objective |
| `branch-lease.ts` / `branch-scope.ts` | no | branch ownership |
| `preview-spool.ts` | health log | PR preview deploy spool |

## Services (product loops)

| File | Boot | Purpose |
|---|---|---|
| `dream-cycle.ts` | `startDreamCycleScheduler` | nightly blockers/rollup/index (+ DSR phase) |
| `routine-scheduler.ts` | `startRoutineScheduler` | cron → board objectives |
| `canary-harness.ts` | `startCanaryHarnessScheduler` | anti-signal canary (flag) |
| `kitchen-loop.ts` | `startKitchenLoop` | six-phase shadow loop (flag) |
| `assistant-nudge.ts` | `startAssistantNudgeScheduler` | 07:00 ET Telegram digest |
| `drift-guard.ts` | `startDriftGuard` | live checkout vs origin/main |
| `objectives-safety.ts` | `startObjectivesSafety` | snapshot + drop-guard |
| `host-boot-daemons.ts` | `startHostBootDaemons` | `host-boot.d/run-all.sh` watchdog |
| `daily-retro.ts` | dream-cycle | DSR three-lens (flag) |
| `strategy-governance.ts` | no | strategy stage gates |
| `design-arena.ts` / `design-context.ts` / `arena-lifecycle.ts` | spawn | design variants |
| `loops.ts` | no | vault loops files |
| `granola-content.ts` / `granola-client.ts` | no | Granola content + API |
| `contacts.ts` | no | vault CRM index |
| `gmail-triage.ts` | internal route | inbox classify |
| `dev-items.ts` | no | development board store |
| `changelog.ts` | no | shipping changelog |
| `secrets-store.ts` / `secrets-crypto.ts` | no | encrypted scoped secrets |
| `mentor-session.ts` | on message | Assistant Claude subprocess (dies with Node) |
| `mentor-context.ts` / `mentor-transcript.ts` | no | Assistant prompt + JSONL |
| `workspaces.ts` | no | workspace table cache |
| `notifier.ts` | no | alerts table + email/telegram |
| `uptimerobot.ts` | no | monitor API cache |
| `crypto.ts` | no | AES-GCM test credentials |
| `knowledge-search.ts` | no | vault grep |
| `resource-assignments.ts` | no | agent/skill scope |
| `user-github-tokens.ts` / `user-google-connections.ts` | no | per-user OAuth |
| `scratchpad.ts` | no | per-user markdown |
| `assistant-config.ts` | no | assistant settings |

## SQLite tables (from `db/index.ts` CREATE TABLE)

users, user_workspaces, objectives, schema_meta, objective_audit, external_check_remediations, planning_conversations, objective_assignees, objective_learnings, session_corrections, activity_log, scratchpads, session_intel, session_file_ops, session_events, uptime_events, alerts, thread_folders, mentor_threads, mentor_summaries, assistant_configs, workspaces, workspace_repos, workspace_integrations, gmail_triage, granola_processed_meetings, granola_action_items, contacts_index, objective_reviews, objective_floor_runs, gate_false_pass, canary_runs, objective_uat_runs, test_credentials, settings, kitchen_loop_runs, loop_drift_metrics, blocked_objectives, routines, session_runtime, branch_leases, session_leases, rolodex_threads, models, session_usage_daily, session_account_override, changelog_entries, user_github_tokens, doppler_scoped_tokens, user_google_connections, objective_prs, secrets, secret_versions, secret_access_log, resource_assignments, dsr_runs, dsr_candidates, dsr_fingerprints, dsr_signal_stats, dsr_lens_misses, dev_items, dev_item_notes, dev_item_attachments, dev_item_prs, dev_ingest_idempotency.

## Client routes (`App.tsx` react-router-dom `Routes`; unknown paths 404)

| Path | Component | Nav |
|---|---|---|
| `/`, `/w/:slug` | `KanbanBoard` (eager) | Work → Board |
| `/assistant`, `/mentor` | `MentorPage` | Work → Assistant |
| `/strategies`, `/strategy/:id` | `StrategiesPage` / `StrategyDetailPage` | Work → Strategies (admin) |
| `/development`, `/feedback` | `DevelopmentPage` | Work → Development (admin) |
| `/jobs` | `JobsBoard` | Automation |
| `/loops` | `LoopsPage` | Automation (label Notes) |
| `/granola` | `GranolaPage` | Automation (label Content) |
| `/contacts` | `ContactsPage` | Directory |
| `/docs` | `DocsPage` | Directory |
| `/status` | `StatusPage` | System |
| `/dashboard` | `Dashboard` | System |
| `/feed` | `ProjectFeed` | System |
| `/config` | `ConfigPage` | System |
| `/costs` | `CostsPage` | check Layout System group |
| `/assistant` | `AssistantPage` | routed; may be hidden |
| `/settings/account` | `AccountSettings` | |
| `/settings/test-credentials` | `TestCredentialsPage` | |
| `/settings/secrets` | `SecretsPage` | |

Unknown paths fall through to `KanbanBoard` (no 404).

## Host cron (not in-process)

Installed by `scripts/fix-vps-cron.sh`: hourly `update-active-state.sh`, 23:00 ET `generate-daily-digest.sh`, 08:00 `campaign-audit.sh`, 02:30 ET `dream-cycle.sh` (overlaps in-process dream-cycle), 09:30 `cron-health-check.sh`. Granola/gmail wrappers exist; confirm crontab separately.
