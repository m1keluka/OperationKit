/**
 * /api/integrations (obj 900682): "Make my own" starts an Integrations bot card;
 * only that card's session (or an admin) may use the builder routes; the MCP
 * path reuses #900620's connect code and resolves the key by NAME (no value in
 * any request or response); the Tool path scaffolds through okit.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { AddressInfo } from 'net'

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 29).toString('base64')
process.env.DB_PATH = path.join(os.tmpdir(), `cc-intbuilder-test-${process.pid}-${Date.now()}.db`)
process.env.JWT_SECRET = 'test-secret-intbuilder'
process.env.APP_BASE_URL = 'https://cc.example.test'

// Starting a real session needs tmux; the start leg has its own tests.
vi.mock('./objectives-create-start.js', () => ({
  startCreatedObjective: vi.fn(async () => ({ httpStatus: 201, body: { start: { started: false, detail: 'test: not started' } } })),
}))

const { initDb, getDb } = await import('../db/index.js')
const { default: router, toolPayload } = await import('./integrations-builder.js')
const { default: mcpRouter } = await import('./mcp-servers.js')
const { setSecret } = await import('../services/secrets-store.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { startStubMcpServer, STUB_API_KEY } = await import('../__fixtures__/stub-mcp-server.js')

const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-intbuilder-okit-'))
const STUB_BIN = path.join(STUB_DIR, 'okit')
const STUB_LOG = path.join(STUB_DIR, 'call.json')
const STUB_OUT = path.join(STUB_DIR, 'reply.json')
// A node stub (no python needed): records argv + stdin, prints the staged reply.
const STUB_SOURCE = `#!/usr/bin/env node
const fs = require('fs')
const argv = process.argv.slice(2)
let stdin = ''
try { if (argv.includes('--from-json')) stdin = fs.readFileSync(0, 'utf8') } catch {}
fs.writeFileSync(process.env.OKIT_STUB_LOG, JSON.stringify({ argv, stdin }))
const reply = JSON.parse(fs.readFileSync(process.env.OKIT_STUB_OUT, 'utf8'))
process.stdout.write(JSON.stringify(reply.body || {}))
process.exit(reply.code || 0)
`

let server: http.Server
let base: string
let stub: Awaited<ReturnType<typeof startStubMcpServer>>

function cookie(id: number, role: 'admin' | 'member'): string {
  return `token=${jwt.sign({ id, username: `u${id}`, role }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`
}
const ADMIN = cookie(1, 'admin')
const MEMBER_A = cookie(2, 'member')

type Who = { cookie?: string; session?: string } | null

async function call(method: string, p: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = {}
  if (who?.cookie) headers.Cookie = who.cookie
  if (who?.session) headers['X-CC-Session-Token'] = who.session
  if (body) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}/api${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

function sessionFor(objectiveId: number, workspace = 'ws-a'): string {
  return mintSessionToken({ objectiveId, workspace, actingUserId: 1 })
}

async function startBot(body: Record<string, unknown> = { workspace: 'ws-a', target: 'Acme CRM' }): Promise<number> {
  const r = await call('POST', '/integrations/builder', { cookie: ADMIN }, body)
  expect(r.status).toBe(201)
  return r.json.objective_id as number
}

beforeAll(async () => {
  initDb()
  fs.writeFileSync(STUB_BIN, STUB_SOURCE)
  fs.chmodSync(STUB_BIN, 0o755)
  process.env.OKIT_BIN = STUB_BIN
  process.env.OKIT_STUB_LOG = STUB_LOG
  process.env.OKIT_STUB_OUT = STUB_OUT
  stub = await startStubMcpServer()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/integrations', router)
  app.use('/api/mcp-servers', mcpRouter)
  server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await stub.close()
  await new Promise(r => server.close(r))
  fs.rmSync(STUB_DIR, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM workspace_mcp_servers; DELETE FROM secret_versions; DELETE FROM secrets; DELETE FROM user_workspaces;')
  try { db.exec('DELETE FROM integration_builds; DELETE FROM integration_builder_cards;') } catch { /* created lazily */ }
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'u1', 'x', 'admin')").run()
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (2, 'u2', 'x', 'member')").run()
  for (const ws of ['ws-a', 'ws-b']) db.prepare('INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)').run(ws, ws)
  db.prepare("INSERT INTO user_workspaces (user_id, workspace, role) VALUES (2, 'ws-a', 'member')").run()
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('session_secret_access', '1')").run()
  fs.rmSync(STUB_LOG, { force: true })
  fs.writeFileSync(STUB_OUT, JSON.stringify({ code: 0, body: { written: ['tools/acme/TOOL.md'] } }))
})

