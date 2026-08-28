import { Router } from 'express'
import bcrypt from 'bcrypt'
import { getDb } from '../db/index.js'
import { generateToken, requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getApiKeySummary, issueApiKey, revokeApiKey } from '../lib/api-keys.js'
import {
  inspectLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
} from '../middleware/login-rate-limit.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import type { LoginRequest, TokenResponse, User } from '@command-center/shared'

const TOKEN_EXPIRES_IN_SEC = 7 * 24 * 60 * 60

const router = Router()

// Real bcrypt hash so a missing-user 401 spends the same compare time as a
// wrong-password 401. Value is never a valid login — we only compare against
// it when the username does not exist.
const DUMMY_HASH = bcrypt.hashSync('timing-dummy', 10)

function clientIp(req: { ip?: string; socket: { remoteAddress?: string } }): string {
  return req.ip || req.socket.remoteAddress || 'unknown'
}

async function authenticatePassword(
  req: { ip?: string; socket: { remoteAddress?: string } },
  username: string,
  password: string,
): Promise<{ ok: true; user: User } | { ok: false; status: number; error: string; retryAfterSec?: number }> {
  if (!username || !password) {
    return { ok: false, status: 400, error: 'Username and password required' }
  }

  const ip = clientIp(req)
  const limited = inspectLoginRateLimit(ip, username)
  if (!limited.ok) {
    return { ok: false, status: 429, error: 'Too many login attempts. Try again later.', retryAfterSec: limited.retryAfterSec }
  }

  const db = getDb()
  const row = db
    .prepare('SELECT id, username, password_hash, role, created_at FROM users WHERE username = ?')
    .get(username) as (User & { password_hash: string }) | undefined

  if (!row) {
    await bcrypt.compare(password, DUMMY_HASH)
    recordLoginFailure(ip, username)
    return { ok: false, status: 401, error: 'Invalid credentials' }
  }

  const valid = await bcrypt.compare(password, row.password_hash)
  if (!valid) {
    recordLoginFailure(ip, username)
    return { ok: false, status: 401, error: 'Invalid credentials' }
  }

  clearLoginFailures(ip, username)
  return {
    ok: true,
    user: {
      id: row.id,
      username: row.username,
      role: row.role,
      created_at: row.created_at,
      workspaces: getUserWorkspaces(row.id),
    },
  }
}

router.post('/login', async (req, res) => {
  const { username, password } = req.body as LoginRequest
  const result = await authenticatePassword(req, username, password)
  if (!result.ok) {
    if (result.retryAfterSec != null) res.setHeader('Retry-After', String(result.retryAfterSec))
    res.status(result.status).json({ error: result.error })
    return
  }

  const token = generateToken(result.user)
  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: TOKEN_EXPIRES_IN_SEC * 1000,
  })

  res.json({ user: result.user })
})

// POST /api/auth/token — same credentials as /login, but returns a Bearer JWT
// in the JSON body and does NOT set a cookie. This is the agent/script path:
// Claude, Grok, ChatGPT Actions, cron, etc. cannot read an httpOnly cookie.
router.post('/token', async (req, res) => {
  const { username, password } = req.body as LoginRequest
  const result = await authenticatePassword(req, username, password)
  if (!result.ok) {
    if (result.retryAfterSec != null) res.setHeader('Retry-After', String(result.retryAfterSec))
    res.status(result.status).json({ error: result.error })
    return
  }

  const token = generateToken(result.user)
  const body: TokenResponse = {
    token,
    token_type: 'Bearer',
    expires_in: TOKEN_EXPIRES_IN_SEC,
    user: result.user,
  }
  res.json(body)
})

router.post('/logout', (_req, res) => {
  res.clearCookie('token', { path: '/' })
  res.json({ ok: true })
})

// Settings → You API key. Cookie/JWT required to mint. The plaintext is only
// in the POST response. Agents send it as Authorization: Bearer cc_live_…
router.get('/api-key', requireAuth, (req: AuthRequest, res) => {
  res.json(getApiKeySummary(req.user!.id))
})

router.post('/api-key', requireAuth, (req: AuthRequest, res) => {
  const issued = issueApiKey(req.user!.id)
  res.status(201).json(issued)
})

router.delete('/api-key', requireAuth, (req: AuthRequest, res) => {
  revokeApiKey(req.user!.id)
  res.json({ ok: true })
})

router.get('/me', requireAuth, (req: AuthRequest, res) => {
  const db = getDb()
  const user = db
    .prepare('SELECT id, username, role, created_at FROM users WHERE id = ?')
    .get(req.user!.id) as User | undefined

  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  user.workspaces = getUserWorkspaces(user.id)
  res.json(user)
})

// GET /api/auth/users?workspace=<slug> — list users the current user can
// assign objectives to. When `workspace` is given, the list is constrained to
// members of that workspace (admins still see admins too); otherwise it's the
// union over the caller's workspace memberships (members) or all users (admins).
router.get('/users', requireAuth, (req: AuthRequest, res) => {
  const db = getDb()
  const user = req.user!
  const workspace = typeof req.query.workspace === 'string' ? req.query.workspace.trim() : ''

  if (workspace) {
    // Members can only scope to a workspace they belong to. Admins can scope to any.
    if (user.role !== 'admin') {
      const myWs = getUserWorkspaces(user.id).map(w => w.workspace)
      if (!myWs.includes(workspace)) {
        res.json([])
        return
      }
    }
    // Workspace members + global admins. Global admins are surfaced so they can
    // be assigned to any objective regardless of workspace membership.
    const users = db.prepare(
      `SELECT DISTINCT u.id, u.username, u.role FROM users u
       LEFT JOIN user_workspaces uw ON uw.user_id = u.id AND uw.workspace = ?
       WHERE uw.user_id IS NOT NULL OR u.role = 'admin'
       ORDER BY u.username`
    ).all(workspace)
    res.json(users)
    return
  }

  if (user.role === 'admin') {
    const users = db.prepare('SELECT id, username, role FROM users ORDER BY username').all()
    res.json(users)
    return
  }

  // Members: find users who share a workspace
  const myWorkspaces = getUserWorkspaces(user.id).map(w => w.workspace)
  if (myWorkspaces.length === 0) {
    res.json([])
    return
  }
  const placeholders = myWorkspaces.map(() => '?').join(',')
  const users = db.prepare(
    `SELECT DISTINCT u.id, u.username, u.role FROM users u
     JOIN user_workspaces uw ON uw.user_id = u.id
     WHERE uw.workspace IN (${placeholders})
     ORDER BY u.username`
  ).all(...myWorkspaces)
  res.json(users)
})

export default router
