# Queue auto-start

_obj 900625. Code: `app/server/src/services/queue-autostart.ts` (sweep, selection,
gates), `app/server/src/db/schema/queue-autostart.ts` (columns + trigger),
`app/server/src/routes/admin-queue-autostart.ts` (admin API), Settings → Platform
(UI)._

Queued **task** and **bug** cards in a workspace start on their own when a
session slot and a seat are free. It is **off everywhere by default** and is
switched on **per workspace** by an admin.

Before this, nothing started an ordinary queued card. The only top-level starter
(`sweepTopLevelQueueStarter`, obj 701663) is limited to bulk-route cards
(`origin IN ('job_reply','strategy')`, `category = 'platform'`), so a card made in
the UI or through the agent API, or a `start=true` create that hit the session
cap, sat in `queue` until someone started it by hand. Widening that starter's
allowlist is **not** a substitute: it would launch old strategy/job_reply cards in
every workspace, client workspaces included.

---

## Turning it on for a workspace

1. **Give the workspace a job ceiling first.** The auto-starter uses the job
   ceiling guard on a new path, `queue_autostart`, whose default policy is
   **enforce**: a card with no finite ceiling is **not** started (see
   [Job Ceilings Rollout](./Job-Ceilings-Rollout)). The usual choice is a
   wall-clock ceiling, which the runner enforces:

   ```sql
   INSERT INTO settings (key, value) VALUES ('job_wallclock_ceiling_ms:<workspace>', '7200000')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value;   -- 2h per card, cumulative
   ```

   If you knowingly want unbudgeted starts in that workspace, set the policy to
   observe instead (the start goes ahead and is logged as
   `queue_autostart_unbudgeted_start`):

   ```sql
   INSERT INTO settings (key, value) VALUES ('job_ceiling_policy:queue_autostart:<workspace>', 'observe')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value;
   ```

   A card that has used up a ceiling somebody set is refused in **both** enforce
   and observe. Only the global kill switch `job_ceiling_guard_enabled = '0'` (policy
   `off`) skips the check.

2. **Switch the workspace on.** Settings → Platform → *Queue auto-start* → the
   workspace's switch. Or through the admin API (admin session cookie):

   ```bash
   curl -X PUT https://<host>/api/admin/queue-autostart/<workspace> \
     -H 'Content-Type: application/json' -d '{"enabled":true}'
   curl https://<host>/api/admin/queue-autostart        # state, caps, ceiling status per workspace
   ```

   Switching it on stamps the workspace's **`enabled_at`** to now. Switching it
   off removes it. Switching it back on stamps a new `enabled_at`, so the cards
   that piled up while it was off are **not** swept up.

3. **Optional: env.** `CC_QUEUE_AUTOSTART_WORKSPACES=ws1,ws2` turns workspaces on
   at the server level (union with the setting). An env-only workspace gets its
   `enabled_at` stamped the first time the server sees it. The UI shows it as
   "Set by server env" and cannot switch it off; remove it from the env instead.

This is a backend feature, so a live install picks it up only after the PR is
merged **and** the backend is redeployed. Changing the setting on a live install
is an operator decision; this PR does not change any install's settings.

### Settings and env reference

| Key | Default | Meaning |
|---|---|---|
| `settings.queue_autostart_workspaces` | empty (off) | Comma list of workspace slugs with auto-start on (the admin toggle writes this). |
| `CC_QUEUE_AUTOSTART_WORKSPACES` | empty | Same, from the server env. Union with the setting. |
| `settings.queue_autostart_enabled_at:<ws>` | written by the toggle | UTC datetime the workspace was switched on — the backlog cutoff. |
| `settings.queue_autostart_max_concurrent` / `CC_QUEUE_AUTOSTART_MAX_CONCURRENT` | `4` (env wins) | Most auto-started cards running at once, across all workspaces. |
| `CC_QUEUE_AUTOSTART_GRACE_MIN` | `1` | Minutes a new, un-requested card waits in queue before it is eligible (time to hold or cancel it). |
| `settings.job_ceiling_policy:queue_autostart[:<ws>]` | `enforce` | Ceiling policy for this path: `enforce`, `observe` or `off`. |

---

## What it will start

A card is a candidate only when **all** of these hold:

