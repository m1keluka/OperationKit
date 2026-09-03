// ── Kitchen Loop driver — Phase-0 SHADOW (obj 700099) ───────────────────────
//
// Assembles the Kitchen Loop's six phases (Backlog → Ideate → Triage → Execute →
// Polish → Regress) ON TOP of command-center's existing board, as a thin scheduled
// DRIVER — not a second execution runtime. The board's existing lifecycle
// (queue → working → ai_review → review → done) already IS Execute/Polish/Regress;
// this service adds only the missing front-half (Backlog/Ideate/Triage) plus the
// drift store + three pause gates that supervise the loop.
//
// PHASE 0 = SHADOW ONLY. This file ships flag-gated OFF and, even when ON, takes
// NO board action:
//   • Ideate is DRY-RUN — it computes and LOGS the tickets it WOULD post to
//     POST /api/internal/objectives, and writes NONE.
//   • the regression oracle is invoked READ-ONLY (spec/cc-oracle.mjs --json).
//   • a loop_drift_metrics snapshot is written each Regress (pure rollup).
//   • the three pause gates (G1 regression / G2 backpressure / G3 starvation) are
//     evaluated and LOGGED, but take no action (no pause, no kill-switch flip).
//
// HARD SAFETY (mirrors deterministic-floor / canary-harness / governance.ts):
// every behavior is OFF by default and gated by `kitchen_loop_enabled` (flag) +
// `kitchen_loop_killed` (instant disarm), each readable from env OR settings,
// fail-closed. With the flag OFF, startKitchenLoop() returns before arming any
// timer — server boot and the existing test suite are byte-for-byte unchanged.
//
// Pure decision logic (nextPhase, evaluatePauseGates, computeIdeateTickets) is
// separated from DB/process side effects so it is exhaustively unit-testable
// without a live board, the oracle, or a scheduler.

import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { getCanaryCatchRate } from './canary-harness.js'
import { getFalsePassRate } from './false-pass.js'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function envFlagOn(env: NodeJS.ProcessEnv, name: string): boolean {
  return TRUE_VALUES.has((env[name] || '').toLowerCase())
}

function settingOn(db: Database, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

// ── Feature flags (env overrides settings; fail-closed on any error) ──────────

/** Kitchen Loop driver enabled? OFF by default. */
export function isKitchenLoopEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_KITCHEN_LOOP_ENABLED')) return true
  return settingOn(db, 'kitchen_loop_enabled')
}

/** Instant disarm — belt-and-suspenders global OFF. */
export function isKitchenLoopKilled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_KITCHEN_LOOP_KILLED')) return true
  return settingOn(db, 'kitchen_loop_killed')
}

// ── Stage-C live-execution flags (NEW — default OFF) ──────────────────────────
// Each governs the OFFENSIVE half of the loop and is independent of the others.
// With EVERY one OFF (the shipped default) the loop is byte-for-byte identical to
// the Phase-0 SHADOW behavior (PR 180): ideate dry-runs, gates log-only.

/**
 * Ideate LIVE-EMIT enabled? OFF ⇒ ideate stays dry-run (computes + logs, writes
 * nothing). ON ⇒ ideate POSTs the computed tickets to the board — but ONLY for
 * the command-center pilot scope, subject to the WIP ceiling, dedup, and the
 * Stage-0 human gate (rows land in 'queue', which never auto-spawns a session).
 */
export function isIdeateLiveEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_KITCHEN_LOOP_IDEATE_LIVE')) return true
  return settingOn(db, 'kitchen_loop_ideate_live')
}

/**
 * Pause-gate ENFORCEMENT enabled? OFF ⇒ a tripped gate is logged only (current
 * shadow behavior). ON ⇒ a tripped gate sets the loop phase to 'paused' and
 * records the reason; the machine then holds until re-armed (or killed).
 */
export function isGatesEnforceEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_KITCHEN_LOOP_GATES_ENFORCE')) return true
  return settingOn(db, 'kitchen_loop_gates_enforce')
}

/** Default ideate WIP ceiling when the `kitchen_loop_wip_cap` setting is absent/invalid. */
export const DEFAULT_WIP_CAP = 8

/** Open-objective statuses that count toward the WIP ceiling and dedup window. */
export const OPEN_STATUSES = ['planning', 'queue', 'working', 'ai_review', 'review'] as const

