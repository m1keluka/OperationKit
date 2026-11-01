import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { Server } from 'http'

// Settings → Seats → Add Claude seat → "Sign in with Claude" (obj 720330), end to
// end through the admin API with Claude's token endpoint faked: the link, the
// pasted `code#state`, the stored seat (same storage as a pasted setup token),
// the CLAUDE-OK test turn, reconnecting an existing seat, and the error paths.
// The verifier and the token must never show up in a response, log or audit row.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-claude-oauth-'))
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')
process.env.CC_SEAT_HOME_ROOT = path.join(TMP, 'seats')
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.CC_LEGACY_CODEX_HOME = path.join(TMP, 'no-legacy-codex')
process.env.GROK_HOME_DIR = path.join(TMP, 'no-legacy-grok')
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-claude-oauth-xxxx'
delete process.env.SESSION_ISOLATION
delete process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN

const TOKEN_A = 'sk-ant-oat01-fake-oauth-token-for-tests-aaaaaaaaaaaaaaaa-a1'
const TOKEN_B = 'sk-ant-oat01-fake-oauth-token-for-tests-bbbbbbbbbbbbbbbb-b2'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }))

// The test turn: answer like the CLI would; record which token it was given.
let probeReply = 'CLAUDE-OK'
const probeTokens: string[] = []
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  return {
    ...real,
    spawn: (_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      probeTokens.push(opts?.env?.CLAUDE_CODE_OAUTH_TOKEN || '')
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setTimeout(() => { child.stdout.emit('data', Buffer.from(probeReply)); child.emit('close', 0) }, 5)
      return child
    },
  }
})

const logged: string[] = []
for (const fn of ['log', 'warn', 'error', 'info'] as const) {
  vi.spyOn(console, fn).mockImplementation((...args: unknown[]) => {
    logged.push(args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })())).join(' '))
  })
}

// Fake Claude's token endpoint; every other fetch (our own API calls) is real.
const realFetch = globalThis.fetch
const tokenRequests: Record<string, unknown>[] = []
let tokenReply: { status: number; body: unknown } = { status: 200, body: { access_token: TOKEN_A, expires_in: 31536000 } }
vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) === TOKEN_URL) {
    tokenRequests.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify(tokenReply.body), { status: tokenReply.status, headers: { 'Content-Type': 'application/json' } })
  }
  return realFetch(input, init)
})

const { initDb, getDb } = await import('../db/index.js')
const router = await import('./account-router.js')
const creds = await import('./seat-credentials.js')
const express = (await import('express')).default
const cookieParser = (await import('cookie-parser')).default
const jwt = (await import('jsonwebtoken')).default
const { requireAuth, requireAdmin } = await import('../middleware/auth.js')
const seatsRouter = (await import('../routes/admin-seats.js')).default

const ADMIN_ID = 1
let server: Server
let baseUrl = ''
const responses: string[] = []
const adminJwt = () => jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await realFetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  responses.push(text)
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

async function startLink(seatId?: string) {
  const r = await call('POST', '/api/admin/seats/claude-oauth/start', seatId ? { seatId } : {})
  expect(r.status).toBe(200)
  return { loginId: r.json.loginId as string, state: new URL(r.json.url).searchParams.get('state') as string, url: r.json.url as string }
}

beforeAll(async () => {
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin', requireAuth, requireAdmin, seatsRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  vi.restoreAllMocks()
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  probeReply = 'CLAUDE-OK'
  tokenReply = { status: 200, body: { access_token: TOKEN_A, expires_in: 31536000 } }
  for (const s of [...router.listSeatRecords()]) { s.activeSessions = []; router.removeSeat(s.id) }
})

