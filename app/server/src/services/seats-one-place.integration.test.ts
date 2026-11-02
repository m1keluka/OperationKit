import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { Server } from 'http'

// One place to manage seats (obj 720368), through the admin API:
// - a Claude seat on a CLI login is reported as "needs Sign in with Claude"
//   while sessions run sandboxed, and Sign in with Claude converts it in place;
// - the old Dashboard account routes refuse to create / reconnect a Claude CLI
//   login while the jail is on (that seat would say Connected, then Unavailable);
// - Remove sticks, also for seats the server would otherwise re-create
//   (a CC_SEAT_POOL_DEFAULTS seed, the legacy single Codex login).

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-seats-one-place-'))
const LEGACY_CODEX = path.join(TMP, 'legacy-codex')
const SEED_FILE = path.join(TMP, 'seed.json')
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')
process.env.CC_SEAT_HOME_ROOT = path.join(TMP, 'seats')
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.CC_LEGACY_CODEX_HOME = LEGACY_CODEX
process.env.GROK_HOME_DIR = path.join(TMP, 'no-legacy-grok')
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-seats-one-place-xx'
delete process.env.SESSION_ISOLATION
delete process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN
delete process.env.CC_SEAT_POOL_DEFAULTS

const TOKEN = 'sk-ant-oat01-fake-oauth-token-for-tests-cccccccccccccccc-c3'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }))

// The CLAUDE-OK test turn; tmux calls (the old CLI-login driver) are recorded.
const execCalls: string[] = []
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  return {
    ...real,
    execSync: (cmd: string) => { execCalls.push(String(cmd)); return '' },
    spawn: () => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = () => {}
      setTimeout(() => { child.stdout.emit('data', Buffer.from('CLAUDE-OK')); child.emit('close', 0) }, 5)
      return child
    },
  }
})

