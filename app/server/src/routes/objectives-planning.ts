/**
 * Planning-stage routes — extracted from objectives.ts (behavior frozen).
 * Registered on the same /api/objectives router. SQL and HTTP paths unchanged.
 */
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import type { Objective, PlanningMessage, SessionMessage } from '@operationkit/shared'
import { getSessionOutput, sendFollowUp, spawnPlannerSession, stopPlannerSession, startSession } from '../services/session-manager.js'
import { MAX_CONCURRENT_SESSIONS } from '@operationkit/shared'
import { broadcast } from '../ws/index.js'
import { mapObjective, requireOwnership } from './objectives-helpers.js'

// ── Planning Stage ───────────────────────────────────────────────────────────
// Project-type objectives start in `planning` status. The planner is a separate
// Claude Code sub-session in read-only mode that drafts an implementation plan
// via Q&A with the user. On approval the plan is stored on the objective and
// the status transitions to `working` and a worker session starts.

// Map a live SessionMessage into a planning_conversations role.
function sessionRoleToPlanningRole(type: SessionMessage['type']): 'user' | 'assistant' | 'system' {
  if (type === 'assistant' || type === 'result') return 'assistant'
  if (type === 'user' || type === 'followup') return 'user'
  return 'system'
}

// Mirror the planner session's JSONL transcript into planning_conversations so
// the full both-sides conversation persists in the DB after the live session
// is torn down. Idempotent via the (objective_id, session_id, seq) unique index.
function persistPlannerMessages(objectiveId: number, sessionId: string): void {
  const db = getDb()
  const messages = getSessionOutput(sessionId)
  if (messages.length === 0) return

  // Find the highest seq we've already persisted for this (objective, session)
  const lastRow = db
    .prepare(
      `SELECT MAX(seq) as max_seq FROM planning_conversations
       WHERE objective_id = ? AND session_id = ? AND seq IS NOT NULL`
    )
    .get(objectiveId, sessionId) as { max_seq: number | null } | undefined
  const startSeq = (lastRow?.max_seq ?? -1) + 1
  if (startSeq >= messages.length) return

  const insert = db.prepare(
    `INSERT OR IGNORE INTO planning_conversations
       (objective_id, session_id, role, content, metadata, seq, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  const tx = db.transaction(() => {
    for (let i = startSeq; i < messages.length; i++) {
      const m = messages[i]
      const text = m.text ?? (m.toolName ? `[${m.toolName}]` : '')
      if (!text.trim()) continue
      const role = sessionRoleToPlanningRole(m.type)
      const metadata = JSON.stringify({ type: m.type, ...(m.toolName ? { toolName: m.toolName } : {}) })
      insert.run(objectiveId, sessionId, role, text, metadata, i, m.timestamp || new Date().toISOString())
    }
  })
  try { tx() } catch (err) {
    console.log(`[planning] persist failed for objective ${objectiveId} session ${sessionId}: ${err instanceof Error ? err.message : err}`)
  }
}

// Read the saved DB-backed transcript for an objective and map it back into
// the SessionMessage shape the client renders. Used as a fallback when the
// live session JSONL is no longer available.
function readSavedTranscript(objectiveId: number): SessionMessage[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT role, content, metadata, created_at
       FROM planning_conversations
       WHERE objective_id = ?
       ORDER BY COALESCE(seq, -1) ASC, id ASC`
    )
    .all(objectiveId) as Array<{ role: string; content: string; metadata: string | null; created_at: string }>
  return rows.map(r => {
    let parsedType: SessionMessage['type'] | undefined
    try {
      if (r.metadata) parsedType = JSON.parse(r.metadata).type as SessionMessage['type']
    } catch {}
    const fallback: SessionMessage['type'] = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'followup' : 'system'
    return { type: parsedType || fallback, text: r.content, timestamp: r.created_at }
  })
}

// Extract a <plan>…</plan> block from the planner's most recent assistant text.
function extractApprovedPlan(sessionId: string): string | null {
  try {
    const messages = getSessionOutput(sessionId)
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.type !== 'assistant' || !m.text) continue
      const match = m.text.match(/<plan>([\s\S]*?)<\/plan>/i)
      if (match) return match[1].trim()
    }
  } catch {}
  return null
}

