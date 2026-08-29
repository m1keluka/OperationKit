# Outcome verification — enablement, verify, kill/rollback (obj 700028)

**What it is.** A generalized deterministic floor for **non-code** objectives
(research / content / data / ops / marketing). The per-project code floor
(`floor_config:<project>` → tsc/build/test + layer-4) only arms for objectives in
a project with compile/test commands. Outcome verification lets *any* objective —
keyed per-objective or per type/category — declare a single **outcome assertion**
that runs at the `working→done` gate. It reuses the floor's layer-4 machinery
verbatim (`runFloor`/`execRunner`): exit `0` = the outcome happened → proceed;
clean non-zero = the outcome did NOT happen → **block + bounce the worker**; any
infra error = **fail-safe-OPEN** (proceed, log loudly).

**Default state: OFF, global default unset.** With no env flag, no settings flag,
and no `outcome_assertion:*` row, `isOutcomeVerificationActiveForObjective` returns
`false` for every objective — behaviour is byte-identical to before this change
(proven by `src/services/outcome-verification.test.ts`). Prod has zero such rows,
so nothing runs until you opt one target in.

---

## Enable (opt-in one-liner)

A single settings row arms ONE target while the global flag stays OFF. Most
specific key wins: per-objective → per-category → per-type.

```sql
-- Per-objective (most specific). `command` is the only required field.
INSERT OR REPLACE INTO settings (key, value) VALUES (
  'outcome_assertion:1234',
  '{"enabled":true,
    "command":"OUTCOME_MIN_ROWS=50 node ${CC_REPO_DIR:-/home/operator/projects/operationkit}/app/server/fixtures/outcome/data-state-delta/assert-rowcount.mjs",
    "command":"OUTCOME_MIN_ROWS=50 node ${CC_REPO_DIR}/app/server/fixtures/outcome/data-state-delta/assert-rowcount.mjs",
    "cwd":"/tmp/cc-worktree-1234"}'
);

-- Per-category (every objective with category=marketing):
INSERT OR REPLACE INTO settings (key, value) VALUES (
  'outcome_assertion:category:marketing',
  '{"enabled":true,"command":"node ${CC_REPO_DIR:-/home/operator/projects/operationkit}/app/server/fixtures/outcome/content-artifact/assert-published.mjs"}'
  '{"enabled":true,"command":"node ${CC_REPO_DIR}/app/server/fixtures/outcome/content-artifact/assert-published.mjs"}'
);

-- Per-type (every objective with type=task):
INSERT OR REPLACE INTO settings (key, value) VALUES (
  'outcome_assertion:type:task', '{"enabled":true,"command":"…"}'
);
```

Config fields: `command` (required), `cwd` (optional — **wins** over the resolved
workdir; set it for a project-less objective whose assertion is an HTTP probe / DB
count and needs no worktree), `timeoutMs` (optional). `enabled` must be `true`.

**Optional global on** (arms outcome verification for *every* objective that has an
assertion row — opt-in rows still gate which objectives actually run a check):

```sql
INSERT OR REPLACE INTO settings (key, value) VALUES ('outcome_verification_enabled','1');
-- or env: CC_OUTCOME_VERIFICATION_ENABLED=1
```

### Writing a good assertion
The assertion must check **real state the worker cannot fake** and exit non-zero
when it is absent. Two worked, runnable examples ship in
`app/server/fixtures/outcome/` (a data row-count delta and a published-artifact
check) — copy one, point it at your real state (a Supabase `count(*)`, an HTTP 200
on the live URL, a CMS fetch). Honesty rule (same as the code floor): only set this
for objectives whose success is **enumerable**. Subjective work (a design, a
strategy memo) is verifier-blind — leave it on the soft LLM/UAT gate, do not force
a brittle outcome assertion.

## Verify it's live

```sql
-- Outcome runs are recorded with the source='outcome' discriminator (distinct from
-- code-floor runs, which have source NULL — so code-floor metrics are uncorrupted):
SELECT objective_id, outcome, passed, command, created_at
FROM objective_floor_runs WHERE source = 'outcome' ORDER BY id DESC LIMIT 20;
```
Milestones land in `activity_log` as `outcome_pass` / `outcome_open` /
`outcome_caught_failure`. A blocked self-claim returns HTTP **409** (`error:
"Outcome verification failed — completion blocked"`); the poller path bounces the
objective back to `working` with the failing assertion output as `ai_review_findings`.

## Kill / rollback

```sql
-- Instant global disarm (overrides every opt-in row, no code change):
INSERT OR REPLACE INTO settings (key, value) VALUES ('outcome_verification_killed','1');
-- or env: CC_OUTCOME_VERIFICATION_KILLED=1   (then restart the server)

-- Disarm a single target:
DELETE FROM settings WHERE key = 'outcome_assertion:1234';

-- Full rollback: revert the PR. The `source` column on objective_floor_runs is
-- additive (NULL for all code-floor rows) and harmless to leave in place.
```

Because the gate is fail-safe-OPEN, a broken assertion / missing interpreter /
timeout never wedges the board — it logs `outcome_open` and the objective proceeds.
