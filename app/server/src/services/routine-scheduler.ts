import { getDb, resolveStrategyId } from '../db/index.js'
import { broadcast } from '../ws/index.js'
import { getDefaultModelId } from './model-registry.js'
import { notify } from './notifier.js'
import { MAX_CONCURRENT_SESSIONS, type Objective } from '@command-center/shared'

const TICK_MS = 60 * 1000
const PORT = parseInt(process.env.PORT || '3002', 10)

// A routine is "overdue" once it has missed a scheduled fire by more than this
// grace window. The grace absorbs the gap between a cron-match minute and the
// tick that fires it, plus any brief in-flight/concurrency back-pressure, so a
// healthy routine never flaps into the overdue state. Tuned for daily jobs:
// long enough not to false-alarm, short enough to catch a real stall same-hour.
const OVERDUE_GRACE_MS = 60 * 60 * 1000
// The scheduler ticks every 60s and stamps `routines_last_tick`. If the most
// recent stamp is older than this, the scheduler loop itself is dead/stalled —
// the failure mode no per-routine check can self-report (a dead loop can't
// alert). The health endpoint surfaces this for an external watcher.
const TICK_STALE_MS = 3 * TICK_MS
const HEARTBEAT_KEY = 'routines_last_tick'

let tickTimer: ReturnType<typeof setInterval> | null = null

// Last skip reason per routine id (in-memory, best-effort context for the
// health endpoint). Set when a cron-matched fire is blocked by a guard.
const lastSkipReason = new Map<number, string>()

export interface RoutineRow {
  id: number
  name: string
  cron_expr: string
  objective_template: string
  enabled: number
  max_queue_depth: number
  last_run_at: string | null
  created_at: string
  // obj 2384 — nullable link to an owning Strategy node (a delegate_mode
  // objective). When set, runs spawn as children of the strategy and feed their
  // summary back into its context. NULL ⇒ standalone routine (unchanged).
  strategy_objective_id?: number | null
}

// ── Minimal 5-field cron matcher ──────────────────────────────────────────
// Fields: minute hour day-of-month month day-of-week.
// Supports: * , - / (lists, ranges, steps — e.g. "*/15", "1-5", "0,30", "1-5/2").
// Day-of-week: 0-7 where both 0 and 7 mean Sunday.
// TIMEZONE: matches against SERVER LOCAL TIME (new Date() getHours()/getMinutes()
// etc.). On this VPS the container runs in UTC, so cron expressions are
// effectively UTC unless the host TZ changes.
// Vixie-cron rule: when BOTH day-of-month and day-of-week are restricted
// (neither is '*'), the date matches if EITHER field matches.

function matchField(field: string, value: number, min: number, max: number): boolean {
  for (const part of field.split(',')) {
    if (!part) continue
    let range = part
    let step = 1
    const slash = part.indexOf('/')
    if (slash !== -1) {
      range = part.slice(0, slash)
      step = parseInt(part.slice(slash + 1), 10)
      if (!Number.isFinite(step) || step <= 0) continue
    }
    let lo: number
    let hi: number
    if (range === '*') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = parseInt(a, 10)
      hi = parseInt(b, 10)
    } else {
      lo = parseInt(range, 10)
      // "N/step" (step on a bare number) means N through max, per cron convention
      hi = slash !== -1 ? max : lo
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    if (value >= lo && value <= hi && (value - lo) % step === 0) return true
  }
  return false
}

const FIELD_PART_RE = /^(\*|\d{1,2}(-\d{1,2})?)(\/\d{1,2})?$/

/** Returns an error string if the expression is malformed, null if valid. */
export function validateCronExpr(expr: string): string | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return 'cron_expr must have exactly 5 fields (min hour dom month dow)'
  for (const field of fields) {
    for (const part of field.split(',')) {
      if (!FIELD_PART_RE.test(part)) return `invalid cron field part: '${part}'`
    }
  }
  return null
}

export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  const [min, hour, dom, month, dow] = fields

  if (!matchField(min, date.getMinutes(), 0, 59)) return false
  if (!matchField(hour, date.getHours(), 0, 23)) return false
  if (!matchField(month, date.getMonth() + 1, 1, 12)) return false

  const day = date.getDay()
  const domMatch = matchField(dom, date.getDate(), 1, 31)
  const dowMatch = matchField(dow, day, 0, 7) || (day === 0 && matchField(dow, 7, 0, 7))

  if (dom === '*' && dow === '*') return true
  if (dom === '*') return dowMatch
  if (dow === '*') return domMatch
  return domMatch || dowMatch // vixie OR rule
}