export function registerObjectivePlanningRoutes(router: Router): void {
// POST /api/objectives/:id/planning/start — boot the planner sub-session
router.post('/:id/planning/start', async (req: AuthRequest, res) => {
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
  if (objective.type !== 'project') {
    res.status(400).json({ error: 'Planning is only available for project-type objectives' })
    return
  }
  if (objective.status !== 'planning') {
    res.status(400).json({ error: `Objective is not in planning status (current: ${objective.status})` })
    return
  }

  try {
    const sessionId = await spawnPlannerSession(objective)
    db.prepare(
      "UPDATE objectives SET planning_session_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId, req.params.id)
    const updated = mapObjective(
      db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
    )
    broadcast({ type: 'objective_updated', payload: updated })
    res.json({ session_id: sessionId })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to start planner' })
  }
})

// GET /api/objectives/:id/planning/messages?after=N — poll planner output
router.get('/:id/planning/messages', (req: AuthRequest, res) => {
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
  const afterIndex = parseInt(req.query.after as string, 10)
  const incremental = !isNaN(afterIndex) && afterIndex >= 0

  // Prefer live session output (and mirror it to the DB transcript). When no
  // live session is available — e.g. after cancel cleared planning_session_id,
  // or the JSONL has been pruned — fall back to the saved transcript.
  let allMessages: SessionMessage[] = []
  if (objective.planning_session_id) {
    persistPlannerMessages(objective.id, objective.planning_session_id)
    allMessages = getSessionOutput(objective.planning_session_id)
  }
  if (allMessages.length === 0) {
    allMessages = readSavedTranscript(objective.id)
  }

  if (incremental) {
    const newMessages = afterIndex < allMessages.length ? allMessages.slice(afterIndex) : []
    res.json({ messages: newMessages, total: allMessages.length, status: objective.status })
  } else {
    res.json({ messages: allMessages, total: allMessages.length, status: objective.status })
  }
})

// POST /api/objectives/:id/planning/message — post a user message to planner
router.post('/:id/planning/message', (req: AuthRequest, res) => {
  const { message, filePaths } = req.body
  if (!message?.trim()) {
    res.status(400).json({ error: 'Message is required' })
    return
  }
  // If files are attached, append their on-disk paths so the planner can read
  // them. Mirrors the /:id/message route's attachment handling.
  let fullMessage = message
  if (filePaths && Array.isArray(filePaths) && filePaths.length > 0) {
    const fileList = filePaths.map((f: string) => `- ${f}`).join('\n')
    fullMessage += `\n\nAttached files (accessible on disk):\n${fileList}`
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
  if (!objective.planning_session_id) {
    res.status(400).json({ error: 'No planning session active — call /planning/start first' })
    return
  }

  // Route through sendFollowUp so the planner gets the message on its existing
  // (or freshly respawned) sub-process. sendFollowUp writes the user message
  // into the planner JSONL as a `followup` event, so persistPlannerMessages
  // (called on the next /messages poll) will mirror it into the DB without
  // needing a second insert here. sendFollowUp returns the active session id.
  const newSessionId = sendFollowUp(objective.planning_session_id, fullMessage, objective)
  if (newSessionId !== objective.planning_session_id) {
    db.prepare(
      "UPDATE objectives SET planning_session_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(newSessionId, req.params.id)
  }
  // Snapshot the just-written followup (and anything else queued) immediately
  // so the durable transcript stays current even if the next GET /messages is
  // delayed.
  persistPlannerMessages(objective.id, newSessionId)
  res.json({ session_id: newSessionId })
})

// POST /api/objectives/:id/planning/approve — extract plan, store, transition to queue
router.post('/:id/planning/approve', async (req: AuthRequest, res) => {
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
  if (objective.status !== 'planning') {
    res.status(400).json({ error: `Objective is not in planning status (current: ${objective.status})` })
    return
  }

  // The body can override the extracted plan if the user wants to edit it
  // before approving.
  const bodyPlan = typeof req.body?.plan === 'string' ? req.body.plan.trim() : ''
  let approvedPlan = bodyPlan
  if (!approvedPlan && objective.planning_session_id) {
    approvedPlan = extractApprovedPlan(objective.planning_session_id) || ''
  }

  // If the planner hasn't emitted a <plan> block yet (e.g. it's sitting in
  // Q&A mode or showing a "Next options" menu), send it a programmatic
  // approve message — the cc-planner skill teaches the planner to treat
  // this as the signal to emit its final plan — then poll for the block.
  // This is the intended Approve-button UX: one click, the system handles
  // the round-trip.
  if (!approvedPlan && objective.planning_session_id) {
    const refreshed = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
    const newSessionId = sendFollowUp(
      objective.planning_session_id,
      'approve — emit the final <plan>…</plan> block now. This is the programmatic approval signal from the Approve Plan button. No more questions, no menus, no "next options".',
      refreshed,
    )
    if (newSessionId !== objective.planning_session_id) {
      db.prepare(
        "UPDATE objectives SET planning_session_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newSessionId, req.params.id)
      objective.planning_session_id = newSessionId
    }
    // Allow up to 90s — covers both a live planner (fast turnaround) and a
    // re-spawned planner that has to cold-load context before emitting the
    // <plan> block.
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2_000))
      const candidate = extractApprovedPlan(objective.planning_session_id)
      if (candidate) {
        approvedPlan = candidate
        break
      }
    }
  }

  if (!approvedPlan) {
    res.status(400).json({
      error: 'Planner did not emit a <plan> block within 90s of the approve signal. The planner may still be loading context — wait a few more seconds and click Approve again, or open the chat to confirm it\'s responsive.',
    })
    return
  }

  // Final snapshot of the planner transcript into planning_conversations so
  // the full both-sides conversation persists even after the session JSONL
  // is no longer being read live.
  if (objective.planning_session_id) {
    persistPlannerMessages(objective.id, objective.planning_session_id)
  }

  // Approve is the human decision. Start the worker now — don't make them
  // click Start on a queue card. If the session cap is full, land in queue.
  const activeCount = (
    db.prepare("SELECT COUNT(*) as count FROM objectives WHERE status IN ('working', 'ai_review')").get() as { count: number }
  ).count
  const nextStatus = activeCount >= MAX_CONCURRENT_SESSIONS ? 'queue' : 'working'

  db.prepare(
    `UPDATE objectives SET
       approved_plan = ?,
       plan_approved_at = datetime('now'),
       status = ?,
       planning_session_id = NULL,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(approvedPlan, nextStatus, req.params.id)

  // Tear down the planner sub-session
  if (objective.planning_session_id) {
    await stopPlannerSession(objective.planning_session_id).catch(() => {})
  }

  if (nextStatus === 'working') {
    try {
      const row = db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
      const sessionId = await startSession(row)
      db.prepare("UPDATE objectives SET session_id = ?, updated_at = datetime('now') WHERE id = ?").run(sessionId, req.params.id)
    } catch (err) {
      console.error(`[planning] failed to start worker after approve on obj ${req.params.id}:`, (err as Error).message)
      db.prepare("UPDATE objectives SET status = 'queue', updated_at = datetime('now') WHERE id = ?").run(req.params.id)
    }
  }

  const updated = mapObjective(
    db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
  )
  broadcast({ type: 'objective_updated', payload: updated })
  res.json(updated)
})

// POST /api/objectives/:id/planning/cancel — keep in planning, kill sub-session
router.post('/:id/planning/cancel', async (req: AuthRequest, res) => {
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
  if (objective.planning_session_id) {
    // Snapshot transcript before tear-down so the conversation is preserved
    // even though a fresh /planning/start will spawn a new session_id.
    persistPlannerMessages(objective.id, objective.planning_session_id)
    await stopPlannerSession(objective.planning_session_id).catch(() => {})
  }
  // Clear the planning_session_id so a fresh /planning/start spawns a new session
  db.prepare(
    "UPDATE objectives SET planning_session_id = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(req.params.id)
  const updated = mapObjective(
    db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
  )
  broadcast({ type: 'objective_updated', payload: updated })
  res.json(updated)
})

// GET /api/objectives/:id/planning/conversations — full saved conversation history
router.get('/:id/planning/conversations', (req: AuthRequest, res) => {
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
  const rows = db
    .prepare(`SELECT * FROM planning_conversations WHERE objective_id = ? ORDER BY created_at ASC`)
    .all(req.params.id) as PlanningMessage[]
  res.json(rows)
})

}
