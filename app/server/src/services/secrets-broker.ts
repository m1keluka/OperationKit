/**
 * Secrets broker — "use without reveal" (obj 715532).
 *
 * A bot names a secret and an action; the server injects the value and hands
 * back only the (redacted) result. No code path in this module returns a value
 * to its caller: `resolveForUse` returns it to `executeHttp`, which puts it on
 * the outbound request and nowhere else.
 *
 * Policy (which secret may go to which host) is config, not code:
 *   settings key `secrets_broker_policy` (JSON), else env CC_SECRETS_BROKER_POLICY.
 *
 *   {
 *     "SUPABASE_SERVICE_ROLE": {
 *       "hosts": ["*.supabase.co"],          // exact host or "*.suffix" (subdomains only)
 *       "description": "example-platform service role",
 *       "workspaces": ["example"],              // members of these may see/use a GLOBAL secret
 *       "methods": ["GET", "POST"]           // optional; default all
 *     }
 *   }
 *
 * A secret with no policy entry (or no hosts) is LISTED but not usable: default-deny.
 */
import { getDb } from '../db/index.js'
import { decryptSecret } from './secrets-crypto.js'
import { redactText } from './secret-redaction.js'
import { isSeatSecretKey } from './secrets-store.js'

export interface BrokerPolicyEntry {
  hosts: string[]
  description?: string
  workspaces?: string[]
  methods?: string[]
}
export type BrokerPolicy = Record<string, BrokerPolicyEntry>

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function sanitizePolicy(raw: unknown): BrokerPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: BrokerPolicy = {}
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!NAME_RE.test(name) || !v || typeof v !== 'object') continue
    const e = v as Record<string, unknown>
    const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && !!s.trim()).map(s => s.trim()) : [])
    out[name] = {
      hosts: strs(e.hosts).map(h => h.toLowerCase()),
      description: typeof e.description === 'string' ? e.description : undefined,
      workspaces: strs(e.workspaces),
      methods: e.methods === undefined ? undefined : strs(e.methods).map(m => m.toUpperCase()),
    }
  }
  return out
}

export function getBrokerPolicy(): BrokerPolicy {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'secrets_broker_policy'").get() as { value: string } | undefined
    if (row?.value) return sanitizePolicy(JSON.parse(row.value))
  } catch { /* malformed / no settings table → fall through */ }
  const env = process.env.CC_SECRETS_BROKER_POLICY
  if (!env) return {}
  try {
    return sanitizePolicy(JSON.parse(env))
  } catch {
    return {} // malformed policy never widens access
  }
}

/**
 * Host allowlist match. `api.supabase.com` = exact. `*.supabase.co` = any
 * subdomain (NOT the apex, NOT `evil-supabase.co`). No other wildcard forms.
 */