/**
 * Resolve the live ideate WIP ceiling from the `kitchen_loop_wip_cap` setting,
 * falling back to DEFAULT_WIP_CAP (8) on absence or any malformed value.
 */
export function getWipCap(db: Database): number {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('kitchen_loop_wip_cap') as
      | { value?: string }
      | undefined
    const n = parseInt(row?.value ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_WIP_CAP
  } catch {
    return DEFAULT_WIP_CAP
  }
}

/** Count board objectives still open (used for the live-ideate WIP ceiling). */
export function countOpenObjectives(db: Database): number {
  try {
    const placeholders = OPEN_STATUSES.map(() => '?').join(',')
    return (db
      .prepare(`SELECT COUNT(*) AS n FROM objectives WHERE status IN (${placeholders})`)
      .get(...OPEN_STATUSES) as { n: number }).n
  } catch {
    return 0
  }
}

/**
 * Dedup guard: true when an OPEN objective with this exact title already exists.
 * Title is the deterministic external id for a kitchen-loop ticket (computeIdeate
 * emits a fixed, stable title per coverage cell), so a same-title open row means
 * the ticket is already on the board and must NOT be re-emitted.
 */
export function openObjectiveTitleExists(db: Database, title: string): boolean {
  try {
    const placeholders = OPEN_STATUSES.map(() => '?').join(',')
    const row = db
      .prepare(`SELECT 1 AS x FROM objectives WHERE title = ? AND status IN (${placeholders}) LIMIT 1`)
      .get(title, ...OPEN_STATUSES) as { x: number } | undefined
    return !!row
  } catch {
    return false
  }
}

/**
 * Resolve the recorded `mode` for a phase from the live flags (replaces the old
 * hard-coded 'shadow' literal). 'live' only when that phase's live flag is ON;
 * every other phase — and every phase while its flag is OFF — stays 'shadow'.
 */
export function resolvePhaseMode(
  db: Database,
  phase: KitchenLoopPhase,
  env: NodeJS.ProcessEnv = process.env,
): 'live' | 'shadow' {
  if (phase === 'ideate') return isIdeateLiveEnabled(db, env) ? 'live' : 'shadow'
  if (phase === 'regress') return isGatesEnforceEnabled(db, env) ? 'live' : 'shadow'
  return 'shadow'
}

// ── Phase state machine (pure) ────────────────────────────────────────────────

export const KITCHEN_LOOP_PHASES = [
  'backlog',
  'ideate',
  'triage',
  'execute',
  'polish',
  'regress',
] as const
export type KitchenLoopPhase = (typeof KITCHEN_LOOP_PHASES)[number] | 'paused' | 'monitor_only'

/** Default loop scope for the Phase-0 dogfood pilot (command-center itself). */
export const DEFAULT_SCOPE = 'command-center'
/** Wall-clock tick cadence (slow; dream-cycle style, NOT the 3s state-poller). */
export const KITCHEN_LOOP_TICK_MS = 60_000
/** G1: consecutive RED oracle iterations before a regression pause would trip. */
export const REGRESSION_PAUSE_AFTER = 3
/** G2: open loop-origin WIP ceiling before backpressure would trip. */
export const KITCHEN_LOOP_MAX_OPEN = 12
/** G3: consecutive zero-merged iterations before starvation would trip. */
export const STARVATION_AFTER = 3

/**
 * Pure phase advance: the six phases cycle, with regress rolling back to backlog
 * (next iteration). `paused` / `monitor_only` are terminal holds that only a human
 * (or a re-arm) leaves, so they advance to themselves. Single source of truth the
 * unit test asserts.
 */
export function nextPhase(current: KitchenLoopPhase): KitchenLoopPhase {
  switch (current) {
    case 'backlog':
      return 'ideate'
    case 'ideate':
      return 'triage'
    case 'triage':
      return 'execute'
    case 'execute':
      return 'polish'
    case 'polish':
      return 'regress'
    case 'regress':
      return 'backlog'
    default:
      return current // paused / monitor_only hold until re-armed
  }
}

// ── Ideate (dry-run in shadow) ─────────────────────────────────────────────────

export interface IdeateTicket {
  title: string
  priority: string
  cell: string
  rationale: string
}

/**
 * Compute the AaU tickets Ideate WOULD post this iteration. In Phase-0 SHADOW this
 * output is only LOGGED — nothing is written to the board. The seed backlog is the
 * P0 coverage gaps W3 enumerated for the command-center pilot (the highest-value
 * untested cells). Pure: no DB writes, no network. (Phase-1 will read the live
 * spec/coverage-matrix.yaml minus loop_drift_metrics; that wiring is Mike-gated.)
 */
