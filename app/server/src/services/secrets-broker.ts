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
import { isServerOnlySecretKey, logAccess, touchLastUsed } from './secrets-store.js'
import { MIN_SECRET_LEN, redactText } from './secret-redaction.js'
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
  return readBrokerPolicy().policy
}

/** Where the effective policy came from — the Secrets UI shows it. */
export type BrokerPolicySource = 'settings' | 'env' | 'none'

export function readBrokerPolicy(): { policy: BrokerPolicy; source: BrokerPolicySource } {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'secrets_broker_policy'").get() as { value: string } | undefined
    if (row?.value) return { policy: sanitizePolicy(JSON.parse(row.value)), source: 'settings' }
  } catch { /* malformed / no settings table → fall through */ }
  const env = process.env.CC_SECRETS_BROKER_POLICY
  if (!env) return { policy: {}, source: 'none' }
  try {
    return { policy: sanitizePolicy(JSON.parse(env)), source: 'env' }
  } catch {
    return { policy: {}, source: 'none' } // malformed policy never widens access
  }
}

// ── Policy editing (obj 900749) ─────────────────────────────────────────────
//
// The Secrets page edits ONE secret's "bot access" entry at a time. That writes
// the `secrets_broker_policy` settings row only — never a secret row, never a
// value. A name with no entry stays default-deny. The first write copies an
// env-sourced policy into settings so nothing configured there is dropped.

/** Exact host (`api.example.com`) or a subdomain wildcard (`*.example.com`). Lowercase, ≥ 2 labels. */
const HOST_PATTERN_RE = /^(\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/
const POLICY_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']
const WS_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const MAX_POLICY_HOSTS = 20

export class BrokerPolicyError extends Error {}

/**
 * Domains where anyone can get a subdomain (public suffixes and shared hosting).
 * A wildcard over one would let a bot send the secret to a host an attacker
 * controls, so the UI only accepts an exact host there. Not exhaustive — the
 * exact-host habit is the real defence; this catches the common traps.
 */
const SHARED_SUFFIXES = new Set([
  'supabase.co', 'supabase.in', 'vercel.app', 'netlify.app', 'herokuapp.com', 'workers.dev', 'pages.dev',
  'github.io', 'gitlab.io', 'appspot.com', 'web.app', 'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net',
  'amazonaws.com', 'fly.dev', 'onrender.com', 'railway.app', 'up.railway.app', 'ngrok.io', 'ngrok-free.app', 'ngrok.app',
  'repl.co', 'replit.dev', 'glitch.me', 'deno.dev', 'run.app', 'cloudfunctions.net', 'blob.core.windows.net',
  'trycloudflare.com', 'r2.dev', 'webflow.io', 'framer.app', 'bubbleapps.io', 'myshopify.com', 'wixsite.com',
  'blogspot.com', 'wordpress.com', 'pipedream.net', 'requestbin.net', 'webhook.site', 'n8n.cloud',
])
const SECOND_LEVEL_PUBLIC = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu', 'ltd', 'plc', 'me', 'or', 'ne', 'go'])

export function isSharedSuffix(suffix: string): boolean {
  const s = suffix.toLowerCase()
  for (const shared of SHARED_SUFFIXES) if (s === shared || s.endsWith(`.${shared}`)) return true
  const labels = s.split('.')
  // co.uk, com.au, org.br … : a two-label public suffix.
  return labels.length === 2 && SECOND_LEVEL_PUBLIC.has(labels[0]!) && labels[1]!.length === 2
}

/** Validate one hand-typed entry. Throws BrokerPolicyError with a readable reason. */
export function validatePolicyEntry(input: unknown): BrokerPolicyEntry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new BrokerPolicyError('body must be an object')
  const b = input as Record<string, unknown>
  const list = (v: unknown, field: string): string[] => {
    if (v === undefined || v === null) return []
    const arr = typeof v === 'string' ? v.split(/[\s,]+/) : v
    if (!Array.isArray(arr) || arr.some(x => typeof x !== 'string')) throw new BrokerPolicyError(`${field} must be a list of strings`)
    return [...new Set((arr as string[]).map(s => s.trim()).filter(Boolean))]
  }
  const hosts = list(b.hosts, 'hosts').map(h => h.toLowerCase().replace(/\.$/, ''))
  if (hosts.length === 0) throw new BrokerPolicyError('add at least one destination host (or turn bot access off)')
  if (hosts.length > MAX_POLICY_HOSTS) throw new BrokerPolicyError(`at most ${MAX_POLICY_HOSTS} hosts`)
  for (const h of hosts) {
    if (h.includes('://') || h.includes('/')) throw new BrokerPolicyError(`'${h}': give a host name only, without https:// or a path`)
    if (IPV4_RE.test(h)) continue // only ever matched exactly (see executeHttp)
    // "*.com" would match every .com host. A wildcard needs a registrable name under it.
    if (h.startsWith('*.') && /^[a-z0-9-]+$/.test(h.slice(2))) throw new BrokerPolicyError(`'${h}' is too broad — name the domain, e.g. *.example.com`)
    if (!HOST_PATTERN_RE.test(h)) throw new BrokerPolicyError(`'${h}' is not a host name. Use api.example.com, or *.example.com for its subdomains`)
    if (h.startsWith('*.') && isSharedSuffix(h.slice(2))) {
      throw new BrokerPolicyError(`'${h}' is too broad — anyone can get a host under ${h.slice(2)}. List the exact host instead (e.g. yourproject.${h.slice(2)})`)
    }
  }
  const methods = list(b.methods, 'methods').map(m => m.toUpperCase())
  for (const m of methods) if (!POLICY_METHODS.includes(m)) throw new BrokerPolicyError(`method '${m}' must be one of ${POLICY_METHODS.join(', ')}`)
  const workspaces = list(b.workspaces, 'workspaces')
  for (const w of workspaces) if (!WS_SLUG_RE.test(w)) throw new BrokerPolicyError(`'${w}' is not a workspace slug`)
  let description: string | undefined
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== 'string') throw new BrokerPolicyError('description must be a string')
    description = b.description.trim().slice(0, 200) || undefined
  }
  return {
    hosts,
    ...(description ? { description } : {}),
    ...(workspaces.length ? { workspaces } : {}),
    ...(methods.length ? { methods } : {}),
  }
}

