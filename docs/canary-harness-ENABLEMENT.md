# Anti-signal Canary Harness — Enablement (obj-2376, Rec #2)

How to arm, run, read, and disarm the anti-signal canary harness in production.
The harness warms the D9 `gate_false_pass` instrument — wired in obj-527/ST2 but
**COLD** (only a human reopen ever wrote a row) — by PROACTIVELY feeding known-bad
Tier-1 fixtures through the REAL deterministic gate and recording any escape.

## What changed in code (this PR)

- **Fixtures** (`app/server/fixtures/canaries/`): 3 Tier-1 known-bad canaries —
  `tier1-no-compile` (tsc type error), `tier1-empty-stub` (TODO stub fails its
  acceptance check), `tier1-weakened-test` (a sealed reference check fails against
  an impl that an `expect(true).toBe(true)` author-test was hiding). Each
  `manifest.json` declares `expectedVerdict: "reject"`.
- **Harness** (`app/server/src/services/canary-harness.ts`): `runCanaryHarness()`
  feeds each fixture through `runFloor` (the same deterministic-floor path the live
  gate uses). A fixture whose floor outcome is `pass` (NOT rejected) is an ESCAPE:
  it writes a `gate_false_pass` row with **`source='canary'`** and raises a CRITICAL
  alarm (console + an `activity_log` `error` row → AlertBell). A `fail` outcome is a
  correct rejection (no row). It evaluates **in-process** — NO Claude review session
  is spawned, so a run is bounded and cheap (just `node` + `tsc` per fixture).
- **Schema** (`app/server/src/db/index.ts`): `gate_false_pass` gains
  `source TEXT NOT NULL DEFAULT 'reopen'` + `canary_id TEXT`, and `objective_id`/
  `review_id` become NULLABLE (a canary has no real objective). New `canary_runs`
  summary table tracks catch-rate over time. A migration rebuilds the table for
  existing DBs (prod has 0 rows → no-op copy).
- **Reopen metric protected**: `getFalsePassRate` (false-pass.ts) now filters to
  `source='reopen'`, so canary rows can NEVER inflate the human-reopen metric.
- **Metric surfaced**: `GET /api/intelligence/canary-catch-rate?days=30` (admin).
- **Scheduler**: `startCanaryHarnessScheduler()` is wired at boot but every tick is
  a **NO-OP until `canary_harness_enabled=1`** — nothing auto-fires on deploy.

## Default is OFF

The scheduled run is gated by `canary_harness_enabled` (settings row OR env
`CC_CANARY_HARNESS_ENABLED`), which **defaults to 0 in code** — no settings row
exists, so `isCanaryHarnessEnabled()` returns `false`. There is also a kill switch
`canary_harness_killed` (or `CC_CANARY_HARNESS_KILLED`) that overrides the enable
flag. Manual invocation (below) does NOT require the flag.

---

## Run it MANUALLY (no flag needed — safe, read-mostly)

A manual run only writes `canary_runs` + (on an escape) `gate_false_pass`
source='canary' rows. It never touches real objectives.

```bash
docker exec command-center node -e '
const { runCanaryHarness } = require("/app/server/dist/server/src/services/canary-harness.js");
console.log(JSON.stringify(runCanaryHarness(undefined, { trigger: "manual" }), null, 2));
'
```

Expect `escaped: 0` and `catchRate: 1` on a healthy gate. Any `escaped > 0` is a
critical alarm — a known-bad input slipped through and MUST be investigated before
trusting the gate.

## Read the catch-rate

```bash
# via the DB
docker exec command-center node -e '
const db = require("better-sqlite3")("/app/data/command-center.db");
console.log(db.prepare("SELECT * FROM canary_runs ORDER BY id DESC LIMIT 5").all());
console.log("canary escapes:", db.prepare("SELECT COUNT(*) n FROM gate_false_pass WHERE source=?").get("canary"));
'
# or via the API (admin auth)
curl -s "$CC_URL/api/intelligence/canary-catch-rate?days=30" -H "Cookie: $ADMIN_COOKIE" | jq
```

---

## STEP — Opt IN to the SCHEDULED run (the ONLY prod change to enable auto-runs)

This makes the 6-hourly scheduled tick actually run. It does NOT change any other
behavior and writes only canary-namespaced rows.

```bash
docker exec command-center node -e '
const db = require("better-sqlite3")("/app/data/command-center.db");
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run("canary_harness_enabled","1");
console.log("canary harness scheduled run ENABLED");
'
```

No restart needed — each scheduler tick re-reads the flag live.

## KILL / ROLLBACK

Instant disable (kill switch wins over the enable flag):

```bash
docker exec command-center node -e '
const db = require("better-sqlite3")("/app/data/command-center.db");
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)").run("canary_harness_killed","1");
'
```

Or simply remove the enable flag:

```bash
docker exec command-center node -e '
const db = require("better-sqlite3")("/app/data/command-center.db");
db.prepare("DELETE FROM settings WHERE key=?").run("canary_harness_enabled");
'
```

Full rollback = revert this PR. The schema additions are additive and harmless when
unused; the only writers are the harness itself (canary rows) and the unchanged
human-reopen path (source='reopen').

## Cost note

Each run executes the fixtures' manifest commands (`tsc --noEmit` + a couple of
`node` scripts) in-process via `runFloor`. No agent/Claude session is spawned and
no network/LLM cost is incurred. A full run is a few seconds of CPU.
