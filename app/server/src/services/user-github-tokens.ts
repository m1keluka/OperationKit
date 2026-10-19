/**
 * Per-user GitHub PAT store + validation (obj-2200 / W1).
 *
 * Each Command Center user may link ONE GitHub Personal Access Token so PRs
 * pushed for objectives they own are attributed to THEM on GitHub. This module
 * owns the storage + validation half:
 *
 *   - The raw PAT is encrypted at rest via services/crypto.ts (AES-256-GCM) and
 *     lives ONLY in `user_github_tokens.token_encrypted`. It is decrypted in
 *     exactly two places: `getDecryptedForUser` (the server-only seam W4's
 *     session-spawn injection calls) and `validatePat` re-validation.
 *   - Every value that can reach an API response is the masked
 *     `UserGithubTokenSummary` — resolved identity + last-4 fingerprint, never
 *     the token. `getForUser` is the only mapper a route should use.
 *   - The PAT is never logged.
 *
 * Validation hits the real GitHub API (`GET /user` + `GET /user/emails`) to
 * resolve the login/id and the author/committer email. The author email must be
 * a verified address on the account or GitHub renders the commit as an unlinked
 * plain name — so we prefer a verified primary and fall back to the account's
 * `noreply` address (`<id>+<login>@users.noreply.github.com`), which is always
 * verified.
 *
 * Session-spawn injection (the consumer of `getDecryptedForUser`) is W4's job
 * and deliberately NOT implemented here.
 */
import { getDb } from '../db/index.js'
import { encryptField, decryptField } from './crypto.js'
import type { GithubTokenType, UserGithubTokenSummary } from '@operationkit/shared'

// ── Test seam ───────────────────────────────────────────────────────────────
// Validation makes real HTTP calls to GitHub in production. Tests inject a fake
// so persistence, masking and error paths run deterministically without
// network access. Mirrors services/workspace-integrations.ts.
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
let _fetch: FetchLike = (input, init) => globalThis.fetch(input, init)
export function __setFetchForTests(f: FetchLike | null): void {
  _fetch = f ?? ((input, init) => globalThis.fetch(input, init))
}

// ── Persistence ───────────────────────────────────────────────────────────--

interface TokenRow {
  user_id: number
  token_encrypted: string
  token_last4: string
  github_login: string
  github_user_id: number | null
  github_email: string
  scopes: string | null
  token_type: string
  created_at: string
  last_validated_at: string | null
}

/** Last-4 fingerprint for masked display. Never derived from anything secret-leaking. */
export function last4(token: string): string {
  if (typeof token !== 'string' || token.length === 0) return ''
  return token.length <= 4 ? token : token.slice(-4)
}

/** Map a DB row to the masked, API-safe summary. The raw token is dropped here. */
function rowToSummary(row: TokenRow): UserGithubTokenSummary {
  return {
    github_login: row.github_login,
    github_email: row.github_email,
    github_user_id: row.github_user_id,
    token_last4: row.token_last4,
    scopes: row.scopes,
    token_type: (row.token_type as GithubTokenType) || 'pat_fine',
    created_at: row.created_at,
    last_validated_at: row.last_validated_at,
  }
}

/**
 * Masked summary of a user's linked token, or `null` if none. This is the ONLY
 * read a route handler should surface — it never contains the raw PAT.
 */
export function getForUser(userId: number): UserGithubTokenSummary | null {
  const row = getDb()
    .prepare('SELECT * FROM user_github_tokens WHERE user_id = ?')
    .get(userId) as TokenRow | undefined
  return row ? rowToSummary(row) : null
}

export interface UpsertInput {
  rawToken: string
  login: string
  githubUserId: number | null
  email: string
  scopes: string | null
  tokenType: GithubTokenType
}

/**
 * Encrypt + persist a validated token for a user (one row per user; replaces
 * any existing link). Returns the masked summary. The raw token is encrypted
 * here and never stored or returned in the clear.
 */
export function upsert(userId: number, input: UpsertInput): UserGithubTokenSummary {
  const encrypted = encryptField(input.rawToken)
  getDb()
    .prepare(
      `INSERT INTO user_github_tokens
         (user_id, token_encrypted, token_last4, github_login, github_user_id,
          github_email, scopes, token_type, last_validated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         token_encrypted   = excluded.token_encrypted,
         token_last4       = excluded.token_last4,
         github_login      = excluded.github_login,
         github_user_id    = excluded.github_user_id,
         github_email      = excluded.github_email,
         scopes            = excluded.scopes,
         token_type        = excluded.token_type,
         last_validated_at = datetime('now')`,
    )
    .run(
      userId,
      encrypted,
      last4(input.rawToken),
      input.login,
      input.githubUserId,
      input.email,
      input.scopes,
      input.tokenType,
    )
  const saved = getForUser(userId)
  if (!saved) throw new Error('user_github_tokens upsert returned no row')
  return saved
}

