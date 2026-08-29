/**
 * Goal-draft, strategy governance, interrupt, and stop — extracted from
 * objectives.ts (behavior frozen). Registered on the same /api/objectives router.
 */
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import {
  type Objective,
  type GoalDraftRequest,
  type GoalDraftResponse,
  type GoalQuestion,
} from '@command-center/shared'
import { stopSession, interruptSession, sendFollowUp } from '../services/session-manager.js'
import { releaseBranchLeasesForObjective } from '../services/branch-lease.js'
import { cancelDelegatorWake } from '../services/delegation.js'
import { broadcast } from '../ws/index.js'
import {
  isStrategyObjective,
  evaluateKillSwitch,
  listDecisions,
  getPendingDecision,
  getDecisionById,
  resolveDecision,
  computeStrategyRollup,
} from '../services/strategy-governance.js'
import {
  buildUsernameMap,
  mapObjective,
  requireOwnership,
} from './objectives-helpers.js'

export function registerObjectiveGoalDraftRoutes(router: Router): void {
// POST /api/objectives/goal/draft
// Lightweight pre-create drafter for the objective-creation modal. Turns a
// rough title (+ optional description) into a concise completion goal, or asks
// 2-5 clarifying multiple-choice questions first. Distinct from the
// /:id/planning/* flow — this runs BEFORE the objective exists. Registered
// before /:id routes so "goal" isn't captured as an :id param.
//
// LLM call mirrors callHaikuSummarizer (mentor-context.ts): direct fetch to
// the Anthropic Messages API with the same headers/parse/try-catch shape.
router.post('/goal/draft', async (req: AuthRequest, res) => {
  const { title, description, answers, skipQuestions } = (req.body || {}) as GoalDraftRequest

  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return res.status(502).json({ error: 'goal drafter unavailable' })
  }

  const hasAnswers = Array.isArray(answers) && answers.length > 0
  // Force a goal when the client has provided answers or explicitly skipped.
  const forceGoal = hasAnswers || skipQuestions === true

  const answersBlock = hasAnswers
    ? answers!
        .filter(a => a && a.question && a.answer)
        .map(a => `Q: ${a.question}\nA: ${a.answer}`)
        .join('\n\n')
    : ''

  const prompt = forceGoal
    ? `You are helping define a clear completion goal for a work objective.

Objective title: ${title.trim()}
${description ? `Description: ${description.trim()}\n` : ''}${answersBlock ? `\nClarifying answers:\n${answersBlock}\n` : ''}
Write ONE concise, specific, measurable completion goal (1-3 sentences) describing what "done" looks like for this objective. It should be concrete enough that someone could verify whether it was achieved.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"mode":"goal","goal":"<the goal text>"}`
    : `You are helping define a clear completion goal for a work objective.

Objective title: ${title.trim()}
${description ? `Description: ${description.trim()}\n` : ''}
If the title and description give you enough signal, write ONE concise, specific, measurable completion goal (1-3 sentences) describing what "done" looks like.

If important details are ambiguous, instead ask 2-5 multiple-choice clarifying questions (each with 2-4 short options) to pin down scope before writing the goal.

Respond with ONLY a JSON object, no prose, no markdown fences. Use EXACTLY one of these shapes:
{"mode":"goal","goal":"<the goal text>"}
{"mode":"questions","questions":[{"id":"q1","question":"<question>","options":["<opt>","<opt>"]}]}`

  let raw: string | null = null
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!apiRes.ok) {
      return res.status(502).json({ error: 'goal drafter request failed' })
    }
    const data = (await apiRes.json()) as { content?: Array<{ type: string; text?: string }> }
    raw = data.content?.find(b => b.type === 'text')?.text?.trim() || null
  } catch {
    return res.status(502).json({ error: 'goal drafter request failed' })
  }

  if (!raw) {
    return res.status(502).json({ error: 'goal drafter returned no output' })
  }

  // Extract the first JSON object (tolerate stray prose / code fences).
  let parsed: GoalDraftResponse | null = null
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    const json = start >= 0 && end > start ? raw.slice(start, end + 1) : raw
    parsed = JSON.parse(json) as GoalDraftResponse
  } catch {
    return res.status(502).json({ error: 'goal drafter returned unparseable output' })
  }

  // Validate the discriminated shape; questions only when NOT forced to a goal.
  if (parsed && parsed.mode === 'questions' && Array.isArray(parsed.questions) && parsed.questions.length > 0 && !forceGoal) {
    const questions: GoalQuestion[] = parsed.questions
      .filter(q => q && typeof q.question === 'string' && Array.isArray(q.options))
      .slice(0, 5)
      .map((q, i) => ({
        id: typeof q.id === 'string' && q.id ? q.id : `q${i + 1}`,
        question: q.question,
        options: q.options.filter(o => typeof o === 'string').slice(0, 4),
      }))
    if (questions.length > 0) {
      return res.json({ mode: 'questions', questions } satisfies GoalDraftResponse)
    }
  }

  if (parsed && parsed.mode === 'goal' && typeof parsed.goal === 'string' && parsed.goal.trim()) {
    return res.json({ mode: 'goal', goal: parsed.goal.trim() } satisfies GoalDraftResponse)
  }

  return res.status(502).json({ error: 'goal drafter returned an invalid response' })
})

}

