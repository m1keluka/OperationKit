/**
 * obj 719065 — secrets from chat, end to end over the real routers:
 *  1. request_secret: a worker emits {name, reason, scope} → card needs_secret,
 *     progress + attention + list_secret_requests all surface it (names only).
 *  2. Only a logged-in owner/admin (cookie) can submit; agent keys, Bearer JWTs,
 *     session tokens and a non-owner member are refused.
 *  3. submit → stored at the chosen scope (existing store, versioned) → status
 *     cleared → worker woken with the NAME, no manual step.
 *  4. "+ Add secret" without a request.
 *  6. the value never appears in a response, the transcript, activity rows or a
 *     console line.
 *  7. MCP relay: board:secrets_request mints a one-time upload token; it expires,
 *     cannot be reused, cannot be used for another name; History records the agent.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-secret-requests-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-secret-requests'
process.env.TRANSCRIPT_DIR = TMP
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.CC_REDACT_ENV_FILES = ''

const sendFollowUpMock = vi.fn((sessionId: string, _m: string, _o: unknown, _opts?: unknown) => sessionId)
vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendFollowUp: (...a: [string, string, unknown, unknown]) => sendFollowUpMock(...a) }
})

const { initDb, getDb } = await import('../db/index.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { resolveSecrets, getSecretValue, listVersions } = await import('../services/secrets-store.js')
const { buildAttention } = await import('../lib/agent-control.js')
const trust = await import('../lib/session-trust.js')
const { redeemUploadToken, UPLOAD_TOKEN_TTL_MS } = await import('../services/secret-requests.js')
const { MCP_TOOLS } = await import('./agent-mcp.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: needsSecretRouter } = await import('./objective-needs-secret.js')
const { default: secretUploadRouter } = await import('./secret-upload.js')
const { default: agentControlRouter } = await import('./agent-control.js')

const WS = 'example'
const SESSION = 'cc-719065-1'
const VALUE = 'apify_api_value_that_must_never_leak_8f3k2'
let server: http.Server
let baseUrl: string
let objId: number
let otherObjId: number
let relayKey: { token: string; id: number }
let plainKey: string

const cookieFor = (id: number, username: string, role: string) =>
  `token=${jwt.sign({ id, username, role }, process.env.JWT_SECRET!, { expiresIn: '1h' })}`
const ownerCookie = () => cookieFor(1, 'mike', 'admin')
const ownerBearer = () => jwt.sign({ id: 1, username: 'mike', role: 'admin' }, process.env.JWT_SECRET!, { expiresIn: '1h' })

function setFlag(key: string, on: boolean) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, on ? '1' : '0')
}

async function call(method: string, p: string, headers: Record<string, string>, body?: unknown, raw?: string) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: {
      ...headers,
      ...(raw !== undefined ? { 'Content-Type': 'text/plain' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text }
}

const flush = () => new Promise(r => setTimeout(r, 20))
const workerToken = () => trust.mintSessionToken({ objectiveId: objId, workspace: WS, actingUserId: 1 })

/** Every console line written during the test, joined — for the no-leak assertion. */
const consoleLines: string[] = []

function everythingPersisted(): string {
  const db = getDb()
  const transcript = fs.existsSync(path.join(TMP, `${SESSION}.jsonl`)) ? fs.readFileSync(path.join(TMP, `${SESSION}.jsonl`), 'utf8') : ''
  return [
    transcript,
    JSON.stringify(db.prepare('SELECT * FROM activity_log').all()),
    JSON.stringify(db.prepare('SELECT * FROM secret_access_log').all()),
    JSON.stringify(db.prepare('SELECT * FROM secret_upload_tokens').all()),
    JSON.stringify(db.prepare('SELECT id, needs_secret, last_session_summary FROM objectives').all()),
    consoleLines.join('\n'),
  ].join('\n')
}

