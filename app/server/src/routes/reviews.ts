/**
 * AI Review iteration history + acceptance-criteria lock endpoints.
 *
 * Split into two routers:
 * - `reviewsRouter` — workspace-scoped auth (`/api/objectives/:id/reviews`).
 *   Lists `objective_reviews` rows for the SessionViewer "AI Review" tab.
 * - `internalReviewsRouter` — localhost-only, no auth. Mounted under
 *   `/api/internal/reviews/:id/criteria`. Used by the reviewer subagent to:
 *     • POST iteration-1 acceptance criteria (locked into
 *       `objectives.acceptance_criteria`).
 *     • GET the locked rubric on iterations 2-3.
 *
 * The internal-only POST is idempotent: if `acceptance_criteria` is already
 * set we return 409 with the existing payload rather than overwriting — this
 * is the lock that lets us trust the rubric across iterations.
 */
import { Router } from 'express'
import type { Request } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { userHasWorkspace } from '../middleware/workspace.js'
import { rubricForChangedFiles, isBackendOnlyChange } from '../services/design-context.js'
import {
  resolveFilesTouched,
  realGhExec,
  type FilesTouchedObjective,
} from '../services/files-touched.js'
import { listObjectivePRs } from '../services/objective-prs.js'
import { getIntelForObjective } from '../services/session-intel-pipeline.js'
import type {
  AcceptanceCriterion,
  AcceptanceCriterionResult,
  AIReviewMode,
  AIReviewVerdict,
  ObjectiveReview,
} from '@command-center/shared'
import { isLocalhost } from '../lib/is-localhost.js'

interface ObjectiveReviewRow {
  id: number
  objective_id: number
  iteration: number
  reviewer_session_id: string
  mode: AIReviewMode
  verdict: AIReviewVerdict
  criteria_results: string
  screenshot_paths: string
  feature_brief: string
  markdown_body: string
  cost_usd: number
  duration_ms: number
  created_at: string
}

function mapReview(r: ObjectiveReviewRow): ObjectiveReview {
  let criteria_results: AcceptanceCriterionResult[] = []
  let screenshot_paths: string[] = []
  try { criteria_results = JSON.parse(r.criteria_results || '[]') } catch {}
  try { screenshot_paths = JSON.parse(r.screenshot_paths || '[]') } catch {}
  return {
    id: r.id,
    objective_id: r.objective_id,
    iteration: r.iteration,
    reviewer_session_id: r.reviewer_session_id,
    mode: r.mode,
    verdict: r.verdict,
    criteria_results,
    screenshot_paths,
    feature_brief: r.feature_brief ?? '',
    markdown_body: r.markdown_body,
    cost_usd: r.cost_usd,
    duration_ms: r.duration_ms,
    created_at: r.created_at,
  }
}

// ─── Workspace-scoped (authenticated) routes ────────────────────────────────

export const reviewsRouter = Router()
reviewsRouter.use(requireAuth)

// GET /api/objectives/:id/reviews — list all iteration rows for an objective.
// Members must have access to the objective's workspace; admins always pass.
reviewsRouter.get('/:id/reviews', (req: AuthRequest, res) => {
  const db = getDb()
  const obj = db
    .prepare('SELECT id, workspace FROM objectives WHERE id = ?')
    .get(req.params.id) as { id: number; workspace: string } | undefined
  if (!obj) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const user = req.user!
  if (user.role !== 'admin' && !userHasWorkspace(user.id, obj.workspace)) {
    res.status(403).json({ error: `No access to workspace '${obj.workspace}'` })
    return
  }

  const rows = db
    .prepare(
      'SELECT * FROM objective_reviews WHERE objective_id = ? ORDER BY iteration ASC'
    )
    .all(obj.id) as ObjectiveReviewRow[]
  res.json(rows.map(mapReview))
})

// GET /api/objectives/:id/prs — full per-objective PR log (obj 2300), newest-first.
// Same workspace-scoped access check as /reviews. Feeds the "Pull Requests" section
// in the SessionViewer detail drawer.
reviewsRouter.get('/:id/prs', (req: AuthRequest, res) => {
  const db = getDb()
  const obj = db
    .prepare('SELECT id, workspace FROM objectives WHERE id = ?')
    .get(req.params.id) as { id: number; workspace: string } | undefined
  if (!obj) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const user = req.user!
  if (user.role !== 'admin' && !userHasWorkspace(user.id, obj.workspace)) {
    res.status(403).json({ error: `No access to workspace '${obj.workspace}'` })
    return
  }
  res.json(listObjectivePRs(obj.id))
})

