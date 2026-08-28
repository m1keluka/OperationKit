# Deterministic Floor — Pilot Enablement (obj 2335)

How to arm the deterministic floor for **one pilot project** in production, and how
to disarm it instantly. This is the activation step that obj-527 left undone: the
floor was merged but shipped DARK (`deterministic_floor_enabled=0`, 0 floor runs).

## What changed in code (this PR)

- **Per-project activation** (`app/server/src/services/deterministic-floor.ts`):
  `isFloorActiveForProject(db, project)` runs the floor when the **global flag is on
  OR the project has its own `floor_config:<project>` opt-in row**. So a single
  pilot is armed purely by inserting one settings row — the global default
  `deterministic_floor_enabled` **stays `0` in code** (`db/index.ts:1038`).
- **working→done is gated on both paths.** The poller already gates the session-end
  path (`state-poller.ts` — `getSessionState` only yields working|review|dead, so a
  task whose `resolvedStatus` is `done` is covered there). The **self-claim** path —
  a session/delegator `PATCH /status` straight to `done` — is now gated
  symmetrically in `routes/objectives.ts` (`status==='done'` from `working`). A red
  floor there returns HTTP 409 and bounces the worker; a completion claim cannot
  bypass the floor.
- **Proof rows.** Every floor execution writes an `objective_floor_runs` row with
  flat audit columns `objective_id, project, command, exit_code, passed, created_at`
  (passed=1 green / passed=0 red).
- **Hard kill switch.** `deterministic_floor_killed=1` (settings row or env
  `CC_DETERMINISTIC_FLOOR_KILLED`) disables the floor everywhere, regardless of any
  opt-in or the global flag.

The floor is **fail-safe-OPEN**: any infra error (command-not-found, timeout,
malformed config, unresolvable workdir) logs loudly and lets the objective proceed
exactly as today. Only a *clean non-zero exit* from a configured check blocks.

---

## STEP 1 — Pick a pilot project & its checks

Choose ONE low-risk leaf project (NOT command-center-infra itself) whose
deterministic checks are fast and reliable, e.g. `example-platform`,
`example-project-platform`. The `commands` you supply run **in the objective's
worktree** (`/tmp/cc-worktree-<id>`), in order, stopping at the first failure.

Pick commands that are genuinely deterministic for that project, e.g.:
- `npx tsc --noEmit`
- `npm test` (or the project's real test script)

## STEP 2 — Insert the opt-in row (the ONLY prod change Mike runs)

Run this on the VPS host. It writes a single settings row. **It does NOT flip the
global flag** — `deterministic_floor_enabled` stays `0`.

```bash
# Replace PILOT and the commands array with your chosen pilot + its real checks.
docker exec command-center node -e '
const db = require("better-sqlite3")("/app/data/command-center.db");
const PILOT = "example-platform";                       // <-- your pilot project name
const cfg = { enabled: true, commands: ["npx tsc --noEmit", "npm test"] };
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)")
  .run("floor_config:" + PILOT, JSON.stringify(cfg));
console.log("armed floor for", PILOT, "->", JSON.stringify(cfg));
'
```

No restart needed — the poller and the status route read the row live.

## STEP 3 — Verify it is armed (and the global default is still 0)

```bash
docker exec command-center node -e '
const db = require("better-sqlite3")("/app/data/command-center.db");
const g = db.prepare("SELECT value FROM settings WHERE key=?").get("deterministic_floor_enabled");
const p = db.prepare("SELECT value FROM settings WHERE key=?").get("floor_config:example-platform");
console.log("global deterministic_floor_enabled =", g && g.value, "(must stay 0)");
console.log("pilot floor_config              =", p && p.value);
'
```

## STEP 4 — Confirm the floor actually FIRES (the obj-527 lesson: merged ≠ armed)

After the pilot completes its next objective, confirm a row landed:

```bash
docker exec command-center node -e '
const db = require("better-sqlite3")("/app/data/command-center.db");
const rows = db.prepare(
  "SELECT objective_id, project, command, exit_code, passed, created_at \
   FROM objective_floor_runs WHERE project=? ORDER BY id DESC LIMIT 10"
).all("example-platform");
console.log("recent floor runs:", JSON.stringify(rows, null, 2));
console.log("total floor runs:", db.prepare("SELECT COUNT(*) n FROM objective_floor_runs").get().n);
'
```

A `passed=1` row = the floor verified a green build. A `passed=0` row = the floor
caught a failure and **blocked** the transition (the worker was bounced with the
failing output). `objective_floor_runs > 0` is the proof the floor is no longer dark.

---

## ROLLBACK / KILL

Disarm the pilot (remove its opt-in):

```bash
docker exec command-center node -e '
require("better-sqlite3")("/app/data/command-center.db")
  .prepare("DELETE FROM settings WHERE key=?").run("floor_config:example-platform");
console.log("disarmed pilot");
'
```

Or kill the floor **everywhere at once** (belt-and-suspenders, no row deletion):

```bash
docker exec command-center node -e '
require("better-sqlite3")("/app/data/command-center.db")
  .prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)")
  .run("deterministic_floor_killed", "1");
console.log("FLOOR KILLED globally");
'
```

Remove the kill with `DELETE FROM settings WHERE key='deterministic_floor_killed'`.

## Going board-wide later (NOT part of this pilot)

Only after the pilot shows healthy `objective_floor_runs` and no false blocks:
set the global flag `deterministic_floor_enabled=1`, which activates the floor for
**every** project that has a `floor_config:<project>` row. Do this as a separate,
deliberate step — never as part of arming the first pilot.

---

# Layer 4 — state-delta / E2E ground truth (obj 2508, KL-4)

The floor as armed above runs **layers 1–3** (compile/build + test — the `commands`
array). Those layers verify the artifact is internally consistent; they **cannot**
catch the "38 green tests, dead service" failure where the code compiles, the
author's own tests pass, but the **real outcome the author cannot fake** (an API
response, a DB row, a rendered result) never happens. Layer 4 closes that gap.