export function computeIdeateTickets(scope: string): IdeateTicket[] {
  if (scope !== DEFAULT_SCOPE) return []
  return [
    {
      title: 'F5 end-to-end transition over real HTTP (queue→working → DB row + spawn)',
      priority: 'P0',
      cell: 'F5/REST+state-poller/transition',
      rationale: 'Highest-value L4 gap: only the in-process guard is unit-tested today.',
    },
    {
      title: 'F6 spawn ground truth (tmux session + worktree + session_id recorded)',
      priority: 'P0',
      cell: 'F6/session-manager/spawn',
      rationale: 'Assert real spawn artifacts exist, not just that code called spawn.',
    },
    {
      title: 'F1 auth contract (login sets httpOnly cookie, /me round-trips, bad creds 401)',
      priority: 'P0',
      cell: 'F1/REST auth/login',
      rationale: 'No executed HTTP auth test exists.',
    },
    {
      title: 'F9 ai_review gate (reviewer spawns, iteration cap holds at 3, verdict shape)',
      priority: 'P0',
      cell: 'F9/reviews+state-poller/gate',
      rationale: 'Core gate currently exercised only at the unit level.',
    },
  ]
}

// ── Live board emit (Stage-C) ───────────────────────────────────────────────────

/** Pilot project the live-emit lands board rows under (the command-center repo). */
export const PILOT_PROJECT = 'command-center-infra'
/** Pilot workspace for emitted tickets. */
export const PILOT_WORKSPACE = 'personal'
/** Board port the in-process driver POSTs to (localhost-only internal route). */
export const INTERNAL_API_PORT = 3002

export interface BoardEmitItem {
  title: string
  description: string
  project: string
  workspace: string
  category: string
}

/**
 * Map a computed ideate ticket to the board-create payload. No `status` is set, so
 * the row is created in the DB-default 'queue' state — the Stage-0 human gate: a
 * queued objective never auto-spawns a session (there is no queue-drainer; a human
 * must transition it to 'working'), mirroring how strategy-governance parks
 * gated spawns. Category 'kitchen-loop' tags provenance.
 */
export function ticketToBoardItem(t: IdeateTicket): BoardEmitItem {
  return {
    title: t.title,
    description: t.rationale,
    project: PILOT_PROJECT,
    workspace: PILOT_WORKSPACE,
    category: 'kitchen-loop',
  }
}

/**
 * Default board emitter: POST the prepared items to the localhost-only internal
 * create route and return the created objective ids. Best-effort — returns [] on
 * any non-2xx or transport error so a flaky board never wedges a tick. The route
 * requires only localhost origin (no internal secret), and the driver runs
 * in-process, so this call is first-party.
 */
export async function postObjectivesToBoard(
  items: BoardEmitItem[],
  port: number = INTERNAL_API_PORT,
): Promise<number[]> {
  if (!items.length) return []
  try {
    const res = await fetch(`http://localhost:${port}/api/internal/objectives`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(items),
    })
    if (!res.ok) return []
    const json = (await res.json()) as { objectives?: Array<{ id: number }> }
    return (json.objectives ?? []).map((o) => o.id)
  } catch {
    return []
  }
}

// ── Pause gates (pure) ──────────────────────────────────────────────────────────

export interface GateInputs {
  /** Running count of consecutive RED oracle verdicts for this scope. */
  consecutiveRed: number
  /** Open loop-origin WIP (objectives this loop created, still in flight). */
  openWip: number
  /** Consecutive iterations that produced zero merged/accepted loop output. */
  consecutiveZeroMerged: number
}

export interface GateDecision {
  tripped: boolean
  reason: string | null
}

export interface PauseGateDecisions {
  g1Regression: GateDecision
  g2Backpressure: GateDecision
  g3Starvation: GateDecision
}

/**
 * Pure evaluation of the paper's three pause gates (§7.5), each mapped onto an
 * existing primitive's threshold. Returns decisions only — the SHADOW caller LOGS
 * them and takes no action. (In a later Mike-gated phase, g1 would flip
 * kitchen_loop_killed for the scope, g2 would stop Ideate, g3 would drop to
 * monitor_only — none of which Phase-0 does.)
 */
