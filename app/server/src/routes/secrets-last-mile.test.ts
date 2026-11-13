/**
 * Secrets last mile (obj 900749): MCP-connected bots and in-app chat bots use a
 * NAMED secret through the existing broker. The value is injected server-side on
 * the outbound request only; nothing the bot can read (tool results, errors,
 * tool lists) ever carries it, and the broker's response redaction stays on.
 *
 * Every outbound request goes to a fake fetch, so the test sees exactly what
 * would have left the server. Temp DB only — never the live board.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-last-mile-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-last-mile-xxxxxx'
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.CC_REDACT_ENV_FILES = ''
process.env.CC_SECRETS_BROKER_RATE_PER_MIN = '1000'
delete process.env.CC_SECRETS_BROKER_POLICY

const { initDb, getDb } = await import('../db/index.js')
const { issueApiKey } = await import('../lib/api-keys.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { agentKeyGuard, requiredScope } = await import('../middleware/agent-key-guard.js')
const { setSecret, listSecrets } = await import('../services/secrets-store.js')
const { resetRateLimits } = await import('../services/file-access.js')
const { setBrokerFetchForTests, setBrokerPolicyEntry, validatePolicyEntry, getBrokerPolicy, callerForAgentKey } = await import('../services/secrets-broker.js')
const { runChatTool, effectiveTools, toolSpecsFor, ToolUseError } = await import('../services/agent-chat/tools.js')
const { ALL_TOOLS_GRANT, TOOL_CATALOG } = await import('../services/agent-chat/tool-names.js')
const { applyBotConfig } = await import('../services/agent-chat/bot-config.js')
const { default: brokerRouter } = await import('./secrets-broker.js')
const { default: secretsRouter } = await import('./secrets.js')
const { default: agentMcpRouter } = await import('./agent-mcp.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN_ID = 1
const MEMBER_ID = 2
const SHARED = 'shared_global_value_0123456789'      // global, policy tags example2
const EXAMPLE2 = 'example2_workspace_value_abcdefghij'     // workspace example2
const EXAMPLE = 'example_workspace_value_klmnopqrst'       // workspace example
const UNTAGGED = 'untagged_global_value_uvwxyz012'  // global, policy tags nobody
const DENIED = 'no_policy_value_3456789abcdefgh'    // global, no policy at all
const ALL_VALUES = [SHARED, EXAMPLE2, EXAMPLE, UNTAGGED, DENIED]

let server: http.Server
let baseUrl: string
let legacyAdminKey: string
let useKey: string          // secrets:use, workspaces [example2], owner = admin
let noScopeKey: string      // default scopes (no secrets:use)
let allWsKey: string        // secrets:use, every workspace of the owner (member in example2 only)

interface Sent { url: string; init: RequestInit }
let sent: Sent[] = []
let reply: (url: string, init: RequestInit) => Response

const adminCookie = () => `token=${jwt.sign({ id: ADMIN_ID, username: 'operator', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
const noValues = (s: string) => { for (const v of ALL_VALUES) expect(s).not.toContain(v) }
const headerOf = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name]

function mint(owner: { id: number; role: 'admin' | 'member' }, label: string, scopes: string[] | undefined, workspaces: string[] | null): string {
  const r = createAgentKey(owner, { label, scopes, workspaces })
  if (!r.ok) throw new Error(r.error)
  return r.key.token
}

async function call(method: string, p: string, opts: { bearer?: string; cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: {
      ...(opts.bearer ? { Authorization: `Bearer ${opts.bearer}` } : {}),
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* keep text */ }
  return { status: res.status, text, json }
}

