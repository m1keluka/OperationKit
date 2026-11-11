/**
 * Claude seat sign-in from the browser (obj 720330): the same OAuth + PKCE flow
 * `claude setup-token` runs, so adding a Claude seat needs no terminal.
 *
 *   1. startClaudeLogin()  → a "Sign in with Claude" link. The PKCE verifier and
 *      the state are held HERE, server-side, in memory, for LOGIN_TTL_MS.
 *   2. The operator signs in on claude.ai and is shown an "Authentication code"
 *      (`code#state`, "Paste this into Claude Code").
 *   3. finishClaudeLogin() checks the state, exchanges code + verifier for the
 *      long-lived subscription token (scope user:inference, 1 year — exactly what
 *      setup-token asks for) and hands it back to the caller to store as a seat.
 *
 * The verifier never leaves this module: it is not returned, not logged and not
 * persisted, and it is dropped on success, on expiry and after too many tries.
 * Subscription only — a response that is not an OAuth subscription token
 * (sk-ant-oat…) is refused; there is no API-key fallback.
 *
 * Constants are the ones the official Claude Code CLI ships (2.1.x).
 */
import crypto from 'crypto'

export const CLAUDE_OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  /** setup-token asks for inference only … */
  scope: 'user:inference',
  /** … and a one-year token. */
  expiresInSeconds: 365 * 24 * 60 * 60,
} as const

export const LOGIN_TTL_MS = 10 * 60 * 1000
export const MAX_ATTEMPTS = 5
const MAX_PENDING = 20
const EXCHANGE_TIMEOUT_MS = 30_000

interface PendingLogin {
  state: string
  verifier: string
  expiresAt: number
  attempts: number
  actorUserId: number | null
}

const pending = new Map<string, PendingLogin>()

const b64url = (buf: Buffer) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** PKCE S256: base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return b64url(crypto.createHash('sha256').update(verifier).digest())
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const u = new URL(CLAUDE_OAUTH.authorizeUrl)
  u.searchParams.append('code', 'true')
  u.searchParams.append('client_id', CLAUDE_OAUTH.clientId)
  u.searchParams.append('response_type', 'code')
  u.searchParams.append('redirect_uri', CLAUDE_OAUTH.redirectUri)
  u.searchParams.append('scope', CLAUDE_OAUTH.scope)
  u.searchParams.append('code_challenge', challenge)
  u.searchParams.append('code_challenge_method', 'S256')
  u.searchParams.append('state', state)
  return u.toString()
}

function sweep(now: number): void {
  for (const [id, p] of pending) if (p.expiresAt <= now) pending.delete(id)
}

export interface StartedLogin {
  loginId: string
  url: string
  expiresAt: string
}

export function startClaudeLogin(opts: { actorUserId?: number | null; now?: number } = {}): StartedLogin {
  const now = opts.now ?? Date.now()
  sweep(now)
  // Bounded: the oldest unfinished link is dropped rather than growing forever.
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value as string)
  const verifier = b64url(crypto.randomBytes(32))
  const state = b64url(crypto.randomBytes(32))
  const loginId = crypto.randomBytes(16).toString('hex')
  const expiresAt = now + LOGIN_TTL_MS
  pending.set(loginId, { state, verifier, expiresAt, attempts: 0, actorUserId: opts.actorUserId ?? null })
  return { loginId, url: buildAuthorizeUrl(pkceChallenge(verifier), state), expiresAt: new Date(expiresAt).toISOString() }
}

/** Drop a pending login (operator pressed Cancel). */
export function cancelClaudeLogin(loginId: string): void {
  pending.delete(loginId)
}

/**
 * Accepts what Claude shows ("code#state"), a bare code, or the full callback URL
 * (…/oauth/code/callback?code=…&state=…). Whitespace anywhere is removed — it
 * only ever comes from copy-paste.
 */
export function parsePastedCode(input: string): { code: string; state: string | null } | null {
  const raw = (input || '').replace(/\s+/g, '')
  if (!raw) return null
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw)
      const code = u.searchParams.get('code')
      return code ? { code, state: u.searchParams.get('state') } : null
    } catch {
      return null
    }
  }
  const hash = raw.indexOf('#')
  const code = hash === -1 ? raw : raw.slice(0, hash)
  const state = hash === -1 ? null : raw.slice(hash + 1)
  return code ? { code, state: state || null } : null
}

