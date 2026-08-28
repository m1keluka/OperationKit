/**
 * Deterministic floor runner, flags, config, and command execution —
 * extracted from deterministic-floor.ts (behavior frozen).
 *
 * Gate decisions live in deterministic-floor-gate.ts; outcome/oracle in
 * deterministic-floor-outcome.ts.
 */
// ── Deterministic floor (ST1 / roadmap P1+P2) ──────────────────────────────
//
// A poller-run CI step that sits UNDER the LLM reviewer on the worker→done path.
// It runs the linked project's deterministic checks (tsc --noEmit + build + test)
// and treats the worker's process-exit as a *claim* to be verified, not a
// completion. A clean non-zero exit from any check is an AUTOMATIC fail routed
// back to the worker — the LLM verdict cannot override a red floor (the reviewer
// never even spawns when the floor is red).
//
// Three hard guards make a floor bug incapable of wedging the board:
//   1. Feature flag  — OFF by default (env CC_DETERMINISTIC_FLOOR_ENABLED or a
//      `deterministic_floor_enabled` settings row). OFF ⇒ behaviour identical to today.
//   2. Per-project opt-in — even when the flag is on, the floor only runs for a
//      project with an explicit `floor_config:<project>` settings row. No config
//      ⇒ NO-OP for that project.
//   3. Fail-safe-OPEN — any *infrastructure* failure (command-not-found, exec
//      crash, timeout, malformed config) logs loudly, SKIPS the gate, and lets the
//      objective proceed exactly as it would today. Only a *clean* non-zero exit
//      from a check is a legitimate gating fail.
//
// The core decision logic (runFloor / classifyCommandResult) takes an injectable
// runner so it is unit-testable without spawning real processes.

import { execSync } from 'child_process'
import fs from 'fs'
import type { Database } from 'better-sqlite3'
import type { Objective } from '@command-center/shared'

export interface FloorConfig {
  /** Must be true for the floor to run; mirrors the per-project opt-in. */
  enabled: boolean
  /** Ordered check commands, e.g. ['npx tsc --noEmit', 'npm run build', 'npm test']. */
  commands: string[]
  /**
   * KL-4 LAYER 4 (state-delta / E2E ground truth) — OPTIONAL, per-project opt-in.
   *
   * Layers 1–3 (compile/build + test, all in `commands`) verify the artifact is
   * internally consistent; they cannot catch the "38 green tests, dead service"
   * failure where the code compiles, the author's own tests pass, but the REAL
   * outcome the author cannot fake (an API response, a DB row, a rendered DOM /
   * screenshot) never happens. This command runs as a FOURTH step AFTER every
   * `commands` entry passes, and asserts that real state delta. A clean non-zero
   * exit is a gating FAIL attributed to layer 4 (`gatingLayer === 4`).
   *
   * It is OPT-IN: a project that omits it falls back to layers 1–2 UNCHANGED (be
   * honest about where the verifier is blind — subjective UI/UX and non-enumerable
   * work should NOT set this; see docs/floor-pilot-ENABLEMENT.md). The on-chain /
   * DeFi oracle variant of KL-4 is deliberately NOT implemented — we keep the
   * 4-layer principle, not the crypto impl.
   */
  stateDeltaCommand?: string
  /** Optional cwd override; default resolved from the objective's project/worktree. */
  cwd?: string
  /** Per-command wall-clock timeout (ms). Defaults to DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number
}

export type FloorOutcome = 'pass' | 'fail' | 'open'

export interface FloorCommandResult {
  command: string
  /** Process exit code; null when the process never produced one (spawn failure). */
  exitCode: number | null
  /** Combined, truncated stdout+stderr (and message on error). */
  output: string
  durationMs: number
  /** Set when this command failed for an INFRASTRUCTURE reason (→ fail-safe-open). */
  infraError?: string
  /**
   * Which floor layer produced this result: undefined/1–3 for the `commands`
   * checks (compile/build/test), 4 for the optional state-delta step. Lets the
   * proof row and follow-up distinguish a layer-4 catch from a layers-1–3 catch.
   */
  layer?: number
}