export function evaluatePauseGates(
  input: GateInputs,
  cfg: { regressionAfter?: number; maxOpen?: number; starvationAfter?: number } = {},
): PauseGateDecisions {
  const regressionAfter = cfg.regressionAfter ?? REGRESSION_PAUSE_AFTER
  const maxOpen = cfg.maxOpen ?? KITCHEN_LOOP_MAX_OPEN
  const starvationAfter = cfg.starvationAfter ?? STARVATION_AFTER
  return {
    g1Regression: input.consecutiveRed >= regressionAfter
      ? { tripped: true, reason: `consecutive_red=${input.consecutiveRed} ≥ ${regressionAfter} (would PAUSE scope)` }
      : { tripped: false, reason: null },
    g2Backpressure: input.openWip >= maxOpen
      ? { tripped: true, reason: `open_wip=${input.openWip} ≥ ${maxOpen} (would stop Ideate / drain)` }
      : { tripped: false, reason: null },
    g3Starvation: input.consecutiveZeroMerged >= starvationAfter
      ? { tripped: true, reason: `zero_merged_iters=${input.consecutiveZeroMerged} ≥ ${starvationAfter} (would drop to monitor_only)` }
      : { tripped: false, reason: null },
  }
}

// ── Regression oracle (read-only) ───────────────────────────────────────────────

export interface OracleResult {
  verdict: string
  counts: { pass: number; warn: number; fail: number }
  totalMs?: number
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** spec/cc-oracle.mjs lives at the repo root's spec/ dir (… /app/server/src/services → ../../../../spec). */
export function defaultOraclePath(): string {
  return path.resolve(__dirname, '../../../../spec/cc-oracle.mjs')
}

/**
 * Run the committed regression oracle READ-ONLY in QUICK mode and parse its --json
 * summary. Quick mode never mutates prod state (read-only DB + live API probes + one
 * P0 Vitest slice). Returns null on any failure (missing oracle, spawn error, bad
 * JSON) so a flaky oracle never corrupts a drift snapshot — the snapshot just records
 * nulls for the oracle-derived columns. Never throws.
 */
export function runOracleReadOnly(oraclePath: string = defaultOraclePath()): OracleResult | null {
  try {
    if (!fs.existsSync(oraclePath)) return null
    const r = spawnSync('node', [oraclePath, '--json'], {
      timeout: 120_000,
      encoding: 'utf8',
      env: { ...process.env },
    })
    const out = (r.stdout || '').trim()
    if (!out) return null
    const parsed = JSON.parse(out) as OracleResult
    if (!parsed || typeof parsed.verdict !== 'string' || !parsed.counts) return null
    return parsed
  } catch {
    return null
  }
}

// ── Drift snapshot (pure rollup of already-existing telemetry) ──────────────────

export interface DriftSnapshot {
  scope: string
  iteration: number
  test_count: number | null
  pass_rate: number | null
  oracle_pass_rate: number | null
  bug_discovery_rate: number | null
  blocked_combos: number | null
  canary_catch_rate: number | null
  canary_escape_rate: number | null
  false_pass_rate: number | null
  coverage_filled: number | null
  coverage_total: number | null
  consecutive_red: number
  detail: string
}

/**
 * Build a drift snapshot from telemetry that already exists. Read-only: oracle
 * --json (passed in), getCanaryCatchRate, getFalsePassRate, blocked_objectives count.
 * Pure assembly given its inputs (oracle injectable for tests).
 */
export function buildDriftSnapshot(
  db: Database,
  scope: string,
  iteration: number,
  oracle: OracleResult | null,
  prevConsecutiveRed: number,
): DriftSnapshot {
  const oraclePassRate = oracle && oracle.counts
    ? oracle.counts.pass / Math.max(1, oracle.counts.pass + oracle.counts.warn + oracle.counts.fail)
    : null
  const isRed = oracle ? oracle.verdict.startsWith('RED') : false
  const consecutiveRed = isRed ? prevConsecutiveRed + 1 : 0

  let canaryCatch: number | null = null
  let canaryEscapeRate: number | null = null
  try {
    const c = getCanaryCatchRate(30, db)
    canaryCatch = c.latestCatchRate
    canaryEscapeRate = c.latestCatchRate != null ? 1 - c.latestCatchRate : null
  } catch {
    /* read-only best-effort */
  }

  let falsePass: number | null = null
  try {
    const fp = getFalsePassRate(30)
    // Roll the per-workspace rows up to a single scope-level figure (max = worst).
    falsePass = fp.length ? Math.max(...fp.map((r) => r.rate)) : 0
  } catch {
    /* read-only best-effort */
  }

  let blockedCombos: number | null = null
  try {
    blockedCombos = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM blocked_objectives
           WHERE resolved_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))`,
      )
      .get() as { n: number }).n
  } catch {
    /* read-only best-effort */
  }

  return {
    scope,
    iteration,
    test_count: null, // oracle --json does not yet emit an assertion count; null in shadow
    pass_rate: oraclePassRate,
    oracle_pass_rate: oraclePassRate,
    bug_discovery_rate: null,
    blocked_combos: blockedCombos,
    canary_catch_rate: canaryCatch,
    canary_escape_rate: canaryEscapeRate,
    false_pass_rate: falsePass,
    coverage_filled: null,
    coverage_total: null,
    consecutive_red: consecutiveRed,
    detail: JSON.stringify({
      oracle_verdict: oracle?.verdict ?? 'unavailable',
      oracle_counts: oracle?.counts ?? null,
      shadow: true,
    }),
  }
}

function insertDriftSnapshot(db: Database, s: DriftSnapshot): void {
  db.prepare(
    `INSERT INTO loop_drift_metrics
       (scope, iteration, test_count, pass_rate, oracle_pass_rate, bug_discovery_rate,
        blocked_combos, canary_catch_rate, canary_escape_rate, false_pass_rate,
        coverage_filled, coverage_total, consecutive_red, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    s.scope, s.iteration, s.test_count, s.pass_rate, s.oracle_pass_rate, s.bug_discovery_rate,
    s.blocked_combos, s.canary_catch_rate, s.canary_escape_rate, s.false_pass_rate,
    s.coverage_filled, s.coverage_total, s.consecutive_red, s.detail,
  )
}

