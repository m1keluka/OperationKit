# obj 900322 — Execution readiness B: truthful no-output, cancellation, restart-safe job accounting

**Scope:** constraints **C3**, **C4** and the cost half of **C9** from
`workspaces/operationkit/architecture/2026-11-08-execution-readiness-architecture.md`,
against go/no-go tests **G10**, **G11**, **G12**. Phase B of the Mike-approved
execution-correctness work (alongside isolation/900321).

**No live operations were performed.** No production process was killed, no DB or
config was mutated, no credential/scope/membership/Cloudflare change was made, no
live exploit test was run, nothing was merged or deployed. Everything below is a
private PR plus measured test output.

---

## 1. What was actually wrong (verified by reading `main` @ `444de1a8`, not assumed)

| # | Defect | Where |
|---|---|---|
| 1 | The poller's `dead` branch routes a worker straight to `review` and **never calls** `classifyNoOpSpawn` / `readStartupFailure` — those are wired only under the `working → review` TRANSITION branch. | `services/poller-loop.ts` |
| 2 | A startup-failure transcript has no `type:"result"`, so `jsonlHasResult` is false and `getSessionState` returns `'dead'` → the obj-900038 startup-failure fix was **unreachable from its own call site**. | `services/session-jsonl.ts`, `services/session-control.ts` |
| 3 | `PATCH /:id/status` handles `done` and `review` with a real teardown; **`cancelled` falls into a bare `else`** that writes the status and nothing else — no stop, no `session_id` clear, no lease release. The worker keeps running (and billing) to the 8h watchdog. | `routes/objectives-status.ts` |
| 4 | `stopSession` wraps its **entire body** in `if (session)` over the in-memory `activeSessions` map. After a restart that map is empty while tmux is still alive → Stop/Cancel are silent no-ops on exactly the sessions that need stopping, and the `obj:<id>` lease is never released. | `services/session-control.ts` |
| 5 | Every retry budget is a **module-level `Map`** (`noopRespawnCounts`, `autoResumeCounts`, `overloadRetryCounts`, `turnsContinueCounts`). A deploy — and self-deploy is an in-session action — empties them, silently re-arming a budget a card had already burned. | `poller-loop.ts`, `session-death.ts` |
| 6 | There is **no per-card cost ceiling at all**. `WATCHDOG_WALLCLOCK_MS` is a per-SPAWN env int, not cumulative across resumes, with no cost analogue. | `config.ts` |
| 7 | A routine card whose session **refused** reaches `done`: `completedWithAnswer` exempts it from the no-op check, `isRoutine → 'done'` fires, and `mustRouteToHumanReview` exempts routine cards too — nothing in the chain disagrees with "finished". | `poller-decisions.ts`, `lib/human-tracked.ts` |

## 2. What this PR changes

**New modules**

| File | Role |
|---|---|
| `db/schema/job-accounting.ts` | `objective_job_accounting` (ceilings + cumulative spend), `objective_job_attempts` (durable retry budgets), `objective_job_teardowns` (teardown ledger, `UNIQUE (objective_id, reason)`). |
| `services/session-outcome.ts` | `classifyTerminalOutcome` — pure classification of what a finished session produced; `applyTruthfulOutcome` — writes the project's existing blocked convention; `detectRefusal`. |
| `services/job-teardown.ts` | `resolveOwnedJob` / `teardownObjectiveJob` — owned, restart-safe, idempotent teardown. |
| `services/job-accounting.ts` | Durable attempts, finite ceilings, cumulative spend, `guardAutoStartCeiling`. |

**Wiring into the real runner**

- `poller-loop.ts` — the `dead` branch now calls the exported `handleDeadSessionOutcome`
  **before** route-to-review. The no-op respawn budget is the `max` of the in-memory map
  and the durable counter, and is bumped/reset in lock-step with the map.
- `session-control.ts` — the tmux kill moved **out of** `if (session)`; new exported
  `killTmuxByName` kills one session by exact name (no prefix glob — a `cc-<id>-*` pattern
  has collided across ids before, and a cancel that kills a neighbour is worse than one that leaks).
- `routes/objectives-status.ts` — a real `cancelled` branch that tears the card's own job down.
- `routes/internal-create.ts` — the chat/agent auto-start path consults `guardAutoStartCeiling`
  and **refuses explicitly** (card blocked, reason + remedy + kill switch named) when no finite
  ceiling exists.
