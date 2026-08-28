/**
 * Outcome verification and oracle gates —
 * extracted from deterministic-floor.ts (behavior frozen).
 *
 * runFloor lives in deterministic-floor-run.ts.
 */
import type { Database } from 'better-sqlite3'
import {
  DEFAULT_TIMEOUT_MS,
  type FloorConfig,
  type FloorRunResult,
} from './deterministic-floor-run.js'

// ════════════════════════════════════════════════════════════════════════════
// OUTCOME VERIFICATION — generalized state-delta floor for NON-CODE objectives
// (obj 700028; closes the Rec #4 coverage gap left by the per-project code floor)
// ════════════════════════════════════════════════════════════════════════════
//
// THE GAP. The code floor above (layers 1–4) only arms for a PROJECT with a
// `floor_config:<project>` row carrying tsc/build/test commands — and layer 4
// only runs AFTER those compile/test layers pass. So research, content, data,
// and ops/marketing objectives — which have no compile step and often no linked
// project at all — get NO hard floor, only the soft LLM UAT gate.
//
// This module lets ANY objective (keyed per-objective OR per type/category)
// declare a single checkable OUTCOME assertion that runs at the working→done
// gate. It REUSES the existing layer-4 machinery wholesale: the assertion is run
// as the `stateDeltaCommand` of a commands-empty FloorConfig, so the exact same
// runFloor/execRunner classification applies — a clean non-zero exit BLOCKS, any
// infra error fails-safe-OPEN, exit 0 PASSES. No parallel execution path.
//
// HARD SAFETY (identical discipline to the code floor + UAT gate):
//   1. Feature flag — OFF by default (env CC_OUTCOME_VERIFICATION_ENABLED or a
//      `outcome_verification_enabled` settings row). OFF ⇒ behaviour identical to
//      today: isOutcomeVerificationActiveForObjective returns false for every
//      objective that has no opt-in row, so NO new check ever runs.
//   2. Per-objective / per-type opt-in — even with the flag on, an objective only
//      gets a check when an `outcome_assertion:*` row resolves for it.
//   3. Fail-safe-OPEN — any infra error / unconfigured / unresolvable cwd / parse
//      error logs loudly and PROCEEDS. Only a clean non-zero exit blocks.
//   4. Kill switch — env CC_OUTCOME_VERIFICATION_KILLED or a
//      `outcome_verification_killed` row disarms everything with one settings write.

function outcomeBoolEnv(v: string | undefined): boolean {
  const s = (v || '').toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function outcomeSettingTrue(db: Database, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

/** True iff outcome verification is globally enabled (env OR settings). OFF by default. */
export function isOutcomeVerificationEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (outcomeBoolEnv(env.CC_OUTCOME_VERIFICATION_ENABLED)) return true
  return outcomeSettingTrue(db, 'outcome_verification_enabled')
}

/** Hard kill switch — disarms outcome verification everywhere, regardless of any opt-in. */
export function isOutcomeVerificationKilled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (outcomeBoolEnv(env.CC_OUTCOME_VERIFICATION_KILLED)) return true
  return outcomeSettingTrue(db, 'outcome_verification_killed')
}

/** Resolved outcome-assertion config for one objective. */
export interface OutcomeAssertionConfig {
  /** The single command run at the gate; exit 0 = pass, clean non-zero = block, infra = open. */
  command: string
  /** Optional cwd to run in. When set it WINS over the resolved workdir — lets a
   *  project-less objective (HTTP probe / DB count) run without a worktree. */
  cwd?: string
  /** Per-command wall-clock timeout (ms). Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number
  /** Which opt-in row this config resolved from (audit/telemetry only). */
  source: 'objective' | 'category' | 'type'
}

/** The minimal objective shape outcome verification keys on. */
export interface OutcomeObjectiveRef {
  id: number
  project: string | null
  workspace: string
  session_id: string | null
  type?: string | null
  category?: string | null
  ai_review_iteration?: number | null
}

/** Parse one `outcome_assertion:*` settings value into a config, or null when not usable.
 *  THROWS on malformed JSON so the caller fails-safe-OPEN (never silently skips a configured gate). */
