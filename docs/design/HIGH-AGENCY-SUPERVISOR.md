# High Agency supervisor — daily review of every bot's work (obj 900795)

Source: owner request 2026-11-13 (t710u). Parent: #900794 (High Agency levels 1–10 and the
wake / close-out loop). Design note: `workspaces/operationkit/decisions/2026-11-13-high-agency-activation-prompt-and-operating-loop.md`
("Supervisor bot").

## What it does

Once a day the server looks across **every High Agency bot** and flags four kinds of problem
on their cards, then routes each flag to whoever has to act:

| flag | rule | reuses | routed to |
|---|---|---|---|
| **orphaned** | a card filed by a bot's High Agency wake that has no owner, or is owned by something that is not a High Agency bot (e.g. `general`), or whose owning bot's file was removed | the wake lineage (`routine_id` / `source_job_id` / `parent_id`) | the human |
| **duplicate** | 2+ open cards in one workspace with the same normalised title, at least one in a bot's area. Never a parent/child pair, never routine wake cards (same title every wake by design) | `normalizeTitle` from the board's duplicate-card guard (obj 64) | the bot, if ONE awake bot owns every twin; otherwise the human |
| **stalled** | `classifyAccountability(...)` returns `stalled` for a `planning`/`queue`/`working` card | #900367 classifier + `settings.accountability_stalled_after_minutes` | the owning bot if it is awake, else the human |
| **over budget** | `evaluateCeiling(...)` returns `exceeded` | #900322 job ledger + the configured ceiling (card → `job_cost_ceiling_usd:<ws>` → `job_cost_ceiling_usd`) | the human — raising a ceiling is a spend decision |

"Awake" = High Agency on, bot file installed, its `high-agency:<slug>` routine enabled and not
auto-paused. A flag for a bot that will not wake goes to the human, because nobody else would see it.
"The human" = the admin who switched that bot's High Agency on (`run_as_user_id`), else the first admin.

## Scope

A card is in scope when it is **open** (not done / cancelled / soft-deleted) and either

- its `agent_context` is a bot that has an `agent_chat_high_agency` row, or
- it was filed by a High Agency wake: its `routine_id` is a `high-agency:*` routine, or its
  `source_job_id` / `parent_id` is a wake card.

Cards that belong to nobody's High Agency area (e.g. the owner's own manual cards) are not reviewed —
except as the *other half* of a duplicate pair, which is the case worth catching (a bot re-filing work
the owner already has).

## Least privilege

The supervisor is **deterministic server code, not a model.** No LLM call, no session, no card, no tool.
That is the least-privilege story: there is no code path in it that sends, spends, merges, deploys,
posts, publishes, closes or reassigns anything. Its only writes are:

1. `review_items` rows + their `review_item_events` audit (actor `server:supervisor`), always
   `kind = 'decision'` with options `approve | reject | snooze` — never an `approval` item, so a
   supervisor flag can never be read as (or used as) an approval;
2. one `supervisor_runs` row per run.

A test asserts the table-level write set is exactly those three tables and that every `objectives` row is
byte-identical before and after a run. There is no route that lets a bot decide, withdraw or edit a flag —
a bot clears a flag by fixing its own card, and the next review withdraws it.

