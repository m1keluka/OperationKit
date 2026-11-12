/**
 * Minimal MCP client for "Test connection" and chat-bot tool calls
 * (Sprint 7.8, obj 900620).
 *
 * Speaks the two remote transports a hosted MCP server may offer:
 *   - Streamable HTTP (spec 2025-03-26+): POST JSON-RPC to the server URL; the
 *     reply is either `application/json` or a `text/event-stream` carrying it.
 *     `Mcp-Session-Id` from the initialize reply is echoed on later requests.
 *   - HTTP+SSE (spec 2024-11-05, legacy): GET the URL as an event stream, wait
 *     for the `endpoint` event, POST JSON-RPC there, read replies off the stream.
 *
 * `transport: 'auto'` follows the spec's backwards-compatibility rule: try a
 * Streamable HTTP initialize first; if the server answers 404/405 (or another
 * 4xx that is not an auth failure), fall back to HTTP+SSE.
 *
 * Every network call goes through an injected `SafeFetch` (safe-fetch.ts), so
 * nothing here can be pointed at an internal address. Credentials arrive as a
 * header map and are never logged or put in an error message.
 */
import type { SafeFetch } from './safe-fetch.js'
import { BlockedUrlError } from './safe-fetch.js'
import { validateMcpUrl } from './url-guard.js'

export const CLIENT_INFO = { name: 'command-center', version: '1.0.0' }
/** What we ask for; a server may answer with any version it supports. */
export const REQUESTED_PROTOCOL_VERSION = '2025-06-18'
/** Versions this client can talk. A server answering anything else is a protocol mismatch. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

export type McpTransport = 'streamable_http' | 'sse'
export type McpErrorKind = 'unreachable' | 'blocked' | 'auth_required' | 'auth_failed' | 'protocol' | 'server_error'

export class McpClientError extends Error {
  constructor(
    readonly kind: McpErrorKind,
    message: string,
    readonly status?: number,
    /** Raw `WWW-Authenticate` value from a 401, for auth detection. Not a secret. */
    readonly wwwAuthenticate?: string | null,
  ) {
    super(message)
  }
}

export interface McpToolInfo {
  name: string
  description: string
  /** JSON Schema for the tool's arguments (passed to chat models as-is). */
  input_schema: Record<string, unknown>
}

export interface McpProbeResult {
  transport: McpTransport
  protocol_version: string
  server_name: string | null
  server_version: string | null
  instructions: string | null
  tools: McpToolInfo[]
}

const MAX_TOOLS = 500
const MAX_DESCRIPTION = 1000
const TOOL_NAME_RE = /^[A-Za-z0-9_.\-/]{1,128}$/

/**
 * Parse a `tools/list` result into a clean list. Drops malformed entries
 * rather than failing the whole listing — one odd tool should not hide the rest.
 */
export function parseToolsList(result: unknown): { tools: McpToolInfo[]; nextCursor: string | null } {
  if (!result || typeof result !== 'object') throw new McpClientError('protocol', 'tools/list returned no result object.')
  const r = result as { tools?: unknown; nextCursor?: unknown }
  if (!Array.isArray(r.tools)) throw new McpClientError('protocol', 'tools/list result has no "tools" array.')
  const tools: McpToolInfo[] = []
  for (const t of r.tools) {
    if (!t || typeof t !== 'object') continue
    const o = t as { name?: unknown; description?: unknown; title?: unknown; inputSchema?: unknown }
    if (typeof o.name !== 'string' || !TOOL_NAME_RE.test(o.name)) continue
    const desc = typeof o.description === 'string' ? o.description : typeof o.title === 'string' ? o.title : ''
    const schema =
      o.inputSchema && typeof o.inputSchema === 'object' && !Array.isArray(o.inputSchema)
        ? (o.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} }
    tools.push({ name: o.name, description: desc.slice(0, MAX_DESCRIPTION), input_schema: schema })
    if (tools.length >= MAX_TOOLS) break
  }
  const nextCursor = typeof r.nextCursor === 'string' && r.nextCursor.length > 0 ? r.nextCursor : null
  return { tools, nextCursor }
}

// ── SSE parsing ──────────────────────────────────────────────────────────────

export interface SseEvent {
  event: string
  data: string
}

/** Incremental `text/event-stream` parser. Feed it text; it yields complete events. */
export class SseParser {
  private buf = ''
  push(chunk: string): SseEvent[] {
    this.buf += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const out: SseEvent[] = []
    let idx: number
    while ((idx = this.buf.indexOf('\n\n')) >= 0) {
      const block = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 2)
      let event = 'message'
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        let value = colon < 0 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length > 0) out.push({ event, data: data.join('\n') })
    }
    return out
  }
}

