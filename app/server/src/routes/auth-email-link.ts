/**
 * Email sign-in link (obj 900497) — "Email me a sign-in link" on the login page.
 * Mounted under /api/auth/email-link. Only active when this install has its own
 * transactional email configured (Settings → Email); otherwise every route says
 * so and the login page hides the option.
 *
 *   GET  /            { available }          — is the option shown?
 *   POST /            { email }              — always 202, whether or not the address is known
 *   POST /redeem      { token }              — single-use, 15 min; sets the session cookie
 *
 * Why a POST to redeem and not a GET link: a link scanner that pre-fetches URLs
 * in an inbox would otherwise burn (or use) the link, and the session cookie is
 * SameSite=strict, which a cross-site GET navigation would not carry onward.
 * The email links to the SPA (/login?link=…), which asks the person to click
 * "Sign in" and redeems the token with a same-origin POST.
 *
 * Not offered to an account that still has to change a setup/temp password —
 * that person signs in with the password they were given.
 */
import { Router } from 'express'
import crypto from 'crypto'
import { getDb } from '../db/index.js'
import { generateToken, isSetupExpired } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { isContentOwner } from '../services/content-owners.js'
import { emailConfigured } from '../services/mailer/config.js'
import { sendSignInLink } from '../services/mailer/account-emails.js'
import { isEmailAddress } from '../services/mailer/address.js'
import type { User, UserRole } from '@operationkit/shared'

export const LINK_TTL_MINUTES = 15
const TOKEN_EXPIRES_IN_SEC = 7 * 24 * 60 * 60
const WINDOW_MS = 15 * 60 * 1000
/** POST / — sign-in link requests per client IP per window (email-bombing / enumeration). */
export const MAX_PER_IP = 5
/** POST / — links actually SENT to one address per window, whoever asks (inbox flooding). */
export const MAX_PER_EMAIL = 3
/** POST /redeem — token guesses per client IP per window. */
export const MAX_REDEEM_PER_IP = 20
/** Sweep expired keys once the limiter map gets this big, so a flood of distinct
 *  IPs/addresses cannot grow it without bound. */
const SWEEP_AT = 10_000

const router = Router()

// In-process sliding-window limiter (same shape as middleware/login-rate-limit
// and services/file-access rateLimit). Single Node process per install, so an
// in-memory map is the whole picture.
const hits = new Map<string, number[]>()
function sweep(now: number): void {
  for (const [k, list] of hits) if (!list.some(t => now - t < WINDOW_MS)) hits.delete(k)
}
function overLimit(key: string, max: number, now = Date.now()): boolean {
  if (hits.size >= SWEEP_AT) sweep(now)
  const list = (hits.get(key) ?? []).filter(t => now - t < WINDOW_MS)
  if (list.length >= max) { hits.set(key, list); return true }
  list.push(now)
  hits.set(key, list)
  return false
}
export function resetEmailLinkRateLimit(): void { hits.clear() }

export function hashLinkToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

router.get('/', (_req, res) => {
  res.json({ available: emailConfigured() })
})

// Rate limited in-handler: MAX_PER_IP per client IP (429 + Retry-After) and
// MAX_PER_EMAIL sends per address (silent, still 202 so it cannot be used to
// enumerate accounts). CodeQL only recognises npm limiter packages, hence:
// codeql[js/missing-rate-limiting] -- per-IP + per-email limiter via overLimit() above; covered by auth-email-link.test.ts
router.post('/', (req, res) => {
  if (!emailConfigured()) {
    res.status(409).json({ error: 'Email sign-in is not set up on this site. Sign in with your password.', code: 'email_not_configured' })
    return
  }
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  if (overLimit(`ip:${ip}`, MAX_PER_IP)) {
    res.setHeader('Retry-After', String(WINDOW_MS / 1000))
    res.status(429).json({ error: 'Too many requests. Try again later.' })
    return
  }
  const raw = (req.body || {}).email
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!isEmailAddress(email)) {
    res.status(400).json({ error: 'Enter your email address' })
    return
  }
  // Same answer whether or not the address belongs to someone, and the send
  // runs after the response so timing does not tell either.
  res.status(202).json({ ok: true })

  if (overLimit(`email:${email}`, MAX_PER_EMAIL)) return
  const db = getDb()
  const user = db
    .prepare('SELECT id, username, must_change_password, password_setup_expires_at FROM users WHERE lower(trim(email)) = ?')
    .get(email) as { id: number; username: string; must_change_password: number; password_setup_expires_at: string | null } | undefined
  if (!user || Number(user.must_change_password) > 0 || isSetupExpired(user.password_setup_expires_at)) return
  const token = crypto.randomBytes(32).toString('base64url')
  db.prepare(`INSERT INTO email_login_tokens (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', ?))`)
    .run(user.id, hashLinkToken(token), `+${LINK_TTL_MINUTES} minutes`)
  void sendSignInLink({ to: email, username: user.username, token, minutes: LINK_TTL_MINUTES }).catch(() => { /* logged by mailer */ })
})

// Rate limited in-handler: MAX_REDEEM_PER_IP token attempts per client IP.
// codeql[js/missing-rate-limiting] -- per-IP limiter via overLimit() above; covered by auth-email-link.test.ts
router.post('/redeem', (req, res) => {
  const raw = (req.body || {}).token
  const token = typeof raw === 'string' ? raw.trim() : ''
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  if (overLimit(`redeem:${ip}`, MAX_REDEEM_PER_IP)) {
    res.setHeader('Retry-After', String(WINDOW_MS / 1000))
    res.status(429).json({ error: 'Too many attempts. Try again later.' })
    return
  }
  const fail = () => res.status(401).json({ error: 'This sign-in link is invalid, used or expired. Ask for a new one.', code: 'link_invalid' })
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) { fail(); return }
  const db = getDb()
  // Atomic single-use claim: only the first redeem flips used_at.
  const claimed = db.prepare(
    `UPDATE email_login_tokens SET used_at = datetime('now')
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')
      RETURNING user_id`,
  ).get(hashLinkToken(token)) as { user_id: number } | undefined
  if (!claimed) { fail(); return }
  const row = db
    .prepare('SELECT id, username, role, created_at, must_change_password, password_setup_expires_at FROM users WHERE id = ?')
    .get(claimed.user_id) as { id: number; username: string; role: UserRole; created_at: string; must_change_password: number; password_setup_expires_at: string | null } | undefined
  if (!row || Number(row.must_change_password) > 0 || isSetupExpired(row.password_setup_expires_at)) { fail(); return }
  // Any other outstanding links for this person are now pointless.
  db.prepare('UPDATE email_login_tokens SET used_at = datetime(\'now\') WHERE user_id = ? AND used_at IS NULL').run(row.id)

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

export default router