let rpcId = 1
async function mcp(method: string, params: unknown, bearer: string) {
  return call('POST', '/api/mcp', { bearer, body: { jsonrpc: '2.0', id: rpcId++, method, params } })
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const ins = db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`)
  ins.run(ADMIN_ID, 'operator', 'admin')
  ins.run(MEMBER_ID, 'gbot', 'member')
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'example2', 'member')`).run(MEMBER_ID)

  setSecret({ scope: { scopeType: 'global' }, key: 'SHARED_API_KEY', value: SHARED })
  setSecret({ scope: { scopeType: 'workspace', workspace: 'example2' }, key: 'EXAMPLE2_API_KEY', value: EXAMPLE2 })
  setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'EXAMPLE_API_KEY', value: EXAMPLE })
  setSecret({ scope: { scopeType: 'global' }, key: 'UNTAGGED_KEY', value: UNTAGGED })
  setSecret({ scope: { scopeType: 'global' }, key: 'DENIED_KEY', value: DENIED })
  setBrokerPolicyEntry('SHARED_API_KEY', { hosts: ['api.shared.example'], workspaces: ['example2'] })
  setBrokerPolicyEntry('EXAMPLE2_API_KEY', { hosts: ['*.example2.example'] })
  setBrokerPolicyEntry('EXAMPLE_API_KEY', { hosts: ['api.example.example'] })
  setBrokerPolicyEntry('UNTAGGED_KEY', { hosts: ['api.untagged.example'] })

  legacyAdminKey = issueApiKey(ADMIN_ID).token
  useKey = mint({ id: ADMIN_ID, role: 'admin' }, 'Grok: Ops', ['board:read', 'secrets:use'], ['example2'])
  noScopeKey = mint({ id: ADMIN_ID, role: 'admin' }, 'Grok: Plain', undefined, ['example2'])
  allWsKey = mint({ id: MEMBER_ID, role: 'member' }, 'Member bot', ['secrets:use'], null)

  setBrokerFetchForTests(async (url, init) => {
    sent.push({ url, init })
    return reply(url, init)
  })

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/secrets-broker', brokerRouter)
  app.use('/api/secrets', secretsRouter)
  app.use('/api', agentMcpRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  setBrokerFetchForTests(null)
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${TMP_DB}${s}`) } catch {} }
})

beforeEach(() => {
  resetRateLimits()
  sent = []
  // A hostile upstream: echoes every header back, so a missed redaction would show.
  reply = (_url, init) => new Response(JSON.stringify({ echoed: init.headers, ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
})

describe('agent surface: secrets:use scope', () => {
  it('maps only the two broker routes to secrets:use; the store CRUD stays off-surface', () => {
    expect(requiredScope('GET', '/api/secrets-broker/list', undefined)).toEqual({ kind: 'scope', scope: 'secrets:use' })
    expect(requiredScope('POST', '/api/secrets-broker/http', {})).toEqual({ kind: 'scope', scope: 'secrets:use' })
    expect(requiredScope('GET', '/api/secrets', undefined)).toEqual({ kind: 'off_surface' })
    expect(requiredScope('GET', '/api/secrets/bot-access', undefined)).toEqual({ kind: 'off_surface' })
    expect(requiredScope('PUT', '/api/secrets/bot-access/X', {})).toEqual({ kind: 'off_surface' })
  })

  it('a key without the scope is refused with missing_scope', async () => {
    const r = await call('GET', '/api/secrets-broker/list', { bearer: noScopeKey })
    expect(r.status).toBe(403)
    expect(r.json.missing_scope).toBe('secrets:use')
    const u = await call('POST', '/api/secrets-broker/http', { bearer: noScopeKey, body: { url: 'https://api.shared.example/x', headers: { A: '{{secret:SHARED_API_KEY}}' } } })
    expect(u.status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('an admin-owned key is NOT an admin caller: only its workspace + tagged globals', async () => {
    const r = await call('GET', '/api/secrets-broker/list', { bearer: useKey })
    expect(r.status).toBe(200)
    noValues(r.text)
    const names = (r.json.secrets as Loose[]).map(s => s.name).sort()
    expect(names).toEqual(['EXAMPLE2_API_KEY', 'SHARED_API_KEY'])
    // The legacy admin key keeps its old every-name view (unchanged behaviour).
    const legacy = await call('GET', '/api/secrets-broker/list', { bearer: legacyAdminKey })
    expect((legacy.json.secrets as Loose[]).map(s => s.name)).toEqual(expect.arrayContaining(['EXAMPLE_API_KEY', 'UNTAGGED_KEY', 'DENIED_KEY']))
  })

  it('callerForAgentKey narrows to the key allowlist ∩ the owner memberships', () => {
    expect(callerForAgentKey({ id: 2, role: 'member' }, ['example2', 'example'], ['example2'])).toEqual({ userId: 2, isAdmin: false, workspaces: ['example2'], bot: true })
    expect(callerForAgentKey({ id: 2, role: 'member' }, null, ['example2'])).toEqual({ userId: 2, isAdmin: false, workspaces: ['example2'], bot: true })
    expect(callerForAgentKey({ id: 1, role: 'admin' }, ['example2'], [])).toEqual({ userId: 1, isAdmin: false, workspaces: ['example2'], bot: true })
  })

  it('injects the value on the outbound request only, and redacts the echo', async () => {
    const r = await call('POST', '/api/secrets-broker/http', {
      bearer: useKey,
      body: { url: 'https://api.shared.example/v1/me', headers: { Authorization: 'Bearer {{secret:SHARED_API_KEY}}' } },
    })
    expect(r.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(headerOf(sent[0].init, 'Authorization')).toBe(`Bearer ${SHARED}`)
    noValues(r.text)
    expect(r.text).toContain('[REDACTED:SHARED_API_KEY]')
    expect(r.json.redaction_count).toBeGreaterThan(0)
  })

  it('refuses a secret outside the key workspaces, an untagged global, and a disallowed host', async () => {
    for (const [name, host] of [['EXAMPLE_API_KEY', 'api.example.example'], ['UNTAGGED_KEY', 'api.untagged.example'], ['DENIED_KEY', 'api.shared.example']] as const) {
      const r = await call('POST', '/api/secrets-broker/http', { bearer: useKey, body: { url: `https://${host}/x`, headers: { A: `{{secret:${name}}}` } } })
      expect(r.status, name).toBe(404)
      noValues(r.text)
    }
    const wrongHost = await call('POST', '/api/secrets-broker/http', { bearer: useKey, body: { url: 'https://evil.example/x', headers: { A: '{{secret:SHARED_API_KEY}}' } } })
    expect(wrongHost.status).toBe(403)
    expect(wrongHost.json.error).toMatch(/not allowed/)
    // workspace pin outside the key allowlist: the guard answers before the broker.
    const pinned = await call('POST', '/api/secrets-broker/http', { bearer: useKey, body: { workspace: 'example', url: 'https://api.example.example/x', headers: { A: '{{secret:EXAMPLE_API_KEY}}' } } })
    expect(pinned.status).toBe(403)
    expect(sent).toHaveLength(0)
  })

  it('audits every use by name and key label, never the value', async () => {
    await call('POST', '/api/secrets-broker/http', { bearer: useKey, body: { url: 'https://api.shared.example/a', headers: { A: '{{secret:SHARED_API_KEY}}' } } })
    const rows = getDb().prepare(`SELECT detail, metadata FROM activity_log WHERE title = 'secrets_broker_use'`).all() as { detail: string; metadata: string }[]
    expect(rows.length).toBeGreaterThan(0)
    const all = JSON.stringify(rows)
    noValues(all)
    expect(all).toContain('Grok: Ops')
    const log = getDb().prepare(`SELECT * FROM secret_access_log WHERE key = 'SHARED_API_KEY' AND action = 'use'`).all()
    noValues(JSON.stringify(log))
    expect(log.length).toBeGreaterThan(0)
  })
})