describe('POST /integrations/builder ("Make my own")', () => {
  it('needs a signed-in admin and a real workspace', async () => {
    expect((await call('POST', '/integrations/builder', null, { workspace: 'ws-a' })).status).toBe(401)
    expect((await call('POST', '/integrations/builder', { cookie: MEMBER_A }, { workspace: 'ws-a' })).status).toBe(403)
    expect((await call('POST', '/integrations/builder', { cookie: ADMIN }, { workspace: 'nope' })).status).toBe(400)
    expect((await call('POST', '/integrations/builder', { cookie: ADMIN }, { workspace: 'ws-a', docs: 'x'.repeat(9000) })).status).toBe(400)
  })

  it('files a builder card whose brief makes it the Integrations bot', async () => {
    const r = await call('POST', '/integrations/builder', { cookie: ADMIN }, { workspace: 'ws-a', target: 'Acme CRM', docs: 'https://docs.acme.test/api' })
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ ok: true, workspace: 'ws-a', started: false, secret_form_enabled: true })
    const id = r.json.objective_id as number
    const card = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Record<string, string | number>
    expect(card).toMatchObject({ title: 'Integrations bot: Acme CRM', workspace: 'ws-a', status: 'queue', created_by: 1 })
    const brief = String(card.description)
    expect(brief).toContain('You are the **Integrations bot**')
    expect(brief).toContain('https://docs.acme.test/api')
    // Keys go through the in-chat secret form of THIS card, and the 900620 path.
    expect(brief).toContain(`/api/objectives/${id}/request-secret`)
    expect(brief).toContain(`/api/integrations/builder/${id}/mcp-server`)
    expect(brief).toContain('api_key_secret')
    expect(String(card.completion_goal)).toContain('Settings → Integrations')
    expect(getDb().prepare('SELECT workspace, target FROM integration_builder_cards WHERE objective_id = ?').get(id))
      .toEqual({ workspace: 'ws-a', target: 'Acme CRM' })
  })

  it('with nothing filled in, the bot is told to ask; with the secret form off, it says so', async () => {
    getDb().prepare("UPDATE settings SET value = '0' WHERE key = 'session_secret_access'").run()
    const r = await call('POST', '/integrations/builder', { cookie: ADMIN }, { workspace: 'ws-a' })
    expect(r.json).toMatchObject({ secret_form_enabled: false })
    const card = getDb().prepare('SELECT title, description FROM objectives WHERE id = ?').get(r.json.objective_id) as { title: string; description: string }
    expect(card.title).toBe('Integrations bot: new integration')
    expect(card.description).toContain('_not given yet — ask_')
    expect(card.description).toContain('The secret form is OFF on this install')
  })
})

describe('builder routes are confined to the bot card', () => {
  it('refuses strangers, members, other cards, non-builder cards and closed cards', async () => {
    const id = await startBot()
    const url = `/integrations/builder/${id}/detect`
    const body = { url: `${stub.baseUrl}/noauth/mcp` }
    expect((await call('POST', url, null, body)).status).toBe(401)
    expect((await call('POST', url, { cookie: MEMBER_A }, body)).status).toBe(403)
    expect((await call('POST', url, { session: 'ccs_forged.sig' }, body)).status).toBe(401)
    // Another card's token.
    const other = Number(getDb().prepare("INSERT INTO objectives (title, workspace, status) VALUES ('plain', 'ws-a', 'working')").run().lastInsertRowid)
    expect((await call('POST', url, { session: sessionFor(other) }, body)).status).toBe(403)
    // A card that is not an Integrations bot, with its own token.
    expect((await call('POST', `/integrations/builder/${other}/detect`, { session: sessionFor(other) }, body)).status).toBe(404)
    // Its own token works.
    const ok = await call('POST', url, { session: sessionFor(id) }, body)
    expect(ok.status).toBe(200)
    expect(ok.json).toMatchObject({ ok: true, auth: 'none' })
    // Moved to another workspace → refused.
    getDb().prepare("UPDATE objectives SET workspace = 'ws-b' WHERE id = ?").run(id)
    expect((await call('POST', url, { session: sessionFor(id) }, body)).status).toBe(403)
    getDb().prepare("UPDATE objectives SET workspace = 'ws-a', status = 'done' WHERE id = ?").run(id)
    expect((await call('POST', url, { session: sessionFor(id) }, body)).status).toBe(409)
  })
})

