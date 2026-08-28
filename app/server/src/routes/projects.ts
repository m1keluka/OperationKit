/**
 * Projects CRUD — GET/POST/PATCH/DELETE /api/projects
 *
 * A "project" is a named subfolder inside a workspace (org). Objectives belong
 * to a project via `objectives.project_id`. This is ENTIRELY DISTINCT from the
 * existing `objectives.project` column (the repo-link field, e.g.
 * 'command-center-infra') — do not confuse the two.
 *
 * Auth mirrors the objectives routes:
 *  - Admins can read/write any workspace.
 *  - Members can only read/write projects in workspaces they belong to
 *    (getUserWorkspaces membership check).
 */
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'

export interface Project {
  id: number
  workspace: string
  name: string
  description: string | null
  color: string | null
  sort_order: number
  archived: boolean
  objective_count?: number
  created_at: string
  updated_at: string
}

function mapProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as number,
    workspace: row.workspace as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    color: (row.color as string | null) ?? null,
    sort_order: row.sort_order as number,
    archived: !!(row.archived as number),
    objective_count: row.objective_count !== undefined ? (row.objective_count as number) : undefined,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  }
}

/**
 * Returns true when the calling user is allowed to access the given workspace.
 * Admins can access any workspace; members are checked against their memberships.
 */
function canAccessWorkspace(req: AuthRequest, workspace: string): boolean {
  if (req.user!.role === 'admin') return true
  return getUserWorkspaces(req.user!.id).some(m => m.workspace === workspace)
}

const router = Router()
router.use(requireAuth)

// GET /api/projects?workspace=<slug>[&include_archived=1]
// Returns all projects in the workspace visible to the caller, with an
// objective count per project (how many non-deleted objectives are associated).
router.get('/', (req: AuthRequest, res) => {
  const workspace = req.query.workspace as string | undefined
  if (!workspace) {
    res.status(400).json({ error: 'workspace query param is required' })
    return
  }
  if (!canAccessWorkspace(req, workspace)) {
    res.status(403).json({ error: `No access to workspace '${workspace}'` })
    return
  }
  const includeArchived = req.query.include_archived === '1'
  const db = getDb()
  const rows = db.prepare(`
    SELECT p.*,
           COUNT(o.id) AS objective_count
      FROM projects p
      LEFT JOIN objectives o
             ON o.project_id = p.id AND o.deleted_at IS NULL
     WHERE p.workspace = ?
       ${includeArchived ? '' : 'AND p.archived = 0'}
     GROUP BY p.id
     ORDER BY p.sort_order ASC, p.name ASC
  `).all(workspace) as Record<string, unknown>[]
  res.json(rows.map(mapProject))
})

// POST /api/projects — create a new project in a workspace
router.post('/', (req: AuthRequest, res) => {
  const body = req.body as Record<string, unknown>
  const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const description = typeof body.description === 'string' ? body.description.trim() || null : null
  const color = typeof body.color === 'string' ? body.color.trim() || null : null

  if (!workspace) {
    res.status(400).json({ error: 'workspace is required' })
    return
  }
  if (!name) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  if (!canAccessWorkspace(req, workspace)) {
    res.status(403).json({ error: `No access to workspace '${workspace}'` })
    return
  }

  const db = getDb()
  // Check for uniqueness (workspace, name) upfront for a clear error.
  const existing = db.prepare('SELECT id FROM projects WHERE workspace = ? AND name = ?').get(workspace, name)
  if (existing) {
    res.status(409).json({ error: `A project named '${name}' already exists in workspace '${workspace}'` })
    return
  }

  const result = db.prepare(`
    INSERT INTO projects (workspace, name, description, color)
    VALUES (?, ?, ?, ?)
  `).run(workspace, name, description, color)

  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
  res.status(201).json(mapProject(row))
})

// PATCH /api/projects/:id — update name, description, color, sort_order, archived
router.patch('/:id', (req: AuthRequest, res) => {
  const db = getDb()
  const id = parseInt(typeof req.params.id === 'string' ? req.params.id : '', 10)
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid project id' })
    return
  }

  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!existing) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  if (!canAccessWorkspace(req, existing.workspace as string)) {
    res.status(403).json({ error: `No access to workspace '${existing.workspace}'` })
    return
  }

  const body = req.body as Record<string, unknown>
  const name = body.name !== undefined ? (typeof body.name === 'string' ? body.name.trim() : null) : null
  const description = body.description !== undefined
    ? (typeof body.description === 'string' ? body.description.trim() || null : null)
    : undefined
  const color = body.color !== undefined
    ? (typeof body.color === 'string' ? body.color.trim() || null : null)
    : undefined
  const sort_order = body.sort_order !== undefined ? Number(body.sort_order) : undefined
  const archived = body.archived !== undefined ? (body.archived ? 1 : 0) : undefined

  if (name !== null && name === '') {
    res.status(400).json({ error: 'name cannot be empty' })
    return
  }

  // Check uniqueness if renaming.
  if (name && name !== existing.name) {
    const dup = db.prepare('SELECT id FROM projects WHERE workspace = ? AND name = ? AND id != ?').get(existing.workspace, name, id)
    if (dup) {
      res.status(409).json({ error: `A project named '${name}' already exists in this workspace` })
      return
    }
  }

  db.prepare(`
    UPDATE projects SET
      name        = COALESCE(?, name),
      description = ${description !== undefined ? '?' : 'description'},
      color       = ${color !== undefined ? '?' : 'color'},
      sort_order  = ${sort_order !== undefined ? '?' : 'sort_order'},
      archived    = ${archived !== undefined ? '?' : 'archived'},
      updated_at  = datetime('now')
    WHERE id = ?
  `).run(
    ...[
      name || null,
      ...(description !== undefined ? [description] : []),
      ...(color !== undefined ? [color] : []),
      ...(sort_order !== undefined ? [isNaN(sort_order) ? 0 : sort_order] : []),
      ...(archived !== undefined ? [archived] : []),
      id,
    ]
  )

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown>
  res.json(mapProject(updated))
})

// DELETE /api/projects/:id
// Nulls out project_id on all objectives in this project (never deletes
// objectives), then deletes the project row. Returns { detached_objectives }.
router.delete('/:id', (req: AuthRequest, res) => {
  const db = getDb()
  const id = parseInt(typeof req.params.id === 'string' ? req.params.id : '', 10)
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid project id' })
    return
  }

  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!existing) {
    res.status(404).json({ error: 'Project not found' })
    return
  }
  if (!canAccessWorkspace(req, existing.workspace as string)) {
    res.status(403).json({ error: `No access to workspace '${existing.workspace}'` })
    return
  }

  const detach = db.prepare('UPDATE objectives SET project_id = NULL WHERE project_id = ?').run(id)
  db.prepare('DELETE FROM projects WHERE id = ?').run(id)

  res.json({ deleted: true, detached_objectives: detach.changes })
})

export default router