function parseOutcomeRow(raw: string | undefined, source: OutcomeAssertionConfig['source']): OutcomeAssertionConfig | null {
  if (!raw || raw.trim().length === 0) return null
  const parsed = JSON.parse(raw) as Partial<OutcomeAssertionConfig> & { enabled?: boolean }
  if (!parsed || parsed.enabled !== true) return null
  const command = typeof parsed.command === 'string' && parsed.command.trim().length > 0 ? parsed.command : undefined
  if (!command) return null
  return {
    command,
    cwd: typeof parsed.cwd === 'string' && parsed.cwd.trim().length > 0 ? parsed.cwd : undefined,
    timeoutMs: typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : undefined,
    source,
  }
}

/**
 * Resolve the outcome assertion for an objective by precedence (most specific wins):
 *   1. per-objective  `outcome_assertion:<id>`
 *   2. per-category   `outcome_assertion:category:<category>`
 *   3. per-type       `outcome_assertion:type:<type>`
 * Returns null when no row resolves (NOT a fail — a NO-OP). THROWS on a malformed
 * row that DOES match, so evaluateOutcomeGate can fail-safe-OPEN. The settings
 * table being unreadable is treated as "not opted in" (returns null), mirroring
 * getFloorConfig.
 */
export function getOutcomeAssertion(db: Database, objective: OutcomeObjectiveRef): OutcomeAssertionConfig | null {
  const keys: Array<{ key: string; source: OutcomeAssertionConfig['source'] }> = [
    { key: `outcome_assertion:${objective.id}`, source: 'objective' },
  ]
  if (objective.category) keys.push({ key: `outcome_assertion:category:${objective.category}`, source: 'category' })
  if (objective.type) keys.push({ key: `outcome_assertion:type:${objective.type}`, source: 'type' })

  for (const { key, source } of keys) {
    let raw: string | undefined
    try {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
      raw = row?.value
    } catch {
      return null // settings unreadable → treat as not opted in (fail-safe)
    }
    if (raw && raw.trim().length > 0) {
      // A matching row that is malformed must THROW (→ fail-safe-OPEN), not fall
      // through to a less-specific key — a broken explicit opt-in is an infra
      // problem the operator should see, never a silent downgrade.
      return parseOutcomeRow(raw, source)
    }
  }
  return null
}

/** True iff ANY `outcome_assertion:*` opt-in row is present (non-empty) for this objective. */
export function hasOutcomeOptIn(db: Database, objective: OutcomeObjectiveRef): boolean {
  const keys = [`outcome_assertion:${objective.id}`]
  if (objective.category) keys.push(`outcome_assertion:category:${objective.category}`)
  if (objective.type) keys.push(`outcome_assertion:type:${objective.type}`)
  try {
    for (const key of keys) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
      if (typeof row?.value === 'string' && row.value.trim().length > 0) return true
    }
  } catch {
    return false
  }
  return false
}

/**
 * Outcome verification is active for an objective iff it is not globally killed
 * AND (the global flag is on OR this objective/type/category has an opt-in row).
 * Mirrors isFloorActiveForProject so a single pilot can arm a per-type check via
 * one DB row without flipping the global default.
 */
export function isOutcomeVerificationActiveForObjective(
  db: Database,
  objective: OutcomeObjectiveRef,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isOutcomeVerificationKilled(db, env)) return false
  return isOutcomeVerificationEnabled(db, env) || hasOutcomeOptIn(db, objective)
}

/** Build the follow-up message routed back to the worker on a failed outcome assertion. */
export function buildOutcomeFailFollowUp(run: FloorRunResult): string {
  return [
    '## Outcome Verification — FAILED',
    '',
    'A deterministic **outcome assertion** for this objective exited non-zero: the real',
    'state it asserts (a data/row delta, a published artifact, an API response — the thing',
    'a written summary cannot fake) did **not** happen. This is an **automatic fail** — the',
    'outcome floor sits under the AI review, so the objective cannot advance until the',
    'asserted outcome actually occurs. Produce the real outcome (do not weaken the',
    'assertion) and continue.',
    '',
    `**Outcome assertion:** \`${run.failedCommand}\``,
    '',
    '```',
    run.failingOutput || '(no output captured)',
    '```',
  ].join('\n')
}

// ── Shared outcome-gate decision (used by BOTH the poller and the working→done route) ──
export interface OutcomeGateDeps {
  /** Resolve the per-objective/type assertion; wraps getOutcomeAssertion and MAY THROW
   *  on a malformed row (→ fail-safe-OPEN). Returns null when not opted in. */
  getConfig: () => OutcomeAssertionConfig | null
  /** Resolve the FALLBACK cwd (used only when the config has no explicit cwd); MAY THROW. */
  resolveFallbackCwd: () => string
  /** Execute the floor (inject runFloor or a fake). Receives a commands-empty FloorConfig. */
  run: (cfg: FloorConfig, cwd: string) => FloorRunResult
  /** Persist the run (best-effort; receives the cwd used and the resolved assertion source). */
  record: (cwd: string, run: FloorRunResult, source: OutcomeAssertionConfig['source']) => void
  /** Emit an activity_log milestone. */
  logMilestone: (title: string, detail: string) => void
}

