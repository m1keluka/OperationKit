/**
 * Shared objective access/mapping helpers — extracted from objectives.ts
 * (behavior frozen). Used by CRUD and the remaining facade routes.
 */
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { getWorkspace } from '../services/workspaces.js'
import { resolveAvailable } from '../services/resource-assignments.js'
import type { Objective } from '@command-center/shared'

/**
 * Lightweight card projection for the board LIST (obj 700512). This is EVERY
 * objectives column EXCEPT the six heavy TEXT fields the board/cards never read:
 * description, last_session_summary, approved_plan, ai_review_findings,
 * acceptance_criteria, transcript_path. Those (avg ~3.3KB description alone)
 * ballooned the list to 15MB / 2125 rows; the detail views fetch them on demand
 * via GET /:id. Keeping every OTHER scalar/flag means no board logic regresses —
 * we only drop text the card doesn't render. mapObjective still runs over these
 * rows; acceptance_criteria simply resolves to null (the column is absent).
 */
export const LIST_COLUMNS = [
  'id', 'title', 'status', 'agent_context', 'assigned_user_id', 'session_id',
  'created_at', 'updated_at', 'workspace', 'category', 'parent_id', 'depth', 'project',
  // project_id = board Project FK (DISTINCT from project = repo-link above)
  'project_id',
  'session_count', 'total_cost_usd', 'total_tokens', 'has_blockers', 'task_count',
  'tasks_passed', 'create_pr', 'branch_name', 'pr_url', 'pr_number', 'completion_goal',
  'workflow_hint', 'effort', 'created_by', 'type', 'plan_approved_at', 'planning_session_id',
  'ai_review_verdict', 'ai_review_session_id', 'skip_ai_review', 'ai_review_iteration',
  'test_cred_slug', 'model', 'routine_id', 'delegate_mode', 'job_disposition',
  'job_review_note', 'source_job_id', 'scope_flags', 'reconcile_sig', 'is_strategy',
  'rejected_tree_sha', 'not_mergeable', 'trust_stage', 'origin', 'strategy_id',
  'last_activity_at', 'ran_on_fallback', 'fallback_detected_at', 'ran_model',
].join(', ')

/**
 * Read-access gate for a single objective, mirroring the LIST visibility rules
 * (obj 700512 GET /:id). Admins see all; a member sees an objective if their
 * membership for that workspace is 'all'-visibility, or they own it. Kept aligned
 * with the list query so detail fetches never leak across workspaces (obj 1001/700082).
 */
export function canReadObjective(req: AuthRequest, objective: Objective): boolean {
  const user = req.user!
  if (user.role === 'admin') return true
  const membership = getUserWorkspaces(user.id).find(m => m.workspace === objective.workspace)
  if (!membership) return false
  if (membership.objective_visibility === 'all') return true
  return userOwnsObjective(user.id, objective)
}

/**
 * Maps a raw SQLite objectives row to the typed Objective contract. SQLite
 * returns 0/1 for INTEGER-typed boolean columns and stores JSON columns as
 * TEXT — both need explicit normalization before the row leaves the server.
 *
 * Touches only the columns whose stored shape differs from the wire shape:
 * - boolean: has_blockers, create_pr, skip_ai_review (0/1 → boolean)
 * - JSON:    acceptance_criteria (TEXT → AcceptanceCriterion[] | null)
 * - hydrate: assigned_user_ids from the objective_assignees join table, and the
 *            matching assigned_usernames from users.username (obj 700850)
 *
 * `userMap` (id → username) is an OPTIONAL preloaded lookup. The board LIST maps
 * hundreds of rows, so it builds the map ONCE (buildUsernameMap) and passes it in
 * here — resolving names is then a pure in-memory lookup with zero per-card
 * queries (no N+1). Single-object / short-list callers may omit it, in which case
 * we resolve the handful of ids with one targeted `IN (...)` query.
 */
export function buildUsernameMap(): Map<number, string> {
  const rows = getDb().prepare('SELECT id, username FROM users').all() as { id: number; username: string }[]
  return new Map(rows.map(u => [u.id, u.username]))
}