**Why not a chat bot / AI routine?** A model-backed supervisor would need board tools and a budget, and
would be one more agent whose say-so must not count. Everything it has to judge is already a typed
signal on the row (#900367's accountability columns, the job ledger, the dedupe normaliser), so a
deterministic reviewer is both cheaper and strictly less privileged. It is "first-class" in the product
sense instead: its own status route, run log, kill switch, feed line, and a line in every bot's wake brief.

## Reuse of #900367 / PR 671 (no third review pile)

- Flags are `review_items` — the one durable decision queue. Nothing new to triage elsewhere.
- One additive column, `review_items.routed_to`, in the same typed `<party>:<name>` form as
  `objectives.waiting_on` (`agent:<slug>` / `human:<user>`). NULL keeps meaning "the human queue", so
  every existing item and caller is unchanged. `createReviewItem` accepts `routed_to` and **re-routes a
  live item in place** (audited `rerouted`) when its target changes, e.g. the owning bot stops waking.
  `listReviewItems` gains `routed_to` (`'human'` or exact) and `dedupe_prefix` filters.
- `dedupe_key = supervisor:<kind>:<card>` → a flag that persists for a week is ONE item re-surfaced
  daily (audited `escalated`), not seven. A snoozed item stays snoozed.
- `created_from_event_id = supervisor:<kind>:<card>:<fingerprint>` names the *occurrence* (the twin
  set, the ceiling, the stall's basis timestamp, the orphan reason). Once the owner decides it, the same
  occurrence is never re-asked; a new occurrence (a third twin, the ceiling raised and hit again) is.
- When a flag's condition clears, the item is **withdrawn** with a reason
  (`supervisor: no longer duplicate on the 2026-11-15 review`) — the pile shrinks by itself.
- Stalled is #900367's own `stalled` verdict; this card adds no detector of its own.

## Default-safe, invents no numbers

- **Stalled is OFF** until `settings.accountability_stalled_after_minutes` is set (#900367 ships it
  default-off). Every run records `checks_off` so "no stalled flags" is never ambiguous.
- **Over budget needs a configured ceiling.** `absent` is never over budget, whatever was spent.
- **Quiet.** No notification, email, chat message, alert or page. One activity-feed line per run, and
  only when the run filed or withdrew something.
- The daily run is ON by default because it only reads the board and writes routed review items. Kill
  switch: `settings.high_agency_supervisor_enabled = '0'` (env `CC_HIGH_AGENCY_SUPERVISOR_ENABLED`).
- `settings.high_agency_supervisor_hour` (0–23, America/New_York, default 6) is *when* it runs — a
  schedule, not a threshold. At most one scheduled run per operator day (UNIQUE index on
  `supervisor_runs(run_date) WHERE trigger='schedule'`), so a restart or a slow tick cannot double-file.
- Never on a scratch instance (started inside the host-daemon block of `index.ts`).
- If the agent files are unreadable or the list is empty, the review trusts the High Agency rows rather
  than calling every bot "removed".

## Surfaces

| | |
|---|---|
| `GET /api/internal/supervisor` | on/off, run hour, stall window, rights, live flag counts, last 14 runs |
| `GET /api/internal/supervisor/flags?bot=<slug>` | the flags routed to that bot — what a bot reads on its wake |
| `GET /api/internal/supervisor/flags?routed_to=human` | the flags that need a person |
| `GET /api/internal/supervisor/preview` | what a run would flag right now (reads only) |
| `POST /api/internal/supervisor/run` | run now — localhost + `X-Internal-Secret` (the only write route) |

Reads use the internal board principal: a card session sees only its own workspace and a request for
another workspace is a 403. The High Agency wake brief now tells each bot to read
`/api/internal/supervisor/flags?bot=<its slug>` and fix those first, on its own cards.

## Coordination with #900794

#900794 rewrites the wake brief and the cadence (levels 1–10). This card touches the brief in exactly one
place (the flags read in step 1, "Orient"); #900794's new brief should keep that line in its orient step.
Nothing here depends on levels 1–10: the supervisor reviews whatever High Agency bots exist today.

## Files

- `app/server/src/services/high-agency-supervisor.ts` — review (reads only), `fileFlags`, `runSupervisor`
- `app/server/src/services/high-agency-supervisor-scheduler.ts` — daily tick, settings, feed line
- `app/server/src/routes/internal-supervisor.ts` — routes
- `app/server/src/db/schema/supervisor.ts` — `supervisor_runs`
- `app/server/src/db/schema/accountability.ts`, `services/review-items.ts` — `routed_to`
- `app/server/src/lib/title-normalize.ts` — `normalizeTitle`, split out of `objective-dedupe.ts` (re-exported)
- `app/server/src/services/agent-chat/high-agency.ts` — one brief line
- Tests: `services/high-agency-supervisor.test.ts` (30), `routes/internal-supervisor.test.ts` (9)

## Follow-ups (not in this card)

- A queue UI for `review_items` (Stage 2 of #900367) — it should filter `routed_to` human vs bot.
- If the owner wants a flag to *wake* the bot immediately instead of waiting for its next scheduled wake,
  that is a send-shaped action and needs its own decision.
