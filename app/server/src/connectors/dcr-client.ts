/**
 * Shared Dynamic Client Registration (RFC 7591) / Client ID Metadata Document
 * (CIMD) client for `auth_path: 'dcr_mcp'` connectors (Sprint 7.3, obj 900507).
 *
 * Implements the MCP Authorization spec's own priority order
 * (modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration,
 * quoted in full in docs/connectors/DCR-CIMD-VENDOR-VERIFICATION.md) for a
 * client with no pre-existing relationship to a provider's OAuth server:
 *
 *   1. CIMD — if the provider's own OAuth Authorization Server Metadata
 *      (RFC 8414, `/.well-known/oauth-authorization-server`) advertises
 *      `client_id_metadata_document_supported`, the client_id IS an https URL
 *      that hosts a small JSON document describing this install. No
 *      registration call, no client_secret — a public client, PKCE-only.
 *   2. DCR — RFC 7591: POST to the provider's own `registration_endpoint`.
 *      Deprecated by the spec but kept for providers that support DCR only
 *      (per the Sprint 7.5 vendor pass, Notion and Linear currently advertise
 *      both, so this module prefers CIMD and only falls back to DCR).
 *   3. none — neither is present; the caller should fall back to an API key.
 *
 * Registration happens against the PROVIDER'S OWN auth server, from THIS
 * install's own redirect URI — there is no shared Example callback and no
 * central/shared client id. Every command-center install that connects a
 * `dcr_mcp` connector registers its own client independently.
 *
 * This module is pure protocol plumbing: discovery, registration, PKCE and
 * token exchange. It knows nothing about SQLite, encryption or which vendor is
 * calling it — storage lives in services/dcr-client-registrations.ts (the
 * per-install client) and services/user-dcr-connections.ts (the per-user
 * grant), mirroring services/user-google-connections.ts.
 */
import { createHash, randomBytes } from 'node:crypto'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * OAuth Authorization Server Metadata (RFC 8414), trimmed to the fields this
 * module reads. Providers return many more fields; they pass through
 * untouched via the index signature so a caller can inspect them if needed.
 */
export interface AuthServerMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  client_id_metadata_document_supported?: boolean
  scopes_supported?: string[]
  [key: string]: unknown
}

/** Fetch `${issuerBaseUrl}/.well-known/oauth-authorization-server`. Never throws. */
export async function discoverAuthServerMetadata(
  issuerBaseUrl: string,
  fetchImpl: FetchLike = (i, init) => globalThis.fetch(i, init),
): Promise<AuthServerMetadata | null> {
  const base = issuerBaseUrl.replace(/\/+$/, '')
  let res: Response
  try {
    res = await fetchImpl(`${base}/.well-known/oauth-authorization-server`)
  } catch {
    return null
  }
  if (!res.ok) return null
  try {
    const body = (await res.json()) as Partial<AuthServerMetadata>
    if (!body || typeof body.token_endpoint !== 'string' || typeof body.authorization_endpoint !== 'string') {
      return null
    }
    return body as AuthServerMetadata
  } catch {
    return null
  }
}

export type RegistrationStrategy = 'cimd' | 'dcr' | 'none'

/** The MCP spec's own priority order: CIMD first, DCR as a deprecated fallback. */
export function chooseRegistrationStrategy(metadata: AuthServerMetadata | null): RegistrationStrategy {
  if (!metadata) return 'none'
  if (metadata.client_id_metadata_document_supported === true) return 'cimd'
  if (typeof metadata.registration_endpoint === 'string' && metadata.registration_endpoint.length > 0) return 'dcr'
  return 'none'
}

// ── CIMD ─────────────────────────────────────────────────────────────────────

/** The JSON document a CIMD client_id URL must serve. Public client — no secret. */
export interface ClientMetadataDocument {
  client_name: string
  redirect_uris: string[]
  token_endpoint_auth_method: 'none'
  grant_types: string[]
  response_types: string[]
  scope?: string
}