export function hostAllowed(host: string, patterns: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return patterns.some(p => {
    if (p.startsWith('*.')) {
      const suffix = p.slice(1) // ".supabase.co"
      return h.endsWith(suffix) && h.length > suffix.length && !h.slice(0, -suffix.length).includes('*')
    }
    return h === p
  })
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[') || host.includes(':')
}

// ── Visibility ──────────────────────────────────────────────────────────────

export interface Caller {
  userId: number
  isAdmin: boolean
  workspaces: string[]
}

interface Row {
  key: string
  scope_type: 'global' | 'workspace' | 'user' | 'workspace_user'
  workspace: string
  user_id: number
  value_encrypted: string
}

function visibleTo(row: Row, caller: Caller, policy: BrokerPolicy): boolean {
  if (caller.isAdmin) return true
  const ws = new Set(caller.workspaces)
  switch (row.scope_type) {
    case 'global':
      return (policy[row.key]?.workspaces ?? []).some(w => ws.has(w))
    case 'workspace':
      return ws.has(row.workspace)
    case 'user':
      return row.user_id === caller.userId
    case 'workspace_user':
      return row.user_id === caller.userId && ws.has(row.workspace)
  }
}

export interface BrokerListItem {
  name: string
  description: string | null
  scope: Row['scope_type']
  workspace: string | null
  allowed_hosts: string[]
  allowed_methods: string[] | null
  usable: boolean
}

/** Names + metadata only. The SELECT deliberately omits value_encrypted. */
export function listForCaller(caller: Caller, opts: { workspace?: string } = {}): BrokerListItem[] {
  const policy = getBrokerPolicy()
  const rows = getDb()
    .prepare("SELECT key, scope_type, workspace, user_id, '' AS value_encrypted FROM secrets ORDER BY key, scope_type, workspace")
    .all() as Row[]
  return rows
    .filter(r => !isSeatSecretKey(r.key)) // seat credentials never go through the broker
    .filter(r => visibleTo(r, caller, policy))
    .filter(r => !opts.workspace || r.workspace === opts.workspace || r.scope_type === 'global' || r.scope_type === 'user')
    .map(r => {
      const p = policy[r.key]
      return {
        name: r.key,
        description: p?.description ?? null,
        scope: r.scope_type,
        workspace: r.workspace || null,
        allowed_hosts: p?.hosts ?? [],
        allowed_methods: p?.methods ?? null,
        usable: (p?.hosts?.length ?? 0) > 0,
      }
    })
}

const SPECIFICITY: Record<Row['scope_type'], number> = { global: 0, workspace: 1, user: 2, workspace_user: 3 }

/**
 * Most-specific visible row for `name` (workspace_user > user > workspace > global),
 * optionally pinned to one workspace. Returns the plaintext ONLY to executeHttp.
 */
function resolveForUse(name: string, caller: Caller, policy: BrokerPolicy, workspace?: string): { value: string; scope: string; workspace: string | null } | null {
  const rows = (getDb()
    .prepare('SELECT key, scope_type, workspace, user_id, value_encrypted FROM secrets WHERE key = ?')
    .all(name) as Row[])
    .filter(r => !isSeatSecretKey(r.key))
    .filter(r => visibleTo(r, caller, policy))
    .filter(r => !workspace || r.scope_type === 'global' || r.scope_type === 'user' || r.workspace === workspace)
  if (rows.length === 0) return null
  // Rows from several workspaces and no ?workspace pin: ambiguous — fall back to
  // global/user rows rather than guess whose credential to send.
  const wsNames = new Set(rows.filter(r => r.workspace).map(r => r.workspace))
  const candidates = !workspace && wsNames.size > 1 ? rows.filter(r => !r.workspace) : rows
  if (candidates.length === 0) return null
  candidates.sort((a, b) => SPECIFICITY[b.scope_type] - SPECIFICITY[a.scope_type])
  const row = candidates[0]
  return {
    value: decryptSecret(row.value_encrypted),
    scope: row.scope_type === 'global' ? 'global' : `${row.scope_type}:${row.workspace || row.user_id}`,
    workspace: row.workspace || null,
  }
}

// ── Execution ───────────────────────────────────────────────────────────────

export const PLACEHOLDER_RE = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g
const HAS_PLACEHOLDER = /\{\{\s*secret:/

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
const STRIP_REQUEST_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'proxy-authorization', 'te', 'trailer'])
const PASS_RESPONSE_HEADERS = ['content-type', 'content-length', 'location', 'retry-after', 'x-request-id', 'etag', 'last-modified', 'content-range', 'x-total-count']

export interface BrokerHttpRequest {
  method?: unknown
  url?: unknown
  headers?: unknown
  body?: unknown
  workspace?: unknown
}

export interface BrokerHttpOutcome {
  httpStatus: number
  body: Record<string, unknown>
  audit: {
    secrets: string[]
    scopes: string[]
    host: string | null
    method: string
    status: string
    workspace: string | null
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>
let fetchImpl: FetchLike = (url, init) => fetch(url, init)

/** Test seam: route outbound requests to a fake. */
export function setBrokerFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init))
}

function collectNames(s: string, into: Set<string>): void {
  for (const m of s.matchAll(PLACEHOLDER_RE)) into.add(m[1])
}

function substitute(s: string, values: Map<string, string>, jsonEscape = false): string {
  return s.replace(PLACEHOLDER_RE, (_m, name: string) => {
    const v = values.get(name) ?? ''
    return jsonEscape ? JSON.stringify(v).slice(1, -1) : v
  })
}

function walkStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === 'string') return fn(v)
  if (Array.isArray(v)) return v.map(x => walkStrings(x, fn))
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = walkStrings(x, fn)
    return out
  }
  return v
}

const MAX_REQUEST_BODY = 1024 * 1024
export const maxResponseBytes = () => Number(process.env.CC_SECRETS_BROKER_MAX_RESPONSE_BYTES) || 2 * 1024 * 1024
const timeoutMs = () => Number(process.env.CC_SECRETS_BROKER_TIMEOUT_MS) || 30_000

function isTextual(contentType: string): boolean {
  const ct = contentType.toLowerCase()
  return !ct || ct.startsWith('text/') || /json|xml|javascript|x-www-form-urlencoded|graphql|yaml|csv/.test(ct)
}

function reject(httpStatus: number, error: string, audit: BrokerHttpOutcome['audit']): BrokerHttpOutcome {
  return { httpStatus, body: { error }, audit: { ...audit, status: `rejected:${httpStatus}` } }
}

/**
 * Validate, inject, send, redact. Every early return is a rejection whose
 * message names secrets/hosts but never a value.
 */
export async function executeHttp(req: BrokerHttpRequest, caller: Caller): Promise<BrokerHttpOutcome> {
  const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET'
  const workspace = typeof req.workspace === 'string' && req.workspace.trim() ? req.workspace.trim() : undefined
  const audit: BrokerHttpOutcome['audit'] = { secrets: [], scopes: [], host: null, method, status: 'pending', workspace: workspace ?? null }

  if (!ALLOWED_METHODS.has(method)) return reject(400, `method must be one of ${[...ALLOWED_METHODS].join(', ')}`, audit)
  if (workspace && !caller.isAdmin && !caller.workspaces.includes(workspace)) return reject(403, `No access to workspace '${workspace}'`, audit)
  if (typeof req.url !== 'string' || !req.url) return reject(400, 'url is required', audit)

  // Placeholders are resolved AFTER parsing the template URL's host, so a
  // secret value can never change where the request goes.
  let template: URL
  try {
    template = new URL(req.url.replace(PLACEHOLDER_RE, 'x'))
  } catch {
    return reject(400, 'url is not a valid absolute URL', audit)
  }
  if (template.protocol !== 'https:') return reject(400, 'only https:// destinations are allowed', audit)
  if (template.username || template.password) return reject(400, 'credentials in the URL authority are not allowed; use a header placeholder', audit)
  const host = template.hostname.toLowerCase()
  audit.host = host
  if (template.port && template.port !== '443') return reject(400, 'non-default ports are not allowed', audit)
  // Same template with a different stand-in: if the host moves, a placeholder sits in it.
  try {
    if (new URL(req.url.replace(PLACEHOLDER_RE, 'y')).host !== template.host) return reject(400, 'placeholders are not allowed in the host', audit)
  } catch {
    return reject(400, 'placeholders are not allowed in the host', audit)
  }

  // Headers: plain string → string map, placeholders only in values.
  const headers: Record<string, string> = {}
  if (req.headers !== undefined) {
    if (!req.headers || typeof req.headers !== 'object' || Array.isArray(req.headers)) return reject(400, 'headers must be an object of strings', audit)
    for (const [k, v] of Object.entries(req.headers as Record<string, unknown>)) {
      if (typeof v !== 'string') return reject(400, `header '${k}' must be a string`, audit)
      if (HAS_PLACEHOLDER.test(k)) return reject(400, 'placeholders are not allowed in header names', audit)
      if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue
      headers[k] = v
    }
  }

  const names = new Set<string>()
  collectNames(req.url, names)
  for (const v of Object.values(headers)) collectNames(v, names)
  let bodyIsJson = false
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') collectNames(req.body, names)
    else if (typeof req.body === 'object') {
      bodyIsJson = true
      walkStrings(req.body, s => { collectNames(s, names); return s })
    } else return reject(400, 'body must be a string or JSON value', audit)
  }
  audit.secrets = [...names].sort()
  if (names.size === 0) return reject(400, 'no {{secret:NAME}} placeholder found — the broker only proxies requests that use a secret', audit)
  if (names.size > 5) return reject(400, 'at most 5 secrets per request', audit)
  if (method === 'GET' || method === 'HEAD') {
    if (req.body !== undefined && req.body !== null) return reject(400, `${method} requests cannot carry a body`, audit)
  }

  // Policy + visibility per secret. IP literals only if listed exactly.
  const policy = getBrokerPolicy()
  const values = new Map<string, string>()
  const redactMap = new Map<string, string>()
  for (const name of names) {
    const p = policy[name]
    const resolved = resolveForUse(name, caller, policy, workspace)
    if (!resolved) return reject(404, `secret '${name}' does not exist or is not visible to this key`, audit)
    if (!p || p.hosts.length === 0) return reject(403, `secret '${name}' has no allowed destination hosts configured`, audit)
    if (isIpLiteral(host) ? !p.hosts.includes(host) : !hostAllowed(host, p.hosts)) {
      return reject(403, `destination host '${host}' is not allowed for secret '${name}' (allowed: ${p.hosts.join(', ')})`, audit)
    }
    if (p.methods && p.methods.length && !p.methods.includes(method)) return reject(403, `method ${method} is not allowed for secret '${name}'`, audit)
    values.set(name, resolved.value)
    audit.scopes.push(`${name}@${resolved.scope}`)
    if (!audit.workspace && resolved.workspace) audit.workspace = resolved.workspace
    if (resolved.value) {
      redactMap.set(resolved.value, name)
      redactMap.set(encodeURIComponent(resolved.value), name)
      redactMap.set(JSON.stringify(resolved.value).slice(1, -1), name)
      redactMap.set(Buffer.from(resolved.value).toString('base64'), name)
    }
  }

  const url = substitute(req.url, values)
  for (const k of Object.keys(headers)) headers[k] = substitute(headers[k], values)
  let body: string | undefined
  if (req.body !== undefined && req.body !== null) {
    body = bodyIsJson
      ? JSON.stringify(walkStrings(req.body, s => substitute(s, values)))
      : substitute(req.body as string, values)
    if (bodyIsJson && !Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
    if (Buffer.byteLength(body) > MAX_REQUEST_BODY) return reject(413, 'request body too large', audit)
  }
  // Final guard: the substituted URL must still point at the validated host.
  try {
    if (new URL(url).hostname.toLowerCase() !== host) return reject(400, 'url host changed after substitution', audit)
  } catch {
    return reject(400, 'url is not valid after substitution', audit)
  }

  const scrub = (s: string) => redactText(s, redactMap)
  let upstream: Response
  try {
    upstream = await fetchImpl(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs()) })
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error'
    audit.status = 'upstream_error'
    return { httpStatus: 502, body: { error: 'upstream request failed', detail: scrub(msg).text }, audit }
  }

  const outHeaders: Record<string, string> = {}
  let redactions = 0
  for (const h of PASS_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h)
    if (v === null) continue
    const r = scrub(v)
    redactions += r.count
    outHeaders[h] = r.text
  }
  const contentType = upstream.headers.get('content-type') ?? ''
  let text: string | null = null
  let truncated = false
  let omitted: string | null = null
  if (method !== 'HEAD') {
    if (!isTextual(contentType)) {
      omitted = 'binary response bodies are not returned (they cannot be redacted)'
      try { await upstream.body?.cancel() } catch { /* ignore */ }
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer())
      const cap = maxResponseBytes()
      truncated = buf.length > cap
      const r = scrub(buf.subarray(0, cap).toString('utf-8'))
      redactions += r.count
      text = r.text
    }
  }
  audit.status = String(upstream.status)
  return {
    httpStatus: 200,
    body: {
      status: upstream.status,
      status_text: upstream.statusText,
      headers: outHeaders,
      body: text,
      body_truncated: truncated,
      ...(omitted ? { body_omitted: omitted } : {}),
      redacted: true,
      redaction_count: redactions,
      secrets_used: audit.secrets,
    },
    audit,
  }
}
