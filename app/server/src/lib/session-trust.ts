/**
 * Session trust plumbing (obj 718944): the two settings flags, and a
 * per-session token so a worker can reach the secrets broker and raise
 * `needs_secret` on ITS OWN card without an agent API key.
 *
 * Flags (settings table):
 *   verified_sender_stamps  — DEFAULT ON since obj 900452 (a '0' row turns it
 *                             off; see `verifiedSenderStampsEnabled`). Sessions
 *                             see `[cc-sender] VERIFIED: …` / `AGENT: …` on every
 *                             chat message, and the prompt carries the
 *                             verified-owner approval rule.
 *   session_secret_access   — default OFF ('1' turns it on). The prompt lists
 *                             the secret NAMES the session
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

/**
 * obj 900452 — `verified_sender_stamps` defaults ON.
 *
 * It shipped default-OFF in #577 with a "turn it on after deploy" note, and the
 * production row was never written — so on 2026-11-09 a worker on #900446 could
 * not tell the owner's own typed follow-up ("run memo23/bbb-scraper now") from a
 * bot relay, obeyed a bot-written FORBIDDEN line in the card instead, and told
 * the owner to edit the card text. The owner-precedence rule is only enforceable
 * when the stamp exists, so the stamp must not depend on a hidden SQL toggle.
 *
 * Env `CC_VERIFIED_SENDER_STAMPS` ('0' / '1') wins; otherwise a settings row of
 * '0' is the only way to turn it off. A missing row, missing table or an
 * uninitialised DB reads as ON. ON is also the SAFER state: it neutralises
 * forged "VERIFIED:" text in every body and strips the signing key from spawns.
 */
export function verifiedSenderStampsEnabled(db?: Database.Database, env: NodeJS.ProcessEnv = process.env): boolean {
  const override = (env.CC_VERIFIED_SENDER_STAMPS || '').trim()
  if (override === '0') return false
  if (override === '1') return true
  try {
    const row = (db ?? getDb()).prepare('SELECT value FROM settings WHERE key = ?').get(VERIFIED_SENDER_FLAG) as
      | { value: string }
      | undefined
    return row?.value !== '0'
  } catch {
    return true
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

// ── Knowledge-base access (obj 900204) ──────────────────────────────────────

/**
 * Settings flag for card-session knowledge-base access.
 *
 * Unlike the two obj-718944 trust flags this one defaults **ON**: a jailed card
 * that cannot read its own workspace's knowledge base is the bug this exists to
 * fix, so an install must not have to opt in to working. Set the row to '0' to
 * turn it back off.
 *
 * It is NOT a secrets grant. It only lets a session present its spawn-minted
 * `CC_SESSION_TOKEN` to `/api/files` and `/api/docs`, scoped to that card's ONE
 * workspace. The secrets broker and the needs-secret route are still gated on
 * `session_secret_access`.
 */
export const SESSION_KB_ACCESS_FLAG = 'session_kb_access'

export function sessionKbAccessEnabled(db?: Database.Database, env: NodeJS.ProcessEnv = process.env): boolean {
  // Env override first, so an install (and a unit test with no DB) can pin the
  // behaviour without a settings row. '0' = off, '1' = on, unset = DB / default.
  const override = (env.CC_SESSION_KB_ACCESS || '').trim()
  if (override === '0') return false
  if (override === '1') return true
  try {
    const row = (db ?? getDb()).prepare('SELECT value FROM settings WHERE key = ?').get(SESSION_KB_ACCESS_FLAG) as
      | { value: string }
      | undefined
    return row?.value !== '0'
  } catch {
    // An uninitialised DB reads as the documented default (ON). The token is
    // still required on every request, so this cannot open the door by itself.
    return true
  }
}