// GET /api/objectives/:id/intel — per-session intelligence rows (newest-first).
// Backs the SessionViewer "skills / sub-agents invoked" surface (obj-2387).
// Same workspace-scoped access check as /reviews and /prs.
reviewsRouter.get('/:id/intel', (req: AuthRequest, res) => {
  const db = getDb()
  const obj = db
    .prepare('SELECT id, workspace FROM objectives WHERE id = ?')
    .get(req.params.id) as { id: number; workspace: string } | undefined
  if (!obj) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const user = req.user!
  if (user.role !== 'admin' && !userHasWorkspace(user.id, obj.workspace)) {
    res.status(403).json({ error: `No access to workspace '${obj.workspace}'` })
    return
  }
  res.json(getIntelForObjective(obj.id))
})

// ─── Localhost-only (no auth) routes ────────────────────────────────────────

export const internalReviewsRouter = Router()

// POST /api/internal/reviews/:id/criteria
// Body: { criteria: AcceptanceCriterion[] }
// Locks the rubric onto the objective. If already set, 409 + existing payload.
internalReviewsRouter.post('/:id/criteria', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const body = req.body as { criteria?: unknown }
  const criteria = body?.criteria
  if (!Array.isArray(criteria)) {
    res.status(400).json({ error: 'criteria must be an array' })
    return
  }
  // Light shape validation — every criterion needs id/criterion/type/method.
  for (const c of criteria as Array<Record<string, unknown>>) {
    if (
      !c ||
      typeof c.id !== 'string' ||
      typeof c.criterion !== 'string' ||
      !['functional', 'visual', 'data'].includes(String(c.type)) ||
      !['browser', 'api', 'doc', 'static'].includes(String(c.method))
    ) {
      res.status(400).json({
        error: 'each criterion needs {id, criterion, type:functional|visual|data, method:browser|api|doc|static}',
      })
      return
    }
  }

  const db = getDb()
  const row = db
    .prepare('SELECT id, acceptance_criteria FROM objectives WHERE id = ?')
    .get(req.params.id) as { id: number; acceptance_criteria: string | null } | undefined
  if (!row) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  if (row.acceptance_criteria) {
    // Already locked — return existing payload so the reviewer can proceed.
    let existing: AcceptanceCriterion[] = []
    try { existing = JSON.parse(row.acceptance_criteria) } catch {}
    res.status(409).json({ error: 'criteria already locked', criteria: existing })
    return
  }

  db.prepare(
    "UPDATE objectives SET acceptance_criteria = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(criteria), row.id)

  res.status(201).json({ ok: true, criteria })
})

// GET /api/internal/reviews/:id/criteria — return locked rubric (or null).
//
// Per-PR UI gate (obj 1453): when the worker's change touches NO client/UI file, the
// visual / ds-* criteria the auto-append baked in (keyed on project, not changed files)
// are unsatisfiable — there is no screen to render against — and the adversarial reviewer
// caps out at 3/3 with a permanent FAIL on e.g. ds-a11y-contrast. So we strip those
// criteria here (the one place the reviewer fetches its bar) and substitute a backend
// correctness bar if nothing functional remains. An EMPTY/unknown file list ⇒ no strip ⇒
// the full ds-* rubric still applies (no regression on genuine UI PRs).
//
// The file list comes from session_intel and falls back to the PR DIFF when intel is
// empty (obj 705254 → resolveFilesTouched). Intel alone was not enough: it is written by
// the async extraction pipeline after a session ends, so it is legitimately empty while a
// session is live, before extraction runs, and permanently if extraction failed — and
// every one of those cases failed OPEN into "grade the browser rubric anyway". That is how
// pure-backend workers got hard-failed on ds-a11y-contrast / qa-smoke for deliverables
// with no UI in them at all. The diff is ground truth and cannot be empty for a real PR.
internalReviewsRouter.get('/:id/criteria', async (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const db = getDb()
  const row = db
    .prepare(
      'SELECT id, acceptance_criteria, session_id, pr_url, pr_number, project FROM objectives WHERE id = ?',
    )
    .get(req.params.id) as
    | (FilesTouchedObjective & { acceptance_criteria: string | null })
    | undefined
  if (!row) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  if (!row.acceptance_criteria) {
    res.json({ criteria: null })
    return
  }
  let criteria: AcceptanceCriterion[] = []
  try { criteria = JSON.parse(row.acceptance_criteria) } catch {}

  const { files: filesTouched, source } = await resolveFilesTouched(db, row, { ghExec: realGhExec })

  const { criteria: effective, stripped } = rubricForChangedFiles(criteria, filesTouched)
  if (stripped) {
    console.log(
      `[reviews] obj ${req.params.id}: backend-only PR (${filesTouched.length} files via ` +
      `${source}, no UI) — stripped ${criteria.length - effective.length} visual/ds-* ` +
      `criteria from review rubric`,
    )
  }
  res.json({
    criteria: effective,
    backend_only: isBackendOnlyChange(filesTouched),
    files_touched_source: source,
  })
})