describe('MCP tools: list_usable_secrets + call_with_secret', () => {
  const names = async (bearer: string) => ((await mcp('tools/list', {}, bearer)).json.result.tools as Loose[]).map(t => t.name)

  it('appear only for a key holding secrets:use', async () => {
    expect(await names(useKey)).toEqual(expect.arrayContaining(['list_usable_secrets', 'call_with_secret']))
    const plain = await names(noScopeKey)
    expect(plain).not.toContain('list_usable_secrets')
    expect(plain).not.toContain('call_with_secret')
  })

  it('call_with_secret injects server-side and the tool result carries no value', async () => {
    const r = await mcp('tools/call', {
      name: 'call_with_secret',
      arguments: { method: 'POST', url: 'https://x.example2.example/hook', headers: { 'X-Api-Key': '{{secret:EXAMPLE2_API_KEY}}' }, body: { note: 'key={{secret:EXAMPLE2_API_KEY}}' } },
    }, useKey)
    expect(r.status).toBe(200)
    expect(r.json.result.isError).toBeFalsy()
    noValues(r.text)
    expect(sent).toHaveLength(1)
    expect(headerOf(sent[0].init, 'X-Api-Key')).toBe(EXAMPLE2)
    expect(String(sent[0].init.body)).toContain(EXAMPLE2)
    const data = JSON.parse(r.json.result.content[0].text)
    expect(data.secrets_used).toEqual(['EXAMPLE2_API_KEY'])
    expect(data.body).toContain('[REDACTED:EXAMPLE2_API_KEY]')
  })

  it('list_usable_secrets returns names + hosts only', async () => {
    const r = await mcp('tools/call', { name: 'list_usable_secrets', arguments: {} }, useKey)
    noValues(r.text)
    const data = JSON.parse(r.json.result.content[0].text)
    expect(data.secrets.map((s: Loose) => s.name).sort()).toEqual(['EXAMPLE2_API_KEY', 'SHARED_API_KEY'])
    expect(data.secrets.find((s: Loose) => s.name === 'EXAMPLE2_API_KEY').allowed_hosts).toEqual(['*.example2.example'])
  })

  it('a key without the scope gets missing_scope, and nothing leaves the server', async () => {
    const r = await mcp('tools/call', { name: 'call_with_secret', arguments: { url: 'https://x.example2.example/a', headers: { A: '{{secret:EXAMPLE2_API_KEY}}' } } }, noScopeKey)
    expect(r.json.result.isError).toBe(true)
    expect(r.json.result.structuredContent.missing_scope).toBe('secrets:use')
    expect(sent).toHaveLength(0)
  })

  it('the legacy full-access key cannot send through MCP (write tool)', async () => {
    const r = await mcp('tools/call', { name: 'call_with_secret', arguments: { url: 'https://api.shared.example/a', headers: { A: '{{secret:SHARED_API_KEY}}' } } }, legacyAdminKey)
    expect(r.json.result.isError).toBe(true)
    expect(sent).toHaveLength(0)
  })
})