export interface FloorRunResult {
  outcome: FloorOutcome
  commands: FloorCommandResult[]
  /** The command whose clean non-zero exit produced a gating fail. */
  failedCommand?: string
  /** Truncated output of the failing command (routed to the worker). */
  failingOutput?: string
  /** Why the floor failed open (infra). */
  openReason?: string
  /**
   * KL-4 layer-4 (state-delta) outcome, when a `stateDeltaCommand` was configured
   * AND layers 1–3 all passed (so layer 4 actually ran). Undefined when no
   * state-delta command was set, or when layers 1–3 short-circuited before it.
   * 'pass' = real outcome asserted; 'fail' = the outcome the author could not fake
   * did NOT happen (gating); 'open' = infra fail-safe-open on the state-delta step.
   */
  layer4Outcome?: FloorOutcome
  /** The state-delta command that ran as layer 4 (when layer4Outcome is set). */
  layer4Command?: string
  /** The layer (1–3 vs 4) whose clean non-zero exit produced a gating fail. */
  gatingLayer?: number
}

/** Per-command wall-clock ceiling — a hung check can never block a transition. */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_OUTPUT_CHARS = 16_000

function truncate(s: string): string {
  if (!s) return ''
  return s.length > MAX_OUTPUT_CHARS
    ? s.slice(0, MAX_OUTPUT_CHARS) + `\n…[truncated ${s.length - MAX_OUTPUT_CHARS} chars]`
    : s
}

// ── Feature flag ────────────────────────────────────────────────────────────
/** True iff the floor is globally enabled (env OR settings). OFF by default. */
export function isFloorEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  const envFlag = (env.CC_DETERMINISTIC_FLOOR_ENABLED || '').toLowerCase()
  if (envFlag === '1' || envFlag === 'true' || envFlag === 'yes' || envFlag === 'on') return true
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'deterministic_floor_enabled'")
      .get() as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

// ── Hard kill switch ──────────────────────────────────────────────────────────
/**
 * Belt-and-suspenders global OFF. When set (env CC_DETERMINISTIC_FLOOR_KILLED or a
 * `deterministic_floor_killed` settings row), NO floor runs anywhere — regardless
 * of the global flag OR any per-project opt-in row. This exists because
 * command-center self-hosts: one settings write must be able to instantly disarm
 * the gate across the whole board if a pilot ever misbehaves, without code edits.
 */
export function isFloorKilled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  const envKill = (env.CC_DETERMINISTIC_FLOOR_KILLED || '').toLowerCase()
  if (envKill === '1' || envKill === 'true' || envKill === 'yes' || envKill === 'on') return true
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'deterministic_floor_killed'")
      .get() as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

// ── Per-project activation (pilot opt-in WITHOUT flipping the global default) ───
/**
 * True iff a per-project floor opt-in row is PRESENT and non-empty. Cheap presence
 * check — it deliberately does NOT JSON.parse/validate the row, so a malformed
 * config still reaches getFloorConfig (which throws) and the caller fails-safe-OPEN
 * rather than this silently reporting "not opted in". This presence is the lever
 * that lets ONE pilot project arm the floor without changing the global default.
 */
export function hasProjectFloorOptIn(db: Database, project: string | null): boolean {
  if (!project) return false
  try {
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(`floor_config:${project}`) as { value?: string } | undefined
    return typeof row?.value === 'string' && row.value.trim().length > 0
  } catch {
    return false
  }
}

/**
 * The floor runs for `project` iff it is not globally killed AND (the global flag
 * is on OR this project has its own opt-in row).
 *
 * This is the mechanism that satisfies "enable the floor for one pilot project via
 * a DB row WITHOUT changing the global default": `deterministic_floor_enabled`
 * stays `0` in code, and a single pilot is armed purely by inserting its
 * `floor_config:<project>` row. The original semantics (global flag ON ⇒ active for
 * every opted-in project) are preserved unchanged.
 */
export function isFloorActiveForProject(
  db: Database,
  project: string | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isFloorKilled(db, env)) return false
  return isFloorEnabled(db, env) || hasProjectFloorOptIn(db, project)
}

// ── Per-project opt-in config ────────────────────────────────────────────────
/**
 * Resolve the per-project floor config. Returns null when the project is not
 * opted in (missing row, disabled, or no commands) — that is a NO-OP, NOT a fail.
 * THROWS on a malformed config row so the caller can fail-safe-OPEN (log + skip).
 */
