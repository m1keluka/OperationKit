# Outcome-verification example assertions (obj 700028)

Worked, runnable OUTCOME assertions for the generalized state-delta floor that
covers **non-code** objectives (research / content / data / ops). Each is a
self-contained Node ESM script: it asserts a real state the worker cannot fake and
exits `0` (outcome happened → gate PASS) or non-zero (outcome did NOT happen → gate
BLOCK). They run through the SAME `runFloor`/`execRunner` path as the code floor's
layer-4 state-delta — see `services/deterministic-floor.ts` (`evaluateOutcomeGate`).

| Example | Asserts | PASS when | BLOCK when |
|---|---|---|---|
| `data-state-delta/assert-rowcount.mjs` | a data/row delta (JSON array ≥ N) | the records were really loaded | the array is missing / empty / short |
| `content-artifact/assert-published.mjs` | a published artifact exists & is non-trivial | the article was really published | the file is missing / a stub / unrendered |

Both are parameterized by env vars (defaults in each file's header) so the *same*
script proves both the **real** outcome (state present → exit 0) and the **broken
canary** (state did not change → exit 1). The differential proof lives in
`src/services/outcome-verification.canary.test.ts`.

## Wiring an objective to one of these

Insert a settings opt-in row (per-objective, per-category, or per-type). With the
global flag OFF (default), this single row is what arms the check for that target —
nothing else runs:

```sql
-- per-objective (most specific)
INSERT INTO settings (key, value) VALUES (
  'outcome_assertion:1234',
  '{"enabled":true,"command":"OUTCOME_MIN_ROWS=50 node /home/operator/projects/command-center-infra/app/server/fixtures/outcome/data-state-delta/assert-rowcount.mjs","cwd":"/tmp/cc-worktree-1234"}'
);

-- per-category (every content objective in a workspace)
INSERT INTO settings (key, value) VALUES (
  'outcome_assertion:category:marketing',
  '{"enabled":true,"command":"node .../content-artifact/assert-published.mjs"}'
);
```

`command` is the only required field. `cwd` (optional) WINS over the resolved
workdir — set it for a project-less objective whose assertion is an HTTP probe or a
DB count that needs no worktree. See `docs/outcome-verification-ENABLEMENT.md`.