// ── Tick — advance one phase per call, SHADOW side effects only ─────────────────

export interface TickDeps {
  /** Injected oracle runner (defaults to the real read-only spawn). */
  runOracle?: (oraclePath?: string) => OracleResult | null
  /** Injected logger (defaults to console.log). */
  log?: (msg: string) => void
  /** Loop scope. Defaults to command-center. */
  scope?: string
  /** Env source for flag resolution (defaults to process.env). */
  env?: NodeJS.ProcessEnv
  /**
   * Injected board emitter (defaults to the real localhost POST). Receives the
   * already-filtered (scope-pinned, WIP-checked, deduped) board items and returns
   * the created objective ids. Injectable so tests assert the exact payload
   * without touching the network or the live board.
   */
  emitToBoard?: (items: BoardEmitItem[]) => Promise<number[]>
}

/**
 * Advance the kitchen-loop state machine ONE step for `scope`.
 *
 * Each phase's behavior is resolved from its live flag (default OFF ⇒ SHADOW):
 *  - ideate  → SHADOW: compute + LOG would-be tickets, write NONE.
 *              LIVE (`kitchen_loop_ideate_live`): POST the computed tickets to the
 *              board — but ONLY for the command-center pilot scope, ONLY while open
 *              WIP < `kitchen_loop_wip_cap`, skipping any ticket whose title already
 *              exists open (dedup). Rows land in 'queue' (Stage-0 human gate: no
 *              auto-spawn). Emitted ids recorded in detail.emitted_ids.
 *  - regress → run oracle read-only, write ONE loop_drift_metrics snapshot, then
 *              evaluate the three pause gates. SHADOW: LOG only. LIVE
 *              (`kitchen_loop_gates_enforce`): a tripped gate sets the run phase to
 *              'paused' with the reason recorded; the machine then holds.
 *
 * With every live flag OFF this is byte-for-byte identical to PR 180 shadow.
 * Reads the latest open run row for the scope and rolls it forward; opens a fresh
 * iteration at `backlog` when none exists. Best-effort and never throws (a tick
 * failure must never wedge the boot path). Async because the live emit awaits a
 * POST; the shadow path performs no awaits, so it completes synchronously.
 */
