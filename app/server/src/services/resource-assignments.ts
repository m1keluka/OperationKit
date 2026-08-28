/**
 * Scoped agent/skill assignment store + resolution (obj-2388).
 *
 * Reuses the obj-2353/1731 credential SCOPE MODEL (global / workspace / user)
 * and ADDS a `project` tier, applied to a new resource kind: agents and skills.
 * This is the single scoping engine for "which agent/skill is assigned where" —
 * there is deliberately no parallel mechanism (the credential `secrets` store is
 * the sibling; this mirrors its shape without crypto/versioning since an
 * assignment carries no secret value).
 *
 * SENTINELS: scope dimensions that don't apply are stored as '' (workspace,
 * project) / 0 (user_id), matching `secrets`, so the UNIQUE index collapses.
 *
 * RESOLUTION SEMANTICS (generalizes Phase-7 `default_agent_pool`):
 *   For a session in (workspace W, project P, on-behalf user U), a resource_type
 *   T is RESTRICTED iff at least one assignment of T is scoped to W (workspace
 *   scope) or (W,P) (project scope). When restricted, the available set is the
 *   union of: global-T assignments (always-on baseline) + workspace-T for W +
 *   project-T for (W,P) + user-T for U. When NOT restricted (no workspace/project
 *   assignment touches this context), T is unrestricted = legacy allow-any.
 *   This makes "scope a workspace/project" turn on its allow-list exactly the way
 *   a non-empty `default_agent_pool` does today, while staying additive/back-compat.
 */
import { getDb } from '../db/index.js'
import type {
  ResourceType,
  ResourceScopeType,
  ResourceAssignment,
} from '@command-center/shared'

export type { ResourceType, ResourceScopeType, ResourceAssignment }

export interface ResourceScope {
  scopeType: ResourceScopeType
  workspace: string | null
  project: string | null
  userId: number | null
}

interface Row {
  id: number
  resource_type: ResourceType
  resource_id: string
  scope_type: ResourceScopeType
  workspace: string
  project: string
  user_id: number
  created_by: number | null
  created_at: string
}

function rowToAssignment(r: Row): ResourceAssignment {
  return {
    id: r.id,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    scopeType: r.scope_type,
    workspace: r.workspace === '' ? null : r.workspace,
    project: r.project === '' ? null : r.project,
    userId: r.user_id === 0 ? null : r.user_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }
}

/** Map a scope's optional dimensions to the NOT-NULL sentinels used in the DB. */
function sentinels(scope: ResourceScope): { workspace: string; project: string; userId: number } {
  return {
    workspace: scope.workspace ?? '',
    project: scope.project ?? '',
    userId: scope.userId ?? 0,
  }
}

/**
 * Create an assignment (idempotent — re-asserting the same (resource, scope) is
 * a no-op via INSERT OR IGNORE). Returns the resulting assignment row.
 */
export function setAssignment(args: {
  resourceType: ResourceType
  resourceId: string
  scope: ResourceScope
  actorUserId: number
}): ResourceAssignment {
  const db = getDb()
  const s = sentinels(args.scope)
  db.prepare(
    `INSERT OR IGNORE INTO resource_assignments
       (resource_type, resource_id, scope_type, workspace, project, user_id, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.resourceType,
    args.resourceId,
    args.scope.scopeType,
    s.workspace,
    s.project,
    s.userId,
    args.actorUserId,
  )
  const row = db
    .prepare(
      `SELECT * FROM resource_assignments
        WHERE resource_type = ? AND resource_id = ? AND scope_type = ?
          AND workspace = ? AND project = ? AND user_id = ?`,
    )
    .get(
      args.resourceType,
      args.resourceId,
      args.scope.scopeType,
      s.workspace,
      s.project,
      s.userId,
    ) as Row
  return rowToAssignment(row)
}

/** List assignments, optionally filtered by resource_type and/or a single scope. */
export function listAssignments(filter?: {
  resourceType?: ResourceType
  scope?: ResourceScope
}): ResourceAssignment[] {
  const db = getDb()
  const where: string[] = []
  const params: unknown[] = []
  if (filter?.resourceType) {
    where.push('resource_type = ?')
    params.push(filter.resourceType)
  }
  if (filter?.scope) {
    const s = sentinels(filter.scope)
    where.push('scope_type = ? AND workspace = ? AND project = ? AND user_id = ?')
    params.push(filter.scope.scopeType, s.workspace, s.project, s.userId)
  }
  const sql =
    `SELECT * FROM resource_assignments` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY resource_type, resource_id, scope_type`
  const rows = db.prepare(sql).all(...params) as Row[]
  return rows.map(rowToAssignment)
}

/** Delete one assignment by its exact (resource, scope) identity. Returns true if a row was removed. */
export function deleteAssignment(args: {
  resourceType: ResourceType
  resourceId: string
  scope: ResourceScope
}): boolean {
  const db = getDb()
  const s = sentinels(args.scope)
  const info = db
    .prepare(
      `DELETE FROM resource_assignments
        WHERE resource_type = ? AND resource_id = ? AND scope_type = ?
          AND workspace = ? AND project = ? AND user_id = ?`,
    )
    .run(
      args.resourceType,
      args.resourceId,
      args.scope.scopeType,
      s.workspace,
      s.project,
      s.userId,
    )
  return info.changes > 0
}

export interface SessionContext {
  workspace: string
  project?: string | null
  userId?: number | null
}

/**
 * Resolve which resources of `resourceType` are available to a session in the
 * given context. See RESOLUTION SEMANTICS above.
 *   - restricted=false → unrestricted (legacy allow-any); `allowed` is the
 *     (possibly empty) set of explicit grants but callers should not filter.
 *   - restricted=true  → availability is exactly `allowed`.
 */
export function resolveAvailable(
  resourceType: ResourceType,
  ctx: SessionContext,
): { restricted: boolean; allowed: string[] } {
  const db = getDb()
  const ws = ctx.workspace
  const project = ctx.project ?? ''
  const userId = ctx.userId ?? 0

  const rows = db
    .prepare(`SELECT * FROM resource_assignments WHERE resource_type = ?`)
    .all(resourceType) as Row[]

  // A workspace/project-scoped assignment touching THIS context turns on the
  // allow-list. Global + user assignments are additive, never restriction triggers.
  const restricted = rows.some(
    (r) =>
      (r.scope_type === 'workspace' && r.workspace === ws) ||
      (r.scope_type === 'project' && r.workspace === ws && r.project === project),
  )

  const allowed = new Set<string>()
  for (const r of rows) {
    if (r.scope_type === 'global') allowed.add(r.resource_id)
    else if (r.scope_type === 'workspace' && r.workspace === ws) allowed.add(r.resource_id)
    else if (r.scope_type === 'project' && r.workspace === ws && r.project === project)
      allowed.add(r.resource_id)
    else if (r.scope_type === 'user' && userId !== 0 && r.user_id === userId)
      allowed.add(r.resource_id)
  }

  return { restricted, allowed: [...allowed].sort() }
}

/**
 * True if `resourceId` of `resourceType` is available to a session in `ctx`.
 * Unrestricted contexts always return true (back-compat). Used as the session
 * gate for agents (complementing `default_agent_pool`) and skills.
 */
export function isResourceAvailable(
  resourceType: ResourceType,
  resourceId: string,
  ctx: SessionContext,
): boolean {
  const { restricted, allowed } = resolveAvailable(resourceType, ctx)
  if (!restricted) return true
  return allowed.includes(resourceId)
}
