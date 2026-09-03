/**
 * Hermes localhost read + control endpoints — extracted from internal.ts
 * (behavior frozen). Localhost gate unchanged.
 */
import { Router } from 'express'
import { execSync } from 'child_process'
import { getDb } from '../db/index.js'
import { broadcast } from '../ws/index.js'
import { logActivity } from './feed.js'
import {
  isTransitionAllowed,
  MAX_CONCURRENT_SESSIONS,
  type Objective,
  type ObjectiveStatus,
} from '@operationkit/shared'
import {
  startSession,
  stopSession,
  sendFollowUp,
  getSessionOutput,
  reopenObjective,
  BranchLeaseConflictError,
  SessionLeaseConflictError,
} from '../services/session-manager.js'
import { recordReopenFalsePass } from '../services/false-pass.js'
import { logObjectiveAudit, checkHumanTerminalReactivation } from '../services/objective-audit.js'
import { releaseBranchLeasesForObjective } from '../services/branch-lease.js'
import { listObjectivePRs } from '../services/objective-prs.js'
import { enqueuePreviewTeardown, kickHostDrain } from '../services/preview-spool.js'
import { mustRouteToHumanReview } from '../lib/human-tracked.js'
import { cleanupOrphanedChildrenOnParentTerminal } from '../lib/cleanup-orphaned-children.js'
import { releaseSessionLeasesForObjective } from '../services/session-lease.js'
import { getOpenTasksBlock } from '../services/mentor-context.js'
import { runCompletionGate, applyGateHandback } from '../services/ci-green-gate.js'
import { insertAlert } from '../services/notifier.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import {
  parseFieldsMode,
  parseListFilters,
  buildWhere,
  resolvePageBounds,
  selectListFor,
  unknownListParams,
  SUPPORTED_LIST_PARAMS,
} from '../lib/objectives-projection.js'
import {
  listSiblings,
  objectiveExists,
  relationBetween,
  unknownSiblingParams,
  SUPPORTED_SIBLINGS_PARAMS,
  SIBLING_FIELDS,
} from '../lib/objective-relations.js'
import {
  isStrategyObjective,
  validateDecisionRequest,
  createDecisionRequest,
  getPendingDecision,
} from '../services/strategy-governance.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { isLockedStatus, runMachineStatusUpdate } from '../lib/status-lock.js'
import { diskAction, diskBlockReason, readHostDisk } from '../lib/host-disk.js'

