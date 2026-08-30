import { Router, type Response, type NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import multer from 'multer'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'

/**
 * Gate Assistant chat access:
 *  - admins always pass
 *  - members pass iff at least one of their workspace memberships has
 *    can_use_assistant = true
 */
function requireAssistantAccess(req: AuthRequest, res: Response, next: NextFunction): void {
  const user = req.user
  if (!user) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  if (user.role === 'admin') {
    next()
    return
  }
  const memberships = getUserWorkspaces(user.id)
  if (memberships.some(m => m.can_use_assistant)) {
    next()
    return
  }
  res.status(403).json({ error: 'Assistant access not enabled for your account' })
}
import {
  startMentorSession,
  sendMentorMessage,
  stopMentorSession,
  getMentorSessionState,
  getMentorJsonlPath,
} from '../services/mentor-session.js'
import { readJsonl } from '../services/mentor-transcript.js'
import type {
  MentorThread,
  ThreadFolder,
  CreateMentorThreadRequest,
  UpdateMentorThreadRequest,
  PostMentorMessageRequest,
  PostMentorMessageResponse,
  MentorThreadOutput,
  SessionMessage,
} from '@operationkit/shared'

const router: Router = Router()
router.use(requireAuth, requireAssistantAccess)

// Upload storage — files go to /app/data/mentor-uploads/<threadId>/
const MENTOR_UPLOAD_DIR = '/app/data/mentor-uploads'
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(MENTOR_UPLOAD_DIR, String(req.params.id))
      fs.mkdirSync(dir, { recursive: true })
      cb(null, dir)
    },
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
      cb(null, `${Date.now()}-${safeName}`)
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
})

