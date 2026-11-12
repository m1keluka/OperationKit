import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { Server } from 'http'

// Seat management, made reliable (obj 720330): idempotent connect / add,
// Reconnect with Sign in with Claude replacing the credential IN PLACE (same id,
// nickname, priority, history), sign-in links bound to their seat, and a Remove
// that clears credentials, survives a restart, is audited and never kills work.
// Claude's token endpoint and the CLAUDE-OK test turn are faked.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-seat-reliability-'))
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')
process.env.CC_SEAT_HOME_ROOT = path.join(TMP, 'seats')
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.CC_LEGACY_CODEX_HOME = path.join(TMP, 'no-legacy-codex')
process.env.GROK_HOME_DIR = path.join(TMP, 'no-legacy-grok')
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-seat-reliability-xx'
delete process.env.SESSION_ISOLATION
delete process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN
delete process.env.CC_CLAUDE_OAUTH_TOKEN_URL

const PASTED = 'sk-ant-oat01-fake-pasted-setup-token-for-tests-pppppppppppp-p1'
const OAUTH_1 = 'sk-ant-oat01-fake-oauth-token-for-tests-1111111111111111-o1'
const OAUTH_2 = 'sk-ant-oat01-fake-oauth-token-for-tests-2222222222222222-o2'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }))

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
      setTimeout(() => { child.stdout.emit('data', Buffer.from('CLAUDE-OK')); child.emit('close', 0) }, 5)
      return child
    },
    // tmux is not present in CI; the seat routes only use it best-effort.
    execSync: (cmd: string, o?: unknown) => (String(cmd).startsWith('tmux') ? '' : real.execSync(cmd, o as never)),
  }
})
for (const fn of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, fn).mockImplementation(() => {})

// Slow, countable fake token endpoint (slow enough for a double-click to overlap).
const realFetch = globalThis.fetch
let tokenCalls = 0
let nextToken = OAUTH_1
vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) === TOKEN_URL) {
    tokenCalls++
    await new Promise(r => setTimeout(r, 60))
    return new Response(JSON.stringify({ access_token: nextToken, expires_in: 31536000 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
const seatsModule = await import('../routes/admin-seats.js')

const ADMIN_ID = 1
let server: Server
let baseUrl = ''
const adminJwt = () => jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await realFetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

async function startLink(seatId?: string) {
  const r = await call('POST', '/api/admin/seats/claude-oauth/start', seatId ? { seatId } : {})
  expect(r.status).toBe(200)
  return { loginId: r.json.loginId as string, state: new URL(r.json.url).searchParams.get('state') as string }
}

const audit = (action: string, seatId?: string) =>
  getDb().prepare(`SELECT action, seat_id, detail FROM seat_audit_log WHERE action = ? ${seatId ? 'AND seat_id = ?' : ''} ORDER BY id`)
    .all(...(seatId ? [action, seatId] : [action])) as Array<{ action: string; seat_id: string; detail: string }>

beforeAll(async () => {
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin', requireAuth, requireAdmin, seatsModule.default)
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
  tokenCalls = 0
  nextToken = OAUTH_1
  seatsModule.__resetSeatWriteMemory()
  for (const s of [...router.listSeatRecords()]) { s.activeSessions = []; router.removeSeat(s.id) }
})

describe('idempotent connect / add', () => {
  it('double-clicked Connect: two finishes on one link → ONE token exchange, ONE seat, same reply', async () => {
    const link = await startLink()
    const body = { loginId: link.loginId, code: `code#${link.state}`, label: 'Double click' }
    const [a, b] = await Promise.all([
      call('POST', '/api/admin/seats/claude-oauth/finish', body),
      call('POST', '/api/admin/seats/claude-oauth/finish', body),
    ])
    expect(tokenCalls).toBe(1)
    expect([a.status, b.status].sort()).toEqual([201, 201])
    expect(a.json.seat.id).toBe(b.json.seat.id)
    expect([a.json.replayed, b.json.replayed].filter(Boolean)).toHaveLength(1)
    expect(router.listSeatRecords().filter(s => s.kind === 'claude')).toHaveLength(1)
  })

  it('retry after the reply was lost: the same link replays the saved seat instead of failing or adding another', async () => {
    const link = await startLink()
    const first = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `code#${link.state}` })
    expect(first.status).toBe(201)
    const retry = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `code#${link.state}` })
    expect(retry.status).toBe(201)
    expect(retry.json).toMatchObject({ ok: true, replayed: true, seat: { id: first.json.seat.id } })
    expect(tokenCalls).toBe(1)
    expect(router.listSeatRecords()).toHaveLength(1)
  })

  it('a FAILED finish is not remembered: fixing the paste on the same link still works', async () => {
    const link = await startLink()
    const bad = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: 'code#wrong-state' })
    expect(bad.json.code).toBe('state_mismatch')
    const good = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `code#${link.state}` })
    expect(good.status).toBe(201)
    expect(good.json.replayed).toBeUndefined()
  })

  it('pasted token: double submit with one idempotency key → one seat', async () => {
    const body = { kind: 'claude', credential: PASTED, label: 'Pasted', idempotencyKey: 'form-abc-12345' }
    const [a, b] = await Promise.all([call('POST', '/api/admin/seats', body), call('POST', '/api/admin/seats', body)])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(a.json.seat.id).toBe(b.json.seat.id)
    expect(router.listSeatRecords()).toHaveLength(1)
  })

  it('pasted token: the same token pasted again (new form) returns the existing seat, not a duplicate', async () => {
    const first = await call('POST', '/api/admin/seats', { kind: 'claude', credential: PASTED })
    const again = await call('POST', '/api/admin/seats', { kind: 'claude', credential: `  ${PASTED}\n` })
    expect(again.status).toBe(200)
    expect(again.json).toMatchObject({ duplicate: true, seat: { id: first.json.seat.id } })
    expect(router.listSeatRecords()).toHaveLength(1)
    expect(audit('add_duplicate', first.json.seat.id)).toHaveLength(1)
    // A genuinely different token is a different seat.
    const other = await call('POST', '/api/admin/seats', { kind: 'claude', credential: OAUTH_2 })
    expect(other.status).toBe(201)
    expect(router.listSeatRecords()).toHaveLength(2)
  })

  it('Codex add: a retried request with the same key does not create a second empty seat', async () => {
    const body = { kind: 'codex', idempotencyKey: 'codex-form-777777' }
    const a = await call('POST', '/api/admin/seats', body)
    const b = await call('POST', '/api/admin/seats', body)
    expect(a.status).toBe(201)
    expect(b.json).toMatchObject({ replayed: true, seat: { id: a.json.seat.id } })
    expect(router.listSeatRecords().filter(s => s.kind === 'codex')).toHaveLength(1)
  })
})

