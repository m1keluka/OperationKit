/**
 * /api/secrets-broker (obj 715532): list names without values; use a secret
 * via server-side placeholder injection to an allowlisted host only; response
 * redacted; workspace scoping; audit without values. Outbound HTTP goes to a
 * fake fetch so the test can see exactly what would have left the server.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcrypt'

const TMP_DB = path.join(os.tmpdir(), `cc-broker-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-broker-xxxxxx'
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 5).toString('base64')
process.env.CC_REDACT_ENV_FILES = ''
process.env.CC_SECRETS_BROKER_RATE_PER_MIN = '1000'

const { initDb, getDb } = await import('../db/index.js')
const { issueApiKey } = await import('../lib/api-keys.js')
const { setSecret } = await import('../services/secrets-store.js')
const { resetRateLimits } = await import('../services/file-access.js')
const { setBrokerFetchForTests, hostAllowed } = await import('../services/secrets-broker.js')
const { default: brokerRouter } = await import('./secrets-broker.js')

const SUPA = 'supa_service_role_value_0123456789'
const EXAMPLE = 'example_only_value_abcdefghij'
const EXAMPLE2 = 'example2_only_value_klmnopqrst'
const UNPOLICIED = 'no_policy_value_uvwxyz0123'
const ALL_VALUES = [SUPA, EXAMPLE, EXAMPLE2, UNPOLICIED]

let server: http.Server
let baseUrl: string
let adminKey: string
let example2Key: string
let exampleKey: string

interface Sent { url: string; init: RequestInit }
let sent: Sent[] = []
let reply: () => Response = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })

async function call(method: 'GET' | 'POST', p: string, token?: string, body?: unknown) {
  return fetch(`${baseUrl}${p}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  setSecret({ scope: { scopeType: 'global' }, key: 'SUPABASE_SERVICE_ROLE', value: SUPA })
  setSecret({ scope: { scopeType: 'workspace', workspace: 'example' }, key: 'EXAMPLE_API_KEY', value: EXAMPLE })
  setSecret({ scope: { scopeType: 'workspace', workspace: 'example2' }, key: 'EXAMPLE2_API_KEY', value: EXAMPLE2 })
  setSecret({ scope: { scopeType: 'global' }, key: 'NO_POLICY_KEY', value: UNPOLICIED })
  process.env.CC_SECRETS_BROKER_POLICY = JSON.stringify({
    SUPABASE_SERVICE_ROLE: { hosts: ['*.supabase.co'], description: 'service role', workspaces: ['example2'] },
    EXAMPLE_API_KEY: { hosts: ['api.example.example'], methods: ['GET'] },
    EXAMPLE2_API_KEY: { hosts: ['api.example2.example'] },
  })

  const db = getDb()
  const hash = bcrypt.hashSync('pw', 4)
  const adminId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('mike', hash, 'admin').lastInsertRowid)
  const example2Id = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('gbot', hash, 'member').lastInsertRowid)
  const exampleId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('abot', hash, 'member').lastInsertRowid)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'example2', 'member')`).run(example2Id)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'example', 'member')`).run(exampleId)
  adminKey = issueApiKey(adminId).token
  example2Key = issueApiKey(example2Id).token
  exampleKey = issueApiKey(exampleId).token

  setBrokerFetchForTests(async (url, init) => {
    sent.push({ url, init })
    return reply()
  })

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/secrets-broker', brokerRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  setBrokerFetchForTests(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(`${TMP_DB}${s}`) } catch {} }
})

beforeEach(() => {
  resetRateLimits()
  sent = []
  reply = () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
})

const noValues = (s: string) => { for (const v of ALL_VALUES) expect(s).not.toContain(v) }

describe('auth', () => {
  it('401 without a key', async () => {
    expect((await call('GET', '/api/secrets-broker/list')).status).toBe(401)
    expect((await call('POST', '/api/secrets-broker/http', undefined, { url: 'https://x.supabase.co' })).status).toBe(401)
  })
})

describe('GET /list', () => {
  it('admin sees every name with scope + allowed hosts, and no values', async () => {
    const res = await call('GET', '/api/secrets-broker/list', adminKey)
    expect(res.status).toBe(200)
    const raw = await res.text()
    noValues(raw)
    const body = JSON.parse(raw) as { secrets: Array<Record<string, unknown>> }
    // Both sides sorted: the OSS publish transform renames these literals, which reorders them.
    expect(body.secrets.map(s => s.name).sort()).toEqual(['EXAMPLE_API_KEY', 'EXAMPLE2_API_KEY', 'NO_POLICY_KEY', 'SUPABASE_SERVICE_ROLE'].sort())
    expect(body.secrets.find(s => s.name === 'SUPABASE_SERVICE_ROLE')).toEqual({
      name: 'SUPABASE_SERVICE_ROLE', description: 'service role', scope: 'global', workspace: null,
      allowed_hosts: ['*.supabase.co'], allowed_methods: null, usable: true,
    })
    expect(body.secrets.find(s => s.name === 'NO_POLICY_KEY')).toMatchObject({ usable: false, allowed_hosts: [] })
    for (const s of body.secrets) expect(Object.keys(s)).not.toContain('value')
  })

  it('a workspace key sees only its workspace secrets + globals tagged for it', async () => {
    const g = await (await call('GET', '/api/secrets-broker/list', example2Key)).json() as { secrets: Array<{ name: string }> }
    expect(g.secrets.map(s => s.name).sort()).toEqual(['EXAMPLE2_API_KEY', 'SUPABASE_SERVICE_ROLE'].sort())
    const a = await (await call('GET', '/api/secrets-broker/list', exampleKey)).json() as { secrets: Array<{ name: string }> }
    expect(a.secrets.map(s => s.name)).toEqual(['EXAMPLE_API_KEY'])
    expect((await call('GET', '/api/secrets-broker/list?workspace=example', example2Key)).status).toBe(403)
  })
})

describe('POST /http — use without reveal', () => {
  it('injects the value server-side into headers/body/url and returns a redacted response', async () => {
    reply = () => new Response(JSON.stringify({ echoed: SUPA, jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abcdefghijkl' }), {
      status: 201, headers: { 'content-type': 'application/json', 'set-cookie': `s=${SUPA}`, location: `https://x.supabase.co/next?key=${SUPA}` },
    })
    const res = await call('POST', '/api/secrets-broker/http', adminKey, {
      method: 'POST',
      url: 'https://abc.supabase.co/rest/v1/rpc/x?apikey={{secret:SUPABASE_SERVICE_ROLE}}',
      headers: { Authorization: 'Bearer {{secret:SUPABASE_SERVICE_ROLE}}', apikey: '{{ secret:SUPABASE_SERVICE_ROLE }}' },
      body: { nested: ['{{secret:SUPABASE_SERVICE_ROLE}}'] },
    })
    expect(res.status).toBe(200)
    const raw = await res.text()
    noValues(raw)
    const body = JSON.parse(raw)
    expect(body.status).toBe(201)
    expect(body.redacted).toBe(true)
    expect(body.body).toContain('[REDACTED:SUPABASE_SERVICE_ROLE]')
    expect(body.body).toContain('[REDACTED:JWT]')
    expect(body.headers['set-cookie']).toBeUndefined()
    expect(body.headers.location).toContain('[REDACTED:SUPABASE_SERVICE_ROLE]')
    expect(body.secrets_used).toEqual(['SUPABASE_SERVICE_ROLE'])

    // What actually left the server carried the real value.
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(`https://abc.supabase.co/rest/v1/rpc/x?apikey=${SUPA}`)
    const h = sent[0].init.headers as Record<string, string>
    expect(h.Authorization).toBe(`Bearer ${SUPA}`)
    expect(h.apikey).toBe(SUPA)
    expect(JSON.parse(sent[0].init.body as string)).toEqual({ nested: [SUPA] })
    expect(sent[0].init.redirect).toBe('manual')
  })

  it.each([
    ['a host outside the allowlist', 'https://evil.example.com/x'],
    ['a look-alike suffix', 'https://evilsupabase.co/x'],
    ['the apex of a *. pattern', 'https://supabase.co/x'],
  ])('rejects %s (403) and sends nothing', async (_n, url) => {
    const res = await call('POST', '/api/secrets-broker/http', adminKey, { url, headers: { apikey: '{{secret:SUPABASE_SERVICE_ROLE}}' } })
    expect(res.status).toBe(403)
    noValues(await res.text())
    expect(sent).toHaveLength(0)
  })

  it.each([
    ['plain http', { url: 'http://abc.supabase.co/x', headers: { a: '{{secret:SUPABASE_SERVICE_ROLE}}' } }, 400],
    ['a placeholder in the host', { url: 'https://{{secret:SUPABASE_SERVICE_ROLE}}.supabase.co/x' }, 400],
    ['userinfo in the URL', { url: 'https://u:p@abc.supabase.co/x', headers: { a: '{{secret:SUPABASE_SERVICE_ROLE}}' } }, 400],
    ['a non-443 port', { url: 'https://abc.supabase.co:8443/x', headers: { a: '{{secret:SUPABASE_SERVICE_ROLE}}' } }, 400],
    ['no placeholder (not an open proxy)', { url: 'https://abc.supabase.co/x' }, 400],
    ['an unknown secret', { url: 'https://abc.supabase.co/x', headers: { a: '{{secret:NOPE}}' } }, 404],
    ['a secret with no host policy', { url: 'https://abc.supabase.co/x', headers: { a: '{{secret:NO_POLICY_KEY}}' } }, 403],
    ['a method the policy forbids', { method: 'POST', url: 'https://api.example.example/x', headers: { a: '{{secret:EXAMPLE_API_KEY}}' }, body: 'x' }, 403],
  ])('rejects %s', async (_n, payload, status) => {
    const res = await call('POST', '/api/secrets-broker/http', adminKey, payload)
    expect(res.status).toBe(status)
    noValues(await res.text())
    expect(sent).toHaveLength(0)
  })

  it('workspace scoping: a key cannot use another workspace\'s secret, even by name', async () => {
    const res = await call('POST', '/api/secrets-broker/http', example2Key, { url: 'https://api.example.example/x', headers: { k: '{{secret:EXAMPLE_API_KEY}}' } })
    expect(res.status).toBe(404)
    expect(sent).toHaveLength(0)
    const ok = await call('POST', '/api/secrets-broker/http', example2Key, { url: 'https://api.example2.example/x', headers: { k: '{{secret:EXAMPLE2_API_KEY}}' } })
    expect(ok.status).toBe(200)
    expect((sent[0].init.headers as Record<string, string>).k).toBe(EXAMPLE2)
    const tagged = await call('POST', '/api/secrets-broker/http', example2Key, { url: 'https://p.supabase.co/x', headers: { k: '{{secret:SUPABASE_SERVICE_ROLE}}' } })
    expect(tagged.status).toBe(200)
    const untagged = await call('POST', '/api/secrets-broker/http', exampleKey, { url: 'https://p.supabase.co/x', headers: { k: '{{secret:SUPABASE_SERVICE_ROLE}}' } })
    expect(untagged.status).toBe(404)
  })

  it('upstream errors never echo the value (even when the error message contains the URL)', async () => {
    reply = () => { throw new Error(`connect ECONNREFUSED for https://abc.supabase.co/?k=${SUPA}`) }
    const res = await call('POST', '/api/secrets-broker/http', adminKey, { url: 'https://abc.supabase.co/?k={{secret:SUPABASE_SERVICE_ROLE}}' })
    expect(res.status).toBe(502)
    const raw = await res.text()
    noValues(raw)
    expect(raw).toContain('[REDACTED:SUPABASE_SERVICE_ROLE]')
  })

  it('binary responses are withheld (cannot be redacted)', async () => {
    reply = () => new Response(Buffer.from([0, 1, 2, 3]), { status: 200, headers: { 'content-type': 'application/octet-stream' } })
    const body = await (await call('POST', '/api/secrets-broker/http', adminKey, { url: 'https://abc.supabase.co/f', headers: { a: '{{secret:SUPABASE_SERVICE_ROLE}}' } })).json()
    expect(body.body).toBeNull()
    expect(body.body_omitted).toMatch(/binary/)
  })

  it('rate limits per user', async () => {
    process.env.CC_SECRETS_BROKER_RATE_PER_MIN = '2'
    try {
      const p = { url: 'https://abc.supabase.co/x', headers: { a: '{{secret:SUPABASE_SERVICE_ROLE}}' } }
      expect((await call('POST', '/api/secrets-broker/http', adminKey, p)).status).toBe(200)
      expect((await call('POST', '/api/secrets-broker/http', adminKey, p)).status).toBe(200)
      const third = await call('POST', '/api/secrets-broker/http', adminKey, p)
      expect(third.status).toBe(429)
      expect(third.headers.get('retry-after')).toBeTruthy()
    } finally {
      process.env.CC_SECRETS_BROKER_RATE_PER_MIN = '1000'
    }
  })
})

describe('audit', () => {
  it('logs every use (name, key id, workspace, host, status) and never a value — DB rows and console', async () => {
    const logs: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
    try {
      await call('POST', '/api/secrets-broker/http', example2Key, { url: 'https://api.example2.example/x', headers: { k: '{{secret:EXAMPLE2_API_KEY}}' } })
      await call('POST', '/api/secrets-broker/http', example2Key, { url: 'https://evil.example/x', headers: { k: '{{secret:EXAMPLE2_API_KEY}}' } })
    } finally {
      spy.mockRestore()
      errSpy.mockRestore()
    }
    const rows = getDb().prepare(`SELECT workspace, detail, metadata FROM activity_log WHERE title = 'secrets_broker_use' ORDER BY id DESC LIMIT 2`).all() as Array<{ workspace: string; detail: string; metadata: string }>
    expect(rows).toHaveLength(2)
    const [rejected, used] = rows.map(r => ({ ...r, meta: JSON.parse(r.metadata) }))
    expect(used.meta).toMatchObject({ secrets: ['EXAMPLE2_API_KEY'], host: 'api.example2.example', status: '200', workspace: 'example2', auth: 'api_key', key_last4: example2Key.slice(-4) })
    expect(rejected.meta).toMatchObject({ secrets: ['EXAMPLE2_API_KEY'], host: 'evil.example', status: 'rejected:403' })
    const access = getDb().prepare(`SELECT action, scope, key FROM secret_access_log WHERE action = 'use'`).all() as Array<{ action: string; scope: string; key: string }>
    expect(access.some(a => a.key === 'EXAMPLE2_API_KEY' && a.scope.includes('api.example2.example'))).toBe(true)

    const everything = [
      JSON.stringify(getDb().prepare('SELECT * FROM activity_log').all()),
      JSON.stringify(getDb().prepare('SELECT * FROM secret_access_log').all()),
      logs.join('\n'),
    ].join('\n')
    noValues(everything)
    expect(logs.some(l => l.includes('[secrets-broker] use') && l.includes('EXAMPLE2_API_KEY'))).toBe(true)
  })
})

describe('hostAllowed', () => {
  it('exact and *.suffix only', () => {
    expect(hostAllowed('a.supabase.co', ['*.supabase.co'])).toBe(true)
    expect(hostAllowed('a.b.supabase.co', ['*.supabase.co'])).toBe(true)
    expect(hostAllowed('supabase.co', ['*.supabase.co'])).toBe(false)
    expect(hostAllowed('xsupabase.co', ['*.supabase.co'])).toBe(false)
    expect(hostAllowed('api.github.com', ['api.github.com'])).toBe(true)
    expect(hostAllowed('api.github.com.evil.io', ['api.github.com'])).toBe(false)
  })
})
