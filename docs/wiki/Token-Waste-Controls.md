# Token-Waste Controls

Four controls added in objective #64 after one week of usage showed ~$5,950 API-equivalent spend, ~40% of it avoidable. Each one is on by default and configurable without a restart (settings are read at the point of use).

| Control | What it stops | Main settings |
|---|---|---|
| Resumed-session history cap | A long card replaying its whole transcript on every resume | `resume_cap_tokens`, `resume_cap_rounds`, `resume_cap_enabled` |
| Script routines | Paying for a model session just to run a script and reply "ok" | per-routine `kind='script'`, `script_command`, `alert_marker` |
| Routine auto-pause | A routine failing every hour for a week | `routine_auto_pause_failures`, per-routine `max_consecutive_failures` |
| Duplicate-card guard | Twin cards for the same work both running | `duplicate_guard_enabled`, `duplicate_guard_window_hours` |
| Per-seat usage (Settings → Seats) | Guessing whether you have too many or too few seats | none (read-only) |

Settings live in the `settings` table (key/value). Where an env var exists, the "precedence" column says which wins.

## A. Resumed-session history cap

When a dead worker is respawned (`sendFollowUp` in `services/session-followup.ts`), it normally runs `claude --resume`, which replays the full prior context. One card resumed 56 times at ~157M tokens each.

Now, if the card's **current session chain** is over budget, the respawn starts a **fresh** conversation instead, seeded with a compact summary built only from the card record (no model call): goal + description + completion goal, status, open TODOs (open child cards, a non-pass review, pending secrets, "no PR yet"), branch / PR(s), last review verdict + findings, last session summary, child task rows. Long fields are clipped at 4,000 chars. Code: `services/resume-cap.ts`.

- **Chain:** one session id. Tokens are summed from the session jsonl's `result` events (input + output + cache read + cache creation) after the last `{"type":"chain_reset"}` marker; rounds are `session_starts` rows of kind `resume` after the last `fresh_seeded_after_cap` row. A fresh-seeded start writes both, so the chain restarts from zero.
- **Trigger:** `tokens >= cap` OR `resumes >= rounds`, whichever comes first.
- **Visible:** `session_starts.reason = 'fresh_seeded_after_cap'` (detail carries the trigger, the numbers and the original wake reason), `objectives.last_start_reason` (card badge "fresh start · history capped"), and an `activity_log` `decision` row with `metadata.kind = 'resume_capped'`.
- Applies to worker sessions (`cc-<id>-<ts>`) only; planners/reviewers are short-lived.

| Setting | Env override (wins) | Default |
|---|---|---|
| `resume_cap_tokens` | `CC_RESUME_CAP_TOKENS` | `40000000` (0 = token trigger off) |
| `resume_cap_rounds` | `CC_RESUME_CAP_ROUNDS` | `12` (0 = round trigger off) |
| `resume_cap_enabled` | `CC_RESUME_CAP_ENABLED` | `1` (`0` = never cap) |

## B. Script routines and auto-pause

**Script routines.** A routine with `kind='script'` runs `script_command` through `bash -lc` on its cron schedule inside the server container, with **no model call**. It runs in the background (the 60s scheduler tick never waits), is killed with its process group after `script_timeout_sec` (default 600), and gets the server env minus the JWT signing secrets. The routine records `last_run_status` (`ok` / `alert` / `failed`), `last_exit_code`, `last_output_tail` (~4 KB), `last_error`, `last_run_at`.

A successful run creates nothing. It escalates to an AI card (built from `objective_template`, output tail appended to the description; fallback title "Routine '<name>' script alert/failure") only when:
- the script exits non-zero, times out, or fails to start, or
- any output line **starts with** `alert_marker` (default `ALERT:`).

**Auto-pause.** Any routine (AI or script) is paused after K consecutive failed runs.

| Source of K (first match wins) | |
|---|---|
| `routines.max_consecutive_failures` | per routine |
| `CC_ROUTINE_AUTO_PAUSE_FAILURES` | env |
| `settings.routine_auto_pause_failures` | global |
| default | `5` (K = 0 disables) |