export function registerObjectiveControlRoutes(router: Router): void {
// GET /api/objectives/:id/governance — Strategy governance surface (obj 2385).
// Returns the strategy's spawned children (projects), its decision history +
// the current pending Decision Request, and its context/budget usage vs the
// kill-switch ceilings. Read-only; drives the StrategyGovernance UI panel.
router.get('/:id/governance', (req: AuthRequest, res) => {
  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const ownershipError = requireOwnership(req, objective)
  if (ownershipError) {
    res.status(403).json({ error: ownershipError })
    return
  }
  if (!isStrategyObjective(objective)) {
    res.status(400).json({ error: 'Not a strategy (a strategy is a top-level delegator)' })
    return
  }
  const childUserMap = buildUsernameMap()
  const children = (db.prepare(
    "SELECT * FROM objectives WHERE parent_id = ? ORDER BY created_at ASC"
  ).all(objective.id) as Objective[]).map(o => mapObjective(o, childUserMap))
  // The shared rollup (obj 700132) is the single source for the at-a-glance
  // budget numbers + pendingDecisionId that the strategies INDEX also shows; the
  // detail surface layers its richer fields (totalTokens, killSwitchReasons, the
  // full pendingDecision object + decision history) on top of the same numbers.
  const rollup = computeStrategyRollup(db, objective)
  const killSwitch = evaluateKillSwitch(db, objective)
  res.json({
    strategy: mapObjective(objective),
    children,
    decisions: listDecisions(db, objective.id),
    pendingDecision: getPendingDecision(db, objective.id),
    rollup,
    budget: {
      spendUsd: rollup.budget.spendUsd,
      spendCeilingUsd: rollup.budget.spendCeilingUsd,
      projectCount: rollup.budget.projectCount,
      projectCeiling: rollup.budget.projectCeiling,
      totalTokens: objective.total_tokens,
      killSwitchTripped: rollup.budget.killSwitchTripped,
      killSwitchReasons: killSwitch.reasons,
    },
  })
})

// POST /api/objectives/:id/decisions/:reviewId/resolve — Operator confirms/denies a
// pending Stage-0 Decision Request (obj 2385). Records the verdict on the
// decision row, then resumes the strategy session with the structured
// `[decision …]` follow-up via the existing sendFollowUp path (which flips the
// objective back to `working`). This is the human end of the gate: the strategy
// cannot spawn its next step until this fires.
router.post('/:id/decisions/:reviewId/resolve', async (req: AuthRequest, res) => {
  const { choice, optionId, note } = req.body as { choice?: string; optionId?: string; note?: string }
  if (choice !== 'approve' && choice !== 'deny') {
    res.status(400).json({ error: "choice must be 'approve' or 'deny'" })
    return
  }
  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const ownershipError = requireOwnership(req, objective)
  if (ownershipError) {
    res.status(403).json({ error: ownershipError })
    return
  }
  const reviewId = Number(req.params.reviewId)
  const decision = getDecisionById(db, reviewId)
  if (!decision || decision.objective_id !== objective.id) {
    res.status(404).json({ error: 'Decision not found for this objective' })
    return
  }
  if (decision.verdict !== 'pending') {
    res.status(409).json({ error: `Decision already resolved (${decision.verdict})` })
    return
  }

  const resolved = resolveDecision(db, reviewId, {
    choice,
    option_id: optionId,
    note,
    resolved_by: req.user?.username || `user-${req.user?.id}`,
    resolved_at: new Date().toISOString(),
  })
  if (!resolved) {
    res.status(500).json({ error: 'Failed to resolve decision' })
    return
  }

  let existingSessionId = objective.session_id
  if (!existingSessionId) {
    const lastSession = db.prepare(
      'SELECT session_id FROM session_intel WHERE objective_id = ? ORDER BY ended_at DESC LIMIT 1'
    ).get(objective.id) as { session_id: string } | undefined
    existingSessionId = lastSession?.session_id || `cc-${objective.id}-${Date.now()}`
  }

  try {
    const newSessionId = sendFollowUp(existingSessionId, resolved.followUp, objective)
    db.prepare("UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?").run(newSessionId, objective.id)
    const updated = mapObjective(db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective)
    broadcast({ type: 'objective_updated', payload: updated })
    res.json({ decision: resolved.decision, objective: updated })
  } catch (err) {
    console.error(`[objectives] decision resolve → sendFollowUp failed for ${objective.id}:`, err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to resume strategy' })
  }
})

// POST /api/objectives/:id/interrupt — send Ctrl+C to interrupt current turn
router.post('/:id/interrupt', (req: AuthRequest, res) => {
  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const ownershipError = requireOwnership(req, objective)
  if (ownershipError) {
    res.status(403).json({ error: ownershipError })
    return
  }
  if (!objective.session_id) {
    res.status(400).json({ error: 'No active session to interrupt' })
    return
  }
  const ok = interruptSession(objective.session_id)
  res.json({ ok, session_id: objective.session_id })
})

// POST /api/objectives/:id/stop — hard-stop a running/stuck objective and park
// it in `review` for the human. Unlike /interrupt (which only sends Ctrl+C to a
// live turn and leaves the card in `working` forever — useless on a session that
// already died, e.g. on a usage-limit hit), this actually:
//   1. kills the tmux session (both the worker and any AI-review session),
//   2. cancels any pending delegator wake + relies on the `review` guard in
//      fireWake so `[child-complete]` pings can't resurrect it,
//   3. releases branch leases so a later re-open re-acquires cleanly,
//   4. moves the card working/ai_review → review and clears session_id, so the
//      state-poller stops re-handling the dead session.
router.post('/:id/stop', async (req: AuthRequest, res) => {
  const db = getDb()
  const objective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }
  const ownershipError = requireOwnership(req, objective)
  if (ownershipError) {
    res.status(403).json({ error: ownershipError })
    return
  }
  if (objective.status === 'done') {
    res.status(400).json({ error: 'Objective is already done' })
    return
  }

  // Kill the live session(s). Best-effort — a dead/limit-hit session has no tmux,
  // and that's fine: the point is to guarantee nothing is left running.
  if (objective.session_id) await stopSession(objective.session_id).catch(() => {})
  if (objective.ai_review_session_id) await stopSession(objective.ai_review_session_id).catch(() => {})

  // Stop the delegator re-spawn loop: cancel any armed wake; the `review` status
  // (set below) is the durable backstop against future [child-complete] wakes.
  if (objective.delegate_mode) cancelDelegatorWake(objective.id)

  // Release branch leases so a future re-open does a fresh acquire + spawn.
  try { releaseBranchLeasesForObjective(db, objective.id) } catch { /* non-fatal */ }

  db.prepare(
    "UPDATE objectives SET status = 'review', session_id = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(objective.id)

  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, 'milestone', 'stopped', ?)`
    ).run(
      objective.project || 'unknown',
      objective.workspace,
      objective.id,
      objective.session_id,
      'Objective stopped by user — session killed and parked in review.'
    )
  } catch { /* non-fatal */ }

  const updated = mapObjective(
    db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
  )
  broadcast({ type: 'objective_updated', payload: updated })
  res.json(updated)
})

}