describe('Add Claude seat with "Sign in with Claude"', () => {
  it('link → paste code#state → seat saved like a pasted token, tested, healthy', async () => {
    const link = await startLink()
    expect(link.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/)
    const done = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `auth-code-1#${link.state}`, label: 'Mike Max' })
    expect(done.status).toBe(201)
    expect(done.json.outcome).toBe('healthy')
    expect(done.json.seat).toMatchObject({ kind: 'claude', label: 'Mike Max', health: 'healthy', available: true })
    expect(done.json.seat.credential).toMatchObject({ kind: 'setup_token', last4: TOKEN_A.slice(-4) })
    // A one-year token: expiry recorded so the 14-day warning can see it.
    const days = (Date.parse(done.json.seat.credential.expiresAt) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(364)
    // Same storage as the pasted-token path: the secrets store, handed to a session as CLAUDE_CODE_OAUTH_TOKEN.
    const seat = router.getAccountById(done.json.seat.id)!
    expect(seat.credentialRef).toBe(creds.seatSecretKey(seat.id))
    expect(creds.seatCredentialEnv(seat)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_A })
    // The test turn ran on that token (and no API key).
    expect(probeTokens.at(-1)).toBe(TOKEN_A)
    expect(tokenRequests.at(-1)).toMatchObject({ grant_type: 'authorization_code', code: 'auth-code-1', state: link.state, expires_in: 31536000 })
  })

  it('a seat whose test turn does not reply CLAUDE-OK is not reported healthy', async () => {
    probeReply = 'hello'
    const link = await startLink()
    const done = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `c#${link.state}` })
    expect(done.status).toBe(201)
    expect(done.json.outcome).toBe('inconclusive')
  })

  it('reconnects an existing Claude seat in place (rotate), keeping its id', async () => {
    const first = await startLink()
    const added = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: first.loginId, code: `c#${first.state}` })
    const id = added.json.seat.id
    router.recordAuthFailure(id, '[health-check] OAuth token has expired')
    tokenReply = { status: 200, body: { access_token: TOKEN_B, expires_in: 31536000 } }
    const again = await startLink(id)
    const done = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: again.loginId, code: `c2#${again.state}`, seatId: id })
    expect(done.status).toBe(200)
    expect(done.json.seat).toMatchObject({ id, health: 'healthy' })
    expect(creds.seatCredentialEnv(router.getAccountById(id)!)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN_B })
    expect(router.listSeatRecords()).toHaveLength(1)
  })

  it('state mismatch → 400, no exchange, no seat', async () => {
    const link = await startLink()
    const before = tokenRequests.length
    const r = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: 'c#not-this-links-state' })
    expect(r.status).toBe(400)
    expect(r.json.code).toBe('state_mismatch')
    expect(tokenRequests.length).toBe(before)
    expect(router.listSeatRecords()).toHaveLength(0)
  })

  it('expired or unknown link → refused, no seat', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] })
    try {
      const link = await startLink()
      vi.setSystemTime(Date.now() + 11 * 60 * 1000)
      const r = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `c#${link.state}` })
      expect(r.status).toBe(410)
      expect(r.json.code).toBe('expired')
    } finally {
      vi.useRealTimers()
    }
    const unknown = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: 'deadbeef', code: 'c#s' })
    expect(unknown.status).toBe(404)
    expect(router.listSeatRecords()).toHaveLength(0)
  })

  it('bad code (Claude says invalid_grant) → 400, no seat; an API key reply is never stored', async () => {
    const link = await startLink()
    tokenReply = { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid authorization code' } }
    const bad = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `wrong#${link.state}` })
    expect(bad.status).toBe(400)
    expect(bad.json.code).toBe('bad_code')
    tokenReply = { status: 200, body: { access_token: 'sk-ant-api03-metered-key-for-tests-xxxx' } }
    const api = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `c#${link.state}` })
    expect(api.json.code).toBe('not_subscription')
    expect(router.listSeatRecords()).toHaveLength(0)
  })

  it('refuses Codex / Grok seats and keeps the pasted-token fallback working', async () => {
    const codex = router.addAccountSlot({ kind: 'codex', label: 'C' })
    const r = await call('POST', '/api/admin/seats/claude-oauth/start', { seatId: codex.id })
    expect(r.status).toBe(400)
    const pasted = await call('POST', '/api/admin/seats', { kind: 'claude', credential: TOKEN_B })
    expect(pasted.status).toBe(201)
    expect(pasted.json.seat.credential.kind).toBe('setup_token')
  })

  it('no verifier, code or token in any response, log line or audit row', async () => {
    const link = await startLink()
    await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `secret-auth-code#${link.state}` })
    const verifiers = tokenRequests.map(t => String(t.code_verifier))
    expect(verifiers.length).toBeGreaterThan(0)
    const haystacks: Record<string, string> = {
      responses: responses.join('\n'),
      logs: logged.join('\n'),
      seat_audit_log: JSON.stringify(getDb().prepare('SELECT * FROM seat_audit_log').all()),
      secret_access_log: JSON.stringify(getDb().prepare('SELECT * FROM secret_access_log').all()),
      stateFile: fs.readFileSync(process.env.CC_ACCOUNT_ROUTER_STATE_FILE!, 'utf-8'),
    }
    for (const [where, text] of Object.entries(haystacks)) {
      for (const v of [...verifiers, TOKEN_A, TOKEN_B, 'secret-auth-code']) {
        expect(text.includes(v), `${v.slice(0, 8)}… leaked into ${where}`).toBe(false)
      }
    }
    expect(haystacks.seat_audit_log).toMatch(/via=oauth/)
  })
})