describe('in-app chat bots: secrets_list + secret_http', () => {
  const agent = (tools: string[]): Loose => ({ slug: 'ops-bot', name: 'Ops', tools, knowledge_folders: [] })
  const ctx = (tools: string[], userId = MEMBER_ID, workspace = 'example2'): Loose => ({
    userId, username: userId === ADMIN_ID ? 'operator' : 'gbot', workspace, agent: agent(tools), kbRoot: os.tmpdir(), connectors: { mail: null, calendar: null },
  })

  it('is explicit opt-in: "All tools" does not grant it, naming it does', () => {
    expect(ALL_TOOLS_GRANT.has('secrets')).toBe(false)
    expect(effectiveTools(agent(['all']))).not.toContain('secrets')
    expect(effectiveTools(agent(['all', 'secrets']))).toContain('secrets')
    expect(toolSpecsFor(agent(['secrets'])).map(s => s.function.name)).toEqual(['secrets_list', 'secret_http'])
    expect(TOOL_CATALOG.find(t => t.name === 'secrets')?.explicit_only).toBe(true)
    // An admin's "All tools" switch keeps a secrets grant the bot was given by name.
    const cfg: Loose = { provider: null, model: null, tools: ['search', 'secrets'], all_tools: true }
    expect(applyBotConfig(agent(['search']), cfg).tools).toEqual(['all', 'secrets'])
  })

  it('a bot without the tool is refused before anything is sent', async () => {
    await expect(runChatTool(ctx(['all']), 'secret_http', { url: 'https://x.example2.example/a', headers: { A: '{{secret:EXAMPLE2_API_KEY}}' } })).rejects.toBeInstanceOf(ToolUseError)
    expect(sent).toHaveLength(0)
  })

  it('secret_http injects server-side; the tool result (what the model and chat history get) has no value', async () => {
    const out = await runChatTool(ctx(['secrets']), 'secret_http', {
      url: 'https://x.example2.example/v1', headers: { Authorization: 'Bearer {{secret:EXAMPLE2_API_KEY}}' },
    })
    expect(headerOf(sent[0].init, 'Authorization')).toBe(`Bearer ${EXAMPLE2}`)
    const seen = JSON.stringify(out)
    noValues(seen)
    expect(seen).toContain('[REDACTED:EXAMPLE2_API_KEY]')
    expect(out.summary).toMatch(/EXAMPLE2_API_KEY \(value hidden\)/)
  })

  it('the chat workspace wins over the model, and an admin chatting is not an admin caller', async () => {
    // Model tries to pin another workspace: ignored — still the chat's workspace.
    await expect(runChatTool(ctx(['secrets'], ADMIN_ID), 'secret_http', { url: 'https://api.example.example/a', headers: { A: '{{secret:EXAMPLE_API_KEY}}' }, workspace: 'example' }))
      .rejects.toThrow(/does not exist or is not visible/)
    // An untagged global is invisible to a chat bot even for an admin.
    await expect(runChatTool(ctx(['secrets'], ADMIN_ID), 'secret_http', { url: 'https://api.untagged.example/a', headers: { A: '{{secret:UNTAGGED_KEY}}' } }))
      .rejects.toThrow(/not visible/)
    expect(sent).toHaveLength(0)
    const list = await runChatTool(ctx(['secrets'], ADMIN_ID), 'secrets_list', {})
    noValues(JSON.stringify(list))
    expect((list.result as Loose).secrets.map((s: Loose) => s.name).sort()).toEqual(['EXAMPLE2_API_KEY', 'SHARED_API_KEY'])
  })

  it('a person outside the chat workspace gets nothing', async () => {
    await expect(runChatTool(ctx(['secrets'], MEMBER_ID, 'example'), 'secrets_list', {})).rejects.toThrow(/not a member/)
  })

  it('a refusal message names the host, never a value', async () => {
    const err = await runChatTool(ctx(['secrets']), 'secret_http', { url: 'https://evil.example/a', headers: { A: '{{secret:EXAMPLE2_API_KEY}}' } }).catch(e => e)
    expect(err).toBeInstanceOf(ToolUseError)
    expect(err.message).toMatch(/evil\.example/)
    noValues(err.message)
  })
})

