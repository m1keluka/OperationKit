/**
 * Per-user Google Workspace connections (obj-706070).
 *
 * Command Center's Google access used to be ONE shared credential — Operator's
 * stored OAuth token, reused by every session regardless of who the work was
 * for (vault: 2026-06-12-hermes-google-suite-shared-credential). This module
 * replaces that with one OAuth grant per Command Center user: Ava's session
 * writes Docs as Ava, Operator's as Operator.
 *
 * Storage posture, mirrored from services/user-github-tokens.ts:
 *   - The refresh token (and the cached access token) are encrypted at rest via
 *     services/crypto.ts (AES-256-GCM) and live ONLY in
 *     `user_google_connections.*_encrypted`.
 *   - Everything that can reach an API response is the masked
 *     `UserGoogleConnectionSummary` — identity + granted scopes + timestamps,
 *     never a token. `getForUser` is the only mapper a route may use.
 *   - Tokens are decrypted in exactly two seams: `getDecryptedRefreshToken`
 *     (spawn-env injection) and `getAccessTokenForUser` (server-side refresh).
 *   - No token is ever logged.
 *
 * The OAuth client is the EXISTING Google Cloud client already used by the
 * workspace-mcp credentials and gmail-triage (Doppler
 * GOOGLE_OAUTH_CLIENT_ID/SECRET). No new Cloud project is created here; the only
 * console change required is registering the web redirect URI — see
 * docs/per-user-google-workspace.md.
 */
import fs from 'fs'
import path from 'path'
import jwt from 'jsonwebtoken'
import { getDb } from '../db/index.js'
import { getJwtSecret } from '../middleware/auth.js'
import { encryptField, decryptField } from './crypto.js'
import type { UserGoogleConnectionSummary } from '@command-center/shared'

// ── Test seam ───────────────────────────────────────────────────────────────
// Token exchange / refresh / revoke hit Google over HTTPS in production. Tests
// inject a fake so persistence, masking, refresh and error paths run
// deterministically offline. Mirrors services/user-github-tokens.ts.
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
let _fetch: FetchLike = (input, init) => globalThis.fetch(input, init)
export function __setFetchForTests(f: FetchLike | null): void {
  _fetch = f ?? ((input, init) => globalThis.fetch(input, init))
}

// ── OAuth configuration ─────────────────────────────────────────────────────

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
export const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

/**
 * Full Workspace scope set. Covers every surface the objective calls for —
 * Gmail, Drive, Docs, Sheets, Slides, Calendar — at the level needed to CREATE
 * artifacts, not just read them, plus openid/email/profile so the callback can
 * resolve which Google account just consented.
 */
export const GOOGLE_SCOPES: readonly string[] = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  // Gmail
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  // Drive (full, + explicit drive.file for app-created artifacts)
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  // Docs / Sheets / Slides
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/presentations',
  // Calendar
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
]

export interface OAuthClientConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/**
 * Resolve the PRIMARY OAuth client from env (Doppler) — the one new consent
 * flows are granted to. Returns null when unconfigured so callers can render an
 * explicit "not configured" state instead of throwing.
 */
export function getOAuthClient(): OAuthClientConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || ''
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || ''
  if (!clientId || !clientSecret) return null
  const redirectUri =
    process.env.GOOGLE_OAUTH_REDIRECT_URI || 'https://cc.example.com/api/user/google/callback'
  return { clientId, clientSecret, redirectUri }
}

/**
 * Resolve the client that can refresh a GIVEN stored grant.
 *
 * A Google refresh token is only valid for the OAuth client that issued it. The
 * credentials migrated off the old shared-credential setup were minted by the
 * LEGACY client (Doppler GMAIL_CLIENT_ID/GMAIL_CLIENT_SECRET, a Desktop client),
 * which is a DIFFERENT client from the primary GOOGLE_OAUTH_CLIENT_ID new
 * consent flows use — verified empirically: refreshing a migrated token against
 * the primary client returns HTTP 401 unauthorized_client, against the legacy
 * client HTTP 200. So the refresh path must select by the row's stored
 * `client_id`, not by "whatever is primary today". Rows connected through the UI
 * carry the primary id and match the first branch; migrated rows match the
 * legacy branch. Unknown id ⇒ null, and the caller records an actionable
 * last_error rather than firing a request that is guaranteed to 401.
 */
