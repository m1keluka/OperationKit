# Adversarial UAT gate — enablement, verification, rollback

> Rec #3 of the obj-2319 Kitchen-Loop adoption roadmap. Builds on the deterministic
> floor (PR #147) and the anti-signal canary harness (PR #154).

## What it is

The review gate today only **reads the diff** — it never *runs* the artifact. The
Kitchen Loop's proof case (38 green unit tests + a service that fails every job) is
exactly the failure a compile+test floor cannot see. The UAT gate closes that gap:
it **executes** a worker-authored, runnable **sealed test card** in an isolated
worktree, grades by EXACT exit codes, and mechanically proves the evaluator did not
cheat — producing a 4-verdict taxonomy.

| Verdict | Meaning |
|---|---|
| `PASS` | every card step's actual exit code matched its expected code |
| `PRODUCT_FAIL` | a step's exit code did NOT match — the artifact is broken (even with green author tests) |
| `UAT_SPEC_FAIL` | the card itself is invalid (manual-edit commands `vim`/`sed -i`/`cat >`, unresolved `<placeholders>`, or no negative test). **Logged, NON-blocking** |
| `EVAL_CHEAT_FAIL` | a post-eval `git diff` shows the evaluator touched a product file. **Overrides** the product verdict; flagged for a human |

The verdict is **re-derived deterministically** from exit codes + the git diff —
never from the LLM evaluator's say-so — so a hallucinating/cheating evaluator
cannot manufacture a `PASS`.

### Scope boundary — what this gate can and cannot mechanically catch

The gate's only mechanism is **blind-exec of the sealed card's commands + exact
exit-code grading** (plus the git-diff anti-cheat and the card-spec validator). It
catches artifacts that fail to compile, return a wrong value, or ship a weakened
test (a sealed reference check exits non-zero).

It **cannot** catch a **state-delta no-op** — the "HTTP 200 but writes nothing"
shape (canary fixture `layer4-state-delta-noop`). Such a fixture's card commands
(compile + the author's own unit test) **all pass by design**; only a separate
`state_delta_command` exposes it. That is the floor's **LAYER-4 state-delta
machinery shipped in obj-2508 (Rec #4)**, which this gate intentionally does not
invoke. The canary-regression proof therefore **excludes** any fixture carrying a
`state_delta_command` (`loadCanaries().filter(c => !c.state_delta_command)`), so the
assertion claims only what the UAT gate can mechanically prove. Layer-4 no-ops are
covered by the deterministic floor's layer-4 step, not by this UAT gate.

## Safety posture (default = inert)

- **Global flag OFF** — `uat_gate_enabled` defaults to `0` in code. OFF ⇒ no-op.
- **Per-project opt-in** — even when the flag is on, the gate only runs for a project
  with a `uat_gate_config:<project>` settings row (mirrors the deterministic floor).
- **SHADOW MODE by default** — even when active, the gate **records** its verdict and
  does **NOT** block any transition until `uat_gate_blocking` is explicitly set.
- **Kill switch** — `uat_gate_killed` (or env `CC_UAT_GATE_KILLED`) disarms everything,
  everywhere, with one settings write and no code edit.
- **Best-effort blind spawn** — a spawn failure is swallowed; the deterministic verdict
  still stands. Tests never spawn tmux.
- **Evaluator model** — defaults to **Opus** (`claude-opus-4-8`), consistent with the
  operator's all-Opus rule. Future A/B: the Kitchen Loop uses Haiku as the "weakest-evaluator /
  operator all-Opus rule. Future A/B: the Kitchen Loop uses Haiku as the "weakest-evaluator /
  dumb user" proxy to maximise the card-completeness signal — **do NOT use Haiku now**;
  evaluate it as a later cost/signal experiment.

## Opt-in (one project, shadow — recommended first step)

```sql
-- Arm the gate for ONE pilot project, shadow-mode (records, never blocks).
-- Global default stays OFF for every other project.
INSERT INTO settings (key, value)
-- Replace <your-project> with the project slug exactly as it appears on the card.
-- Replace <your-project> with the objective `project` slug you want to pilot;
-- the key suffix must match it exactly or the gate never fires.
VALUES ('uat_gate_config:<your-project>', '{"enabled":true}')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
```

That is all that is required to start collecting `objective_uat_runs` rows in shadow.

## Verify it is working

```sql
-- Shadow runs accumulate here; shadow=1 means "recorded, did not block".
SELECT id, objective_id, source, verdict, shadow, created_at
FROM objective_uat_runs ORDER BY id DESC LIMIT 20;
```

Canary-regression proof (the gate must reject a known-bad Tier-1 fixture):

```bash
cd app/server && ../node_modules/.bin/vitest run src/services/uat-gate.test.ts
# Expect: "every Tier-1 canary the UAT gate can mechanically catch returns PRODUCT_FAIL (not PASS)" ✓
# (the layer4-state-delta-noop fixture is excluded by scope — see "Scope boundary" above)
```

## Promote to enforcing (only after shadow looks correct)

```sql
INSERT INTO settings (key, value) VALUES ('uat_gate_enabled', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;   -- global on (or keep per-project)
INSERT INTO settings (key, value) VALUES ('uat_gate_blocking', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;   -- now PRODUCT_FAIL / EVAL_CHEAT_FAIL BLOCK
```

In enforce mode: `PRODUCT_FAIL` and `EVAL_CHEAT_FAIL` → the caller blocks the transition;
`PASS` and `UAT_SPEC_FAIL` → proceed (a bad card must never gate work — it is a worker signal).

## Kill / rollback (instant, no deploy)

```sql
-- Hard disarm everywhere, regardless of any opt-in or the global flag:
INSERT INTO settings (key, value) VALUES ('uat_gate_killed', '1')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;

-- Or simply go back to shadow (stop blocking, keep recording):
DELETE FROM settings WHERE key = 'uat_gate_blocking';

-- Or fully opt a project back out:
DELETE FROM settings WHERE key = 'uat_gate_config:<your-project>';
```

Env equivalents (for an emergency that cannot reach the DB):
`CC_UAT_GATE_KILLED=1`, `CC_UAT_GATE_ENABLED=1`, `CC_UAT_GATE_BLOCKING=1`.

Because nothing is wired into a live transition by default and the gate is a separate
table (`objective_uat_runs`, never `objective_reviews`), the worst-case blast radius of a
bug while shadow is on is an extra recorded row — no transition is affected.
