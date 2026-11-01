import { Router } from 'express'
import bcrypt from 'bcrypt'
import { getDb } from '../db/index.js'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import type {
  CreateUserRequest,
  ResetPasswordRequest,
  User,
  UserRole,
  WorkspaceMembership,
} from '@operationkit/shared'

const router = Router()
router.use(requireAuth, requireAdmin)

const BCRYPT_ROUNDS = 10

interface UserRow {
  id: number
  username: string
  role: UserRole
  email: string | null
  created_at: string
}

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/

/**
 * Normalise a sign-in email (obj 720332). Behind Cloudflare Access the verified
 * Access email picks the user, so it must be unique (case-insensitive).
 * Returns { email } (null = clear) or { error }.
 */
function parseEmail(raw: unknown, selfId: number | null): { email: string | null } | { error: string; status: number } {
  if (raw === null || raw === '') return { email: null }
  if (typeof raw !== 'string' || !EMAIL.test(raw.trim())) return { error: 'email must look like name@example.com', status: 400 }
  const email = raw.trim().toLowerCase()
  const holder = getDb().prepare('SELECT id FROM users WHERE lower(trim(email)) = ? AND id != ?').get(email, selfId ?? -1)
  if (holder) return { error: 'Another user already has that email', status: 409 }
  return { email }
}

// GET /api/admin/users — list every user with their workspace memberships
router.get('/', (_req: AuthRequest, res) => {
  const db = getDb()
  const users = db
    .prepare('SELECT id, username, role, email, created_at FROM users ORDER BY username')
    .all() as UserRow[]

  const memberships = db
    .prepare(
      `SELECT user_id, workspace, role, can_use_assistant, objective_visibility
       FROM user_workspaces`
    )
    .all() as Array<{
      user_id: number
      workspace: string
      role: UserRole
      can_use_assistant: number
      objective_visibility: string
    }>

  const byUser = new Map<number, WorkspaceMembership[]>()
  for (const u of users) byUser.set(u.id, [])
  for (const m of memberships) {
    const list = byUser.get(m.user_id)
    if (!list) continue
    const user = users.find(u => u.id === m.user_id)!
    list.push({
      user_id: m.user_id,
      username: user.username,
      workspace: m.workspace,
      role: m.role,
      can_use_assistant: !!m.can_use_assistant,
      objective_visibility: m.objective_visibility === 'all' ? 'all' : 'own',
    })
  }

  res.json(
    users.map(u => ({
      ...u,
      workspaces: byUser.get(u.id) ?? [],
    }))
  )
})

// POST /api/admin/users  body: { username, password, role?, email? }
router.post('/', async (req: AuthRequest, res) => {
  const { username, password, role = 'member', email: rawEmail } = req.body as CreateUserRequest

  if (!username?.trim() || typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'username and password (min 8 chars) required' })
    return
  }
  if (role !== 'admin' && role !== 'member') {
    res.status(400).json({ error: "role must be 'admin' or 'member'" })
    return
  }

  const db = getDb()
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim())
  if (existing) {
    res.status(409).json({ error: 'Username already taken' })
    return
  }

  const parsed = rawEmail === undefined ? { email: null } : parseEmail(rawEmail, null)
  if ('error' in parsed) {
    res.status(parsed.status).json({ error: parsed.error })
    return
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  const result = db
    .prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)')
    .run(username.trim(), hash, role, parsed.email)

  const user = db
    .prepare('SELECT id, username, role, email, created_at FROM users WHERE id = ?')
    .get(result.lastInsertRowid) as User

  res.status(201).json(user)
})

// POST /api/admin/users/:id/reset-password  body: { password }
router.post('/:id/reset-password', async (req: AuthRequest, res) => {
  const idParam = req.params.id
  const userId = parseInt(typeof idParam === 'string' ? idParam : '', 10)
  if (Number.isNaN(userId)) {
    res.status(400).json({ error: 'Invalid user_id' })
    return
  }
  const { password } = req.body as ResetPasswordRequest
  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'password (min 8 chars) required' })
    return
  }

  const db = getDb()
  const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(userId)
  if (!exists) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId)
  res.json({ ok: true })
})

// DELETE /api/admin/users/:id — kill switch; cascades to user_workspaces.
// Refuses to delete the caller's own account.
router.delete('/:id', (req: AuthRequest, res) => {
  const idParam = req.params.id
  const userId = parseInt(typeof idParam === 'string' ? idParam : '', 10)
  if (Number.isNaN(userId)) {
    res.status(400).json({ error: 'Invalid user_id' })
    return
  }
  if (req.user!.id === userId) {
    res.status(400).json({ error: 'Cannot delete your own account' })
    return
  }
  const db = getDb()
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  if (result.changes === 0) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  res.json({ ok: true })
})

// PATCH /api/admin/users/:id  body: { role?, email? }  (email null/'' clears it)
router.patch('/:id', (req: AuthRequest, res) => {
  const idParam = req.params.id
  const userId = parseInt(typeof idParam === 'string' ? idParam : '', 10)
  if (Number.isNaN(userId)) {
    res.status(400).json({ error: 'Invalid user_id' })
    return
  }
  const body = (req.body || {}) as { role?: UserRole; email?: string | null }
  const { role } = body
  const hasEmail = Object.prototype.hasOwnProperty.call(body, 'email')
  if (role === undefined && !hasEmail) {
    res.status(400).json({ error: 'Nothing to change: send role and/or email' })
    return
  }
  if (role !== undefined && role !== 'admin' && role !== 'member') {
    res.status(400).json({ error: "role must be 'admin' or 'member'" })
    return
  }
  const db = getDb()
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  if (hasEmail) {
    const parsed = parseEmail(body.email, userId)
    if ('error' in parsed) {
      res.status(parsed.status).json({ error: parsed.error })
      return
    }
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(parsed.email, userId)
  }
  if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId)
  const user = db
    .prepare('SELECT id, username, role, email, created_at FROM users WHERE id = ?')
    .get(userId) as User
  res.json(user)
})

export default router
