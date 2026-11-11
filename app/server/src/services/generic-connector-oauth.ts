/**
 * Generic store + authorization-code flow for `auth_path: 'oauth_guided'`
 * connectors (obj 900508, Sprint 7.4 catalog preload) — Slack, Microsoft 365,
 * HubSpot, Discord, Intercom. Mirrors `services/user-google-connections.ts`
 * (same CSRF-state-JWT + encrypt-at-rest posture) but generalized across
 * `connector_oauth_grants`, one row per `(connector_id, user_id)`, instead of
 * a bespoke table per vendor.
 *
 * "Guided" means the INSTALL OWNER registers their own OAuth app with the
 * vendor (console walkthrough in each `setup_guide.md`) and pastes the
 * resulting client id/secret into Settings → Secrets as
 * `<CONNECTOR_ID>_OAUTH_CLIENT_ID` / `_OAUTH_CLIENT_SECRET` (env-var naming
 * mirrors `GOOGLE_OAUTH_CLIENT_ID`). There is no shared app and no Example
 * central dependency — exactly option (a) in the Sprint 7 proposal
 * (docs/connectors/INTEGRATIONS-PROPOSAL.md §2).
 */
import jwt from 'jsonwebtoken'
import { getDb } from '../db/index.js'
import { getJwtSecret } from '../middleware/auth.js'
import { encryptField, decryptField } from './crypto.js'
import { checkConnectorCredential, type ConnectorActor } from './connector-guard.js'
import type { ConnectorOAuthEndpoints } from '../connectors/types.js'

export interface OAuthClientConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
}

/** `slack` → `SLACK`, `microsoft-365` → `MICROSOFT_365`. */
function envPrefix(connectorId: string): string {
  return connectorId.toUpperCase().replace(/-/g, '_')
}

function redirectUriFor(connectorId: string): string {
  const base = process.env.APP_BASE_URL || ''
  return `${base}/api/user/connector-oauth/${connectorId}/callback`
}

/** Resolve the install's own OAuth app for this connector, or `null` if unset. */
export function getOAuthClient(connectorId: string): OAuthClientConfig | null {
  const prefix = envPrefix(connectorId)
  const clientId = process.env[`${prefix}_OAUTH_CLIENT_ID`]
  const clientSecret = process.env[`${prefix}_OAUTH_CLIENT_SECRET`]
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, redirectUri: redirectUriFor(connectorId) }
}

// ── CSRF state (mirrors user-google-connections.ts) ──────────────────────────
interface StatePayload {
  uid: number
  cid: string
}

export function signState(connectorId: string, userId: number): string {
  return jwt.sign({ uid: userId, cid: connectorId } satisfies StatePayload, getJwtSecret(), { expiresIn: '15m' })
}

/** Verify a callback `state`, scoped to the connector it was minted for. */
export function verifyState(connectorId: string, state: string): number | null {
  try {
    const decoded = jwt.verify(state, getJwtSecret()) as StatePayload
    if (decoded.cid !== connectorId || typeof decoded.uid !== 'number') return null
    return decoded.uid
  } catch {
    return null
  }
}

/** Build the vendor's consent URL for this connector/user. */
export function buildAuthUrl(
  connectorId: string,
  userId: number,
  oauth: ConnectorOAuthEndpoints,
  client: OAuthClientConfig,
): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    response_type: 'code',
    scope: oauth.scopes.join(' '),
    state: signState(connectorId, userId),
  })
  return `${oauth.authorize_url}?${params.toString()}`
}

// ── Persistence ───────────────────────────────────────────────────────────--

export interface GenericOAuthSummary {
  account_label: string | null
  scopes: string
  connected_at: string
  last_refreshed_at: string | null
  last_error: string | null
}

interface GrantRow {
  connector_id: string
  user_id: number
  account_label: string | null
  refresh_token_encrypted: string | null
  access_token_encrypted: string | null
  access_token_expires_at: string | null
  scopes: string
  connected_at: string
  last_refreshed_at: string | null
  last_error: string | null
}

function rowToSummary(row: GrantRow): GenericOAuthSummary {
  return {
    account_label: row.account_label,
    scopes: row.scopes,
    connected_at: row.connected_at,
    last_refreshed_at: row.last_refreshed_at,
    last_error: row.last_error,
  }
}

export function getForUser(connectorId: string, userId: number): GenericOAuthSummary | null {
  const row = getDb()
    .prepare('SELECT * FROM connector_oauth_grants WHERE connector_id = ? AND user_id = ?')
    .get(connectorId, userId) as GrantRow | undefined
  return row ? rowToSummary(row) : null
}