- **Failure:** script non-zero exit / timeout / spawn error (an alert with exit 0 is *not* a failure); AI routine fire errors (bad template, spawn failed), or a run card that ends `cancelled` or with AI review verdict `fail`.
- **Neutral (no count, no reset):** over-fire, queue-depth, concurrency and duplicate guards; "script already running".
- **Reset:** a script exit 0, or a run card that ends `done` / `review` without a fail verdict.
- On pause: `enabled=0`, `auto_paused_at`, `auto_pause_reason = "auto-paused: K failures, last error …"`, an `activity_log` `blocker` row (`metadata.kind='routine_auto_paused'`) and a high alert. The Jobs board shows the reason with a **Resume** button (`POST /api/admin/routines/:id/resume`; localhost twin `POST /api/internal/routines/:id/resume`), which re-enables, clears the streak and logs `routine_resumed`.
- Internal create/update accept `kind`, `script_command` (required for scripts), `alert_marker`, `script_timeout_sec`, `max_consecutive_failures`.

## C. Duplicate-card guard

Code: `lib/objective-dedupe.ts`. A card is a **twin** when its normalized title (NFKC, lowercase, trailing `(n)` / `copy` suffixes stripped, punctuation/emoji → space, whitespace collapsed) and workspace match an **open** card (not done/cancelled, not soft-deleted) created within the window. Nothing is merged; the new card is refused.

- `POST /api/objectives` (incl. `start:true`) → **409** `{reason:'duplicate_24h', existing_id, existing}`. `force:true` creates anyway — the board's create dialog shows the existing card and a **Create anyway** button.
- `queue → working` PATCH (public and internal) → **409** while a twin is already `working`/`ai_review`, unless `force:true`. Routine cards, parent/child pairs and the card itself are exempt.
- `POST /api/internal/objectives` → duplicate items are skipped and listed in `deduped_details` with `reason:'duplicate_24h'` (per-item `force:true` overrides); 409 + `existing_ids` when every item was a duplicate. The living-docs twin guard is unchanged.
- Routine cron fires skip with `duplicate guard: …` when another source already has an open twin (`run-now` is unguarded).
- Metrics: every refusal / override is an `activity_log` `decision` row, `metadata.kind = duplicate_refused | duplicate_forced`, with `source`, `existing_id`, `normalized_title`.

| Setting (wins) | Env fallback | Default |
|---|---|---|
| `duplicate_guard_enabled` | `CC_DUPLICATE_GUARD_ENABLED` | on (`0` = off) |
| `duplicate_guard_window_hours` | `CC_DUPLICATE_GUARD_WINDOW_HOURS` | `24` |

## D. Per-seat usage (Settings → Seats)

`GET /api/admin/seats` adds a masked `usage` block per seat and a response-level `provisioning` hint; credentials, home paths and tokens are never returned (asserted in `seat-usage.integration.test.ts`). Code: `services/seat-usage.ts`.

- `tokens_24h` / `tokens_7d` — `session_intel.total_tokens` of sessions on that seat that **ended** in the window (rolling; `session_usage_daily` only has whole Eastern days). A running session counts once it ends.
- `sessions_24h` / `sessions_7d` — distinct session ids from `session_intel`, `session_runtime` and the seat's live sessions.
- `limit_state` — `healthy` / `5h` / `weekly`, with `limit_reset_at`. The router doesn't record which limit tripped, so `weekly` is inferred when the latest rate-limit message mentions a week or the cooldown is longer than 5h10m. The reset shown is when the router puts the seat back in rotation. The UI renders it in the viewer's local time with a timezone label.
- `limited_pct_24h` — share of the last 24h the seat spent rate-limited (rate-limit history log, plus a live cooldown). Early clears aren't logged, so it can overstate.
- `provisioning` — per engine: seats limited > 25% of the last 24h count toward **under**-provisioned; enabled, unparked seats with zero sessions in 24h count toward **over**-provisioned. Verdict `under` / `over` / `mixed` / `ok` / `no_seats`.

See also: [Accounts, Subscriptions & Seats](./Accounts-Subscriptions-and-Seats), [Board & Objectives Lifecycle](./Board-and-Objectives-Lifecycle).
