/**
 * OPTIONAL, opt-in shared third-party OAuth app (Sprint 7.7, obj 900511 —
 * follow-up #7 / option (e) of docs/connectors/INTEGRATIONS-PROPOSAL.md).
 *
 * Some providers neither support DCR/CIMD nor make it easy to register your
 * own OAuth app (a few enterprise SaaS vendors gatekeep "become a developer"
 * behind a sales call). For those, an install admin MAY point one named
 * `oauth_guided` connector at a shared OAuth app run by a third party of
 * THEIR choosing (a WorkOS/Descope-style MCP auth provider, or any OAuth 2.0
 * authorization server that already has an app registered with the vendor).
 *
 * Hard rules this module enforces by construction:
 *   - OFF BY DEFAULT. There is no built-in issuer, client id or redirect URI —
 *     not Example's, not anyone's. A fresh install has no `settings` row, so
 *     `getSharedAppConfig()` returns null for every connector and the module
 *     never makes a network call.
 *   - NAMED PROVIDERS ONLY. Config is keyed per connector id and is accepted
 *     only for connectors that declare `shared_app_eligible` (the generic
 *     `oauth_guided` factory). There is no "all providers" switch.
 *   - NEVER PREFERRED OVER THE INSTALL'S OWN APP. When the install has its own
 *     `<ID>_OAUTH_CLIENT_ID/_SECRET`, that app is used and the shared app is
 *     ignored (see connectors/lib/oauth-guided-connector.ts).
 *   - NO SECRET STORAGE CHANGES. The config holds only public values (issuer,
 *     client id, redirect URI). The shared app is treated as a PUBLIC client
 *     (PKCE, RFC 7636). If a third party also hands out a client secret, it is
 *     read by NAME from the existing Settings → Secrets env
 *     (`<ID>_SHARED_OAUTH_CLIENT_SECRET`) — this module never stores it.
 *
 * Using a shared app is a dependency on whoever runs it — not on Operation
 * Kit. Turning it off (or never turning it on) leaves the install fully
 * working through its own apps, DCR/CIMD, or API keys.
 */
import jwt from 'jsonwebtoken'
import { getDb } from '../db/index.js'
import { getJwtSecret } from '../middleware/auth.js'
import {
  buildAuthorizationUrl,
  discoverAuthServerMetadata,
  exchangeAuthorizationCode,
  generatePkceVerifier,
  pkceChallengeFromVerifier,
  type FetchLike,
} from '../connectors/dcr-client.js'

/** The single `settings` row holding every opt-in. Absent on a fresh install. */
export const SHARED_APP_SETTINGS_KEY = 'connector_shared_oauth_apps'

export interface SharedAppConfig {
  /** The admin explicitly turned this on. Missing/false = off. */
  enabled: boolean
  /** Base URL of the third party's OAuth authorization server (RFC 8414 discovery runs against it). */
  issuer: string
  /** Client id the third party issued for its shared app. */
  client_id: string
  /** Redirect URI registered on the shared app. The third party relays `code` + `state` back to this install. */
  redirect_uri: string
  /** Optional: who runs it, shown in the UI and on the connection ("Example Auth Inc."). */
  provider_label?: string
  /** Optional scope override; the connector's own scopes are used when omitted. */
  scopes?: string[]
}

type ConfigMap = Record<string, SharedAppConfig>

function readAll(): ConfigMap {
  let raw: string | undefined
  try {
    raw = (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(SHARED_APP_SETTINGS_KEY) as
      | { value?: string }
      | undefined)?.value
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ConfigMap) : {}
  } catch {
    return {}
  }
}

function writeAll(map: ConfigMap): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(SHARED_APP_SETTINGS_KEY, JSON.stringify(map))
}

/** Stored config for one connector, enabled or not. `null` when never configured. */
export function getStoredSharedAppConfig(connectorId: string): SharedAppConfig | null {
  const c = readAll()[connectorId]
  return c && typeof c === 'object' ? c : null
}

/**
 * The config to USE for one connector, or `null`. Non-null only when the
 * admin turned it on AND every required field is present and valid — a
 * half-filled or switched-off entry behaves exactly like no entry.
 */
export function getSharedAppConfig(connectorId: string): SharedAppConfig | null {
  const c = getStoredSharedAppConfig(connectorId)
  if (!c || c.enabled !== true) return null
  return validateSharedAppInput(c).ok ? c : null
}

function isSecureUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return false
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  // Plain http only for a local dev auth server.
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
}

export type SharedAppValidation = { ok: true; value: SharedAppConfig } | { ok: false; error: string }

/** Strip trailing `/`s in linear time (a `/\/+$/` replace is quadratic on `////…x`). */
export function trimTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* '/' */) end--
  return s.slice(0, end)
}

