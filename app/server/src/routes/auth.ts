import { Router, type Response } from 'express'
import bcrypt from 'bcrypt'
import { getDb } from '../db/index.js'
import { generateToken, isSetupExpired, requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getApiKeySummary, issueApiKey, revokeApiKey } from '../lib/api-keys.js'
import { createAgentKey, listAgentKeys, revokeAgentKey } from '../lib/agent-keys.js'
import { AGENT_SCOPES, type ApiKeyIdentity } from '@operationkit/shared'
import {
  inspectLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
} from '../middleware/login-rate-limit.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { isContentOwner } from '../services/content-owners.js'
import type { LoginRequest, TokenResponse, User } from '@operationkit/shared'

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
    .prepare('SELECT id, username, password_hash, role, created_at, must_change_password, password_setup_expires_at FROM users WHERE username = ?')
    .get(username) as (Omit<User, 'must_change_password'> & { password_hash: string; must_change_password: number; password_setup_expires_at: string | null }) | undefined

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

  // obj 719935: a one-time setup password stops working at its expiry, even if
  // nobody used it. The installer re-issues one: install/admin-password.sh.
  const mustChange = Number(row.must_change_password) > 0
  if (mustChange && isSetupExpired(row.password_setup_expires_at)) {
    recordLoginFailure(ip, username)
    return { ok: false, status: 401, error: 'This setup password has expired. Ask your installer for a new one.' }
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
      // Must match GET /me: the client uses the login response as the user until the next reload,
      // so omitting this hid Content from owners right after sign-in (obj 712749).
      has_content: isContentOwner(row.id),
      ...(mustChange ? { must_change_password: true } : {}),
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

  if (result.user.must_change_password) {
    res.status(403).json({ error: 'Sign in through the website and choose a new password first.', code: 'password_change_required' })
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

// POST /api/auth/change-password { current_password, new_password } (obj 719935).
// The only way out of a one-time setup password; also usable any time after.
// Re-issues the session cookie so the `pwc` restriction drops immediately.
router.post('/change-password', requireAuth, async (req: AuthRequest, res) => {
  if (req.authVia !== 'session') {
    res.status(403).json({ error: 'Change your password from the website.' })
    return
  }
  const { current_password, new_password } = (req.body || {}) as { current_password?: unknown; new_password?: unknown }
  const db = getDb()
  const row = db
    .prepare('SELECT id, username, password_hash, role, created_at FROM users WHERE id = ?')
    .get(req.user!.id) as (User & { password_hash: string }) | undefined
  if (!row) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  const ip = clientIp(req)
  const limited = inspectLoginRateLimit(ip, row.username)
  if (!limited.ok) {
    res.setHeader('Retry-After', String(limited.retryAfterSec))
    res.status(429).json({ error: 'Too many attempts. Try again later.' })
    return
  }
  if (typeof current_password !== 'string' || !(await bcrypt.compare(current_password, row.password_hash))) {
    recordLoginFailure(ip, row.username)
    res.status(400).json({ error: 'Your current password is not right.', field: 'current_password' })
    return
  }
  const problem = newPasswordProblem(new_password, row.username)
  if (problem) {
    res.status(400).json({ error: problem, field: 'new_password' })
    return
  }
  if (await bcrypt.compare(new_password as string, row.password_hash)) {
    res.status(400).json({ error: 'Pick a password different from the current one.', field: 'new_password' })
    return
  }
  const hash = await bcrypt.hash(new_password as string, 12)
  db.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 0, password_setup_expires_at = NULL WHERE id = ?',
  ).run(hash, row.id)
  clearLoginFailures(ip, row.username)

  const user: User = {
    id: row.id, username: row.username, role: row.role, created_at: row.created_at,
    workspaces: getUserWorkspaces(row.id), has_content: isContentOwner(row.id),
  }
  res.cookie('token', generateToken(user), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: TOKEN_EXPIRES_IN_SEC * 1000,
  })
  res.json({ user })
})

router.post('/logout', (_req, res) => {
  res.clearCookie('token', { path: '/' })
  res.json({ ok: true })
})

export const MIN_PASSWORD_LENGTH = 12

/** Plain-language reason a new password is refused, or null when it is acceptable. */
export function newPasswordProblem(newPassword: unknown, username: string): string | null {
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (newPassword.length > 200) return 'Use at most 200 characters.'
  if (newPassword.toLowerCase().includes(username.toLowerCase())) return 'The new password must not contain your username.'
  if (/^(.)\1+$/.test(newPassword)) return 'The new password cannot be one repeated character.'
  return null
}

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

// Settings → You agent keys (obj 714090): many named, scoped keys per user so
// each Grok Bot is its own least-privilege principal. Managing keys needs a
// human session (cookie/JWT) or the legacy full key — an agent key can never
// mint or revoke keys (the agent-key guard also blocks /api/auth/* for them).
function rejectAgentKey(req: AuthRequest, res: Response): boolean {
  if (!req.agentKey) return false
  res.status(403).json({ error: 'Agent keys cannot manage API keys', missing_scope: null })
  return true
}

router.get('/agent-keys', requireAuth, (req: AuthRequest, res) => {
  if (rejectAgentKey(req, res)) return
  res.json({ keys: listAgentKeys(req.user!.id), scopes: AGENT_SCOPES })
})

router.post('/agent-keys', requireAuth, (req: AuthRequest, res) => {
  if (rejectAgentKey(req, res)) return
  const result = createAgentKey(req.user!, req.body ?? {})
  if (!result.ok) {
    res.status(result.status).json({ error: result.error })
    return
  }
  res.status(201).json(result.key)
})

router.delete('/agent-keys/:id', requireAuth, (req: AuthRequest, res) => {
  if (rejectAgentKey(req, res)) return
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0 || !revokeAgentKey(req.user!.id, id)) {
    res.status(404).json({ error: 'Agent key not found' })
    return
  }
  res.json({ ok: true })
})

router.get('/me', requireAuth, (req: AuthRequest, res) => {
  const db = getDb()
  const user = db
    .prepare('SELECT id, username, role, created_at, must_change_password FROM users WHERE id = ?')
    .get(req.user!.id) as (User & { must_change_password?: number | boolean }) | undefined

  if (!user) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  // Report the session's state, not just the row's: a pre-change cookie still
  // carries `pwc` and is still gated, so the client must keep showing the form.
  if (Number(user.must_change_password) > 0 || req.user!.must_change_password) user.must_change_password = true
  else delete user.must_change_password

  user.workspaces = getUserWorkspaces(user.id)
  // Content surface access (obj 710856) — a `content_owners` row, not a role.
  user.has_content = isContentOwner(user.id)
  // obj 714090: when called with an API key, say WHICH key and what it may do.
  // Absent for browser sessions / JWTs, so the UI payload is unchanged.
  let api_key: ApiKeyIdentity | undefined
  if (req.agentKey) {
    api_key = { kind: 'agent', ...req.agentKey }
  } else if (req.authVia === 'legacy_api_key') {
    api_key = { kind: 'legacy', id: null, label: 'Legacy API key (full access)', scopes: [...AGENT_SCOPES], workspaces: null }
  }
  res.json(api_key ? { ...user, api_key } : user)
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