export type FinishError =
  | 'unknown_login'      // no such link (never started, cancelled, or the server restarted)
  | 'expired'            // the link is older than LOGIN_TTL_MS
  | 'bad_input'          // nothing that looks like a code was pasted
  | 'state_mismatch'     // the code belongs to a different sign-in link
  | 'too_many_attempts'
  | 'bad_code'           // Claude rejected the code (wrong, already used, or expired on their side)
  | 'not_subscription'   // the reply was not a Claude subscription token
  | 'exchange_failed'    // network / unexpected reply

export type FinishResult =
  | { ok: true; token: string; expiresAt: string | null; actorUserId: number | null }
  | { ok: false; error: FinishError; message: string }

const MESSAGES: Record<FinishError, string> = {
  unknown_login: 'This sign-in link is no longer active. Get a new link and try again.',
  expired: 'This sign-in link expired. Get a new link and sign in again.',
  bad_input: 'Paste the authentication code Claude showed you.',
  state_mismatch: 'That code is from a different sign-in link. Use the code from the link shown here, or get a new link.',
  too_many_attempts: 'Too many attempts with this link. Get a new link and sign in again.',
  bad_code: 'Claude did not accept that code. Copy the whole code again (it is single-use), or get a new link.',
  not_subscription: 'Claude did not return a subscription token for this account. Nothing was saved.',
  exchange_failed: 'Could not reach Claude to finish signing in. Try again in a minute.',
}

const fail = (error: FinishError, detail?: string): FinishResult => ({
  ok: false,
  error,
  message: detail ? `${MESSAGES[error]} (${detail})` : MESSAGES[error],
})

/** Only a short, value-free reason from the token endpoint ever reaches the UI. */
function safeReason(body: unknown): string | undefined {
  const b = body as { error?: unknown; error_description?: unknown } | null
  const parts = [b?.error, b?.error_description].filter((v): v is string => typeof v === 'string')
  if (!parts.length) return undefined
  return parts.join(': ').replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]').replace(/[^\w .:,'()/-]/g, '').slice(0, 120)
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number
  json: () => Promise<unknown>
}>

export async function finishClaudeLogin(opts: {
  loginId: string
  pasted: string
  now?: number
  fetchImpl?: FetchLike
}): Promise<FinishResult> {
  const now = opts.now ?? Date.now()
  const entry = typeof opts.loginId === 'string' ? pending.get(opts.loginId) : undefined
  if (!entry) return fail('unknown_login')
  if (entry.expiresAt <= now) {
    pending.delete(opts.loginId)
    return fail('expired')
  }
  const parsed = parsePastedCode(opts.pasted)
  if (!parsed) return fail('bad_input')
  entry.attempts += 1
  if (entry.attempts > MAX_ATTEMPTS) {
    pending.delete(opts.loginId)
    return fail('too_many_attempts')
  }
  // A bare code (no #state) is allowed, but a state that is present must match.
  if (parsed.state !== null && !timingSafeEqualStr(parsed.state, entry.state)) return fail('state_mismatch')

  const doFetch: FetchLike = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  let status: number
  let body: unknown
  try {
    const res = await doFetch(CLAUDE_OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: parsed.code,
        redirect_uri: CLAUDE_OAUTH.redirectUri,
        client_id: CLAUDE_OAUTH.clientId,
        code_verifier: entry.verifier,
        state: entry.state,
        expires_in: CLAUDE_OAUTH.expiresInSeconds,
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    })
    status = res.status
    body = await res.json().catch(() => null)
  } catch {
    return fail('exchange_failed')
  }
  if (status === 400 || status === 401 || status === 403) return fail('bad_code', safeReason(body))
  if (status !== 200) return fail('exchange_failed', `HTTP ${status}`)

  const token = (body as { access_token?: unknown } | null)?.access_token
  if (typeof token !== 'string' || !token.startsWith('sk-ant-oat')) {
    // Never store anything else (an API key would bill per token).
    pending.delete(opts.loginId)
    return fail('not_subscription')
  }
  pending.delete(opts.loginId)
  const expiresIn = Number((body as { expires_in?: unknown }).expires_in)
  return {
    ok: true,
    token,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(now + expiresIn * 1000).toISOString() : null,
    actorUserId: entry.actorUserId,
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb)
}

/** Test hook: how many sign-in links are pending. */
export function pendingLoginCount(): number {
  return pending.size
}
