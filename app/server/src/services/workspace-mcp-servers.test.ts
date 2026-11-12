/**
 * Workspace MCP servers (obj 900620) — integration tests against a local stub
 * MCP server (src/__fixtures__/stub-mcp-server.ts): no-auth, bearer/API key,
 * OAuth (DCR, CIMD, guided/manual) with PKCE + refresh, legacy SSE fallback,
 * plus storage redaction, workspace isolation and session config rendering.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 21).toString('base64')
process.env.DB_PATH = path.join(os.tmpdir(), `cc-wsmcp-test-${process.pid}-${Date.now()}.db`)
process.env.JWT_SECRET = 'test-secret-wsmcp'
process.env.APP_BASE_URL = 'https://cc.example.test'

const { initDb, getDb } = await import('../db/index.js')
const svc = await import('./workspace-mcp-servers.js')
const store = await import('./secrets-store.js')
const { detectAuth } = await import('../mcp-servers/auth-detect.js')
const { mcpToolSetFor, runMcpTool } = await import('./agent-chat/mcp-tools.js')
const cfg = await import('./workspace-mcp-config.js')
const { writeCodexMcpProfile } = await import('./session-harness-mcp.js')
const { buildClaudeCommand } = await import('./session-spawn-command.js')
const { startStubMcpServer, STUB_API_KEY } = await import('../__fixtures__/stub-mcp-server.js')

let stub: Awaited<ReturnType<typeof startStubMcpServer>>

beforeAll(async () => {
  initDb()
  stub = await startStubMcpServer()
})
afterAll(async () => {
  await stub.close()
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM workspace_mcp_servers; DELETE FROM secret_versions; DELETE FROM secrets;')
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run()
  for (const ws of ['ws-a', 'ws-b']) {
    db.prepare("INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)").run(ws, ws.toUpperCase())
  }
  stub.state.asMode = 'dcr'
})

function allTablesText(): string {
  const db = getDb()
  const rows = [
    ...db.prepare('SELECT * FROM workspace_mcp_servers').all(),
    ...db.prepare('SELECT * FROM secrets').all(),
    ...db.prepare('SELECT * FROM secret_versions').all(),
  ]
  return JSON.stringify(rows)
}

async function connectOAuth(workspace = 'ws-a', extra: Partial<Parameters<typeof svc.createServer>[0]> = {}) {
  const url = `${stub.baseUrl}/oauth/mcp`
  const d = await detectAuth({ url, fetchImpl: svc.mcpFetch() })
  if (!d.ok || d.data.auth !== 'oauth') throw new Error(`detect failed: ${JSON.stringify(d)}`)
  const row = svc.createServer({ workspace, name: 'Stub OAuth', url, auth_type: 'oauth', detected: d.data, ...extra }, 1)
  const start = await svc.startOAuth(row.id, 1)
  if (!start.ok) throw new Error(start.error)
  // The stub's /as/authorize auto-consents and 302s back to our callback.
  const res = await fetch(start.redirectUrl, { redirect: 'manual' })
  const back = new URL(res.headers.get('location')!)
  expect(back.origin + back.pathname).toBe('https://cc.example.test/api/mcp-servers/oauth/callback')
  const done = await svc.completeOAuth(back.searchParams.get('state')!, back.searchParams.get('code')!)
  return { row, start, done, detected: d.data }
}

describe('no-auth server', () => {
  it('create + test: initialize, paginated tools/list, server name/version, malformed tools dropped', async () => {
    const row = svc.createServer({ workspace: 'ws-a', name: 'Open Stub', url: `${stub.baseUrl}/noauth/mcp`, auth_type: 'none' }, 1)
    const t = await svc.testServer(row.id)
    expect(t?.ok).toBe(true)
    const s = svc.toSummary(t!.row)
    expect(s.status).toBe('connected')
    expect(s.server_name).toBe('stub-noauth')
    expect(s.server_version).toBe('1.2.3')
    expect(s.detected_transport).toBe('streamable_http')
    expect(s.tools.map(x => x.name)).toEqual(['echo', 'add', 'search_docs'])
    expect(s.tools.find(x => x.name === 'echo')?.description).toBe('Echo the input back')
  })

  it('falls back to the legacy HTTP+SSE transport', async () => {
    const row = svc.createServer({ workspace: 'ws-a', name: 'Legacy', url: `${stub.baseUrl}/sse`, auth_type: 'none' }, 1)
    const t = await svc.testServer(row.id)
    expect(t?.ok).toBe(true)
    expect(t!.row.detected_transport).toBe('sse')
    expect(t!.row.server_name).toBe('stub-legacy-sse')
  })

  it('clear errors: protocol mismatch, not an MCP endpoint, unreachable', async () => {
    const bad = svc.createServer({ workspace: 'ws-a', name: 'Bad proto', url: `${stub.baseUrl}/badproto/mcp`, auth_type: 'none' }, 1)
    const t1 = await svc.testServer(bad.id)
    expect(t1).toMatchObject({ ok: false, kind: 'protocol' })
    expect(t1 && !t1.ok && t1.error).toMatch(/Protocol mismatch.*1999-01-01/)

    const html = svc.createServer({ workspace: 'ws-a', name: 'Not MCP', url: `${stub.baseUrl}/notmcp`, auth_type: 'none' }, 1)
    expect(await svc.testServer(html.id)).toMatchObject({ ok: false, kind: 'protocol' })

    const down = svc.createServer({ workspace: 'ws-a', name: 'Down', url: 'http://127.0.0.1:1/mcp', auth_type: 'none' }, 1)
    const t3 = await svc.testServer(down.id)
    expect(t3).toMatchObject({ ok: false, kind: 'unreachable' })
    expect(svc.getServerRow(down.id)!.status).toBe('error')
  })
})

describe('API key / bearer server', () => {
  it('detects api_key, stores the key encrypted in the secrets store, never in a summary', async () => {
    const d = await detectAuth({ url: `${stub.baseUrl}/bearer/mcp`, fetchImpl: svc.mcpFetch() })
    expect(d.ok && d.data.auth).toBe('api_key')

    const row = svc.createServer({ workspace: 'ws-a', name: 'Bearer Stub', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key: STUB_API_KEY }, 1)
    const t = await svc.testServer(row.id)
    expect(t?.ok).toBe(true)
    expect(t!.row.server_name).toBe('stub-bearer') // replies were SSE-wrapped
    const summary = svc.toSummary(t!.row)
    expect(summary.has_credential).toBe(true)
    expect(JSON.stringify(summary)).not.toContain(STUB_API_KEY)
    // Ciphertext only, at rest: the plaintext key appears in no table.
    expect(allTablesText()).not.toContain(STUB_API_KEY)
    const secret = store.getSecret({ scopeType: 'workspace', workspace: 'ws-a' }, svc.mcpSecretKey(row.id, 'ACCESS_TOKEN'))
    expect(secret?.serviceOnly).toBe(true)
  })

  it('store keys are server-only: never bulk-resolved into a session env or listed for the broker', () => {
    const row = svc.createServer({ workspace: 'ws-a', name: 'Bearer', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key: STUB_API_KEY }, 1)
    const resolved = store.resolveSecrets({ workspace: 'ws-a', includeServiceOnly: true })
    expect(Object.keys(resolved)).not.toContain(svc.mcpSecretKey(row.id, 'ACCESS_TOKEN'))
    expect(store.resolveSecretNames({ workspace: 'ws-a' })).not.toContain(svc.mcpSecretKey(row.id, 'ACCESS_TOKEN'))
  })

  it('a wrong key is an auth failure with a clear message', async () => {
    const row = svc.createServer({ workspace: 'ws-a', name: 'Bearer bad', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key: 'wrong-key' }, 1)
    const t = await svc.testServer(row.id)
    expect(t).toMatchObject({ ok: false, kind: 'auth_failed' })
    expect(t && !t.ok && t.error).toMatch(/rejected the credentials/)
    expect(t && !t.ok && t.error).not.toContain('wrong-key')
    expect(svc.getServerRow(row.id)!.status).toBe('needs_auth')
  })

  it('unauthenticated test of an auth server is "auth required"', async () => {
    const row = svc.createServer({ workspace: 'ws-a', name: 'Open?', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'none' }, 1)
    expect(await svc.testServer(row.id)).toMatchObject({ ok: false, kind: 'auth_required' })
  })
})

describe('OAuth', () => {
  it('DCR: registers a client, PKCE + resource indicator, exchanges code, stores tokens, lists tools', async () => {
    const { row, done } = await connectOAuth()
    expect(done.ok).toBe(true)
    expect(stub.state.registered).toHaveLength(1)
    expect(stub.state.registered[0].redirect_uris).toEqual(['https://cc.example.test/api/mcp-servers/oauth/callback'])
    const q = stub.state.lastAuthorizeParams!
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.get('resource')).toBe(`${stub.baseUrl}/oauth/mcp`)
    expect(q.get('scope')).toBe('mcp:read mcp:write') // from the 401 challenge
    expect(stub.state.lastTokenBody?.get('resource')).toBe(`${stub.baseUrl}/oauth/mcp`)

    const t = await svc.testServer(row.id)
    expect(t?.ok).toBe(true)
    const s = svc.toSummary(t!.row)
    expect(s).toMatchObject({ auth_type: 'oauth', oauth_registration: 'dcr', has_credential: true, has_refresh_token: true, status: 'connected', server_name: 'stub-oauth' })
    // Neither token nor DCR client secret is in any table in plaintext, or in the summary.
    const text = allTablesText() + JSON.stringify(s)
    for (const tok of [...stub.state.validTokens, ...stub.state.refreshTokens.keys(), stub.state.registered[0].client_secret]) {
      expect(text).not.toContain(tok)
    }
  })

  it('CIMD: the client_id IS this install\'s metadata URL; no registration call', async () => {
    stub.state.asMode = 'cimd'
    const before = stub.state.registered.length
    const { start, done } = await connectOAuth()
    expect(done.ok).toBe(true)
    expect(stub.state.registered.length).toBe(before)
    expect(new URL(start.ok ? start.redirectUrl : '').searchParams.get('client_id')).toBe('https://cc.example.test/api/mcp-servers/oauth/client-metadata')
    const doc = svc.mcpClientMetadataDocument()
    expect(doc.client_id).toBe('https://cc.example.test/api/mcp-servers/oauth/client-metadata')
    expect(doc.redirect_uris).toEqual(['https://cc.example.test/api/mcp-servers/oauth/callback'])
    expect(doc.token_endpoint_auth_method).toBe('none')
  })

  it('guided (no DCR/CIMD): needs a pasted client ID, then uses it', async () => {
    stub.state.asMode = 'manual'
    const url = `${stub.baseUrl}/oauth/mcp`
    const d = await detectAuth({ url, fetchImpl: svc.mcpFetch() })
    expect(d.ok && d.data.auth === 'oauth' && d.data.registration).toBe('manual')
    if (!d.ok || d.data.auth !== 'oauth') return
    const detected = d.data
    expect(() => svc.createServer({ workspace: 'ws-a', name: 'Manual', url, auth_type: 'oauth', detected }, 1)).toThrow(/client ID/)
    stub.state.registered.push({ client_id: 'manual-client', client_secret: 'manual-secret', redirect_uris: [] })
    const { done, start } = await connectOAuth('ws-a', { oauth_client_id: 'manual-client', oauth_client_secret: 'manual-secret' })
    expect(done.ok).toBe(true)
    expect(new URL(start.ok ? start.redirectUrl : '').searchParams.get('client_id')).toBe('manual-client')
    expect(stub.state.lastTokenBody?.get('client_secret')).toBe('manual-secret')
    expect(allTablesText()).not.toContain('manual-secret')
  })

  it('a forged or mismatched state is refused', async () => {
    const r1 = await svc.completeOAuth('not-a-jwt', 'code')
    expect(r1.ok).toBe(false)
    const { row } = await connectOAuth()
    const jwt = (await import('jsonwebtoken')).default
    const forged = jwt.sign({ uid: 1, connector: `mcp-server:${row.id}`, verifier: 'x' }, 'some-other-secret')
    expect(await svc.completeOAuth(forged, 'code')).toMatchObject({ ok: false, error: 'invalid_state' })
  })

  it('refreshes an expiring access token (rotating refresh token) and keeps working', async () => {
    const { row } = await connectOAuth()
    await svc.testServer(row.id)
    const oldEnv = svc.spawnEnvFor('ws-a')[svc.sessionTokenEnvName(row.id)]
    getDb().prepare("UPDATE workspace_mcp_servers SET token_expires_at = ? WHERE id = ?").run(new Date(Date.now() + 30_000).toISOString(), row.id)
    expect(svc.needsRefresh(svc.getServerRow(row.id)!)).toBe(true)
    stub.state.validTokens.delete(oldEnv) // the old access token stops working
    expect(await svc.refreshServerToken(row.id)).toBe(true)
    expect(stub.state.lastTokenBody?.get('grant_type')).toBe('refresh_token')
    const newEnv = svc.spawnEnvFor('ws-a')[svc.sessionTokenEnvName(row.id)]
    expect(newEnv).not.toBe(oldEnv)
    expect(svc.needsRefresh(svc.getServerRow(row.id)!)).toBe(false)
    expect((await svc.testServer(row.id))?.ok).toBe(true)
  })

  it('a refresh the provider rejects marks the server needs_auth', async () => {
    const { row } = await connectOAuth()
    stub.state.refreshTokens.clear()
    expect(await svc.refreshServerToken(row.id)).toBe(false)
    expect(svc.getServerRow(row.id)!.status).toBe('needs_auth')
  })
})

describe('disconnect', () => {
  it('removes the row and revokes every local credential', async () => {
    const { row } = await connectOAuth()
    const scope = { scopeType: 'workspace' as const, workspace: 'ws-a' }
    expect(store.getSecret(scope, svc.mcpSecretKey(row.id, 'ACCESS_TOKEN'))).not.toBeNull()
    expect(store.getSecret(scope, svc.mcpSecretKey(row.id, 'REFRESH_TOKEN'))).not.toBeNull()
    expect(store.getSecret(scope, svc.mcpSecretKey(row.id, 'CLIENT_SECRET'))).not.toBeNull()
    expect(svc.deleteServer(row.id, 1)).toBe(true)
    expect(svc.getServerRow(row.id)).toBeNull()
    for (const k of ['ACCESS_TOKEN', 'REFRESH_TOKEN', 'CLIENT_SECRET'] as const) {
      expect(store.getSecret(scope, svc.mcpSecretKey(row.id, k))).toBeNull()
    }
    expect(svc.spawnEnvFor('ws-a')).toEqual({})
  })
})

describe('workspace isolation (sessions + chat bots)', () => {
  async function twoWorkspaces() {
    const a = svc.createServer({ workspace: 'ws-a', name: 'Alpha Docs', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key: STUB_API_KEY }, 1)
    const b = svc.createServer({ workspace: 'ws-b', name: 'Beta CRM', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key: 'beta-only-key' }, 1)
    await svc.testServer(a.id)
    // ws-b's server is connected too (status forced: its key is not the stub's).
    getDb().prepare("UPDATE workspace_mcp_servers SET status = 'connected', tools_json = ? WHERE id = ?").run(JSON.stringify([{ name: 'crm_lookup', description: 'x', input_schema: {} }]), b.id)
    return { a, b }
  }

  it('a session spawned in ws A gets ws A\'s servers and token only — never ws B\'s', async () => {
    const { a, b } = await twoWorkspaces()
    const envA = svc.spawnEnvFor('ws-a')
    const descA = svc.parseSpawnDescriptor(envA)
    expect(descA.map(s => s.key)).toEqual(['alpha-docs'])
    expect(envA[svc.sessionTokenEnvName(a.id)]).toBe(STUB_API_KEY)
    expect(envA[svc.sessionTokenEnvName(b.id)]).toBeUndefined()
    expect(JSON.stringify(envA)).not.toContain('beta-only-key')
    expect(JSON.stringify(envA)).not.toContain('beta-crm')

    const envB = svc.spawnEnvFor('ws-b')
    expect(svc.parseSpawnDescriptor(envB).map(s => s.key)).toEqual(['beta-crm'])
    expect(JSON.stringify(envB)).not.toContain(STUB_API_KEY)

    expect(svc.spawnEnvFor(null)).toEqual({})
    expect(svc.spawnEnvFor('')).toEqual({})
    expect(svc.spawnEnvFor('ws-unknown')).toEqual({})
  })

  it('disabled servers and servers that are not connected are not injected', async () => {
    const { a } = await twoWorkspaces()
    svc.updateServer(a.id, { enabled: false }, 1)
    expect(svc.spawnEnvFor('ws-a')).toEqual({})
  })

  it('chat bots: only agents that list `mcp`, only their workspace, and calls cannot cross workspaces', async () => {
    const { a, b } = await twoWorkspaces()
    expect(mcpToolSetFor({ tools: ['search'] }, 'ws-a').specs).toEqual([])
    const setA = mcpToolSetFor({ tools: ['mcp'] }, 'ws-a')
    expect(setA.specs.map(s => s.function.name)).toEqual(['mcp__alpha-docs__echo', 'mcp__alpha-docs__add', 'mcp__alpha-docs__search_docs'])
    expect(setA.specs.some(s => s.function.name.includes('beta'))).toBe(false)

    const out = await runMcpTool('ws-a', setA, 'mcp__alpha-docs__add', { a: 2, b: 3 })
    expect(JSON.stringify(out.result)).toContain('5')
    await expect(runMcpTool('ws-a', setA, 'mcp__beta-crm__crm_lookup', {})).rejects.toThrow(/not allowed/)
    await expect(svc.callServerTool('ws-a', b.id, 'crm_lookup', {})).rejects.toThrow(/not connected in this workspace/)
    void a
  })

  it('per-tool disable hides the tool from chat and from sessions', async () => {
    const { a } = await twoWorkspaces()
    svc.updateServer(a.id, { disabled_tools: ['add'] }, 1)
    const set = mcpToolSetFor({ tools: ['mcp'] }, 'ws-a')
    expect(set.specs.map(s => s.function.name)).not.toContain('mcp__alpha-docs__add')
    await expect(svc.callServerTool('ws-a', a.id, 'add', { a: 1, b: 1 })).rejects.toThrow(/turned off/)
    const desc = svc.parseSpawnDescriptor(svc.spawnEnvFor('ws-a'))
    expect(desc[0].disabled_tools).toEqual(['add'])
    expect(cfg.claudeDisallowedTools(desc)).toEqual(['mcp__alpha-docs__add'])
    expect(svc.toSummary(svc.getServerRow(a.id)!).tools.find(t => t.name === 'add')?.enabled).toBe(false)
  })
})

describe('session MCP config rendering', () => {
  it('Claude config references the token by env var; the file never holds it; platform servers win', async () => {
    const a = svc.createServer({ workspace: 'ws-a', name: 'Playwright', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key: STUB_API_KEY }, 1)
    expect(a.slug).toBe('playwright-mcp') // reserved key is never taken
    await svc.testServer(a.id)
    const desc = svc.parseSpawnDescriptor(svc.spawnEnvFor('ws-a'))
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsmcp-cfg-'))
    const base = path.join(dir, 'base.json')
    fs.writeFileSync(base, JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] } } }))
    const out = cfg.writeWorkspaceMcpConfig({ outPath: base, basePath: base, servers: desc })
    const written = fs.readFileSync(out!, 'utf8')
    const parsed = JSON.parse(written)
    expect(parsed.mcpServers.playwright).toEqual({ command: 'npx', args: ['@playwright/mcp'] })
    expect(parsed.mcpServers['playwright-mcp']).toEqual({
      type: 'http',
      url: `${stub.baseUrl}/bearer/mcp`,
      headers: { Authorization: `Bearer \${${svc.sessionTokenEnvName(a.id)}}` },
    })
    expect(written).not.toContain(STUB_API_KEY)

    // Codex profile: env var NAME, never the value.
    const profile = writeCodexMcpProfile(dir, 'sess-1', out, desc)
    const toml = fs.readFileSync(path.join(dir, `${profile}.config.toml`), 'utf8')
    expect(toml).toContain('[mcp_servers.playwright-mcp]')
    expect(toml).toContain(`bearer_token_env_var = "${svc.sessionTokenEnvName(a.id)}"`)
    expect(toml).toContain('[mcp_servers.playwright]')
    expect(toml).not.toContain(STUB_API_KEY)
  })

  it('a custom header key is passed through env_http_headers for Codex', () => {
    const row = svc.createServer({ workspace: 'ws-a', name: 'Hdr', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', auth_header_name: 'X-Api-Key', api_key: 'k-123' }, 1)
    getDb().prepare("UPDATE workspace_mcp_servers SET status = 'connected' WHERE id = ?").run(row.id)
    const desc = svc.parseSpawnDescriptor(svc.spawnEnvFor('ws-a'))
    expect(desc[0].headers).toEqual({ 'X-Api-Key': `\${${svc.sessionTokenEnvName(row.id)}}` })
    const toml = cfg.workspaceServersToToml(desc)
    expect(toml).toContain('[mcp_servers.hdr.env_http_headers]')
    expect(toml).toContain(`"X-Api-Key" = "${svc.sessionTokenEnvName(row.id)}"`)
  })

  it('claude command carries --disallowedTools for turned-off tools only', () => {
    const cmd = buildClaudeCommand({ engine: 'claude', budget: 1, effortLevel: 'low', disallowedTools: ['mcp__docs__delete_page', 'Bash; rm -rf /'] })
    expect(cmd).toContain('--disallowedTools "mcp__docs__delete_page"')
    expect(cmd).not.toContain('rm -rf')
    expect(buildClaudeCommand({ engine: 'claude', budget: 1, effortLevel: 'low' })).not.toContain('--disallowedTools')
  })
})

describe('input validation', () => {
  it('rejects unknown workspaces, unsafe URLs and bad header names', () => {
    expect(() => svc.createServer({ workspace: 'nope', name: 'x', url: 'https://mcp.example.com', auth_type: 'none' }, 1)).toThrow(/Unknown workspace/)
    expect(() => svc.createServer({ workspace: 'ws-a', name: 'x', url: 'https://169.254.169.254/', auth_type: 'none' }, 1)).toThrow(/public internet/)
    expect(() => svc.createServer({ workspace: 'ws-a', name: 'x', url: 'https://mcp.example.com', auth_type: 'api_key', auth_header_name: 'Host', api_key: 'k' }, 1)).toThrow(/cannot be used/)
    expect(() => svc.createServer({ workspace: 'ws-a', name: 'x', url: 'https://mcp.example.com', auth_type: 'api_key', api_key: 'a\r\nX-Evil: 1' }, 1)).toThrow(/not a valid header/)
    expect(() => svc.createServer({ workspace: 'ws-a', name: 'x', url: 'https://mcp.example.com', auth_type: 'oauth' }, 1)).toThrow(/Detect/)
  })

  it('slugs are unique per workspace', () => {
    const r1 = svc.createServer({ workspace: 'ws-a', name: 'Docs!', url: 'https://mcp.example.com/a', auth_type: 'none' }, 1)
    const r2 = svc.createServer({ workspace: 'ws-a', name: 'docs', url: 'https://mcp.example.com/b', auth_type: 'none' }, 1)
    const r3 = svc.createServer({ workspace: 'ws-b', name: 'docs', url: 'https://mcp.example.com/c', auth_type: 'none' }, 1)
    expect([r1.slug, r2.slug, r3.slug]).toEqual(['docs', 'docs-2', 'docs'])
  })

  it('Authorization values: bare key → Bearer; a pasted scheme is kept', () => {
    expect(svc.authHeaderFor('Authorization', 'abc')).toEqual({ name: 'Authorization', value: 'Bearer abc', bearer: true })
    expect(svc.authHeaderFor('Authorization', 'Token abc')).toEqual({ name: 'Authorization', value: 'Token abc', bearer: false })
    expect(svc.authHeaderFor('X-Api-Key', 'abc')).toEqual({ name: 'X-Api-Key', value: 'abc', bearer: false })
  })
})
