# obj 900323 — bounded single-agent chat → board → thread MVP: acceptance matrix

**Status: measured, 2026-11-08.** Every row below was produced by running the suite named
in it. Nothing is checked on prose. Where a gate is PARTIAL the limit is stated in the same
row rather than in a footnote.

- Branch: `cc/obj-900323-execution-readiness-c-bounded-single-age`
- PR: https://github.com/your-org/operationkit/pull/661 (private repo, not merged)
- Suite: `app/server/src/services/bots/bots-mvp.e2e.test.ts`
- Credentials used: **synthetic only** (`synthetic-connector`, `SYNTHETIC_TEST_TOKEN`, a
  fake `sk-ant-`/`ghp_`-shaped string). No production secret is read, granted or migrated.

## Commands and their actual output

```
$ cd app/server && npx vitest run src/services/bots/bots-mvp.e2e.test.ts
 ✓ src/services/bots/bots-mvp.e2e.test.ts (39 tests) 146ms
 Test Files  1 passed (1)
      Tests  39 passed (39)

$ cd app/server && npx tsc --noEmit -p tsconfig.json
(no output — clean)

$ cd app && npm run build          # client vite build + server tsc, the CI `build` job
✓ built in 14.59s
> @operationkit/server@0.0.1 build
> tsc

$ cd app && npm run test --workspace=client
 Test Files  51 passed (51)
      Tests  315 passed (315)
```

### Regression check against `main`

The full server suite does not pass cleanly in this sandbox — `python3` is absent, so
`skill-graph` and friends fail at collection. That is pre-existing and environmental, and
the honest way to report it is a BASELINE DIFF, not a pass claim:

```
$ git checkout main      && cd app/server && npm run test
 Test Files  214 failed | 110 passed | 1 skipped (325)
      Tests  27 failed | 1415 passed | 44 skipped (1486)

$ git checkout <this branch> && cd app/server && npm run test
 Test Files  214 failed | 111 passed | 1 skipped (326)
      Tests  27 failed | 1454 passed | 44 skipped (1525)
```

Identical failure counts; +1 passing file, +39 passing tests. **This branch introduces no
new failures.** Whether the 27 environmental failures pass in CI is CI's answer, not one
this sandbox can give.

## The matrix

| Gate | What it asserts | Result | Evidence / limit |
|---|---|---|---|
| **G1** owned, started job | A card is filed owned by the VALIDATED bot, in the person's workspace, `job_mode=read_only`; the start is a recorded decision, not a side effect | **PASS** | `G1` describe, 2 tests. Unbudgeted → `start_mode='manual'`, `code='auto_start_no_ceiling'`; after an explicit finite ceiling → `allowed:true` |
| **G2** idempotency | Same `(thread, idempotency_key)` twice → one card, `reused:true`, one `bot_job_origins` row. A missing key is refused, not generated | **PASS** | `G2` describe, 2 tests + the wiring test that proves the DERIVED key collapses an identical chat tool call |
| **G3** duplicate guard | Same title + workspace in a new request → refused with the existing card id; `force` overrides | **PASS** | `G3` describe, 2 tests. Reuses `lib/objective-dedupe.ts`; refusal recorded through the existing `recordDedupe` telemetry |
| **G4** owner validation | Unknown bot, wrong-thread bot, non-member person and missing workspace are each refused by code. A key LABEL resolves to nothing | **PASS** | `G4` describe, 5 tests |
| **G5** connector + KB + board isolation | The job cannot reach another workspace's board, another workspace's knowledge base, or another person's connector | **PASS** | `G5` describe, 3 tests, which CALL `lib/kb-workspace-scope` (obj 900321) and `services/connector-guard` (obj 900303) rather than re-implementing them |
| **G6** redacted artifact retrieval | Secret-shaped text in a worker summary never reaches the thread message | **PASS** | `G6` describe, 2 tests: unit on `buildThreadBody`, then the full enqueue→deliver path. Uses `services/live-redaction.ts`. **Limit:** that module is itself the documented stand-in until #715532's redactor lands; this inherits its coverage, no more |
| **G7** deduped completion | A replayed done event, a reopen→done cycle and overlapping ticks collapse to ONE delivery and ONE message. A non-bot card is never delivered | **PASS** | `G7` describe, 3 tests. Dedupe is a deterministic `delivery_id` PRIMARY KEY, the same contract obj 900309 uses |
| **G8** same-thread delivery | The result lands as an assistant turn in the originating `(person, bot)` conversation and nowhere else; a blocked card arrives as a clarification | **PASS** | `G8` describe, 2 tests |
| **G9** same-job follow-up | A follow-up reaches the SAME card; a live worker is ATTACHED to (no second worker, no second card); another conversation is refused | **PASS** | `G9` describe, 2 tests, via the existing `obj:<id>` identity lease |
| **G10** credential revocation | The next authorized call after a controlled revocation fails; wildcard revocation works; secrets are default-deny and names-only; an unreadable ledger is NOT permission | **PASS** | `G10` describe, 4 tests. **Limit:** the gate is evaluated at the next call. An in-flight request that already holds the value is not interrupted — nothing in this process can interrupt it. Spawn-time env injection is unchanged by this PR |
| **G11** crash / cancel / resume | A dead holder's lease is taken over by the resuming session; a cancelled job is not revived by a follow-up | **PASS** | `G11` describe, 2 tests |
| **G12** durable cost/time limit | No ceiling → refused with NO invented number; the enforced(wall-clock)/advisory(cost) split is preserved verbatim; ceiling and spend survive a restart (verified through a FRESH connection to the DB file) | **PASS** | `G12` describe, 4 tests, driving `services/job-accounting.ts` (obj 900322). **Limit:** the cost ceiling is advisory — no measured provider spend is collected, so it is not a billing cap, and this PR does not claim one |
| **zero-output honesty** (folded into G7) | A card that reaches `done` with no output says exactly that instead of implying a result | **PASS** | `G7` test 2 |
| **approval / block** | A consequential action is RECORDED and refused; an approval is bound to its exact inputs, is single-use, and a block cannot be re-decided into an approval | **PASS** | `approval / block` describe, 3 tests. **By design the MVP never executes one** — there is no external-action path in this PR |

## Out of scope, deliberately

No OpenBot source copied, vendored or modified (obj 900328's inventory was read as a
behaviour reference only). No fan-out, no browser, no new models or connectors. No change
to production config, budgets, secrets, scopes, memberships. No merge, no deploy. The
900327 Bot-terminology rename (PR 659) is NOT duplicated here; this PR uses "bot" in new
surfaces and leaves that PR's wording edits to integrate in normal review order.

## CI (the authoritative run)

PR 661, GitHub Actions run `42518981197` — the `gate` jobs that lock the merge:

```
typecheck      pass  1m13s
unit (server)  pass  4m5s
unit (client)  pass  1m17s
build          pass  1m43s
test-integrity pass  8s
```

The server suite passes in full in CI, which settles the sandbox question above: those 27
local failures were the missing `python3`, not this branch.