// ── JSON-RPC plumbing ───────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function isResponseFor(msg: unknown, id: number): msg is JsonRpcResponse {
  return !!msg && typeof msg === 'object' && (msg as JsonRpcResponse).id === id &&
    ('result' in (msg as object) || 'error' in (msg as object))
}

function unwrap(msg: JsonRpcResponse, method: string): unknown {
  if (msg.error) {
    const text = typeof msg.error.message === 'string' ? msg.error.message.slice(0, 300) : 'unknown error'
    throw new McpClientError('protocol', `The server rejected ${method}: ${text} (code ${msg.error.code}).`)
  }
  return msg.result
}

function classifyNetworkError(err: unknown, url: string): McpClientError {
  if (err instanceof McpClientError) return err
  if (err instanceof BlockedUrlError) return new McpClientError('blocked', err.message)
  const e = err as { message?: string; code?: string; cause?: { code?: string; message?: string } }
  const code = e?.code ?? e?.cause?.code ?? ''
  const host = (() => { try { return new URL(url).host } catch { return url } })()
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new McpClientError('unreachable', `Could not find ${host} (DNS lookup failed).`)
  if (code === 'ECONNREFUSED') return new McpClientError('unreachable', `${host} refused the connection.`)
  if (/timed out/i.test(e?.message ?? '')) return new McpClientError('unreachable', `${host} did not answer in time.`)
  if (/certificate|self.signed|CERT_/i.test(`${code} ${e?.message ?? ''}`)) {
    return new McpClientError('unreachable', `${host} has an invalid TLS certificate.`)
  }
  return new McpClientError('unreachable', `Could not reach ${host}: ${(e?.message ?? String(err)).slice(0, 200)}`)
}

function httpError(res: Response, sentCredentials: boolean, what: string): McpClientError {
  const www = res.headers.get('www-authenticate')
  if (res.status === 401) {
    return sentCredentials
      ? new McpClientError('auth_failed', 'The server rejected the credentials (HTTP 401).', 401, www)
      : new McpClientError('auth_required', 'The server requires authentication (HTTP 401).', 401, www)
  }
  if (res.status === 403) {
    return new McpClientError(sentCredentials ? 'auth_failed' : 'auth_required', 'The server refused access (HTTP 403); the key or account may lack permission.', 403, www)
  }
  if (res.status >= 500) return new McpClientError('server_error', `The server failed on ${what} (HTTP ${res.status}).`, res.status)
  return new McpClientError('protocol', `The server answered ${what} with HTTP ${res.status}; it may not be an MCP endpoint.`, res.status)
}

async function readBodyText(res: Response): Promise<string> {
  try { return await res.text() } catch { return '' }
}

/** Read an SSE response body until the JSON-RPC reply with `id` arrives. */
async function readSseReply(res: Response, id: number, signal: AbortSignal): Promise<JsonRpcResponse> {
  if (!res.body) throw new McpClientError('protocol', 'Empty event stream.')
  const reader = res.body.getReader()
  const parser = new SseParser()
  const decoder = new TextDecoder()
  const onAbort = () => { reader.cancel().catch(() => {}) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (signal.aborted) throw new McpClientError('unreachable', 'The server did not answer in time.')
      if (done) break
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
        if (ev.event !== 'message') continue
        let msg: unknown
        try { msg = JSON.parse(ev.data) } catch { continue }
        const msgs = Array.isArray(msg) ? msg : [msg]
        for (const m of msgs) if (isResponseFor(m, id)) return m
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.cancel().catch(() => {})
  }
  throw new McpClientError('protocol', 'The event stream ended without a reply.')
}

export interface McpConnectOptions {
  url: string
  /** Extra request headers, e.g. `{ Authorization: 'Bearer …' }`. Never logged. */
  headers?: Record<string, string>
  transport?: McpTransport | 'auto'
  fetchImpl: SafeFetch
  /** Per-request timeout in ms. Default 20s. */
  timeoutMs?: number
}

/**
 * One open MCP session. Use `McpSession.open()`; always `close()` it.
 */
export class McpSession {
  private nextId = 1
  private sessionId: string | null = null
  // Legacy SSE state.
  private sseEndpoint: string | null = null
  private sseReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private ssePending = new Map<number, (m: JsonRpcResponse) => void>()
  private sseAbort = new AbortController()
  protocolVersion = REQUESTED_PROTOCOL_VERSION
  serverInfo: { name: string | null; version: string | null } = { name: null, version: null }
  instructions: string | null = null
  private initialized = false

  private constructor(private readonly opts: McpConnectOptions, readonly transport: McpTransport) {}

  private get sentCredentials(): boolean {
    return Object.keys(this.opts.headers ?? {}).length > 0
  }

  private get timeoutMs(): number {
    return this.opts.timeoutMs ?? 20_000
  }

