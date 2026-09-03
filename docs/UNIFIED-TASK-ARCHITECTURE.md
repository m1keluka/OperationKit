# Unified Task Management Architecture

Single-source-of-truth map of the **capture → dispatch → execute → archive** loop that keeps work flowing through the Command Center (CC) board without manual task management.

This document was produced as part of CC objective #141 ("Build unified task management architecture", 2026-06-04). It catalogs every component, identifies which wires are connected vs missing, and records what was fixed in that session vs what remains as follow-up.

---

## 1. The Loop

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                              CAPTURE                                     │
 │                                                                          │
 │  operator brain dump (Telegram)──┐                                           │
 │  Granola meeting transcripts─┤                                           │
 │  Gmail inbox triage──────────┼──► raw signal                             │
 │  Himalaya IMAP envelope class┤                                           │
 │  Direct CLI / scripts────────┘                                           │
 └──────────────────────────────┬───────────────────────────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                              DISPATCH                                    │
 │                                                                          │
 │  Hermes orchestrator (LiteLLM proxy on VPS host, systemd: hermes-gateway)│
 │    • parses raw text via LLM, decomposes into one objective per task     │
 │    • picks agent_context, workspace, effort                              │
 │    • POSTs batch to /api/internal/objectives                             │
 │                                                                          │
 │  Granola action items skip Hermes: extracted on ingest, parked in        │
 │  granola_action_items (status='pending-review') until approved via       │
 │  /api/meeting-queue/:id/approve (or new batch endpoint).                 │
 └──────────────────────────────┬───────────────────────────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                              EXECUTE                                     │
 │                                                                          │
 │  Command Center (this app, port 3002)                                    │
 │    • objectives table is the spine                                       │
 │    • status: queue → working → review → done                             │
 │    • working transitions spawn a Claude Code session in tmux             │
 │    • session-manager.ts owns lifecycle, account-router rotates accounts  │
 │    • state-poller checks every 3s; declares dead → review on tmux exit   │
 │    • EVERY session works in /tmp/cc-worktree-{id}/ (HARD ISOLATION)     │
 │    • sessions report mid-flight via POST /api/internal/progress          │
 └──────────────────────────────┬───────────────────────────────────────────┘
                                ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │                              ARCHIVE                                     │
 │                                                                          │
 │  Per-session (auto on session death):                                    │
 │    • session-intel extracts: tools used, files touched, decisions,       │
 │      blockers, follow-ups, outcome, cost                                 │
 │    • capture-gap detector fires if agent claimed decisions but wrote     │
 │      no second-brain/<ws>/decisions/*.md                                 │
 │    • real-time knowledge capture watches assistant Write/Edit of any     │
 │      second-brain/ path during the session (state-poller @ 3s)           │
 │                                                                          │
 │  Per-hour (cron on host):                                                │
 │    • update-active-state.sh rewrites workspaces/<ws>/active.md from      │
 │      live CC objective state + recent git activity                       │
 │                                                                          │
 │  Per-day (23:00 ET cron):                                                │
 │    • generate-daily-digest.sh synthesises workspaces/<ws>/daily/         │
 │      YYYY-MM-DD.md across CC activity + git + audits + costs            │
 │                                                                          │
 │  Per-night (02:30 ET cron, 4 phases):                                    │
 │    • dream-cycle.sh: blockers → rollup → cleanup → index                 │
 │    • rollup updates ~/ai-workspace/skills/registry.json from             │
 │      session_intel (usage_count, failure_count, eval_score)              │
 │                                                                          │
 │  Manual (agents during session):                                         │
 │    • vault-capture protocol writes to workspaces/<ws>/decisions/,        │
 │      /tasks/, /insights/, /contacts/ following the canonical paths      │
 │      in ~/ai-workspace/protocols/vault-capture.md                       │
 └──────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Reference

### 2.1 Capture Layer

| Component | Lives at | Inbound surface | Outbound to | Status |
|---|---|---|---|---|
| Hermes Telegram gateway | `/home/operator/.hermes/`, systemd `hermes-gateway` | Telegram bot DM | `POST /api/internal/objectives` (CC), `/api/internal/vault/*` (rolodex) | **Planned** — venv setup script in `scripts/setup-hermes.sh`; not yet deployed (no `/home/operator/.hermes` on disk, no systemd unit) |
| Telegram Rolodex | `app/telegram-rolodex/index.ts` | the operator DMs | CC vault tools (search/append/update on `~/second-brain/`) | **Planned** — same systemd unit as Hermes |
| Granola ingest | `app/server/src/scripts/granola-ingest.ts`, `scripts/run-granola-ingest.sh` | Granola API (every 15min) | Vault meeting notes (`workspaces/<ws>/meetings/YYYY-MM-DD-<slug>.md`) + `granola_action_items` SQLite queue | **Working** end-to-end. Action items reach the operator via the meeting-queue UI now that the router is mounted. Still missing host crontab entry — runs only when triggered manually. |
| Meeting-queue review | `app/server/src/routes/meeting-queue.ts` | UI badge poll + approve/dismiss | `objectives` table (status=queue) | **Working as of 2026-06-04** — router mount added (`app.use('/api/meeting-queue', …)`). Batch-approve endpoint added the same session. |
| Gmail inbox triage | `app/server/src/services/gmail-triage.ts`, `scripts/run-gmail-triage.sh` | Gmail INBOX (cron) | Gmail labels (Live/Junk/Example Leads/Notifications) + `gmail_triage` table | **Endpoint working as of 2026-06-04** — `POST /api/internal/gmail-triage/run` added. Still missing host crontab entry. Triaged-as-Live emails do not yet create CC objectives. |
| Himalaya envelope classifier | `scripts/inbox-triage-himalaya.sh` (host) | IMAP INBOX | Gmail labels + state TSV | **Working** but isolated — never reaches CC objectives. |
| Bulk session-to-board | `POST /api/internal/objectives` (`routes/internal.ts:90`) | Sessions calling the localhost API | `objectives` table | **Working**. The path PRD-decomposition sessions use to spawn child board cards. |

### 2.2 Dispatch Layer

| Component | Role | Status |
|---|---|---|
| Hermes orchestrator (LLM) | Reads Telegram text → emits one or more objective JSONs → batch-creates them | **Planned** — not deployed |
| Hermes seed memory | `scripts/hermes-seeds/MEMORY.md` (CC API contract + decomposition heuristics) + `USER.md` (Mike's profile) | **Authored** and ready to load into Hermes' system prompt the moment the service comes up |
| Internal API (`routes/internal.ts`) | Localhost-only no-JWT endpoints Hermes calls (objectives, status, message, progress, briefing) | **Working** |
| Briefing query (`/api/internal/briefing`, `/api/briefing/briefing`) | Aggregates working + review + blocked into one daily snapshot | **Fixed 2026-06-04** — was filtering `status IN ('working','blocked','needs_review')` which never matched (`blocked` and `needs_review` are not valid statuses). Now `('working','review')` with the blocked facet derived from `has_blockers`. |

### 2.3 Execute Layer

| Component | Role | Status |
|---|---|---|
| `objectives` table + status state machine | Single board spine; valid transitions in `shared/types.ts` (`VALID_TRANSITIONS`) | **Working** |
| `session-manager.ts → startSession()` | Spawns tmux session via `pickAccount()`, builds the prompt, persists `session_id` on the objective | **Working** |
| `state-poller.ts` (3s) | Detects `dead` tmux sessions → flips objective to `review`, calls `handleSessionDeath()` | **Working** |
| `handleSessionDeath()` | Releases account slot, records rate-limit events, **and now triggers session-intel extraction** | **Wiring completed 2026-06-04** — extraction queue used to drain only at server boot |
| Worktree isolation for PR sessions | `computeIsolation()` + `checkWorktreeViolation()` in session-manager | **Working** (enforced) |
| Sub-agent / task decomposition | Sessions spawn child objectives via `POST /api/internal/objectives` (with `parent_id`) | **Working but manual** — no native parent→child task scheduler. Workflow hints (`fan-out`, `adversarial`, `tournament`, `loop-until-done`) live in the prompt and are agent-honored, not server-enforced. |
| Rate-limit / account exhaustion | `account-router.enqueueSession()` parks an objective when all accounts are throttled | **Working** but no retry scheduler — enqueued objectives sit until an account frees up |

### 2.4 Archive Layer

| Component | Cadence | What it does | Status |
|---|---|---|---|
| Session-intel extractor (`services/session-intel.ts`) | On session death (and on server boot) | Phase A deterministic JSONL parse → Phase B Ollama/Anthropic summary → writes `session_intel`, `session_events`, updates `objectives.last_session_summary` / `has_blockers` | **Auto-trigger added 2026-06-04** — previously only the boot-time `requeueParsedSessions()` ever called `queueExtraction`. Now also fires from `handleSessionDeath()`. |
| Real-time knowledge capture | Every 3s during a working session | Watches new JSONL bytes for Write/Edit on `second-brain/**/decisions/`, `/insights/`, `/workspaces/`. Inserts `session_events` rows so the UI shows captures live. | **Working** (`state-poller.scanForKnowledgeWrites`) |
| Capture-gap detector | Runs after session-intel summary | If LLM-summarized `decisions[].length > 0` and no `second-brain/**/decisions/*.md` write happened, emits `session_events` `capture_gap` milestone | **Working** — but it now actually fires every session since extraction is auto-triggered |
| `update-active-state.sh` | Hourly | Rewrites `workspaces/{example,example-project}/active.md` + `personal/active.md` from CC API + git | **Working** (cron + cron.env on host, last run validated 2026-06-04) |
| `generate-daily-digest.sh` | 23:00 ET | Synthesises `workspaces/<ws>/daily/YYYY-MM-DD.md` from CC + git + audits + transcripts | **Working** when container is up |
| `dream-cycle.sh` | 02:30 ET | 4 phases: blockers/rollup/cleanup/index. Rollup updates skills registry from `session_intel`. | **Working** (index phase WARN-only until `~/ai-workspace/scripts/minions/index-rebuild.sh` finds populated Sources dir) |
| Vault capture protocol | Agent-driven, every Phase 6 (Deliver) | Agents write to `workspaces/<ws>/decisions/`, `/tasks/`, `/insights/`, `/contacts/` per `~/ai-workspace/protocols/vault-capture.md` | **Working** — enforced by Phase 6 of the pipeline skill and detected by capture-gap |

---

## 3. End-to-End Walk-Through

### Path A: Mike sends a Telegram brain dump

1. the operator DMs the Hermes bot: *"three things — get the GHL sync running for Murphy, audit Cavaro's last EB sends, and someone needs to look at why the calendar webhook is dropping events"*.
2. Hermes parses, picks `agent_context`/`workspace`/`effort` per `MEMORY.md` heuristics, calls `POST /api/internal/objectives` with an array of three.
3. CC returns three `id`s; Hermes replies *"Created 3 objectives: #N1 (cto/example), #N2 (general/example), #N3 (cto/example)"*.
4. Mike (or Hermes via `PATCH /:id/status`) flips them to `working`; sessions spawn.
5. Each session runs its pipeline. On completion → `review`. State-poller calls `handleSessionDeath()` → `queueExtraction()` → session-intel summary lands in DB and activity feed.
6. Any decision the agent wrote to `~/second-brain/workspaces/example/decisions/` is picked up live by `scanForKnowledgeWrites`. If the agent forgot to write one, the capture-gap detector flags it.

**Status today:** steps 2–6 work; step 1 is the missing link (Hermes systemd unit not deployed). Until Hermes is running, Mike must curl the endpoint directly or use the CC web UI to create objectives.

### Path B: Action item from a Granola-recorded meeting

1. Cron triggers `run-granola-ingest.sh` (every 15 min — *cron entry missing today*).
2. `granola-ingest.ts` pulls new meetings, writes vault notes, queues action items into `granola_action_items` with `status='pending-review'`.
3. CC frontend polls `GET /api/meeting-queue/count` and shows a badge.
4. Mike opens the queue, clicks Approve → `POST /api/meeting-queue/:id/approve` (or the new `/approve-batch` with multiple ids).
5. Objective lands in `queue` status; Mike (or Hermes) flips to `working`.
6. Same Archive flow as Path A.

**Status today:** steps 2–6 work; step 1 is the missing link (cron entry).

### Path C: Mike creates an objective directly in the CC UI

1. Click "+ New" → fill the form → POST `/api/objectives` (JWT-authenticated).
2. Same Execute and Archive flow.

**Status today:** working.

---

## 4. Gap Closures in This Session (CC #141)

| Gap | Fix | File:Line |
|---|---|---|
| Granola action items unreachable — router not mounted | Added `app.use('/api/meeting-queue', meetingQueueRouter)` | `app/server/src/index.ts:28,127` |
| Daily/internal briefing queried invalid statuses (`needs_review`, `blocked`) and always returned empty `needsReview` array | Rewrote queries to use `('working','review')`; derived `blocked` from `has_blockers` column | `app/server/src/routes/briefing.ts:28-54`, `app/server/src/routes/internal.ts:391-401` |
| Session-intel extraction only ran on server boot — every completed session in steady-state stayed un-summarised | Added `queueExtraction(...)` call inside `handleSessionDeath()` | `app/server/src/services/session-manager.ts:23,237-243` |
| `run-gmail-triage.sh` posted to a non-existent endpoint | Added `POST /api/internal/gmail-triage/run` that invokes `runGmailTriage()` | `app/server/src/routes/internal.ts:12,291-309` |
| Granola review queue required one click per item | Added `POST /api/meeting-queue/approve-batch` (transactional, idempotent on already-reviewed items) | `app/server/src/routes/meeting-queue.ts:124-176` |

These all ship in the next backend deploy (`mode=both`).

---

## 5. Remaining Gaps (Follow-Up Work)

These were intentionally left for separate CC objectives — each is meaningful enough to plan and own independently rather than smuggle into this session.

1. **Deploy Hermes** — run `bash scripts/setup-hermes.sh install gateway`, provision `TELEGRAM_BOT_TOKEN` + `TELEGRAM_ROLODEX_OWNER_ID` in `.hermes/.env`, register the bot with @BotFather, smoke-test a single brain dump. Without this, the Capture layer is missing its primary inbound surface.
2. **Install missing host cron entries** — granola ingest (every 15 min) and gmail-triage (every 30 min). Both wrappers exist; only the crontab lines are missing. Format:
   ```
   */15 * * * * . /home/operator/.config/command-center/cron.env && bash /home/operator/projects/command-center-infra/scripts/run-granola-ingest.sh >> /home/operator/transcripts/granola-ingest.cron.log 2>&1 # command-center: granola-ingest
   */30 * * * * . /home/operator/.config/command-center/cron.env && bash /home/operator/projects/command-center-infra/scripts/run-gmail-triage.sh >> /home/operator/transcripts/gmail-triage.cron.log 2>&1 # command-center: gmail-triage
   ```
3. **Live-email → objective bridge** — when Gmail triage classifies an envelope as `Live` and the sender is unknown, create a `general`-agent CC objective so it can't fall through the cracks. Probably belongs in `gmail-triage.ts:runGmailTriage` after the label apply.
4. **Account-exhaustion retry scheduler** — `account-router.enqueueSession()` parks but never re-attempts. Add a 60s drain loop that flips parked objectives back to `working` once an account frees up.
5. **Granola classification fallback** — when Ollama is down, `granola-ingest.ts:107` silently skips the meeting. Add an Anthropic fallback (cost ≈ $0.005/meeting; worth it for reliability).
6. **Himalaya → CC integration** — IMAP envelope classification stops at Gmail labels. Either route ACTION envelopes to the same Live-email bridge from #3, or roll Himalaya into Gmail triage.

---

## 6. Operating Invariants

These are the contracts that hold the loop together. Break them and the architecture stops being unified.

- **Every brain dump becomes a board card** — the CC `objectives` table is the only place running work lives. If you find yourself tracking work in a notepad, Slack, or a stray markdown file, you're outside the loop.
- **`status` is the source of truth, not the agent's claim** — agents must transition objectives, not just say "done" in chat.
- **Sessions never co-own files with each other** — file ownership is at the task level (one task = one file set). Parallel sessions touching the same file is a decomposition bug.
- **Vault writes always include `workspace:` frontmatter** — `update-active-state.sh` and `dream-cycle.sh` filter by it; missing frontmatter means the artifact vanishes from rollups.
- **Decisions live in `~/second-brain/workspaces/<ws>/decisions/YYYY-MM-DD-<slug>.md`** — capture-gap detector checks for exactly this path pattern. Writing elsewhere flags the session as a capture gap.
- **Worktree sessions never touch the main checkout** — see `command-center-infra/CLAUDE.md` "Worktree Isolation" for the production-crash post-mortem.

---

## 7. Provenance

- Decision capture: `~/second-brain/workspaces/example/decisions/2026-06-04-unified-task-management-architecture.md`
- Source objective: CC #141
- Sibling objective (running in parallel): CC #142 ("Close and archive stale second brain tasks", `coo`)
- Skills consulted: pipeline, project-management, devops, qa-enforcement, vault-capture