describe('Reconnect with Sign in with Claude (credential replaced in place)', () => {
  it('a pasted-token seat is offered Reconnect and keeps id, nickname, priority and history after it', async () => {
    const added = await call('POST', '/api/admin/seats', { kind: 'claude', credential: PASTED, label: 'Old pasted seat' })
    const id = added.json.seat.id
    expect(added.json.seat.credential.source).toBe('pasted')
    await call('PATCH', `/api/admin/seats/${id}`, { label: 'Operator Max (nickname)', priority: 3 })
    router.recordSessionStart(id, 'sess-history')
    router.recordSessionEnd(id, 'sess-history', 1234, 0.5)
    const before = router.getAccountById(id)!
    const history = JSON.stringify(before.usageLog)
    const secretKey = before.credentialRef

    nextToken = OAUTH_1
    const link = await startLink(id)
    const done = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `c#${link.state}`, seatId: id })
    expect(done.status).toBe(200)
    expect(done.json.outcome).toBe('healthy')
    expect(done.json.seat).toMatchObject({ id, label: 'Operator Max (nickname)', priority: 3, health: 'healthy' })
    expect(done.json.seat.credential).toMatchObject({ kind: 'setup_token', source: 'oauth', last4: OAUTH_1.slice(-4) })

    const after = router.getAccountById(id)!
    expect(after.credentialRef).toBe(secretKey) // same store key, value overwritten
    expect(JSON.stringify(after.usageLog)).toBe(history)
    expect(after.sessionsToday).toBe(before.sessionsToday)
    expect(creds.seatCredentialEnv(after)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_1 })
    expect(probeTokens.at(-1)).toBe(OAUTH_1) // health re-checked on the NEW credential
    expect(router.listSeatRecords()).toHaveLength(1)
    expect(audit('reconnect', id)[0].detail).toMatch(/via=oauth/)
  })

  it('the nickname survives reconnect AND a server restart (obj 718892)', async () => {
    const added = await call('POST', '/api/admin/seats', { kind: 'claude', credential: PASTED })
    const id = added.json.seat.id
    await call('PATCH', `/api/admin/seats/${id}`, { label: 'Sticky name' })
    const link = await startLink(id)
    await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `c#${link.state}` })
    vi.resetModules()
    const fresh = await import('./account-router.js')
    const seat = fresh.getAccountById(id)!
    expect(seat.customLabel).toBe('Sticky name')
    expect(seat.credentialSource).toBe('oauth')
  })

  it('a Reconnect link is bound to its seat: omitting seatId still reconnects that seat (no new seat)', async () => {
    const added = await call('POST', '/api/admin/seats', { kind: 'claude', credential: PASTED })
    const id = added.json.seat.id
    const link = await startLink(id)
    const done = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `c#${link.state}` })
    expect(done.status).toBe(200)
    expect(done.json.seat.id).toBe(id)
    expect(router.listSeatRecords()).toHaveLength(1)
  })

  it('a Reconnect link cannot be finished onto a DIFFERENT seat (409, nothing exchanged)', async () => {
    const a = await call('POST', '/api/admin/seats', { kind: 'claude', credential: PASTED })
    const b = await call('POST', '/api/admin/seats', { kind: 'claude', credential: OAUTH_2 })
    const link = await startLink(a.json.seat.id)
    const r = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `c#${link.state}`, seatId: b.json.seat.id })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('wrong_seat')
    expect(tokenCalls).toBe(0)
    expect(creds.seatCredentialEnv(router.getAccountById(b.json.seat.id)!)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: OAUTH_2 })
  })

  it('the seat removed while the operator was on claude.ai → 404, nothing saved, no new seat', async () => {
    const added = await call('POST', '/api/admin/seats', { kind: 'claude', credential: PASTED })
    const id = added.json.seat.id
    const link = await startLink(id)
    expect((await call('DELETE', `/api/admin/seats/${id}`)).status).toBe(200)
    const r = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: link.loginId, code: `c#${link.state}`, seatId: id })
    expect(r.status).toBe(404)
    expect(router.listSeatRecords()).toHaveLength(0)
    expect(tokenCalls).toBe(0)
  })
})

