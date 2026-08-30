/**
 * List + CRUD routes — extracted from objectives.ts (behavior frozen).
 * Registered on the same /api/objectives router. SQL and HTTP paths unchanged.
 */
import { Router } from 'express'
import { getDb, resolveStrategyId } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { resolveObjectiveModel } from '../services/model-registry.js'
import { depthForParent, recomputeSubtreeDepth } from '../lib/objective-depth.js'
import {
  getInitialStatus,
  DEFAULT_EFFORT_BY_TYPE,
  type Objective,
  type ObjectiveType,
  type CreateObjectiveRequest,
  type UpdateObjectiveRequest,
} from '@operationkit/shared'
import { stopSession } from '../services/session-manager.js'
import {
  logObjectiveAudit,
  isSoftDeleteEnabled,
} from '../services/objective-audit.js'
import { broadcast } from '../ws/index.js'
import { computeStrategyRollup } from '../services/strategy-governance.js'
import {
  LIST_COLUMNS,
  canReadObjective,
  buildUsernameMap,
  mapObjective,
  setAssignees,
  normalizeAssignees,
  checkAgentInWorkspacePool,
  defaultAgentForWorkspace,
  requireOwnership,
} from './objectives-helpers.js'

export function registerObjectiveCrudRoutes(router: Router): void {
// GET /api/objectives?workspace=example[&status=done&limit=50&offset=0]
// GET /api/objectives?workspaces=example,example2  (multi-select; empty / omitted = all)
//
// Board LIST endpoint (obj 700512, extended obj 700872). Returns the lightweight
// LIST_COLUMNS projection (heavy text omitted — fetch full via GET /:id) and, by
// DEFAULT, EXCLUDES BOTH status=done AND status=cancelled (the bulk of the old
// 15MB payload — ~2350 done + 62 cancelled rows). Both are HIDDEN by default on
// the board and each retrievable on demand via ?status=done / ?status=cancelled,
// paginated newest-first with ?limit/?offset. Admin vs member visibility and
// ?workspace scoping are preserved EXACTLY (view-leak fixes obj 1001/700082): the
// status filter and pagination are additive constraints layered onto the same
// visibility queries.
router.get('/', (req: AuthRequest, res) => {
  const db = getDb()
  const user = req.user!
  const single = req.query.workspace as string | undefined
  const multi = req.query.workspaces as string | undefined
  const requested = (multi != null
    ? multi.split(',')
    : single != null ? [single] : []
  ).map(s => s.trim()).filter(s => s && s !== 'all')
  const workspace = requested.length === 1 ? requested[0] : undefined
  const statusFilter = req.query.status as string | undefined

  // Status predicate: an explicit ?status=X narrows to it (the on-demand lazy
  // columns are ?status=done and ?status=cancelled); with no status the default
  // EXCLUDES both done and cancelled (active pipeline only). The NOT IN predicate
  // is byte-matched to the partial index idx_obj_active_updated (db/index.ts) so
  // the default board query uses the index instead of a full SCAN + TEMP B-TREE.
  const statusClause = statusFilter ? 'status = ?' : "status NOT IN ('done', 'cancelled')"
  const statusParams: unknown[] = statusFilter ? [statusFilter] : []

  // Soft-delete (obj 700415): hide tombstoned rows by default; an admin may pass
  // ?include_deleted=1 to see them (the Trash/Restore view). Enforced IN SQL —
  // the slim LIST_COLUMNS projection deliberately omits `deleted_at`, so a
  // post-SELECT `.filter(o => !o.deleted_at)` can't see the column (it would be
  // undefined and let every tombstone through). It also keeps pagination honest:
  // deleted rows are excluded BEFORE LIMIT/OFFSET, not after. No placeholders, so
  // it's appended to each WHERE without disturbing param order.
  const includeDeleted = req.query.include_deleted === '1' && user.role === 'admin'
  const tombstoneClause = includeDeleted ? '' : ' AND deleted_at IS NULL'

  // project_id filter — ?project_id=<N> narrows to a single project;
  // ?project_id=unassigned narrows to rows where project_id IS NULL.
  const projectIdParam = req.query.project_id as string | undefined
  let projectIdClause = ''
  const projectIdParams: unknown[] = []
  if (projectIdParam !== undefined) {
    if (projectIdParam === 'unassigned') {
      projectIdClause = ' AND project_id IS NULL'
    } else {
      const pid = parseInt(projectIdParam, 10)
      if (!isNaN(pid)) {
        projectIdClause = ' AND project_id = ?'
        projectIdParams.push(pid)
      }
    }
  }

  // Optional pagination (used by the lazy Done column). Cap the page size so a
  // caller can't request the whole done backlog at once.
  const rawLimit = parseInt(req.query.limit as string, 10)
  const rawOffset = parseInt(req.query.offset as string, 10)
  const limit = !isNaN(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : null
  const offset = !isNaN(rawOffset) && rawOffset >= 0 ? rawOffset : 0
  const pageClause = limit != null ? ` LIMIT ${limit} OFFSET ${offset}` : ''

  let objectives: Objective[]

  if (user.role === 'admin') {
    // Admins see everything in the requested workspaces (or all when unfiltered).
    if (requested.length > 0) {
      objectives = db
        .prepare(`SELECT ${LIST_COLUMNS} FROM objectives WHERE workspace IN (${requested.map(() => '?').join(',')}) AND ${statusClause}${tombstoneClause}${projectIdClause} ORDER BY updated_at DESC${pageClause}`)
        .all(...requested, ...statusParams, ...projectIdParams) as Objective[]
    } else {
      objectives = db
        .prepare(`SELECT ${LIST_COLUMNS} FROM objectives WHERE ${statusClause}${tombstoneClause}${projectIdClause} ORDER BY updated_at DESC${pageClause}`)
        .all(...statusParams, ...projectIdParams) as Objective[]
    }
  } else {
    // Members see objectives within their workspace memberships. Each membership
    // has an `objective_visibility` flag — 'own' (default) shows only objectives
    // the member created or is assigned to; 'all' shows every objective in that
    // workspace (used when an admin grants full read access to a member).
    const memberships = getUserWorkspaces(user.id)
    const scoped = requested.length > 0
      ? memberships.filter(m => requested.includes(m.workspace))
      : memberships
    if (scoped.length === 0) {
      res.json([])
      return
    }
    const allWs = scoped.filter(m => m.objective_visibility === 'all').map(m => m.workspace)
    const ownWs = scoped.filter(m => m.objective_visibility !== 'all').map(m => m.workspace)

    if (workspace && scoped.length === 1) {
      const membership = scoped[0]
      if (membership.objective_visibility === 'all') {
        objectives = db
          .prepare(
            `SELECT ${LIST_COLUMNS} FROM objectives
             WHERE workspace = ? AND ${statusClause}${tombstoneClause}${projectIdClause}
             ORDER BY updated_at DESC${pageClause}`
          )
          .all(workspace, ...statusParams, ...projectIdParams) as Objective[]
      } else {
        // "own" visibility — caller is the creator, the primary assignee, or
        // listed in the objective_assignees join table.
        objectives = db
          .prepare(
            `SELECT ${LIST_COLUMNS} FROM objectives
             WHERE workspace = ? AND ${statusClause}${tombstoneClause}${projectIdClause}
               AND (
                 assigned_user_id = ?
                 OR created_by = ?
                 OR id IN (SELECT objective_id FROM objective_assignees WHERE user_id = ?)
               )
             ORDER BY updated_at DESC${pageClause}`
          )
          .all(workspace, ...statusParams, ...projectIdParams, user.id, user.id, user.id) as Objective[]
      }
    } else {
      // Cross-workspace: union of (all-visibility workspaces, full set) and
      // (own-visibility workspaces, filtered to ownership).
      const clauses: string[] = []
      const params: unknown[] = []
      if (allWs.length > 0) {
        clauses.push(`workspace IN (${allWs.map(() => '?').join(',')})`)
        params.push(...allWs)
      }
      if (ownWs.length > 0) {
        clauses.push(
          `(workspace IN (${ownWs.map(() => '?').join(',')}) AND (
             assigned_user_id = ?
             OR created_by = ?
             OR id IN (SELECT objective_id FROM objective_assignees WHERE user_id = ?)
           ))`
        )
        params.push(...ownWs, user.id, user.id, user.id)
      }
      if (clauses.length === 0) {
        res.json([])
        return
      }
      objectives = db
        .prepare(
          `SELECT ${LIST_COLUMNS} FROM objectives
           WHERE (${clauses.join(' OR ')}) AND ${statusClause}${tombstoneClause}${projectIdClause}
           ORDER BY updated_at DESC${pageClause}`
        )
        .all(...params, ...statusParams, ...projectIdParams) as Objective[]
    }
  }
  const userMap = buildUsernameMap()
  res.json(objectives.map(o => mapObjective(o, userMap)))
})

// GET /api/objectives/strategies?workspace=example — JWT-authed list of Strategies
// (is_strategy=1) for the strategy-association selector (obj 2386). Distinct from
// the localhost-only /api/internal/strategies; this is the client-facing list.
// Registered before any '/:id' route so "strategies" isn't captured as an id.
router.get('/strategies', (req: AuthRequest, res) => {
  const db = getDb()
  const user = req.user!
  const workspace = req.query.workspace as string | undefined
  let rows: Objective[]
  if (user.role === 'admin') {
    rows = (workspace && workspace !== 'all'
      ? db.prepare('SELECT * FROM objectives WHERE is_strategy = 1 AND workspace = ? ORDER BY updated_at DESC').all(workspace)
      : db.prepare('SELECT * FROM objectives WHERE is_strategy = 1 ORDER BY updated_at DESC').all()) as Objective[]
  } else {
    // Members: only Strategies in workspaces they belong to.
    const ws = getUserWorkspaces(user.id).map(w => w.workspace)
    if (ws.length === 0) { res.json([]); return }
    const scope = workspace && workspace !== 'all' ? (ws.includes(workspace) ? [workspace] : []) : ws
    if (scope.length === 0) { res.json([]); return }
    rows = db
      .prepare(`SELECT * FROM objectives WHERE is_strategy = 1 AND workspace IN (${scope.map(() => '?').join(',')}) ORDER BY updated_at DESC`)
      .all(...scope) as Objective[]
  }
  // Enrich each strategy with its rollup (child-status counts, budget summary,
  // pendingDecisionId) so the INDEX page renders without an N+1 of per-strategy
  // governance fetches. Computed via the SAME helper the governance detail
  // endpoint uses, so list + detail never diverge (obj 700132). Additive: the
  // object is a strict superset of mapObjective's — existing consumers (the
  // strategy-association selector, obj 2386) just ignore the extra field.
  const userMap = buildUsernameMap()
  res.json(rows.map(o => ({ ...mapObjective(o, userMap), rollup: computeStrategyRollup(db, o) })))
})

// GET /api/objectives/:id — full single-objective detail (obj 700512).
// The board LIST now omits heavy text columns, so the detail/modal views fetch
// the COMPLETE row (SELECT *) here to render description, approved_plan,
// ai_review_findings, last_session_summary, acceptance_criteria, etc. Registered
// AFTER '/strategies' and '/goal' so those literal GET paths win over ':id', and
// before '/:id/output' (a longer path that ':id' can't match). Visibility mirrors
// the list via canReadObjective so a detail fetch never leaks across workspaces.
router.get('/:id', (req: AuthRequest, res) => {
  const db = getDb()
  const objective = db
    .prepare('SELECT * FROM objectives WHERE id = ?')
    .get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  if (!canReadObjective(req, objective)) {
    res.status(403).json({ error: 'You do not have access to this objective' })
    return
  }
  res.json(mapObjective(objective))
})

// POST /api/objectives
router.post('/', (req: AuthRequest, res) => {
  const { title, description, agent_context, workspace, project, project_id, category, parent_id, assigned_user_id, assigned_user_ids, create_pr, delegate_mode, completion_goal, workflow_hint, effort, model, type, skip_ai_review, strategy_id, is_strategy } = req.body as CreateObjectiveRequest
  const user = req.user!

  if (!title?.trim()) {
    res.status(400).json({ error: 'Title is required' })
    return
  }

  // Members can only create in their allowed workspaces
  const effectiveWorkspace = workspace || 'example'
  if (user.role !== 'admin') {
    const userWs = getUserWorkspaces(user.id).map(w => w.workspace)
    if (!userWs.includes(effectiveWorkspace)) {
      res.status(403).json({ error: `No access to workspace '${effectiveWorkspace}'` })
      return
    }
  }

  // QW5 / audit B#9: skip_ai_review bypasses the QA gate, so enabling it is
  // admin-only. A non-admin creating an objective with the toggle set is
  // rejected outright (matches the admin-gated workspace selector).
  if (skip_ai_review && user.role !== 'admin') {
    res.status(403).json({ error: 'Only admins can enable skip_ai_review' })
    return
  }

  // Resolve the canonical assignee list. Multi-assign payload wins; fall back
  // to the legacy single-id field; members default to self when nothing's set.
  const requested = normalizeAssignees(assigned_user_id, assigned_user_ids)
  let assigneeIds: number[]
  if (requested && requested.length > 0) {
    assigneeIds = requested
  } else if (user.role !== 'admin') {
    assigneeIds = [user.id]
  } else {
    assigneeIds = []
  }
  const effectiveAssignedUserId = assigneeIds.length > 0 ? assigneeIds[0] : null

  // obj 708817: the create form no longer collects an agent, so an absent
  // agent_context resolves to the workspace's primary pool agent (see
  // defaultAgentForWorkspace). An explicitly-supplied agent still wins.
  const effectiveAgent = agent_context || defaultAgentForWorkspace(effectiveWorkspace)
  const poolError = checkAgentInWorkspacePool(effectiveWorkspace, effectiveAgent, project)
  if (poolError) {
    res.status(400).json({ error: poolError })
    return
  }

  // Type drives initial status (project → planning, otherwise → queue) and the
  // effort default when the caller didn't specify one.
  const effectiveType: ObjectiveType = type || 'task'
  const effectiveEffort = effort || DEFAULT_EFFORT_BY_TYPE[effectiveType]
  const initialStatus = getInitialStatus(effectiveType)

  // Stored Strategy marker (obj 2383, corrected obj 2835): a Strategy is a NEW,
  // intentional top tier — it must be set EXPLICITLY by the caller, NEVER inferred
  // from delegate_mode/parent_id. The prior inference (`delegate_mode && parent_id
  // IS NULL`) wrongly stamped nearly every objective Operator runs, since almost all
  // top-level objectives are delegators. is_strategy now defaults to 0 and only
  // becomes 1 when the create request explicitly opts in.
  const isStrategy = is_strategy === true

  const db = getDb()

  // project_id validation: must belong to the same workspace as the objective.
  // When no project_id is supplied but a parent exists, inherit from parent.
  let effectiveProjectId: number | null = null
  if (project_id !== undefined && project_id !== null) {
    const prow = db.prepare('SELECT workspace FROM projects WHERE id = ?').get(project_id) as { workspace: string } | undefined
    if (!prow) {
      res.status(400).json({ error: `project_id ${project_id} does not exist` })
      return
    }
    if (prow.workspace !== effectiveWorkspace) {
      res.status(400).json({ error: `project_id ${project_id} belongs to workspace '${prow.workspace}', not '${effectiveWorkspace}'` })
      return
    }
    effectiveProjectId = project_id
  } else if (project_id === null) {
    // Explicit null — no project
    effectiveProjectId = null
  } else if (parent_id) {
    // Inherit from parent when project_id is omitted (obj 708808: child inherits parent's project)
    const parentRow = db.prepare('SELECT project_id FROM objectives WHERE id = ?').get(parent_id) as { project_id: number | null } | undefined
    effectiveProjectId = parentRow?.project_id ?? null
  }

  // Provenance (obj 2386): this route is human-driven, so origin is always
  // 'manual'. strategy_id resolves an explicit association (a manual objective
  // linked to a Strategy, even with no parent) first, then parent-chain
  // inheritance, then NULL. A Strategy created here points strategy_id at itself
  // is intentionally NOT done — is_strategy already marks it as a Strategy.
  const resolvedStrategyId = resolveStrategyId(db, strategy_id, parent_id ?? null)
  const result = db
    .prepare(
      // depth is DERIVED, never client-supplied (obj 707003). This route omitted
      // the column entirely, so a human-created child inherited the NOT NULL
      // DEFAULT 0 and stayed mislabelled until the next boot backfill guessed 1
      // for it — which was itself wrong for anything below the first level.
      `INSERT INTO objectives (title, description, agent_context, workspace, project, project_id, category, parent_id, depth, assigned_user_id, created_by, create_pr, delegate_mode, is_strategy, completion_goal, workflow_hint, effort, model, type, status, skip_ai_review, origin, strategy_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`
    )
    .run(title.trim(), description || '', effectiveAgent, effectiveWorkspace, project || null, effectiveProjectId, category || 'general', parent_id || null, depthForParent(db, parent_id || null), effectiveAssignedUserId, user.id, create_pr ? 1 : 0, delegate_mode ? 1 : 0, isStrategy ? 1 : 0, completion_goal || null, workflow_hint || null, effectiveEffort, resolveObjectiveModel({ model, type: effectiveType, create_pr, delegate_mode }), effectiveType, initialStatus, skip_ai_review ? 1 : 0, resolvedStrategyId)

  setAssignees(Number(result.lastInsertRowid), assigneeIds)

  const objective = mapObjective(
    db.prepare('SELECT * FROM objectives WHERE id = ?').get(result.lastInsertRowid) as Objective
  )

  broadcast({ type: 'objective_updated', payload: objective })
  res.status(201).json(objective)
})
// PUT /api/objectives/:id
router.put('/:id', (req: AuthRequest, res) => {
  const { title, description, agent_context, workspace, project, project_id, category, parent_id, assigned_user_id, assigned_user_ids, create_pr, delegate_mode, completion_goal, workflow_hint, effort, model, type, skip_ai_review, test_cred_slug, strategy_id, is_strategy } = req.body as UpdateObjectiveRequest
  const db = getDb()

  // Raw row; `existing.create_pr` etc. are 0/1 here because we haven't passed
  // it through mapObjective yet. That's fine — truthy/falsy logic below.
  const existing = db
    .prepare('SELECT * FROM objectives WHERE id = ?')
    .get(req.params.id) as Objective | undefined

  if (!existing) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }

  const ownershipError = requireOwnership(req, existing)
  if (ownershipError) {
    res.status(403).json({ error: ownershipError })
    return
  }

  // QW5 / audit B#9: only admins may ENABLE the AI-review bypass. A non-admin
  // can leave it unchanged or turn it off (which re-arms QA), but cannot turn
  // it on. `existing.skip_ai_review` is the raw 0/1 column value here.
  if (skip_ai_review !== undefined && req.user!.role !== 'admin') {
    const enabling = !!skip_ai_review && !existing.skip_ai_review
    if (enabling) {
      res.status(403).json({ error: 'Only admins can enable skip_ai_review' })
      return
    }
  }

  // Agent-pool gate: only checked when caller is actually changing agent or
  // workspace. Use the post-update values for the lookup (caller-supplied or
  // existing).
  if (agent_context !== undefined || workspace !== undefined) {
    const finalWs = workspace ?? existing.workspace
    const finalAgent = agent_context ?? existing.agent_context
    const finalProject = project ?? existing.project
    const poolError = checkAgentInWorkspacePool(finalWs, finalAgent, finalProject)
    if (poolError) {
      res.status(400).json({ error: poolError })
      return
    }
  }

  // Type change is allowed only while the objective is still pre-execution
  // (planning or queue) — once work has started, switching workflow lanes
  // mid-flight is a foot-gun.
  if (type !== undefined && type !== existing.type) {
    if (existing.status !== 'queue' && existing.status !== 'planning') {
      res.status(400).json({ error: `Cannot change type once objective is past queue (current status: ${existing.status})` })
      return
    }
  }

  // Resolve the new assignee list. null = caller didn't touch assignment.
  const requestedAssignees = normalizeAssignees(assigned_user_id, assigned_user_ids)
  // assigned_user_id column tracks the primary (first) assignee for spawn.
  // When caller didn't touch assignment, keep the existing column value.
  const newPrimary = requestedAssignees === null
    ? existing.assigned_user_id
    : (requestedAssignees.length > 0 ? requestedAssignees[0] : null)

  // Stored Strategy marker (obj 2383, corrected obj 2835). is_strategy is an
  // EXPLICIT marker — it is NEVER re-derived from delegate_mode/parent_id. Toggling
  // delegate_mode or re-parenting must NOT promote/demote the marker (the old
  // recompute wrongly did, re-stamping history). The marker only changes when the
  // update request explicitly supplies is_strategy; otherwise it is preserved.
  const effectiveParentId = parent_id !== undefined ? parent_id : existing.parent_id
  const effectiveIsStrategy = is_strategy !== undefined ? !!is_strategy : !!existing.is_strategy

  // Strategy association (obj 2386). When the caller supplies strategy_id we
  // resolve it (explicit valid Strategy wins; otherwise parent-chain inherit;
  // otherwise null). null explicitly detaches. Omitted => keep existing.
  const effectiveStrategyId = strategy_id !== undefined
    ? resolveStrategyId(db, strategy_id, effectiveParentId ?? null)
    : (existing.strategy_id ?? null)

  // project_id validation (obj 708808): validate workspace match when supplied.
  const finalWorkspace = workspace ?? existing.workspace
  let effectiveUpdateProjectId: number | null | undefined = undefined // undefined = keep existing
  if (project_id !== undefined) {
    if (project_id === null) {
      effectiveUpdateProjectId = null // explicit detach
    } else {
      const prow = db.prepare('SELECT workspace FROM projects WHERE id = ?').get(project_id) as { workspace: string } | undefined
      if (!prow) {
        res.status(400).json({ error: `project_id ${project_id} does not exist` })
        return
      }
      if (prow.workspace !== finalWorkspace) {
        res.status(400).json({ error: `project_id ${project_id} belongs to workspace '${prow.workspace}', not '${finalWorkspace}'` })
        return
      }
      effectiveUpdateProjectId = project_id
    }
  }

  db.prepare(
    `UPDATE objectives SET
       title = COALESCE(?, title),
       description = COALESCE(?, description),
       agent_context = COALESCE(?, agent_context),
       workspace = COALESCE(?, workspace),
       project = ?,
       project_id = ?,
       category = COALESCE(?, category),
       parent_id = ?,
       assigned_user_id = ?,
       create_pr = ?,
       delegate_mode = ?,
       is_strategy = ?,
       completion_goal = ?,
       workflow_hint = ?,
       effort = COALESCE(?, effort),
       model = COALESCE(?, model),
       type = COALESCE(?, type),
       skip_ai_review = ?,
       test_cred_slug = ?,
       strategy_id = ?,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    title ?? null,
    description ?? null,
    agent_context ?? null,
    workspace ?? null,
    project !== undefined ? project : existing.project,
    effectiveUpdateProjectId !== undefined ? effectiveUpdateProjectId : (existing as unknown as Record<string, unknown>).project_id ?? null,
    category ?? null,
    parent_id !== undefined ? parent_id : existing.parent_id,
    newPrimary,
    create_pr !== undefined ? (create_pr ? 1 : 0) : (existing.create_pr ? 1 : 0),
    delegate_mode !== undefined ? (delegate_mode ? 1 : 0) : (existing.delegate_mode ? 1 : 0),
    effectiveIsStrategy ? 1 : 0,
    completion_goal !== undefined ? (completion_goal || null) : existing.completion_goal,
    workflow_hint !== undefined ? (workflow_hint || null) : existing.workflow_hint,
    effort ?? null,
    model ?? null,
    type ?? null,
    skip_ai_review !== undefined ? (skip_ai_review ? 1 : 0) : (existing.skip_ai_review ? 1 : 0),
    test_cred_slug !== undefined ? (test_cred_slug || null) : existing.test_cred_slug,
    effectiveStrategyId,
    req.params.id
  )

  // REPARENT (obj 707003) — the one operation that invalidates depths it does
  // not itself write. Moving a node shifts its ENTIRE subtree, so recompute from
  // the moved node down rather than just fixing the node. Only runs when the
  // caller actually changed parent_id, so an ordinary field edit is unaffected.
  if (parent_id !== undefined && (parent_id ?? null) !== (existing.parent_id ?? null)) {
    recomputeSubtreeDepth(db, Number(req.params.id))
  }

  if (requestedAssignees !== null) {
    setAssignees(Number(req.params.id), requestedAssignees)
  }

  const updated = mapObjective(
    db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
  )

  broadcast({ type: 'objective_updated', payload: updated })
  res.json(updated)
})

router.delete('/:id', async (req: AuthRequest, res) => {
  const db = getDb()

  const existing = db
    .prepare('SELECT * FROM objectives WHERE id = ?')
    .get(req.params.id) as Objective | undefined

  if (!existing) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }

  const ownershipError = requireOwnership(req, existing)
  if (ownershipError) {
    res.status(403).json({ error: ownershipError })
    return
  }

  // Kill session if active
  if (existing.session_id) {
    await stopSession(existing.session_id).catch(() => {})
  }

  // Soft-delete (obj 700415). Default OFF = hard delete preserved (but now
  // audited). When settings.soft_delete_enabled is on, set the tombstone instead
  // of removing the row; either way append exactly one audit row FIRST so a
  // delete always leaves a trace (deliverable B §3 — deletes were unlogged).
  if (isSoftDeleteEnabled(db)) {
    logObjectiveAudit(db, {
      objectiveId: existing.id,
      eventType: 'delete_soft',
      fromStatus: existing.status,
      toStatus: existing.status,
      actor: 'user',
      pathway: 'delete-endpoint-soft',
      sessionId: existing.session_id,
      titleSnapshot: existing.title,
      workspace: existing.workspace,
    })
    db.prepare("UPDATE objectives SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id)
  } else {
    logObjectiveAudit(db, {
      objectiveId: existing.id,
      eventType: 'delete_hard',
      fromStatus: existing.status,
      toStatus: null,
      actor: 'user',
      pathway: 'delete-endpoint-hard',
      sessionId: existing.session_id,
      titleSnapshot: existing.title,
      workspace: existing.workspace,
    })
    db.prepare('DELETE FROM objectives WHERE id = ?').run(req.params.id)
  }

  broadcast({ type: 'objective_deleted', payload: { id: existing.id, workspace: existing.workspace } })
  res.json({ ok: true })
})

}
