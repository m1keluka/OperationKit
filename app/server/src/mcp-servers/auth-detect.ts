/**
 * Auth auto-detection for a pasted MCP server URL (Sprint 7.8, obj 900620).
 *
 * Follows the MCP Authorization spec's discovery chain, so the person never has
 * to know which kind of server they pasted:
 *
 *   1. Send an unauthenticated `initialize`. A clean answer → no auth needed.
 *   2. HTTP 401 → read `WWW-Authenticate` (RFC 6750 / RFC 9728). Its
 *      `resource_metadata` parameter points at the OAuth Protected Resource
 *      Metadata document; without it we try the well-known locations.
 *   3. The PRM names the authorization server(s). Fetch that server's RFC 8414
 *      metadata (OIDC discovery as a fallback). Older servers that publish no
 *      PRM are tried at their own origin, as the 2025-03-26 spec allowed.
 *   4. connectors/dcr-client.ts decides the registration path from that
 *      metadata — CIMD, else DCR, else none:
 *        cimd / dcr → OAuth with automatic client registration
 *        none       → OAuth with a client the admin registers by hand (guided)
 *   5. A 401 with no OAuth metadata anywhere → an API key / bearer token.
 *
 * Every fetch goes through the SSRF-guarded fetch, including the metadata URLs
 * a server advertises (a hostile server cannot use discovery to reach inside).
 */
import { chooseRegistrationStrategy, type AuthServerMetadata } from '../connectors/dcr-client.js'
import type { SafeFetch } from './safe-fetch.js'
import { McpClientError, probeMcpServer, type McpProbeResult, type McpTransport } from './mcp-client.js'
import { validateMcpUrl } from './url-guard.js'

export interface WwwAuthChallenge {
  scheme: string
  params: Record<string, string>
}

/**
 * Parse a `WWW-Authenticate` header into challenges. Handles quoted strings
 * with escaped quotes and commas, and several challenges in one header.
 */
export function parseWwwAuthenticate(header: string | null | undefined): WwwAuthChallenge[] {
  if (!header) return []
  const out: WwwAuthChallenge[] = []
  let i = 0
  const s = header
  const skipWs = () => { while (i < s.length && /[\s,]/.test(s[i])) i++ }
  const readToken = () => {
    const start = i
    while (i < s.length && /[!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(s[i])) i++
    return s.slice(start, i)
  }
  while (i < s.length) {
    skipWs()
    const scheme = readToken()
    if (!scheme) { i++; continue }
    const challenge: WwwAuthChallenge = { scheme: scheme.toLowerCase(), params: {} }
    out.push(challenge)
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++
      if (s[i] === ',') { i++; while (i < s.length && /\s/.test(s[i])) i++ }
      const save = i
      const key = readToken()
      while (i < s.length && /\s/.test(s[i])) i++
      if (!key || s[i] !== '=') { i = save; break }
      i++ // '='
      while (i < s.length && /\s/.test(s[i])) i++
      let value = ''
      if (s[i] === '"') {
        i++
        while (i < s.length && s[i] !== '"') {
          if (s[i] === '\\' && i + 1 < s.length) i++
          value += s[i++]
        }
        i++ // closing quote
      } else {
        const start = i
        while (i < s.length && s[i] !== ',' && !/\s/.test(s[i])) i++
        value = s.slice(start, i)
      }
      challenge.params[key.toLowerCase()] = value
    }
  }
  return out
}

export function bearerChallenge(header: string | null | undefined): WwwAuthChallenge | null {
  return parseWwwAuthenticate(header).find(c => c.scheme === 'bearer') ?? null
}

export interface ProtectedResourceMetadata {
  resource?: string
  authorization_servers?: string[]
  scopes_supported?: string[]
  [key: string]: unknown
}

async function getJson(url: string, fetchImpl: SafeFetch): Promise<unknown | null> {
  if (!validateMcpUrl(url).ok) return null
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' } })
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return null }
    return await res.json()
  } catch {
    return null
  }
}

/** RFC 9728 well-known URLs for a resource, path-specific first. */
export function protectedResourceMetadataUrls(resourceUrl: string): string[] {
  const u = new URL(resourceUrl)
  const path = u.pathname.replace(/\/+$/, '')
  const urls = [] as string[]
  if (path) urls.push(`${u.origin}/.well-known/oauth-protected-resource${path}`)
  urls.push(`${u.origin}/.well-known/oauth-protected-resource`)
  return urls
}