/**
 * Set (entry) or clear (null) one secret's bot-access entry. Returns the new
 * effective policy. Writes the settings row only.
 */
export function setBrokerPolicyEntry(name: string, entry: BrokerPolicyEntry | null): BrokerPolicy {
  if (!NAME_RE.test(name)) throw new BrokerPolicyError('invalid secret name')
  const next: BrokerPolicy = { ...readBrokerPolicy().policy }
  if (entry) next[name] = entry
  else delete next[name]
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES ('secrets_broker_policy', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(next))
  return getBrokerPolicy()
}

/**
 * Host allowlist match. `api.supabase.com` = exact. `*.supabase.co` = any
 * subdomain (NOT the apex, NOT `evil-supabase.co`). No other wildcard forms.
 */
/** Seat credentials and server-only / MCP-connection secrets never go through the broker. */
export function isBrokerableSecretKey(name: string): boolean {
  return !isSeatSecretKey(name) && !isServerOnlySecretKey(name)
}

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
  /**
   * A bot (named agent key / in-app chat bot), as opposed to a person or a
   * worker session (obj 900749). Bots may not use a value too short for the
   * redactor to recognise, since their replies feed an LLM.
   */
  bot?: boolean
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
    .filter(r => !isServerOnlySecretKey(r.key))
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
function resolveForUse(name: string, caller: Caller, policy: BrokerPolicy, workspace?: string): { id: number; value: string; scope: string; workspace: string | null } | null {
  if (isServerOnlySecretKey(name)) return null
  const rows = (getDb()
    .prepare('SELECT id, key, scope_type, workspace, user_id, value_encrypted FROM secrets WHERE key = ?')
    .all(name) as (Row & { id: number })[])
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
    id: row.id,
    value: decryptSecret(row.value_encrypted),
    scope: row.scope_type === 'global' ? 'global' : `${row.scope_type}:${row.workspace || row.user_id}`,
    workspace: row.workspace || null,
  }
}

// ── Execution ───────────────────────────────────────────────────────────────

/**
 * Every form of an injected value the reply is scrubbed for (obj 900749):
 * raw, URL-encoded, JSON-escaped, hex, and base64 / base64url at all three
 * byte alignments. An upstream that stores "X{{secret:K}}" and hands it back
 * base64-encoded puts the value at an arbitrary offset in the stream; the core
 * characters that depend only on the value's own bytes are the same for a given
 * offset mod 3, so matching those three cores catches it wherever it sits.
 */
