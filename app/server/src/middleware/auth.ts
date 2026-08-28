import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import type { User } from '@command-center/shared'
import { isApiKey, userFromApiKey } from '../lib/api-keys.js'

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
}

export function generateToken(user: User): string {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, getJwtSecret(), {
    expiresIn: TOKEN_EXPIRY,
  })
}

export function verifyToken(token: string): User | null {
  try {
    const payload = jwt.verify(token, getJwtSecret()) as User & { iat: number; exp: number }
    return { id: payload.id, username: payload.username, role: payload.role, created_at: '' }
  } catch {
    return null
  }
}

function extractToken(req: AuthRequest): string | undefined {
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
    const apiUser = userFromApiKey(token)
    if (!apiUser) {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }
    req.user = apiUser
    next()
    return
  }

  const user = verifyToken(token)
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' })
    return
  }

  req.user = user
  next()
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' })
    return
  }
  next()
}