beforeAll(async () => {
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console)
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
      void orig
    })
  }
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'mike', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'sam', 'x', 'member')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace) VALUES (2, ?)`).run(WS)
  objId = Number(db.prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id) VALUES ('enrich', 'cto', ?, 1, 'working', ?)`,
  ).run(WS, SESSION).lastInsertRowid)
  otherObjId = Number(db.prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status) VALUES ('other', 'cto', 'example2', 1, 'working')`,
  ).run().lastInsertRowid)
  const relay = createAgentKey({ id: 1, role: 'admin' }, { label: 'Grok Bot', scopes: ['board:read', 'board:write', 'board:secrets_request'] })
  if (!relay.ok) throw new Error(relay.error)
  relayKey = { token: relay.key.token, id: relay.key.id }
  const plain = createAgentKey({ id: 1, role: 'admin' }, { label: 'Plain Bot', scopes: ['board:read', 'board:write'] })
  if (!plain.ok) throw new Error(plain.error)
  plainKey = plain.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/secret-upload', secretUploadRouter)
  app.use('/api/objectives', needsSecretRouter)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/agent', agentControlRouter)
  server = http.createServer(app)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  vi.restoreAllMocks()
  await new Promise<void>(r => server.close(() => r()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  sendFollowUpMock.mockClear()
  setFlag(trust.SESSION_SECRET_ACCESS_FLAG, true)
  getDb().prepare("UPDATE objectives SET status = 'working', needs_secret = NULL WHERE id IN (?, ?)").run(objId, otherObjId)
  getDb().prepare('DELETE FROM secrets').run()
})

async function raise(name = 'APIFY_API_TOKEN', scope?: string) {
  const r = await call('POST', `/api/objectives/${objId}/request-secret`, { 'X-CC-Session-Token': workerToken() }, {
    name, reason: 'Apify skip trace for C3/C4 owners', ...(scope ? { scope } : {}),
  })
  expect(r.status).toBe(200)
  return r
}

describe('1. request_secret event → visible status everywhere (names only)', () => {
  it('worker request sets needs_secret with scope + request id; card, progress, attention and list show it', async () => {
    const r = await raise('APIFY_API_TOKEN', 'global')
    expect(r.json.request_ids).toEqual([`sr-${objId}-APIFY_API_TOKEN`])
    expect(r.json.needs_secret).toEqual([expect.objectContaining({ name: 'APIFY_API_TOKEN', scope: 'global' })])

    const card = await call('GET', `/api/objectives/${objId}`, { Cookie: ownerCookie() })
    expect(card.json.needs_secret[0]).toMatchObject({ name: 'APIFY_API_TOKEN', scope: 'global' })

    const progress = await call('GET', `/api/objectives/${objId}/progress`, { Authorization: `Bearer ${plainKey}` })
    expect(progress.status).toBe(200)
    expect(progress.json.secret_requests).toEqual([
      expect.objectContaining({ request_id: `sr-${objId}-APIFY_API_TOKEN`, name: 'APIFY_API_TOKEN', scope: 'global', workspace: WS }),
    ])

    const att = buildAttention(getDb(), { id: 1, role: 'admin' }, {})
    const item = att.items.find(i => i.id === objId)!
    expect(item.kind).toBe('needs_secret')
    expect(item.secret_requests).toEqual([expect.objectContaining({ request_id: `sr-${objId}-APIFY_API_TOKEN`, scope: 'global' })])

    const list = await call('GET', '/api/agent/secret-requests', { Authorization: `Bearer ${plainKey}` })
    expect(list.status).toBe(200)
    expect(list.json.requests.map((x: any) => x.request_id)).toEqual([`sr-${objId}-APIFY_API_TOKEN`])
  })

  it('rejects a bad scope and a token for another card', async () => {
    const bad = await call('POST', `/api/objectives/${objId}/request-secret`, { 'X-CC-Session-Token': workerToken() }, { name: 'X_KEY', reason: 'r', scope: 'everyone' })
    expect(bad.status).toBe(400)
    const foreign = await call('POST', `/api/objectives/${otherObjId}/request-secret`, { 'X-CC-Session-Token': workerToken() }, { name: 'X_KEY', reason: 'r' })
    expect(foreign.status).toBe(403)
  })
})

describe('2+3. owner submits → stored → status cleared → worker resumes', () => {
  it('agents, API keys, Bearer JWTs, session tokens and a non-owner member are refused', async () => {
    await raise()
    for (const h of <Array<Record<string, string>>>[
      { Authorization: `Bearer ${relayKey.token}` },
      { Authorization: `Bearer ${plainKey}` },
      { Authorization: `Bearer ${ownerBearer()}` },
      { 'X-CC-Session-Token': workerToken() },
      { Cookie: cookieFor(2, 'sam', 'member') }, // logged in, but not this card's owner
    ]) {
      for (const p of ['needs-secret/fill', 'secrets']) {
        const r = await call('POST', `/api/objectives/${objId}/${p}`, h, { name: 'APIFY_API_TOKEN', value: VALUE })
        expect([401, 403], `${p} ${JSON.stringify(Object.keys(h))}`).toContain(r.status)
      }
    }
    expect(resolveSecrets({ workspace: WS }).APIFY_API_TOKEN).toBeUndefined()
    expect(sendFollowUpMock).not.toHaveBeenCalled()
  })

  it('request → owner popup submit (scope picked) → existing store + History → cleared → woken with the NAME only', async () => {
    await raise()
    const filled = await call('POST', `/api/objectives/${objId}/needs-secret/fill`, { Cookie: ownerCookie() }, { name: 'APIFY_API_TOKEN', value: VALUE, scope: 'global' })
    expect(filled.status).toBe(200)
    expect(filled.text).not.toContain(VALUE)
    expect(filled.json).toMatchObject({ ok: true, scope: 'global', requested: true, woke: true, needs_secret: [] })
    expect(getSecretValue({ scopeType: 'global' }, 'APIFY_API_TOKEN')).toBe(VALUE)
    expect(listVersions({ scopeType: 'global' }, 'APIFY_API_TOKEN')[0]).toMatchObject({ version: 1, changedBy: 1, via: null })

    const card = await call('GET', `/api/objectives/${objId}`, { Cookie: ownerCookie() })
    expect(card.json.needs_secret ?? []).toEqual([])
    expect(card.json.status).toBe('working')

    await flush()
    expect(sendFollowUpMock).toHaveBeenCalledTimes(1)
    const [sid, text] = sendFollowUpMock.mock.calls[0] as unknown as [string, string]
    expect(sid).toBe(SESSION)
    expect(text).toContain('APIFY_API_TOKEN is now available')
    expect(text).not.toContain(VALUE)
    expect(everythingPersisted()).not.toContain(VALUE)
  })

  it('the card owner (non-admin) may fill at their organization scope but not Command Center-wide', async () => {
    const db = getDb()
    db.prepare('UPDATE objectives SET created_by = 2 WHERE id = ?').run(objId)
    try {
      await raise()
      const global = await call('POST', `/api/objectives/${objId}/needs-secret/fill`, { Cookie: cookieFor(2, 'sam', 'member') }, { name: 'APIFY_API_TOKEN', value: VALUE, scope: 'global' })
      expect(global.status).toBe(403)
      const ws = await call('POST', `/api/objectives/${objId}/needs-secret/fill`, { Cookie: cookieFor(2, 'sam', 'member') }, { name: 'APIFY_API_TOKEN', value: VALUE })
      expect(ws.status).toBe(200)
      expect(resolveSecrets({ workspace: WS }).APIFY_API_TOKEN).toBe(VALUE)
    } finally {
      db.prepare('UPDATE objectives SET created_by = 1 WHERE id = ?').run(objId)
    }
  })
})

describe('4. "+ Add secret" with no request', () => {
  it('owner adds a secret from any card chat; the session is told the NAME', async () => {
    const r = await call('POST', `/api/objectives/${objId}/secrets`, { Cookie: ownerCookie() }, { name: 'SLACK_WEBHOOK_URL', value: VALUE, scope: 'workspace' })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, requested: false, scope: `workspace:${WS}`, woke: true })
    expect(resolveSecrets({ workspace: WS }).SLACK_WEBHOOK_URL).toBe(VALUE)
    await flush()
    expect((sendFollowUpMock.mock.calls[0] as unknown as [string, string])[1]).toContain('SLACK_WEBHOOK_URL')
  })

  it('notify:false stores without restarting the worker; bad names are refused', async () => {
    const r = await call('POST', `/api/objectives/${objId}/secrets`, { Cookie: ownerCookie() }, { name: 'QUIET_KEY', value: VALUE, notify: false })
    expect(r.json).toMatchObject({ ok: true, woke: false })
    expect((await call('POST', `/api/objectives/${objId}/secrets`, { Cookie: ownerCookie() }, { name: 'lower case', value: VALUE })).status).toBe(400)
    await flush()
    expect(sendFollowUpMock).not.toHaveBeenCalled()
  })
})

describe('7. MCP relay: one-time, write-only upload token', () => {
  async function mint(requestId = `sr-${objId}-APIFY_API_TOKEN`, token = relayKey.token, body: unknown = {}) {
    return call('POST', `/api/objectives/${objId}/secret-requests/${requestId}/upload-token`, { Authorization: `Bearer ${token}` }, body)
  }

  it('only a key with board:secrets_request can mint; never the owner cookie or a plain key', async () => {
    await raise()
    const plain = await mint(undefined, plainKey)
    expect(plain.status).toBe(403)
    expect(plain.json.missing_scope).toBe('board:secrets_request')
    const cookie = await call('POST', `/api/objectives/${objId}/secret-requests/sr-${objId}-APIFY_API_TOKEN/upload-token`, { Cookie: ownerCookie() }, {})
    expect(cookie.status).toBe(403)
    const notRequested = await mint(`sr-${objId}-OTHER_KEY`)
    expect(notRequested.status).toBe(409)
  })

  it('fulfil: host POSTs the raw value → stored, History names the agent, card resumes; reuse is refused', async () => {
    await raise()
    const m = await mint()
    expect(m.status).toBe(200)
    expect(m.json).toMatchObject({ name: 'APIFY_API_TOKEN', scope: 'workspace', single_use: true, ttl_seconds: 900 })
    expect(m.json.upload_token).toMatch(/^ccsu_/)
    expect(m.json.curl).toContain('"$APIFY_API_TOKEN"')
    // Only the hash is stored.
    expect(JSON.stringify(getDb().prepare('SELECT * FROM secret_upload_tokens').all())).not.toContain(m.json.upload_token)

    const up = await call('POST', '/api/secret-upload?name=APIFY_API_TOKEN', { 'X-CC-Upload-Token': m.json.upload_token }, undefined, VALUE)
    expect(up.status).toBe(200)
    expect(up.json).toEqual({ ok: true, name: 'APIFY_API_TOKEN', scope: `workspace:${WS}`, card_resumed: true })
    expect(up.text).not.toContain(VALUE)
    expect(resolveSecrets({ workspace: WS }).APIFY_API_TOKEN).toBe(VALUE)
    const [v] = listVersions({ scopeType: 'workspace', workspace: WS }, 'APIFY_API_TOKEN')
    expect(v.via).toBe(`agent Grok Bot (key #${relayKey.id}) relayed the request on card #${objId}`)

    const card = await call('GET', `/api/objectives/${objId}`, { Cookie: ownerCookie() })
    expect(card.json.needs_secret ?? []).toEqual([])
    await flush()
    expect(sendFollowUpMock).toHaveBeenCalledTimes(1)

    // Reuse: same token again (even after re-raising the request) → refused.
    await raise()
    const again = await call('POST', '/api/secret-upload?name=APIFY_API_TOKEN', { 'X-CC-Upload-Token': m.json.upload_token }, { value: 'second_value_123456789' })
    expect(again.status).toBe(410)
    expect(getSecretValue({ scopeType: 'workspace', workspace: WS }, 'APIFY_API_TOKEN')).toBe(VALUE)
    expect(everythingPersisted()).not.toContain(VALUE)
  })

  it('wrong name is refused and does not burn the token', async () => {
    await raise()
    const m = await mint()
    const wrong = await call('POST', '/api/secret-upload?name=GITHUB_TOKEN', { 'X-CC-Upload-Token': m.json.upload_token }, undefined, VALUE)
    expect(wrong.status).toBe(403)
    expect(resolveSecrets({ workspace: WS }).GITHUB_TOKEN).toBeUndefined()
    const right = await call('POST', '/api/secret-upload?name=APIFY_API_TOKEN', { 'X-CC-Upload-Token': m.json.upload_token }, undefined, VALUE)
    expect(right.status).toBe(200)
  })

  it('an expired token is refused', async () => {
    await raise()
    const m = await mint()
    const later = new Date(Date.now() + UPLOAD_TOKEN_TTL_MS + 1000)
    const r = redeemUploadToken(m.json.upload_token, 'APIFY_API_TOKEN', VALUE, later)
    expect(r).toMatchObject({ ok: false, status: 410 })
    expect(resolveSecrets({ workspace: WS }).APIFY_API_TOKEN).toBeUndefined()
    // Over HTTP too, once the clock really passes expiry.
    getDb().prepare("UPDATE secret_upload_tokens SET expires_at = datetime('now', '-1 minute')").run()
    const http410 = await call('POST', '/api/secret-upload?name=APIFY_API_TOKEN', { 'X-CC-Upload-Token': m.json.upload_token }, undefined, VALUE)
    expect(http410.status).toBe(410)
  })

  it('unknown / missing tokens and flag-off are refused', async () => {
    expect((await call('POST', '/api/secret-upload?name=APIFY_API_TOKEN', { 'X-CC-Upload-Token': 'ccsu_nope' }, undefined, VALUE)).status).toBe(401)
    expect((await call('POST', '/api/secret-upload?name=APIFY_API_TOKEN', {}, undefined, VALUE)).status).toBe(401)
    setFlag(trust.SESSION_SECRET_ACCESS_FLAG, false)
    expect((await call('POST', '/api/secret-upload?name=APIFY_API_TOKEN', { 'X-CC-Upload-Token': 'ccsu_nope' }, undefined, VALUE)).status).toBe(404)
  })

  it('the MCP fulfill tool maps request_id to the upload-token route and never takes a value', async () => {
    const tool = MCP_TOOLS.find(t => t.name === 'fulfill_secret_request')!
    expect(Object.keys((tool.inputSchema as any).properties).sort()).toEqual(['request_id', 'scope'])
    const calls: Array<[string, string, unknown]> = []
    await tool.run({ request_id: `sr-${objId}-APIFY_API_TOKEN` }, (async (m: string, p: string, b?: unknown) => { calls.push([m, p, b]); return {} }) as any)
    expect(calls[0].slice(0, 2)).toEqual(['POST', `/api/objectives/${objId}/secret-requests/sr-${objId}-APIFY_API_TOKEN/upload-token`])
    await expect(tool.run({ request_id: 'nope' }, (async () => ({})) as any)).rejects.toThrow(/request_id/)
  })
})
