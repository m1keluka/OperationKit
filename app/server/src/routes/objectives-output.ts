/**
 * Output, stream, and chat-message routes — extracted from objectives.ts
 * (behavior frozen). Registered on the same /api/objectives router.
 */
import fs from 'fs'
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import type { Objective, SessionMessage, ThreadTimeline } from '@operationkit/shared'
import { buildThreadTimelineCached } from '../services/thread-timeline.js'
import { getSessionOutput, getSessionJsonlPath, sendFollowUp, recordFollowUpInJsonl } from '../services/session-manager.js'
import { checkHumanTerminalReactivation } from '../services/objective-audit.js'
import { broadcast } from '../ws/index.js'
import { mapObjective, requireOwnership } from './objectives-helpers.js'
import { isLockedStatus, runMachineStatusUpdate } from '../lib/status-lock.js'
import { diskAction, diskBlockReason, readHostDisk } from '../lib/host-disk.js'

// Default cap on the non-incremental first-open payload: the most recent N
// messages. Older history loads on demand via ?from&to; the live tail via
// ?after. Chosen well above the client's live-tail cap (40) so the first paint
// has context, but far below "the whole session".
const DEFAULT_OUTPUT_LIMIT = 200
// Hard cap on a single ?from&to expansion so one lazy fetch can't ship the
// entire array. Larger ranges page via successive ?from&to requests.
const MAX_OUTPUT_SLICE = 500