export function registerInternalHermesRoutes(router: Router): void {
// ─── Hermes integration: localhost-only read + control endpoints ───────────

// GET /api/internal/objectives — list objectives (admin-equivalent, no JWT).
//
// Field-projected by default (obj 705914): the response omits the heavy prose
// columns (description, ai_review_findings, acceptance_criteria,
// last_session_summary, completion_goal, approved_plan, job_review_note) which
// were ~97% of a 44 MB / 10.6s full-table response. Every ROW is still
// returned, so no caller silently loses a card. Measured on the live board:
// 43.1 MB → 8.7 MB by default, → 2.6 MB with ?fields=minimal.
//
//   ?fields=minimal       — identity/lifecycle columns only; what health probes
//                           and second-brain's active.md render actually read.
//   ?fields=full          — include the prose columns; always bounded to one
//                           page (default+max 200 rows) so the 44 MB response
//                           cannot be re-created by accident.
//   ?workspace= ?status=  — unchanged column filters.
//   ?since=<ISO>          — updated_at >= since.
//   ?parent_id=<id>       — DIRECT children of <id> (obj 707003); `null` = top tier.
//   ?ancestor_id=<id>     — the whole subtree below <id> (strict descendants).
//   ?include_terminal=0   — drop done/cancelled (the ever-growing tail).
//   ?limit= &offset=      — explicit paging (obj 700512).
//
// Any OTHER param is a 400 (obj 707003). Unknown params used to be ignored, which
// made an unsupported filter look like an answered query over the whole board.
//
// Response headers describe what was withheld without changing the JSON shape
// (a bare array — every existing caller depends on that):
//   X-Total-Count / X-Returned-Count / X-Fields-Mode / X-Truncated
router.get('/objectives', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  // STRICT param contract (obj 707003). An unrecognized param used to be
  // silently dropped, so `?parent_id=706936` answered with all 8,362 rows and
  // HTTP 200 — a full-board false positive indistinguishable from a real answer.
  // Reject instead: a caller that mistypes a filter now learns it immediately.
  const unknown = unknownListParams(req.query as Record<string, unknown>)
  if (unknown.length > 0) {
    res.status(400).json({
      error: `Unsupported query parameter(s): ${unknown.join(', ')}`,
      unknown_params: unknown,
      supported_params: [...SUPPORTED_LIST_PARAMS],
    })
    return
  }
  const db = getDb()
  const mode = parseFieldsMode(req.query.fields)
  const filters = parseListFilters(req.query as Record<string, unknown>)
  const { where, params } = buildWhere(filters)
  const { limit, offset } = resolvePageBounds(req.query.limit, req.query.offset, mode)

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM objectives${where}`).get(...params) as { n: number }).n

  let sql = `SELECT ${selectListFor(db, mode)} FROM objectives${where} ORDER BY updated_at DESC`
  if (limit !== null) sql += ` LIMIT ${limit} OFFSET ${offset}`

  const rows = db.prepare(sql).all(...params)
  res.set({
    'X-Total-Count': String(total),
    'X-Returned-Count': String(rows.length),
    'X-Fields-Mode': mode,
    'X-Truncated': String(rows.length < total),
  })
  res.json(rows)
})

// GET /api/internal/strategies — list all Strategies (the canonical top tier).
// Proves the stored marker (obj 2383): one column predicate, no depth/delegate_mode
// derivation. Optional ?workspace= filter. See docs/terminology-glossary.md.
router.get('/strategies', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const db = getDb()
  const workspace = req.query.workspace as string | undefined
  const rows = workspace
    ? db.prepare('SELECT * FROM objectives WHERE is_strategy = 1 AND workspace = ? ORDER BY updated_at DESC').all(workspace)
    : db.prepare('SELECT * FROM objectives WHERE is_strategy = 1 ORDER BY updated_at DESC').all()
  res.json(rows)
})

// GET /api/internal/strategies/:id/objectives — every objective a given
// Strategy invoked/owns (obj 2386). Proves explicit provenance: a SINGLE
// indexed column predicate (strategy_id = ?) returns the full set, regardless
// of how deep in the tree each objective sits or whether it was manually linked
// (parent_id IS NULL). Optional ?origin= filter narrows to one provenance kind.
router.get('/strategies/:id/objectives', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const db = getDb()
  const origin = req.query.origin as string | undefined
  const rows = origin
    ? db.prepare('SELECT * FROM objectives WHERE strategy_id = ? AND origin = ? ORDER BY created_at DESC').all(req.params.id, origin)
    : db.prepare('SELECT * FROM objectives WHERE strategy_id = ? ORDER BY created_at DESC').all(req.params.id)
  res.json(rows)
})

// GET /api/internal/objectives/:id — single objective detail
router.get('/objectives/:id', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  // Embed the associated Strategy (obj 2386) so the objective detail can SHOW
  // its strategy inline — including for a manual objective with no parent.
  const strategy = objective.strategy_id != null
    ? db.prepare('SELECT id, title, agent_context, workspace FROM objectives WHERE id = ? AND is_strategy = 1').get(objective.strategy_id)
    : null
  // Embed the full PR log (obj 2300) so a curl against the detail shows every PR.
  res.json({ ...objective, prs: listObjectivePRs(objective.id), strategy })
})

// GET /api/internal/objectives/:id/siblings — the sanctioned sibling read edge
// (obj 707038, P1-3). Direct siblings only (same parent_id, self excluded), and
// only their FINAL-value fields: id, title, status, ai_review_verdict,
// last_session_summary, updated_at. See lib/objective-relations.ts for why the
// column set is an allowlist and why an orphan gets [] rather than the top tier.
//
// This is the narrow alternative to what a peer-curious session had to do
// before: `GET /objectives/<sib>/output` (the raw session log) or `?fields=full`
// over the board, both of which hand back mid-flight scratch.
router.get('/objectives/:id/siblings', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  // Same strict-param contract as the list endpoint (obj 707003): an unsupported
  // param is a 400, never a silently-unfiltered 200.
  const unknown = unknownSiblingParams(req.query as Record<string, unknown>)
  if (unknown.length > 0) {
    res.status(400).json({
      error: `Unsupported query parameter(s): ${unknown.join(', ')}`,
      unknown_params: unknown,
      supported_params: [...SUPPORTED_SIBLINGS_PARAMS],
    })
    return
  }
  const db = getDb()
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0 || !objectiveExists(db, id)) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const raw = String(req.query.include_terminal ?? '').toLowerCase()
  const includeTerminal = !(raw === '0' || raw === 'false' || raw === 'no')
  const siblings = listSiblings(db, id, includeTerminal)
  res.set({ 'X-Returned-Count': String(siblings.length), 'X-Fields-Mode': 'final' })
  res.json({ objective_id: id, fields: [...SIBLING_FIELDS], siblings })
})

// GET /api/internal/objectives/:id/output — session conversation history (no JWT)
router.get('/objectives/:id/output', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }

  const sessionIds = new Set<string>()
  if (objective.session_id) sessionIds.add(objective.session_id)
  const priorSessions = db.prepare(
    'SELECT session_id FROM session_intel WHERE objective_id = ? ORDER BY started_at ASC'
  ).all(objective.id) as { session_id: string }[]
  for (const s of priorSessions) sessionIds.add(s.session_id)

  if (sessionIds.size === 0) {
    res.json({ messages: [], total: 0, status: objective.status })
    return
  }

  let targetId: string
  if (sessionIds.size === 1) {
    targetId = sessionIds.values().next().value!
  } else {
    targetId = objective.session_id || priorSessions[priorSessions.length - 1]?.session_id || ''
  }
  if (!targetId) {
    res.json({ messages: [], total: 0, status: objective.status })
    return
  }

  const messages = getSessionOutput(targetId)
  // Return last N messages for brevity (full history can be huge)
  const limit = parseInt(req.query.limit as string, 10) || 50
  const tail = messages.length > limit ? messages.slice(-limit) : messages
  res.json({ messages: tail, total: messages.length, status: objective.status, session_id: targetId })
})

// GET /api/internal/briefing — daily briefing (admin-equivalent, no JWT)
router.get('/briefing', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const db = getDb()

  type Row = { id: number; title: string; status: string; workspace: string; updated_at: string; has_blockers: number }
  // Status set reflects shared types: queue|working|review|done. The `blocked`
  // facet is derived from has_blockers (column), not a status value.
  const rows = db.prepare(`
    SELECT id, title, status, workspace, updated_at, has_blockers
    FROM objectives
    WHERE status IN ('working', 'review')
    ORDER BY updated_at DESC
  `).all() as Row[]

  const inProgress = rows.filter(r => r.status === 'working' && !r.has_blockers)
  const blocked = rows.filter(r => r.status === 'working' && !!r.has_blockers)
  const needsReview = rows.filter(r => r.status === 'review')
  const openLoops = getOpenTasksBlock({ allowedWorkspaces: null })

  res.json({
    asOf: new Date().toISOString(),
    board: { inProgress, blocked, needsReview },
    openLoops,
  })
})

// PATCH /api/internal/objectives/:id/status — status transitions (no JWT)
router.patch('/objectives/:id/status', async (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const { status } = req.body as { status: string }
  const db = getDb()

  const existing = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!existing) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }

  if (status === 'working' && existing.status === 'working') {
    res.json(existing)
    return
  }

  if (!isTransitionAllowed(existing.type, existing.status as ObjectiveStatus, status as ObjectiveStatus)) {
    res.status(400).json({ error: `Cannot transition '${existing.type}' objective from '${existing.status}' to '${status}'` })
    return
  }

  if (status === 'working') {
    // Count only states that hold a RUNNING session ('working' + 'ai_review');
    // exclude 'review' (parked awaiting a human, no session) so a review backlog
    // can't saturate the cap and block the queue from draining.
    const activeCount = db.prepare("SELECT COUNT(*) as count FROM objectives WHERE status IN ('working', 'ai_review')").get() as { count: number }
    if (activeCount.count >= MAX_CONCURRENT_SESSIONS) {
      res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_SESSIONS} concurrent sessions reached` })
      return
    }
  }

  try {
    const startsFromReviewLike =
      existing.status === 'queue' ||
      existing.status === 'review' ||
      existing.status === 'ai_review'
    if (status === 'working' && isLockedStatus(existing.status)) {
      res.json({ status: existing.status, skipped: true, reason: 'locked_status' })
      return
    }
    if (status === 'working' && existing.status === 'done') {
      // Re-Open: resume the most recent thread in place instead of starting over.
      // ST2: pass-gated reopen ⇒ false pass; record it before the state changes.
      recordReopenFalsePass(existing)
      const sessionId = await reopenObjective(existing)
      db.prepare("UPDATE objectives SET status = ?, session_id = ?, updated_at = datetime('now') WHERE id = ?").run(status, sessionId, req.params.id)
    } else if (status === 'working' && startsFromReviewLike) {
      // Human-terminal guard (obj 700415, FIX B). This localhost-only, unauthed
      // endpoint is the PRIMARY machine revive of a parked objective (deliverable
      // A pathway #4) AND the target of the queue-drain callback (index.ts, #5).
      // Under CC_HUMAN_TERMINAL_GUARD (default OFF → dry-run) a machine start of a
      // human-terminated objective logs "WOULD block" and proceeds; when enforced
      // it is skipped (status unchanged, HTTP 200 so an automated caller doesn't
      // error-loop). Account-limit auto-resume is untouched: it acts on already-
      // working sessions, never a parked→working start (see PARKED_STATUSES).
      const guarded = checkHumanTerminalReactivation(db, existing, 'internal-patch-start')
      if (guarded.blocked) {
        res.json({ status: existing.status, skipped: true, reason: 'terminal_by_human' })
        return
      }
      if (existing.status !== 'queue' && existing.session_id) {
        db.prepare("UPDATE session_intel SET outcome = 'failed' WHERE session_id = ? AND outcome IS NULL").run(existing.session_id)
      }
      const sessionId = await startSession(existing)
      db.prepare("UPDATE objectives SET status = ?, session_id = ?, updated_at = datetime('now') WHERE id = ?").run(status, sessionId, req.params.id)
    } else if (status === 'done') {
      // GUARD (single chokepoint): this endpoint is unauthenticated (localhost-only)
      // and ANY agent session can call it. A human-tracked objective (top-level,
      // non-routine) must never be auto-completed here — redirect to `review` so an
      // admin signs it off. The authenticated human UI path (routes/objectives.ts)
      // is unaffected. Worker children (parent_id) and routine-spawned objectives
      // (routine_id) keep existing behavior so delegators can still accept children.
      // We redirect (HTTP 200) rather than 4xx-refuse so automated callers don't
      // error-loop. See 2026-06-21-stop-auto-done-human-tracked-objectives.md.
      if (mustRouteToHumanReview(existing)) {
        console.warn(
          `[internal] Redirected auto-done → review for human-tracked objective ${existing.id} ` +
          `("${existing.title}"). caller=${req.ip || 'unknown'} ua="${req.get('user-agent') || 'unknown'}"`
        )
        db.prepare("UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?").run(req.params.id)
        logObjectiveAudit(db, {
          objectiveId: Number(req.params.id),
          eventType: 'status_change',
          fromStatus: existing.status,
          toStatus: 'review',
          actor: 'machine',
          pathway: 'internal-patch-auto-done-redirect',
          sessionId: existing.session_id,
          titleSnapshot: existing.title,
          workspace: existing.workspace,
        })
        const redirected = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
        broadcast({ type: 'objective_updated', payload: redirected })
        // Orphan-child cleanup (obj 700595, FIX 1a): this parent just landed in
        // `review` (a terminal-for-children state) — retire its stranded queue kids.
        try {
          cleanupOrphanedChildrenOnParentTerminal(db, Number(req.params.id), broadcast, 'review')
        } catch (err) {
          console.error('[internal] orphan-child cleanup failed:', (err as Error).message)
        }
        res.json({ status: 'review', redirected: true, reason: 'human-tracked objective requires admin sign-off' })
        return
      }
      // ── CI-green gate (obj 704785) ──────────────────────────────────────────
      // This is the machine self-claim path — any agent session can call it, so it is
      // exactly where a worker used to close itself on top of a red PR. Same gate,
      // same semantics as the authenticated UI path: failing REQUIRED check → 409 +
      // handback with the check names; absent/queued required check → bounded wait
      // then complete with a durable record; advisory red → never blocks.
      {
        const gate = await runCompletionGate(db, existing, { pathway: 'internal-patch-done', alert: insertAlert })
        if (gate.blocked) {
          const landed = applyGateHandback(db, existing, gate, { sendFollowUp, broadcast })
          res.status(409).json({
            error: gate.decision.action === 'escalate'
              ? 'PR required checks still failing after the hold cap — escalated to Mike'
              : 'PR required checks not green — completion blocked',
            ciGate: {
              action: gate.decision.action,
              failingRequired: gate.decision.failingRequired,
              missingRequired: gate.decision.missingRequired,
              advisoryRed: gate.decision.advisoryRed,
              requiredSource: gate.decision.requiredSource,
              reason: gate.decision.reason,
              landedStatus: landed,
              findings: gate.handback,
            },
          })
          return
        }
      }

      if (existing.session_id) {
        db.prepare("UPDATE session_intel SET outcome = 'success' WHERE session_id = ? AND outcome IS NULL").run(existing.session_id)
        await stopSession(existing.session_id)
      }
      db.prepare("UPDATE objectives SET status = ?, session_id = NULL, updated_at = datetime('now') WHERE id = ?").run(status, req.params.id)

      // Release branch lease on done (obj 994) + non-PR identity lease (obj 1075).
      releaseBranchLeasesForObjective(db, Number(req.params.id))
      releaseSessionLeasesForObjective(db, Number(req.params.id))

      // Tear down the PR preview on done (obj 1452). The GitHub close/merge
      // webhook is the canonical teardown trigger, but it requires the repo
      // webhook to be configured; enqueuing here too guarantees teardown even
      // when it isn't. Idempotent + no-op against a missing preview.
      if (existing.pr_number) {
        if (enqueuePreviewTeardown(existing.pr_number, existing.id)) kickHostDrain()
      }

      if (existing.branch_name) {
        const worktreePath = `/tmp/cc-worktree-${existing.id}`
        try {
          execSync(`rm -rf ${worktreePath} 2>/dev/null || true`, { timeout: 5000 })
          execSync(`find /home/operator/projects -maxdepth 2 -name .git -type d -exec git --git-dir={} worktree prune 2>/dev/null \\;`, { timeout: 10000 })
          if (existing.project) {
            execSync(`git -C /home/operator/projects/${existing.project} branch -D ${existing.branch_name} 2>/dev/null || true`, { timeout: 5000 })
          }
        } catch {}
      }
    } else {
      db.prepare("UPDATE objectives SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.params.id)
    }
  } catch (err) {
    // Branch-lease conflict (obj 994): refuse the duplicate; status untouched.
    if (err instanceof BranchLeaseConflictError) {
      res.status(409).json({ error: err.message, branch_name: err.branchName, owner_objective_id: err.ownerObjectiveId })
      return
    }
    // Identity-lease conflict (obj 1075): refuse the duplicate non-PR card; untouched.
    if (err instanceof SessionLeaseConflictError) {
      res.status(409).json({ error: err.message, lease_key: err.leaseKey, owner_objective_id: err.ownerObjectiveId })
      return
    }
    const message = err instanceof Error ? err.message : 'Session operation failed'
    res.status(500).json({ error: message })
    return
  }

  const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
  // Audit the status transition (obj 700415). `updated.status` is the actual
  // landed status (may differ from the requested `status` when the auto-done →
  // review redirect fired above).
  logObjectiveAudit(db, {
    objectiveId: Number(req.params.id),
    eventType: 'status_change',
    fromStatus: existing.status,
    toStatus: updated.status,
    actor: 'machine',
    pathway: 'internal-patch-status',
    sessionId: updated.session_id,
    titleSnapshot: updated.title,
    workspace: updated.workspace,
  })
  broadcast({ type: 'objective_updated', payload: updated })

  // Orphan-child cleanup on parent-terminal (obj 700595, FIX 1a). Mirror of the
  // authenticated path in routes/objectives.ts — keyed on the LANDED status so a
  // done/review/cancelled parent retires its stranded queue children. Best-effort.
  if (updated.status === 'done' || updated.status === 'review' || updated.status === 'cancelled') {
    try {
      cleanupOrphanedChildrenOnParentTerminal(db, Number(req.params.id), broadcast, updated.status)
    } catch (err) {
      console.error('[internal] orphan-child cleanup failed:', (err as Error).message)
    }
  }

  res.json(updated)
})

