import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import type { User } from '@operationkit/shared'
import { isApiKey, userFromApiKey } from '../lib/api-keys.js'
import { resolveAgentKey, touchAgentKey, type AgentKeyPrincipal } from '../lib/agent-keys.js'
import { getDb } from '../db/index.js'

const TOKEN_EXPIRY = '7d'
const MIN_SECRET_LEN = 16
const PLACEHOLDERS = new Set([
  'command-center-dev-secret-change-in-prod',
  'change-me-to-a-random-string',
  'change-me',
  'dev-secret',
])

/**
 * Session-signing secret. Never a git-committed fallback — a known default is
 * how self-hosted apps get their cookies forged. Tests set JWT_SECRET in
 * vitest.setup.ts; production compose maps CC_JWT_SECRET → JWT_SECRET.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < MIN_SECRET_LEN) {
    throw new Error(
      'JWT_SECRET is required (min 16 characters). Generate with: openssl rand -base64 48'
    )
  }
  return secret
}

/** Fail boot if the secret is missing, short, or a known placeholder. */
export function assertJwtSecret(): void {
  const secret = process.env.JWT_SECRET
  if (!secret || secret.length < MIN_SECRET_LEN || PLACEHOLDERS.has(secret)) {
    throw new Error(
      'JWT_SECRET is required in production (min 16 characters, not a placeholder). ' +
        'Generate with: openssl rand -base64 48 — then set CC_JWT_SECRET for compose.'
    )
  }
}

export interface AuthRequest extends Request {
  user?: User
  /** Set when the request authenticated with a named agent API key (obj 714090). */
  agentKey?: AgentKeyPrincipal
  /** How the caller authenticated. Absent before requireAuth / the agent-key guard ran. */
  authVia?: 'session' | 'legacy_api_key' | 'agent_api_key'
}

export function generateToken(user: User): string {
  // `pwc` (obj 719935): the holder signed in with a one-time setup password and
  // may only reach PASSWORD_CHANGE_ALLOWED until they pick a real one.
  const claims = { id: user.id, username: user.username, role: user.role, ...(user.must_change_password ? { pwc: 1 } : {}) }
  return jwt.sign(claims, getJwtSecret(), {
    expiresIn: TOKEN_EXPIRY,
  })
}

export function verifyToken(token: string): User | null {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as User & { iat: number; exp: number; pwc?: number }
    return {
      id: payload.id, username: payload.username, role: payload.role, created_at: '',
      ...(payload.pwc ? { must_change_password: true } : {}),
    }
  } catch {
    return null
  }
}

/*
 * Forced password change (obj 719935) — why a JWT claim and not a per-request
 * DB lookup:
 *
 * A user holding a one-time setup password is minted a token carrying `pwc: 1`
 * at login. `requireAuth` restricts any `pwc` token to PASSWORD_CHANGE_ALLOWED,
 * so the 99.9% path (normal users, normal tokens) pays nothing extra. Only a
 * `pwc` token — rare, lives for minutes during first sign-in — costs one PK
 * lookup, and that lookup makes it fail CLOSED: once the password is changed
 * (flag cleared) or the setup window has expired, the stale `pwc` token is a 401,
 * not an unrestricted session. /change-password re-issues a fresh cookie without
 * the claim. So a leaked setup password cannot outlive its replacement.
 *
 * API keys (legacy + agent) are DB-backed already, so they check the column
 * directly — a must-change user can never authenticate through a key.
 *
 * Residual: a token minted BEFORE an operator re-arms must_change_password on an
 * existing account (set-admin-password --setup) carries no claim and stays valid
 * until it expires. That holder already proved the previous password; rotate
 * JWT_SECRET if that must be cut off immediately.
 */

interface PasswordState { must_change_password: number; password_setup_expires_at: string | null }

function readPasswordState(userId: number): PasswordState | undefined {
  return getDb()
    .prepare('SELECT must_change_password, password_setup_expires_at FROM users WHERE id = ?')
    .get(userId) as PasswordState | undefined
}

/** True when the stored setup password's window has closed. */
export function isSetupExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false
  const t = Date.parse(expiresAt)
  return Number.isFinite(t) && t <= now
}

/** DB truth for API-key callers (no JWT claim to read). */
export function userMustChangePassword(userId: number): boolean {
  const row = readPasswordState(userId)
  return !!row && Number(row.must_change_password) > 0
}

/** The only routes a `pwc` session may call. Everything else is 403. */
export const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/me', '/api/auth/change-password', '/api/auth/logout'])

export function isPasswordChangeBlocked(user: User, originalUrl: string): boolean {
  if (!user.must_change_password) return false
  const pathOnly = originalUrl.split('?')[0].replace(/\/+$/, '')
  return !PASSWORD_CHANGE_ALLOWED.has(pathOnly)
}

export function extractToken(req: AuthRequest): string | undefined {
  const cookieToken = req.cookies?.token
  if (cookieToken) return cookieToken
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  return undefined
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = extractToken(req)
  if (!token) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  if (isApiKey(token)) {
    // Legacy single per-user key first — unchanged, full access (Mike's live
    // Grok Bots use it). Then the named/scoped agent keys (obj 714090).
    const apiUser = userFromApiKey(token)
    if (apiUser) {
      if (userMustChangePassword(apiUser.id)) {
        res.status(403).json({ error: 'Password change required', code: 'password_change_required' })
        return
      }
      req.user = apiUser
      req.authVia = 'legacy_api_key'
      next()
      return
    }
    const agent = resolveAgentKey(token)
    if (agent.status === 'revoked') {
      res.status(401).json({ error: 'API key revoked' })
      return
    }
    if (agent.status !== 'ok') {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }
    if (userMustChangePassword(agent.user.id)) {
      res.status(403).json({ error: 'Password change required', code: 'password_change_required' })
      return
    }
    req.user = agent.user
    req.agentKey = agent.key
    req.authVia = 'agent_api_key'
    touchAgentKey(agent.key.id)
    next()
    return
  }

  const user = verifyToken(token)
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  if (user.must_change_password) {
    // Fail closed on a stale setup-password token (see the comment above).
    const state = readPasswordState(user.id)
    if (!state || Number(state.must_change_password) === 0 || isSetupExpired(state.password_setup_expires_at)) {
      res.clearCookie('token', { path: '/' })
      res.status(401).json({ error: 'Session expired. Please sign in again.' })
      return
    }
    if (isPasswordChangeBlocked(user, req.originalUrl || req.url)) {
      res.status(403).json({ error: 'Password change required', code: 'password_change_required' })
      return
    }
  }

  req.user = user
  req.authVia = 'session'
  next()
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  // Defense in depth (obj 714090): an admin's scoped agent key never inherits
  // admin powers, even if a route slipped past the agent-key guard.
  if (req.agentKey) {
    res.status(403).json({ error: 'Agent keys cannot call admin endpoints', missing_scope: null })
    return
  }
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' })
    return
  }
  next()
}
