import { Router } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { getOpenTasksBlock } from '../services/mentor-context.js'

const router = Router()
router.use(requireAuth)

// GET /api/jarvis/briefing
// Aggregates live board state + vault open loops for the daily briefing.
// Phase 5: members only see board rows from workspaces they belong to AND that
// they created/are assigned to — mirroring `GET /api/objectives`. Admins see all.
router.get('/briefing', (req: AuthRequest, res) => {
  const db = getDb()
  const user = req.user!

  type Row = {
    id: number
    title: string
    status: string
    workspace: string
    updated_at: string
    has_blockers: number
  }

  let rows: Row[]
  // Status set reflects shared types: queue|working|review|done. The `blocked`
  // facet is derived from has_blockers (column), not a status value.
  if (user.role === 'admin') {
    rows = db.prepare(`
      SELECT id, title, status, workspace, updated_at, has_blockers
      FROM objectives
      WHERE status IN ('working', 'review')
      ORDER BY updated_at DESC
    `).all() as Row[]
  } else {
    const userWs = getUserWorkspaces(user.id).map(w => w.workspace)
    if (userWs.length === 0) {
      rows = []
    } else {
      const placeholders = userWs.map(() => '?').join(',')
      rows = db.prepare(`
        SELECT id, title, status, workspace, updated_at, has_blockers
        FROM objectives
        WHERE status IN ('working', 'review')
          AND workspace IN (${placeholders})
          AND (assigned_user_id = ? OR created_by = ?)
        ORDER BY updated_at DESC
      `).all(...userWs, user.id, user.id) as Row[]
    }
  }

  const inProgress = rows.filter(r => r.status === 'working' && !r.has_blockers)
  const blocked = rows.filter(r => r.status === 'working' && !!r.has_blockers)
  const needsReview = rows.filter(r => r.status === 'review')

  // Phase 6: getOpenTasksBlock now honors `allowedWorkspaces`. Admin gets null
  // (no filter); members get their actual workspace list so other workspaces'
  // open loops are filtered out at the disk-walk stage.
  const allowedWorkspaces = user.role === 'admin'
    ? null
    : getUserWorkspaces(user.id).map(w => w.workspace)
  const openLoops = getOpenTasksBlock({ allowedWorkspaces })

  res.json({
    asOf: new Date().toISOString(),
    board: { inProgress, blocked, needsReview },
    openLoops,
    gmail: { available: false, note: 'Connect via Jarvis chat — use MCP tools gmail_list and calendar_list from within a session' },
    calendar: { available: false, note: 'Connect via Jarvis chat — use MCP tools gmail_list and calendar_list from within a session' },
  })
})

export default router
