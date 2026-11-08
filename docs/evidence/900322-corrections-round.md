# obj 900322 — corrections round: evidence

_Follow-up to PR #656 (merged `61473449`). This document supersedes §4 "Known
gaps" of `900322-execution-readiness-b.md` and restates G10/G11/G12 as
**measured** pass / fail / untested rather than as checked boxes._

> **Status of the first round.** PR #656 was merged on 2026-11-08 at 17:53Z,
> before these corrections existed. The corrections therefore could not be added
> to that PR; they ship as a follow-up on the same branch name against the same
> card. **Merged is not deployed** — whether `61473449` is on the live checkout
> and inside the running Node process was NOT verifiable from this sandbox, so
> the "is the breaking change live right now?" question below is open.

---

## 1. The three findings this round corrects

All three were verified by reading merged `main`, not taken on report.

### F1 — the guard was attached to EXISTING automation, defaults ON, and nothing seeds a ceiling

`guardAutoStartCeiling` described itself as the chat/agent auto-start path. Its
only call site (`routes/internal-create.ts:610` on `61473449`) is the auto-start
loop that starts the children of a **live `delegate_mode` parent** — automation
that has been running for months. `isCeilingGuardEnabled` returns `true` when
the setting is absent, and the first round deliberately seeded no numeric
default. The composition is a silent breaking change: on deploy, every
delegator's children get `status='review'`, `ai_review_verdict='blocked'`.

A helper-level test could not have caught this. The helper did exactly what it
documented; the mismatch was between the helper and the path it was wired to.

### F2 — the cost ceiling was not a budget, and the time ceiling was not enforced

```
$ grep -rn "recordSpend\|observeSessionElapsed" --include=*.ts app/server/src \
    --exclude=*test* | grep -v 'job-accounting.ts' | wc -l
0
```

Zero producers. `spent_usd` and `elapsed_ms` could only ever be written by a test
writing them directly, so "a running job is stopped at its ceiling" was a claim
about `evaluateCeiling`, not about the runner.

Worse for the dollar half: nothing in this system collects measured provider
spend at all. Sessions run on subscription seats through the Claude CLI; there is
no per-call billing feed into the server process.

### F3 — recovery teardown was incomplete, and the reviewer could still complete a card silently

`teardownObjectiveJob` had exactly one caller (`objectives-status.ts:395`, the
cancel path). The poller's dead/recovery path hand-rolled its own two lease
releases. And `handleDeadSessionOutcome` is scoped to `status='working'`, so the
`ai_review` lifecycle was out of its reach entirely.

---

## 2. What changed

| Area | Change |
|---|---|
| **Rollout policy** | `resolveAutoStartPolicy(db, path, ws)` resolves `enforce` / `observe` / `off` per auto-start path. `delegate_child` (the legacy loop) defaults to **observe** — the child starts and the missing budget is recorded; `bounded` (any new entry point) defaults to **enforce** — refused outright. Operator opts in with `settings.job_ceiling_policy:<path>[:<ws>]`. A ceiling that somebody DID set is still enforced on both paths. No numeric default is introduced by either policy. |
| **Diagnostics** | Every unbudgeted legacy start writes an `activity_log` row (`job_ceiling_unbudgeted_start`) carrying `policy`, `policy_source`, `path` and `ceiling_source`, plus a console warning. The migration query is in `docs/wiki/Job-Ceilings-Rollout.md`. |
| **Running time ceiling** | `enforceRunningCeiling()` runs on the poller's live `working` branch, ahead of the watchdog. It observes the spawn clock, writes it to a per-session ledger, and stops the job when the card's **cumulative** total crosses a configured finite wall-clock ceiling. |
| **Cumulative accounting** | New `objective_job_session_time(objective_id, session_id, elapsed_ms)`, written `MAX(old,new)`. Idempotent per tick, additive per retry, immune to restart. `getSpend().elapsedMs` sums it. |
| **Honest guarantees** | `CEILING_ENFORCEMENT = { time: 'enforced', cost: 'advisory' }` and `describeCeilingSupport()`. Every refusal/stop message now says which dimension is enforced and states that the cost ceiling is **not a billing cap**. |
| **Recovery teardown** | The poller's dead/no-output path now calls the same `teardownObjectiveJob` the cancel path uses (reason keyed by session id), with a fallback to the direct releases if the teardown throws. |
| **Reviewer no-output** | `pollAIReviewSessions`'s `!verdict` branch sent a routine-spawned task whose REVIEWER produced nothing to `done`. It now routes to `review` with a reason naming it a review-side infrastructure failure. Narrow by construction: a reviewer that ran but emitted no `<verdict>` keeps its existing handling verbatim. |