describe('MCP path (#900620 connect code, key by NAME)', () => {
  it('never accepts a value; resolves the workspace secret server-side; records the build; no value in any response', async () => {
    const id = await startBot()
    const who = { session: sessionFor(id) }
    const url = `/integrations/builder/${id}/mcp-server`
    const body = { name: 'Acme', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key_secret: 'ACME_API_KEY' }

    const withValue = await call('POST', url, who, { ...body, api_key: STUB_API_KEY })
    expect(withValue.status).toBe(400)
    expect(withValue.text).not.toContain(STUB_API_KEY)

    expect((await call('POST', url, who, { ...body, workspace: 'ws-b' })).status).toBe(403)
    expect((await call('POST', url, who, { ...body, api_key_secret: 'CC_MCP_SERVER_1_TOKEN' })).status).toBe(403)

    const missing = await call('POST', url, who, body)
    expect(missing.status).toBe(409)
    expect(missing.json).toMatchObject({ code: 'secret_missing', secret: 'ACME_API_KEY' })

    // A secret in ANOTHER workspace is not used.
    setSecret({ scope: { scopeType: 'workspace', workspace: 'ws-b' }, key: 'ACME_API_KEY', value: STUB_API_KEY })
    expect((await call('POST', url, who, body)).status).toBe(409)

    // What the in-chat form writes: workspace scope of the card.
    setSecret({ scope: { scopeType: 'workspace', workspace: 'ws-a' }, key: 'ACME_API_KEY', value: STUB_API_KEY, source: 'chat' })
    const made = await call('POST', url, who, body)
    expect(made.status).toBe(201)
    expect(made.json).toMatchObject({
      test: { ok: true },
      server: { workspace: 'ws-a', status: 'connected', has_credential: true, auth_type: 'api_key' },
      build: { kind: 'mcp_server', workspace: 'ws-a', secret_names: ['ACME_API_KEY'], objective_id: id },
    })
    expect(made.text).not.toContain(STUB_API_KEY)

    // It is a normal 900620 server: listed on Settings → Integrations, value never returned.
    const list = await call('GET', '/mcp-servers?workspace=ws-a', { cookie: ADMIN })
    expect((list.json as unknown as { name: string }[]).map(s => s.name)).toEqual(['Acme'])
    expect(list.text).not.toContain(STUB_API_KEY)

    // Disconnecting it in Settings forgets the build record.
    const serverId = (made.json.server as { id: number }).id
    expect((await call('DELETE', `/mcp-servers/${serverId}`, { cookie: ADMIN })).status).toBe(200)
    expect((await call('GET', '/integrations/builds?workspace=ws-a', { cookie: ADMIN })).json).toEqual([])
  })

  it('OAuth servers are created waiting for the person to sign in', async () => {
    const id = await startBot()
    const r = await call('POST', `/integrations/builder/${id}/mcp-server`, { session: sessionFor(id) },
      { name: 'OAuth one', url: `${stub.baseUrl}/oauth/mcp`, auth_type: 'oauth' })
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ server: { status: 'needs_auth' }, test: null })
    expect(String(r.json.next)).toContain('Sign in')
  })
})