export function getOAuthClientById(clientId: string): OAuthClientConfig | null {
  if (!clientId) return getOAuthClient()
  const primary = getOAuthClient()
  if (primary && primary.clientId === clientId) return primary

  const legacyId = process.env.GMAIL_CLIENT_ID || ''
  const legacySecret = process.env.GMAIL_CLIENT_SECRET || ''
  if (legacyId && legacySecret && legacyId === clientId) {
    // Desktop client: it cannot serve the web redirect, but refresh_token grant
    // does not use a redirect_uri at all, so refreshing works fine.
    return { clientId: legacyId, clientSecret: legacySecret, redirectUri: '' }
  }
  return null
}

// ── CSRF state ──────────────────────────────────────────────────────────────
// The consent round-trip leaves our origin, so the callback cannot trust a
// cookie alone. We carry a short-lived JWT signed with JWT_SECRET that binds the
// flow to the user who started it; the callback derives the user id from THAT,
// never from a query param.

interface StatePayload { uid: number }

export function signState(userId: number): string {
  return jwt.sign({ uid: userId } satisfies StatePayload, getJwtSecret(), {
    expiresIn: '15m',
  })
}

/** Verify a callback `state`. Returns the user id, or null if forged/expired. */
export function verifyState(state: string): number | null {
  try {
    const decoded = jwt.verify(state, getJwtSecret()) as StatePayload
    return typeof decoded.uid === 'number' ? decoded.uid : null
  } catch {
    return null
  }
}

/** Build the Google consent URL. `offline` + `prompt=consent` guarantee a refresh token. */
export function buildAuthUrl(userId: number, client: OAuthClientConfig): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    // Without prompt=consent Google omits refresh_token on re-consent for an
    // already-granted client, which would silently break reconnects.
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: signState(userId),
  })
  return `${AUTH_ENDPOINT}?${params.toString()}`
}

// ── Persistence ─────────────────────────────────────────────────────────────

interface ConnectionRow {
  user_id: number
  google_email: string
  google_sub: string | null
  refresh_token_encrypted: string
  access_token_encrypted: string | null
  access_token_expires_at: string | null
  scopes: string
  client_id: string
  connected_at: string
  last_refreshed_at: string | null
  last_error: string | null
}

/** Map a DB row to the masked, API-safe summary. All token material is dropped here. */
function rowToSummary(row: ConnectionRow): UserGoogleConnectionSummary {
  return {
    google_email: row.google_email,
    scopes: row.scopes,
    client_id: row.client_id,
    connected_at: row.connected_at,
    last_refreshed_at: row.last_refreshed_at,
    last_error: row.last_error,
  }
}

/**
 * Masked summary of a user's Google connection, or `null` if not connected.
 * This is the ONLY read a route handler may surface.
 */
export function getForUser(userId: number): UserGoogleConnectionSummary | null {
  const row = getDb()
    .prepare('SELECT * FROM user_google_connections WHERE user_id = ?')
    .get(userId) as ConnectionRow | undefined
  return row ? rowToSummary(row) : null
}

export interface UpsertInput {
  googleEmail: string
  googleSub: string | null
  refreshToken: string
  accessToken?: string | null
  accessTokenExpiresAt?: string | null
  scopes: string
  clientId: string
}

/** Encrypt + persist a user's connection (one row per user; replaces any existing). */
export function upsert(userId: number, input: UpsertInput): UserGoogleConnectionSummary {
  getDb()
    .prepare(
      `INSERT INTO user_google_connections
         (user_id, google_email, google_sub, refresh_token_encrypted,
          access_token_encrypted, access_token_expires_at, scopes, client_id,
          connected_at, last_refreshed_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         google_email            = excluded.google_email,
         google_sub              = excluded.google_sub,
         refresh_token_encrypted = excluded.refresh_token_encrypted,
         access_token_encrypted  = excluded.access_token_encrypted,
         access_token_expires_at = excluded.access_token_expires_at,
         scopes                  = excluded.scopes,
         client_id               = excluded.client_id,
         last_refreshed_at       = datetime('now'),
         last_error              = NULL`,
    )
    .run(
      userId,
      input.googleEmail,
      input.googleSub,
      encryptField(input.refreshToken),
      input.accessToken ? encryptField(input.accessToken) : null,
      input.accessTokenExpiresAt ?? null,
      input.scopes,
      input.clientId,
    )
  const saved = getForUser(userId)
  if (!saved) throw new Error('user_google_connections upsert returned no row')
  return saved
}