// ── Cadence helpers (browser-facing schedule display) ───────────────────────

/**
 * The next wall-clock instant strictly after `from` at which `expr` fires.
 * Steps minute-by-minute (cheap for daily/hourly routines) against the same
 * `cronMatches` used by the live tick, so display and execution never diverge.
 * Returns null for a malformed expression or if nothing matches within a year.
 */
export function nextRunAt(expr: string, from: Date = new Date()): Date | null {
  if (validateCronExpr(expr) !== null) return null
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1) // strictly after `from`
  const MAX_MINUTES = 366 * 24 * 60
  for (let i = 0; i < MAX_MINUTES; i++) {
    if (cronMatches(expr, cursor)) return new Date(cursor)
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  return null
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * Human-readable cadence for the common routine shapes (daily / hourly /
 * every-N-min / weekdays / single weekday). Falls back to the raw expression
 * for anything it doesn't model, so the UI always shows something truthful.
 */
export function describeCron(expr: string): string {
  if (validateCronExpr(expr) !== null) return expr
  const [min, hour, dom, month, dow] = expr.trim().split(/\s+/)
  // Only model the day-agnostic shapes; anything pinned to a day-of-month or
  // month is left raw (e.g. monthly schedules).
  if (dom !== '*' || month !== '*') return expr

  const everyN = /^\*\/(\d{1,2})$/.exec(min)
  if (everyN && hour === '*' && dow === '*') return `Every ${everyN[1]} min`

  const minNum = /^\d{1,2}$/.test(min) ? parseInt(min, 10) : null
  if (minNum === null) return expr

  if (hour === '*' && dow === '*') return `Hourly at :${pad2(minNum)}`

  const hourNum = /^\d{1,2}$/.test(hour) ? parseInt(hour, 10) : null
  if (hourNum === null) return expr
  const time = `${pad2(hourNum)}:${pad2(minNum)} UTC`

  if (dow === '*') return `Daily at ${time}`
  if (dow === '1-5') return `Weekdays at ${time}`
  if (/^\d$/.test(dow)) {
    const d = parseInt(dow, 10) % 7 // 7 == Sunday
    return `${DOW_NAMES[d]} at ${time}`
  }
  return expr
}

// ── Health ───────────────────────────────────────────────────────────────────

/**
 * The most recent wall-clock instant at or before `from` at which `expr` fires.
 * Steps minute-by-minute backwards (same matcher as the live tick). Returns null
 * for a malformed expression or if nothing matched within the lookback window
 * (default 36h — comfortably covers daily and weekday cadences).
 */
export function mostRecentRunAt(expr: string, from: Date = new Date(), lookbackMinutes = 36 * 60): Date | null {
  if (validateCronExpr(expr) !== null) return null
  const cursor = new Date(from)
  cursor.setSeconds(0, 0)
  for (let i = 0; i <= lookbackMinutes; i++) {
    if (cronMatches(expr, cursor)) return new Date(cursor)
    cursor.setMinutes(cursor.getMinutes() - 1)
  }
  return null
}

export interface RoutineHealth {
  id: number
  name: string
  enabled: boolean
  cron_expr: string
  cadence: string
  last_run_at: string | null
  expected_last_fire: string | null
  next_run_at: string | null
  overdue: boolean
  minutes_overdue: number
  last_skip_reason: string | null
}

/**
 * A routine is overdue when it MISSED its most recent scheduled fire: the last
 * cron-match at/before now is newer than its last_run_at, and that miss is older
 * than the grace window. Because fireRoutine stamps last_run_at at fire time, a
 * healthy routine (and a legitimately long in-flight run) is never overdue — only
 * a routine that was blocked/never-ran since its scheduled time trips this.
 */
export function computeRoutineHealth(routine: RoutineRow, now: Date = new Date()): RoutineHealth {
  const expected = routine.enabled ? mostRecentRunAt(routine.cron_expr, now) : null
  const lastRun = routine.last_run_at ? new Date(routine.last_run_at) : null
  let overdue = false
  let minutesOverdue = 0
  if (expected) {
    const missed = !lastRun || lastRun.getTime() < expected.getTime()
    if (missed && now.getTime() - expected.getTime() >= OVERDUE_GRACE_MS) {
      overdue = true
      minutesOverdue = Math.round((now.getTime() - expected.getTime()) / 60000)
    }
  }
  return {
    id: routine.id,
    name: routine.name,
    enabled: !!routine.enabled,
    cron_expr: routine.cron_expr,
    cadence: describeCron(routine.cron_expr),
    last_run_at: routine.last_run_at,
    expected_last_fire: expected ? expected.toISOString() : null,
    next_run_at: routine.enabled ? (nextRunAt(routine.cron_expr, now)?.toISOString() ?? null) : null,
    overdue,
    minutes_overdue: minutesOverdue,
    last_skip_reason: lastSkipReason.get(routine.id) ?? null,
  }
}

export interface RoutinesHealthReport {
  ok: boolean
  globally_enabled: boolean
  last_tick: string | null
  tick_stale: boolean
  overdue_count: number
  routines: RoutineHealth[]
}

/** Aggregate health for every routine + scheduler-loop liveness. */
export function routinesHealth(now: Date = new Date()): RoutinesHealthReport {
  const db = getDb()
  const routines = db.prepare('SELECT * FROM routines ORDER BY id').all() as RoutineRow[]
  const tickRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(HEARTBEAT_KEY) as { value: string } | undefined
  const lastTick = tickRow?.value ?? null
  const tickStale = !lastTick || now.getTime() - new Date(lastTick).getTime() > TICK_STALE_MS
  const health = routines.map(r => computeRoutineHealth(r, now))
  const overdueCount = health.filter(h => h.overdue).length
  return {
    // ok only when the loop is alive AND no enabled routine has silently stalled.
    ok: !tickStale && overdueCount === 0,
    globally_enabled: routinesGloballyEnabled(),
    last_tick: lastTick,
    tick_stale: tickStale,
    overdue_count: overdueCount,
    routines: health,
  }
}

/** Last guard-skip reason recorded for a routine this process, if any. */
export function getLastSkipReason(id: number): string | null {
  return lastSkipReason.get(id) ?? null
}

// ── Firing ─────────────────────────────────────────────────────────────────

export function routinesGloballyEnabled(): boolean {
  const row = getDb()
    .prepare("SELECT value FROM settings WHERE key = 'routines_enabled'")
    .get() as { value: string } | undefined
  return row ? row.value === '1' : true
}

export interface FireResult {
  ok: boolean
  reason?: string
  objective_id?: number
}

/**
 * Instantiate a routine's objective template as a board objective (status
 * queue, routine_id set), broadcast it, then transition it to working via the
 * internal status PATCH — the exact code path humans/Hermes use, so the
 * session-spawn behavior is identical. Guards: per-routine queue depth and
 * global MAX_CONCURRENT_SESSIONS. The global kill switch is checked by the
 * tick, not here, so run-now can bypass it.
 */
export async function fireRoutine(routine: RoutineRow, source: 'cron' | 'run-now'): Promise<FireResult> {
  const db = getDb()

  // Queue-depth guard. Count only GENUINELY IN-FLIGHT objectives for this
  // routine — `done` is terminal and `review` is parked awaiting a human;
  // neither should block the next scheduled fire. Counting `review` here is what
  // let a single stranded review card permanently fill a maxq=1 slot and
  // silently kill the schedule (obj 1970: all 7 routines stopped firing ~Jun 21).
  // With routine tasks now auto-completing to `done` (resolveWorkerEndStatus),
  // this is belt-and-suspenders: even a future routing regression that parks a
  // routine card in `review` can no longer stop the job from firing on cadence.
  const pending = (db.prepare(
    "SELECT COUNT(*) AS n FROM objectives WHERE routine_id = ? AND status IN ('planning','queue','working','ai_review')"
  ).get(routine.id) as { n: number }).n
  if (pending >= routine.max_queue_depth) {
    return { ok: false, reason: `queue depth guard: ${pending} in-flight objective(s) >= max_queue_depth ${routine.max_queue_depth}` }
  }

  const active = (db.prepare(
    "SELECT COUNT(*) AS n FROM objectives WHERE status IN ('working', 'review', 'ai_review')"
  ).get() as { n: number }).n
  if (active >= MAX_CONCURRENT_SESSIONS) {
    return { ok: false, reason: `concurrency guard: ${active} active sessions >= MAX_CONCURRENT_SESSIONS ${MAX_CONCURRENT_SESSIONS}` }
  }

  let tpl: Record<string, unknown>
  try {
    tpl = JSON.parse(routine.objective_template) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'objective_template is not valid JSON' }
  }
  const str = (k: string): string | null => (typeof tpl[k] === 'string' && (tpl[k] as string).trim() ? (tpl[k] as string) : null)
  const title = str('title')
  if (!title) return { ok: false, reason: 'objective_template.title is required' }
  const type = ['project', 'bug', 'task'].includes(tpl.type as string) ? (tpl.type as string) : 'task'

  // obj 2384 — Strategy ownership. If this routine is owned by a Strategy node,
  // the run-objective becomes a CHILD of that strategy (parent_id + derived
  // depth) so completion feeds back into the strategy's rolling context via the
  // continuation seam (delegatorParentOf → appendChildResult). The link is honored
  // only when the target still exists AND is a delegator (delegate_mode=1) — the
  // sole node type delegatorParentOf will wake; otherwise we degrade gracefully to
  // a standalone run (parent_id NULL), exactly the pre-2384 behavior. This keeps
  // existing standalone routines byte-identical.
  let parentId: number | null = null
  let parentDepth = 0
  if (routine.strategy_objective_id != null) {
    const strat = db
      .prepare('SELECT id, depth, delegate_mode FROM objectives WHERE id = ?')
      .get(routine.strategy_objective_id) as { id: number; depth: number | null; delegate_mode: number } | undefined
    if (strat && strat.delegate_mode) {
      parentId = strat.id
      parentDepth = (strat.depth ?? 0) + 1
    } else {
      console.warn(`[routines] '${routine.name}': strategy_objective_id ${routine.strategy_objective_id} is missing or not a delegator — running standalone`)
    }
  }

  // Mark last_run_at BEFORE the async spawn so a slow spawn can't double-fire
  // within the same minute.
  db.prepare("UPDATE routines SET last_run_at = ? WHERE id = ?").run(new Date().toISOString(), routine.id)

  // Provenance (obj 2386): a routine-spawned objective is always origin='routine'.
  // strategy_id reflects the OWNING Strategy (obj 2384 routines.strategy_objective_id)
  // when the routine is owned by one — the same node resolved as parentId above —
  // so a strategy-owned recurring job is queryable via strategy_id like any other
  // member. Standalone routines leave strategy_id NULL (unchanged behavior).
  const routineStrategyId = resolveStrategyId(db, null, parentId)
  const result = db.prepare(
    `INSERT INTO objectives
       (title, description, agent_context, workspace, project, category,
        completion_goal, workflow_hint, effort, model, type, routine_id,
        parent_id, depth, status, origin, strategy_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queue', 'routine', ?)`
  ).run(
    title,
    str('description') || '',
    str('agent_context') || 'general',
    str('workspace') || 'example',
    str('project'),
    str('category') || 'general',
    str('completion_goal'),
    str('workflow_hint'),
    str('effort') || 'normal',
    str('model') || getDefaultModelId(),
    type,
    routine.id,
    parentId,
    parentDepth,
    routineStrategyId,
  )
  const objectiveId = result.lastInsertRowid as number
  if (tpl.create_pr === true || tpl.create_pr === 1) {
    db.prepare('UPDATE objectives SET create_pr = 1 WHERE id = ?').run(objectiveId)
  }

  const obj = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId) as Objective
  if (obj) broadcast({ type: 'objective_updated', payload: obj })
  console.log(`[routines] '${routine.name}' fired (${source}) → objective ${objectiveId} queued`)

  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/api/internal/objectives/${objectiveId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'working' }),
    })
    if (!resp.ok) {
      const body = await resp.text()
      console.warn(`[routines] '${routine.name}': objective ${objectiveId} created but spawn failed: ${resp.status} ${body}`)
      return { ok: true, objective_id: objectiveId, reason: `created but transition to working failed: ${resp.status} ${body}` }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[routines] '${routine.name}': objective ${objectiveId} created but spawn request errored: ${msg}`)
    return { ok: true, objective_id: objectiveId, reason: `created but spawn request errored: ${msg}` }
  }

  console.log(`[routines] '${routine.name}': objective ${objectiveId} transitioned to working (session spawned)`)
  return { ok: true, objective_id: objectiveId }
}

// ── Scheduler ──────────────────────────────────────────────────────────────

function sameMinute(isoA: string | null, b: Date): boolean {
  if (!isoA) return false
  return isoA.slice(0, 16) === b.toISOString().slice(0, 16)
}

/** Stamp the scheduler heartbeat so the health endpoint can detect a dead loop. */
function recordTickHeartbeat(now: Date): void {
  try {
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(HEARTBEAT_KEY, now.toISOString())
  } catch (err) {
    console.warn('[routines] failed to record tick heartbeat:', err instanceof Error ? err.message : err)
  }
}

/**
 * Raise a HIGH alert for any enabled routine that has silently stalled (missed a
 * scheduled fire past the grace window). notify() persists the alert, broadcasts
 * it to the UI, and emails it — and dedups, so a persistently-overdue routine
 * nags rather than spams. This is the "make it obvious when jobs aren't running"
 * surface: a stalled routine no longer fails in silence.
 */
async function alertOnStalledRoutines(now: Date): Promise<void> {
  const db = getDb()
  const routines = db.prepare('SELECT * FROM routines WHERE enabled = 1').all() as RoutineRow[]
  for (const routine of routines) {
    const health = computeRoutineHealth(routine, now)
    if (!health.overdue) continue
    const reason = health.last_skip_reason ? ` Last skip: ${health.last_skip_reason}.` : ''
    await notify({
      severity: 'high',
      source: 'routines',
      title: `Routine '${routine.name}' has stopped firing`,
      message:
        `Routine '${routine.name}' (${health.cadence}) is overdue by ~${health.minutes_overdue} min. ` +
        `Expected fire at ${health.expected_last_fire}; last actual run ${health.last_run_at ?? 'never'}.${reason} ` +
        `Check the board for a stranded card filling its queue slot, or the scheduler logs.`,
      dedup_key: `routine-overdue-${routine.id}`,
      url: '/jobs',
    })
  }
}

async function tick(): Promise<void> {
  const now = new Date()
  const db = getDb()
  recordTickHeartbeat(now)

  if (!routinesGloballyEnabled()) {
    console.log('[routines] tick — kill switch off (settings.routines_enabled != 1), skipping')
    return
  }

  const routines = db.prepare('SELECT * FROM routines WHERE enabled = 1').all() as RoutineRow[]
  let fired = 0
  for (const routine of routines) {
    if (!cronMatches(routine.cron_expr, now)) continue
    // Double-fire guard: skip if this routine already fired this minute
    // (timer drift can land two ticks inside one wall-clock minute).
    if (sameMinute(routine.last_run_at, now)) continue
    try {
      const result = await fireRoutine(routine, 'cron')
      if (result.ok) {
        fired++
        lastSkipReason.delete(routine.id)
      } else {
        lastSkipReason.set(routine.id, result.reason ?? 'unknown')
        console.log(`[routines] '${routine.name}' skipped: ${result.reason}`)
      }
    } catch (err) {
      console.error(`[routines] '${routine.name}' fire failed:`, err)
    }
  }
  console.log(`[routines] tick — ${routines.length} enabled, ${fired} fired`)

  // Surface silently-stalled routines (missed fires) as alerts. Runs every tick;
  // notify()'s dedup keeps a persistent stall to a periodic nag, not a flood.
  try {
    await alertOnStalledRoutines(now)
  } catch (err) {
    console.error('[routines] stall-alert sweep failed:', err)
  }
}

export function startRoutineScheduler(): void {
  if (tickTimer) return
  tickTimer = setInterval(() => {
    tick().catch(err => console.error('[routines] tick failed:', err))
  }, TICK_MS)
  console.log('[routines] Scheduler started — 60s tick, cron matched against server local time')
}

export function stopRoutineScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
    console.log('[routines] Scheduler stopped')
  }
}