const realFetch = globalThis.fetch
vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input) === TOKEN_URL) {
    return new Response(JSON.stringify({ access_token: TOKEN, expires_in: 31536000 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return realFetch(input, init)
})
for (const fn of ['log', 'warn', 'error', 'info'] as const) vi.spyOn(console, fn).mockImplementation(() => {})

const { initDb, getDb } = await import('../db/index.js')
const router = await import('./account-router.js')
const creds = await import('./seat-credentials.js')
const express = (await import('express')).default
const cookieParser = (await import('cookie-parser')).default
const jwt = (await import('jsonwebtoken')).default
const { requireAuth, requireAdmin } = await import('../middleware/auth.js')
const seatsRouter = (await import('../routes/admin-seats.js')).default
const accountsRouter = (await import('../routes/admin-accounts.js')).default

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

async function seatSummary(id: string) {
  const r = await call('GET', '/api/admin/seats')
  return (r.json.seats as Array<{ id: string }>).find(s => s.id === id) as any
}

/** A Claude seat signed in the old way: the CLI's own login file in the seat's HOME. */
function cliLoginClaudeSeat(label: string) {
  const seat = router.addAccountSlot({ kind: 'claude', label })
  fs.mkdirSync(path.join(seat.homeDir, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(seat.homeDir, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'sk-ant-oat01-cli-login', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 },
  }))
  return seat
}

beforeAll(async () => {
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin', requireAuth, requireAdmin, seatsRouter, accountsRouter)
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

afterEach(() => {
  delete process.env.SESSION_ISOLATION
  delete process.env.CC_SEAT_POOL_DEFAULTS
  for (const s of [...router.listSeatRecords()]) { s.activeSessions = []; router.removeSeat(s.id) }
})

describe('a Claude CLI-login seat while sessions run sandboxed', () => {
  it('is reported as needing "Sign in with Claude", not healthy-but-unavailable', async () => {
    const seat = cliLoginClaudeSeat('Mike biz')
    process.env.SESSION_ISOLATION = 'docker'
    const s = await seatSummary(seat.id)
    expect(s.available).toBe(false)
    expect(s.credential).toMatchObject({ kind: 'cli_login', usable: false, needsClaudeSignIn: true })
  })

  it('on the host (no jail) the same seat is usable and not flagged', async () => {
    const seat = cliLoginClaudeSeat('Host seat')
    const s = await seatSummary(seat.id)
    expect(s.credential).toMatchObject({ kind: 'cli_login', usable: true, needsClaudeSignIn: false })
    expect(s.available).toBe(true)
  })

  it('Sign in with Claude converts it in place to a setup token: same id, available', async () => {
    const seat = cliLoginClaudeSeat('Convert me')
    process.env.SESSION_ISOLATION = 'docker'
    const start = await call('POST', '/api/admin/seats/claude-oauth/start', { seatId: seat.id })
    expect(start.status).toBe(200)
    const state = new URL(start.json.url).searchParams.get('state')
    const done = await call('POST', '/api/admin/seats/claude-oauth/finish', { loginId: start.json.loginId, code: `c#${state}`, seatId: seat.id })
    expect(done.status).toBe(200)
    expect(done.json.seat).toMatchObject({ id: seat.id, label: 'Convert me', health: 'healthy', available: true })
    expect(done.json.seat.credential).toMatchObject({ kind: 'setup_token', usable: true, needsClaudeSignIn: false })
    expect(creds.seatCredentialEnv(router.getAccountById(seat.id)!)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    expect(router.listSeatRecords().filter(s => s.kind === 'claude')).toHaveLength(1)
  })

  it('the old Dashboard routes refuse to create or reconnect a Claude CLI login (409, points at Seats)', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    const add = await call('POST', '/api/admin/accounts', { label: 'New', kind: 'claude' })
    expect(add.status).toBe(409)
    expect(add.json).toMatchObject({ code: 'claude_cli_login_jailed', manage: '/settings/seats' })
    expect(router.listSeatRecords()).toHaveLength(0)

    const seat = cliLoginClaudeSeat('Old')
    execCalls.length = 0
    const connect = await call('POST', `/api/admin/accounts/${seat.id}/connect/start`)
    expect(connect.status).toBe(409)
    expect(connect.json.code).toBe('claude_cli_login_jailed')
    expect(execCalls.some(c => c.includes('tmux new-session'))).toBe(false)
  })

  it('without the jail the old add route still works (host installs unchanged)', async () => {
    const add = await call('POST', '/api/admin/accounts', { label: 'Host', kind: 'claude' })
    expect(add.status).toBe(201)
  })
})

describe('Remove sticks', () => {
  it('an ordinary seat of every engine is removed', async () => {
    for (const kind of ['claude', 'codex', 'grok'] as const) {
      const body = kind === 'claude' ? { kind, credential: TOKEN } : { kind }
      const added = await call('POST', '/api/admin/seats', body)
      expect(added.status).toBe(201)
      const del = await call('DELETE', `/api/admin/seats/${added.json.seat.id}`)
      expect(del.status).toBe(200)
    }
    expect((await call('GET', '/api/admin/seats')).json.seats).toHaveLength(0)
  })

  it('a seeded seat (CC_SEAT_POOL_DEFAULTS) does not come back after Remove', async () => {
    fs.writeFileSync(SEED_FILE, JSON.stringify([{ id: 's9', label: 'Seeded' }]))
    process.env.CC_SEAT_POOL_DEFAULTS = SEED_FILE
    router.addAccountSlot({ kind: 'codex' }) // any write → the state file exists and the seed merges in
    expect((await seatSummary('s9'))?.label).toBe('Seeded')
    expect((await call('DELETE', '/api/admin/seats/s9')).status).toBe(200)
    expect(await seatSummary('s9')).toBeUndefined()
  })

  it('the legacy single Codex login seat does not come back after Remove', async () => {
    fs.mkdirSync(path.join(LEGACY_CODEX, '.codex'), { recursive: true })
    fs.writeFileSync(path.join(LEGACY_CODEX, '.codex', 'auth.json'), '{"tokens":"legacy-login"}')
    router.addAccountSlot({ kind: 'claude', label: 'x' })
    expect(await seatSummary('codex')).toBeDefined()
    expect((await call('DELETE', '/api/admin/seats/codex')).status).toBe(200)
    expect(await seatSummary('codex')).toBeUndefined()
    // Re-adding a Codex seat from Seats still works and is a new seat.
    const again = await call('POST', '/api/admin/seats', { kind: 'codex' })
    expect(again.status).toBe(201)
    expect(again.json.seat.id).not.toBe('codex')
    fs.rmSync(LEGACY_CODEX, { recursive: true, force: true })
  })

  it('a seat with a live session is refused with 409, not silently kept', async () => {
    const added = await call('POST', '/api/admin/seats', { kind: 'claude', credential: TOKEN })
    router.recordSessionStart(added.json.seat.id, 'sess-1')
    const del = await call('DELETE', `/api/admin/seats/${added.json.seat.id}`)
    expect(del.status).toBe(409)
    expect(del.json.error).toBe('seat_in_use')
  })
})