interface ThreadRow {
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

interface FolderRow {
  id: number
  title: string
  workspace: string
  created_at: string
  updated_at: string
}

function rowToThread(row: ThreadRow): MentorThread {
  let tags: string[] = []
  try {
    const parsed = JSON.parse(row.tags || '[]')
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string')
  } catch {
    tags = []
  }
  return {
    id: row.id,
    title: row.title,
    tags,
    pinned: row.pinned === 1,
    archived: row.archived === 1,
    done: row.done === 1,
    folder_id: row.folder_id ?? null,
    account_id: row.account_id,
    session_id: row.session_id,
    last_active_at: row.last_active_at,
    last_message_role: row.last_message_role ?? null,
    workspace: row.workspace || 'example',
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function rowToFolder(row: FolderRow): ThreadFolder {
  return {
    id: row.id,
    title: row.title,
    workspace: row.workspace || 'example',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function getFolderOr404(id: number, res: Response, req: AuthRequest): FolderRow | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM thread_folders WHERE id = ?').get(id) as FolderRow | undefined
  if (!row) {
    res.status(404).json({ error: 'Folder not found' })
    return null
  }
  if (req.user && req.user.role !== 'admin') {
    const allowed = getUserWorkspaces(req.user.id).map(m => m.workspace)
    if (!allowed.includes(row.workspace || 'example')) {
      res.status(403).json({ error: 'No access to this folder' })
      return null
    }
  }
  return row
}

function getThreadOr404(id: number, res: Response, req?: AuthRequest): ThreadRow | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM mentor_threads WHERE id = ?').get(id) as ThreadRow | undefined
  if (!row) {
    res.status(404).json({ error: 'Thread not found' })
    return null
  }
  if (req?.user && req.user.role !== 'admin') {
    const allowed = getUserWorkspaces(req.user.id).map(m => m.workspace)
    const ws = row.workspace || 'example'
    if (!allowed.includes(ws)) {
      res.status(403).json({ error: 'No access to this thread' })
      return null
    }
    // Phase 6: mentor threads are private-by-default. Members only see threads
    // they created themselves. Legacy threads with created_by=NULL stay
    // admin-only (they predate multi-user and belong to Operator).
    if (row.created_by !== req.user.id) {
      res.status(403).json({ error: 'No access to this thread' })
      return null
    }
  }
  return row
}

// ── Folder CRUD ──

router.get('/folders', (req: AuthRequest, res: Response) => {
  const user = req.user!
  const db = getDb()
  if (user.role === 'admin') {
    const rows = db.prepare('SELECT * FROM thread_folders ORDER BY title ASC').all() as FolderRow[]
    res.json(rows.map(rowToFolder))
    return
  }
  const allowed = getUserWorkspaces(user.id).map(m => m.workspace)
  if (allowed.length === 0) {
    res.json([])
    return
  }
  const placeholders = allowed.map(() => '?').join(',')
  const rows = db
    .prepare(`SELECT * FROM thread_folders WHERE workspace IN (${placeholders}) ORDER BY title ASC`)
    .all(...allowed) as FolderRow[]
  res.json(rows.map(rowToFolder))
})

router.post('/folders', (req: AuthRequest, res: Response) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
  if (!title) {
    res.status(400).json({ error: 'title is required' })
    return
  }
  const workspace = typeof req.body?.workspace === 'string' ? req.body.workspace.trim() : ''
  if (!workspace) {
    res.status(400).json({ error: 'workspace is required' })
    return
  }
  const user = req.user!
  if (user.role !== 'admin') {
    const allowed = getUserWorkspaces(user.id).map(m => m.workspace)
    if (!allowed.includes(workspace)) {
      res.status(403).json({ error: `No access to workspace '${workspace}'` })
      return
    }
  }
  const db = getDb()
  const result = db
    .prepare('INSERT INTO thread_folders (title, workspace) VALUES (?, ?)')
    .run(title, workspace)
  const row = db.prepare('SELECT * FROM thread_folders WHERE id = ?').get(result.lastInsertRowid) as FolderRow
  res.status(201).json(rowToFolder(row))
})

router.patch('/folders/:id', (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  if (!getFolderOr404(id, res, req)) return
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : ''
  if (!title) {
    res.status(400).json({ error: 'title is required' })
    return
  }
  const db = getDb()
  db.prepare("UPDATE thread_folders SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, id)
  const row = db.prepare('SELECT * FROM thread_folders WHERE id = ?').get(id) as FolderRow
  res.json(rowToFolder(row))
})

router.delete('/folders/:id', (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  if (!getFolderOr404(id, res, req)) return
  const db = getDb()
  // Null out threads in this folder before deleting
  db.prepare('UPDATE mentor_threads SET folder_id = NULL WHERE folder_id = ?').run(id)
  db.prepare('DELETE FROM thread_folders WHERE id = ?').run(id)
  res.status(204).end()
})

// ── Thread CRUD ──

router.get('/threads', (req: AuthRequest, res: Response) => {
  const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true'
  const wsFilter = typeof req.query.workspace === 'string' ? req.query.workspace : null
  const user = req.user!
  const db = getDb()

  const where: string[] = []
  const params: unknown[] = []
  if (!includeArchived) where.push('archived = 0')

  if (user.role === 'admin') {
    if (wsFilter && wsFilter !== 'all') {
      where.push('workspace = ?')
      params.push(wsFilter)
    }
  } else {
    const allowed = getUserWorkspaces(user.id).map(m => m.workspace)
    if (allowed.length === 0) {
      res.json([])
      return
    }
    if (wsFilter && wsFilter !== 'all') {
      if (!allowed.includes(wsFilter)) {
        res.json([])
        return
      }
      where.push('workspace = ?')
      params.push(wsFilter)
    } else {
      where.push(`workspace IN (${allowed.map(() => '?').join(',')})`)
      params.push(...allowed)
    }
    // Phase 6: mentor threads are private-by-default for members.
    where.push('created_by = ?')
    params.push(user.id)
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const sql = `SELECT * FROM mentor_threads ${whereSql} ORDER BY pinned DESC, updated_at DESC`
  const rows = db.prepare(sql).all(...params) as ThreadRow[]
  res.json(rows.map(rowToThread))
})

router.post('/threads', (req: AuthRequest, res: Response) => {
  const body = (req.body || {}) as CreateMentorThreadRequest
  const user = req.user!
  const title = body.title?.trim() || 'Untitled'
  const tags = Array.isArray(body.tags) ? body.tags.filter(t => typeof t === 'string') : []
  const workspace = body.workspace?.trim() || 'example'

  if (user.role !== 'admin') {
    const allowed = getUserWorkspaces(user.id).map(m => m.workspace)
    if (!allowed.includes(workspace)) {
      res.status(403).json({ error: `No access to workspace '${workspace}'` })
      return
    }
  }

  const db = getDb()
  const result = db
    .prepare('INSERT INTO mentor_threads (title, tags, workspace, created_by) VALUES (?, ?, ?, ?)')
    .run(title, JSON.stringify(tags), workspace, user.id)
  const row = db
    .prepare('SELECT * FROM mentor_threads WHERE id = ?')
    .get(result.lastInsertRowid) as ThreadRow
  res.status(201).json(rowToThread(row))
})

router.patch('/threads/:id', (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const existing = getThreadOr404(id, res, req)
  if (!existing) return

  const body = (req.body || {}) as UpdateMentorThreadRequest
  const updates: string[] = []
  const values: Array<string | number | null> = []

  if (typeof body.title === 'string') {
    const trimmed = body.title.trim()
    if (!trimmed) {
      res.status(400).json({ error: 'title cannot be empty' })
      return
    }
    updates.push('title = ?')
    values.push(trimmed)
  }
  if (Array.isArray(body.tags)) {
    const tags = body.tags.filter(t => typeof t === 'string')
    updates.push('tags = ?')
    values.push(JSON.stringify(tags))
  }
  if (typeof body.pinned === 'boolean') {
    updates.push('pinned = ?')
    values.push(body.pinned ? 1 : 0)
  }
  if (typeof body.archived === 'boolean') {
    updates.push('archived = ?')
    values.push(body.archived ? 1 : 0)
  }
  if (typeof body.done === 'boolean') {
    updates.push('done = ?')
    values.push(body.done ? 1 : 0)
  }
  if ('folder_id' in body) {
    updates.push('folder_id = ?')
    values.push(body.folder_id == null ? null : Number(body.folder_id))
  }
  if (typeof body.workspace === 'string') {
    const ws = body.workspace.trim()
    const user = req.user!
    if (user.role !== 'admin') {
      const allowed = getUserWorkspaces(user.id).map(m => m.workspace)
      if (!allowed.includes(ws)) {
        res.status(403).json({ error: `No access to workspace '${ws}'` })
        return
      }
    }
    updates.push('workspace = ?')
    values.push(ws)
  }

  if (updates.length === 0) {
    res.json(rowToThread(existing))
    return
  }

  updates.push("updated_at = datetime('now')")

  const db = getDb()
  db.prepare(`UPDATE mentor_threads SET ${updates.join(', ')} WHERE id = ?`).run(...values, id)
  const row = db.prepare('SELECT * FROM mentor_threads WHERE id = ?').get(id) as ThreadRow
  res.json(rowToThread(row))
})

router.delete('/threads/:id', (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  // Verify access before stopping the session or deleting the row, otherwise
  // a non-member could nuke another workspace's thread by id.
  if (!getThreadOr404(id, res, req)) return
  try { stopMentorSession(id) } catch {}
  const db = getDb()
  const result = db.prepare('DELETE FROM mentor_threads WHERE id = ?').run(id)
  if (result.changes === 0) {
    res.status(404).json({ error: 'Thread not found' })
    return
  }
  res.status(204).end()
})

// ── Output / messaging ──

/**
 * Live transcript for a thread. Reads the JSONL log on disk (live or last
 * completed session) and parses it into SessionMessage[] using the same
 * format the board UI consumes. Polled by the client every ~2s.
 */
router.get('/threads/:id/output', (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const row = getThreadOr404(id, res, req)
  if (!row) return

  const jsonlPath = getMentorJsonlPath(id)
  const messages: SessionMessage[] = jsonlPath ? readJsonl(jsonlPath) : []
  const state = getMentorSessionState(id)

  const output: MentorThreadOutput = {
    thread: rowToThread(row),
    state,
    messages,
  }
  res.json(output)
})

/**
 * Server-Sent Events stream for a thread's live transcript. Near-instant
 * updates vs. the 2s /output poll (which stays as the fallback).
 *
 * Emits:
 *  - `event: snapshot` on connect — the full MentorThreadOutput shape
 *    ({thread, state, messages}), identical to the poll endpoint.
 *  - `event: update` whenever the thread's JSONL file changes OR the session
 *    state changes — {state, messages}. Change-detection is cheap: messages
 *    length + last-message JSON + state; nothing is emitted unless one moved.
 *  - `: ping` comment every 25s so idle proxies (Caddy) don't drop the socket.
 *
 * The JSONL is appended live by spawnMentorProcess's stdout handler
 * (fs.appendFileSync), so tailing the file gives real-time output. We watch
 * the file with fs.watch (debounced ~150ms) and also re-poll the session
 * state each tick so state transitions (working→review→idle) propagate even
 * when the file itself is quiet.
 */
router.get('/threads/:id/stream', (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const row = getThreadOr404(id, res, req)
  if (!row) return

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()

  // Assemble the current {state, messages} snapshot. Path is re-resolved each
  // tick because a fresh session (respawn) rotates the JSONL to a new file.
  const assemble = (): { state: ReturnType<typeof getMentorSessionState>; messages: SessionMessage[] } => {
    const jsonlPath = getMentorJsonlPath(id)
    const messages: SessionMessage[] = jsonlPath ? readJsonl(jsonlPath) : []
    const state = getMentorSessionState(id)
    return { state, messages }
  }

  // Cheap change signature: messages length + last message JSON + state.
  const signature = (state: string, messages: SessionMessage[]): string =>
    `${state}|${messages.length}|${messages.length ? JSON.stringify(messages[messages.length - 1]) : ''}`

  // Initial snapshot (full MentorThreadOutput shape, like /output).
  const initial = assemble()
  let lastSig = signature(initial.state, initial.messages)
  const snapshot: MentorThreadOutput = {
    thread: rowToThread(row),
    state: initial.state,
    messages: initial.messages,
  }
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`)

  let closed = false
  let debounceTimer: NodeJS.Timeout | null = null
  let watcher: fs.FSWatcher | null = null
  let watchedPath: string | null = null

  const emitUpdate = (): void => {
    if (closed) return
    const { state, messages } = assemble()
    const sig = signature(state, messages)
    if (sig === lastSig) return
    lastSig = sig
    res.write(`event: update\ndata: ${JSON.stringify({ state, messages })}\n\n`)
  }

  const scheduleEmit = (): void => {
    if (closed) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(emitUpdate, 150)
  }

  // Ensure we're watching the current JSONL file. The path can change on
  // respawn (new session id) or appear for the first time (session just
  // started), so re-check it on every tick and (re)attach the watcher.
  const ensureWatcher = (): void => {
    if (closed) return
    const jsonlPath = getMentorJsonlPath(id)
    if (!jsonlPath) return
    if (watchedPath === jsonlPath && watcher) return
    if (watcher) { try { watcher.close() } catch {} watcher = null }
    try {
      watcher = fs.watch(jsonlPath, () => scheduleEmit())
      watchedPath = jsonlPath
    } catch {
      // File may not exist yet — the poll tick below will retry ensureWatcher
      // and emit once it appears.
      watcher = null
      watchedPath = null
    }
  }

  ensureWatcher()

  // Poll tick: catches state transitions when the file is quiet, and picks up
  // the file (or a rotated file) whenever fs.watch missed it or wasn't attached
  // yet. Cheap — assemble() only reads a small JSONL. 1s cadence is well under
  // the old 2s poll and complements the event-driven fs.watch path.
  const pollTimer = setInterval(() => {
    ensureWatcher()
    scheduleEmit()
  }, 1000)

  // Heartbeat: keep idle proxies from closing the connection.
  const heartbeatTimer = setInterval(() => {
    if (closed) return
    res.write(': ping\n\n')
  }, 25000)

  const cleanup = (): void => {
    if (closed) return
    closed = true
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    clearInterval(pollTimer)
    clearInterval(heartbeatTimer)
    if (watcher) { try { watcher.close() } catch {} watcher = null }
  }

  req.on('close', cleanup)
  res.on('error', cleanup)
})

/**
 * Send a user message. If no session is running for the thread, this
 * transparently spawns one with the message as the first turn. The actual
 * assistant reply streams into the JSONL log; the client picks it up via
 * the next /output poll.
 */
router.post('/threads/:id/messages', (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const row = getThreadOr404(id, res, req)
  if (!row) return

  const body = (req.body || {}) as PostMentorMessageRequest
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!content) {
    res.status(400).json({ error: 'content is required' })
    return
  }

  let fullContent = content
  if (Array.isArray(body.filePaths) && body.filePaths.length > 0) {
    const fileList = body.filePaths
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map(p => `- ${p}`)
      .join('\n')
    if (fileList) fullContent += `\n\nAttached files (accessible on disk):\n${fileList}`
  }

  let sessionId: string | null = null
  try {
    sessionId = sendMentorMessage(id, fullContent)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to send message'
    res.status(502).json({ error: message })
    return
  }

  const updated = getDb().prepare('SELECT * FROM mentor_threads WHERE id = ?').get(id) as ThreadRow
  const response: PostMentorMessageResponse = {
    thread: rowToThread(updated),
    session_id: sessionId,
  }
  res.status(202).json(response)
})

/**
 * Stop a thread's session. The thread record stays; the next message will
 * spawn a fresh session (with prior context lost — the JSONL log is the
 * receipt, not the live state).
 */
router.post('/threads/:id/stop', (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const row = getThreadOr404(id, res, req)
  if (!row) return

  stopMentorSession(id)
  const updated = getDb().prepare('SELECT * FROM mentor_threads WHERE id = ?').get(id) as ThreadRow
  res.json(rowToThread(updated))
})

// POST /api/mentor/threads/:id/upload — upload files for use in the next message
router.post('/threads/:id/upload', upload.array('files', 10), (req: AuthRequest, res: Response) => {
  const id = parseInt(req.params.id as string, 10)
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  if (!getThreadOr404(id, res, req)) return
  const files = (req.files as Express.Multer.File[]) || []
  if (files.length === 0) {
    res.status(400).json({ error: 'No files uploaded' })
    return
  }
  const uploaded = files.map(f => ({
    originalName: f.originalname,
    path: f.path,
    size: f.size,
    mimetype: f.mimetype,
  }))
  console.log(`[mentor-upload] ${files.length} file(s) uploaded for thread ${id}`)
  res.json({ files: uploaded })
})

export default router
