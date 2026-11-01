import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { getDb } from '../db/index.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import {
  fireRoutine,
  validateCronExpr,
  routinesGloballyEnabled,
  routinesHealth,
  type RoutineRow,
} from '../services/routine-scheduler.js'
import { resumeRoutine } from '../services/routine-auto-pause.js'

// Routines CRUD + run-now. Localhost-only AND shared-secret gated (audit B5 /
// threat T6): network origin alone let any in-container session curl this and
// schedule arbitrary objectives. Callers must now also send the X-Internal-Secret
// header (see middleware/internal-secret.ts).
const router = Router()

router.use((req: Request, res: Response, next: NextFunction) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  if (!requireInternalSecret(req, res)) return
  next()
})

function getRoutine(id: string): RoutineRow | undefined {
  return getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined
}

// obj 64 Part B — script-routine + auto-pause fields accepted by create/update.
interface ScriptFieldsBody {
  kind?: unknown
  script_command?: unknown
  alert_marker?: unknown
  script_timeout_sec?: unknown
  max_consecutive_failures?: unknown
}

/**
 * Validate the obj-64 fields present on a body. Returns column→value pairs to
 * write, or an error. `existing` (PATCH) supplies the current kind/command so
 * "script kind requires script_command" is checked against the merged result.
 */
export function parseScriptFields(
  body: ScriptFieldsBody,
  existing?: Pick<RoutineRow, 'kind' | 'script_command'>,
): { error: string } | { cols: Record<string, unknown> } {
  const cols: Record<string, unknown> = {}
  if (body.kind !== undefined) {
    if (body.kind !== 'ai' && body.kind !== 'script') return { error: "kind must be 'ai' or 'script'" }
    cols.kind = body.kind
  }
  if (body.script_command !== undefined) {
    if (body.script_command !== null && typeof body.script_command !== 'string') {
      return { error: 'script_command must be a string' }
    }
    cols.script_command = typeof body.script_command === 'string' && body.script_command.trim() ? body.script_command : null
  }
  if (body.alert_marker !== undefined) {
    if (body.alert_marker !== null && typeof body.alert_marker !== 'string') return { error: 'alert_marker must be a string' }
    cols.alert_marker = typeof body.alert_marker === 'string' && body.alert_marker.length > 0 ? body.alert_marker : null
  }
  if (body.script_timeout_sec !== undefined) {
    const v = body.script_timeout_sec
    if (v !== null && !(Number.isInteger(v) && (v as number) > 0 && (v as number) <= 24 * 3600)) {
      return { error: 'script_timeout_sec must be a positive integer (seconds, <= 86400) or null' }
    }
    cols.script_timeout_sec = v
  }
  if (body.max_consecutive_failures !== undefined) {
    const v = body.max_consecutive_failures
    if (v !== null && !(Number.isInteger(v) && (v as number) >= 0)) {
      return { error: 'max_consecutive_failures must be a non-negative integer (0 disables auto-pause) or null' }
    }
    cols.max_consecutive_failures = v
  }
  const kind = (cols.kind as string | undefined) ?? existing?.kind ?? 'ai'
  const cmd = 'script_command' in cols ? cols.script_command : existing?.script_command
  if (kind === 'script' && !(typeof cmd === 'string' && cmd.trim())) {
    return { error: 'script_command is required when kind is script' }
  }
  return { cols }
}

// GET /api/internal/routines — all routines + global kill switch state
router.get('/', (_req, res) => {
  const routines = getDb().prepare('SELECT * FROM routines ORDER BY id').all() as RoutineRow[]
  res.json({ routines_enabled: routinesGloballyEnabled(), routines })
})

// GET /api/internal/routines/health — per-routine liveness: overdue detection,
// scheduler-loop heartbeat staleness, and last skip reason. `ok:false` means a
// routine has silently stalled or the scheduler loop is dead. Registered before
// /:id so 'health' isn't captured as an id. Returns 200 always (the body's `ok`
// carries the verdict) so a watcher distinguishes "unhealthy" from "endpoint down".
router.get('/health', (_req, res) => {
  res.json(routinesHealth())
})