export function buildClientMetadataDocument(opts: {
  clientName: string
  redirectUri: string
  scope?: string
}): ClientMetadataDocument {
  return {
    client_name: opts.clientName,
    redirect_uris: [opts.redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    ...(opts.scope ? { scope: opts.scope } : {}),
  }
}

// ── DCR (RFC 7591) ───────────────────────────────────────────────────────────

export interface DcrRegistrationRequest {
  client_name: string
  redirect_uris: string[]
  grant_types?: string[]
  response_types?: string[]
  token_endpoint_auth_method?: string
  scope?: string
}

export interface DcrRegisteredClient {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
}

export type DcrRegistrationOutcome =
  | { ok: true; data: DcrRegisteredClient }
  | { ok: false; error: string }

/** POST to the provider's own `registration_endpoint` (RFC 7591). */
export async function registerDynamicClient(
  metadata: AuthServerMetadata,
  req: DcrRegistrationRequest,
  fetchImpl: FetchLike = (i, init) => globalThis.fetch(i, init),
): Promise<DcrRegistrationOutcome> {
  if (!metadata.registration_endpoint) {
    return { ok: false, error: 'Provider metadata has no registration_endpoint.' }
  }
  const body: DcrRegistrationRequest = {
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
    ...req,
  }
  let res: Response
  try {
    res = await fetchImpl(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    return { ok: false, error: `Could not reach ${metadata.registration_endpoint}: ${(err as Error).message}` }
  }
  if (!res.ok) {
    return { ok: false, error: `Registration rejected (HTTP ${res.status}).` }
  }
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    return { ok: false, error: 'Registration endpoint returned a non-JSON response.' }
  }
  const data = parsed as Partial<DcrRegisteredClient> | null
  if (!data || typeof data.client_id !== 'string' || data.client_id.length === 0) {
    return { ok: false, error: 'Registration response had no client_id.' }
  }
  return {
    ok: true,
    data: {
      client_id: data.client_id,
      client_secret: typeof data.client_secret === 'string' ? data.client_secret : undefined,
      client_id_issued_at: typeof data.client_id_issued_at === 'number' ? data.client_id_issued_at : undefined,
      client_secret_expires_at:
        typeof data.client_secret_expires_at === 'number' ? data.client_secret_expires_at : undefined,
    },
  }
}

// ── Ensure a registered client (the orchestration callers actually use) ─────

export interface EnsureClientResult {
  method: 'cimd' | 'dcr'
  clientId: string
  clientSecret?: string
  metadata: AuthServerMetadata
}
export type EnsureClientOutcome = { ok: true; data: EnsureClientResult } | { ok: false; error: string }

/**
 * Discover the provider's metadata and resolve a usable client_id (+ secret,
 * for DCR) per the spec's priority order. `cimdMetadataUrl` is the install's
 * own stable, publicly-reachable URL serving `buildClientMetadataDocument()`'s
 * output for this connector (see routes/connectors.ts).
 */
export async function ensureRegisteredClient(opts: {
  issuerBaseUrl: string
  clientName: string
  redirectUri: string
  cimdMetadataUrl: string
  scope?: string
  fetchImpl?: FetchLike
}): Promise<EnsureClientOutcome> {
  const fetchImpl = opts.fetchImpl ?? ((i: string, init?: RequestInit) => globalThis.fetch(i, init))
  const metadata = await discoverAuthServerMetadata(opts.issuerBaseUrl, fetchImpl)
  const strategy = chooseRegistrationStrategy(metadata)
  if (strategy === 'none' || !metadata) {
    return {
      ok: false,
      error: `${opts.issuerBaseUrl} advertises neither CIMD nor DCR — use the API key fallback instead.`,
    }
  }
  if (strategy === 'cimd') {
    return { ok: true, data: { method: 'cimd', clientId: opts.cimdMetadataUrl, metadata } }
  }
  const reg = await registerDynamicClient(
    metadata,
    { client_name: opts.clientName, redirect_uris: [opts.redirectUri], scope: opts.scope },
    fetchImpl,
  )
  if (!reg.ok) return reg
  return {
    ok: true,
    data: { method: 'dcr', clientId: reg.data.client_id, clientSecret: reg.data.client_secret, metadata },
  }
}

// ── PKCE (RFC 7636) ──────────────────────────────────────────────────────────

/** 43-128 char URL-safe random string, per RFC 7636 §4.1. */
export function generatePkceVerifier(): string {
  return randomBytes(32).toString('base64url')
}

/** S256 code_challenge for a given verifier, per RFC 7636 §4.2. */
export function pkceChallengeFromVerifier(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

// ── Authorization + token exchange ──────────────────────────────────────────

export function buildAuthorizationUrl(
  metadata: AuthServerMetadata,
  params: {
    clientId: string
    redirectUri: string
    scope?: string
    state: string
    codeChallenge?: string
    /** RFC 8707 resource indicator — the MCP server URL the token is for (obj 900620). Optional. */
    resource?: string
  },
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
  })
  if (params.scope) q.set('scope', params.scope)
  if (params.codeChallenge) {
    q.set('code_challenge', params.codeChallenge)
    q.set('code_challenge_method', 'S256')
  }
  if (params.resource) q.set('resource', params.resource)
  return `${metadata.authorization_endpoint}?${q.toString()}`
}

export interface TokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  [key: string]: unknown
}
export type TokenOutcome = { ok: true; data: TokenResponse } | { ok: false; error: string }

async function postToken(
  tokenEndpoint: string,
  body: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<TokenOutcome> {
  let res: Response
  try {
    res = await fetchImpl(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    })
  } catch (err) {
    return { ok: false, error: `Could not reach ${tokenEndpoint}: ${(err as Error).message}` }
  }
  if (!res.ok) {
    return { ok: false, error: `Token endpoint rejected the request (HTTP ${res.status}).` }
  }
  let parsed: unknown
  try {
    parsed = await res.json()
  } catch {
    return { ok: false, error: 'Token endpoint returned a non-JSON response.' }
  }
  const data = parsed as Partial<TokenResponse> | null
  if (!data || typeof data.access_token !== 'string' || data.access_token.length === 0) {
    return { ok: false, error: 'Token response had no access_token.' }
  }
  return { ok: true, data: data as TokenResponse }
}

export async function exchangeAuthorizationCode(
  metadata: AuthServerMetadata,
  params: { code: string; redirectUri: string; clientId: string; clientSecret?: string; codeVerifier?: string; resource?: string },
  fetchImpl: FetchLike = (i, init) => globalThis.fetch(i, init),
): Promise<TokenOutcome> {
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
  }
  if (params.clientSecret) body.client_secret = params.clientSecret
  if (params.codeVerifier) body.code_verifier = params.codeVerifier
  if (params.resource) body.resource = params.resource
  return postToken(metadata.token_endpoint, body, fetchImpl)
}

export async function refreshAccessToken(
  metadata: AuthServerMetadata,
  params: { refreshToken: string; clientId: string; clientSecret?: string; resource?: string },
  fetchImpl: FetchLike = (i, init) => globalThis.fetch(i, init),
): Promise<TokenOutcome> {
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  }
  if (params.clientSecret) body.client_secret = params.clientSecret
  if (params.resource) body.resource = params.resource
  return postToken(metadata.token_endpoint, body, fetchImpl)
}
