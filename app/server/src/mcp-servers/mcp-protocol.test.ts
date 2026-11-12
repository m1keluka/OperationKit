import { describe, it, expect } from 'vitest'
import { parseToolsList, SseParser, McpClientError } from './mcp-client.js'
import { parseWwwAuthenticate, bearerChallenge, protectedResourceMetadataUrls, authServerMetadataUrls, detectAuth } from './auth-detect.js'
import type { SafeFetch } from './safe-fetch.js'

describe('parseToolsList', () => {
  it('keeps name + description + schema and reads the next cursor', () => {
    const r = parseToolsList({
      tools: [
        { name: 'search', description: 'Search things', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
        { name: 'get_page', title: 'Get a page' },
      ],
      nextCursor: 'abc',
    })
    expect(r.nextCursor).toBe('abc')
    expect(r.tools).toEqual([
      { name: 'search', description: 'Search things', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'get_page', description: 'Get a page', input_schema: { type: 'object', properties: {} } },
    ])
  })

  it('drops malformed entries instead of failing the whole list', () => {
    const r = parseToolsList({ tools: [null, 42, { description: 'no name' }, { name: 'has space' }, { name: 'x'.repeat(200) }, { name: 'ok.tool-1/v2' }] })
    expect(r.tools.map(t => t.name)).toEqual(['ok.tool-1/v2'])
    expect(r.nextCursor).toBeNull()
  })

  it('truncates very long descriptions', () => {
    const r = parseToolsList({ tools: [{ name: 'a', description: 'd'.repeat(5000) }] })
    expect(r.tools[0].description.length).toBe(1000)
  })

  it('a result without a tools array is a protocol error', () => {
    expect(() => parseToolsList({})).toThrow(McpClientError)
    expect(() => parseToolsList(null)).toThrow(/no result/)
  })
})

describe('SseParser', () => {
  it('parses events split across chunks, CRLF, comments and multi-line data', () => {
    const p = new SseParser()
    expect(p.push(': ping\r\n\r\nevent: endpoint\r\ndata: /messages?s')).toEqual([])
    const evs = p.push('id=1\r\n\r\ndata: {"a":\ndata: 1}\n\n')
    expect(evs).toEqual([
      { event: 'endpoint', data: '/messages?sid=1' },
      { event: 'message', data: '{"a":\n1}' },
    ])
  })
})

describe('WWW-Authenticate parsing', () => {
  it('reads resource_metadata and scope from a Bearer challenge', () => {
    const h = 'Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="read write"'
    const c = bearerChallenge(h)
    expect(c?.params.resource_metadata).toBe('https://mcp.example.com/.well-known/oauth-protected-resource/mcp')
    expect(c?.params.scope).toBe('read write')
    expect(c?.params.error).toBe('invalid_token')
  })

  it('handles several challenges, escaped quotes and commas inside quotes', () => {
    const cs = parseWwwAuthenticate('Basic realm="a, b", Bearer realm="say \\"hi\\"", error=invalid_token')
    expect(cs.map(c => c.scheme)).toEqual(['basic', 'bearer'])
    expect(cs[0].params.realm).toBe('a, b')
    expect(cs[1].params.realm).toBe('say "hi"')
    expect(cs[1].params.error).toBe('invalid_token')
  })

  it('no header → no challenge', () => {
    expect(parseWwwAuthenticate(null)).toEqual([])
    expect(bearerChallenge('Basic realm="x"')).toBeNull()
  })
})

describe('discovery URLs', () => {
  it('PRM: path-specific first, then the origin', () => {
    expect(protectedResourceMetadataUrls('https://a.example.com/v1/mcp')).toEqual([
      'https://a.example.com/.well-known/oauth-protected-resource/v1/mcp',
      'https://a.example.com/.well-known/oauth-protected-resource',
    ])
  })
  it('AS metadata: RFC 8414 path insertion, then OIDC', () => {
    expect(authServerMetadataUrls('https://auth.example.com/tenant1')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://auth.example.com/.well-known/openid-configuration/tenant1',
      'https://auth.example.com/tenant1/.well-known/openid-configuration',
    ])
    expect(authServerMetadataUrls('https://auth.example.com')).toEqual([
      'https://auth.example.com/.well-known/oauth-authorization-server',
      'https://auth.example.com/.well-known/openid-configuration',
    ])
  })
})