---

## 3. Measured results

### Typecheck

```
$ npx tsc -p server/tsconfig.json --noEmit; echo "tsc=$?"
tsc=0
```

### Full server suite — baseline (`main` @ `61473449`) vs branch, same machine, same `node_modules`

```
main    Test Files  210 failed | 106 passed | 1 skipped (317)
        Tests        27 failed | 1372 passed | 44 skipped (1443)

branch  Test Files  210 failed | 109 passed | 1 skipped (320)
        Tests        27 failed | 1396 passed | 44 skipped (1467)
```

Identical failure counts, and the set of failing suites is byte-identical:

```
$ diff /tmp/suite-main.fails /tmp/suite-branch.fails && echo "IDENTICAL failing suites"
IDENTICAL failing suites
```

Delta: **+3 test files, +24 tests, all passing** — exactly the three new suites.
The 210 pre-existing load failures are environmental, not behavioural: this
sandbox has no `python3`, so `node-pty` and `bcrypt` cannot be built
(`npm rebuild node-pty bcrypt` → `gyp ERR! not ok`) and those suites never load.
They fail identically on `main`. **CI is the authoritative run** — the `gate`
job builds the native toolchain.

### New integration suites — 24/24 passing

| Suite | Tests | Drives |
|---|---|---|
| `routes/internal-create-ceiling-policy.test.ts` | 9 | The **real express route** `POST /api/internal/objectives` and its real auto-start loop, with a real delegate parent. Only `startSession` is stubbed. |
| `services/execution-readiness-b-runtime.integration.test.ts` | 13 | `enforceRunningCeiling` (the live poller branch), the real `session_spawns` clock, the real teardown ledger. Only `killTmuxByName` is stubbed — and recorded by exact name, so "kills only its own" is asserted, not hoped. |
| `services/reviewer-no-output.integration.test.ts` | 2 | `pollAIReviewSessions` itself, over a real empty reviewer transcript. |

Plus the first round's `execution-readiness-b.integration.test.ts` — **29/29
still passing** after the policy change (one assertion's expected wording was
updated; no behaviour it asserted was relaxed).

### Mutation checks — the new tests are load-bearing

Green tests are only evidence if they would go red. Two were verified by
reverting the fix in place:

```
# reviewer no-output fix commented out:
× empty reviewer transcript → review + blocked
  → expected 'done' to be 'review'
```

The first attempt at that test seeded a hand-made top-level card and passed
**without** the fix (`mustRouteToHumanReview` already blocks `done` for those).
The test was corrected to seed a **routine-spawned** task — the shape that
actually reached the `done` arm — and only then did it discriminate. The
vacuous version is documented here rather than quietly deleted.

Similarly, `internal-create-ceiling-policy.test.ts` asserts `json.started === 1`
for an unbudgeted legacy child; on `main` that value is `0`.

---

## 4. G10 / G11 / G12 — measured status

Legend: **PASS** = asserted by a test that drives the real wiring ·
**PARTIAL** = real but narrower than the goal reads · **UNTESTED** = built,
no automated assertion · **NOT SUPPORTED** = explicitly out of reach, stated as such.

### G10 — owned cancellation and teardown

| Claim | Status | Evidence |
|---|---|---|
| Cancel tears down only the card's own tmux + leases | **PASS** | `execution-readiness-b.integration.test.ts` (round 1); neighbour-safety re-asserted in the runtime suite |
| Teardown is idempotent — "exactly once" | **PASS** | `crash recovery is BOUNDED` — 3 calls, 1 ledger row, `performed` true/false/false |
| Works after a server restart (no in-memory map) | **PASS** | `cancel after a RESTART…` — `vi.resetModules()`, teardown off durable state, neighbour's lease still open |
| Poller recovery path uses the same teardown | **PASS** (end-to-end) | `dead-branch recovery teardown releases only owned resources, exactly once` (4 tests, runtime suite). Drives `handleDeadSessionOutcome` — the live dead branch — with the card AND a neighbour holding seeded `session_leases` + `branch_leases`. Measured: `killedTmux === [own session]`, both of the card's lease tables released, both of the neighbour's still open and its card still `working`, one ledger row with `killed_tmux=1, leases_released=1`. Mutation-verified: replacing the teardown call with the pre-correction hand-rolled release fails all 4 |
| Real process kills | **NOT TESTED BY DESIGN** | `killTmuxByName` is stubbed and recorded. The brief forbids real process kills. The *selection* of names is what is asserted |

### G11 — truthful outcomes

