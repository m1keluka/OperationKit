/**
 * Workspace MCP servers — storage, OAuth, refresh and test (Sprint 7.8, obj 900620).
 *
 * Settings → Integrations → "Connect an MCP server" lands here. A connection:
 *   - belongs to ONE workspace (`workspace_mcp_servers.workspace`), and only
 *     sessions / chat bots in that workspace ever receive it;
 *   - keeps every credential in the native secrets store at that workspace's
 *     scope under `CC_MCP_SERVER_<id>_*` keys, which secrets-store.ts treats as
 *     server-only (never bulk-injected, never served by the broker). The ONE
 *     value a session gets is the access token its MCP config references —
 *     never the refresh token or a DCR client secret (see spawnEnvFor below);
 *   - reuses the Sprint 7.3 DCR/CIMD client (connectors/dcr-client.ts) for
 *     registration, PKCE, code exchange and refresh. No parallel OAuth stack.
 *
 * Every outbound request uses the SSRF-guarded fetch (mcp-servers/safe-fetch.ts).
 * Nothing in this file logs or returns a credential; `McpServerSummary` has no
 * value field, by construction.
 */
import jwt from 'jsonwebtoken'
import type {
  McpServerSummary,
  McpServerTool,
  McpServerAuthType,
  McpServerTransport,
  McpServerStatus,
  McpOAuthRegistration,
  McpErrorKind,
} from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { setSecret, getSecretValue, deleteSecret, getSecret, MCP_SERVER_SECRET_PREFIX, type SecretScope } from './secrets-store.js'
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  generatePkceVerifier,
  pkceChallengeFromVerifier,
  refreshAccessToken,
  registerDynamicClient,
  buildClientMetadataDocument,
  type AuthServerMetadata,
  type ClientMetadataDocument,
} from '../connectors/dcr-client.js'
import { appBaseUrl } from '../connectors/dcr-routes.js'
import { signDcrState, verifyDcrState } from './dcr-state.js'
import { validateMcpUrl } from '../mcp-servers/url-guard.js'
import { safeFetch as defaultSafeFetch, type SafeFetch } from '../mcp-servers/safe-fetch.js'
import { McpClientError, McpSession, probeMcpServer, type McpToolInfo } from '../mcp-servers/mcp-client.js'
import { discoverIssuerMetadata, type DetectedAuth } from '../mcp-servers/auth-detect.js'

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface McpServerRow {
  id: number
  workspace: string
  slug: string
  name: string
  url: string
  transport: McpServerTransport
  auth_type: McpServerAuthType
  auth_header_name: string | null
  catalog_id: string | null
  oauth_registration: McpOAuthRegistration | null
  oauth_issuer: string | null
  oauth_authorization_endpoint: string | null
  oauth_token_endpoint: string | null
  oauth_client_id: string | null
  oauth_scope: string | null
  oauth_resource: string | null
  token_expires_at: string | null
  status: McpServerStatus
  server_name: string | null
  server_version: string | null
  protocol_version: string | null
  detected_transport: 'streamable_http' | 'sse' | null
  tools_json: string
  disabled_tools_json: string
  enabled: number
  last_tested_at: string | null
  last_error: string | null
  created_by: number | null
  created_at: string
  updated_at: string
}

export interface StoredTool extends McpToolInfo {}

let fetchImpl: SafeFetch = defaultSafeFetch
/** Tests swap in a fetch that may reach a localhost stub. */
export function __setMcpFetchForTests(f: SafeFetch | null): void {
  fetchImpl = f ?? defaultSafeFetch
}
/** The SSRF-guarded fetch every MCP-server request uses. */
export function mcpFetch(): SafeFetch {
  return fetchImpl
}

// ── Secrets (native store, workspace scope, server-only keys) ────────────────

type SecretKind = 'ACCESS_TOKEN' | 'REFRESH_TOKEN' | 'CLIENT_SECRET'

export function mcpSecretKey(id: number, kind: SecretKind): string {
  return `${MCP_SERVER_SECRET_PREFIX}${id}_${kind}`
}

function scopeOf(row: Pick<McpServerRow, 'workspace'>): SecretScope {
  return { scopeType: 'workspace', workspace: row.workspace }
}