// ── detectAuth against a scripted fetch ─────────────────────────────────────

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>): SafeFetch {
  return async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`
    const h = routes[key]
    if (!h) return new Response('not found', { status: 404 })
    return h(init)
  }
}

const MCP = 'https://mcp.example.com/mcp'
const unauthorized = (challenge: string) => () => json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': challenge })
const asMeta = (extra: Record<string, unknown>) => () =>
  json(200, { issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token', ...extra })

describe('detectAuth', () => {
  it('no auth: initialize succeeds without credentials', async () => {
    let n = 0
    const f = fakeFetch({
      [`POST ${MCP}`]: init => {
        const msg = JSON.parse(String(init?.body))
        if (msg.method === 'initialize') return json(200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'open', version: '9' } } })
        if (msg.method === 'tools/list') { n++; return json(200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 't1' }] } }) }
        return new Response(null, { status: 202 })
      },
      [`DELETE ${MCP}`]: () => new Response(null, { status: 204 }),
    })
    const r = await detectAuth({ url: MCP, fetchImpl: f })
    expect(r.ok && r.data.auth).toBe('none')
    if (r.ok && r.data.auth === 'none') {
      expect(r.data.probe.server_name).toBe('open')
      expect(r.data.probe.tools.map(t => t.name)).toEqual(['t1'])
    }
    expect(n).toBe(1)
  })

  it('OAuth + CIMD via resource_metadata', async () => {
    const f = fakeFetch({
      [`POST ${MCP}`]: unauthorized('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="files:read"'),
      ['GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp']: () =>
        json(200, { resource: MCP, authorization_servers: ['https://auth.example.com'] }),
      ['GET https://auth.example.com/.well-known/oauth-authorization-server']: asMeta({ client_id_metadata_document_supported: true, registration_endpoint: 'https://auth.example.com/register' }),
    })
    const r = await detectAuth({ url: MCP, fetchImpl: f })
    expect(r.ok).toBe(true)
    if (r.ok && r.data.auth === 'oauth') {
      expect(r.data.registration).toBe('cimd')
      expect(r.data.challenge_scope).toBe('files:read')
      expect(r.data.resource).toBe(MCP)
    } else throw new Error('expected oauth')
  })

  it('OAuth + DCR found through the well-known PRM when the challenge has no hint', async () => {
    const f = fakeFetch({
      [`POST ${MCP}`]: unauthorized('Bearer realm="x"'),
      ['GET https://mcp.example.com/.well-known/oauth-protected-resource']: () => json(200, { authorization_servers: ['https://auth.example.com'] }),
      ['GET https://auth.example.com/.well-known/oauth-authorization-server']: asMeta({ registration_endpoint: 'https://auth.example.com/register' }),
    })
    const r = await detectAuth({ url: MCP, fetchImpl: f })
    expect(r.ok && r.data.auth === 'oauth' && r.data.registration).toBe('dcr')
  })

  it('OAuth without DCR/CIMD → guided (manual client registration)', async () => {
    const f = fakeFetch({
      [`POST ${MCP}`]: unauthorized('Bearer'),
      ['GET https://mcp.example.com/.well-known/oauth-protected-resource']: () => json(200, { authorization_servers: ['https://auth.example.com'] }),
      ['GET https://auth.example.com/.well-known/oauth-authorization-server']: asMeta({}),
    })
    const r = await detectAuth({ url: MCP, fetchImpl: f })
    expect(r.ok && r.data.auth === 'oauth' && r.data.registration).toBe('manual')
  })

  it('a 401 with no OAuth metadata anywhere → API key', async () => {
    const f = fakeFetch({ [`POST ${MCP}`]: unauthorized('Bearer realm="api"') })
    const r = await detectAuth({ url: MCP, fetchImpl: f })
    expect(r.ok && r.data.auth).toBe('api_key')
  })

  it('refuses OAuth metadata that points the browser or token exchange at an internal address', async () => {
    const f = fakeFetch({
      [`POST ${MCP}`]: unauthorized('Bearer'),
      ['GET https://mcp.example.com/.well-known/oauth-protected-resource']: () => json(200, { authorization_servers: ['https://auth.example.com'] }),
      ['GET https://auth.example.com/.well-known/oauth-authorization-server']: () =>
        json(200, { issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://169.254.169.254/token' }),
    })
    const r = await detectAuth({ url: MCP, fetchImpl: f })
    expect(r.ok && r.data.auth).toBe('api_key')
  })

  it('a blocked URL never reaches fetch', async () => {
    let called = false
    const r = await detectAuth({ url: 'https://10.0.0.1/mcp', fetchImpl: async () => { called = true; return new Response('') } })
    expect(r).toMatchObject({ ok: false, kind: 'blocked' })
    expect(called).toBe(false)
  })

  it('reports unreachable / protocol errors with a clear kind', async () => {
    const down = await detectAuth({ url: MCP, fetchImpl: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) } })
    expect(down).toMatchObject({ ok: false, kind: 'unreachable' })
    const html = await detectAuth({ url: MCP, fetchImpl: async () => new Response('<html/>', { status: 200, headers: { 'Content-Type': 'text/html' } }) })
    expect(html).toMatchObject({ ok: false, kind: 'protocol' })
  })
})