- `poller-decisions.ts` — `resolveWorkerEndStatus` gains `producedNothing`; when set, the card
  routes to `review`, never `done`, on every lane including the routine carve-outs.

**Design commitments**

- **No guessed numeric production defaults.** `cost_ceiling_usd` / `wallclock_ceiling_ms` are
  `NULL` until explicitly configured. `resolveConfiguredCeiling` checks card → workspace setting
  → global setting and returns `source: 'none'` rather than inventing a number. `Infinity`,
  `NaN`, `0` and negatives are **rejected**, not clamped.
- **Ownership from durable state only.** Teardown resolves tmux names from the card's own
  `session_id` plus its own un-released `session_leases` / `branch_leases` rows. It never reads
  `activeSessions`, so it behaves identically before and after a restart.
- **Fail-safe, never fail-loud-wrong.** A transcript read error yields `intel = null` and, absent
  a conclusive startup-failure event, does **not** block — a read failure must never manufacture
  a block. A classification error logs and falls through to the pre-existing routing.
- **Reuse, not duplication.** Blocked is the existing convention (`status='review'`,
  `ai_review_verdict='blocked'`, `ai_review_findings`, `has_blockers=1`, `activity_log` `error`
  row) that the obj-840 and obj-900038 paths already use — `ObjectiveStatus` has no `'blocked'`
  member and this PR does not add one. The obj-900038 startup-failure detector is reused verbatim;
  this PR makes it *reachable*.

## 3. Measured evidence

### CI — the authoritative run, all nine checks green

