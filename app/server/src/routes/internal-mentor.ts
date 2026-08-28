/**
 * Jarvis mentor service-auth bridge — extracted from internal.ts
 * (behavior frozen). Localhost + MENTOR_SERVICE_TOKEN gate unchanged.
 */
import { Router } from 'express'
import type { Request, Response } from 'express'
import { getDb } from '../db/index.js'
import { sendMentorMessage, getMentorSessionState, getMentorJsonlPath } from '../services/mentor-session.js'
import { readJsonl } from '../services/mentor-transcript.js'
import { isLocalhost } from '../lib/is-localhost.js'

// ─── Jarvis service-auth bridge (objective 341) ────────────────────────────
// New routes under /api/internal/mentor for the Telegram bot (thin client).
// Each is gated by BOTH isLocalhost(req) AND a service-token header. The
// JWT-gated browser routes in routes/mentor.ts are UNCHANGED. See
// objective-memory/341/BRIDGE_CONTRACT.md.

interface MentorThreadDbRow {
  id: number
  title: string
  tags: string
  pinned: number
  archived: number
  done: number
  folder_id: number | null
  account_id: string | null
  session_id: string | null
  last_active_at: string | null
  last_message_role: 'user' | 'assistant' | null
  workspace: string
  created_by: number | null
  created_at: string
  updated_at: string
}

function mentorOwnerUsername(): string {
  return process.env.MENTOR_TELEGRAM_OWNER_USERNAME || 'mike'
}

/**
 * Resolve the Telegram owner's user id (username = MENTOR_TELEGRAM_OWNER_USERNAME,
 * default "mike"). Returns null if no such user exists.
 */
function resolveOwnerId(): number | null {
  const row = getDb()
    .prepare('SELECT id FROM users WHERE username = ?')
    .get(mentorOwnerUsername()) as { id: number } | undefined
  return row?.id ?? null
}

/**
 * Gate a bridge request: localhost AND a matching service token. Writes the
 * appropriate error response and returns false if the request should be
 * rejected. Fail-closed: if MENTOR_SERVICE_TOKEN is unset, reject (401) and
 * log a warning rather than allowing every localhost caller through.
 */
function checkServiceAuth(req: Request, res: Response): boolean {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return false
  }
  const expected = process.env.MENTOR_SERVICE_TOKEN
  if (!expected) {
    console.warn('[internal/mentor] MENTOR_SERVICE_TOKEN is unset — rejecting bridge request (fail-closed)')
    res.status(401).json({ error: 'Service token not configured' })
    return false
  }
  const provided = req.header('x-service-token')
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'Invalid or missing service token' })
    return false
  }
  return true
}

/**
 * Fetch a thread by id, requiring it to be owned by the Telegram owner. Writes
 * a 404 and returns null otherwise (so foreign threads are indistinguishable
 * from missing ones — no ownership oracle).
 */
function getOwnedThreadOr404(id: number, res: Response): MentorThreadDbRow | null {
  const ownerId = resolveOwnerId()
  if (ownerId == null) {
    res.status(404).json({ error: 'Thread not found' })
    return null
  }
  const row = getDb()
    .prepare('SELECT * FROM mentor_threads WHERE id = ?')
    .get(id) as MentorThreadDbRow | undefined
  if (!row || row.created_by !== ownerId) {
    res.status(404).json({ error: 'Thread not found' })
    return null
  }
  return row
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

// 1. GET /api/internal/mentor/threads — list the owner's threads.

export function registerInternalMentorRoutes(router: Router): void {
router.get('/mentor/threads', (req, res) => {
  if (!checkServiceAuth(req, res)) return
  const ownerId = resolveOwnerId()
  if (ownerId == null) {
    res.json({ threads: [] })
    return
  }
  const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true'
  const db = getDb()
  const where = ['created_by = ?']
  const params: unknown[] = [ownerId]
  if (!includeArchived) where.push('archived = 0')
  const sql = `SELECT * FROM mentor_threads WHERE ${where.join(' AND ')} ORDER BY pinned DESC, COALESCE(last_active_at, updated_at) DESC`
  const rows = db.prepare(sql).all(...params) as MentorThreadDbRow[]
  res.json({
    threads: rows.map(r => ({
      id: r.id,
      title: r.title,
      last_active_at: r.last_active_at,
      last_message_role: r.last_message_role ?? null,
      pinned: r.pinned === 1,
      archived: r.archived === 1,
      tags: parseTags(r.tags),
    })),
  })
})

// 2. POST /api/internal/mentor/threads — create a thread owned by the owner.
router.post('/mentor/threads', (req, res) => {
  if (!checkServiceAuth(req, res)) return
  const ownerId = resolveOwnerId()
  if (ownerId == null) {
    res.status(500).json({ error: `Telegram owner '${mentorOwnerUsername()}' not found` })
    return
  }
  const body = (req.body || {}) as { title?: string; workspace?: string; tags?: string[] }
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Telegram'
  const workspace = typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : 'example'
  const requested = Array.isArray(body.tags) ? body.tags.filter(t => typeof t === 'string') : []
  const tags = requested.includes('telegram') ? requested : ['telegram', ...requested]

  const db = getDb()
  const result = db
    .prepare('INSERT INTO mentor_threads (title, tags, workspace, created_by) VALUES (?, ?, ?, ?)')
    .run(title, JSON.stringify(tags), workspace, ownerId)
  const row = db.prepare('SELECT * FROM mentor_threads WHERE id = ?').get(result.lastInsertRowid) as MentorThreadDbRow
  res.status(201).json({
    thread: {
      id: row.id,
      title: row.title,
      workspace: row.workspace || 'example',
      tags: parseTags(row.tags),
      created_at: row.created_at,
      updated_at: row.updated_at,
      created_by: row.created_by,
      pinned: row.pinned === 1,
      archived: row.archived === 1,
    },
  })
})

// 3. POST /api/internal/mentor/threads/:id/messages — post a user message.
router.post('/mentor/threads/:id/messages', (req, res) => {
  if (!checkServiceAuth(req, res)) return
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const row = getOwnedThreadOr404(id, res)
  if (!row) return

  const body = (req.body || {}) as { content?: string }
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content) {
    res.status(400).json({ error: 'content is required' })
    return
  }

  let sessionId: string | null = null
  try {
    sessionId = sendMentorMessage(id, content)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to send message'
    res.status(502).json({ error: message })
    return
  }
  res.status(202).json({ session_id: sessionId, thread_id: id })
})

// 4. GET /api/internal/mentor/threads/:id/output — poll state + transcript.
router.get('/mentor/threads/:id/output', (req, res) => {
  if (!checkServiceAuth(req, res)) return
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const row = getOwnedThreadOr404(id, res)
  if (!row) return

  const jsonlPath = getMentorJsonlPath(id)
  let messages = jsonlPath ? readJsonl(jsonlPath) : []
  const state = getMentorSessionState(id)
  const tail = parseInt(req.query.tail as string, 10)
  if (Number.isFinite(tail) && tail > 0 && messages.length > tail) {
    messages = messages.slice(-tail)
  }
  res.json({ state, messages, last_active_at: row.last_active_at })
})

}
