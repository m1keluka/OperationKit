// ── Anti-signal canary harness (obj-2376, Rec #2 of the obj-2319 loop audit) ──
//
// The D9 false-pass instrument (gate_false_pass / false-pass.ts) is WIRED but
// COLD: it only ever gets a row when a HUMAN reopens a done objective. So the
// review gate's correctness is measured only REACTIVELY, after a bad merge is
// noticed. The Kitchen Loop's hardest empirical lesson (KL-7) is to PROACTIVELY
// "test the tests": inject KNOWN-BAD inputs and verify the gate REJECTS them. An
// escaped Tier-1 bad input is a critical alarm.
//
// This harness feeds each known-bad canary fixture (app/server/fixtures/canaries/)
// through the REAL deterministic-floor evaluation path (`runFloor`) and records
// the outcome:
//   • rejected (clean non-zero exit → floor outcome 'fail')  → the gate worked.
//   • escaped  (floor outcome 'pass' on a known-bad fixture) → a FALSE PASS:
//        writes a gate_false_pass row with source='canary' (recordCanaryFalsePass)
//        and raises a CRITICAL alarm.
//   • open     (infra fail-safe-open → floor outcome 'open') → inconclusive; logged,
//        not counted as a catch and not an escape.
//
// SAFETY (this modifies the platform that grades every objective):
//   • Evaluates against the in-process deterministic floor only — NO Claude review
//     SESSION is spawned, so a run is bounded and cheap (node + tsc per fixture).
//   • Canary rows are namespaced with source='canary' + a canary_id and have NULL
//     objective_id/review_id, so they cannot corrupt the human-reopen metric
//     (getFalsePassRate filters to source='reopen').
//   • The SCHEDULED run is gated behind `canary_harness_enabled` (default 0 in
//     code) plus a kill switch; nothing auto-fires on deploy. Manual invocation
//     (runCanaryHarness) is always allowed for tests / Operator-triggered runs.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { runFloor, type CommandRunner, type FloorOutcome, execRunner } from './deterministic-floor.js'
import { recordCanaryFalsePass } from './false-pass.js'

// ── Fixture model ─────────────────────────────────────────────────────────────
export interface CanaryManifest {
  id: string
  tier: number
  description: string
  brokenKind: string
  /** Always 'reject' for a known-bad canary; declared in the fixture for clarity. */
  expectedVerdict: 'reject'
  /** Deterministic check commands run IN ORDER in the fixture dir. */
  commands: string[]
  /**
   * KL-4 layer-4 canary (obj 2508): an OPTIONAL state-delta command run as the 4th
   * floor step. A layer-4 canary passes `commands` (compile + the author's own test)
   * but FAILS this state-delta assertion — proving the floor catches a wrong real
   * outcome that layers 1–3 miss. Omitted on the Tier-1 (layers-1–3) canaries.
   */
  state_delta_command?: string
}

export interface Canary extends CanaryManifest {
  /** Absolute path to the fixture directory (the cwd its commands run in). */
  dir: string
}

/** Per-canary outcome after feeding it through the real floor. */
export interface CanaryResult {
  id: string
  tier: number
  /** floor outcome: 'fail' = rejected (good), 'pass' = ESCAPE, 'open' = inconclusive. */
  floorOutcome: FloorOutcome
  /** True when the known-bad canary was correctly rejected (floorOutcome === 'fail'). */
  rejected: boolean
  /** True when the known-bad canary slipped through (floorOutcome === 'pass'). */
  escaped: boolean
  /** gate_false_pass row id written on an escape (null otherwise). */
  falsePassRowId: number | null
}