export function resolveUsernames(assignedIds: number[], userMap?: Map<number, string>): string[] {
  if (assignedIds.length === 0) return []
  const lookup = userMap ?? (() => {
    const placeholders = assignedIds.map(() => '?').join(',')
    const rows = getDb()
      .prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`)
      .all(...assignedIds) as { id: number; username: string }[]
    return new Map(rows.map(u => [u.id, u.username]))
  })()
  // Preserve assignedIds order (primary first); drop ids with no matching user.
  return assignedIds
    .map(id => lookup.get(id))
    .filter((name): name is string => typeof name === 'string')
}

export function mapObjective(row: Objective, userMap?: Map<number, string>): Objective {
  const r = row as unknown as Record<string, unknown>
  let acceptance: unknown = null
  const raw = r.acceptance_criteria
  if (typeof raw === 'string' && raw.length > 0) {
    try { acceptance = JSON.parse(raw) } catch { acceptance = null }
  }
  const ids = getDb()
    .prepare('SELECT user_id FROM objective_assignees WHERE objective_id = ? ORDER BY user_id')
    .all(row.id) as { user_id: number }[]
  const assignedIds = ids.map(x => x.user_id)
  // Ensure the primary assignee is present in the list (defensive — backfill
  // covers this, but a manual DB poke or a row with assigned_user_id but no
  // join row would otherwise vanish from the multi-assign view).
  if (row.assigned_user_id != null && !assignedIds.includes(row.assigned_user_id)) {
    assignedIds.unshift(row.assigned_user_id)
  }
  return {
    ...row,
    has_blockers: !!r.has_blockers,
    create_pr: !!r.create_pr,
    delegate_mode: !!r.delegate_mode,
    is_strategy: !!r.is_strategy,
    terminal_by_human: !!r.terminal_by_human,
    skip_ai_review: !!r.skip_ai_review,
    ran_on_fallback: !!r.ran_on_fallback,
    acceptance_criteria: acceptance as Objective['acceptance_criteria'],
    assigned_user_ids: assignedIds,
    assigned_usernames: resolveUsernames(assignedIds, userMap),
  }
}

/** Replace the join-table rows for an objective with the given set of user ids. */
export function setAssignees(objectiveId: number, userIds: number[]): void {
  const db = getDb()
  const tx = db.transaction((ids: number[]) => {
    db.prepare('DELETE FROM objective_assignees WHERE objective_id = ?').run(objectiveId)
    const insert = db.prepare('INSERT OR IGNORE INTO objective_assignees (objective_id, user_id) VALUES (?, ?)')
    for (const uid of ids) insert.run(objectiveId, uid)
  })
  tx(userIds)
}

/**
 * Normalize the incoming assignee fields to a single canonical list. Callers
 * can send either `assigned_user_ids` (the new multi-assign array) or the
 * legacy `assigned_user_id` shorthand. If both are sent, the array wins.
 * Returns null when the caller didn't touch assignment at all.
 */
export function normalizeAssignees(
  legacy: number | null | undefined,
  multi: number[] | undefined,
): number[] | null {
  if (multi !== undefined) {
    return Array.from(new Set(multi.filter(n => typeof n === 'number' && n > 0)))
  }
  if (legacy !== undefined) {
    return legacy ? [legacy] : []
  }
  return null
}

/** Check if a non-admin user owns an objective (created it or is assigned to it) */
export function userOwnsObjective(userId: number, objective: Objective): boolean {
  if (objective.created_by === userId) return true
  if (objective.assigned_user_id === userId) return true
  const row = getDb()
    .prepare('SELECT 1 FROM objective_assignees WHERE objective_id = ? AND user_id = ?')
    .get(objective.id, userId)
  return !!row
}

/**
 * Phase-3 gate: an agent must be in the workspace's default_agent_pool to be
 * assignable to an objective in that workspace. Empty pool (legacy / freshly
 * created workspaces) is treated as "no restriction" so we don't break
 * pre-Phase-3 rows on upgrade. Returns null on pass, error message on fail.
 */
export function checkAgentInWorkspacePool(
  workspace: string,
  agentContext: string,
  project?: string | null,
): string | null {
  // obj-2388: project-grain agent assignments (resource_assignments) COMPLEMENT
  // the workspace pool. If any agent assignment is scoped to this workspace or
  // (workspace, project), availability is restricted to the resolved set; absent
  // such assignments this is a no-op and the legacy workspace-pool gate governs.
  const avail = resolveAvailable('agent', { workspace, project })
  if (avail.restricted && !avail.allowed.includes(agentContext)) {
    return `Agent '${agentContext}' is not assigned to ${project ? `project '${project}'` : `workspace '${workspace}'`} (allowed: ${avail.allowed.join(', ') || 'none'})`
  }

  const ws = getWorkspace(workspace)
  if (!ws) return null // workspace existence is checked elsewhere; pool gate skips
  const pool = ws.default_agent_pool
  if (!pool || pool.length === 0) return null // unconfigured pool = allow any
  if (pool.includes(agentContext)) return null
  return `Agent '${agentContext}' is not in workspace '${workspace}' pool (allowed: ${pool.join(', ')})`
}

/**
 * Server-side default for `agent_context` when the caller does not supply one
 * (obj 708817 — the human create form no longer asks for an agent).
 *
 * There is no classifier: `AGENT_MAP[objective.agent_context]` in
 * prompt-builder.ts is the ONLY thing that picks the persona and the working
 * directory, so an absent agent MUST resolve to a concrete, deterministic value.
 * The workspace's own `default_agent_pool[0]` is that value — it gives
 * per-workspace routing (operationkit -> 'cto', a marketing workspace -> 'cmo')
 * with no new logic — falling back to 'general' for a legacy/unconfigured pool.
 *
 * Callers that DO send agent_context keep their exact previous behaviour; this
 * is only consulted for the absent case.
 */
export function defaultAgentForWorkspace(workspace: string): string {
  const ws = getWorkspace(workspace)
  const pool = ws?.default_agent_pool
  if (pool && pool.length > 0) return pool[0]
  return 'general'
}

/** Middleware-style ownership check for member users. Admins always pass. */
export function requireOwnership(req: AuthRequest, objective: Objective): string | null {
  const user = req.user!
  if (user.role === 'admin') return null
  if (!userOwnsObjective(user.id, objective)) {
    return 'You do not have access to this objective'
  }
  return null
}