function putSecret(row: Pick<McpServerRow, 'id' | 'workspace'>, kind: SecretKind, value: string, actor: number | null): void {
  setSecret({
    scope: scopeOf(row),
    key: mcpSecretKey(row.id, kind),
    value,
    serviceOnly: true,
    actorUserId: actor,
    source: 'server',
    via: 'mcp-server',
    description: `MCP server #${row.id} ${kind.toLowerCase().replace('_', ' ')} (Settings → Integrations)`,
  })
}

function readSecret(row: Pick<McpServerRow, 'id' | 'workspace'>, kind: SecretKind): string | null {
  return getSecretValue(scopeOf(row), mcpSecretKey(row.id, kind), null, 'server')
}

function hasSecret(row: Pick<McpServerRow, 'id' | 'workspace'>, kind: SecretKind): boolean {
  return getSecret(scopeOf(row), mcpSecretKey(row.id, kind)) !== null
}

function dropSecret(row: Pick<McpServerRow, 'id' | 'workspace'>, kind: SecretKind, actor: number | null): void {
  deleteSecret(scopeOf(row), mcpSecretKey(row.id, kind), actor, 'server')
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Server keys that already mean something in a session's MCP config. */
const RESERVED_SLUGS = new Set(['playwright', 'google-workspace', 'command-center', 'cc', 'knowledge', 'claude', 'codex', 'grok'])

export function slugifyName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  const s = base || 'mcp'
  return RESERVED_SLUGS.has(s) ? `${s}-mcp` : s
}

function uniqueSlug(workspace: string, name: string): string {
  const base = slugifyName(name)
  const taken = new Set(
    (getDb().prepare('SELECT slug FROM workspace_mcp_servers WHERE workspace = ?').all(workspace) as Array<{ slug: string }>).map(r => r.slug),
  )
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const s = `${base.slice(0, 36)}-${n}`
    if (!taken.has(s)) return s
  }
  return `${base.slice(0, 30)}-${Date.now() % 100000}`
}

const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'content-type', 'accept', 'connection', 'transfer-encoding', 'cookie', 'mcp-session-id', 'mcp-protocol-version'])

export function normalizeHeaderName(raw: string | null | undefined): string {
  const h = (raw ?? '').trim() || 'Authorization'
  if (!HEADER_NAME_RE.test(h) || FORBIDDEN_HEADERS.has(h.toLowerCase())) {
    throw new McpServerInputError(`"${h}" cannot be used as the API key header.`)
  }
  return h
}

/** Does this pasted Authorization value already carry a scheme ("Bearer x", "Token x")? */
export function hasAuthScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._~+-]*\s+\S/.test(value.trim())
}

/**
 * The header a request should carry, built from the stored token. For
 * `Authorization`, a bare key becomes `Bearer <key>`; a pasted value that
 * already has a scheme is sent as-is.
 */
export function authHeaderFor(headerName: string, token: string): { name: string; value: string; bearer: boolean } {
  if (headerName.toLowerCase() === 'authorization') {
    const t = token.trim()
    if (hasAuthScheme(t)) return { name: 'Authorization', value: t, bearer: /^bearer\s/i.test(t) }
    return { name: 'Authorization', value: `Bearer ${t}`, bearer: true }
  }
  return { name: headerName, value: token.trim(), bearer: false }
}

function parseTools(json: string): StoredTool[] {
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? (v as StoredTool[]).filter(t => t && typeof t.name === 'string') : []
  } catch {
    return []
  }
}