describe('bot-access policy API (Settings → Secrets)', () => {
  it('validates hosts: no schemes, no paths, no bare TLD wildcards', () => {
    expect(() => validatePolicyEntry({ hosts: ['https://api.x.com'] })).toThrow(/host name only/)
    expect(() => validatePolicyEntry({ hosts: ['*.com'] })).toThrow(/too broad/)
    expect(() => validatePolicyEntry({ hosts: ['*'] })).toThrow(/not a host name/)
    expect(() => validatePolicyEntry({ hosts: [] })).toThrow(/at least one/)
    expect(() => validatePolicyEntry({ hosts: ['api.x.com'], methods: ['TRACE'] })).toThrow(/method/)
    expect(validatePolicyEntry({ hosts: 'API.X.com, *.y.example', methods: ['get'] })).toEqual({ hosts: ['api.x.com', '*.y.example'], methods: ['GET'] })
  })

  it('admin (web app) sets and clears one entry; secret rows are untouched', async () => {
    const before = JSON.stringify(listSecrets())
    const g = await call('GET', '/api/secrets/bot-access', { cookie: adminCookie() })
    expect(g.status).toBe(200)
    expect(g.json.source).toBe('settings')
    expect(g.json.policy.SHARED_API_KEY.hosts).toEqual(['api.shared.example'])
    noValues(g.text)

    const put = await call('PUT', '/api/secrets/bot-access/DENIED_KEY', { cookie: adminCookie(), body: { hosts: ['api.denied.example'], methods: ['GET'] } })
    expect(put.status).toBe(200)
    expect(getBrokerPolicy().DENIED_KEY).toMatchObject({ hosts: ['api.denied.example'], methods: ['GET'] })
    const bad = await call('PUT', '/api/secrets/bot-access/DENIED_KEY', { cookie: adminCookie(), body: { hosts: ['*.com'] } })
    expect(bad.status).toBe(400)
    const del = await call('DELETE', '/api/secrets/bot-access/DENIED_KEY', { cookie: adminCookie() })
    expect(del.status).toBe(200)
    expect(getBrokerPolicy().DENIED_KEY).toBeUndefined()

    // Policy edits never write a secret row (version, updatedAt, scope all identical).
    expect(JSON.stringify(listSecrets())).toBe(before)
    const audit = getDb().prepare(`SELECT detail FROM secret_access_log WHERE action = 'bot_access' AND key = 'DENIED_KEY' ORDER BY id`).all() as { detail: string }[]
    expect(audit.map(a => a.detail)).toEqual(['hosts=api.denied.example methods=GET', 'off'])
  })

  it('an API key cannot widen policy, a member cannot read it, an agent key cannot reach it', async () => {
    expect((await call('PUT', '/api/secrets/bot-access/DENIED_KEY', { bearer: legacyAdminKey, body: { hosts: ['api.x.example'] } })).status).toBe(403)
    const member = jwt.sign({ id: MEMBER_ID, username: 'gbot', role: 'member' }, process.env.JWT_SECRET as string)
    expect((await call('GET', '/api/secrets/bot-access', { cookie: `token=${member}` })).status).toBe(403)
    expect((await call('GET', '/api/secrets/bot-access', { bearer: useKey })).status).toBe(403)
    expect(getBrokerPolicy().DENIED_KEY).toBeUndefined()
  })

  it('refuses seat and server-only names', async () => {
    const r = await call('PUT', '/api/secrets/bot-access/CC_MCP_SERVER_7_TOKEN', { cookie: adminCookie(), body: { hosts: ['api.x.example'] } })
    expect(r.status).toBe(400)
  })
})