/** Remove a user's connection row. Returns true if a row was removed. */
export function deleteForUser(userId: number): boolean {
  const result = getDb().prepare('DELETE FROM user_google_connections WHERE user_id = ?').run(userId)
  return result.changes > 0
}

/** Record a refresh failure as connection health (surfaced in the UI, not fatal). */
export function recordError(userId: number, message: string): void {
  getDb()
    .prepare('UPDATE user_google_connections SET last_error = ? WHERE user_id = ?')
    .run(message.slice(0, 300), userId)
}

/**
 * SERVER-ONLY: decrypt and return the raw refresh token for a user, or `null`.
 *
 * This is the seam the spawn-env injection calls. It must NEVER feed an API
 * response or a log line — the return value goes straight into a spawned child
 * process env.
 */
export function getDecryptedRefreshToken(userId: number): string | null {
  const row = getDb()
    .prepare('SELECT refresh_token_encrypted FROM user_google_connections WHERE user_id = ?')
    .get(userId) as { refresh_token_encrypted: string } | undefined
  if (!row) return null
  return decryptField(row.refresh_token_encrypted)
}

// ── Google OAuth calls ──────────────────────────────────────────────────────

export interface ExchangeResult {
  ok: true
  data: { refreshToken: string; accessToken: string; expiresAt: string; scopes: string }
}
export type ExchangeOutcome = ExchangeResult | { ok: false; error: string }

/** Exchange an authorization code for tokens. */
export async function exchangeCode(code: string, client: OAuthClientConfig): Promise<ExchangeOutcome> {
  let res: Response
  try {
    res = await _fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
  } catch (err) {
    return { ok: false, error: `Could not reach Google: ${(err as Error).message}` }
  }
  if (!res.ok) {
    return { ok: false, error: `Google rejected the authorization code (HTTP ${res.status}).` }
  }
  const body = (await res.json()) as {
    refresh_token?: string
    access_token?: string
    expires_in?: number
    scope?: string
  }
  if (!body.refresh_token) {
    // Happens when the user re-consents without prompt=consent; we always send
    // it, so this means the grant is in a state we cannot use.
    return {
      ok: false,
      error: 'Google did not return a refresh token. Remove Command Center at myaccount.google.com/permissions and reconnect.',
    }
  }
  return {
    ok: true,
    data: {
      refreshToken: body.refresh_token,
      accessToken: body.access_token || '',
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
      scopes: body.scope || GOOGLE_SCOPES.join(' '),
    },
  }
}