export function redactionForms(value: string): string[] {
  const out = new Set<string>([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)])
  const bytes = Buffer.from(value)
  out.add(bytes.toString('hex'))
  out.add(bytes.toString('hex').toUpperCase())
  out.add(bytes.toString('base64'))
  for (let k = 0; k < 3; k++) {
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64')
    const core = b64.slice(Math.ceil((8 * k) / 6), Math.floor((8 * (k + bytes.length)) / 6))
    if (core.length < MIN_SECRET_LEN) continue
    out.add(core)
    out.add(core.replace(/\+/g, '-').replace(/\//g, '_'))
  }
  return [...out].filter(f => f.length >= MIN_SECRET_LEN)
}

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
    /** Store row ids of the secrets used (for the per-secret audit + last-used stamp). Never a value. */
    secretIds?: number[]
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
  const audit: BrokerHttpOutcome['audit'] = { secrets: [], scopes: [], secretIds: [], host: null, method, status: 'pending', workspace: workspace ?? null }

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
    if (caller.bot && resolved.value.length < MIN_SECRET_LEN) {
      return reject(403, `secret '${name}' is too short to be redacted reliably, so bots cannot use it`, audit)
    }
    values.set(name, resolved.value)
    audit.scopes.push(`${name}@${resolved.scope}`)
    audit.secretIds!.push(resolved.id)
    if (!audit.workspace && resolved.workspace) audit.workspace = resolved.workspace
    if (resolved.value) {
      for (const form of redactionForms(resolved.value)) redactMap.set(form, name)
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
      // Redact the WHOLE body, then cut: cutting first could split a value at
      // the cap and leave its prefix unrecognisable (obj 900749).
      const r = scrub(buf.toString('utf-8'))
      redactions += r.count
      text = truncated ? r.text.slice(0, cap) : r.text
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

// ── Callers + audit shared by every surface (obj 900749) ─────────────────────
//
// The broker has four front doors: the REST route (cookie / legacy key / agent
// key / worker session token), the remote MCP tools (which re-issue to that
// route with the bot's own key), and in-app chat bots (which call executeHttp
// in-process). They all build a Caller here and audit through recordBrokerUse,
// so "who used which secret, where" reads the same whichever door was used.

/**
 * A named agent key (cc_live_) — what an MCP-connected bot holds. NEVER an
 * admin caller, even when the key's owner is an admin: a bot reaches only its
 * owner's own user-scoped secrets, workspace secrets of the key's workspaces,
 * and global secrets whose policy names one of those workspaces. A key with a
 * workspace allowlist is narrowed to it (∩ the owner's memberships unless the
 * owner is a global admin, who may hold keys for workspaces without a row).
 */
export function callerForAgentKey(owner: { id: number; role: string }, keyWorkspaces: string[] | null, ownerWorkspaces: string[]): Caller {
  const own = new Set(ownerWorkspaces)
  const workspaces = keyWorkspaces === null
    ? ownerWorkspaces
    : owner.role === 'admin' ? keyWorkspaces : keyWorkspaces.filter(w => own.has(w))
  return { userId: owner.id, isAdmin: false, workspaces: [...new Set(workspaces)], bot: true }
}

/**
 * An in-app chat bot acting for the person chatting, inside ONE workspace (the
 * chat's). Non-admin by construction, whatever the person's role: a chat bot
 * never gets an admin's every-secret view.
 */
export function callerForChat(userId: number, workspace: string): Caller {
  return { userId, isAdmin: false, workspaces: [workspace], bot: true }
}

export interface BrokerUseIdentity {
  /** How the call reached the broker. */
  auth: 'api_key' | 'agent_key' | 'session' | 'chat' | 'mcp'
  /** Short, non-secret handle: key last4, `obj:<id>`, `bot:<slug>`. */
  key_last4: string | null
  username: string
}

/**
 * Audit one broker call: an activity_log row (names, host, status — never a
 * value), per-secret store audit + last-used stamp on success, and one log line.
 */
export function recordBrokerUse(outcome: BrokerHttpOutcome, caller: Caller, id: BrokerUseIdentity): void {
  const a = outcome.audit
  const meta = {
    secrets: a.secrets,
    scopes: a.scopes,
    host: a.host,
    method: a.method,
    status: a.status,
    workspace: a.workspace,
    user_id: caller.userId,
    username: id.username,
    auth: id.auth,
    key_last4: id.key_last4,
  }
  try {
    getDb().prepare(
      `INSERT INTO activity_log (project, workspace, event_type, title, detail, metadata)
       VALUES ('operationkit', ?, 'milestone', 'secrets_broker_use', ?, ?)`,
    ).run(
      a.workspace ?? 'shared',
      `${id.username} used ${a.secrets.join(', ') || '(none)'} → ${a.method} ${a.host ?? '-'} (${a.status})`,
      JSON.stringify(meta),
    )
  } catch (err) {
    console.error('[secrets-broker] audit insert failed', err instanceof Error ? err.message : err)
  }
  // Store-level audit too, so the secret's own access history shows each use.
  if (!a.status.startsWith('rejected')) {
    const ids = a.secretIds ?? []
    a.scopes.forEach((s, i) => {
      const [name, scope] = s.split('@')
      logAccess(caller.userId, 'use', `broker:${scope}→${a.host}`, name, {
        secretId: ids[i] ?? null,
        source: id.auth === 'chat' ? 'chat' : 'broker',
        detail: `${a.method} ${a.host ?? '-'}${id.auth === 'chat' || id.auth === 'agent_key' ? ` via ${id.auth}` : ''}`,
      })
    })
    touchLastUsed(ids)
  }
  console.log(`[secrets-broker] use user=${caller.userId} auth=${id.auth} key=${id.key_last4 ?? '-'} secrets=${a.secrets.join(',') || '-'} host=${a.host ?? '-'} status=${a.status}`)
}