  static async open(opts: McpConnectOptions): Promise<McpSession> {
    const check = validateMcpUrl(opts.url)
    if (!check.ok) throw new McpClientError('blocked', check.error)
    const want = opts.transport ?? 'auto'
    if (want === 'sse') {
      const s = new McpSession(opts, 'sse')
      await s.initialize()
      return s
    }
    const s = new McpSession(opts, 'streamable_http')
    try {
      await s.initialize()
      return s
    } catch (err) {
      const e = err as McpClientError
      const fallback = want === 'auto' && e instanceof McpClientError && e.kind === 'protocol' &&
        (e.status === 404 || e.status === 405 || e.status === 400 || e.status === 406 || e.status === 415)
      if (!fallback) throw err
      const legacy = new McpSession(opts, 'sse')
      try {
        await legacy.initialize()
        return legacy
      } catch (legacyErr) {
        // Report the legacy failure only when it is more specific (e.g. auth).
        if (legacyErr instanceof McpClientError && legacyErr.kind !== 'protocol') throw legacyErr
        throw err
      }
    }
  }

  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...(this.opts.headers ?? {}) }
    if (this.sessionId) h['Mcp-Session-Id'] = this.sessionId
    if (this.initialized) h['MCP-Protocol-Version'] = this.protocolVersion
    return h
  }

  private async initialize(): Promise<void> {
    if (this.transport === 'sse') await this.openSseStream()
    const result = (await this.request('initialize', {
      protocolVersion: REQUESTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })) as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown }; instructions?: unknown } | null
    if (!result || typeof result !== 'object') throw new McpClientError('protocol', 'initialize returned no result.')
    const pv = typeof result.protocolVersion === 'string' ? result.protocolVersion : ''
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) {
      await this.close()
      throw new McpClientError(
        'protocol',
        pv
          ? `Protocol mismatch: the server speaks MCP ${pv}; this client supports ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`
          : 'Protocol mismatch: the server did not say which MCP version it speaks.',
      )
    }
    this.protocolVersion = pv
    this.serverInfo = {
      name: typeof result.serverInfo?.name === 'string' ? result.serverInfo.name.slice(0, 200) : null,
      version: typeof result.serverInfo?.version === 'string' ? result.serverInfo.version.slice(0, 100) : null,
    }
    this.instructions = typeof result.instructions === 'string' ? result.instructions.slice(0, 2000) : null
    this.initialized = true
    await this.notify('notifications/initialized')
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    return this.transport === 'sse' ? this.sseRequest(id, method, body) : this.httpRequest(id, method, body)
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const body = JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
    const target = this.transport === 'sse' ? this.sseEndpoint! : this.opts.url
    try {
      const res = await this.opts.fetchImpl(target, {
        method: 'POST',
        headers: { ...this.baseHeaders(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body,
      })
      await res.body?.cancel().catch(() => {})
    } catch {
      // A failed notification is not fatal; the next request will surface the problem.
    }
  }

  private async httpRequest(id: number, method: string, body: string): Promise<unknown> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      let res: Response
      try {
        res = await this.opts.fetchImpl(this.opts.url, {
          method: 'POST',
          headers: { ...this.baseHeaders(), 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body,
          signal: ctrl.signal,
        })
      } catch (err) {
        throw classifyNetworkError(err, this.opts.url)
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        throw httpError(res, this.sentCredentials, method)
      }
      const sid = res.headers.get('mcp-session-id')
      if (sid && /^[\x21-\x7e]{1,256}$/.test(sid)) this.sessionId = sid
      const ctype = (res.headers.get('content-type') ?? '').toLowerCase()
      let msg: JsonRpcResponse | null = null
      if (ctype.includes('text/event-stream')) {
        msg = await readSseReply(res, id, ctrl.signal)
      } else if (ctype.includes('application/json')) {
        const text = await readBodyText(res)
        let parsed: unknown
        try { parsed = JSON.parse(text) } catch {
          throw new McpClientError('protocol', `The server's reply to ${method} was not valid JSON.`)
        }
        const list = Array.isArray(parsed) ? parsed : [parsed]
        msg = (list.find(m => isResponseFor(m, id)) as JsonRpcResponse | undefined) ?? null
      } else {
        await res.body?.cancel().catch(() => {})
        throw new McpClientError('protocol', `The server answered ${method} with "${ctype || 'no content type'}", not JSON-RPC; it may not be an MCP endpoint.`, res.status)
      }
      if (!msg) throw new McpClientError('protocol', `The server's reply to ${method} was not a JSON-RPC response.`)
      return unwrap(msg, method)
    } finally {
      clearTimeout(timer)
    }
  }

  // ── Legacy HTTP+SSE ───────────────────────────────────────────────────────

  private async openSseStream(): Promise<void> {
    let res: Response
    try {
      res = await this.opts.fetchImpl(this.opts.url, {
        method: 'GET',
        headers: { ...(this.opts.headers ?? {}), Accept: 'text/event-stream' },
        signal: this.sseAbort.signal,
      })
    } catch (err) {
      throw classifyNetworkError(err, this.opts.url)
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw httpError(res, this.sentCredentials, 'the event-stream request')
    }
    if (!(res.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream') || !res.body) {
      await res.body?.cancel().catch(() => {})
      throw new McpClientError('protocol', 'The server did not open an event stream; it is not an MCP endpoint.', res.status)
    }
    this.sseReader = res.body.getReader()
    const parser = new SseParser()
    const decoder = new TextDecoder()
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new McpClientError('protocol', 'The event stream never announced its message endpoint.')), this.timeoutMs)
      const pump = async () => {
        try {
          for (;;) {
            const { value, done } = await this.sseReader!.read()
            if (done) break
            for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
              if (ev.event === 'endpoint') {
                clearTimeout(timer)
                resolve(ev.data.trim())
                continue
              }
              if (ev.event !== 'message') continue
              let msg: unknown
              try { msg = JSON.parse(ev.data) } catch { continue }
              for (const m of Array.isArray(msg) ? msg : [msg]) {
                const id = (m as JsonRpcResponse)?.id
                if (typeof id === 'number' && this.ssePending.has(id)) {
                  this.ssePending.get(id)!(m as JsonRpcResponse)
                  this.ssePending.delete(id)
                }
              }
            }
          }
        } catch { /* stream closed */ }
        clearTimeout(timer)
        reject(new McpClientError('protocol', 'The event stream closed before the server answered.'))
        for (const [, cb] of this.ssePending) cb({ jsonrpc: '2.0', error: { code: -32000, message: 'event stream closed' } })
        this.ssePending.clear()
      }
      void pump()
    })
    const resolved = new URL(endpoint, this.opts.url)
    // The message endpoint must stay on the same origin — a server cannot
    // bounce our credentials to a third party (or an internal address).
    if (resolved.origin !== new URL(this.opts.url).origin) {
      throw new McpClientError('protocol', 'The server announced a message endpoint on a different host; refusing to send credentials there.')
    }
    this.sseEndpoint = resolved.toString()
  }

  private async sseRequest(id: number, method: string, body: string): Promise<unknown> {
    if (!this.sseEndpoint) throw new McpClientError('protocol', 'No message endpoint.')
    const reply = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ssePending.delete(id)
        reject(new McpClientError('unreachable', `The server did not answer ${method} in time.`))
      }, this.timeoutMs)
      this.ssePending.set(id, m => { clearTimeout(timer); resolve(m) })
    })
    let res: Response
    try {
      res = await this.opts.fetchImpl(this.sseEndpoint, {
        method: 'POST',
        headers: { ...this.baseHeaders(), 'Content-Type': 'application/json' },
        body,
      })
    } catch (err) {
      this.ssePending.delete(id)
      throw classifyNetworkError(err, this.sseEndpoint)
    }
    await res.body?.cancel().catch(() => {})
    if (!res.ok) {
      this.ssePending.delete(id)
      throw httpError(res, this.sentCredentials, method)
    }
    return unwrap(await reply, method)
  }

  async listTools(): Promise<McpToolInfo[]> {
    const all: McpToolInfo[] = []
    let cursor: string | null = null
    for (let page = 0; page < 20; page++) {
      const result = await this.request('tools/list', cursor ? { cursor } : {})
      const parsed = parseToolsList(result)
      all.push(...parsed.tools)
      if (!parsed.nextCursor || all.length >= MAX_TOOLS) break
      cursor = parsed.nextCursor
    }
    return all.slice(0, MAX_TOOLS)
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request('tools/call', { name, arguments: args })
  }

  async close(): Promise<void> {
    if (this.transport === 'sse') {
      this.sseAbort.abort()
      await this.sseReader?.cancel().catch(() => {})
      return
    }
    if (this.sessionId) {
      try {
        const res = await this.opts.fetchImpl(this.opts.url, { method: 'DELETE', headers: this.baseHeaders() })
        await res.body?.cancel().catch(() => {})
      } catch { /* best effort */ }
    }
  }
}

/** initialize + tools/list + close. The "Test connection" probe. */
export async function probeMcpServer(opts: McpConnectOptions): Promise<McpProbeResult> {
  const session = await McpSession.open(opts)
  try {
    const tools = await session.listTools()
    return {
      transport: session.transport,
      protocol_version: session.protocolVersion,
      server_name: session.serverInfo.name,
      server_version: session.serverInfo.version,
      instructions: session.instructions,
      tools,
    }
  } finally {
    await session.close()
  }
}
