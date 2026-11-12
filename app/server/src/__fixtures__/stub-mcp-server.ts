/**
 * Local stub MCP server for the workspace-MCP integration tests (obj 900620).
 * Plain node:http on 127.0.0.1, no network. Endpoints:
 *
 *   POST /noauth/mcp           Streamable HTTP, JSON replies, no auth, paginated tools/list
 *   POST /bearer/mcp           Streamable HTTP, SSE-wrapped replies, needs `Bearer stub-key-123`
 *   POST /oauth/mcp            needs a token minted by the stub auth server below
 *   GET  /sse  + POST /sse/messages   legacy HTTP+SSE transport (POST /sse → 405 for fallback)
 *   POST /badproto/mcp         answers initialize with an unsupported protocol version
 *   POST /notmcp               an HTML page, not MCP
 *   OAuth: PRM at /.well-known/oauth-protected-resource/oauth/mcp, auth server issuer `${base}/as`
 *          (metadata at /.well-known/oauth-authorization-server/as), /as/register (DCR),
 *          /as/authorize (auto-consents, 302 back with ?code&state), /as/token (code + PKCE, refresh).
 */
import http from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export type AsMode = 'dcr' | 'cimd' | 'manual'

export interface StubState {
  asMode: AsMode
  /** access tokens currently valid for /oauth/mcp */
  validTokens: Set<string>
  refreshTokens: Map<string, string> // refresh → client_id
  codes: Map<string, { challenge: string; clientId: string; redirectUri: string; resource: string | null }>
  registered: Array<{ client_id: string; client_secret: string; redirect_uris: string[] }>
  lastAuthorizeParams: URLSearchParams | null
  lastTokenBody: URLSearchParams | null
  toolCalls: Array<{ name: string; args: unknown }>
  requests: Array<{ method: string; path: string; auth: string | null }>
  counter: number
}

export const STUB_API_KEY = 'stub-key-123'

const TOOLS_PAGE_1 = [
  { name: 'echo', description: 'Echo the input back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
]
const TOOLS_PAGE_2 = [
  { name: 'search_docs', description: 'Search the stub docs' },
  { name: 'bad name with spaces', description: 'malformed, must be dropped' },
  { description: 'no name, must be dropped' },
]

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let b = ''
    req.on('data', c => { b += c })
    req.on('end', () => resolve(b))
  })
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id, result }
}

function handleRpc(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }, serverName: string, state: StubState, protocol = '2025-06-18'): unknown | null {
  switch (msg.method) {
    case 'initialize':
      return rpcResult(msg.id, { protocolVersion: protocol, capabilities: { tools: {} }, serverInfo: { name: serverName, version: '1.2.3' }, instructions: 'stub server' })
    case 'notifications/initialized':
      return null
    case 'tools/list': {
      const cursor = msg.params?.cursor
      return cursor === 'page2' ? rpcResult(msg.id, { tools: TOOLS_PAGE_2 }) : rpcResult(msg.id, { tools: TOOLS_PAGE_1, nextCursor: 'page2' })
    }
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      state.toolCalls.push({ name, args: msg.params?.arguments })
      if (name === 'add') {
        const a = msg.params?.arguments as { a: number; b: number }
        return rpcResult(msg.id, { content: [{ type: 'text', text: String(a.a + a.b) }] })
      }
      return rpcResult(msg.id, { content: [{ type: 'text', text: JSON.stringify(msg.params?.arguments ?? {}) }] })
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
  }
}