| Claim | Status | Evidence |
|---|---|---|
| Startup death before output → blocked with specific reason | **PASS** | round 1 suite |
| Zero-output death → blocked, not silent review | **PASS** | round 1 suite |
| Refusal distinguished from silence | **PASS** | round 1 suite |
| Explicit error record (`activity_log`) for each | **PASS** | round 1 suite |
| Reviewer that produced nothing never completes a card | **PASS** | `reviewer-no-output.integration.test.ts`, mutation-verified |
| Reviewer that ran but emitted no verdict | **UNCHANGED BY DESIGN** | asserted to keep its existing handling, so the fix stays narrow |
| Auto-start refusal is visible and specific | **PASS** | `internal-create-ceiling-policy.test.ts` — blocked card + reason + diagnostic row |

### G12 — bounded execution and durable accounting

| Claim | Status | Evidence |
|---|---|---|
| Retry/attempt counters survive restart | **PASS** | round 1 suite (SQLite, not a Map) |
| Cumulative elapsed survives restart | **PASS** | `a server RESTART does not reset the total` |
| A retry cannot reset the budget | **PASS** | `a RETRY under a new session id ADDS to the total` — 60s + 50s trips a 100s ceiling |
| Per-tick observation does not inflate the total | **PASS** | 20 ticks of a 5-minute session → ~5 minutes |
| A **running** job is stopped at its TIME ceiling | **PASS** | `OVER its ceiling, the LIVE job is stopped…` — card blocked, measured numbers in the reason, teardown ledger row, neighbour untouched |
| Card → workspace → global inheritance | **PASS** | round 1 suite + the workspace-scoped opt-in test |
| No numeric production default anywhere | **PASS** | `source: 'none'` when nothing is configured; asserted |
| A **dollar hard stop** | **NOT SUPPORTED** | No measured provider spend exists. Asserted explicitly: ten hours of runtime records `$0`, and the cost ceiling fires only on an explicitly recorded estimate. Documented as advisory, never as a billing cap |
| Mid-run cost enforcement | **NOT SUPPORTED** | follows from the above |
| Legacy automation is not silently broken | **PASS** | `still starts — an unconfigured install is not silently broken` |
| Operator-visible migration path | **PASS** (diagnostics + doc) / **UNTESTED** (no UI surface) | diagnostic rows asserted; `docs/wiki/Job-Ceilings-Rollout.md` documents the steps; there is no Settings screen for it |

---

## 5. Remaining gaps and the decisions that are NOT mine

1. **Is the first round live right now?** `61473449` is merged. Whether the live
   checkout is at that commit and whether the running Node process postdates it
   could not be checked from this sandbox (`/api/internal/drift-check` is not
   reachable on this path, and the host checkout is not mounted). **If #656 is
   already deployed, unbudgeted delegator children are being blocked right now**,
   and this branch is the fix. Worth checking before anything else:
   ```bash
   git -C /home/operator/projects/operationkit rev-parse HEAD origin/main
   ps -eo pid,lstart,args | grep '[t]sx server/src/index.ts'
   ```
2. **The production ceiling numbers.** Not chosen here, deliberately.
3. **When to flip `delegate_child` to `enforce`.** An operator decision; the
   diagnostic rows exist so it can be made on data.
4. **Whether to build measured spend collection at all** — or to drop the cost
   dimension and keep only the enforceable time one.
5. ~~**Poller recovery teardown is wired but not asserted end-to-end.**~~ **CLOSED**
   (this round, see §6): the dead-branch call site is now driven with seeded
   leases on both the card and a neighbour, across a simulated restart, a re-tick
   and a respawn.
6. **In-flight cost enforcement, and G11 for the reviewer's own crash recovery**
   (as opposed to its silence) remain unbuilt.

---

## 6. Dead-branch recovery teardown — the closing regression (measured)

The gap §5.5 named is closed. Four tests were added to
`app/server/src/services/execution-readiness-b-runtime.integration.test.ts`
(suite: `dead-branch recovery teardown releases only owned resources, exactly once`).
They drive `handleDeadSessionOutcome` — the function the poller's live `dead`
branch calls — over a real migrated SQLite DB, real on-disk transcripts, the real
`pollerTeardownDeps()` (real `releaseSessionLeasesForObjective` /
`releaseBranchLeasesForObjective`, with only `killTmuxByName` stubbed at the
process boundary and recorded by exact name, per the no-real-kills constraint).