export function getFloorConfig(db: Database, project: string | null): FloorConfig | null {
  if (!project) return null
  let raw: string | undefined
  try {
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(`floor_config:${project}`) as { value?: string } | undefined
    raw = row?.value
  } catch {
    return null // settings table unreadable → treat as not opted in
  }
  if (!raw) return null
  // A parse error here is an INFRA problem, not "not opted in" — let it throw so
  // the poller fails open loudly rather than silently skipping a configured gate.
  const parsed = JSON.parse(raw) as Partial<FloorConfig>
  if (!parsed || parsed.enabled !== true) return null
  const commands = Array.isArray(parsed.commands)
    ? parsed.commands.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
    : []
  if (commands.length === 0) return null
  // KL-4 layer 4 (optional). Accept the roadmap/settings key `state_delta_command`
  // and the camelCase `stateDeltaCommand` (config-shape consistency); a project
  // that sets neither falls back to layers 1–2 unchanged. A non-string / blank
  // value is treated as "not configured" rather than throwing — an empty layer-4
  // command must never be able to gate.
  const rawDelta =
    (parsed as Record<string, unknown>).stateDeltaCommand ??
    (parsed as Record<string, unknown>).state_delta_command
  const stateDeltaCommand =
    typeof rawDelta === 'string' && rawDelta.trim().length > 0 ? rawDelta : undefined
  return {
    enabled: true,
    commands,
    stateDeltaCommand,
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
    timeoutMs: typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : undefined,
  }
}

// ── Command runner ────────────────────────────────────────────────────────────
export type CommandRunner = (command: string, cwd: string, timeoutMs: number) => FloorCommandResult