describe('Tool path (okit new tool --kind http-api)', () => {
  it('validates input, never carries a value, scaffolds and lists the build for the workspace', async () => {
    const id = await startBot()
    const who = { session: sessionFor(id) }
    const url = `/integrations/builder/${id}/tool`
    const good = {
      name: 'acme', description: 'Read and update Acme CRM contacts and deals.', base_url: 'https://api.acme.test/v2',
      docs_url: 'https://docs.acme.test/api', secrets: [{ env: 'ACME_API_KEY', header: 'Authorization: Bearer $ACME_API_KEY' }],
      body: '## Endpoints\n- GET /contacts',
    }
    expect((await call('POST', url, who, { ...good, base_url: 'http://api.acme.test' })).status).toBe(400)
    expect((await call('POST', url, who, { ...good, name: '../etc' })).status).toBe(400)
    expect((await call('POST', url, who, { ...good, secrets: [{ env: 'lower' }] })).status).toBe(400)

    const dry = await call('POST', url, who, { ...good, dry_run: true })
    expect(dry.status).toBe(200)
    expect(dry.json).toMatchObject({ ok: true, dry_run: true, name: 'acme' })
    const dryCall = JSON.parse(fs.readFileSync(STUB_LOG, 'utf8')) as { argv: string[]; stdin: string }
    expect(dryCall.argv).toEqual(['new', 'tool', 'acme', '--json', '--from-json', '-', '--dry-run'])
    expect((await call('GET', '/integrations/builds?workspace=ws-a', { cookie: ADMIN })).json).toEqual([])

    const real = await call('POST', url, who, good)
    expect(real.status).toBe(201)
    expect(real.json).toMatchObject({ ok: true, name: 'acme', build: { kind: 'tool', ref: 'acme', name: 'Acme', secret_names: ['ACME_API_KEY'] } })
    const sent = JSON.parse((JSON.parse(fs.readFileSync(STUB_LOG, 'utf8')) as { stdin: string }).stdin) as {
      frontmatter: { name: string; kind: string; auth: { secrets: { env: string; source: string }[] } }
      body: string
    }
    expect(sent.frontmatter).toMatchObject({ name: 'acme', kind: 'http-api', auth: { secrets: [{ env: 'ACME_API_KEY', source: 'session-spawn-env' }] } })
    expect(sent.body).toContain('https://api.acme.test/v2')
    expect(sent.body).toContain('## Endpoints')

    const members = await call('GET', '/integrations/builds?workspace=ws-a', { cookie: MEMBER_A })
    expect(members.status).toBe(200)
    expect((members.json as unknown as { ref: string }[]).map(b => b.ref)).toEqual(['acme'])
    expect((await call('GET', '/integrations/builds?workspace=ws-b', { cookie: MEMBER_A })).status).toBe(403)
  })

  it('maps okit exit codes: 1 → 422 schema errors, 2 → 409', async () => {
    const id = await startBot()
    const who = { session: sessionFor(id) }
    const good = { name: 'acme', description: 'Read and update Acme CRM contacts.', base_url: 'https://api.acme.test' }
    fs.writeFileSync(STUB_OUT, JSON.stringify({ code: 1, body: { errors: ['description too short'] } }))
    expect((await call('POST', `/integrations/builder/${id}/tool`, who, good)).status).toBe(422)
    fs.writeFileSync(STUB_OUT, JSON.stringify({ code: 2, body: { error: 'exists' } }))
    expect((await call('POST', `/integrations/builder/${id}/tool`, who, good)).status).toBe(409)
  })
})

describe('toolPayload (pure)', () => {
  it('puts env NAMES in frontmatter and refuses server-only names', () => {
    const p = toolPayload({ name: 'acme-crm', description: 'Acme CRM contacts and deals.', base_url: 'https://x.test', secrets: [{ env: 'ACME_KEY' }] }, 'ws-a')
    expect(p.ok).toBe(true)
    if (p.ok) {
      expect(p.name).toBe('Acme Crm')
      expect(JSON.stringify(p.frontmatter)).toContain('ACME_KEY')
      expect(p.body).toContain('`$ACME_KEY`')
    }
    expect(toolPayload({ name: 'a', description: 'Acme CRM contacts.', base_url: 'https://x.test', secrets: [{ env: 'CC_MCP_SERVER_2_TOKEN' }] }, 'ws-a').ok).toBe(false)
  })
})