export interface CanaryRunSummary {
  total: number
  caught: number
  escaped: number
  opened: number
  /** caught / (caught + escaped); 1 when no conclusive runs. Conclusive excludes 'open'. */
  catchRate: number
  results: CanaryResult[]
  /** canary_runs row id for this run. */
  runRowId: number | null
  /**
   * Stage-C enforcement (obj 700316). True when `kitchen_loop_review_enforce` is ON
   * for this run (the command-center pilot). When false the harness is log-only
   * (current behaviour): an escape raises an alarm but is NOT a blocking signal.
   */
  enforcing: boolean
  /**
   * The would-block decision turned REAL. True iff `enforcing` AND ≥1 canary escaped
   * — i.e. under enforcement a known-bad fixture slipped the gate, which is a hard
   * block (a merge gate consuming this run must NOT advance). Always false when
   * enforcement is OFF, so today's behaviour is byte-for-byte unchanged.
   */
  blocked: boolean
}

// ── Fixture discovery ─────────────────────────────────────────────────────────
/**
 * Resolve the fixtures/canaries directory. Walks up from this module's location
 * until it finds a `fixtures/canaries` dir, so it works both from TS source
 * (vitest/tsx under src/) and the compiled dist tree. Falls back to an explicit
 * override.
 */
export function resolveCanaryDir(override?: string): string {
  if (override) return override
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'fixtures', 'canaries')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('canary-harness: could not locate fixtures/canaries directory')
}