describe('review hardening (obj 900749)', () => {
  it('refuses wildcards over shared hosting / public suffixes', () => {
    for (const h of ['*.supabase.co', '*.vercel.app', '*.co.uk', '*.com.au', '*.s3.amazonaws.com', '*.workers.dev']) {
      expect(() => validatePolicyEntry({ hosts: [h] }), h).toThrow(/too broad/)
    }
    // Exact hosts on those domains are fine.
    expect(validatePolicyEntry({ hosts: ['abc.supabase.co', 'api.example.co.uk'] }).hosts).toEqual(['abc.supabase.co', 'api.example.co.uk'])
  })

  it('redacts a value an upstream hands back base64-encoded at any offset, hex-encoded, or url-safe', async () => {
    const enc = [
      Buffer.from(`X${EXAMPLE2}`).toString('base64'),
      Buffer.from(`XY${EXAMPLE2}Z`).toString('base64'),
      Buffer.from(`prefix:${EXAMPLE2}`).toString('base64url'),
      Buffer.from(EXAMPLE2).toString('hex'),
    ]
    reply = () => new Response(JSON.stringify({ stored: enc }), { status: 200, headers: { 'content-type': 'application/json' } })
    const r = await call('POST', '/api/secrets-broker/http', { bearer: useKey, body: { url: 'https://x.example2.example/a', headers: { A: '{{secret:EXAMPLE2_API_KEY}}' } } })
    expect(r.status).toBe(200)
    const body = r.json.body as string
    for (const e of enc) expect(body).not.toContain(e)
    // Decoding whatever is left must not reveal the value either.
    for (const chunk of body.match(/[A-Za-z0-9+/_-]{12,}/g) ?? []) {
      expect(Buffer.from(chunk, 'base64').toString('latin1')).not.toContain(EXAMPLE2)
      expect(Buffer.from(chunk, 'base64url').toString('latin1')).not.toContain(EXAMPLE2)
    }
    expect(body).toContain('[REDACTED:EXAMPLE2_API_KEY]')
  })

  it('redacts before truncating, so a value straddling the size cap leaks no prefix', async () => {
    const prev = process.env.CC_SECRETS_BROKER_MAX_RESPONSE_BYTES
    process.env.CC_SECRETS_BROKER_MAX_RESPONSE_BYTES = '100'
    try {
      reply = () => new Response('a'.repeat(90) + EXAMPLE2 + 'tail', { status: 200, headers: { 'content-type': 'text/plain' } })
      const r = await call('POST', '/api/secrets-broker/http', { bearer: useKey, body: { url: 'https://x.example2.example/a', headers: { A: '{{secret:EXAMPLE2_API_KEY}}' } } })
      expect(r.json.body_truncated).toBe(true)
      expect(r.json.body).not.toContain(EXAMPLE2.slice(0, 10))
    } finally {
      if (prev === undefined) delete process.env.CC_SECRETS_BROKER_MAX_RESPONSE_BYTES
      else process.env.CC_SECRETS_BROKER_MAX_RESPONSE_BYTES = prev
    }
  })

  it('a bot cannot use a value too short to redact; a person still can', async () => {
    setSecret({ scope: { scopeType: 'workspace', workspace: 'example2' }, key: 'SHORT_PIN', value: '12345' })
    setBrokerPolicyEntry('SHORT_PIN', { hosts: ['api.pin.example'] })
    const bot = await call('POST', '/api/secrets-broker/http', { bearer: useKey, body: { url: 'https://api.pin.example/a', headers: { A: '{{secret:SHORT_PIN}}' } } })
    expect(bot.status).toBe(403)
    expect(bot.json.error).toMatch(/too short/)
    expect(sent).toHaveLength(0)
    const person = await call('POST', '/api/secrets-broker/http', { bearer: legacyAdminKey, body: { url: 'https://api.pin.example/a', headers: { A: '{{secret:SHORT_PIN}}' } } })
    expect(person.status).toBe(200)
    setBrokerPolicyEntry('SHORT_PIN', null)
  })

  it('a Bearer JWT (not the browser cookie) cannot change bot access', async () => {
    const bearerJwt = jwt.sign({ id: ADMIN_ID, username: 'operator', role: 'admin' }, process.env.JWT_SECRET as string)
    const r = await call('PUT', '/api/secrets/bot-access/DENIED_KEY', { bearer: bearerJwt, body: { hosts: ['api.x.example'] } })
    expect(r.status).toBe(403)
    expect(getBrokerPolicy().DENIED_KEY).toBeUndefined()
  })
})