// POST /api/internal/objectives/:id/message — send follow-up message (no JWT)
router.post('/objectives/:id/message', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const { message, from_objective_id } = req.body as { message: string; from_objective_id?: number | string }
  if (!message?.trim()) {
    res.status(400).json({ error: 'Message is required' })
    return
  }

  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }

  // ── Relationship check (obj 707038, P1-3) ────────────────────────────────
  // prompt-builder.ts asks in PROSE that a session only message its own children.
  // Nothing enforced it: this route is localhost-only and unauthed, so any
  // session could deliver a message into any objective's session.
  //
  // CALLER IDENTITY — the honest version. There is no caller identity on this
  // route and none can be derived: `isLocalhost` is the only gate, every session
  // shares the loopback interface, and no existing internal route carries a
  // session/objective header we could reuse (verified: no CC_OBJECTIVE_ID in the
  // spawn env, no X-Objective-Id anywhere in the server). So identity is an
  // EXPLICIT, SELF-DECLARED body param, `from_objective_id`. That makes this
  // check ADVISORY-BUT-RECORDED, not cryptographic: a caller that lies about its
  // id defeats it. What it does buy is (a) an unrelated pair is rejected on the
  // honest path, (b) every cross-edge message is attributed in the activity log,
  // so the graph of who-messages-whom becomes observable instead of invisible.
  // Real enforcement needs a per-session token minted at spawn — a follow-up.
  //
  // BACK-COMPAT is deliberate and load-bearing: the param is OPTIONAL. Every
  // existing caller — the delegator's `[child-complete]` wake, the CI feedback
  // bridge, strategy-governance, Mike's own curl — omits it and is unaffected.
  // Omission is logged as `unattributed`, and the settings key
  // `message_require_from_objective='1'` flips omission to a 400 once callers
  // have been migrated. Enforcing on day one would have broken the delegator.
  let callerRelation: string = 'unattributed'
  if (from_objective_id !== undefined && from_objective_id !== null && from_objective_id !== '') {
    const fromId = Number(from_objective_id)
    if (!Number.isInteger(fromId) || fromId <= 0) {
      res.status(400).json({ error: 'from_objective_id must be a positive integer objective id' })
      return
    }
    if (!objectiveExists(db, fromId)) {
      res.status(404).json({ error: `from_objective_id ${fromId} is not an objective` })
      return
    }
    const relation = relationBetween(db, fromId, objective.id)
    if (relation === null) {
      res.status(403).json({
        error: `Objective ${fromId} has no parent/child/sibling relationship to ${objective.id} — messaging is limited to one graph hop.`,
        from_objective_id: fromId,
        to_objective_id: objective.id,
        allowed_relations: ['self', 'parent', 'child', 'sibling'],
      })
      return
    }
    callerRelation = relation
  } else if (
    (db.prepare("SELECT value FROM settings WHERE key = 'message_require_from_objective'").get() as { value?: string } | undefined)?.value === '1'
  ) {
    res.status(400).json({
      error: 'from_objective_id is required (message_require_from_objective=1)',
      to_objective_id: objective.id,
    })
    return
  }
  // Attribution is the durable half of an advisory check: even the unattributed
  // path is now visible, so "who messages whom" is auditable rather than dark.
  try {
    logActivity({
      project: objective.project || 'command-center-infra',
      workspace: objective.workspace,
      objective_id: objective.id,
      // `progress` is the generic bucket in activity_log's event_type CHECK
      // constraint; the relation lives in title/detail/metadata.
      event_type: 'progress',
      title: `internal message → #${objective.id} (relation ${callerRelation})`,
      detail: `from_objective_id=${from_objective_id ?? 'none'} relation=${callerRelation}`,
      metadata: { from_objective_id: from_objective_id ?? null, relation: callerRelation },
    })
  } catch (err) {
    // Telemetry must never break the delegator→child wake path.
    console.error('[internal] message attribution log failed:', err)
  }

  let existingSessionId = objective.session_id
  if (!existingSessionId) {
    const lastSession = db.prepare(
      'SELECT session_id FROM session_intel WHERE objective_id = ? ORDER BY ended_at DESC LIMIT 1'
    ).get(objective.id) as { session_id: string } | undefined
    existingSessionId = lastSession?.session_id || `cc-${objective.id}-${Date.now()}`
  }

  // Wrapped so a throw in the spawn path returns a clean 500 to the caller
  // (delegator nudge / [child-complete] wake) instead of an opaque failure —
  // obj 1180: buildPrompt threw here on raw-string acceptance_criteria.
  // Human-terminal guard (obj 700415, FIX B). The unauthed internal message
  // endpoint flips a parked objective to `working` with no status guard
  // (deliverable A pathway #8). Under CC_HUMAN_TERMINAL_GUARD (default OFF →
  // dry-run) a machine message to a human-terminated objective logs "WOULD block"
  // and proceeds; when enforced it is skipped BEFORE the (re)spawn.
  const priorStatus = objective.status
  if (isLockedStatus(priorStatus)) {
    res.json({ status: objective.status, skipped: true, reason: 'locked_status' })
    return
  }
  const disk = readHostDisk()
  if (disk && diskAction(disk) === 'block') {
    res.status(507).json({ error: diskBlockReason(disk), skipped: true, reason: 'disk_full' })
    return
  }
  const guarded = checkHumanTerminalReactivation(db, objective, 'internal-message-flip')
  if (guarded.blocked) {
    res.json({ status: objective.status, skipped: true, reason: 'terminal_by_human' })
    return
  }

  try {
    const newSessionId = sendFollowUp(existingSessionId, message, objective)
    runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
      newSessionId,
      Number(req.params.id),
    )

    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
    if (priorStatus !== 'working') {
      logObjectiveAudit(db, {
        objectiveId: Number(req.params.id),
        eventType: 'status_change',
        fromStatus: priorStatus,
        toStatus: 'working',
        actor: 'machine',
        pathway: 'internal-message-flip',
        sessionId: newSessionId,
        titleSnapshot: objective.title,
        workspace: objective.workspace,
      })
    }
    broadcast({ type: 'objective_updated', payload: updated })
    res.json(updated)
  } catch (err) {
    console.error(`[internal] message → sendFollowUp failed for ${req.params.id}:`, err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to send message' })
  }
})