```
jail-proof                               pass   24s
typecheck                                pass   53s
unit (server)                            pass   2m55s
unit (client)                            pass   1m9s
build                                    pass   1m15s
test-integrity                           pass    9s
shellcheck (scripts/migrate)             pass    9s
gitleaks-config (OSS publish allowlist)  pass    7s
oss-public-tree (assembled public mirror) pass
```
(run `42503006219`, PR #656)

`unit (server)` is the one that matters here and it is **green on the full suite** — CI has the
C toolchain, so every suite loads and runs there.

Environment note on the LOCAL numbers below: this sandbox has no `python3` and no C toolchain,
so `node-pty` and `bcrypt` cannot build and 202 server suites fail to **load** locally, on
`main` and on this branch identically. The local figures are therefore reported as a **baseline
diff**, which is the only honest way to read them; CI above is the authoritative result and it
supersedes them.

### Typecheck — clean

```
$ npx tsc --noEmit        # app/server
exit=0
```

### Full server suite — baseline vs branch (same machine, same node_modules)

| | Test Files | Tests failed | Tests passed |
|---|---|---|---|
| `main` (stashed branch changes) | 210 failed / 105 passed / 1 skipped | **27** | **1343** |
| this branch | 210 failed / 106 passed / 1 skipped | **27** | **1372** |

**Identical failure counts; +29 passing tests — exactly this PR's new suite. Zero regressions.**
The 27 pre-existing test failures and the 202 load failures are the missing native modules /
missing `python3`, present on `main` before this change.

### New integration suite — 29/29 passing

```
$ npx vitest run src/services/execution-readiness-b.integration.test.ts
 ✓ src/services/execution-readiness-b.integration.test.ts (29 tests) 136ms
 Test Files  1 passed (1)
      Tests  29 passed (29)
```

These drive the **real wiring**, not helpers beside it: `handleDeadSessionOutcome` is the function
the poller's `dead` branch calls, over a real on-disk transcript and a real migrated SQLite DB;
`teardownObjectiveJob` is the function the `cancelled` route branch calls, against the real
`objectives` / `session_leases` / `branch_leases` / ledger tables; `guardAutoStartCeiling` is the
function `internal-create.ts` calls; `resolveWorkerEndStatus` is the poller's own routing table.

Coverage against the brief's required cases:

| Required case | Test |
|---|---|
| startup dies before output | `startup death BEFORE first output → blocked with the exit code and stderr, never a silent review` |
| explicit error record | same test — asserts an `activity_log` `error` row with `session_startup_failed` |
| routine refusal | `a routine task that produced NOTHING routes to review, not done` (+ 4 refusal-classifier tests) |
| cancel releases owned resources exactly once | `teardown is IDEMPOTENT — a second cancel releases nothing a second time` (asserts ledger count == 1) |
| cancel is scoped to the card | `cancel touches ONLY the cancelled card — a concurrent neighbour keeps its session and leases` |
| restart then cancel | `RESTART THEN CANCEL: ownership resolves from durable state, so an empty in-memory map changes nothing` |
| crash recovery bounded | `a silent no-output death blocks only once the DURABLE budget is exhausted, then carries the count` |
| retries survive restart without resetting | `THE RESTART CASE: the no-output budget survives a process restart and is NOT re-armed` |
| spend/time limits survive restart | `THE RESTART CASE: spend and ceiling are re-read from SQLite, so a restart cannot reset the budget` (re-opens the same DB file on a fresh connection) |
| finite ceiling absent → auto-start rejected explicitly | `AUTO-START IS REFUSED, explicitly, when no finite ceiling is configured` |
| no guessed numeric defaults | `NO numeric default is invented — an unconfigured card reports absent, not unlimited`; `a non-finite ceiling is REJECTED rather than coerced`; `a garbage settings value is NOT a ceiling` |

### Two real defects the tests caught during development

1. **Teardown idempotency was broken by its own side effect.** The ledger key was
   `(objective_id, session_id, reason)`, but teardown *clears* `objectives.session_id` — so a
   second cancel resolved a `NULL` session, SQLite treats NULLs as distinct in a UNIQUE
   constraint, and "exactly once" silently became "once per call". The test failed; the key is
   now `(objective_id, reason)`, with the reasoning recorded in the schema comment.
2. **One of my own test premises was wrong.** I asserted that a session with no transcript and no
   log should not block. It should: that is precisely the legacy silent shape obj 900038 named
   `wrapper_never_started`, and blocking it is the truthful answer. The test was corrected to
   assert the documented behaviour, and a separate genuine fail-safe test (real tool calls +
   unreadable log → never blocked) was added.

## 4. Known gaps — audit G10 / G11 / G12

Stated plainly rather than papered over.

- **G10 is partially closed.** Cancel and post-restart stop are fixed and proven. The teardown is
  driven by the `cancelled` route branch; the poller does **not** yet call `teardownObjectiveJob`
  on its own recovery paths (`handleLimitDeath`, `handleOverloadDeath`, the orphan sweeps), which
  keep their existing lease handling. Unifying those is a follow-up, not a silent omission.
- **G11 is closed on the `dead` path and on routine refusal routing.** It is NOT closed for the
  `ai_review` lifecycle: a reviewer session that itself produces no output still follows the
  pre-existing reviewer-no-verdict path. Out of scope here.
- **G12 is closed structurally but not yet *enforced in-flight*.** The budget is durable, cumulative,
  restart-proof, and refuses auto-start. What this PR does **not** add is a poller tick that calls
  `recordSpend` from live session usage and kills a running worker mid-flight at the ceiling —
  that touches the spend pipeline and the kill path together and deserves its own gated change.
  So today: a job **cannot be auto-started** without a finite budget and **cannot be auto-started
  again** once the budget is spent; a job already running is still bounded only by the existing
  per-spawn watchdog. This is a real limitation, stated as one.
- **Behaviour change operators must know about.** `guardAutoStartCeiling` defaults **ON**, per the
  objective's explicit requirement that an absent finite ceiling must reject auto-start explicitly.
  Because no global default number is seeded (deliberately), chat/agent auto-start of delegator
  children will refuse until `settings.job_cost_ceiling_usd` (or a `:<workspace>` variant) is set,
  or `settings.job_ceiling_guard_enabled = '0'` is written. Both the refusal message and this
  document name the remedy. This is the intended semantics, not an accident — flagging it loudly
  because it is the one externally visible default change in the PR.
- **Environment limitation on the LOCAL evidence only.** The 202 unloadable suites mean the full
  suite was never green *on this machine*, on `main` or on the branch — missing `python3` and C
  toolchain, not a code problem. This is now moot for the verdict: CI ran the full suite with the
  toolchain and `unit (server)` passed, along with all eight other checks.

## 5. Not done, deliberately (scope boundary)

No merge, no deploy, no scheduler rebuild, no changes to notification-contracts/900309 / PR 654
(this PR neither requires it to merge first nor touches its patch), no new child coding work.
Phase C remains gated on A + B being accepted.