export interface UpsertGrantInput {
  accountLabel: string | null
  refreshToken: string | null
  accessToken: string | null
  accessTokenExpiresAt: string | null
  scopes: string
}

export function upsert(connectorId: string, userId: number, input: UpsertGrantInput): GenericOAuthSummary {
  getDb()
    .prepare(
      `INSERT INTO connector_oauth_grants
         (connector_id, user_id, account_label, refresh_token_encrypted,
          access_token_encrypted, access_token_expires_at, scopes, last_refreshed_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
       ON CONFLICT(connector_id, user_id) DO UPDATE SET
         account_label           = excluded.account_label,
         refresh_token_encrypted = COALESCE(excluded.refresh_token_encrypted, connector_oauth_grants.refresh_token_encrypted),
         access_token_encrypted  = excluded.access_token_encrypted,
         access_token_expires_at = excluded.access_token_expires_at,
         scopes                  = excluded.scopes,
         last_refreshed_at       = excluded.last_refreshed_at,
         last_error              = NULL`,
    )
    .run(
      connectorId,
      userId,
      input.accountLabel,
      input.refreshToken ? encryptField(input.refreshToken) : null,
      input.accessToken ? encryptField(input.accessToken) : null,
      input.accessTokenExpiresAt,
      input.scopes,
    )
  const saved = getForUser(connectorId, userId)
  if (!saved) throw new Error(`connector_oauth_grants upsert returned no row for ${connectorId}`)
  return saved
}

export function recordError(connectorId: string, userId: number, error: string): void {
  getDb()
    .prepare(
      `UPDATE connector_oauth_grants SET last_error = ? WHERE connector_id = ? AND user_id = ?`,
    )
    .run(error.slice(0, 300), connectorId, userId)
}

export function deleteForUser(connectorId: string, userId: number): boolean {
  const result = getDb()
    .prepare('DELETE FROM connector_oauth_grants WHERE connector_id = ? AND user_id = ?')
    .run(connectorId, userId)
  return result.changes > 0
}

/** SERVER-ONLY: decrypt the stored access/refresh token pair, owner-guarded. */
export function getDecryptedForUser(
  connectorId: string,
  userId: number,
  actor: ConnectorActor,
): { accessToken: string | null; refreshToken: string | null } | null {
  if (!checkConnectorCredential({ connectorId, ownerUserId: userId, actor }).allowed) return null
  const row = getDb()
    .prepare(
      'SELECT access_token_encrypted, refresh_token_encrypted FROM connector_oauth_grants WHERE connector_id = ? AND user_id = ?',
    )
    .get(connectorId, userId) as { access_token_encrypted: string | null; refresh_token_encrypted: string | null } | undefined
  if (!row) return null
  return {
    accessToken: row.access_token_encrypted ? decryptField(row.access_token_encrypted) : null,
    refreshToken: row.refresh_token_encrypted ? decryptField(row.refresh_token_encrypted) : null,
  }
}

// ── Test seam ─────────────────────────────────────────────────────────────--
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>
let _fetch: FetchLike = (input, init) => globalThis.fetch(input, init)
export function __setFetchForTests(f: FetchLike | null): void {
  _fetch = f ?? ((input, init) => globalThis.fetch(input, init))
}

export interface ExchangeResult {
  ok: true
  data: { accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string }
}
export type ExchangeOutcome = ExchangeResult | { ok: false; error: string }

/** Exchange an authorization code for a token pair at the connector's own `token_url`. */
export async function exchangeCode(
  oauth: ConnectorOAuthEndpoints,
  code: string,
  client: OAuthClientConfig,
): Promise<ExchangeOutcome> {
  let res: Response
  try {
    res = await _fetch(oauth.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
        redirect_uri: client.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
  } catch (err) {
    return { ok: false, error: `Could not reach the token endpoint: ${(err as Error).message}` }
  }
  if (!res.ok) {
    return { ok: false, error: `The provider rejected the authorization code (HTTP ${res.status}).` }
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    scope?: string
  } | null
  if (!body?.access_token) {
    return { ok: false, error: 'The provider did not return an access token.' }
  }
  return {
    ok: true,
    data: {
      accessToken: body.access_token,
      refreshToken: body.refresh_token || null,
      expiresAt: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null,
      scopes: body.scope || oauth.scopes.join(' '),
    },
  }
}