// POST /api/internal/objectives/:id/decision — a STRATEGY node submits a
// Stage-0 Decision Request and parks for Mike's confirm/deny (obj 2385).
// localhost-only; called by the strategy session itself before it commits any
// strategic step (spawn-next / pivot / stop / re-scope). The request is stored
// as an objective_reviews row (mode='decision', verdict='pending') and the
// objective is parked in `review` — reusing the existing human gate. The
// existing fireWake guard then prevents any child-completion from stampeding
// past the pending decision until Mike resumes it via .../:id/message (which the
// UI's approve/deny calls through). Malformed requests are rejected here (the
// cheap deterministic pre-gate) so a strategy can never park on an empty ask.
router.post('/objectives/:id/decision', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  if (!requireInternalSecret(req, res)) return

  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  if (!isStrategyObjective(objective)) {
    res.status(400).json({ error: 'Decision requests are only valid for a strategy (a top-level delegator)' })
    return
  }

  const validated = validateDecisionRequest(req.body)
  if (!validated.ok) {
    res.status(400).json({ error: `Malformed Decision Request: ${validated.error}` })
    return
  }

  const reviewerSessionId = objective.session_id || `strategy-${objective.id}`
  const decision = createDecisionRequest(db, objective.id, validated.value, reviewerSessionId)

  db.prepare("UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?").run(objective.id)
  const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
  broadcast({ type: 'objective_updated', payload: updated })
  logActivity({
    project: objective.project || objective.workspace,
    workspace: objective.workspace,
    objective_id: objective.id,
    event_type: 'decision',
    title: `Strategy #${objective.id} awaiting decision: ${validated.value.kind}`,
    detail: validated.value.decision,
  })
  res.status(201).json({ decision, objective: updated })
})