export function disabledToolsOf(row: Pick<McpServerRow, 'disabled_tools_json'>): string[] {
  try {
    const v = JSON.parse(row.disabled_tools_json) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function enabledToolsOf(row: McpServerRow): StoredTool[] {
  const off = new Set(disabledToolsOf(row))
  return parseTools(row.tools_json).filter(t => !off.has(t.name))
}

export class McpServerInputError extends Error {}

export function toSummary(row: McpServerRow): McpServerSummary {
  const off = new Set(disabledToolsOf(row))
  const tools: McpServerTool[] = parseTools(row.tools_json).map(t => ({ name: t.name, description: t.description, enabled: !off.has(t.name) }))
  return {
    id: row.id,
    workspace: row.workspace,
    slug: row.slug,
    name: row.name,
    url: row.url,
    transport: row.transport,
    detected_transport: row.detected_transport,
    auth_type: row.auth_type,
    auth_header_name: row.auth_type === 'api_key' ? row.auth_header_name ?? 'Authorization' : null,
    oauth_registration: row.oauth_registration,
    oauth_issuer: row.oauth_issuer,
    oauth_client_id: row.oauth_registration === 'cimd' ? null : row.oauth_client_id,
    has_credential: row.auth_type === 'none' ? false : hasSecret(row, 'ACCESS_TOKEN'),
    has_refresh_token: row.auth_type === 'oauth' ? hasSecret(row, 'REFRESH_TOKEN') : false,
    token_expires_at: row.token_expires_at,
    catalog_id: row.catalog_id,
    status: row.status,
    enabled: Number(row.enabled) > 0,
    server_name: row.server_name,
    server_version: row.server_version,
    protocol_version: row.protocol_version,
    tools,
    last_tested_at: row.last_tested_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export function getServerRow(id: number): McpServerRow | null {
  return (getDb().prepare('SELECT * FROM workspace_mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined) ?? null
}

/** Rows of ONE workspace. A null/empty workspace has no servers — never "all". */
export function listServerRows(workspace: string | null | undefined): McpServerRow[] {
  if (!workspace) return []
  return getDb().prepare('SELECT * FROM workspace_mcp_servers WHERE workspace = ? ORDER BY name COLLATE NOCASE, id').all(workspace) as McpServerRow[]
}

export function workspaceExists(workspace: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM workspaces WHERE slug = ?').get(workspace)
}

export interface CreateServerInput {
  workspace: string
  name: string
  url: string
  transport?: McpServerTransport
  auth_type: McpServerAuthType
  auth_header_name?: string
  api_key?: string
  oauth_client_id?: string
  oauth_client_secret?: string
  oauth_scope?: string
  catalog_id?: string
  /** From a prior detectAuth() — fills the OAuth endpoints. */
  detected?: Extract<DetectedAuth, { auth: 'oauth' }> | null
}

const TRANSPORTS: McpServerTransport[] = ['auto', 'streamable_http', 'sse']
const AUTH_TYPES: McpServerAuthType[] = ['none', 'api_key', 'oauth']

export function createServer(input: CreateServerInput, actorUserId: number | null): McpServerRow {
  const workspace = (input.workspace ?? '').trim()
  if (!workspace || !workspaceExists(workspace)) throw new McpServerInputError(`Unknown workspace "${workspace}".`)
  const name = (input.name ?? '').trim().slice(0, 80)
  if (!name) throw new McpServerInputError('Give the server a name.')
  const check = validateMcpUrl(input.url)
  if (!check.ok) throw new McpServerInputError(check.error)
  const url = check.url.toString()
  const transport = input.transport ?? 'auto'
  if (!TRANSPORTS.includes(transport)) throw new McpServerInputError(`Unknown transport "${transport}".`)
  if (!AUTH_TYPES.includes(input.auth_type)) throw new McpServerInputError(`Unknown auth type "${input.auth_type}".`)

  let headerName: string | null = null
  if (input.auth_type === 'api_key') {
    headerName = normalizeHeaderName(input.auth_header_name)
    if (!input.api_key || !input.api_key.trim()) throw new McpServerInputError('Paste the API key or token.')
    if (input.api_key.length > 8192 || /[\r\n]/.test(input.api_key)) throw new McpServerInputError('That key is not a valid header value.')
  }

  let registration: McpOAuthRegistration | null = null
  if (input.auth_type === 'oauth') {
    const d = input.detected
    if (!d) throw new McpServerInputError('Run "Detect" first so the OAuth endpoints are known.')
    registration = d.registration
    if (registration === 'manual' && !(input.oauth_client_id ?? '').trim()) {
      throw new McpServerInputError('This server does not support automatic client registration. Register an app with the provider and paste its client ID.')
    }
  }
  const catalogId = input.catalog_id && /^[a-z0-9-]{1,60}$/.test(input.catalog_id) ? input.catalog_id : null
  const d = input.detected ?? null

  const db = getDb()
  const slug = uniqueSlug(workspace, name)
  const info = db
    .prepare(
      `INSERT INTO workspace_mcp_servers
        (workspace, slug, name, url, transport, auth_type, auth_header_name, catalog_id,
         oauth_registration, oauth_issuer, oauth_authorization_endpoint, oauth_token_endpoint,
         oauth_client_id, oauth_scope, oauth_resource, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      workspace, slug, name, url, transport, input.auth_type, headerName, catalogId,
      registration,
      d?.issuer ?? null,
      d?.authorization_endpoint ?? null,
      d?.token_endpoint ?? null,
      registration === 'manual' ? (input.oauth_client_id ?? '').trim().slice(0, 500) : null,
      (input.oauth_scope ?? '').trim().slice(0, 1000) || d?.challenge_scope || null,
      d?.resource ?? null,
      input.auth_type === 'oauth' ? 'needs_auth' : 'pending',
      actorUserId,
    )
  const row = getServerRow(Number(info.lastInsertRowid))!
  try {
    if (input.auth_type === 'api_key') putSecret(row, 'ACCESS_TOKEN', input.api_key!.trim(), actorUserId)
    if (registration === 'manual' && input.oauth_client_secret?.trim()) {
      putSecret(row, 'CLIENT_SECRET', input.oauth_client_secret.trim(), actorUserId)
    }
  } catch (err) {
    db.prepare('DELETE FROM workspace_mcp_servers WHERE id = ?').run(row.id)
    throw err
  }
  return row
}

export interface UpdateServerInput {
  name?: string
  enabled?: boolean
  /** Replace the per-tool opt-out list. */
  disabled_tools?: string[]
  /** api_key servers: replace the stored key. */
  api_key?: string
}

export function updateServer(id: number, patch: UpdateServerInput, actorUserId: number | null): McpServerRow {
  const row = getServerRow(id)
  if (!row) throw new McpServerInputError('No such MCP server.')
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch.name !== undefined) {
    const n = patch.name.trim().slice(0, 80)
    if (!n) throw new McpServerInputError('Give the server a name.')
    sets.push('name = ?'); vals.push(n)
  }
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0) }
  if (patch.disabled_tools !== undefined) {
    if (!Array.isArray(patch.disabled_tools) || patch.disabled_tools.some(t => typeof t !== 'string' || t.length > 128)) {
      throw new McpServerInputError('disabled_tools must be a list of tool names.')
    }
    sets.push('disabled_tools_json = ?'); vals.push(JSON.stringify([...new Set(patch.disabled_tools)].slice(0, 1000)))
  }
  if (patch.api_key !== undefined) {
    if (row.auth_type !== 'api_key') throw new McpServerInputError('This server does not use an API key.')
    if (!patch.api_key.trim() || /[\r\n]/.test(patch.api_key)) throw new McpServerInputError('Paste the API key or token.')
    putSecret(row, 'ACCESS_TOKEN', patch.api_key.trim(), actorUserId)
    sets.push("status = 'pending'", 'last_error = NULL')
  }
  if (sets.length > 0) {
    sets.push("updated_at = datetime('now')")
    getDb().prepare(`UPDATE workspace_mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  }
  return getServerRow(id)!
}

/**
 * Disconnect: remove the row AND every local credential (access token, refresh
 * token, API key, client secret) from the secrets store. Sessions spawned after
 * this no longer get the server; the store's audit log records each delete.
 */
export function deleteServer(id: number, actorUserId: number | null): boolean {
  const row = getServerRow(id)
  if (!row) return false
  for (const k of ['ACCESS_TOKEN', 'REFRESH_TOKEN', 'CLIENT_SECRET'] as SecretKind[]) dropSecret(row, k, actorUserId)
  getDb().prepare('DELETE FROM workspace_mcp_servers WHERE id = ?').run(id)
  return true
}

function markResult(id: number, fields: Partial<Pick<McpServerRow, 'status' | 'last_error' | 'server_name' | 'server_version' | 'protocol_version' | 'detected_transport' | 'tools_json'>> & { tested?: boolean }): void {
  const sets: string[] = ["updated_at = datetime('now')"]
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'tested') continue
    sets.push(`${k} = ?`); vals.push(v)
  }
  if (fields.tested) sets.push("last_tested_at = datetime('now')")
  getDb().prepare(`UPDATE workspace_mcp_servers SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
}

// ── OAuth ────────────────────────────────────────────────────────────────────

export function mcpOAuthRedirectUri(): string {
  return `${appBaseUrl()}/api/mcp-servers/oauth/callback`
}

/** This install's CIMD client_id URL for workspace MCP servers. */
export function mcpCimdClientId(): string {
  return `${appBaseUrl()}/api/mcp-servers/oauth/client-metadata`
}

export function mcpClientMetadataDocument(): ClientMetadataDocument & { client_id: string; client_uri: string } {
  return {
    client_id: mcpCimdClientId(),
    client_uri: appBaseUrl(),
    ...buildClientMetadataDocument({ clientName: 'Command Center', redirectUri: mcpOAuthRedirectUri() }),
  }
}

function metadataFor(row: McpServerRow): AuthServerMetadata {
  return {
    issuer: row.oauth_issuer ?? '',
    authorization_endpoint: row.oauth_authorization_endpoint ?? '',
    token_endpoint: row.oauth_token_endpoint ?? '',
  }
}

const STATE_PREFIX = 'mcp-server:'

export type OAuthStartOutcome = { ok: true; redirectUrl: string } | { ok: false; error: string }

/**
 * Begin the authorization-code + PKCE flow. Registers a client first when the
 * server supports CIMD (client_id = our metadata URL) or DCR (POST to its
 * registration endpoint, from re-fetched metadata so a stale registration
 * endpoint is never trusted); the manual path uses the client the admin pasted.
 */
export async function startOAuth(id: number, userId: number): Promise<OAuthStartOutcome> {
  const row = getServerRow(id)
  if (!row || row.auth_type !== 'oauth') return { ok: false, error: 'This server does not use OAuth.' }
  if (!row.oauth_authorization_endpoint || !row.oauth_token_endpoint) return { ok: false, error: 'OAuth endpoints are missing. Remove the server and connect it again.' }
  if (!validateMcpUrl(row.oauth_authorization_endpoint).ok) return { ok: false, error: 'The server advertised an unsafe authorization URL.' }

  let clientId = row.oauth_client_id
  if (row.oauth_registration === 'cimd') {
    clientId = mcpCimdClientId()
  } else if (row.oauth_registration === 'dcr' && !clientId) {
    const metadata = row.oauth_issuer ? await discoverIssuerMetadata(row.oauth_issuer, fetchImpl) : null
    if (!metadata?.registration_endpoint) return { ok: false, error: 'The server no longer advertises a registration endpoint.' }
    const reg = await registerDynamicClient(
      metadata,
      { client_name: 'Command Center', redirect_uris: [mcpOAuthRedirectUri()], ...(row.oauth_scope ? { scope: row.oauth_scope } : {}) },
      fetchImpl,
    )
    if (!reg.ok) return { ok: false, error: reg.error }
    clientId = reg.data.client_id
    getDb().prepare("UPDATE workspace_mcp_servers SET oauth_client_id = ?, updated_at = datetime('now') WHERE id = ?").run(clientId, id)
    if (reg.data.client_secret) putSecret(row, 'CLIENT_SECRET', reg.data.client_secret, userId)
  }
  if (!clientId) return { ok: false, error: 'No OAuth client ID. Paste the client ID from your app registration.' }

  const verifier = generatePkceVerifier()
  const state = signDcrState(userId, `${STATE_PREFIX}${id}`, verifier)
  const redirectUrl = buildAuthorizationUrl(metadataFor(row), {
    clientId,
    redirectUri: mcpOAuthRedirectUri(),
    scope: row.oauth_scope ?? undefined,
    state,
    codeChallenge: pkceChallengeFromVerifier(verifier),
    resource: row.oauth_resource ?? row.url,
  })
  return { ok: true, redirectUrl }
}

/** Server id a callback `state` claims, BEFORE verification (used to pick the expected binding). */
export function serverIdFromState(state: string): number | null {
  const decoded = jwt.decode(state) as { connector?: unknown } | null
  const c = typeof decoded?.connector === 'string' ? decoded.connector : ''
  if (!c.startsWith(STATE_PREFIX)) return null
  const id = Number(c.slice(STATE_PREFIX.length))
  return Number.isInteger(id) && id > 0 ? id : null
}

function storeTokens(row: McpServerRow, tokens: { access_token: string; refresh_token?: string; expires_in?: number }, actor: number | null): void {
  putSecret(row, 'ACCESS_TOKEN', tokens.access_token, actor)
  if (typeof tokens.refresh_token === 'string' && tokens.refresh_token) putSecret(row, 'REFRESH_TOKEN', tokens.refresh_token, actor)
  const expiresAt = typeof tokens.expires_in === 'number' && tokens.expires_in > 0
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null
  getDb().prepare("UPDATE workspace_mcp_servers SET token_expires_at = ?, status = 'pending', last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(expiresAt, row.id)
}

export type OAuthCompleteOutcome = { ok: true; serverId: number } | { ok: false; serverId: number | null; error: string }

export async function completeOAuth(state: string, code: string): Promise<OAuthCompleteOutcome> {
  const id = serverIdFromState(state)
  if (!id) return { ok: false, serverId: null, error: 'invalid_state' }
  const payload = verifyDcrState(state, `${STATE_PREFIX}${id}`)
  if (!payload) return { ok: false, serverId: id, error: 'invalid_state' }
  const row = getServerRow(id)
  if (!row || row.auth_type !== 'oauth') return { ok: false, serverId: id, error: 'server_removed' }
  const clientId = row.oauth_registration === 'cimd' ? mcpCimdClientId() : row.oauth_client_id
  if (!clientId) return { ok: false, serverId: id, error: 'no_client' }
  const result = await exchangeAuthorizationCode(
    metadataFor(row),
    {
      code,
      redirectUri: mcpOAuthRedirectUri(),
      clientId,
      clientSecret: readSecret(row, 'CLIENT_SECRET') ?? undefined,
      codeVerifier: payload.verifier,
      resource: row.oauth_resource ?? row.url,
    },
    fetchImpl,
  )
  if (!result.ok) {
    markResult(id, { status: 'needs_auth', last_error: result.error })
    return { ok: false, serverId: id, error: result.error }
  }
  storeTokens(row, result.data, payload.uid)
  return { ok: true, serverId: id }
}

const refreshing = new Map<number, Promise<boolean>>()

/** Refresh when the access token expires within this window. */
const REFRESH_WINDOW_MS = 5 * 60_000

export function needsRefresh(row: Pick<McpServerRow, 'auth_type' | 'token_expires_at'>, now = Date.now(), windowMs = REFRESH_WINDOW_MS): boolean {
  if (row.auth_type !== 'oauth' || !row.token_expires_at) return false
  const t = Date.parse(row.token_expires_at)
  return Number.isFinite(t) && t - now < windowMs
}

/**
 * Refresh an OAuth access token with its refresh token. One refresh per server
 * at a time (rotating refresh tokens would otherwise invalidate each other).
 * Returns true when a usable access token is stored afterwards.
 */
export function refreshServerToken(id: number): Promise<boolean> {
  const inflight = refreshing.get(id)
  if (inflight) return inflight
  const p = (async () => {
    const row = getServerRow(id)
    if (!row || row.auth_type !== 'oauth') return false
    const refreshToken = readSecret(row, 'REFRESH_TOKEN')
    const clientId = row.oauth_registration === 'cimd' ? mcpCimdClientId() : row.oauth_client_id
    if (!refreshToken || !clientId || !row.oauth_token_endpoint) {
      markResult(id, { status: 'needs_auth', last_error: 'The sign-in expired. Reconnect to sign in again.' })
      return false
    }
    const result = await refreshAccessToken(
      metadataFor(row),
      { refreshToken, clientId, clientSecret: readSecret(row, 'CLIENT_SECRET') ?? undefined, resource: row.oauth_resource ?? row.url },
      fetchImpl,
    )
    if (!result.ok) {
      markResult(id, { status: 'needs_auth', last_error: `Token refresh failed: ${result.error} Reconnect to sign in again.` })
      return false
    }
    storeTokens(row, result.data, null)
    // storeTokens resets status to pending; a refresh does not change what the server offers.
    getDb().prepare("UPDATE workspace_mcp_servers SET status = CASE WHEN tools_json != '[]' THEN 'connected' ELSE status END WHERE id = ?").run(id)
    return true
  })().finally(() => refreshing.delete(id))
  refreshing.set(id, p)
  return p
}

/** Refresh every OAuth token about to expire (host daemon tick). */
export async function refreshExpiringTokens(windowMs = 15 * 60_000): Promise<number> {
  const rows = getDb()
    .prepare("SELECT * FROM workspace_mcp_servers WHERE auth_type = 'oauth' AND enabled = 1 AND token_expires_at IS NOT NULL")
    .all() as McpServerRow[]
  let n = 0
  for (const row of rows) {
    if (!needsRefresh(row, Date.now(), windowMs)) continue
    if (!hasSecret(row, 'REFRESH_TOKEN')) continue
    if (await refreshServerToken(row.id).catch(() => false)) n++
  }
  return n
}

let refresher: NodeJS.Timeout | null = null
/** Host-only: keep OAuth tokens fresh so sessions spawn with a live token. */
export function startMcpTokenRefresher(intervalMs = 5 * 60_000): void {
  if (refresher) return
  refresher = setInterval(() => {
    refreshExpiringTokens().catch(err => console.warn('[mcp-servers] token refresh tick failed:', (err as Error).message))
  }, intervalMs)
  refresher.unref?.()
}

// ── Credentials for an outbound request (server side only) ───────────────────

/**
 * Headers to call this server with, refreshing an expiring OAuth token first.
 * SERVER-ONLY: the result carries a credential and must never reach a response
 * body or a log line.
 */
export async function requestHeadersFor(row: McpServerRow): Promise<Record<string, string>> {
  if (row.auth_type === 'none') return {}
  if (needsRefresh(row)) await refreshServerToken(row.id)
  const fresh = getServerRow(row.id) ?? row
  const token = readSecret(fresh, 'ACCESS_TOKEN')
  if (!token) return {}
  const h = authHeaderFor(fresh.auth_type === 'api_key' ? fresh.auth_header_name ?? 'Authorization' : 'Authorization', token)
  return { [h.name]: h.value }
}

// ── Test connection ──────────────────────────────────────────────────────────

export type TestOutcome = { ok: true; row: McpServerRow } | { ok: false; kind: McpErrorKind; error: string; row: McpServerRow }

/** initialize + tools/list against the stored credentials; records the result on the row. */
export async function testServer(id: number): Promise<TestOutcome | null> {
  const row = getServerRow(id)
  if (!row) return null
  if (row.auth_type !== 'none' && !hasSecret(row, 'ACCESS_TOKEN')) {
    const error = row.auth_type === 'oauth' ? 'Not signed in yet. Click Sign in to authorize.' : 'No API key is stored.'
    markResult(id, { status: 'needs_auth', last_error: error, tested: true })
    return { ok: false, kind: 'auth_required', error, row: getServerRow(id)! }
  }
  try {
    const headers = await requestHeadersFor(row)
    const probe = await probeMcpServer({ url: row.url, headers, transport: row.transport, fetchImpl })
    markResult(id, {
      status: 'connected',
      last_error: null,
      server_name: probe.server_name,
      server_version: probe.server_version,
      protocol_version: probe.protocol_version,
      detected_transport: probe.transport,
      tools_json: JSON.stringify(probe.tools),
      tested: true,
    })
    return { ok: true, row: getServerRow(id)! }
  } catch (err) {
    const e = err instanceof McpClientError ? err : new McpClientError('unreachable', (err as Error).message)
    const status: McpServerStatus = e.kind === 'auth_failed' || e.kind === 'auth_required' ? 'needs_auth' : 'error'
    markResult(id, { status, last_error: e.message, tested: true })
    return { ok: false, kind: e.kind, error: e.message, row: getServerRow(id)! }
  }
}

/** tools/call for a chat bot. Refuses disabled tools and servers outside `workspace`. */
export async function callServerTool(workspace: string, serverId: number, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const row = getServerRow(serverId)
  if (!row || row.workspace !== workspace || Number(row.enabled) === 0) throw new McpServerInputError('That MCP server is not connected in this workspace.')
  if (!enabledToolsOf(row).some(t => t.name === tool)) throw new McpServerInputError(`Tool "${tool}" is turned off for ${row.name}.`)
  const headers = await requestHeadersFor(row)
  const session = await McpSession.open({ url: row.url, headers, transport: row.detected_transport ?? row.transport, fetchImpl })
  try {
    return await session.callTool(tool, args)
  } finally {
    await session.close()
  }
}

// ── Session wiring (card sessions: Claude / Codex / Grok) ────────────────────

/** Env var a session reads a server's credential from. Not a secrets-store key. */
export function sessionTokenEnvName(id: number): string {
  return `CC_MCP_TOKEN_${id}`
}

/** One remote server as handed to the spawner. No secret: headers reference env vars. */
export interface WorkspaceMcpSpawnServer {
  key: string
  name: string
  url: string
  type: 'http' | 'sse'
  /** Header name → template, e.g. `{ Authorization: 'Bearer ${CC_MCP_TOKEN_3}' }`. */
  headers: Record<string, string>
  /** Env var holding the raw token, when the header is a Bearer token (Codex `bearer_token_env_var`). */
  bearer_env?: string
  /** Header name → env var holding the full header value (Codex `env_http_headers`). */
  env_headers?: Record<string, string>
  disabled_tools: string[]
}

/** Env key carrying the JSON list of `WorkspaceMcpSpawnServer` (no secrets) to spawnInTmux. */
export const WORKSPACE_MCP_ENV = 'CC_WORKSPACE_MCP_SERVERS'

/**
 * What a session spawned for a card in `workspace` gets: env vars holding the
 * access tokens of THAT workspace's enabled, connected servers, plus a
 * descriptor the spawner turns into MCP config. A server in any other
 * workspace contributes nothing — the query is keyed on the workspace, and a
 * card with no workspace gets nothing at all.
 *
 * Sync (the spawn env builder is sync): an OAuth token that is about to expire
 * is handed out as-is and a background refresh is kicked off; the host
 * refresher keeps tokens fresh ahead of time so this is the rare case.
 */
export function spawnEnvFor(workspace: string | null | undefined): Record<string, string> {
  const env: Record<string, string> = {}
  const servers: WorkspaceMcpSpawnServer[] = []
  for (const row of listServerRows(workspace)) {
    if (Number(row.enabled) === 0) continue
    if (row.status !== 'connected') continue
    const type: 'http' | 'sse' = (row.detected_transport ?? row.transport) === 'sse' ? 'sse' : 'http'
    const spawn: WorkspaceMcpSpawnServer = { key: row.slug, name: row.name, url: row.url, type, headers: {}, disabled_tools: disabledToolsOf(row) }
    if (row.auth_type !== 'none') {
      let token: string | null = null
      try { token = readSecret(row, 'ACCESS_TOKEN') } catch { token = null }
      if (!token) continue
      if (needsRefresh(row)) void refreshServerToken(row.id).catch(() => {})
      const envName = sessionTokenEnvName(row.id)
      const h = authHeaderFor(row.auth_type === 'api_key' ? row.auth_header_name ?? 'Authorization' : 'Authorization', token)
      if (h.bearer && h.name === 'Authorization') {
        env[envName] = h.value.replace(/^bearer\s+/i, '')
        spawn.headers = { Authorization: `Bearer \${${envName}}` }
        spawn.bearer_env = envName
      } else {
        env[envName] = h.value
        spawn.headers = { [h.name]: `\${${envName}}` }
        spawn.env_headers = { [h.name]: envName }
      }
    }
    servers.push(spawn)
  }
  if (servers.length > 0) env[WORKSPACE_MCP_ENV] = JSON.stringify(servers)
  return env
}

/** Parse the descriptor back out of a spawn env. Never throws. */
export function parseSpawnDescriptor(env: Record<string, string | undefined>): WorkspaceMcpSpawnServer[] {
  const raw = env[WORKSPACE_MCP_ENV]
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    if (!Array.isArray(v)) return []
    return v.filter((s): s is WorkspaceMcpSpawnServer =>
      !!s && typeof s.key === 'string' && /^[a-z0-9-]{1,48}$/.test(s.key) && typeof s.url === 'string' && (s.type === 'http' || s.type === 'sse'))
  } catch {
    return []
  }
}