/** Bump `last_validated_at` after a successful re-validation. No-op if no row. */
export function touchValidated(userId: number): UserGithubTokenSummary | null {
  getDb()
    .prepare(`UPDATE user_github_tokens SET last_validated_at = datetime('now') WHERE user_id = ?`)
    .run(userId)
  return getForUser(userId)
}

/** Revoke (delete) a user's stored token. Returns true if a row was removed. */
export function deleteForUser(userId: number): boolean {
  const result = getDb().prepare('DELETE FROM user_github_tokens WHERE user_id = ?').run(userId)
  return result.changes > 0
}

/**
 * SERVER-ONLY: decrypt and return the raw PAT for a user, or `null` if none.
 *
 * This is the seam W4's per-session env injection calls. It must NEVER feed an
 * API response or a log line — the return value goes straight into a spawned
 * child process env.
 */
export function getDecryptedForUser(userId: number): string | null {
  const row = getDb()
    .prepare('SELECT token_encrypted FROM user_github_tokens WHERE user_id = ?')
    .get(userId) as { token_encrypted: string } | undefined
  if (!row) return null
  return decryptField(row.token_encrypted)
}

// ── GitHub validation ─────────────────────────────────────────────────────--

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'CommandCenter-UserGithubToken',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/** Classify the PAT by prefix. Fine-grained: `github_pat_`; classic: `ghp_`. */
function classifyToken(token: string): GithubTokenType {
  if (token.startsWith('github_pat_')) return 'pat_fine'
  if (token.startsWith('ghp_')) return 'pat_classic'
  // Default to fine-grained — the modern, recommended form. token_type is a
  // diagnostic hint, not a security boundary.
  return 'pat_fine'
}

export interface ValidatedPat {
  login: string
  id: number | null
  email: string
  scopes: string | null
  type: GithubTokenType
}

export type ValidateResult =
  | { ok: true; data: ValidatedPat }
  | { ok: false; error: string }

interface GithubUser {
  login?: string
  id?: number
  email?: string | null
}
interface GithubEmail {
  email?: string
  primary?: boolean
  verified?: boolean
}

/**
 * Validate a GitHub PAT against the live API and resolve the identity we need
 * for attribution: login, numeric id, a verified author email, observed scopes
 * and the token type. Never throws on bad creds — returns a structured
 * `{ ok: false, error }` so the route surfaces a real failure, not a false pass.
 */
export async function validatePat(rawToken: string): Promise<ValidateResult> {
  const token = rawToken.trim()
  if (!token) return { ok: false, error: 'Token is empty.' }

  let userRes: Response
  try {
    userRes = await _fetch('https://api.github.com/user', { headers: ghHeaders(token) })
  } catch {
    return { ok: false, error: 'Could not reach GitHub API.' }
  }
  if (userRes.status === 401) {
    return { ok: false, error: 'GitHub token invalid (401 — bad credentials). Generate a new token and re-link.' }
  }
  if (userRes.status === 403) {
    return {
      ok: false,
      error:
        'GitHub rejected this token (403). If your org uses SSO, authorize this token for the your-org org in GitHub → Settings → Developer settings, then re-link.',
    }
  }
  if (!userRes.ok) {
    return { ok: false, error: `GitHub API error while validating token (${userRes.status}).` }
  }

  const user = (await userRes.json().catch(() => null)) as GithubUser | null
  if (!user || typeof user.login !== 'string') {
    return { ok: false, error: 'GitHub returned an unexpected response for this token.' }
  }
  const login = user.login
  const id = typeof user.id === 'number' ? user.id : null

  // Classic PATs list granted scopes in this header; fine-grained PATs do not
  // (they carry resource permissions instead) — absence is expected there.
  const scopesHeader = userRes.headers.get('x-oauth-scopes')
  const scopes = scopesHeader && scopesHeader.trim().length > 0 ? scopesHeader.trim() : null
  const type = classifyToken(token)

  const email = await resolveAuthorEmail(token, login, id)
  return { ok: true, data: { login, id, email, scopes, type } }
}

/**
 * Resolve the author/committer email. Prefer a verified primary from
 * `GET /user/emails`; otherwise fall back to the always-verified GitHub
 * `noreply` address. The noreply form requires the numeric id — if we don't
 * have it we fall back to the login-only legacy noreply form.
 */
async function resolveAuthorEmail(
  token: string,
  login: string,
  id: number | null,
): Promise<string> {
  const noreply =
    id != null
      ? `${id}+${login}@users.noreply.github.com`
      : `${login}@users.noreply.github.com`

  let res: Response
  try {
    res = await _fetch('https://api.github.com/user/emails', { headers: ghHeaders(token) })
  } catch {
    return noreply
  }
  if (!res.ok) return noreply // fine-grained PAT without email:read → use noreply

  const emails = (await res.json().catch(() => null)) as GithubEmail[] | null
  if (!Array.isArray(emails)) return noreply

  const primaryVerified = emails.find(e => e.primary && e.verified && typeof e.email === 'string')
  if (primaryVerified?.email) return primaryVerified.email

  const anyVerified = emails.find(e => e.verified && typeof e.email === 'string')
  if (anyVerified?.email) return anyVerified.email

  return noreply
}