export async function startStubMcpServer(): Promise<{ baseUrl: string; state: StubState; close: () => Promise<void> }> {
  const state: StubState = {
    asMode: 'dcr',
    validTokens: new Set(),
    refreshTokens: new Map(),
    codes: new Map(),
    registered: [],
    lastAuthorizeParams: null,
    lastTokenBody: null,
    toolCalls: [],
    requests: [],
    counter: 0,
  }
  const sseClients = new Map<string, http.ServerResponse>()
  let baseUrl = ''

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', baseUrl)
    const p = url.pathname
    const auth = (req.headers.authorization as string | undefined) ?? null
    state.requests.push({ method: req.method ?? '', path: p, auth })

    // ── MCP endpoints (Streamable HTTP) ──
    const mcpPaths: Record<string, { name: string; check: () => boolean; challenge?: string; sse?: boolean; protocol?: string }> = {
      '/noauth/mcp': { name: 'stub-noauth', check: () => true },
      '/bearer/mcp': { name: 'stub-bearer', check: () => auth === `Bearer ${STUB_API_KEY}`, challenge: 'Bearer realm="stub"', sse: true },
      '/oauth/mcp': {
        name: 'stub-oauth',
        check: () => !!auth && auth.startsWith('Bearer ') && state.validTokens.has(auth.slice(7)),
        challenge: `Bearer error="invalid_token", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/oauth/mcp", scope="mcp:read mcp:write"`,
      },
      '/badproto/mcp': { name: 'stub-badproto', check: () => true, protocol: '1999-01-01' },
    }
    const ep = mcpPaths[p]
    if (ep) {
      if (req.method === 'DELETE') { res.writeHead(204); return res.end() }
      if (req.method !== 'POST') { res.writeHead(405); return res.end() }
      if (!ep.check()) {
        await readBody(req)
        res.writeHead(401, { 'WWW-Authenticate': ep.challenge ?? 'Bearer', 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'unauthorized' }))
      }
      const msg = JSON.parse(await readBody(req))
      const reply = handleRpc(msg, ep.name, state, ep.protocol)
      if (reply === null) { res.writeHead(202); return res.end() }
      const headers: Record<string, string> = msg.method === 'initialize' ? { 'Mcp-Session-Id': `sess-${++state.counter}` } : {}
      if (ep.sse) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers })
        res.write(': keepalive\n\n')
        res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
        return res.end()
      }
      return json(res, 200, reply, headers)
    }

    if (p === '/notmcp') {
      await readBody(req)
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<html>hello</html>')
    }

    // ── Legacy HTTP+SSE ──
    if (p === '/sse' && req.method === 'POST') { await readBody(req); res.writeHead(405); return res.end() }
    if (p === '/sse' && req.method === 'GET') {
      const sid = String(++state.counter)
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.write(`event: endpoint\ndata: /sse/messages?sid=${sid}\n\n`)
      sseClients.set(sid, res)
      req.on('close', () => sseClients.delete(sid))
      return
    }
    if (p === '/sse/messages' && req.method === 'POST') {
      const client = sseClients.get(url.searchParams.get('sid') ?? '')
      const msg = JSON.parse(await readBody(req))
      res.writeHead(202); res.end()
      const reply = handleRpc(msg, 'stub-legacy-sse', state)
      if (reply && client) client.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`)
      return
    }

    // ── OAuth: protected resource + authorization server ──
    if (p === '/.well-known/oauth-protected-resource/oauth/mcp') {
      return json(res, 200, { resource: `${baseUrl}/oauth/mcp`, authorization_servers: [`${baseUrl}/as`], scopes_supported: ['mcp:read', 'mcp:write'] })
    }
    if (p === '/.well-known/oauth-authorization-server/as') {
      return json(res, 200, {
        issuer: `${baseUrl}/as`,
        authorization_endpoint: `${baseUrl}/as/authorize`,
        token_endpoint: `${baseUrl}/as/token`,
        ...(state.asMode === 'dcr' ? { registration_endpoint: `${baseUrl}/as/register` } : {}),
        ...(state.asMode === 'cimd' ? { client_id_metadata_document_supported: true } : {}),
        scopes_supported: ['mcp:read', 'mcp:write'],
        code_challenge_methods_supported: ['S256'],
      })
    }
    if (p === '/as/register' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const client = { client_id: `dcr-client-${++state.counter}`, client_secret: `dcr-secret-${state.counter}`, redirect_uris: body.redirect_uris }
      state.registered.push(client)
      return json(res, 201, client)
    }
    if (p === '/as/authorize') {
      const q = url.searchParams
      state.lastAuthorizeParams = q
      const code = `code-${++state.counter}`
      state.codes.set(code, {
        challenge: q.get('code_challenge') ?? '',
        clientId: q.get('client_id') ?? '',
        redirectUri: q.get('redirect_uri') ?? '',
        resource: q.get('resource'),
      })
      const back = new URL(q.get('redirect_uri') ?? '')
      back.searchParams.set('code', code)
      back.searchParams.set('state', q.get('state') ?? '')
      res.writeHead(302, { Location: back.toString() })
      return res.end()
    }
    if (p === '/as/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req))
      state.lastTokenBody = body
      const mint = (clientId: string) => {
        const n = ++state.counter
        const access = `at-${n}`
        const refresh = `rt-${n}`
        state.validTokens.add(access)
        state.refreshTokens.set(refresh, clientId)
        return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600 }
      }
      if (body.get('grant_type') === 'authorization_code') {
        const entry = state.codes.get(body.get('code') ?? '')
        if (!entry) return json(res, 400, { error: 'invalid_grant' })
        const verifier = body.get('code_verifier') ?? ''
        const challenge = createHash('sha256').update(verifier).digest('base64url')
        if (challenge !== entry.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
        if (body.get('client_id') !== entry.clientId || body.get('redirect_uri') !== entry.redirectUri) return json(res, 400, { error: 'invalid_client' })
        const reg = state.registered.find(r => r.client_id === entry.clientId)
        if (reg && body.get('client_secret') !== reg.client_secret) return json(res, 401, { error: 'invalid_client' })
        state.codes.delete(body.get('code')!)
        return json(res, 200, mint(entry.clientId))
      }
      if (body.get('grant_type') === 'refresh_token') {
        const rt = body.get('refresh_token') ?? ''
        const clientId = state.refreshTokens.get(rt)
        if (!clientId || clientId !== body.get('client_id')) return json(res, 400, { error: 'invalid_grant' })
        state.refreshTokens.delete(rt) // rotation
        return json(res, 200, mint(clientId))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    baseUrl,
    state,
    close: () =>
      new Promise<void>(resolve => {
        for (const c of sseClients.values()) c.end()
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}
