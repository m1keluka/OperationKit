# Job ceilings: what is enforced, and how it rolls out

_obj 900322. Companion to `app/server/src/services/job-accounting.ts`._

This page exists because the first version of this feature shipped two claims it
could not back: that an auto-start guard applied only to a future bounded chat
MVP (its only call site was pre-existing delegator automation), and that a
dollar ceiling was a budget (nothing measures spend). Both are corrected here,
in code and in prose.

---

## 1. What a ceiling actually guarantees

| Dimension | Setting | Status | Why |
|---|---|---|---|
| **Wall-clock time** | `wallclock_ceiling_ms` / `job_wallclock_ceiling_ms[:ws]` | **ENFORCED** | The poller observes each live session's elapsed time on every tick from its own clock and stops the job when the card's cumulative total crosses the configured finite value. First-party measurement, so the guarantee is real. |
| **Cost (USD)** | `cost_ceiling_usd` / `job_cost_ceiling_usd[:ws]` | **ADVISORY** | Nothing in this system collects measured provider spend. Sessions run on subscription seats through the Claude CLI; there is no per-call billing feed into the server process. `spent_usd` holds only what something explicitly passed to `recordSpend`, and **today nothing in the runner does**. |

**Do not describe the cost ceiling as a billing cap.** A dollar figure derived
from token counts is an estimate of list-price value. It is not a subscription
charge, and honouring it cannot stop money being spent. `describeCeilingSupport()`
is the one sentence to put in front of a human; `CEILING_ENFORCEMENT` is the
machine-readable form.

A finite ceiling in **either** dimension satisfies the "this job is budgeted"
test — that is deliberate, so an operator who only wants a time bound is not
forced to invent a dollar number.

### Inheritance

`objective` → `workspace` → `global`, most specific wins, resolved by
`resolveConfiguredCeiling()`:

```
objectives: objective_job_accounting.cost_ceiling_usd / .wallclock_ceiling_ms
workspace:  settings.job_cost_ceiling_usd:<ws>  /  settings.job_wallclock_ceiling_ms:<ws>
global:     settings.job_cost_ceiling_usd       /  settings.job_wallclock_ceiling_ms
```

**No numeric default exists anywhere.** Absent is a first-class, reported state —
not "unlimited", and not a number this codebase picked. Choosing the production
numbers is an operator decision and is listed as an open decision below.

### Cumulative, and restart-proof

Elapsed time is `SUM(elapsed_ms)` over `objective_job_session_time`, one row per
`(objective, session)`, written with `MAX(old, new)`:

- ticking the same live session 1,200 times stores one reading, not 1,200;
- a **retry** under a new session id adds a row beside the old ones, so it
  cannot reset the budget;
- a **resume** of the same session converges on the larger reading;
- a **server restart** changes nothing, because the ledger is SQLite, not a Map.

Attempt counters (`objective_job_attempts`) have the same property, which is the
other half of the original bug: every retry budget used to live in a module-level
`Map` that a deploy emptied.

---

## 2. Rollout: legacy automation vs new bounded starts

The guard's only call site is the auto-start loop in
`POST /api/internal/objectives` that starts the children of a live
`delegate_mode` parent. That is **existing automation**. Enforcing "no ceiling →
refuse" there, with the guard defaulting on and no ceiling seeded anywhere,
converts every delegator's children into blocked cards the moment it deploys.

So policy is resolved **per path**:

| Path | Default | Behaviour with no finite ceiling |
|---|---|---|
| `delegate_child` — the pre-existing loop | `observe` | The child **starts**. The missing budget is recorded as an `activity_log` row (`job_ceiling_unbudgeted_start`, with `policy_source` so the decision is traceable) and logged. |
| `bounded` — any NEW bounded entry point | `enforce` | **Refused**, explicitly, with the reason and the remedy on the card. No installed base to break. |

`observe` means "no budget *yet*", not "ignore the budget". A card whose
configured ceiling is already **spent** is refused on both paths — only the
explicit global kill switch suppresses that.

### Operator opt-in, most specific first

```
settings.job_ceiling_policy:<path>:<workspace>   = enforce | observe | off
settings.job_ceiling_policy:<path>               = enforce | observe | off
settings.job_ceiling_policy                      = enforce | observe | off
settings.job_ceiling_guard_enabled               = 0   (legacy global kill switch → off)
```

The intended migration, which an operator drives — this code performs no step of
it automatically:

1. **Measure.** Count `activity_log` rows with
   `metadata.kind = 'job_ceiling_unbudgeted_start'`. That is the population that
   would break under enforcement, grouped by workspace.
   ```sql
   SELECT workspace, COUNT(*) FROM activity_log
    WHERE title = 'job_ceiling_unbudgeted_start'
      AND created_at > datetime('now','-7 days')
    GROUP BY workspace;
   ```
2. **Choose numbers** per workspace (see open decisions).
3. **Set** `job_wallclock_ceiling_ms:<ws>` (and optionally the advisory cost one).
4. **Watch** the diagnostic count for that workspace fall to zero.
5. **Flip one workspace** to `job_ceiling_policy:delegate_child:<ws> = 'enforce'`.
6. Repeat, then set the global `job_ceiling_policy:delegate_child = 'enforce'`.

Rollback at any step is a single settings row back to `observe`. Reaching for
`job_ceiling_guard_enabled = 0` disables the promised safety **everywhere**,
including on new bounded paths, and should not be used as a migration tool.

---

## 3. What stops a running job, and what the card says

`enforceRunningCeiling()` runs on the poller's live `working` branch, ahead of
the watchdog. The two are different instruments and the card now says which one
acted:

- **Watchdog** (`WATCHDOG_WALLCLOCK_MS`, 8h, from the process env) — a fixed
  per-spawn backstop. Force-routes to review as "stuck".
- **Job ceiling** — a per-card, cumulative budget somebody configured. Blocks the
  card with the measured numbers, the configured numbers, and which of them is
  enforced.

On breach the card is **blocked for a human** (`status='review'`,
`ai_review_verdict='blocked'`, `has_blockers=1`, plus an `activity_log` error
row) — never auto-done and never auto-cancelled — and only resources the card
**owns** are torn down: its own `session_id` and its own un-released lease rows,
killed by exact tmux name through the same idempotent, ledgered
`teardownObjectiveJob` the cancel path uses. A card with no configured ceiling is
untouched.

---

## 4. Open decisions (NOT made in code)

1. **The production numbers.** What finite wall-clock ceiling per workspace? No
   default is seeded, deliberately — a guessed number is indistinguishable from
   a budget decision somebody made.
2. **When to flip `delegate_child` to `enforce`,** and whether per workspace or
   globally. Until then, delegator children run unbudgeted — visibly, but
   unbudgeted.
3. **Whether to build measured spend collection at all.** Without a provider
   billing feed the cost ceiling cannot become a real cap. The honest options are
   (a) leave it advisory and rely on the time ceiling, (b) estimate from token
   counts and label every surface "estimate", or (c) drop the cost dimension.
   This objective does not choose.