| Test | What it seeds | What it measures |
|---|---|---|
| kills ONLY the card's own tmux and releases ONLY its leases | card + **neighbour**, each holding a `session_leases` AND a `branch_leases` row, both `working` | death 1 → no teardown, no kill, attempts=1. death 2 → `killedTmux === [own session]`, card's session+branch leases released, neighbour's **both still open**, neighbour still `working` with its `session_id` intact, exactly 1 ledger row (`dead-no-output:<sid>`, `killed_tmux=1`, `leases_released=1`), card `review`/`blocked`/`has_blockers=1`, `session_id` nulled |
| works after a RESTART | same, plus `noopRespawnCounts.clear()` between the two deaths | the in-memory map is empty (`size === 0`) and the durable attempt count is unchanged at 1; the second death still blocks, still kills only the card's tmux, still releases both of its leases, neighbour untouched |
| a re-tick releases EXACTLY once | card re-armed onto the SAME session id twice after the block | both re-ticks return `true` (stay blocked, never "done"); still **one** ledger row for that reason and still **one** kill in total |
| retry accounting stays BOUNDED | card respawned under a NEW session id with its own lease | the new session inherits the exhausted budget and is blocked on its FIRST death; attempts ≥ `MAX_NOOP_RESPAWNS`; ledger rows are `[dead-no-output:<sid>, dead-no-output:<sid>-r2]` and kills are `[<sid>, <sid>-r2]` — one row and one kill per real resource, no double-release of the first |

**Mutation verification (the tests are load-bearing).** Replacing the
`teardownObjectiveJob(...)` call in `handleDeadSessionOutcome` with the
pre-correction hand-rolled `releaseSessionLeasesForObjective(db, objective.id)`:

```
× kills ONLY the card’s own tmux and releases ONLY its leases — the neighbour runs on
× works after a RESTART: in-memory maps are empty, durable state still drives teardown
× a re-tick on the same dead session releases EXACTLY once — no second kill
× retry accounting stays BOUNDED: a respawned session never refills the budget
AssertionError: expected [] to deeply equal [ 'cc-9200337-s1' ]
 Tests  4 failed | 13 passed (17)
```

Source restored; the mutation was never committed.

**Measured runs (this sandbox).**

```
# suite under test
✓ server/src/services/execution-readiness-b-runtime.integration.test.ts (17 tests) 280ms
  Test Files  1 passed (1)
       Tests  17 passed (17)

# typecheck
npx tsc -p server/tsconfig.json --noEmit   → clean, no output

# full server suite, before vs after (same sandbox, same command)
before:  Test Files  210 failed | 109 passed | 1 skipped (320)
         Tests  27 failed | 1396 passed | 44 skipped (1467)
after:   Test Files  210 failed | 109 passed | 1 skipped (320)
         Tests  27 failed | 1400 passed | 44 skipped (1471)
```

After merging the owner's main sync (41cdbcde, which brings #654 and #655 onto
this branch) the same suites re-run green on the merged tree:

```
# the four obj-900322 suites, merged tree
 Test Files  4 passed (4)
      Tests  57 passed (57)

# full server suite, merged tree
 Test Files  213 failed | 110 passed | 1 skipped (324)
      Tests  27 failed | 1415 passed | 44 skipped (1486)

# typecheck, merged tree: npx tsc -p server/tsconfig.json --noEmit → rc=0, no output
```

The failing-test count is unchanged at 27 across all three runs; the extra
passing tests are this suite plus the suites main brought in.

Identical failure counts; `+4 passed` is exactly this suite. The 210 load
failures are environmental and pre-existing on both sides — this sandbox has no
`python3`, so `node-pty`/`bcrypt` cannot build and those suites never import.
**CI is the authoritative run**, and green CI alone is not acceptance: the table
above is the acceptance claim, and each row names the assertion behind it.

**Still NOT claimed by this round** (unchanged): no measured provider spend, so
no dollar hard stop and no mid-run cost enforcement — the cost dimension stays
ADVISORY and is never a billing cap; TIME is the enforced dimension. No real
process kill is exercised. No production DB, config, secret, scope or membership
was touched, and nothing was merged or deployed.

**Authoritative CI run** (head `249df817`, the merged tree — this is the run with
the full toolchain, so it is what settles the 210 suites this sandbox cannot load):

```
build                                     pass  1m34s
gate                                      pass  5s
gitleaks-config (OSS publish allowlist)   pass  5s
jail-proof                                pass  20s
oss-public-tree (assembled public mirror) pass  11m40s
shellcheck (scripts/migrate)              pass  8s
test-integrity                            pass  12s
typecheck                                 pass  1m8s
unit (client)                             pass  1m16s
unit (server)                             pass  2m42s
```

10/10 green including `gate`. PR #657 is left OPEN and UNMERGED, per the brief.