/** Resolve the consenting Google account's email/sub from an access token. */
export async function fetchUserInfo(
  accessToken: string,
): Promise<{ email: string; sub: string | null }> {
  try {
    const res = await _fetch(USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return { email: '', sub: null }
    const body = (await res.json()) as { email?: string; sub?: string }
    return { email: body.email || '', sub: body.sub || null }
  } catch {
    return { email: '', sub: null }
  }
}

/**
 * Return a VALID access token for a user, refreshing via the stored refresh
 * token when the cached one is missing or within 60s of expiry. Server-only.
 * Returns null when the user has no connection or the refresh fails (the
 * failure is recorded on the row as `last_error`, never thrown at the caller).
 */
export async function getAccessTokenForUser(userId: number): Promise<string | null> {
  const row = getDb()
    .prepare('SELECT * FROM user_google_connections WHERE user_id = ?')
    .get(userId) as ConnectionRow | undefined
  if (!row) return null

  if (row.access_token_encrypted && row.access_token_expires_at) {
    const expiresAt = new Date(row.access_token_expires_at).getTime()
    if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 60_000) {
      try {
        return decryptField(row.access_token_encrypted)
      } catch {
        /* fall through to a refresh */
      }
    }
  }

  // Select the client that ISSUED this grant — see getOAuthClientById.
  const client = getOAuthClientById(row.client_id)
  if (!client) {
    recordError(
      userId,
      'The OAuth client this credential was granted to is not configured on this server. Reconnect Google Workspace.',
    )
    return null
  }

  let refreshToken: string
  try {
    refreshToken = decryptField(row.refresh_token_encrypted)
  } catch {
    recordError(userId, 'Stored credential could not be decrypted. Reconnect Google Workspace.')
    return null
  }

  try {
    const res = await _fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.clientId,
        client_secret: client.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    })
    if (!res.ok) {
      recordError(userId, `Google refused the refresh token (HTTP ${res.status}). Reconnect Google Workspace.`)
      return null
    }
    const body = (await res.json()) as { access_token?: string; expires_in?: number }
    if (!body.access_token) {
      recordError(userId, 'Google returned no access token on refresh.')
      return null
    }
    const expiresAt = new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString()
    getDb()
      .prepare(
        `UPDATE user_google_connections
            SET access_token_encrypted = ?, access_token_expires_at = ?,
                last_refreshed_at = datetime('now'), last_error = NULL
          WHERE user_id = ?`,
      )
      .run(encryptField(body.access_token), expiresAt, userId)
    return body.access_token
  } catch (err) {
    recordError(userId, `Refresh failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * Disconnect: ask Google to revoke the grant, then delete the row. Deletion
 * happens even if the remote revoke fails — a user who clicks Disconnect must
 * always end up with no stored credential.
 */
export async function disconnect(userId: number): Promise<{ removed: boolean; revoked: boolean }> {
  let revoked = false
  let refreshToken: string | null = null
  try {
    refreshToken = getDecryptedRefreshToken(userId)
  } catch {
    refreshToken = null
  }
  if (refreshToken) {
    try {
      const res = await _fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }).toString(),
      })
      revoked = res.ok
    } catch {
      revoked = false
    }
  }
  const removed = deleteForUser(userId)
  return { removed, revoked }
}

/**
 * Isolated on-disk Google credential dir for ONE user.
 *
 * workspace-mcp (and the ambient `~/.claude.json` google-workspace server) reads
 * EVERY `*.json` in `WORKSPACE_MCP_CREDENTIALS_DIR`. The shared folder
 * `/home/operator/assistant/google-credentials` holds Operator AND Ava, so a session
 * can send as the other person. We write a private dir with that user's file
 * only. Returns null when the user has no usable grant.
 */
export function writeIsolatedGoogleCredsDir(userId: number): string | null {
  try {
    const summary = getForUser(userId)
    const refresh = getDecryptedRefreshToken(userId)
    if (!summary?.google_email || !refresh) return null
    const client = getOAuthClientById(summary.client_id)
    const root = process.env.CC_SCRIPT_DIR || '/tmp/cc-scripts'
    const dir = path.join(root, 'google-creds', String(userId))
    fs.mkdirSync(dir, { recursive: true })
    for (const name of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, name)) } catch { /* ignore */ }
    }
    const body = {
      refresh_token: refresh,
      token: '',
      client_id: client?.clientId || process.env.GOOGLE_OAUTH_CLIENT_ID || '',
      client_secret: client?.clientSecret || process.env.GOOGLE_OAUTH_CLIENT_SECRET || '',
      account: summary.google_email,
      scopes: (summary.scopes || '').split(/\s+/).filter(Boolean),
    }
    fs.writeFileSync(path.join(dir, `${summary.google_email}.json`), JSON.stringify(body), { mode: 0o600 })
    return dir
  } catch {
    return null
  }
}

/** Empty dir so an unconnected session cannot see the shared multi-user folder. */
export function writeEmptyGoogleCredsDir(tag: string): string {
  const root = process.env.CC_SCRIPT_DIR || '/tmp/cc-scripts'
  const dir = path.join(root, 'google-creds', `absent-${tag}`)
  fs.mkdirSync(dir, { recursive: true })
  try {
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name))
  } catch { /* ignore */ }
  return dir
}