/** RFC 8414 + OIDC discovery URLs for an issuer, in the MCP spec's priority order. */
export function authServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer)
  const path = u.pathname.replace(/\/+$/, '')
  if (!path) {
    return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`]
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ]
}

export async function fetchProtectedResourceMetadata(
  mcpUrl: string,
  hintedUrl: string | null,
  fetchImpl: SafeFetch,
): Promise<ProtectedResourceMetadata | null> {
  const candidates = hintedUrl ? [hintedUrl, ...protectedResourceMetadataUrls(mcpUrl)] : protectedResourceMetadataUrls(mcpUrl)
  for (const url of candidates) {
    const body = (await getJson(url, fetchImpl)) as ProtectedResourceMetadata | null
    if (body && typeof body === 'object' && Array.isArray(body.authorization_servers)) return body
  }
  return null
}

export async function discoverIssuerMetadata(issuer: string, fetchImpl: SafeFetch): Promise<AuthServerMetadata | null> {
  for (const url of authServerMetadataUrls(issuer)) {
    const body = (await getJson(url, fetchImpl)) as Partial<AuthServerMetadata> | null
    if (body && typeof body.authorization_endpoint === 'string' && typeof body.token_endpoint === 'string') {
      // The endpoints a hostile server advertises must pass the same guard:
      // the browser goes to authorization_endpoint, the server POSTs to the rest.
      if (!validateMcpUrl(body.authorization_endpoint).ok || !validateMcpUrl(body.token_endpoint).ok) return null
      if (body.registration_endpoint && !validateMcpUrl(String(body.registration_endpoint)).ok) {
        delete body.registration_endpoint
      }
      return { issuer: typeof body.issuer === 'string' ? body.issuer : issuer, ...body } as AuthServerMetadata
    }
  }
  return null
}

export type DetectedAuth =
  | { auth: 'none'; probe: McpProbeResult }
  | {
      auth: 'oauth'
      /** cimd/dcr = automatic client registration; manual = the guided wizard (admin registers a client). */
      registration: 'cimd' | 'dcr' | 'manual'
      issuer: string
      authorization_endpoint: string
      token_endpoint: string
      registration_endpoint: string | null
      scopes_supported: string[]
      /** Scope the server asked for in its 401 challenge, if any. */
      challenge_scope: string | null
      /** RFC 8707 resource indicator to request tokens for. */
      resource: string
      metadata: AuthServerMetadata
    }
  | { auth: 'api_key'; reason: string }

export type DetectOutcome =
  | { ok: true; data: DetectedAuth }
  | { ok: false; kind: McpClientError['kind']; error: string }

/**
 * Work out how a server wants to be authenticated. Never throws; never
 * sends a credential (there is none yet).
 */
export async function detectAuth(opts: {
  url: string
  transport?: McpTransport | 'auto'
  fetchImpl: SafeFetch
}): Promise<DetectOutcome> {
  const check = validateMcpUrl(opts.url)
  if (!check.ok) return { ok: false, kind: 'blocked', error: check.error }
  let challengeHeader: string | null = null
  try {
    const probe = await probeMcpServer({ url: opts.url, transport: opts.transport ?? 'auto', fetchImpl: opts.fetchImpl })
    return { ok: true, data: { auth: 'none', probe } }
  } catch (err) {
    if (!(err instanceof McpClientError)) return { ok: false, kind: 'unreachable', error: (err as Error).message }
    if (err.kind !== 'auth_required') return { ok: false, kind: err.kind, error: err.message }
    challengeHeader = err.wwwAuthenticate ?? null
  }

  const challenge = bearerChallenge(challengeHeader)
  const hinted = challenge?.params.resource_metadata ?? null
  const prm = await fetchProtectedResourceMetadata(opts.url, hinted, opts.fetchImpl)
  const issuers = prm?.authorization_servers?.filter(s => typeof s === 'string') ?? []
  // Pre-PRM servers (spec 2025-03-26) host their auth server at their own origin.
  if (issuers.length === 0) issuers.push(new URL(opts.url).origin)

  for (const issuer of issuers.slice(0, 3)) {
    if (!validateMcpUrl(issuer).ok) continue
    const metadata = await discoverIssuerMetadata(issuer, opts.fetchImpl)
    if (!metadata) continue
    const strategy = chooseRegistrationStrategy(metadata)
    return {
      ok: true,
      data: {
        auth: 'oauth',
        registration: strategy === 'none' ? 'manual' : strategy,
        issuer: metadata.issuer || issuer,
        authorization_endpoint: metadata.authorization_endpoint,
        token_endpoint: metadata.token_endpoint,
        registration_endpoint: typeof metadata.registration_endpoint === 'string' ? metadata.registration_endpoint : null,
        scopes_supported: Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported.filter(x => typeof x === 'string') : (prm?.scopes_supported ?? []),
        challenge_scope: challenge?.params.scope ?? null,
        resource: typeof prm?.resource === 'string' && validateMcpUrl(prm.resource).ok ? prm.resource : opts.url,
        metadata,
      },
    }
  }
  return {
    ok: true,
    data: {
      auth: 'api_key',
      reason: prm
        ? 'The server points at an authorization server that publishes no OAuth metadata. Use an API key or token.'
        : 'The server asks for credentials but publishes no OAuth metadata. Use an API key or token.',
    },
  }
}
