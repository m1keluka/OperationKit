import { Router } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { userHasWorkspace } from '../middleware/workspace.js'
import { broadcast } from '../ws/index.js'
import type { ActivityEvent } from '@command-center/shared'

const router = Router()

/**
 * Phase 5: gate feed reads on workspace membership. Admins pass through.
 * Members must belong to the workspace they're asking about; missing param
 * is rejected rather than defaulting to 'example' (silent leak in the legacy code).
 */
function checkFeedWorkspace(req: AuthRequest, workspace: string): string | null {
  const user = req.user!
  if (user.role === 'admin') return null
  if (!workspace) return 'workspace query param required'
  if (!userHasWorkspace(user.id, workspace)) return `No access to workspace '${workspace}'`
  return null
}

// ── GET /api/projects/:project/feed ──
// Returns unified activity timeline for a project

router.get('/projects/:project/feed', requireAuth, (req: AuthRequest, res) => {
  const project = req.params.project as string
  const workspace = (req.query.workspace as string) || 'example'
  const err = checkFeedWorkspace(req, workspace)
  if (err) {
    res.status(403).json({ error: err })
    return
  }
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)
  const before = req.query.before as string | undefined // cursor pagination

  const db = getDb()

  // Get activity_log events for this project
  let query = `
    SELECT * FROM activity_log
    WHERE project = ? AND workspace = ?
    ${before ? 'AND created_at < ?' : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `
  const params: unknown[] = [project, workspace]
  if (before) params.push(before)
  params.push(limit)

  const events = db.prepare(query).all(...params) as Array<Record<string, unknown>>

  const parsed: ActivityEvent[] = events.map(row => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  })) as ActivityEvent[]

  // Also return summary stats
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_events,
      SUM(CASE WHEN event_type = 'session_end' THEN 1 ELSE 0 END) as sessions_completed,
      SUM(CASE WHEN event_type = 'blocker' THEN 1 ELSE 0 END) as blockers,
      SUM(CASE WHEN event_type = 'error' THEN 1 ELSE 0 END) as errors
    FROM activity_log
    WHERE project = ? AND workspace = ?
  `).get(project, workspace) as Record<string, number>

  // Get active objectives for this project
  const activeObjectives = db.prepare(`
    SELECT id, title, status, agent_context, session_id,
           last_session_summary, has_blockers
    FROM objectives
    WHERE project = ? AND workspace = ? AND status != 'done'
    ORDER BY updated_at DESC
  `).all(project, workspace)

  res.json({
    events: parsed,
    stats,
    active_objectives: activeObjectives,
    has_more: parsed.length === limit,
  })
})

// ── GET /api/projects/:project/feed/live ──
// Returns only recent events (last 5 minutes) for polling

router.get('/projects/:project/feed/live', requireAuth, (req: AuthRequest, res) => {
  const project = req.params.project as string
  const workspace = (req.query.workspace as string) || 'example'
  const err = checkFeedWorkspace(req, workspace)
  if (err) {
    res.status(403).json({ error: err })
    return
  }
  const since = (req.query.since as string) || new Date(Date.now() - 5 * 60 * 1000).toISOString()

  const db = getDb()
  const events = db.prepare(`
    SELECT * FROM activity_log
    WHERE project = ? AND workspace = ? AND created_at > ?
    ORDER BY created_at ASC
  `).all(project, workspace, since) as Array<Record<string, unknown>>

  const parsed: ActivityEvent[] = events.map(row => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  })) as ActivityEvent[]

  res.json(parsed)
})

// ── GET /api/feed/all ──
// Cross-project feed — everything recent

router.get('/feed/all', requireAuth, (req: AuthRequest, res) => {
  const workspace = (req.query.workspace as string) || 'example'
  const err = checkFeedWorkspace(req, workspace)
  if (err) {
    res.status(403).json({ error: err })
    return
  }
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200)

  const db = getDb()
  const events = db.prepare(`
    SELECT * FROM activity_log
    WHERE workspace = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(workspace, limit) as Array<Record<string, unknown>>

  const parsed: ActivityEvent[] = events.map(row => ({
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  })) as ActivityEvent[]

  res.json(parsed)
})

// ── Helper: log an activity event ──

export function logActivity(event: {
  project: string
  workspace?: string
  objective_id?: number | null
  task_id?: number | null
  session_id?: string | null
  event_type: string
  title: string
  detail?: string | null
  metadata?: Record<string, unknown> | null
}): ActivityEvent {
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO activity_log (project, workspace, objective_id, task_id, session_id, event_type, title, detail, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.project,
    event.workspace || 'example',
    event.objective_id || null,
    event.task_id || null,
    event.session_id || null,
    event.event_type,
    event.title,
    event.detail || null,
    event.metadata ? JSON.stringify(event.metadata) : null,
  )

  const row = db.prepare('SELECT * FROM activity_log WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
  const parsed: ActivityEvent = {
    ...row,
    metadata: row.metadata ? JSON.parse(row.metadata as string) : null,
  } as ActivityEvent

  broadcast({ type: 'activity', payload: parsed })
  return parsed
}

export default router
