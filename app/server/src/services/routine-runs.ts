/**
 * Per-run execution history for routines (obj 900676) — the data behind the
 * Jobs → Executions view (n8n-style: a list of runs, click one to read its log).
 *
 * Write side: routine-scheduler.ts calls `beginRoutineRun` at the top of every
 * fireRoutine() and `settleRoutineRun` / `finishScriptRun` when the fire returns,
 * so every fire — cron or run-now, AI / script / flow, including one a guard
 * refused — leaves a `routine_runs` row. Never throws into the scheduler: a
 * history write failing must not stop a routine from firing.
 *
 * Read side: `listRoutineExecutions` merges `routine_runs` with the run records
 * that existed before it (routine cards in `objectives`, routine flow runs in
 * `flow_runs`), so history is complete from day one without a backfill. The live
 * status of an AI / flow run is read from its card / flow run, never cached here.
 */
import type Database from 'better-sqlite3'
import { initRoutineRunsSchema, ROUTINE_RUN_OUTPUT_BYTES, type RoutineRunStatus } from '../db/schema/routine-runs.js'
import type {
  JobExecutionDetailResponse,
  JobExecutionKind,
  JobExecutionLogEntry,
  JobExecutionRoutineInfo,
  JobExecutionStatus,
  JobExecutionSummary,
} from '../../../shared/job-executions.js'

/** Keep at most this many history rows per routine (oldest pruned on insert). */
export const ROUTINE_RUNS_KEEP_PER_ROUTINE = 500

/** Fire results that are a guard saying "not this slot", not a failure (mirrors routine-auto-pause BENIGN_SKIP_PREFIXES). */
const SKIP_PREFIXES = [
  'queue depth guard',
  'concurrency guard',
  'over-fire guard',
  'duplicate guard',
  'script already running',
  'flows disabled',
  'flow inactive',
]

const initialised = new WeakSet<Database.Database>()
function ensureSchema(db: Database.Database): void {
  if (initialised.has(db)) return
  initRoutineRunsSchema(db)
  initialised.add(db)
}

const nowIso = () => new Date().toISOString()

export function routineKind(kind: string | null | undefined): JobExecutionKind {
  return kind === 'script' ? 'script' : kind === 'flow' ? 'flow' : 'ai'
}

// ── Write side ─────────────────────────────────────────────────────────────