describe('Remove', () => {
  it('removes the seat, deletes its stored credential, survives a restart and is audited', async () => {
    const added = await call('POST', '/api/admin/seats', { kind: 'claude', credential: PASTED, label: 'Goes away' })
    const id = added.json.seat.id
    const ref = router.getAccountById(id)!.credentialRef!
    expect(creds.seatCredentialStored(ref)).toBe(true)

    const del = await call('DELETE', `/api/admin/seats/${id}`)
    expect(del.status).toBe(200)
    expect(del.json.removed).toMatchObject({ id, credentialDeleted: true })
    expect(creds.seatCredentialStored(ref)).toBe(false)
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM secrets WHERE key = ?').get(ref)).toEqual({ n: 0 })
    expect((await call('GET', '/api/admin/seats')).json.seats.map((s: { id: string }) => s.id)).not.toContain(id)
    expect(audit('remove', id)[0].detail).toMatch(/kind=claude credential=deleted/)

    vi.resetModules()
    const fresh = await import('./account-router.js')
    expect(fresh.getAccountById(id)).toBeNull()
    expect(fresh.listSeatRecords().map(s => s.id)).not.toContain(id)
  })

  it('a removed seat\'s id is never reused, so a new seat cannot inherit its history', async () => {
    const a = await call('POST', '/api/admin/seats', { kind: 'codex' })
    await call('DELETE', `/api/admin/seats/${a.json.seat.id}`)
    const b = await call('POST', '/api/admin/seats', { kind: 'codex' })
    expect(b.json.seat.id).not.toBe(a.json.seat.id)
  })

  it('a Codex / Grok seat\'s own login files are deleted with it', async () => {
    for (const kind of ['codex', 'grok'] as const) {
      const added = await call('POST', '/api/admin/seats', { kind })
      const seat = router.getAccountById(added.json.seat.id)!
      const dir = path.join(seat.homeDir, kind === 'codex' ? '.codex' : '.grok')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, kind === 'codex' ? 'auth.json' : 'user-settings.json'), '{"login":"seat-only"}')
      const del = await call('DELETE', `/api/admin/seats/${seat.id}`)
      expect(del.json.removed.loginFiles).toBe('removed')
      expect(fs.existsSync(seat.homeDir)).toBe(false)
      expect(audit('remove', seat.id)[0].detail).toMatch(/login_files=removed/)
    }
  })

  it('a seat in use is drained, not removed, and the refusal is audited', async () => {
    const added = await call('POST', '/api/admin/seats', { kind: 'claude', credential: PASTED })
    const id = added.json.seat.id
    router.recordSessionStart(id, 'live-1')
    router.recordSessionStart(id, 'live-2')
    const del = await call('DELETE', `/api/admin/seats/${id}`)
    expect(del.status).toBe(409)
    expect(del.json).toMatchObject({ code: 'seat_in_use', activeSessions: 2, drained: true, seat: { id, enabled: false } })
    expect(del.json.error).toBe('This seat is running 2 sessions. It is now disabled, so no new work starts on it, and the running work keeps going. Remove it again when they finish.')
    expect(router.getAccountById(id)!.activeSessions).toEqual(['live-1', 'live-2'])
    expect(audit('remove_blocked', id)[0].detail).toBe('active_sessions=2 drained=now')
  })
})

describe('clearSeatHome only touches a HOME the pool made for that seat', () => {
  it('keeps a shared / legacy login dir and never deletes the root itself', () => {
    const root = path.join(TMP, 'seats')
    const shared = path.join(TMP, 'shared-codex-home')
    fs.mkdirSync(path.join(shared, '.codex'), { recursive: true })
    expect(router.clearSeatHome({ homeDir: shared }, root)).toBe('kept_shared')
    expect(fs.existsSync(shared)).toBe(true)
    expect(router.clearSeatHome({ homeDir: root }, root)).toBe('kept_shared')
    expect(router.clearSeatHome({ homeDir: path.join(root, 'a', 'nested') }, root)).toBe('kept_shared')
    expect(router.clearSeatHome({ homeDir: `${root}/../shared-codex-home` }, root)).toBe('kept_shared')
    expect(fs.existsSync(shared)).toBe(true)
  })
})