**Layer 4 is OPT-IN, per project, and OFF unless you add a `state_delta_command`.**
A project that omits it falls back to layers 1–2 **completely unchanged** — there is
no behaviour change, no new row content, nothing to roll back. This is deliberate:
be honest about where the verifier is blind.

## When to add a layer-4 command (and when NOT to)

ADD it only when the objective has an **assertable, deterministic real outcome**:
- an HTTP endpoint that must return a specific body / status AND persist a row;
- a CLI/script whose run must change observable state (a file, a DB row, a queue);
- a rendered artifact whose presence can be asserted headlessly.

Do **NOT** add it for:
- **subjective UI/UX** ("does this look good") — not deterministic; keep it on the
  human/UAT path (roadmap §iii). Layer 4 must be a hard pass/fail, never a judgement.
- **non-enumerable / exploratory work** — the Kitchen Loop itself says don't loop these.
- **on-chain / DeFi oracle deltas** — the crypto variant of KL-4 is deliberately
  **not** implemented here; we keep the 4-layer *principle*, not the chain oracle.

The command runs in the **same worktree** as layers 1–3, **after every `commands`
entry passes** (asserting a real outcome is meaningless if it didn't even compile).
A clean non-zero exit is a gating **fail attributed to layer 4** — the worker is
bounced with a state-delta-specific follow-up. A layer-4 **infra** error (timeout,
command-not-found) **fails-safe-OPEN** exactly like layers 1–3 — it never blocks.

## Arming layer 4 for a pilot project

Add a `state_delta_command` to the same `floor_config:<project>` row:

```bash
docker exec command-center node -e '
const db = require("better-sqlite3")("/app/data/command-center.db");
const PILOT = "example-platform";                        // <-- your pilot
const cfg = {
  enabled: true,
  commands: ["npx tsc --noEmit", "npm test"],         // layers 1-3 (unchanged)
  state_delta_command: "npm run e2e:state-delta"       // LAYER 4 (opt-in)
};
db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)")
  .run("floor_config:" + PILOT, JSON.stringify(cfg));
console.log("armed layer 4 for", PILOT);
'
```

The key may be `state_delta_command` (canonical) or `stateDeltaCommand` (alias).

## Verifying layer 4 fires

The `objective_floor_runs` row records the layer-4 outcome in a new column:

```bash
docker exec command-center node -e '
const db = require("better-sqlite3")("/app/data/command-center.db");
const rows = db.prepare(
  "SELECT objective_id, project, outcome, passed, failed_command, layer4_outcome, created_at \
   FROM objective_floor_runs WHERE project=? ORDER BY id DESC LIMIT 10"
).all("example-platform");
console.log(JSON.stringify(rows, null, 2));
'
```

- `layer4_outcome = NULL` → no layer-4 ran (project not opted in, or layers 1–3
  short-circuited first) — i.e. the unchanged fallback.
- `layer4_outcome = 'pass'` → the real outcome was asserted.
- `layer4_outcome = 'fail'` (with `outcome='fail'`) → the state-delta caught a wrong
  real outcome that layers 1–3 passed. **This is the verifier signal layer 4 exists for.**
- `layer4_outcome = 'open'` → infra fail-safe-open on the state-delta step.

## Rollback (layer 4 only)

Remove just the layer-4 step while keeping layers 1–2 armed — re-run the STEP 2
insert **without** `state_delta_command`. Or disarm the whole pilot / kill the floor
globally exactly as in the ROLLBACK section above. Removing layer 4 is always safe:
projects without a `state_delta_command` behave identically to the pre-layer-4 floor.

## Proof it earns its place (canary)

`app/server/fixtures/canaries/layer4-state-delta-noop/` is a known-bad fixture whose
handler returns HTTP 200 but **writes nothing**. It passes `node --check` + the
author's response-only unit test (layers 1–3 GREEN) yet **fails** the layer-4
state-delta assertion. The differential — `runFloor` with `commands` only returns
`pass` (escape), but WITH the `state_delta_command` returns `fail` (caught) — is
asserted in `app/server/src/services/deterministic-floor.layer4.test.ts`, and the
canary harness alarms on it (`canary-harness.test.ts`).
