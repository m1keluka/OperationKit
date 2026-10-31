/**
 * Session trust plumbing (obj 718944): the two settings flags, and a
 * per-session token so a worker can reach the secrets broker and raise
 * `needs_secret` on ITS OWN card without an agent API key.
 *
 * Flags (settings table, both default OFF — '1' turns them on):
 *   verified_sender_stamps  — sessions see `[cc-sender] VERIFIED: …` / `AGENT: …`
 *                             on every chat message, and the prompt carries the
 *                             verified-owner approval rule.
 *   session_secret_access   — the prompt lists the secret NAMES the session
 *                             has, spawns carry CC_SESSION_TOKEN, and the
 *                             needs-secret / broker routes accept it.
 *
 * Token: `ccs_<b64url(payload)>.<b64url(hmac)>`, payload = {o: objectiveId,
 * w: workspace, u: actingUserId, e: expiry}. HMAC key is derived from
 * JWT_SECRET under its own label, so a session token can never be replayed as
 * a login JWT or vice versa. Whenever either flag is on the spawn env drops
 * JWT_SECRET (see `stripServerSigningSecrets`) — otherwise any session could
 * mint an owner cookie and forge the VERIFIED stamp.
 */
import crypto from 'crypto'
import type Database from 'better-sqlite3'
import { getJwtSecret } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

export const VERIFIED_SENDER_FLAG = 'verified_sender_stamps'
export const SESSION_SECRET_ACCESS_FLAG = 'session_secret_access'

/** Never throws: an uninitialised DB or missing table reads as OFF. */
export function readSettingFlag(key: string, db?: Database.Database): boolean {
  try {
    const row = (db ?? getDb()).prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value === '1'
  } catch {
    return false
  }
}

/** Env keys a session must never hold while a trust flag is on. */
export const SERVER_SIGNING_SECRETS = ['JWT_SECRET', 'CC_JWT_SECRET'] as const

export function stripServerSigningSecrets(env: Record<string, string | undefined>): void {
  for (const k of SERVER_SIGNING_SECRETS) delete env[k]
}

export const SESSION_TOKEN_PREFIX = 'ccs_'
export const SESSION_TOKEN_HEADER = 'x-cc-session-token'
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface SessionTokenClaims {
  objectiveId: number
  workspace: string
  actingUserId: number | null
}

function key(): Buffer {
  return crypto.createHmac('sha256', getJwtSecret()).update('cc-session-token-v1').digest()
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', key()).update(payload).digest('base64url')
}

export function mintSessionToken(claims: SessionTokenClaims, now = Date.now(), ttlMs = DEFAULT_TTL_MS): string {
  const payload = Buffer.from(
    JSON.stringify({ o: claims.objectiveId, w: claims.workspace, u: claims.actingUserId, e: now + ttlMs }),
  ).toString('base64url')
  return `${SESSION_TOKEN_PREFIX}${payload}.${sign(payload)}`
}

export function verifySessionToken(token: string | undefined | null, now = Date.now()): SessionTokenClaims | null {
  if (!token || !token.startsWith(SESSION_TOKEN_PREFIX)) return null
  const body = token.slice(SESSION_TOKEN_PREFIX.length)
  const dot = body.indexOf('.')
  if (dot <= 0) return null
  const payload = body.slice(0, dot)
  const mac = Buffer.from(body.slice(dot + 1))
  const expected = Buffer.from(sign(payload))
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { o: unknown; w: unknown; u: unknown; e: unknown }
    if (typeof p.o !== 'number' || typeof p.w !== 'string' || typeof p.e !== 'number' || p.e < now) return null
    return { objectiveId: p.o, workspace: p.w, actingUserId: typeof p.u === 'number' ? p.u : null }
  } catch {
    return null
  }
}

/** Token from `X-CC-Session-Token`, or `Authorization: Bearer ccs_…`. */
export function sessionTokenFromHeaders(headers: Record<string, string | string[] | undefined>): string | null {
  const h = headers[SESSION_TOKEN_HEADER]
  if (typeof h === 'string' && h.startsWith(SESSION_TOKEN_PREFIX)) return h.trim()
  const auth = headers.authorization
  if (typeof auth === 'string' && auth.startsWith(`Bearer ${SESSION_TOKEN_PREFIX}`)) return auth.slice(7).trim()
  return null
}
