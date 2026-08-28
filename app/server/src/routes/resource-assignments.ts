/**
 * Scoped agent/skill assignment — REST surface (obj-2388).
 *
 * Thin authorization + validation layer over services/resource-assignments.ts.
 * Mirrors routes/secrets.ts: `requireAuth`, `req.user`, a single `canAccessScope`
 * gate, 400 validation. Reuses the obj-2353/1731 scope model (global/workspace/
 * user) and adds a `project` scope target.
 *
 * ACCESS MATRIX (who may create/list/delete an assignment at a scope):
 *   - global    → global admin only (user.role === 'admin').
 *   - workspace → global admin OR any member of ws.
 *   - project   → global admin OR any member of the project's workspace.
 *   - user      → global admin OR the user themselves.
 *
 * Resource availability RESOLUTION (which skills/agents a session may use) is a
 * separate, unauthenticated-by-membership read used by the spawn path; it is
 * exposed at GET /resolve for verification/admin tooling.
 */
import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import {
  setAssignment,
  listAssignments,
  deleteAssignment,
  resolveAvailable,
  type ResourceScope,
} from '../services/resource-assignments.js'
import type { User, ResourceType, ResourceScopeType } from '@command-center/shared'

const RESOURCE_TYPES: ResourceType[] = ['agent', 'skill']
const SCOPE_TYPES: ResourceScopeType[] = ['global', 'workspace', 'user', 'project']

/** True if a user_workspaces row exists for (userId, ws) — ANY role. */
function isWorkspaceMember(userId: number, ws: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM user_workspaces WHERE user_id = ? AND workspace = ?')
    .get(userId, ws) as { 1: number } | undefined
  return !!row
}

/** The single authorization gate. Global admins bypass everything. */
export function canAccessScope(user: User, scope: ResourceScope): boolean {
  if (user.role === 'admin') return true
  switch (scope.scopeType) {
    case 'global':
      return false // global admin only
    case 'workspace':
      return !!scope.workspace && isWorkspaceMember(user.id, scope.workspace)
    case 'project':
      // A project lives inside its workspace; membership of the workspace gates it.
      return !!scope.workspace && isWorkspaceMember(user.id, scope.workspace)
    case 'user':
      return scope.userId != null && user.id === scope.userId
    default:
      return false
  }
}

/** Validate + build a ResourceScope from loose inputs. Does NOT check access. */
function parseScope(
  scopeType: unknown,
  workspace: unknown,
  project: unknown,
  userIdRaw: unknown,
): { scope: ResourceScope } | { error: string } {
  if (typeof scopeType !== 'string' || !SCOPE_TYPES.includes(scopeType as ResourceScopeType)) {
    return { error: `scopeType must be one of: ${SCOPE_TYPES.join(', ')}` }
  }
  const st = scopeType as ResourceScopeType
  const ws = workspace == null || workspace === '' ? null : String(workspace)
  const proj = project == null || project === '' ? null : String(project)
  let uid: number | null = null
  if (userIdRaw != null && userIdRaw !== '') {
    const n = Number(userIdRaw)
    if (!Number.isInteger(n)) return { error: 'userId must be an integer' }
    uid = n
  }
  if ((st === 'workspace' || st === 'project') && !ws) {
    return { error: `scope '${st}' requires a workspace` }
  }
  if (st === 'project' && !proj) {
    return { error: `scope 'project' requires a project` }
  }
  if (st === 'user' && uid == null) {
    return { error: `scope 'user' requires a userId` }
  }
  // Clear irrelevant dimensions so the stored scope is canonical.
  return {
    scope: {
      scopeType: st,
      workspace: st === 'workspace' || st === 'project' ? ws : null,
      project: st === 'project' ? proj : null,
      userId: st === 'user' ? uid : null,
    },
  }
}

function parseResourceType(v: unknown): ResourceType | null {
  return typeof v === 'string' && RESOURCE_TYPES.includes(v as ResourceType)
    ? (v as ResourceType)
    : null
}

const router = Router()
router.use(requireAuth)

