/**
 * /api/mcp-servers routes (obj 900620): admin-only mutations, workspace-scoped
 * reads, credentials never in a response, OAuth callback + CIMD document, and
 * the real buildSpawnEnv honouring workspace isolation.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { AddressInfo } from 'net'

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 23).toString('base64')
process.env.DB_PATH = path.join(os.tmpdir(), `cc-mcproutes-test-${process.pid}-${Date.now()}.db`)
process.env.JWT_SECRET = 'test-secret-mcproutes'
process.env.APP_BASE_URL = 'https://cc.example.test'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./mcp-servers.js')
const svc = await import('../services/workspace-mcp-servers.js')
const { buildSpawnEnv } = await import('../services/session-spawn-env.js')
const { startStubMcpServer, STUB_API_KEY } = await import('../__fixtures__/stub-mcp-server.js')

let server: http.Server
let base: string
let stub: Awaited<ReturnType<typeof startStubMcpServer>>

function cookie(id: number, role: 'admin' | 'member'): string {
  return `token=${jwt.sign({ id, username: `u${id}`, role }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`
}
const ADMIN = cookie(1, 'admin')
const MEMBER_A = cookie(2, 'member')

async function call(method: string, p: string, who: string | null, body?: unknown) {
  const res = await fetch(`${base}/api/mcp-servers${p}`, {
    method,
    redirect: 'manual',
    headers: { ...(who ? { Cookie: who } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json: json as Record<string, unknown> & unknown[], text, headers: res.headers }
}

beforeAll(async () => {
  initDb()
  stub = await startStubMcpServer()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/mcp-servers', router)
  server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await stub.close()
  await new Promise(r => server.close(r))
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM workspace_mcp_servers; DELETE FROM secret_versions; DELETE FROM secrets; DELETE FROM user_workspaces;')
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'u1', 'x', 'admin')").run()
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (2, 'u2', 'x', 'member')").run()
  for (const ws of ['ws-a', 'ws-b']) db.prepare('INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)').run(ws, ws)
  db.prepare("INSERT INTO user_workspaces (user_id, workspace, role) VALUES (2, 'ws-a', 'member')").run()
})

describe('auth + scoping', () => {
  it('needs a login', async () => {
    expect((await call('GET', '/?workspace=ws-a', null)).status).toBe(401)
  })

  it('mutations are admin-only', async () => {
    const body = { workspace: 'ws-a', name: 'x', url: `${stub.baseUrl}/noauth/mcp`, auth_type: 'none' }
    expect((await call('POST', '/', MEMBER_A, body)).status).toBe(403)
    expect((await call('POST', '/detect', MEMBER_A, { url: `${stub.baseUrl}/noauth/mcp` })).status).toBe(403)
    const created = await call('POST', '/', ADMIN, body)
    expect(created.status).toBe(201)
    const id = (created.json as unknown as { server: { id: number } }).server.id
    expect((await call('POST', `/${id}/test`, MEMBER_A)).status).toBe(403)
    expect((await call('PATCH', `/${id}`, MEMBER_A, { enabled: false })).status).toBe(403)
    expect((await call('DELETE', `/${id}`, MEMBER_A)).status).toBe(403)
    expect((await call('POST', `/${id}/oauth/start`, MEMBER_A)).status).toBe(403)
  })

  it('a member reads their own workspace only', async () => {
    await call('POST', '/', ADMIN, { workspace: 'ws-b', name: 'B only', url: `${stub.baseUrl}/noauth/mcp`, auth_type: 'none' })
    expect((await call('GET', '/?workspace=ws-a', MEMBER_A)).status).toBe(200)
    expect((await call('GET', '/?workspace=ws-b', MEMBER_A)).status).toBe(403)
    expect((await call('GET', '/', MEMBER_A)).status).toBe(400) // never "all workspaces"
    const listA = await call('GET', '/?workspace=ws-a', ADMIN)
    expect(listA.json).toEqual([])
  })
})

describe('connect flows over HTTP', () => {
  it('detect → create (api key) → test → tools listed; the key is never in any response', async () => {
    const det = await call('POST', '/detect', ADMIN, { url: `${stub.baseUrl}/bearer/mcp` })
    expect(det.json).toMatchObject({ ok: true, auth: 'api_key' })
    const created = await call('POST', '/', ADMIN, { workspace: 'ws-a', name: 'Bearer', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key: STUB_API_KEY })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ test: { ok: true }, server: { status: 'connected', has_credential: true, server_name: 'stub-bearer' } })
    const id = (created.json as unknown as { server: { id: number } }).server.id
    const test = await call('POST', `/${id}/test`, ADMIN)
    expect(test.json).toMatchObject({ ok: true, server: { tools: [{ name: 'echo', enabled: true }, { name: 'add', enabled: true }, { name: 'search_docs', enabled: true }] } })
    const list = await call('GET', '/?workspace=ws-a', ADMIN)
    for (const r of [det, created, test, list]) expect(r.text).not.toContain(STUB_API_KEY)
  })

  it('detect reports blocked / unreachable URLs with a kind', async () => {
    expect((await call('POST', '/detect', ADMIN, { url: 'https://169.254.169.254/latest' })).json).toMatchObject({ ok: false, kind: 'blocked' })
    expect((await call('POST', '/detect', ADMIN, { url: 'http://127.0.0.1:1/mcp' })).json).toMatchObject({ ok: false, kind: 'unreachable' })
  })

  it('create refuses an SSRF URL', async () => {
    const r = await call('POST', '/', ADMIN, { workspace: 'ws-a', name: 'meta', url: 'https://metadata.google.internal/', auth_type: 'none' })
    expect(r.status).toBe(400)
  })

  it('OAuth: start → provider → callback stores tokens, runs the test, redirects to settings', async () => {
    const det = await call('POST', '/detect', ADMIN, { url: `${stub.baseUrl}/oauth/mcp` })
    expect(det.json).toMatchObject({ ok: true, auth: 'oauth', registration: 'dcr', redirect_uri: 'https://cc.example.test/api/mcp-servers/oauth/callback' })
    const created = await call('POST', '/', ADMIN, { workspace: 'ws-a', name: 'OAuth', url: `${stub.baseUrl}/oauth/mcp`, auth_type: 'oauth' })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ server: { status: 'needs_auth', has_credential: false } })
    const id = (created.json as unknown as { server: { id: number } }).server.id
    const start = await call('POST', `/${id}/oauth/start`, ADMIN)
    const redirectUrl = (start.json as unknown as { redirect_url: string }).redirect_url
    const consent = await fetch(redirectUrl, { redirect: 'manual' })
    const back = new URL(consent.headers.get('location')!)
    const cb = await call('GET', `/oauth/callback${back.search}`, null) // public route: no cookie
    expect(cb.status).toBe(302)
    expect(cb.headers.get('location')).toBe(`https://cc.example.test/settings/connectors?mcp_oauth=connected&mcp_server=${id}`)
    const list = await call('GET', '/?workspace=ws-a', ADMIN)
    expect(list.json[0]).toMatchObject({ status: 'connected', has_credential: true, has_refresh_token: true, oauth_registration: 'dcr' })
    for (const tok of stub.state.validTokens) expect(list.text).not.toContain(tok)
  })

  it('callback with a provider error or bad state redirects with an error, stores nothing', async () => {
    const e1 = await call('GET', '/oauth/callback?error=access_denied', null)
    expect(e1.headers.get('location')).toContain('mcp_oauth=error')
    const e2 = await call('GET', '/oauth/callback?code=x&state=forged', null)
    expect(e2.headers.get('location')).toContain('mcp_error=invalid_state')
  })

  it('serves the CIMD client metadata document publicly', async () => {
    const r = await call('GET', '/oauth/client-metadata', null)
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ client_id: 'https://cc.example.test/api/mcp-servers/oauth/client-metadata', token_endpoint_auth_method: 'none' })
  })

  it('PATCH toggles a tool; DELETE disconnects and revokes local tokens', async () => {
    const created = await call('POST', '/', ADMIN, { workspace: 'ws-a', name: 'Bearer', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key: STUB_API_KEY })
    const id = (created.json as unknown as { server: { id: number } }).server.id
    const p = await call('PATCH', `/${id}`, ADMIN, { disabled_tools: ['add'] })
    expect((p.json as unknown as { tools: Array<{ name: string; enabled: boolean }> }).tools.find(t => t.name === 'add')?.enabled).toBe(false)
    expect((await call('DELETE', `/${id}`, ADMIN)).json).toEqual({ ok: true })
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM secrets WHERE key LIKE 'CC_MCP_SERVER_%'").get()).toEqual({ n: 0 })
    expect((await call('DELETE', `/${id}`, ADMIN)).status).toBe(404)
  })

  it('catalog lists connectors that publish a remote MCP endpoint', async () => {
    const r = await call('GET', '/catalog', ADMIN)
    const ids = (r.json as unknown as Array<{ id: string; mcp_url: string }>).map(e => e.id)
    expect(ids).toEqual(expect.arrayContaining(['notion', 'linear']))
    const notion = (r.json as unknown as Array<{ id: string; mcp_url: string }>).find(e => e.id === 'notion')
    expect(notion?.mcp_url).toBe('https://mcp.notion.com/mcp')
  })
})

describe('buildSpawnEnv (the real session spawn env)', () => {
  it('a card in ws A gets ws A\'s MCP server + token; a card in ws B never does', async () => {
    const a = svc.createServer({ workspace: 'ws-a', name: 'Alpha', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key: STUB_API_KEY }, 1)
    await svc.testServer(a.id)
    const objective = (ws: string) => ({ id: 990001, title: 't', workspace: ws, status: 'working', created_by: 1 }) as unknown as Parameters<typeof buildSpawnEnv>[0]['objective']
    const envA = buildSpawnEnv({ objective: objective('ws-a'), homeDir: os.tmpdir(), sessionKind: 'worker' })
    const envB = buildSpawnEnv({ objective: objective('ws-b'), homeDir: os.tmpdir(), sessionKind: 'worker' })
    expect(envA[svc.sessionTokenEnvName(a.id)]).toBe(STUB_API_KEY)
    expect(svc.parseSpawnDescriptor(envA).map(s => s.key)).toEqual(['alpha'])
    expect(envB[svc.sessionTokenEnvName(a.id)]).toBeUndefined()
    expect(envB[svc.WORKSPACE_MCP_ENV]).toBeUndefined()
    expect(Object.values(envB)).not.toContain(STUB_API_KEY)
    // The secrets-store copy is never bulk-injected under its store key.
    expect(envA[svc.mcpSecretKey(a.id, 'ACCESS_TOKEN')]).toBeUndefined()
  })
})