/** Open a history row for a fire. Returns its id, or null if the write failed (never throws). */
export function beginRoutineRun(
  db: Database.Database,
  routine: { id: number; kind?: string | null },
  source: string,
): number | null {
  try {
    ensureSchema(db)
    const id = db
      .prepare("INSERT INTO routine_runs (routine_id, kind, source, status, started_at) VALUES (?, ?, ?, 'running', ?)")
      .run(routine.id, routineKind(routine.kind), source, nowIso()).lastInsertRowid as number
    db.prepare(
      `DELETE FROM routine_runs WHERE routine_id = ? AND id <= (
         SELECT id FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    ).run(routine.id, routine.id, ROUTINE_RUNS_KEEP_PER_ROUTINE)
    return id
  } catch (err) {
    console.warn('[routine-runs] could not open history row:', err instanceof Error ? err.message : err)
    return null
  }
}

/** Status of a fire from its FireResult (AI / flow fires and refused fires of any kind). */
export function fireResultStatus(res: { ok: boolean; reason?: string; objective_id?: number; flow_run_id?: number }): RoutineRunStatus {
  if (res.ok) {
    if (res.reason?.startsWith('created but spawn failed')) return 'failed'
    return res.objective_id != null || res.flow_run_id != null ? 'dispatched' : 'succeeded'
  }
  const reason = res.reason ?? ''
  return SKIP_PREFIXES.some(p => reason.startsWith(p)) ? 'skipped' : 'failed'
}

function finish(
  db: Database.Database,
  runId: number,
  fields: {
    status: RoutineRunStatus
    reason?: string | null
    objective_id?: number | null
    flow_run_id?: number | null
    exit_code?: number | null
    output?: string | null
    duration_ms?: number | null
  },
): void {
  ensureSchema(db)
  const row = db.prepare('SELECT started_at FROM routine_runs WHERE id = ?').get(runId) as { started_at: string } | undefined
  if (!row) return
  const ended = nowIso()
  const duration = fields.duration_ms ?? Math.max(0, Date.parse(ended) - Date.parse(row.started_at))
  let output = fields.output ?? null
  let truncated = 0
  if (output != null && Buffer.byteLength(output) > ROUTINE_RUN_OUTPUT_BYTES) {
    output = output.slice(-ROUTINE_RUN_OUTPUT_BYTES)
    truncated = 1
  }
  db.prepare(
    `UPDATE routine_runs SET status = ?, reason = ?, objective_id = COALESCE(?, objective_id),
            flow_run_id = COALESCE(?, flow_run_id), exit_code = ?, output = COALESCE(?, output),
            output_truncated = ?, ended_at = ?, duration_ms = ?
      WHERE id = ?`,
  ).run(
    fields.status, fields.reason ?? null, fields.objective_id ?? null, fields.flow_run_id ?? null,
    fields.exit_code ?? null, output, truncated, ended, duration, runId,
  )
}

/** Close a fire's row from its FireResult. Never throws. */
export function settleRoutineRun(
  db: Database.Database,
  runId: number | null,
  res: { ok: boolean; reason?: string; objective_id?: number; flow_run_id?: number },
): void {
  if (runId == null) return
  try {
    finish(db, runId, {
      status: fireResultStatus(res),
      reason: res.reason ?? null,
      objective_id: res.objective_id ?? null,
      flow_run_id: res.flow_run_id ?? null,
    })
  } catch (err) {
    console.warn('[routine-runs] could not close history row:', err instanceof Error ? err.message : err)
  }
}

/** Close a script run's row with its outcome and captured output. Never throws. */
export function finishScriptRun(
  db: Database.Database,
  runId: number | null,
  r: { status: 'ok' | 'alert' | 'failed'; reason: string; exit_code: number | null; output: string; duration_ms: number; objective_id?: number | null },
): void {
  if (runId == null) return
  try {
    finish(db, runId, {
      status: r.status === 'ok' ? 'succeeded' : r.status,
      reason: r.reason,
      exit_code: r.exit_code,
      output: r.output,
      duration_ms: r.duration_ms,
      objective_id: r.objective_id ?? null,
    })
  } catch (err) {
    console.warn('[routine-runs] could not close script history row:', err instanceof Error ? err.message : err)
  }
}

// ── Read side ──────────────────────────────────────────────────────────────

interface RoutineLike {
  id: number
  name: string
  kind?: string | null
  flow_id?: number | null
  objective_template?: string | null
  script_command?: string | null
}

interface RunRow {
  id: number
  routine_id: number
  kind: string
  source: string
  status: RoutineRunStatus
  reason: string | null
  objective_id: number | null
  flow_run_id: number | null
  exit_code: number | null
  output: string | null
  output_truncated: number
  started_at: string
  ended_at: string | null
  duration_ms: number | null
}

interface ObjRow {
  id: number
  title: string
  status: string
  job_disposition: string | null
  job_review_note: string | null
  last_session_summary: string | null
  total_cost_usd: number | null
  created_at: string
  updated_at: string
}

interface FlowRunRow {
  id: number
  flow_id: number
  status: string
  goal_met: number | null
  spent_usd: number | null
  trigger_json: string | null
  error_json: string | null
  created_at: string
  started_at: string | null
  ended_at: string | null
}

/** SQLite `datetime('now')` has no zone; treat it as UTC. */
function iso(ts: string | null | undefined): string | null {
  if (!ts) return null
  return /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts.replace(' ', 'T') + 'Z'
}

function msBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const d = Date.parse(b) - Date.parse(a)
  return Number.isFinite(d) && d >= 0 ? d : null
}

/** Live status of a routine card. */
export function objectiveExecutionStatus(o: Pick<ObjRow, 'status' | 'job_disposition'>): JobExecutionStatus {
  if (o.status === 'cancelled') return 'cancelled'
  if (o.status === 'review') return 'needs_review'
  if (o.status === 'done') return o.job_disposition === 'needs_review' ? 'needs_review' : 'succeeded'
  return 'running'
}

/** Live status of a flow run (a succeeded run that missed its goal reads as failed). */
export function flowRunExecutionStatus(r: Pick<FlowRunRow, 'status' | 'goal_met'>): JobExecutionStatus {
  switch (r.status) {
    case 'succeeded': return r.goal_met === 0 ? 'failed' : 'succeeded'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'waiting': return 'waiting'
    default: return 'running'
  }
}

function objEnded(o: ObjRow): string | null {
  return ['done', 'cancelled', 'review'].includes(o.status) ? iso(o.updated_at) : null
}

function parseJson<T>(s: string | null): T | null {
  if (!s) return null
  try { return JSON.parse(s) as T } catch { return null }
}

function flowError(r: FlowRunRow): string | null {
  const e = parseJson<{ type?: string; title?: string }>(r.error_json)
  if (!e) return r.status === 'succeeded' && r.goal_met === 0 ? 'goal not met' : null
  return [e.type, e.title].filter(Boolean).join(': ') || null
}

function fromObjective(routineId: number, o: ObjRow, base?: RunRow): JobExecutionSummary {
  const started = base ? base.started_at : iso(o.created_at)!
  const ended = objEnded(o)
  return {
    key: base ? `rr-${base.id}` : `obj-${o.id}`,
    routine_id: routineId,
    routine_run_id: base?.id ?? null,
    kind: 'ai',
    source: base?.source ?? 'unknown',
    status: objectiveExecutionStatus(o),
    started_at: started,
    ended_at: ended,
    duration_ms: msBetween(started, ended),
    reason: o.job_review_note || (base?.reason ?? null),
    objective_id: o.id,
    objective_title: o.title,
    flow_id: null,
    flow_run_id: null,
    exit_code: null,
    cost_usd: Number(o.total_cost_usd) || 0,
  }
}

function fromFlowRun(routineId: number, r: FlowRunRow, base?: RunRow): JobExecutionSummary {
  const started = base ? base.started_at : iso(r.created_at)!
  const ended = iso(r.ended_at)
  const trig = parseJson<{ source?: string }>(r.trigger_json)
  return {
    key: base ? `rr-${base.id}` : `flow-${r.id}`,
    routine_id: routineId,
    routine_run_id: base?.id ?? null,
    kind: 'flow',
    source: base?.source ?? (trig?.source === 'schedule' ? 'cron' : trig?.source ?? 'unknown'),
    status: flowRunExecutionStatus(r),
    started_at: started,
    ended_at: ended,
    duration_ms: msBetween(started, ended),
    reason: flowError(r),
    objective_id: null,
    objective_title: null,
    flow_id: r.flow_id,
    flow_run_id: r.id,
    exit_code: null,
    cost_usd: Number(r.spent_usd) || 0,
  }
}

function fromRunRow(routine: RoutineLike, rr: RunRow, obj?: ObjRow, flowRun?: FlowRunRow): JobExecutionSummary {
  // A dispatched AI / flow fire takes the live status of what it dispatched.
  if (rr.status === 'dispatched' && obj && routineKind(rr.kind) === 'ai') return fromObjective(routine.id, obj, rr)
  if (rr.status === 'dispatched' && flowRun) return fromFlowRun(routine.id, flowRun, rr)
  // A row still `running` long after any fire could take (the server restarted mid-run) is lost.
  const lost = rr.status === 'running' && Date.now() - Date.parse(rr.started_at) > STALE_RUNNING_MS
  const status: JobExecutionStatus = rr.status === 'dispatched' ? 'running' : lost ? 'failed' : rr.status
  return {
    key: `rr-${rr.id}`,
    routine_id: routine.id,
    routine_run_id: rr.id,
    kind: routineKind(rr.kind),
    source: rr.source,
    status,
    started_at: rr.started_at,
    ended_at: rr.ended_at,
    duration_ms: rr.duration_ms,
    reason: lost ? 'no result recorded (the server restarted during the run?)' : rr.reason,
    objective_id: rr.objective_id,
    objective_title: obj?.title ?? null,
    flow_id: flowRun?.flow_id ?? (rr.flow_run_id != null ? routine.flow_id ?? null : null),
    flow_run_id: rr.flow_run_id,
    exit_code: rr.exit_code,
    cost_usd: obj ? Number(obj.total_cost_usd) || 0 : flowRun ? Number(flowRun.spent_usd) || 0 : null,
  }
}

/** A `running` history row older than this never got its result (scripts time out at 10 min by default). */
const STALE_RUNNING_MS = 3 * 60 * 60 * 1000

const OBJ_COLS = 'id, title, status, job_disposition, job_review_note, last_session_summary, total_cost_usd, created_at, updated_at'
const FLOW_COLS = 'id, flow_id, status, goal_met, spent_usd, trigger_json, error_json, created_at, started_at, ended_at'

function hasTable(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

function loadObjective(db: Database.Database, id: number | null): ObjRow | undefined {
  if (id == null) return undefined
  return db.prepare(`SELECT ${OBJ_COLS} FROM objectives WHERE id = ?`).get(id) as ObjRow | undefined
}

function loadFlowRun(db: Database.Database, id: number | null): FlowRunRow | undefined {
  if (id == null || !hasTable(db, 'flow_runs')) return undefined
  return db.prepare(`SELECT ${FLOW_COLS} FROM flow_runs WHERE id = ?`).get(id) as FlowRunRow | undefined
}

export function routineInfo(routine: RoutineLike, cadence: string): JobExecutionRoutineInfo {
  let title = routine.name
  try {
    const t = JSON.parse(routine.objective_template || '{}') as { title?: unknown }
    if (typeof t.title === 'string' && t.title.trim()) title = t.title
  } catch { /* keep the name */ }
  return { id: routine.id, name: routine.name, title, kind: routineKind(routine.kind), cadence, flow_id: routine.flow_id ?? null }
}

/**
 * Every run of a routine, newest first: its `routine_runs` rows plus any routine
 * card / routine flow run that predates the history table (or was otherwise not
 * recorded there).
 */
export function listRoutineExecutions(db: Database.Database, routine: RoutineLike, limit = 100): JobExecutionSummary[] {
  ensureSchema(db)
  const cap = Math.min(500, Math.max(1, Math.floor(limit) || 100))
  const runs = db.prepare('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY id DESC LIMIT ?').all(routine.id, cap) as RunRow[]
  const out: JobExecutionSummary[] = runs.map(rr =>
    fromRunRow(routine, rr, loadObjective(db, rr.objective_id), loadFlowRun(db, rr.flow_run_id)),
  )

  const legacyObjs = db.prepare(
    `SELECT ${OBJ_COLS} FROM objectives o
      WHERE o.routine_id = ?
        AND NOT EXISTS (SELECT 1 FROM routine_runs rr WHERE rr.objective_id = o.id)
      ORDER BY o.id DESC LIMIT ?`,
  ).all(routine.id, cap) as ObjRow[]
  for (const o of legacyObjs) out.push(fromObjective(routine.id, o))

  if (hasTable(db, 'flow_runs')) {
    const legacyFlows = db.prepare(
      `SELECT ${FLOW_COLS} FROM flow_runs fr
        WHERE fr.mode = 'live' AND json_valid(fr.trigger_json)
          AND json_extract(fr.trigger_json, '$.payload.routine_id') = ?
          AND NOT EXISTS (SELECT 1 FROM routine_runs rr WHERE rr.flow_run_id = fr.id)
        ORDER BY fr.id DESC LIMIT ?`,
    ).all(routine.id, cap) as FlowRunRow[]
    for (const r of legacyFlows) out.push(fromFlowRun(routine.id, r))
  }

  out.sort((a, b) => (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0))
  return out.slice(0, cap)
}

const KEY = /^(rr|obj|flow)-(\d{1,12})$/

/** One run of a routine with its log. Null when the key does not name a run of THIS routine. */
export function getRoutineExecution(
  db: Database.Database,
  routine: RoutineLike,
  key: string,
  cadence: string,
): JobExecutionDetailResponse | null {
  ensureSchema(db)
  const m = KEY.exec(key)
  if (!m) return null
  const id = Number(m[2])
  let rr: RunRow | undefined
  let obj: ObjRow | undefined
  let flowRun: FlowRunRow | undefined
  if (m[1] === 'rr') {
    rr = db.prepare('SELECT * FROM routine_runs WHERE id = ? AND routine_id = ?').get(id, routine.id) as RunRow | undefined
    if (!rr) return null
    obj = loadObjective(db, rr.objective_id)
    flowRun = loadFlowRun(db, rr.flow_run_id)
  } else if (m[1] === 'obj') {
    obj = db.prepare(`SELECT ${OBJ_COLS} FROM objectives WHERE id = ? AND routine_id = ?`).get(id, routine.id) as ObjRow | undefined
    if (!obj) return null
  } else {
    flowRun = loadFlowRun(db, id)
    const trig = flowRun ? parseJson<{ payload?: { routine_id?: unknown } }>(flowRun.trigger_json) : null
    if (!flowRun || trig?.payload?.routine_id !== routine.id) return null
  }

  const execution = rr
    ? fromRunRow(routine, rr, obj, flowRun)
    : obj
      ? fromObjective(routine.id, obj)
      : fromFlowRun(routine.id, flowRun!)

  const log = buildLog(db, execution, rr, obj, flowRun)
  return {
    routine: routineInfo(routine, cadence),
    execution,
    log,
    output: rr?.output ?? null,
    output_truncated: !!rr?.output_truncated,
    command: execution.kind === 'script' ? routine.script_command ?? null : null,
    objective: obj
      ? {
          id: obj.id,
          title: obj.title,
          status: obj.status,
          job_disposition: obj.job_disposition,
          job_review_note: obj.job_review_note,
          last_session_summary: obj.last_session_summary,
          total_cost_usd: Number(obj.total_cost_usd) || 0,
        }
      : null,
  }
}

const SOURCE_LABEL: Record<string, string> = {
  cron: 'Fired by the schedule',
  'run-now': 'Fired by Run now',
  manual: 'Started manually',
  unknown: 'Run started',
}

const ACTIVITY_LEVEL: Record<string, JobExecutionLogEntry['level']> = {
  session_start: 'info',
  session_end: 'info',
  progress: 'info',
  decision: 'info',
  file_change: 'info',
  milestone: 'success',
  blocker: 'warn',
  error: 'error',
}

function statusEntry(e: JobExecutionSummary): JobExecutionLogEntry | null {
  const reason = e.reason ?? null
  switch (e.status) {
    case 'succeeded': return { at: e.ended_at, level: 'success', label: 'Finished: succeeded', detail: reason }
    case 'needs_review': return { at: e.ended_at, level: 'warn', label: 'Finished: needs review', detail: reason }
    case 'alert': return { at: e.ended_at, level: 'warn', label: 'Finished: alert raised', detail: reason }
    case 'failed': return { at: e.ended_at, level: 'error', label: 'Finished: failed', detail: reason }
    case 'skipped': return { at: e.ended_at ?? e.started_at, level: 'warn', label: 'Skipped — nothing ran', detail: reason }
    case 'cancelled': return { at: e.ended_at, level: 'warn', label: 'Cancelled', detail: reason }
    case 'waiting': return { at: null, level: 'info', label: 'Waiting (approval, event or child card)', detail: reason }
    default: return { at: null, level: 'info', label: 'Still running', detail: null }
  }
}

function buildLog(
  db: Database.Database,
  e: JobExecutionSummary,
  rr: RunRow | undefined,
  obj: ObjRow | undefined,
  flowRun: FlowRunRow | undefined,
): JobExecutionLogEntry[] {
  const log: JobExecutionLogEntry[] = []
  log.push({ at: e.started_at, level: 'info', label: SOURCE_LABEL[e.source] ?? `Fired (${e.source})` })

  if (e.kind === 'script' && rr && rr.status !== 'skipped') {
    log.push({
      at: rr.ended_at,
      level: rr.status === 'succeeded' ? 'success' : rr.status === 'running' ? 'info' : rr.status === 'alert' ? 'warn' : 'error',
      label: rr.status === 'running' ? 'Script running' : `Script exited${rr.exit_code != null ? ` with code ${rr.exit_code}` : ''}`,
      detail: rr.reason,
    })
  }

  if (obj) {
    const escalation = e.kind === 'script'
    log.push({
      at: iso(obj.created_at),
      level: escalation ? 'warn' : 'info',
      label: escalation ? `Escalated to card #${obj.id}` : `Card #${obj.id} filed`,
      detail: obj.title,
    })
    const acts = db.prepare(
      `SELECT event_type, title, detail, created_at FROM activity_log WHERE objective_id = ? ORDER BY id LIMIT 200`,
    ).all(obj.id) as { event_type: string; title: string; detail: string | null; created_at: string }[]
    for (const a of acts) {
      log.push({ at: iso(a.created_at), level: ACTIVITY_LEVEL[a.event_type] ?? 'info', label: a.title, detail: a.detail ? a.detail.slice(0, 2000) : null })
    }
    if (!escalation && obj.last_session_summary) {
      log.push({ at: objEnded(obj), level: 'info', label: 'Session summary', detail: obj.last_session_summary.slice(0, 4000) })
    }
  }

  if (flowRun) {
    log.push({ at: iso(flowRun.created_at), level: 'info', label: `Workflow run #${flowRun.id} queued` })
    if (flowRun.started_at) log.push({ at: iso(flowRun.started_at), level: 'info', label: `Workflow run #${flowRun.id} started` })
  }

  if (!(e.kind === 'script' && rr && rr.status !== 'skipped')) {
    const s = statusEntry(e)
    if (s) log.push(s)
  }
  return log
}