/** Validate an admin's input. Never fills in a default for a missing field. */
export function validateSharedAppInput(body: unknown): SharedAppValidation {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.enabled !== 'boolean') return { ok: false, error: '`enabled` must be true or false.' }
  if (!isSecureUrl(b.issuer)) return { ok: false, error: '`issuer` must be an https:// URL of the third party you chose.' }
  const clientId = typeof b.client_id === 'string' ? b.client_id.trim() : ''
  if (!clientId || clientId.length > 300) return { ok: false, error: '`client_id` is required.' }
  if (!isSecureUrl(b.redirect_uri)) return { ok: false, error: '`redirect_uri` must be an https:// URL.' }
  const label = typeof b.provider_label === 'string' ? b.provider_label.trim().slice(0, 80) : ''
  let scopes: string[] | undefined
  if (b.scopes !== undefined && b.scopes !== null) {
    if (!Array.isArray(b.scopes) || !b.scopes.every(s => typeof s === 'string' && s.length > 0 && s.length < 200)) {
      return { ok: false, error: '`scopes` must be a list of strings.' }
    }
    scopes = b.scopes as string[]
  }
  return {
    ok: true,
    value: {
      enabled: b.enabled,
      issuer: trimTrailingSlashes(b.issuer as string),
      client_id: clientId,
      redirect_uri: b.redirect_uri as string,
      ...(label ? { provider_label: label } : {}),
      ...(scopes ? { scopes } : {}),
    },
  }
}

export function setSharedAppConfig(connectorId: string, config: SharedAppConfig): void {
  const map = readAll()
  map[connectorId] = config
  writeAll(map)
}

export function clearSharedAppConfig(connectorId: string): void {
  const map = readAll()
  if (!(connectorId in map)) return
  delete map[connectorId]
  writeAll(map)
}

/** `slack` → `SLACK_SHARED_OAUTH_CLIENT_SECRET`. Read by name only; never stored here. */
export function sharedSecretEnvName(connectorId: string): string {
  return `${connectorId.toUpperCase().replace(/-/g, '_')}_SHARED_OAUTH_CLIENT_SECRET`
}

export function sharedAppHost(c: SharedAppConfig): string {
  try {
    return new URL(c.issuer).host
  } catch {
    return c.issuer
  }
}

// ── CSRF state (distinct shape from the install-owned app's state) ──────────

interface SharedStatePayload {
  kind: 'shared_app'
  uid: number
  connector: string
  verifier: string
}

export function signSharedAppState(userId: number, connectorId: string, verifier: string): string {
  return jwt.sign(
    { kind: 'shared_app', uid: userId, connector: connectorId, verifier } satisfies SharedStatePayload,
    getJwtSecret(),
    { expiresIn: '15m' },
  )
}

/** Returns the payload only for a valid shared-app state minted for THIS connector. */
export function verifySharedAppState(state: string, connectorId: string): SharedStatePayload | null {
  try {
    const d = jwt.verify(state, getJwtSecret()) as Partial<SharedStatePayload>
    if (d.kind !== 'shared_app' || d.connector !== connectorId) return null
    if (typeof d.uid !== 'number' || typeof d.verifier !== 'string') return null
    return d as SharedStatePayload
  } catch {
    return null
  }
}

// ── Flow ─────────────────────────────────────────────────────────────────────

let _fetch: FetchLike = (i, init) => globalThis.fetch(i, init)
export function __setSharedAppFetchForTests(f: FetchLike | null): void {
  _fetch = f ?? ((i, init) => globalThis.fetch(i, init))
}

export type SharedStartOutcome = { ok: true; redirectUrl: string } | { ok: false; error: string }

/** Build the consent URL at the third party's authorization server. */
export async function startSharedAppOAuth(
  connectorId: string,
  userId: number,
  config: SharedAppConfig,
  defaultScopes: string[],
): Promise<SharedStartOutcome> {
  const metadata = await discoverAuthServerMetadata(config.issuer, _fetch)
  if (!metadata) {
    return {
      ok: false,
      error: `The shared app's issuer (${sharedAppHost(config)}) did not answer OAuth discovery. Turn the shared app off to use your own app instead.`,
    }
  }
  const verifier = generatePkceVerifier()
  const scopes = config.scopes ?? defaultScopes
  return {
    ok: true,
    redirectUrl: buildAuthorizationUrl(metadata, {
      clientId: config.client_id,
      redirectUri: config.redirect_uri,
      scope: scopes.length ? scopes.join(' ') : undefined,
      state: signSharedAppState(userId, connectorId, verifier),
      codeChallenge: pkceChallengeFromVerifier(verifier),
    }),
  }
}

export type SharedExchangeOutcome =
  | { ok: true; data: { accessToken: string; refreshToken: string | null; expiresAt: string | null; scopes: string } }
  | { ok: false; error: string }

/** Exchange the relayed authorization code at the third party's token endpoint. */
export async function exchangeSharedAppCode(
  connectorId: string,
  config: SharedAppConfig,
  code: string,
  verifier: string,
  defaultScopes: string[],
): Promise<SharedExchangeOutcome> {
  const metadata = await discoverAuthServerMetadata(config.issuer, _fetch)
  if (!metadata) return { ok: false, error: 'shared_app_discovery_failed' }
  const result = await exchangeAuthorizationCode(
    metadata,
    {
      code,
      redirectUri: config.redirect_uri,
      clientId: config.client_id,
      clientSecret: process.env[sharedSecretEnvName(connectorId)] || undefined,
      codeVerifier: verifier,
    },
    _fetch,
  )
  if (!result.ok) return result
  const t = result.data
  return {
    ok: true,
    data: {
      accessToken: t.access_token,
      refreshToken: typeof t.refresh_token === 'string' ? t.refresh_token : null,
      expiresAt: typeof t.expires_in === 'number' ? new Date(Date.now() + t.expires_in * 1000).toISOString() : null,
      scopes: typeof t.scope === 'string' ? t.scope : (config.scopes ?? defaultScopes).join(' '),
    },
  }
}