- `status = 'queue'`, top-level (`parent_id IS NULL`), not soft-deleted;
- `type` is `task` or `bug` — **never** a `project` (or anything in `planning`);
- not a Strategy (`is_strategy = 0`) and not a `[Review] …` companion;
- in a workspace that has auto-start on;
- no `queue_hold`, and no `blocked_by` card that is not `done` yet;
- **and one of:**
  - the card was **explicitly start-requested**: a `start=true` create, a
    `PATCH status=working` or an MCP `start_objective` that got a **session-cap
    409**. Those paths now set `auto_start_requested_at` on the card, and the
    response says so (`start.auto_start` / `auto_start: {requested,
    workspace_enabled}`); or
  - the card has **never run** (`session_count = 0`), **entered the queue after
    the workspace's `enabled_at`**, and has been queued for the grace window.

It does not matter **who made the card** (UI, agent API, bulk route, routine).

"Entered the queue" is `objectives.queued_at`, which a trigger stamps on every
transition into `queue`, falling back to `created_at` for cards that have not
moved since the migration. A card reopened back into the queue after
`enabled_at` counts as new; a card that has already run (`session_count > 0`)
and was parked back in queue is only started if someone asks for it.

Candidates are taken **oldest queue entry first**.

## When it starts one

The sweep runs on the state poller, every 30 seconds. For each candidate, in
order:

1. **Session cap**: running sessions (`working` + `ai_review`) must be below
   `MAX_CONCURRENT_SESSIONS`, the same count `PATCH → working` uses. At the cap
   the tick stops.
2. **Auto-start cap**: running cards that the auto-starter launched
   (`autostarted_at` set, still `working`/`ai_review`) must be below
   `queue_autostart_max_concurrent` (default 4). Cards started by hand do not
   count against it. At the cap the tick stops.
3. **Seat**: a seat for the card's engine (or an engine the workspace/card
   failover policy allows) must be able to take work now. If every seat is
   cooling down, parked or busy, the card is **skipped, not failed**: it stays
   in `queue` and the tick moves on to the next card, which may use another
   engine.
4. **Duplicate guard**: a card whose same-title twin is already running is
   skipped, as `PATCH → working` would refuse it.
5. **Ceiling guard** (`guardAutoStartCeiling`, path `queue_autostart`): see
   above. A refusal is written to the card (`auto_start_note`) and to
   `activity_log` (`queue_autostart_refused`) **once per change**, not on every
   tick.

If the spawn itself fails (a branch lease conflict, or a seat lost between the
check and the spawn), the card stays queued and the next tick tries again.

### What it records

- `objective_audit`: one `status_change` row, `queue → working`, actor
  `state-poller`, **pathway `queue-autostart`**.
- `session_starts.reason = 'queue_autostart'` and
  `objectives.last_start_reason = 'queue_autostart'`. `get_progress` (MCP) and
  `GET /api/objectives/:id/progress` return `last_start_reason`,
  `last_start_at` and a `queue_autostart` block: whether the workspace has it on,
  the card's start request, hold, `blocked_by`, the latest skip note, and
  `autostarted_at`.
- `objectives.auto_start_note`: why a queued card has **not** started yet
  (`waiting: no claude seat can take work now…`, `refused: Auto-start refused
  (policy enforce …)`, `start failed, will retry: …`). Cleared when the card
  leaves the queue.

## What it won't start

- Anything in a workspace that does not have it on, which by default is **every**
  workspace.
- The **backlog**: cards that were already queued before `enabled_at` and
  were never start-requested.
- Projects, planning cards, Strategies, `[Review]` companions, delegator
  **children** (those belong to the delegator and its queue drainer / fan-out),
  deleted cards.
- **Held** cards: `queue_hold` is set.
- Cards **waiting on another card**: `blocked_by` points at a card that is not
  `done` (a cancelled or deleted blocker keeps it waiting; clear the field).
- A card with no finite job ceiling while the policy is `enforce`, or a card over
  its ceiling.
- More than `queue_autostart_max_concurrent` at once, or anything while the session
  cap is full or every seat for the card's engine is cooling.

## Holding a card

A `WAIT:` or `DEPENDS ON:` line in a card's description is **not** parsed. Use
the fields:

| Field | Set it | Clear it |
|---|---|---|
| `queue_hold` | any reason string (≤ 500 chars), or `true` | `null`, `""` or `false` |
| `blocked_by` | id of a card **in the same workspace** | `null` |

They are accepted on `POST /api/objectives`, `PUT /api/objectives/:id`, and the
MCP `create_objective` / `update_objective` tools, under the same ownership and
workspace checks as every other field. An invalid value is a `400` and nothing is
written. A missing card and a card in another workspace get the same error, so the
field cannot be used to probe other workspaces.

A hold only stops the **auto-starter**. An explicit start (the board's Start
button, `start_objective`, `start=true`) still starts a held card.