// GET /api/resource-assignments — list assignments the caller may see.
//   - ?resourceType= filters by kind.
//   - Admin sees all; members see assignments at scopes they can access.
router.get('/', (req: AuthRequest, res) => {
  const user = req.user!
  const rt = req.query.resourceType
  let resourceType: ResourceType | undefined
  if (rt !== undefined) {
    const parsed = parseResourceType(rt)
    if (!parsed) {
      res.status(400).json({ error: `resourceType must be one of: ${RESOURCE_TYPES.join(', ')}` })
      return
    }
    resourceType = parsed
  }
  const all = listAssignments({ resourceType })
  if (user.role === 'admin') {
    res.json(all)
    return
  }
  const visible = all.filter((a) =>
    canAccessScope(user, {
      scopeType: a.scopeType,
      workspace: a.workspace,
      project: a.project,
      userId: a.userId,
    }),
  )
  res.json(visible)
})

// GET /api/resource-assignments/resolve?resourceType=&workspace=&project=&userId=
//   Returns the effective availability (restricted + allowed[]) for a session
//   context. The gate the spawn path uses; exposed for verification/admin UI.
router.get('/resolve', (req: AuthRequest, res) => {
  const user = req.user!
  const rt = parseResourceType(req.query.resourceType)
  if (!rt) {
    res.status(400).json({ error: `resourceType must be one of: ${RESOURCE_TYPES.join(', ')}` })
    return
  }
  const workspace = req.query.workspace
  if (typeof workspace !== 'string' || !workspace.trim()) {
    res.status(400).json({ error: 'workspace is required' })
    return
  }
  // Non-admins may only resolve for a workspace they belong to.
  if (user.role !== 'admin' && !isWorkspaceMember(user.id, workspace)) {
    res.status(403).json({ error: 'You do not have access to this workspace' })
    return
  }
  const project = typeof req.query.project === 'string' ? req.query.project : null
  const userIdRaw = req.query.userId
  const userId =
    userIdRaw != null && userIdRaw !== '' && Number.isInteger(Number(userIdRaw))
      ? Number(userIdRaw)
      : null
  const result = resolveAvailable(rt, { workspace, project, userId })
  res.json({ resourceType: rt, ...result })
})

// POST /api/resource-assignments — create (or re-assert) an assignment.
router.post('/', (req: AuthRequest, res) => {
  const user = req.user!
  const body = (req.body ?? {}) as Record<string, unknown>
  const resourceType = parseResourceType(body.resourceType)
  if (!resourceType) {
    res.status(400).json({ error: `resourceType must be one of: ${RESOURCE_TYPES.join(', ')}` })
    return
  }
  const resourceId = typeof body.resourceId === 'string' ? body.resourceId.trim() : ''
  if (!resourceId) {
    res.status(400).json({ error: 'resourceId is required' })
    return
  }
  const parsed = parseScope(body.scopeType, body.workspace, body.project, body.userId)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  if (!canAccessScope(user, parsed.scope)) {
    res.status(403).json({ error: 'You do not have access to this scope' })
    return
  }
  const assignment = setAssignment({
    resourceType,
    resourceId,
    scope: parsed.scope,
    actorUserId: user.id,
  })
  res.status(201).json(assignment)
})

// DELETE /api/resource-assignments?resourceType=&resourceId=&scopeType=&workspace=&project=&userId=
router.delete('/', (req: AuthRequest, res) => {
  const user = req.user!
  const resourceType = parseResourceType(req.query.resourceType)
  if (!resourceType) {
    res.status(400).json({ error: `resourceType must be one of: ${RESOURCE_TYPES.join(', ')}` })
    return
  }
  const resourceId = typeof req.query.resourceId === 'string' ? req.query.resourceId.trim() : ''
  if (!resourceId) {
    res.status(400).json({ error: 'resourceId is required' })
    return
  }
  const parsed = parseScope(req.query.scopeType, req.query.workspace, req.query.project, req.query.userId)
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  if (!canAccessScope(user, parsed.scope)) {
    res.status(403).json({ error: 'You do not have access to this scope' })
    return
  }
  const removed = deleteAssignment({ resourceType, resourceId, scope: parsed.scope })
  if (!removed) {
    res.status(404).json({ error: 'assignment not found' })
    return
  }
  res.status(204).end()
})

export default router