export type OutcomeGateDecision =
  | { action: 'proceed'; reason: 'green' | 'open' | 'not-opted-in' | 'cfg-error'; run?: FloorRunResult }
  | { action: 'block'; run: FloorRunResult; followUp: string }

/**
 * Resolve assertion → run it (as a commands-empty layer-4 floor) → classify.
 * Returns `block` ONLY on a clean non-zero exit; every infra problem, parse error,
 * or not-opted-in case returns `proceed` (fail-safe-OPEN) so an outcome-floor bug
 * can never wedge a transition. The CALLER performs the status mutation. Activation
 * (isOutcomeVerificationActiveForObjective) is the caller's responsibility — this
 * function assumes the objective is active and only resolves config→run→verdict.
 */
export function evaluateOutcomeGate(deps: OutcomeGateDeps): OutcomeGateDecision {
  let cfg: OutcomeAssertionConfig | null
  try {
    cfg = deps.getConfig()
  } catch (err) {
    deps.logMilestone('outcome_open', `assertion config parse error; gate skipped (fail-open): ${String(err)}`)
    return { action: 'proceed', reason: 'cfg-error' }
  }
  if (!cfg) return { action: 'proceed', reason: 'not-opted-in' }

  // An explicit config cwd WINS (project-less HTTP/DB-probe objectives), else fall
  // back to the resolved workdir. A throw from the fallback fails-safe-OPEN.
  let cwd: string
  try {
    cwd = cfg.cwd ?? deps.resolveFallbackCwd()
  } catch (err) {
    deps.logMilestone('outcome_open', `cwd resolution threw; gate skipped (fail-open): ${String(err)}`)
    return { action: 'proceed', reason: 'open' }
  }

  // Reuse the layer-4 machinery: a commands-empty floor whose ONLY step is the
  // assertion. runFloor runs zero layers 1–3 then the assertion, applying the
  // identical infra→open / non-zero→fail / 0→pass classification.
  const floorCfg: FloorConfig = { enabled: true, commands: [], stateDeltaCommand: cfg.command, timeoutMs: cfg.timeoutMs }
  let run: FloorRunResult
  try {
    run = deps.run(floorCfg, cwd)
  } catch (err) {
    run = { outcome: 'open', commands: [], openReason: `runFloor threw: ${String(err)}` }
  }
  deps.record(cwd, run, cfg.source)

  if (run.outcome === 'fail') {
    return { action: 'block', run, followUp: buildOutcomeFailFollowUp(run) }
  }
  if (run.outcome === 'open') {
    deps.logMilestone('outcome_open', `gate skipped (fail-open): ${run.openReason}`)
    return { action: 'proceed', reason: 'open', run }
  }
  deps.logMilestone('outcome_pass', `outcome assertion green (source=${cfg.source}): \`${cfg.command}\``)
  return { action: 'proceed', reason: 'green', run }
}

/**
 * Persist one outcome-verification run to objective_floor_runs with the
 * `source='outcome'` DISCRIMINATOR so it is mechanically distinguishable from a
 * code-floor run and never corrupts the code-floor / layer-4 metrics. `layer4_outcome`
 * is deliberately NULL here — that column is a CODE-floor (state-delta layer 4)
 * metric; the outcome verdict lives in the standard `outcome`/`passed` columns.
 * Best-effort: a write failure is logged and swallowed.
 */
