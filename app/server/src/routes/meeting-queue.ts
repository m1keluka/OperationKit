import { Router } from 'express'
import { randomUUID } from 'crypto'
import { getDb } from '../db/index.js'
import { getDefaultModelId } from '../services/model-registry.js'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { broadcast } from '../ws/index.js'
import type { Objective } from '@operationkit/shared'

const router = Router()
router.use(requireAuth)

/**
 * Resolve which workspaces this user can see meeting-queue items for.
 * Admin → null (unscoped, sees everything).
 * Member → list of workspace slugs the user belongs to.
 */
function allowedWorkspaces(req: AuthRequest): string[] | null {
  const user = req.user!
  if (user.role === 'admin') return null
  return getUserWorkspaces(user.id).map(m => m.workspace)
}

interface ActionItemRow {
  id: string
  meeting_id: string
  status: string
  title: string
  description: string
  workspace: string
  priority: number
  owner: string | null
  deadline: string | null
  source_excerpt: string | null
  created_at: string
  reviewed_at: string | null
  meeting_title: string | null
  meeting_date: string | null
  meeting_workspace: string | null
}

// GET /api/meeting-queue — pending action items with meeting context
router.get('/', (req: AuthRequest, res) => {
  const db = getDb()
  const allowed = allowedWorkspaces(req)
  if (allowed && allowed.length === 0) {
    res.json([])
    return
  }
  const wsClause = allowed ? ` AND a.workspace IN (${allowed.map(() => '?').join(',')})` : ''
  const items = db.prepare(`
    SELECT
      a.id, a.meeting_id, a.status, a.title, a.description, a.workspace,
      a.priority, a.owner, a.deadline, a.source_excerpt, a.created_at, a.reviewed_at,
      m.title AS meeting_title, m.meeting_date, m.workspace AS meeting_workspace
    FROM granola_action_items a
    LEFT JOIN granola_processed_meetings m ON m.id = a.meeting_id
    WHERE a.status = 'pending-review'${wsClause}
    ORDER BY a.created_at DESC
  `).all(...(allowed || [])) as ActionItemRow[]
  res.json(items)
})

// GET /api/meeting-queue/count — lightweight badge poll
router.get('/count', (req: AuthRequest, res) => {
  const db = getDb()
  const allowed = allowedWorkspaces(req)
  if (allowed && allowed.length === 0) {
    res.json({ count: 0 })
    return
  }
  const wsClause = allowed ? ` AND workspace IN (${allowed.map(() => '?').join(',')})` : ''
  const row = db.prepare(
    `SELECT COUNT(*) AS count FROM granola_action_items WHERE status = 'pending-review'${wsClause}`
  ).get(...(allowed || [])) as { count: number }
  res.json({ count: row.count })
})

// POST /api/meeting-queue/:id/approve — create objective, mark approved
router.post('/:id/approve', (req: AuthRequest, res) => {
  const db = getDb()
  const item = db.prepare(
    `SELECT * FROM granola_action_items WHERE id = ?`
  ).get(req.params.id) as ActionItemRow | undefined

  if (!item) {
    res.status(404).json({ error: 'Action item not found' })
    return
  }

  if (!item.workspace) {
    res.status(400).json({ error: 'Action item has no workspace assignment; cannot approve' })
    return
  }

  const allowed = allowedWorkspaces(req)
  if (allowed && !allowed.includes(item.workspace)) {
    res.status(403).json({ error: 'No access to this action item' })
    return
  }

  // Create the objective. created_by is set so member-scoped reads (Phase 5)
  // see this objective without admin elevation.
  const result = db.prepare(
    `INSERT INTO objectives (title, description, workspace, status, agent_context, project, category, model, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'queue', 'general', 'command-center-infra', 'general', ?, ?, datetime('now'), datetime('now'))`
  ).run(
    item.title || 'Meeting action item',
    item.description || '',
    item.workspace,
    getDefaultModelId(),
    req.user!.id
  )

  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(result.lastInsertRowid)

  // Mark action item approved
  db.prepare(
    `UPDATE granola_action_items SET status = 'approved', reviewed_at = datetime('now') WHERE id = ?`
  ).run(req.params.id)

  broadcast({ type: 'objective_updated', payload: objective as Objective })
  res.status(201).json(objective)
})