/** Load and validate every canary manifest under the fixtures dir. */
export function loadCanaries(override?: string): Canary[] {
  const base = resolveCanaryDir(override)
  const entries = fs
    .readdirSync(base, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort()

  const canaries: Canary[] = []
  for (const name of entries) {
    const manifestPath = path.join(base, name, 'manifest.json')
    if (!fs.existsSync(manifestPath)) continue
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as CanaryManifest
    if (m.expectedVerdict !== 'reject') {
      throw new Error(`canary ${name}: expectedVerdict must be 'reject' (got ${m.expectedVerdict})`)
    }
    if (!Array.isArray(m.commands) || m.commands.length === 0) {
      throw new Error(`canary ${name}: manifest.commands must be a non-empty array`)
    }
    canaries.push({ ...m, dir: path.join(base, name) })
  }
  return canaries
}

// ── Feature flag + kill switch (scheduled run is OFF by default) ──────────────
function boolEnv(v: string | undefined): boolean {
  const s = (v || '').toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

/** True iff the SCHEDULED canary harness is enabled (env OR settings). OFF by default. */
export function isCanaryHarnessEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (boolEnv(env.CC_CANARY_HARNESS_ENABLED)) return true
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'canary_harness_enabled'")
      .get() as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

/**
 * Stage-C enforcement (obj 700316). True iff `kitchen_loop_review_enforce` is ON
 * (env OR settings). OFF by default; a missing row (CW1 seeds it OFF in db/index.ts,
 * which this module never edits) is OFF. When OFF, a canary escape is log-only
 * (alarm) exactly as before; when ON, an escape becomes a blocking signal
 * (CanaryRunSummary.blocked). The canary harness exclusively exercises the
 * command-center-infra gate, so it is command-center-scoped by construction — no
 * other workspace's merges run through it.
 */
export function isReviewEnforceEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (boolEnv(env.CC_KITCHEN_LOOP_REVIEW_ENFORCE)) return true
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'kitchen_loop_review_enforce'")
      .get() as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

/** Hard kill switch — disables the scheduled harness regardless of the enable flag. */
export function isCanaryHarnessKilled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (boolEnv(env.CC_CANARY_HARNESS_KILLED)) return true
  try {
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'canary_harness_killed'")
      .get() as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

// ── Critical alarm on an escape ───────────────────────────────────────────────
/**
 * Raise a CRITICAL alarm: a Tier-1 known-bad canary was NOT rejected by the gate.
 * Logs loudly to the console and writes an activity_log 'error' row so it surfaces
 * in the AlertBell UI. Best-effort; never throws into the run.
 */
export function raiseCanaryAlarm(db: Database, canary: { id: string; tier: number }, detail: string): void {
  const msg = `🚨 CRITICAL: Tier-${canary.tier} canary '${canary.id}' ESCAPED the gate (false pass). ${detail}`
  console.error(`[canary-harness] ${msg}`)
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES ('command-center-infra', 'personal', NULL, NULL, 'error', ?, ?)`,
    ).run(`Canary escape: ${canary.id}`, msg)
  } catch (err) {
    console.error('[canary-harness] failed to write alarm to activity_log:', err)
  }
}

// ── The runner ────────────────────────────────────────────────────────────────
export interface RunCanaryOptions {
  /** Override the fixtures dir (tests). */
  fixturesDir?: string
  /** Inject the command runner (tests simulate an escape by returning exit 0). */
  runner?: CommandRunner
  /** Subset of canary ids to run (default: all). */
  only?: string[]
  /** Bookkeeping workspace for escape rows. */
  workspace?: string
  /** What triggered this run, recorded on the canary_runs row. */
  trigger?: 'manual' | 'scheduled' | 'test'
  /**
   * Stage-C enforcement override (obj 700316). When omitted, enforcement is read
   * from the `kitchen_loop_review_enforce` flag (isReviewEnforceEnabled). Pass an
   * explicit boolean in tests to exercise both branches deterministically.
   */
  enforce?: boolean
}

/**
 * Feed every (selected) canary through the REAL floor and record the outcome.
 * Writes one canary_runs summary row, a gate_false_pass(source='canary') row per
 * escape, and raises a critical alarm per escape. Returns the run summary.
 *
 * This is the MANUAL entry point — always runnable (tests, Operator-triggered). The
 * scheduled wrapper (startCanaryHarnessScheduler) guards on the enable flag.
 */
export function runCanaryHarness(db: Database = getDb(), opts: RunCanaryOptions = {}): CanaryRunSummary {
  const runner = opts.runner ?? execRunner
  const workspace = opts.workspace ?? 'personal'
  const trigger = opts.trigger ?? 'manual'
  // Stage-C: enforcement is read from the flag unless explicitly overridden (tests).
  const enforcing = opts.enforce ?? isReviewEnforceEnabled(db)
  let canaries = loadCanaries(opts.fixturesDir)
  if (opts.only && opts.only.length) {
    const want = new Set(opts.only)
    canaries = canaries.filter(c => want.has(c.id))
  }

  const results: CanaryResult[] = []
  let caught = 0
  let escaped = 0
  let opened = 0

  for (const canary of canaries) {
    const run = runFloor(
      { enabled: true, commands: canary.commands, stateDeltaCommand: canary.state_delta_command },
      canary.dir,
      runner,
    )
    let rejected = false
    let escapedThis = false
    let falsePassRowId: number | null = null

    if (run.outcome === 'fail') {
      rejected = true
      caught++
    } else if (run.outcome === 'open') {
      opened++
    } else {
      // outcome === 'pass' → the known-bad canary was NOT rejected. ESCAPE.
      escapedThis = true
      escaped++
      falsePassRowId = recordCanaryFalsePass({ canary_id: canary.id, workspace, tier: canary.tier })
      raiseCanaryAlarm(db, canary, `expected reject; floor returned 'pass'. gate_false_pass id=${falsePassRowId}`)
    }

    results.push({
      id: canary.id,
      tier: canary.tier,
      floorOutcome: run.outcome,
      rejected,
      escaped: escapedThis,
      falsePassRowId,
    })
  }

  const conclusive = caught + escaped
  const catchRate = conclusive > 0 ? caught / conclusive : 1
  const detail = results
    .map(r => `${r.id}=${r.escaped ? 'ESCAPE' : r.rejected ? 'caught' : 'open'}`)
    .join(', ')

  let runRowId: number | null = null
  try {
    const res = db
      .prepare(
        `INSERT INTO canary_runs (total, caught, escaped, opened, catch_rate, trigger, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(canaries.length, caught, escaped, opened, catchRate, trigger, detail)
    runRowId = Number(res.lastInsertRowid)
  } catch (err) {
    console.error('[canary-harness] failed to record canary_runs row:', err)
  }

  // Stage-C (obj 700316): under enforcement an escape is no longer log-only — it is
  // a hard block. When enforcement is OFF this is always false, so the harness keeps
  // its current alarm-only behaviour byte-for-byte.
  const blocked = enforcing && escaped > 0

  if (escaped > 0) {
    console.error(
      `[canary-harness] run complete: ${escaped}/${canaries.length} canaries ESCAPED — catch-rate ${(catchRate * 100).toFixed(0)}%` +
        (blocked ? ' — ENFORCING: BLOCK (escape is a hard failure)' : ' — log-only (enforcement off)'),
    )
  } else {
    console.log(`[canary-harness] run complete: ${caught} caught, ${opened} open, 0 escaped — catch-rate ${(catchRate * 100).toFixed(0)}%`)
  }

  return { total: canaries.length, caught, escaped, opened, catchRate, results, runRowId, enforcing, blocked }
}

// ── Surfaced metric ───────────────────────────────────────────────────────────
export interface CanaryCatchRate {
  /** Total canary escapes recorded in the window (gate_false_pass source='canary'). */
  escapes: number
  /** Number of harness runs in the window. */
  runs: number
  /** Latest run's catch rate (1 = all caught), or null when no runs in window. */
  latestCatchRate: number | null
  /** Latest run timestamp, or null. */
  latestRunAt: string | null
}

/**
 * Surface the canary catch-rate over the trailing window — the proactive
 * companion to getFalsePassRate. Reads the canary_runs summary table and the
 * source='canary' escape rows. (Exposed via the intelligence route.)
 */
export function getCanaryCatchRate(windowDays = 30, db: Database = getDb()): CanaryCatchRate {
  const offset = `-${Math.max(1, Math.floor(windowDays))} days`
  const escapesRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM gate_false_pass
        WHERE source = 'canary' AND reopened_at >= datetime('now', ?)`,
    )
    .get(offset) as { n: number }
  const runsRow = db
    .prepare(`SELECT COUNT(*) AS n FROM canary_runs WHERE created_at >= datetime('now', ?)`)
    .get(offset) as { n: number }
  const latest = db
    .prepare(
      `SELECT catch_rate, created_at FROM canary_runs
        WHERE created_at >= datetime('now', ?) ORDER BY id DESC LIMIT 1`,
    )
    .get(offset) as { catch_rate: number; created_at: string } | undefined

  return {
    escapes: escapesRow?.n ?? 0,
    runs: runsRow?.n ?? 0,
    latestCatchRate: latest ? latest.catch_rate : null,
    latestRunAt: latest ? latest.created_at : null,
  }
}

// ── Scheduled wrapper (OFF by default) ────────────────────────────────────────
let schedulerTimer: ReturnType<typeof setInterval> | null = null
/** Default scheduled cadence: every 6h. Only ticks when the flag is ON. */
const SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Start the scheduled canary harness. NO-OP unless `canary_harness_enabled` is set
 * (settings row or CC_CANARY_HARNESS_ENABLED) — so NOTHING auto-fires on deploy.
 * Each tick re-checks the flag + kill switch, so Operator can arm/disarm live without a
 * restart. Safe to call unconditionally at boot.
 */
export function startCanaryHarnessScheduler(db: Database = getDb()): void {
  if (schedulerTimer) return
  schedulerTimer = setInterval(() => {
    try {
      if (isCanaryHarnessKilled(db) || !isCanaryHarnessEnabled(db)) return
      runCanaryHarness(db, { trigger: 'scheduled' })
    } catch (err) {
      console.error('[canary-harness] scheduled run failed:', err)
    }
  }, SCHEDULE_INTERVAL_MS)
  // Don't keep the event loop alive solely for this timer.
  if (typeof schedulerTimer.unref === 'function') schedulerTimer.unref()
  console.log('[canary-harness] scheduler armed (ticks are NO-OP until canary_harness_enabled=1)')
}

export function stopCanaryHarnessScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
  }
}