export function recordOutcomeRunRow(
  db: Database,
  objective: OutcomeObjectiveRef,
  resolvedStatus: string | null,
  cwd: string,
  run: FloorRunResult,
): void {
  try {
    const gating =
      run.commands.find(c => c.command === run.failedCommand) ??
      run.commands[run.commands.length - 1]
    db.prepare(
      `INSERT INTO objective_floor_runs
        (objective_id, project, iteration, outcome, passed, command, exit_code, commands_json, failed_command, open_reason, cwd, resolved_status, llm_would_have_run, layer4_outcome, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      objective.id,
      objective.project ?? null,
      objective.ai_review_iteration || 0,
      run.outcome,
      run.outcome === 'pass' ? 1 : 0,
      gating?.command ?? null,
      gating?.exitCode ?? null,
      JSON.stringify(
        run.commands.map(c => ({ command: c.command, exitCode: c.exitCode, durationMs: c.durationMs, infraError: c.infraError, layer: c.layer })),
      ),
      run.failedCommand ?? null,
      run.openReason ?? null,
      cwd,
      resolvedStatus,
      0, // outcome verification never had an LLM reviewer queued in its place
      null, // layer4_outcome is a code-floor metric; NULL keeps it uncorrupted
      'outcome', // ← the discriminator: code-floor rows have source NULL
    )
  } catch (err) {
    console.error(`[outcome] failed to record outcome run for obj ${objective.id}:`, err)
  }
}

// ════════════════════════════════════════════════════════════════════════════
// ORACLE HARD MERGE GATE — Stage-C enforcement (obj 700316, Kitchen-Loop pilot)
// ════════════════════════════════════════════════════════════════════════════
//
// WHAT. When the `kitchen_loop_oracle_gate` flag is ON, the regression oracle
// (spec/cc-oracle.mjs, QUICK mode) runs as a HARD gate UNDER the LLM reviewer for
// command-center-infra PRs: a non-GREEN oracle verdict BLOCKS the merge/floor and
// bounces the worker, exactly like a red deterministic floor. The oracle answers
// "is command-center-infra at least as good as before this iteration?" — a
// regression the per-author compile+test floor cannot see.
//
// HARD BLAST-RADIUS RULE (non-negotiable). This gate applies ONLY to the
// command-center-infra pilot. EVERY other repo/workspace (example / example2 /
// example-project / anything) is UNAFFECTED whether the flag is on or off — the
// scope guard (`isCommandCenterTarget`) is checked in `isOracleGateActiveForObjective`,
// which the callers gate on BEFORE entering the oracle branch. A regression here
// would block real business work, so the scope guard is proven by test.
//
// SAFETY (mirrors the deterministic floor's discipline):
//   1. Feature flag — OFF by default (env CC_KITCHEN_LOOP_ORACLE_GATE or a
//      `kitchen_loop_oracle_gate` settings row, seeded OFF by sibling worker CW1).
//      A missing row is treated as OFF. OFF ⇒ the gate is never entered ⇒ behaviour
//      byte-for-byte identical to today.
//   2. Scope guard — even when the flag is on, the gate only arms for
//      project === 'command-center-infra'.
//   3. Fail-safe-OPEN — the oracle is executed through the SAME runFloor/execRunner
//      classifier as the floor: a clean non-zero exit (RED verdict) BLOCKS, any
//      infra failure (node missing, oracle crash, timeout) fails-safe-OPEN (logs +
//      proceeds), exit 0 (GREEN) passes. An oracle bug can never wedge the board.

/** The pilot project the Stage-C enforcement gates are scoped to. */
export const COMMAND_CENTER_PROJECT = 'command-center-infra'

/**
 * Scope guard for ALL Stage-C enforcement (oracle gate + review-enforce). True ONLY
 * for the command-center-infra pilot — every other repo/workspace returns false, so
 * no enforcement path can ever gate a non-pilot objective. This is the single
 * chokepoint the blast-radius rule depends on.
 */
export function isCommandCenterTarget(project: string | null | undefined): boolean {
  return project === COMMAND_CENTER_PROJECT
}

function oracleBoolEnv(v: string | undefined): boolean {
  const s = (v || '').toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/**
 * True iff the oracle hard gate flag is ON (env OR settings). OFF by default; a
 * missing `kitchen_loop_oracle_gate` row is OFF. The flag row is SEEDED by sibling
 * worker CW1 in db/index.ts — this module only READS it (never edits db/index.ts).
 */
export function isOracleGateEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (oracleBoolEnv(env.CC_KITCHEN_LOOP_ORACLE_GATE)) return true
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'kitchen_loop_oracle_gate'")
      .get() as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

/** Minimal objective shape the oracle gate keys on. */
export interface OracleObjectiveRef {
  project: string | null
}

/**
 * The oracle gate is active for an objective iff the flag is ON **and** the target
 * is the command-center-infra pilot. The scope guard is INSIDE this predicate so a
 * caller that gates on it (poller + self-claim route) can never enter the oracle
 * branch for a non-pilot objective — the blast-radius guarantee.
 */
export function isOracleGateActiveForObjective(
  db: Database,
  objective: OracleObjectiveRef,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isOracleGateEnabled(db, env) && isCommandCenterTarget(objective.project)
}

/**
 * The oracle invocation. QUICK mode is the default (no flag); `--json` emits the
 * machine-readable verdict summary on stdout. The decision is driven by the EXIT
 * CODE (0 iff GREEN / every check passed, 1 iff RED / regressed) via runFloor's
 * classifier — NOT by parsing the LLM-free verdict string — so the gate is exactly
 * as deterministic as the floor.
 */
export const ORACLE_COMMAND = 'node spec/cc-oracle.mjs --json'

/** Shared oracle-gate decision (used by BOTH the poller and the self-claim route). */
export interface OracleGateDeps {
  /** Resolve the cwd the oracle runs in (the worktree/repo root holding spec/). MAY THROW. */
  resolveCwd: () => string
  /** Execute the oracle (inject runFloor or a fake). Receives a commands-empty FloorConfig. */
  run: (cfg: FloorConfig, cwd: string) => FloorRunResult
  /** Persist the run (best-effort; receives the cwd used). */
  record?: (cwd: string, run: FloorRunResult) => void
  /** Emit an activity_log milestone. */
  logMilestone: (title: string, detail: string) => void
  /** Optional per-run timeout override (ms). */
  timeoutMs?: number
}

export type OracleGateDecision =
  | { action: 'proceed'; reason: 'green' | 'open'; run?: FloorRunResult }
  | { action: 'block'; run: FloorRunResult; followUp: string }

/**
 * Run the regression oracle as a commands-empty layer-4 floor whose ONLY step is
 * ORACLE_COMMAND, then classify with the floor's exact infra→open / non-zero→block /
 * 0→proceed rules. Returns `block` ONLY on a clean non-zero exit (RED verdict);
 * every infra problem returns `proceed` (fail-safe-OPEN) so an oracle bug can never
 * wedge a transition. Activation (isOracleGateActiveForObjective, incl. the scope
 * guard) is the CALLER's responsibility — this function assumes the gate is active
 * and only runs→classifies, mirroring evaluateOutcomeGate.
 */
export function evaluateOracleGate(deps: OracleGateDeps): OracleGateDecision {
  let cwd: string
  try {
    cwd = deps.resolveCwd()
  } catch (err) {
    deps.logMilestone('oracle_open', `cwd resolution threw; oracle gate skipped (fail-open): ${String(err)}`)
    return { action: 'proceed', reason: 'open' }
  }

  const floorCfg: FloorConfig = { enabled: true, commands: [], stateDeltaCommand: ORACLE_COMMAND, timeoutMs: deps.timeoutMs }
  let run: FloorRunResult
  try {
    run = deps.run(floorCfg, cwd)
  } catch (err) {
    run = { outcome: 'open', commands: [], openReason: `oracle run threw: ${String(err)}` }
  }
  deps.record?.(cwd, run)

  if (run.outcome === 'fail') {
    return { action: 'block', run, followUp: buildOracleFailFollowUp(run) }
  }
  if (run.outcome === 'open') {
    deps.logMilestone('oracle_open', `oracle gate skipped (fail-open): ${run.openReason}`)
    return { action: 'proceed', reason: 'open', run }
  }
  deps.logMilestone('oracle_pass', 'regression oracle verdict GREEN (at-least-as-good)')
  return { action: 'proceed', reason: 'green', run }
}

/** Build the follow-up routed back to the worker when the oracle verdict is non-GREEN. */
export function buildOracleFailFollowUp(run: FloorRunResult): string {
  return [
    '## Regression Oracle — FAILED (verdict: RED / regressed)',
    '',
    'The command-center-infra regression oracle (`spec/cc-oracle.mjs`, QUICK mode) returned',
    'a **non-GREEN** verdict: this iteration is **not** at-least-as-good as before — a live',
    'API/DB/lifecycle ground-truth check that previously passed now FAILS. This is an',
    '**automatic fail** — the oracle sits under the AI review as a hard merge gate, so the',
    'objective cannot advance until the oracle is GREEN again. Fix the regression (do not',
    'weaken the oracle) and continue.',
    '',
    `**Oracle command:** \`${run.failedCommand ?? ORACLE_COMMAND}\``,
    '',
    '```',
    run.failingOutput || '(no output captured)',
    '```',
  ].join('\n')
}