export async function tickKitchenLoop(db: Database = getDb(), deps: TickDeps = {}): Promise<void> {
  const scope = deps.scope ?? DEFAULT_SCOPE
  const log = deps.log ?? ((m: string) => console.log(m))
  const runOracle = deps.runOracle ?? runOracleReadOnly
  const env = deps.env ?? process.env
  const emitToBoard = deps.emitToBoard ?? postObjectivesToBoard

  try {
    const last = db
      .prepare(
        `SELECT id, iteration, phase FROM kitchen_loop_runs
          WHERE scope = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(scope) as { id: number; iteration: number; phase: KitchenLoopPhase } | undefined

    let iteration: number
    let phase: KitchenLoopPhase
    if (!last) {
      iteration = 1
      phase = 'backlog'
    } else if (last.phase === 'paused' || last.phase === 'monitor_only') {
      log(`[kitchen-loop] scope=${scope} held in '${last.phase}' — re-arm required, no advance`)
      return
    } else if (last.phase === 'regress') {
      iteration = last.iteration + 1
      phase = 'backlog'
    } else {
      iteration = last.iteration
      phase = nextPhase(last.phase)
    }

    // Close the prior open row.
    if (last && !['paused', 'monitor_only'].includes(last.phase)) {
      db.prepare(`UPDATE kitchen_loop_runs SET ended_at = datetime('now') WHERE id = ?`).run(last.id)
    }

    // `mode` is resolved per-phase from the live flags (replaces the old hard-coded
    // 'shadow' literal). It stays 'shadow' for every phase whose live flag is OFF.
    let mode: 'live' | 'shadow' = resolvePhaseMode(db, phase, env)
    const detail: Record<string, unknown> = { shadow: mode === 'shadow' }

    if (phase === 'ideate') {
      const tickets = computeIdeateTickets(scope)
      detail.would_post = tickets.length
      // LIVE-EMIT requires the flag ON *and* the pilot scope — double-pinned so we
      // never write a board row for any workspace other than command-center. (Below
      // the flag, computeIdeateTickets already returns [] for non-pilot scopes.)
      const liveEmit = isIdeateLiveEnabled(db, env) && scope === DEFAULT_SCOPE
      if (!liveEmit) {
        // SHADOW dry-run — byte-for-byte identical to PR 180.
        mode = 'shadow'
        detail.shadow = true
        log(
          `[kitchen-loop] SHADOW ideate scope=${scope} iter=${iteration} — WOULD POST ${tickets.length} ticket(s), wrote NONE:`,
        )
        for (const t of tickets) log(`[kitchen-loop]   • [${t.priority}] ${t.title}  (${t.cell})`)
      } else {
        mode = 'live'
        detail.shadow = false
        const wipCap = getWipCap(db)
        const openWip = countOpenObjectives(db)
        if (openWip >= wipCap) {
          // WIP ceiling — emit NOTHING this iteration (backpressure).
          detail.emitted_ids = []
          detail.emit_skipped = 'wip_ceiling'
          detail.open_wip = openWip
          detail.wip_cap = wipCap
          log(
            `[kitchen-loop] LIVE ideate scope=${scope} iter=${iteration} — WIP ceiling hit (open=${openWip} ≥ cap=${wipCap}), emitted NONE`,
          )
        } else {
          // DEDUP — never re-emit a ticket whose title is already open on the board.
          const fresh = tickets.filter((t) => !openObjectiveTitleExists(db, t.title))
          const deduped = tickets.length - fresh.length
          const ids = fresh.length ? await emitToBoard(fresh.map(ticketToBoardItem)) : []
          detail.emitted_ids = ids
          detail.deduped = deduped
          detail.open_wip = openWip
          detail.wip_cap = wipCap
          log(
            `[kitchen-loop] LIVE ideate scope=${scope} iter=${iteration} — emitted ${ids.length} ticket(s) to board (queue/human-gated), deduped=${deduped}, ids=[${ids.join(
              ',',
            )}]`,
          )
        }
      }
    }

    if (phase === 'regress') {
      const oracle = runOracle(defaultOraclePath())
      log(
        `[kitchen-loop] SHADOW regress scope=${scope} iter=${iteration} — oracle(read-only) verdict=${
          oracle?.verdict ?? 'unavailable'
        }`,
      )
      const prevRed = (db
        .prepare(
          `SELECT consecutive_red AS r FROM loop_drift_metrics WHERE scope = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(scope) as { r: number } | undefined)?.r ?? 0
      const snapshot = buildDriftSnapshot(db, scope, iteration, oracle, prevRed)
      insertDriftSnapshot(db, snapshot)
      log(
        `[kitchen-loop] SHADOW regress scope=${scope} iter=${iteration} — wrote loop_drift_metrics (oracle_pass_rate=${
          snapshot.oracle_pass_rate ?? 'null'
        } consecutive_red=${snapshot.consecutive_red})`,
      )

      // Evaluate the three pause gates.
      const openWip = countOpenObjectives(db)
      const gates = evaluatePauseGates({
        consecutiveRed: snapshot.consecutive_red,
        openWip,
        consecutiveZeroMerged: 0, // not tracked in shadow; logged as informational
      })
      detail.gates = gates
      const enforce = isGatesEnforceEnabled(db, env)
      const tripped = Object.entries(gates).filter(([, g]) => g.tripped)
      if (enforce && tripped.length) {
        // ENFORCE: a tripped gate PAUSES the loop. Override the phase to 'paused'
        // so the run row records the hold; the machine then holds until re-armed.
        mode = 'live'
        detail.shadow = false
        detail.paused = true
        detail.pause_reasons = tripped.map(([name, g]) => ({ gate: name, reason: g.reason }))
        for (const [name, g] of Object.entries(gates)) {
          log(
            `[kitchen-loop] ENFORCE gate ${name}: ${
              g.tripped ? `TRIPPED — ${g.reason} (PAUSING loop)` : 'ok'
            }`,
          )
        }
        log(
          `[kitchen-loop] ENFORCE scope=${scope} iter=${iteration} — loop PAUSED by ${tripped
            .map(([n]) => n)
            .join(', ')}; re-arm required to resume`,
        )
        phase = 'paused'
      } else {
        // SHADOW (or ENFORCE-on but nothing tripped): LOG only — no action.
        if (enforce) {
          mode = 'live'
          detail.shadow = false
          for (const [name, g] of Object.entries(gates)) {
            log(`[kitchen-loop] ENFORCE gate ${name}: ${g.tripped ? `TRIPPED — ${g.reason}` : 'ok'}`)
          }
        } else {
          for (const [name, g] of Object.entries(gates)) {
            log(
              `[kitchen-loop] SHADOW gate ${name}: ${
                g.tripped ? `WOULD-TRIP — ${g.reason}` : 'ok'
              } (no action taken in shadow)`,
            )
          }
        }
      }
    }

    db.prepare(
      `INSERT INTO kitchen_loop_runs (scope, iteration, phase, mode, detail)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(scope, iteration, phase, mode, JSON.stringify(detail))
  } catch (err) {
    console.error('[kitchen-loop] tick failed (non-fatal):', err)
  }
}

// ── Scheduler (OFF by default) ──────────────────────────────────────────────────

let schedulerTimer: ReturnType<typeof setInterval> | null = null

/**
 * Start the Kitchen Loop driver. COMPLETE NO-OP unless `kitchen_loop_enabled` is
 * set (settings row or CC_KITCHEN_LOOP_ENABLED) — so NOTHING arms on deploy and the
 * boot path is byte-for-byte unchanged while the flag is OFF. When enabled, each
 * slow tick re-checks the flag + kill switch (so Mike can arm/disarm live without a
 * restart) and advances the SHADOW state machine one phase. Safe to call
 * unconditionally at boot.
 */
export function startKitchenLoop(db: Database = getDb()): void {
  if (schedulerTimer) return
  if (isKitchenLoopKilled(db) || !isKitchenLoopEnabled(db)) {
    // Flag OFF ⇒ do not even arm the timer. No-op.
    return
  }
  schedulerTimer = setInterval(() => {
    try {
      if (isKitchenLoopKilled(db) || !isKitchenLoopEnabled(db)) return
      // Async tick — fire-and-forget; its own try/catch swallows tick errors, and
      // the .catch() here backstops any rejection from the awaited live emit so an
      // unhandled rejection can never escape the timer.
      void tickKitchenLoop(db).catch((err) =>
        console.error('[kitchen-loop] scheduled tick failed:', err),
      )
    } catch (err) {
      console.error('[kitchen-loop] scheduled tick failed:', err)
    }
  }, KITCHEN_LOOP_TICK_MS)
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref()
  console.log(
    '[kitchen-loop] driver armed — Stage-C live-execution layer present but flag-gated OFF ' +
      '(ideate dry-run unless kitchen_loop_ideate_live; gates log-only unless kitchen_loop_gates_enforce)',
  )
}

export function stopKitchenLoop(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
}
