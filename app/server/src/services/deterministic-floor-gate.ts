/**
 * Deterministic-floor gate decision and persistence —
 * extracted from deterministic-floor.ts (behavior frozen).
 *
 * runFloor lives in deterministic-floor-run.ts; outcome/oracle in
 * deterministic-floor-outcome.ts.
 */
import type { Database } from 'better-sqlite3'
import {
  type FloorConfig,
  type FloorRunResult,
  buildFloorFailFollowUp,
} from './deterministic-floor-run.js'

// ── Shared gate decision (used by BOTH the poller and the working→done route) ──
//
// The floor lives on more than one transition. The poller gates the session-end
// path (working→review/ai_review/done); the status route gates the SELF-CLAIM
// path (a session/delegator PATCHing its own objective straight to `done`). Both
// must apply the identical decision so a self-claimed completion cannot bypass a
// gate the poller would have enforced. This function centralises that decision
// with injected IO so it stays unit-testable (mirrors the injectable runner).
//
// Activation (isFloorActiveForProject) is the CALLER's responsibility — this
// function assumes the project is active and only resolves config→run→verdict.

export interface FloorGateDeps {
  /** Resolve the per-project config; wraps getFloorConfig and MAY THROW on a
   *  malformed row (→ fail-safe-OPEN). Returns null when the project isn't opted in. */
  getConfig: () => FloorConfig | null
  /** Resolve the cwd to run checks in; MAY THROW (resolveWorkdir fails closed). */
  resolveCwd: () => string
  /** Execute the floor (inject runFloor or a fake). */
  run: (cfg: FloorConfig, cwd: string) => FloorRunResult
  /** Persist the run to objective_floor_runs (best-effort; receives the cwd used). */
  record: (cwd: string, run: FloorRunResult) => void
  /** Emit an activity_log milestone. */
  logMilestone: (title: string, detail: string) => void
}

export type FloorGateDecision =
  | { action: 'proceed'; reason: 'green' | 'open' | 'not-opted-in' | 'cfg-error'; run?: FloorRunResult }
  | { action: 'block'; run: FloorRunResult; followUp: string }

/**
 * Resolve config → run checks → classify. Returns `block` ONLY on a clean red
 * floor (a check exited non-zero); every infra problem, parse error, or
 * not-opted-in case returns `proceed` (fail-safe-OPEN) so a floor bug can never
 * wedge a transition. The caller performs the actual status mutation: on `block`
 * it must NOT advance the objective (bounce it back to the worker / reject the
 * self-claim); on `proceed` it advances exactly as it would have without a floor.
 */
export function evaluateFloorGate(deps: FloorGateDeps): FloorGateDecision {
  let cfg: FloorConfig | null
  try {
    cfg = deps.getConfig()
  } catch (err) {
    // Malformed config row = INFRA failure → fail-safe-OPEN (log + skip).
    deps.logMilestone('floor_open', `config parse error; gate skipped (fail-open): ${String(err)}`)
    return { action: 'proceed', reason: 'cfg-error' }
  }
  if (!cfg) return { action: 'proceed', reason: 'not-opted-in' }

  let cwd: string
  try {
    cwd = deps.resolveCwd()
  } catch (err) {
    deps.logMilestone('floor_open', `resolveWorkdir threw; gate skipped (fail-open): ${String(err)}`)
    return { action: 'proceed', reason: 'open' }
  }

  let run: FloorRunResult
  try {
    run = deps.run(cfg, cwd)
  } catch (err) {
    run = { outcome: 'open', commands: [], openReason: `runFloor threw: ${String(err)}` }
  }
  deps.record(cwd, run)

  if (run.outcome === 'fail') {
    return { action: 'block', run, followUp: buildFloorFailFollowUp(run) }
  }
  if (run.outcome === 'open') {
    deps.logMilestone('floor_open', `gate skipped (fail-open): ${run.openReason}`)
    return { action: 'proceed', reason: 'open', run }
  }
  deps.logMilestone('floor_pass', `all ${cfg.commands.length} check(s) green`)
  return { action: 'proceed', reason: 'green', run }
}

// ── Shared persistence helpers (single source of truth for floor writes) ──────
// Both the poller (session-end path) and the status route (self-claim path) write
// the SAME proof row + milestone shape, so they live here rather than being
// duplicated. Best-effort: a write failure is logged and swallowed — the floor is
// an advisory gate and must never crash a transition.

/** The minimal objective shape needed to attribute a floor run / milestone. */
export interface FloorObjectiveRef {
  id: number
  project: string | null
  workspace: string
  session_id: string | null
  ai_review_iteration?: number | null
}

/**
 * Persist one floor run to objective_floor_runs. `resolvedStatus` is where the
 * objective WOULD advance on a green floor; `llmWouldHaveRun` records whether an
 * LLM reviewer would otherwise have run (so a red floor with this=1 is the
 * "floor caught what the optimist would have passed" signal). Writes the
 * denormalised proof columns (project/passed/command/exit_code) added in obj 2335.
 */
export function recordFloorRunRow(
  db: Database,
  objective: FloorObjectiveRef,
  resolvedStatus: string | null,
  cwd: string,
  run: FloorRunResult,
  llmWouldHaveRun: boolean,
): void {
  try {
    const gating =
      run.commands.find(c => c.command === run.failedCommand) ??
      run.commands[run.commands.length - 1]
    db.prepare(
      `INSERT INTO objective_floor_runs
        (objective_id, project, iteration, outcome, passed, command, exit_code, commands_json, failed_command, open_reason, cwd, resolved_status, llm_would_have_run, layer4_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      llmWouldHaveRun ? 1 : 0,
      // KL-4: NULL when no layer-4 (state-delta) command ran (project not opted into
      // layer 4, or layers 1–3 short-circuited first) → existing rows/projects
      // unchanged; 'pass'|'fail'|'open' when the state-delta step actually executed.
      run.layer4Outcome ?? null,
    )
  } catch (err) {
    console.error(`[floor] failed to record floor run for obj ${objective.id}:`, err)
  }
}

/** Emit a floor milestone to activity_log (event_type constrained to 'milestone'). */
export function logFloorMilestoneRow(
  db: Database,
  objective: FloorObjectiveRef,
  title: string,
  detail: string,
): void {
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, 'milestone', ?, ?)`,
    ).run(objective.project || 'unknown', objective.workspace, objective.id, objective.session_id, title, detail)
  } catch (err) {
    console.error(`[floor] failed to log milestone '${title}' for obj ${objective.id}:`, err)
  }
}