// PATCH /api/internal/routines/settings — flip the global kill switch.
// Registered before /:id so 'settings' isn't captured as an id.
router.patch('/settings', (req, res) => {
  const { routines_enabled } = req.body as { routines_enabled?: boolean }
  if (typeof routines_enabled !== 'boolean') {
    res.status(400).json({ error: 'routines_enabled (boolean) required' })
    return
  }
  getDb().prepare(
    "INSERT INTO settings (key, value) VALUES ('routines_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(routines_enabled ? '1' : '0')
  console.log(`[routines] global kill switch set to ${routines_enabled ? 'ON' : 'OFF'}`)
  res.json({ routines_enabled })
})

// POST /api/internal/routines — create
router.post('/', (req, res) => {
  const scriptParsed = parseScriptFields(req.body as ScriptFieldsBody)
  if ('error' in scriptParsed) {
    res.status(400).json({ error: scriptParsed.error })
    return
  }
  const isScript = scriptParsed.cols.kind === 'script'
  const { name, cron_expr, objective_template, enabled, max_queue_depth, strategy_objective_id } = req.body as {
    name?: string
    cron_expr?: string
    objective_template?: unknown
    enabled?: boolean
    max_queue_depth?: number
    strategy_objective_id?: number | null
  }

  if (!name?.trim()) {
    res.status(400).json({ error: 'name required' })
    return
  }
  const cronErr = cron_expr ? validateCronExpr(cron_expr) : 'cron_expr required'
  if (cronErr) {
    res.status(400).json({ error: cronErr })
    return
  }
  let templateJson: string
  if (typeof objective_template === 'string') {
    try {
      JSON.parse(objective_template)
      templateJson = objective_template
    } catch {
      res.status(400).json({ error: 'objective_template string is not valid JSON' })
      return
    }
  } else if (objective_template && typeof objective_template === 'object') {
    templateJson = JSON.stringify(objective_template)
  } else if (isScript && objective_template == null) {
    // A script routine's template is only used for escalation cards; without one
    // the escalation falls back to a generated "Routine '<name>' script alert" title.
    templateJson = '{}'
  } else {
    res.status(400).json({ error: 'objective_template (object or JSON string) required' })
    return
  }
  if (!isScript && !(JSON.parse(templateJson) as { title?: string }).title?.trim()) {
    res.status(400).json({ error: 'objective_template.title required' })
    return
  }
  const depth = Number.isInteger(max_queue_depth) && (max_queue_depth as number) > 0 ? max_queue_depth : 1
  // obj 2384 — optional owning Strategy link. Must reference an existing delegator
  // objective; otherwise reject so a typo'd link can't silently orphan the runs.
  const strategyId = strategy_objective_id == null ? null : Number(strategy_objective_id)
  if (strategyId != null) {
    const strat = getDb().prepare('SELECT delegate_mode FROM objectives WHERE id = ?').get(strategyId) as { delegate_mode: number } | undefined
    if (!strat) { res.status(400).json({ error: `strategy_objective_id ${strategyId} not found` }); return }
    if (!strat.delegate_mode) { res.status(400).json({ error: `objective ${strategyId} is not a delegator (delegate_mode=0); cannot own a routine` }); return }
  }

  try {
    const result = getDb().prepare(
      'INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth, strategy_objective_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name.trim(), cron_expr, templateJson, enabled ? 1 : 0, depth, strategyId)
    const extra = Object.keys(scriptParsed.cols)
    if (extra.length) {
      getDb()
        .prepare(`UPDATE routines SET ${extra.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
        .run(...extra.map(c => scriptParsed.cols[c]), result.lastInsertRowid)
    }
    res.status(201).json(getRoutine(String(result.lastInsertRowid)))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'insert failed'
    res.status(msg.includes('UNIQUE') ? 409 : 500).json({ error: msg })
  }
})

// PATCH /api/internal/routines/:id — partial update (enable/disable, cron, template, depth)
router.patch('/:id', (req, res) => {
  const existing = getRoutine(req.params.id as string)
  if (!existing) {
    res.status(404).json({ error: 'Routine not found' })
    return
  }
  const body = req.body as {
    name?: string
    cron_expr?: string
    objective_template?: unknown
    enabled?: boolean
    max_queue_depth?: number
    strategy_objective_id?: number | null
  }

  const updates: string[] = []
  const params: unknown[] = []

  const scriptParsed = parseScriptFields(req.body as ScriptFieldsBody, existing)
  if ('error' in scriptParsed) {
    res.status(400).json({ error: scriptParsed.error })
    return
  }
  for (const [col, val] of Object.entries(scriptParsed.cols)) {
    updates.push(`${col} = ?`)
    params.push(val)
  }
  // Switching kind: don't retro-count the other kind's cards as AI runs.
  if (scriptParsed.cols.kind !== undefined && scriptParsed.cols.kind !== (existing.kind ?? 'ai')) {
    updates.push('last_accounted_objective_id = (SELECT MAX(id) FROM objectives WHERE routine_id = ?)')
    params.push(existing.id)
  }

  // obj 2384 — set/clear the owning Strategy link. null clears it (back to a
  // standalone routine); a value must reference an existing delegator objective.
  if (body.strategy_objective_id !== undefined) {
    if (body.strategy_objective_id === null) {
      updates.push('strategy_objective_id = ?')
      params.push(null)
    } else {
      const sid = Number(body.strategy_objective_id)
      const strat = getDb().prepare('SELECT delegate_mode FROM objectives WHERE id = ?').get(sid) as { delegate_mode: number } | undefined
      if (!strat) { res.status(400).json({ error: `strategy_objective_id ${sid} not found` }); return }
      if (!strat.delegate_mode) { res.status(400).json({ error: `objective ${sid} is not a delegator` }); return }
      updates.push('strategy_objective_id = ?')
      params.push(sid)
    }
  }

  if (body.name !== undefined) {
    if (!body.name.trim()) {
      res.status(400).json({ error: 'name cannot be empty' })
      return
    }
    updates.push('name = ?')
    params.push(body.name.trim())
  }
  if (body.cron_expr !== undefined) {
    const cronErr = validateCronExpr(body.cron_expr)
    if (cronErr) {
      res.status(400).json({ error: cronErr })
      return
    }
    updates.push('cron_expr = ?')
    params.push(body.cron_expr)
  }
  if (body.objective_template !== undefined) {
    let templateJson: string
    if (typeof body.objective_template === 'string') {
      try {
        JSON.parse(body.objective_template)
        templateJson = body.objective_template
      } catch {
        res.status(400).json({ error: 'objective_template string is not valid JSON' })
        return
      }
    } else if (body.objective_template && typeof body.objective_template === 'object') {
      templateJson = JSON.stringify(body.objective_template)
    } else {
      res.status(400).json({ error: 'objective_template must be an object or JSON string' })
      return
    }
    updates.push('objective_template = ?')
    params.push(templateJson)
  }
  if (body.enabled !== undefined) {
    updates.push('enabled = ?')
    params.push(body.enabled ? 1 : 0)
    // Manually re-enabling is a resume: clear the auto-pause streak/state.
    if (body.enabled) {
      updates.push('consecutive_failures = 0', 'auto_paused_at = NULL', 'auto_pause_reason = NULL')
    }
  }
  if (body.max_queue_depth !== undefined) {
    if (!Number.isInteger(body.max_queue_depth) || body.max_queue_depth < 1) {
      res.status(400).json({ error: 'max_queue_depth must be a positive integer' })
      return
    }
    updates.push('max_queue_depth = ?')
    params.push(body.max_queue_depth)
  }

  if (updates.length === 0) {
    res.status(400).json({ error: 'No updatable fields provided' })
    return
  }

  try {
    getDb().prepare(`UPDATE routines SET ${updates.join(', ')} WHERE id = ?`).run(...params, existing.id)
    res.json(getRoutine(String(existing.id)))
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'update failed'
    res.status(msg.includes('UNIQUE') ? 409 : 500).json({ error: msg })
  }
})

// DELETE /api/internal/routines/:id
router.delete('/:id', (req, res) => {
  const existing = getRoutine(req.params.id as string)
  if (!existing) {
    res.status(404).json({ error: 'Routine not found' })
    return
  }
  getDb().prepare('DELETE FROM routines WHERE id = ?').run(existing.id)
  res.json({ ok: true, deleted: existing.name })
})

// POST /api/internal/routines/:id/resume — one-click resume of an auto-paused
// (or disabled) routine: enabled=1, streak + auto-pause fields cleared, activity row.
router.post('/:id/resume', (req, res) => {
  const existing = getRoutine(req.params.id as string)
  if (!existing) {
    res.status(404).json({ error: 'Routine not found' })
    return
  }
  resumeRoutine(existing.id, 'internal-api')
  res.json(getRoutine(String(existing.id)))
})

// POST /api/internal/routines/:id/run-now — fire immediately. Bypasses the
// cron schedule and the global kill switch (explicit operator action) but
// still respects the per-routine queue-depth guard.
router.post('/:id/run-now', async (req, res) => {
  const existing = getRoutine(req.params.id as string)
  if (!existing) {
    res.status(404).json({ error: 'Routine not found' })
    return
  }
  try {
    // Script routines run in the background (a script may take minutes).
    const result = await fireRoutine(existing, 'run-now', { background: true })
    res.status(result.ok ? 201 : 409).json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'run-now failed' })
  }
})

export default router