// GET /api/internal/objectives/:id/decision — the strategy node reads its own
// pending decision back (e.g. after a wake) to confirm it is still parked.
router.get('/objectives/:id/decision', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  if (!requireInternalSecret(req, res)) return
  const db = getDb()
  const pending = getPendingDecision(db, Number(req.params.id))
  res.json({ pending })
})

// POST /api/internal/objectives/:id/job-disposition — a job (routine-spawned
// objective) records its end-of-run disposition. localhost-only; called by the
// job session itself. Orthogonal to status: disposition is the *outcome* the
// Jobs board lanes on (Needs Review vs Complete), not the worker lifecycle.
router.post('/objectives/:id/job-disposition', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const { disposition, note } = req.body as { disposition?: string; note?: string }
  if (disposition !== 'complete' && disposition !== 'needs_review') {
    res.status(400).json({ error: "disposition must be 'complete' or 'needs_review'" })
    return
  }

  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  if (objective.routine_id == null) {
    res.status(400).json({ error: 'Objective is not a job (no routine_id); disposition does not apply' })
    return
  }

  const reviewNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : null
  db.prepare(
    "UPDATE objectives SET job_disposition = ?, job_review_note = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(disposition, reviewNote, req.params.id)

  const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
  broadcast({ type: 'objective_updated', payload: updated })
  res.json(updated)
})

}
