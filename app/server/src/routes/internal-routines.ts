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
  } else {
    res.status(400).json({ error: 'objective_template (object or JSON string) required' })
    return
  }
  if (!(JSON.parse(templateJson) as { title?: string }).title?.trim()) {
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
    const result = await fireRoutine(existing, 'run-now')
    res.status(result.ok ? 201 : 409).json(result)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'run-now failed' })
  }
})

export default router