// POST /api/meeting-queue/approve-batch — promote multiple action items in one transaction.
// Body: { ids: string[] }. Returns { approved: Objective[], skipped: { id, reason }[] }.
// Reduces friction of clearing the granola review queue when several items are clearly
// actionable from one meeting — Operator no longer has to click each row.
router.post('/approve-batch', (req: AuthRequest, res) => {
  const { ids } = req.body as { ids?: string[] }
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: 'ids array required' })
    return
  }
  const db = getDb()
  const allowed = allowedWorkspaces(req)
  const approved: unknown[] = []
  const skipped: Array<{ id: string; reason: string }> = []

  const tx = db.transaction((itemIds: string[]) => {
    for (const itemId of itemIds) {
      const item = db.prepare(
        `SELECT * FROM granola_action_items WHERE id = ?`
      ).get(itemId) as ActionItemRow | undefined

      if (!item) { skipped.push({ id: itemId, reason: 'not_found' }); continue }
      if (item.status !== 'pending-review') { skipped.push({ id: itemId, reason: `status=${item.status}` }); continue }
      if (!item.workspace) { skipped.push({ id: itemId, reason: 'no_workspace' }); continue }
      if (allowed && !allowed.includes(item.workspace)) { skipped.push({ id: itemId, reason: 'forbidden' }); continue }

      const result = db.prepare(
        `INSERT INTO objectives (title, description, workspace, status, agent_context, project, category, model, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'queue', 'general', 'command-center-infra', 'general', ?, ?, datetime('now'), datetime('now'))`
      ).run(
        item.title || 'Meeting action item',
        item.description || '',
        item.workspace,
        getDefaultModelId(),
        req.user!.id
      )
      const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(result.lastInsertRowid)
      db.prepare(
        `UPDATE granola_action_items SET status = 'approved', reviewed_at = datetime('now') WHERE id = ?`
      ).run(itemId)
      approved.push(objective)
    }
  })
  tx(ids)

  for (const obj of approved) {
    broadcast({ type: 'objective_updated', payload: obj as Objective })
  }
  res.status(201).json({ approved, skipped })
})

// POST /api/meeting-queue/:id/dismiss
router.post('/:id/dismiss', (req: AuthRequest, res) => {
  const db = getDb()
  const item = db.prepare(
    `SELECT id, workspace FROM granola_action_items WHERE id = ?`
  ).get(req.params.id) as { id: string; workspace: string | null } | undefined

  if (!item) {
    res.status(404).json({ error: 'Action item not found' })
    return
  }

  if (!item.workspace) {
    res.status(400).json({ error: 'Action item has no workspace assignment; cannot dismiss' })
    return
  }

  const allowed = allowedWorkspaces(req)
  if (allowed && !allowed.includes(item.workspace)) {
    res.status(403).json({ error: 'No access to this action item' })
    return
  }

  db.prepare(
    `UPDATE granola_action_items SET status = 'dismissed', reviewed_at = datetime('now') WHERE id = ?`
  ).run(req.params.id)

  res.json({ ok: true })
})

// POST /api/meeting-queue/seed — admin-only fixture insertion (Phase 5)
// Originally a test endpoint left auth-only — any member could spam fake queue
// items into prod. Now admin-only; treat as a dev aid, not a production path.
router.post('/seed', requireAdmin, (_req, res) => {
  const db = getDb()
  const meetingId = randomUUID()
  const today = new Date().toISOString().split('T')[0]

  db.prepare(
    `INSERT OR IGNORE INTO granola_processed_meetings (id, title, meeting_date, workspace, vault_path)
     VALUES (?, ?, ?, ?, ?)`
  ).run(meetingId, 'Q2 Planning Session', today, 'example', `workspaces/example/meetings/${today}-q2-planning.md`)

  const items = [
    {
      id: randomUUID(),
      title: 'Set up automated reporting dashboard',
      description: 'Build a dashboard that aggregates weekly KPIs from all active projects and sends a Monday morning briefing.',
      workspace: 'example',
      priority: 2,
      owner: 'Operator',
      deadline: null,
      source_excerpt: 'Operator: we need to stop pulling numbers manually every week, this should be automated by end of Q2',
    },
    {
      id: randomUUID(),
      title: 'Review Example Project pricing model',
      description: 'Audit current price-per-pound margins and adjust calculator defaults based on recent supplier cost changes.',
      workspace: 'example-project',
      priority: 1,
      owner: null,
      deadline: '2026-05-15',
      source_excerpt: 'Supplier costs up 12% — we need to revisit the calculator defaults before the next batch of quotes goes out',
    },
    {
      id: randomUUID(),
      title: 'Draft outreach sequence for warm leads',
      description: 'Create a 3-email nurture sequence for leads that downloaded the guide but haven\'t booked a call.',
      workspace: 'example',
      priority: 3,
      owner: null,
      deadline: null,
      source_excerpt: 'We have about 40 leads sitting in the "guide downloaded" bucket with no follow-up — low-hanging fruit',
    },
  ]

  for (const item of items) {
    db.prepare(
      `INSERT OR IGNORE INTO granola_action_items
       (id, meeting_id, title, description, workspace, priority, owner, deadline, source_excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(item.id, meetingId, item.title, item.description, item.workspace, item.priority, item.owner, item.deadline, item.source_excerpt)
  }

  res.json({ seeded: true, meetingId, itemCount: items.length })
})

export default router