/** Real runner — runs a command via the shell and classifies the result. */
export const execRunner: CommandRunner = (command, cwd, timeoutMs) => {
  const start = Date.now()
  try {
    const out = execSync(command, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return { command, exitCode: 0, output: truncate(out || ''), durationMs: Date.now() - start }
  } catch (err: unknown) {
    const e = err as { status?: number | null; signal?: string; killed?: boolean; code?: string; stdout?: string; stderr?: string; message?: string }
    const status = typeof e.status === 'number' ? e.status : null
    const combined = truncate(`${e.stdout || ''}${e.stderr || ''}${(!e.stdout && !e.stderr && e.message) || ''}`)
    const timedOut = e.killed === true || e.signal === 'SIGTERM' || e.signal === 'SIGKILL'
    // INFRA failures → no exit code (spawn failure), timeout/kill, or shell
    // "command not found" (127) / "not executable" (126). These must fail OPEN.
    if (timedOut || status === null || status === 126 || status === 127) {
      return {
        command,
        exitCode: status,
        output: combined,
        durationMs: Date.now() - start,
        infraError: timedOut ? 'timeout' : status === null ? (e.code || 'spawn-failure') : `shell-exit-${status}`,
      }
    }
    // Clean non-zero exit from the check itself → legitimate gating fail.
    return { command, exitCode: status, output: combined, durationMs: Date.now() - start }
  }
}

/** Invoke the runner for one command, normalising a throw into an infra result. */
function runOne(runner: CommandRunner, command: string, cwd: string, timeoutMs: number, layer?: number): FloorCommandResult {
  let r: FloorCommandResult
  try {
    r = runner(command, cwd, timeoutMs)
  } catch (err) {
    // A runner that throws (rather than returning a result) is itself infra.
    r = { command, exitCode: null, output: String(err), durationMs: 0, infraError: 'runner-threw' }
  }
  if (layer !== undefined) r.layer = layer
  return r
}

/**
 * Run the configured checks in order. Stops at the first non-pass command.
 * - any infra failure (infraError, or exit 126/127) → OPEN (fail-safe)
 * - any clean non-zero exit                          → FAIL (gate the objective)
 * - all commands exit 0 (layers 1–3)                 → run LAYER 4 if configured
 *
 * KL-4 LAYER 4 (state-delta) runs ONLY after every `commands` entry passes, since
 * asserting a real outcome is meaningless if the artifact didn't even compile/test.
 * Its result is attributed to layer 4 (`gatingLayer === 4`, `layer4Outcome`), so a
 * layer-4 catch is distinguishable from a layers-1–3 catch in the proof row and the
 * worker follow-up. When no `stateDeltaCommand` is configured the function behaves
 * EXACTLY as before (layers 1–2 only) — the fallback path is untouched.
 */
export function runFloor(config: FloorConfig, cwd: string, runner: CommandRunner = execRunner): FloorRunResult {
  const results: FloorCommandResult[] = []
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  for (const command of config.commands) {
    const r = runOne(runner, command, cwd, timeoutMs)
    results.push(r)
    if (r.infraError) {
      return { outcome: 'open', commands: results, openReason: `${r.infraError} on \`${command}\`` }
    }
    if (r.exitCode !== 0) {
      return { outcome: 'fail', commands: results, failedCommand: command, failingOutput: r.output, gatingLayer: 1 }
    }
  }

  // ── Layers 1–3 all green. LAYER 4 — state-delta / E2E ground truth (optional). ──
  const delta = config.stateDeltaCommand
  if (!delta) {
    // No layer-4 configured → behaviour identical to the pre-layer-4 floor.
    return { outcome: 'pass', commands: results }
  }
  const d = runOne(runner, delta, cwd, timeoutMs, 4)
  results.push(d)
  if (d.infraError) {
    // Infra problem running the state-delta → fail-safe-OPEN (advisory gate; never
    // block a transition on a layer-4 infra failure). Layers 1–3 still passed.
    return {
      outcome: 'open',
      commands: results,
      openReason: `${d.infraError} on layer-4 \`${delta}\``,
      layer4Outcome: 'open',
      layer4Command: delta,
    }
  }
  if (d.exitCode !== 0) {
    // The real outcome the author cannot fake did NOT happen → gating FAIL (layer 4).
    return {
      outcome: 'fail',
      commands: results,
      failedCommand: delta,
      failingOutput: d.output,
      gatingLayer: 4,
      layer4Outcome: 'fail',
      layer4Command: delta,
    }
  }
  return { outcome: 'pass', commands: results, layer4Outcome: 'pass', layer4Command: delta }
}

/**
 * Resolve the directory the floor should run in. For PR-mode objectives the
 * worker did its work inside `/tmp/cc-worktree-<id>/`, so the floor must validate
 * that tree, not the deployed checkout. Falls back to the canonical project path.
 */
export function resolveFloorCwd(
  objective: Pick<Objective, 'id' | 'create_pr'>,
  resolveWorkdir: () => string,
): string {
  if (objective.create_pr) {
    const wt = `/tmp/cc-worktree-${objective.id}`
    try {
      if (fs.existsSync(wt)) return wt
    } catch {
      /* fall through */
    }
  }
  return resolveWorkdir()
}

/** Build the follow-up message routed back to the worker on a red floor. */
export function buildFloorFailFollowUp(run: FloorRunResult): string {
  const isLayer4 = run.gatingLayer === 4
  const header = isLayer4
    ? [
        '## Deterministic Floor — FAILED (Layer 4: state-delta)',
        '',
        'Your code compiled and the tests passed, but the **layer-4 state-delta check**',
        'failed: the real outcome it asserts (an API response, a DB row, a rendered',
        'result — the thing a passing unit test cannot fake) did **not** happen. This is',
        'an **automatic fail** — the floor sits under the AI review, so the objective',
        'cannot advance until the asserted outcome actually occurs. Fix the behaviour',
        '(not the assertion) below and continue.',
      ]
    : [
        '## Deterministic Floor — FAILED',
        '',
        'A required check command exited non-zero. This is an **automatic fail** — the',
        'deterministic floor sits under the AI review, so the objective cannot advance',
        'until these checks pass. Fix the errors below and continue.',
      ]
  const parts: string[] = [
    ...header,
    '',
    `**Failing command:** \`${run.failedCommand}\``,
    '',
    '```',
    run.failingOutput || '(no output captured)',
    '```',
  ]
  const passed = run.commands.filter(c => c.exitCode === 0).map(c => c.command)
  if (passed.length) {
    parts.push('', `Checks that passed before the failure: ${passed.map(c => `\`${c}\``).join(', ')}`)
  }
  return parts.join('\n')
}