export function registerObjectiveOutputRoutes(router: Router): void {
// GET /api/objectives/:id/output?after=N
// When `after` is provided, returns only messages with index > N (incremental).
// Response includes `total` so the client knows the full count for the next poll.
// First open (no query) returns the most recent DEFAULT_OUTPUT_LIMIT messages
// (bounded); ?limit=N overrides, ?limit=0 returns the full array.
// ?view=timeline returns the collapsed segment list (memoized); pass
// ?known=<count> to get a tiny {unchanged:true} body when nothing new arrived.
// ?from&to returns a raw slice (span-capped at MAX_OUTPUT_SLICE).
router.get('/:id/output', (req: AuthRequest, res) => {
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

  // Gather ALL session IDs for this objective (current + prior), ordered
  // chronologically, and CONCATENATE their transcripts into one thread.
  //
  // An objective accumulates many session ids over its life (task respawns,
  // wake continuations, queue restarts) — obj 702589 reached 15 in one day.
  // The old behaviour returned only the current/latest session, silently
  // hiding every earlier session's green summaries and user follow-ups
  // (obj 702624: 42 of 44 user messages invisible). The thread is the
  // OBJECTIVE's conversation, so it spans all its sessions.
  //
  // Reviewer (`cc-review-*`) and planner (`cc-plan-*`) transcripts are
  // separate conversations with their own surfaces — they are excluded from
  // the interleaved history. The objective's CURRENT session is always
  // included (even if it is a review/plan session) so an actively-running
  // session is never invisible.
  const priorSessions = db.prepare(
    'SELECT session_id FROM session_intel WHERE objective_id = ? ORDER BY started_at ASC'
  ).all(objective.id) as { session_id: string }[]

  const isAuxSession = (id: string) => id.startsWith('cc-review-') || id.startsWith('cc-plan-')
  const orderedIds: string[] = []
  for (const s of priorSessions) {
    if (!isAuxSession(s.session_id) && !orderedIds.includes(s.session_id)) orderedIds.push(s.session_id)
  }
  if (objective.session_id && !orderedIds.includes(objective.session_id)) {
    orderedIds.push(objective.session_id)
  }
  // Fallback: only aux sessions exist (e.g. a done objective whose last
  // session_id pointed at its reviewer) — show them rather than a blank thread.
  if (orderedIds.length === 0) {
    for (const s of priorSessions) {
      if (!orderedIds.includes(s.session_id)) orderedIds.push(s.session_id)
    }
  }

  if (orderedIds.length === 0) {
    res.json({ messages: [], total: 0, status: objective.status })
    return
  }

  // `session_id` reported to the client stays the newest session (the live one).
  const targetId = orderedIds[orderedIds.length - 1]

  // getSessionOutput is fast — returns cached parsed messages per session, only
  // reading new bytes from each JSONL since the last call. Only the newest
  // session's file ever grows, so the concatenation is stable-prefix +
  // growing tail, which keeps timeline indices (and the client's cached
  // ?from&to slices) valid across polls.
  const perSession = orderedIds.map(id => getSessionOutput(id))
  const allMessages: SessionMessage[] =
    perSession.length === 1 ? perSession[0] : ([] as SessionMessage[]).concat(...perSession)

  // ?view=timeline — collapsed thread of visible anchors + collapsed action
  // gaps, computed over the FULL parsed array (not the tail). Used by the UI to
  // render a delegator thread without a wall of tool calls.
  if (req.query.view === 'timeline') {
    // ?known=<count> — the client tells us how many messages it last saw. If the
    // session hasn't grown, short-circuit with a tiny "unchanged" body instead
    // of re-shipping the whole (up to ~100KB+) segment list on every 2s poll.
    // This is the common case for a working session between tool calls.
    const known = parseInt(req.query.known as string, 10)
    if (!isNaN(known) && known === allMessages.length) {
      res.json({ unchanged: true, total: allMessages.length, status: objective.status, session_id: targetId })
      return
    }
    const timeline: ThreadTimeline = {
      total: allMessages.length,
      status: objective.status,
      session_id: targetId,
      // Memoized by (session-set key, message count): a poll where the count is
      // unchanged is a Map lookup, not an O(n) rebuild over the full array. The
      // key spans ALL concatenated sessions so a new session id (which shifts
      // the array) never reuses a stale single-session entry.
      segments: buildThreadTimelineCached(orderedIds.join('|'), allMessages),
    }
    res.json(timeline)
    return
  }

  // ?from=START&to=END — lazy expansion of a collapsed action gap. Returns the
  // raw messages in [START, END) over the full parsed array. Indices are
  // validated and clamped to the array bounds, and the span is capped so a
  // single expansion (e.g. the leading "older history" gap of a huge session)
  // can never itself ship the entire message array.
  if (req.query.from !== undefined || req.query.to !== undefined) {
    const rawFrom = parseInt(req.query.from as string, 10)
    const rawTo = parseInt(req.query.to as string, 10)
    const from = Math.max(0, Math.min(isNaN(rawFrom) ? 0 : rawFrom, allMessages.length))
    const reqTo = Math.max(from, Math.min(isNaN(rawTo) ? allMessages.length : rawTo, allMessages.length))
    const to = Math.min(reqTo, from + MAX_OUTPUT_SLICE)
    res.json({
      messages: allMessages.slice(from, to),
      total: allMessages.length,
      status: objective.status,
      session_id: targetId,
      from,
      to,
      // True when the requested range was clamped — the client can page the rest
      // with a follow-up ?from=to&to=… request.
      truncated: to < reqTo,
    })
    return
  }

  // Check whether we need a synthetic end indicator (crash/OOM/budget).
  // We check against the full list so we don't miss a result in earlier messages.
  const needsEndIndicator = (() => {
    if (objective.status === 'working') return false
    if (allMessages.length === 0) return false
    const last = allMessages[allMessages.length - 1]
    if (last.type === 'result') return false
    const recentResult = [...allMessages].reverse().find(m => m.type === 'result' || m.type === 'error')
    if (recentResult?.text && /hit your limit|rate.?limit|usage limit/i.test(recentResult.text)) return false
    return true
  })()
  const endMsg: SessionMessage | null = needsEndIndicator ? {
    type: 'system',
    text: 'Session ended unexpectedly — no completion message was received. The process may have crashed, been killed (OOM), or hit the budget limit.',
    timestamp: new Date().toISOString(),
  } : null

  const totalWithEnd = allMessages.length + (endMsg ? 1 : 0)

  if (incremental) {
    const newMessages = afterIndex < allMessages.length ? allMessages.slice(afterIndex) : []
    // Append end indicator if it falls within this slice
    if (endMsg && afterIndex <= allMessages.length) newMessages.push(endMsg)
    res.json({ messages: newMessages, total: totalWithEnd, status: objective.status })
  } else {
    // Non-incremental first open: bound the payload to the most recent `limit`
    // messages instead of shipping the entire array (a multi-thousand-message
    // session is multiple MB). Older messages load lazily via ?from&to and the
    // live tail streams via ?after. `total`/`from` let the client know a bounded
    // window was returned. Callers can pass ?limit=0 for the (rare) full dump.
    const rawLimit = parseInt(req.query.limit as string, 10)
    const limit = isNaN(rawLimit) ? DEFAULT_OUTPUT_LIMIT : Math.max(0, rawLimit)
    const withEnd = endMsg ? [...allMessages, endMsg] : allMessages
    const start = limit > 0 && withEnd.length > limit ? withEnd.length - limit : 0
    const messages = start > 0 ? withEnd.slice(start) : [...withEnd]
    res.json({
      messages,
      total: totalWithEnd,
      status: objective.status,
      from: start,
      truncated: start > 0,
    })
  }
})

// GET /api/objectives/:id/stream
// Server-Sent Events "poke" channel for an objective's live thread. It ships NO
// transcript data — it only signals "something changed, re-fetch /output now",
// giving the SessionViewer/ThreadTimeline instant updates instead of a 2s poll.
// GET /:id/output remains the data source + fallback.
//
// A `changed` event carries the current concatenated message `total` and the
// objective `status`, computed the SAME way /output does (concatenated
// getSessionOutput over the ordered, non-aux session ids). It fires on connect,
// then whenever the live session's JSONL grows, the live session id changes, or
// the status changes.
router.get('/:id/stream', (req: AuthRequest, res) => {
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

  const objectiveId = objective.id
  const isAuxSession = (id: string) => id.startsWith('cc-review-') || id.startsWith('cc-plan-')

  // Resolve the ordered session ids + newest live session id EXACTLY as /output
  // does. Re-reads the DB each call so a new session (respawn/wake) is picked up.
  const resolve = (): { orderedIds: string[]; targetId: string | null; status: string } => {
    const obj = db.prepare('SELECT session_id, status FROM objectives WHERE id = ?')
      .get(objectiveId) as { session_id: string | null; status: string } | undefined
    if (!obj) return { orderedIds: [], targetId: null, status: objective.status }
    const priorSessions = db.prepare(
      'SELECT session_id FROM session_intel WHERE objective_id = ? ORDER BY started_at ASC'
    ).all(objectiveId) as { session_id: string }[]
    const orderedIds: string[] = []
    for (const s of priorSessions) {
      if (!isAuxSession(s.session_id) && !orderedIds.includes(s.session_id)) orderedIds.push(s.session_id)
    }
    if (obj.session_id && !orderedIds.includes(obj.session_id)) orderedIds.push(obj.session_id)
    if (orderedIds.length === 0) {
      for (const s of priorSessions) {
        if (!orderedIds.includes(s.session_id)) orderedIds.push(s.session_id)
      }
    }
    const targetId = orderedIds.length ? orderedIds[orderedIds.length - 1] : null
    return { orderedIds, targetId, status: obj.status }
  }

  // Concatenated message count, same source as /output's `total` (pre end-indicator).
  const computeTotal = (orderedIds: string[]): number => {
    if (orderedIds.length === 0) return 0
    let n = 0
    for (const id of orderedIds) {
      try { n += getSessionOutput(id).length } catch { /* ignore */ }
    }
    return n
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  let closed = false
  let watcher: fs.FSWatcher | null = null
  let watchedPath: string | null = null
  let watchedSessionId: string | null = null
  let debounceTimer: NodeJS.Timeout | null = null
  let lastSignature = ''

  const emitChanged = () => {
    if (closed) return
    const { orderedIds, status } = resolve()
    const total = computeTotal(orderedIds)
    const signature = `${total}|${status}`
    if (signature === lastSignature) return
    lastSignature = signature
    res.write(`event: changed\ndata: ${JSON.stringify({ total, status })}\n\n`)
  }

  const scheduleEmit = () => {
    if (closed) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { debounceTimer = null; emitChanged() }, 150)
  }

  // (Re)attach the fs.watch on the newest live session's JSONL. No-op if the
  // path is unchanged and the watcher is still live. If the file doesn't exist
  // yet, leave the watcher off — the 1s tick re-attaches once it appears.
  const attachWatcher = (targetId: string | null) => {
    if (closed) return
    if (targetId === watchedSessionId && watcher) return
    if (watcher) { try { watcher.close() } catch { /* ignore */ } watcher = null }
    watchedSessionId = targetId
    watchedPath = targetId ? getSessionJsonlPath(targetId) : null
    if (!watchedPath) return
    try {
      if (!fs.existsSync(watchedPath)) return
      watcher = fs.watch(watchedPath, () => scheduleEmit())
    } catch { watcher = null }
  }

  // Connect snapshot: emit current total+status (may be total=0 if the JSONL
  // doesn't exist yet), then attach the watcher.
  {
    const { orderedIds, targetId, status } = resolve()
    const total = computeTotal(orderedIds)
    lastSignature = `${total}|${status}`
    res.write(`event: changed\ndata: ${JSON.stringify({ total, status })}\n\n`)
    attachWatcher(targetId)
  }

  // ~1s safety tick: cheap re-resolve of the live session id (re-attach the
  // watcher if it moved or the file just appeared) + change-detected emit.
  const safetyInterval = setInterval(() => {
    if (closed) return
    const { orderedIds, targetId, status } = resolve()
    if (targetId !== watchedSessionId || (targetId && !watcher)) attachWatcher(targetId)
    const total = computeTotal(orderedIds)
    const signature = `${total}|${status}`
    if (signature !== lastSignature) {
      lastSignature = signature
      res.write(`event: changed\ndata: ${JSON.stringify({ total, status })}\n\n`)
    }
  }, 1000)

  // Heartbeat comment so proxies/clients keep the connection open.
  const heartbeat = setInterval(() => {
    if (closed) return
    res.write(`: ping\n\n`)
  }, 25000)

  const cleanup = () => {
    if (closed) return
    closed = true
    if (watcher) { try { watcher.close() } catch { /* ignore */ } watcher = null }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    clearInterval(safetyInterval)
    clearInterval(heartbeat)
  }

  req.on('close', cleanup)
  res.on('error', cleanup)
})

// POST /api/objectives/:id/message
router.post('/:id/message', async (req: AuthRequest, res) => {
  const { message, filePaths } = req.body
  if (!message?.trim()) {
    res.status(400).json({ error: 'Message is required' })
    return
  }
  // If files are attached, append their paths to the message so Claude can access them
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

  // If no active session (task-driven objectives clear session_id), find the last
  // session or generate a new one. Using the last session_id means the follow-up
  // appends to the existing JSONL, preserving conversation history in the UI.
  let existingSessionId = objective.session_id
  if (!existingSessionId) {
    const lastSession = db.prepare(
      'SELECT session_id FROM session_intel WHERE objective_id = ? ORDER BY ended_at DESC LIMIT 1'
    ).get(objective.id) as { session_id: string } | undefined
    existingSessionId = lastSession?.session_id || `cc-${objective.id}-${Date.now()}`
  }

  // Respond BEFORE the (re)spawn so the client isn't blocked for 3-5s (obj 700253).
  // For the current tmux architecture sessions hold no live stdin, so every
  // follow-up falls through sendFollowUp's respawn path, whose synchronous work
  // (resume lookup, worktree verify, predecessor reap, tmux spawn) blocked the
  // HTTP response — which the UI ties the textbox-clear and "working" flip to.
  //
  // sendFollowUp ALWAYS returns the same session id it was passed, so we can
  // persist status + session_id and answer the client up-front, then run the
  // heavy spawn on the next tick. The frontend discards this response body and
  // reconciles the message via timeline polling, so an early 200 is safe.
  const priorStatus = objective.status
  // Human-terminal guard (obj 700415, FIX B). A chat message silently flips a
  // parked/terminal objective back to `working` with no status guard (deliverable
  // A pathway #7). Under CC_HUMAN_TERMINAL_GUARD (default OFF → dry-run) a message
  // to a human-terminated objective logs "WOULD block" and still proceeds; when
  // enforced it is skipped (the human must explicitly reopen first). A message is
  // NOT treated as an explicit reopen.
  if (isLockedStatus(objective.status)) {
    res.status(409).json({
      error: 'This card is done. Reopen it before sending a message.',
      status: objective.status,
    })
    return
  }
  // Fail fast when the VPS is out of space. A disk-full UPDATE/jsonl append
  // hangs the event loop and the composer looks dead (2026-08-25).
  const disk = readHostDisk()
  if (disk && diskAction(disk) === 'block') {
    res.status(507).json({ error: diskBlockReason(disk) })
    return
  }
  const chatGuard = checkHumanTerminalReactivation(db, objective, 'public-message-chat-flip')
  if (chatGuard.blocked) {
    res.status(409).json({
      error: 'Objective was ended by a human — reopen it explicitly before messaging.',
      terminal_by_human: true,
    })
    return
  }
  runMachineStatusUpdate(
    db,
    "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
    existingSessionId,
    Number(req.params.id),
  )
  const updated = mapObjective(
    db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
  )
  broadcast({ type: 'objective_updated', payload: updated })
  // Write the follow-up into jsonl BEFORE 200 so the next timeline poll can
  // show the bubble even if spawn is still in flight (or later throws).
  try {
    recordFollowUpInJsonl(existingSessionId, fullMessage)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    console.error(`[objectives] message → jsonl write failed for ${req.params.id}:`, err)
    if (code === 'ENOSPC') {
      res.status(507).json({ error: 'Disk is full — message not sent. Cleanup is running; retry in a minute.' })
      return
    }
    res.status(500).json({ error: 'Failed to record message' })
    return
  }
  res.json(updated)

  // Defer the spawn so it runs after the response is flushed. A throw here can no
  // longer reach the client, so on failure we revert the objective to its prior
  // status and broadcast, rather than leaving the card stuck on "working".
  setImmediate(() => {
    try {
      sendFollowUp(existingSessionId, fullMessage, objective, { skipJsonl: true })
    } catch (err) {
      console.error(`[objectives] message → deferred sendFollowUp failed for ${req.params.id}:`, err)
      try {
        db.prepare("UPDATE objectives SET status = ?, updated_at = datetime('now') WHERE id = ?").run(priorStatus, req.params.id)
        const reverted = mapObjective(
          db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
        )
        broadcast({ type: 'objective_updated', payload: reverted })
      } catch (revertErr) {
        console.error(`[objectives] message → failed to revert status for ${req.params.id}:`, revertErr)
      }
    }
  })
})

}
