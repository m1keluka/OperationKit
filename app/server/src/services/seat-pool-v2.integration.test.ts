import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import type { Server } from 'http'

// Seat pool v2 end-to-end (fake data only): per-session seat assignment in the
// sandbox, the single-token fallback for an install with no seats, v1 state
// migration, opt-in cross-engine failover, the expiry warning, and — the
// security contract — no credential value in any API response, log line or
// audit entry.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-seat-v2-'))
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')
process.env.CC_SEAT_HOME_ROOT = path.join(TMP, 'seats')
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.DB_PATH = path.join(TMP, 'test.db')
// Point the single pre-v2 Codex / Grok login dirs at empty temp paths so a
// host that happens to have them never leaks a seat into this suite.
process.env.CC_LEGACY_CODEX_HOME = path.join(TMP, 'no-legacy-codex')
process.env.GROK_HOME_DIR = path.join(TMP, 'no-legacy-grok')
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-seat-pool-v2-xx'
delete process.env.SESSION_ISOLATION
delete process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN
delete process.env.SESSION_JAIL_ANTHROPIC_API_KEY

// Fake credentials. Long enough to be shown as a last-4 hint; never real.
const TOKEN_1 = 'fake-setup-token-for-tests-0000000000000000-aaa1'
const TOKEN_2 = 'fake-setup-token-for-tests-1111111111111111-bbb2'
const TOKEN_3 = 'fake-setup-token-for-tests-2222222222222222-ccc3'
const SERVER_TOKEN = 'fake-server-token-for-tests-3333333333333333-ddd4'
const ALL_TOKENS = [TOKEN_1, TOKEN_2, TOKEN_3, SERVER_TOKEN]

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }))

// "Test now" spawns a probe; answer like a healthy CLI without running one.
vi.mock('child_process', async (orig) => {
  const real = await orig<typeof import('child_process')>()
  return {
    ...real,
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

// Capture every log line so the leak test can scan them.
const logged: string[] = []
for (const fn of ['log', 'warn', 'error', 'info'] as const) {
  const orig = console[fn].bind(console)
  vi.spyOn(console, fn).mockImplementation((...args: unknown[]) => {
    logged.push(args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })())).join(' '))
    void orig
  })
}

const { initDb, getDb } = await import('../db/index.js')
const router = await import('./account-router.js')
const creds = await import('./seat-credentials.js')
const assign = await import('./seat-assign.js')
const health = await import('./account-health-check.js')
const store = await import('./secrets-store.js')
const { buildJailRunArgv } = await import('./session-jail.js')
const express = (await import('express')).default
const cookieParser = (await import('cookie-parser')).default
const jwt = (await import('jsonwebtoken')).default
const { requireAuth, requireAdmin } = await import('../middleware/auth.js')
const seatsRouter = (await import('../routes/admin-seats.js')).default
const accountsRouter = (await import('../routes/admin-accounts.js')).default
const agentControlRouter = (await import('../routes/agent-control.js')).default

const ADMIN_ID = 1
let server: Server
let baseUrl = ''
const responses: string[] = []
const adminJwt = () => jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminJwt()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  responses.push(text)
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

function writeState(accounts: unknown[]): void {
  fs.writeFileSync(process.env.CC_ACCOUNT_ROUTER_STATE_FILE!, JSON.stringify({ accounts, queue: [], lastResetDate: new Date().toISOString().slice(0, 10) }))
}

/** Wipe every seat (in-memory state is authoritative; the file alone is re-merged on load). */
function resetPool(): void {
  for (const s of [...router.listSeatRecords()]) {
    s.activeSessions = []
    router.removeSeat(s.id)
  }
  writeState([])
}

function loginSeat(kind: 'codex' | 'grok', label: string) {
  const seat = router.addAccountSlot({ kind, label })
  const dir = path.join(seat.homeDir, kind === 'codex' ? '.codex' : '.grok')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ fake: 'login-file-for-tests' }))
  return seat
}

beforeAll(async () => {
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin', requireAuth, requireAdmin, seatsRouter, accountsRouter)
  app.use('/api/agent', agentControlRouter)
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
  delete process.env.SESSION_ISOLATION
  delete process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN
  resetPool()
})

describe('install with no seats configured', () => {
  it('a sandboxed session still signs in with the single server token (unchanged behaviour)', () => {
    process.env.SESSION_ISOLATION = 'docker'
    process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN = SERVER_TOKEN
    const seat = router.pickAccount()
    expect(seat?.id).toBe('sandbox')
    expect(creds.seatCredentialEnv(seat!)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SERVER_TOKEN })
  })

  it('once a pasted Claude seat exists, the server token is no longer used', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN = SERVER_TOKEN
    expect(router.pickAccount()?.id).toBe('sandbox')
    const { json } = await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 1', credential: TOKEN_1 })
    expect(router.pickAccount()?.id).toBe(json.seat.id)
  })

  it('a host (tmux) install keeps its existing CLI-login seats, migrated without losing history', () => {
    const home = path.join(TMP, 'legacy-home')
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}')
    const usage = [{ timestamp: new Date().toISOString(), tokens: 1234, cost: 0.5, sessionId: 'sess-1' }]
    writeState([{ id: 'legacy1', label: 'Old name', priority: 3, homeDir: home, sessionsToday: 2, tokensToday: 1234, costToday: 0.5, lastRateLimit: null, rateLimitResetsAt: null, activeSessions: [], usageLog: usage }])
    const seat = router.pickAccount()
    expect(seat?.id).toBe('legacy1')
    const rec = router.listSeatRecords().find(s => s.id === 'legacy1')!
    expect(rec.kind).toBe('claude')
    expect(rec.enabled).toBe(true)
    expect(rec.credentialKind).toBe('cli_login')
    expect(rec.priority).toBe(3)
    expect(rec.usageLog).toHaveLength(1)
    expect(rec.usageLog[0].tokens).toBe(1234)
    expect(router.getAccountLabel('legacy1')).toBe('Old name')
  })
})

describe('per-session assignment in sandboxed sessions', () => {
  it('two sandboxed sessions get two different seats, each with its own credential', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    const a = await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 1', credential: TOKEN_1 })
    const b = await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 2', priority: 5, credential: TOKEN_2 })
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)

    const first = router.pickAccount()!
    router.recordSessionStart(first.id, 'session-one')
    const second = router.pickAccount()!
    router.recordSessionStart(second.id, 'session-two')

    expect(first.id).not.toBe(second.id)
    const envs = [creds.seatCredentialEnv(first).CLAUDE_CODE_OAUTH_TOKEN, creds.seatCredentialEnv(second).CLAUDE_CODE_OAUTH_TOKEN]
    expect(new Set(envs)).toEqual(new Set([TOKEN_1, TOKEN_2]))
    // A seat never carries an API key alongside its token.
    expect(Object.keys(creds.seatCredentialEnv(first))).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
  })

  it('a follow-up re-picks when its seat is now unhealthy', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    const a = (await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 1', credential: TOKEN_1 })).json.seat.id
    const b = (await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 2', credential: TOKEN_2 })).json.seat.id
    expect(router.chooseFollowUpAccount(a).account?.id).toBe(a)
    router.recordRateLimit(a, new Date(Date.now() + 60 * 60 * 1000))
    const choice = router.chooseFollowUpAccount(a)
    expect(choice.rerouted).toBe(true)
    expect(choice.account?.id).toBe(b)
  })

  it('a Codex CLI login is never shared by two live sandboxed sessions; each seat mounts only its own login dir', () => {
    process.env.SESSION_ISOLATION = 'docker'
    const c1 = loginSeat('codex', 'Seat 1')
    const c2 = loginSeat('codex', 'Seat 2')
    const first = router.pickSeatOfKind('codex')!
    router.recordSessionStart(first.id, 'codex-one')
    const second = router.pickSeatOfKind('codex')!
    router.recordSessionStart(second.id, 'codex-two')
    expect(new Set([first.id, second.id])).toEqual(new Set([c1.id, c2.id]))
    expect(router.pickSeatOfKind('codex')).toBeNull() // both busy → queue

    const mount = creds.seatJailMount(first)!
    expect(mount).toEqual({ source: path.join(first.homeDir, '.codex'), target: '/home/jailuser/.codex' })
    const argv = buildJailRunArgv({ objectiveId: 7, sessionId: 'codex-one', worktreePath: '/tmp/wt-7', homePath: '/tmp/home-7', image: 'img', seatMount: mount })
    const mounts = argv.filter((_, i, all) => all[i - 1] === '--mount')
    expect(mounts).toHaveLength(3)
    expect(mounts[2]).toContain('target=/home/jailuser/.codex')
    expect(mounts.join(' ')).not.toContain(second.homeDir)
    expect(() => buildJailRunArgv({ objectiveId: 7, sessionId: 's', worktreePath: '/tmp/a', homePath: '/tmp/b', image: 'img', seatMount: { source: '/tmp/x', target: '/etc' } })).toThrow()
  })
})

describe('failure handling on real seats', () => {
  it('credits exhausted parks without a timer; a good turn clears cooldown and credits park', async () => {
    const id = (await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 1', credential: TOKEN_1 })).json.seat.id
    router.recordCreditsExhausted(id, "You've hit your monthly spend limit")
    expect(router.seatStatusOf(router.getAccountById(id)!).health).toBe('credits_exhausted')
    expect(router.pickAccount()).toBeNull()
    router.clearRateLimit(id) // a completed turn with usage
    expect(router.pickAccount()?.id).toBe(id)
    router.recordRateLimit(id) // no stated reset → backoff, not 5h
    const until = Date.parse(router.getAccountById(id)!.rateLimitResetsAt!)
    expect(until - Date.now()).toBeLessThanOrEqual(15 * 60 * 1000 + 1000)
    router.clearRateLimit(id)
    expect(router.seatStatusOf(router.getAccountById(id)!).health).toBe('healthy')
  })

  it('401 parks needs_reconnect and 403 org-disabled parks needs_admin', async () => {
    const id = (await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 1', credential: TOKEN_1 })).json.seat.id
    router.recordAuthFailure(id, 'API Error: 401 Invalid authentication credentials')
    expect(router.seatStatusOf(router.getAccountById(id)!).health).toBe('needs_reconnect')
    router.recordAuthFailure(id, 'Your organization has disabled Claude subscription access for Claude Code')
    expect(router.seatStatusOf(router.getAccountById(id)!).health).toBe('needs_admin')
  })
})

describe('cross-engine failover (opt-in)', () => {
  function card(over: Record<string, unknown> = {}) {
    const ins = getDb().prepare(`INSERT INTO objectives (title, description, status, workspace, agent_context, created_by, model) VALUES ('Card', 'd', 'queue', 'ws-test', 'cto', ?, 'claude-opus-4-8')`).run(ADMIN_ID)
    return { id: Number(ins.lastInsertRowid), workspace: 'ws-test', model: 'claude-opus-4-8', title: 'Card', project: 'p', session_id: null, engine_failover: null, ...over }
  }

  async function claudeSeatsAllDown() {
    const a = (await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 1', credential: TOKEN_1 })).json.seat.id
    const b = (await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 2', credential: TOKEN_2 })).json.seat.id
    router.recordRateLimit(a, new Date(Date.now() + 3600_000))
    router.recordRateLimit(b, new Date(Date.now() + 3600_000))
    loginSeat('codex', 'Seat 3')
  }

  it('default (off): the card stays on its engine and queues', async () => {
    await claudeSeatsAllDown()
    expect(assign.assignSeatForStart(card(), 'claude')).toBeNull()
  })

  it('enabled: falls back only when every seat of the engine is down, and logs it on the card', async () => {
    const put = await call('PUT', '/api/admin/seats/failover/ws-test', { enabled: true, order: ['claude', 'codex', 'grok'] })
    expect(put.json).toMatchObject({ enabled: true, order: ['claude', 'codex', 'grok'] })
    const c = card()
    // A healthy Claude seat → no fallback.
    await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 0', credential: TOKEN_3 })
    loginSeat('codex', 'Seat 3')
    expect(assign.assignSeatForStart(c, 'claude')?.engine).toBe('claude')
    resetPool()
    await claudeSeatsAllDown()
    const got = assign.assignSeatForStart(c, 'claude')!
    expect(got.engine).toBe('codex')
    expect(got.fellBackFrom).toBe('claude')
    const row = getDb().prepare(`SELECT title, detail FROM activity_log WHERE objective_id = ? AND title = 'seat_failover'`).get(c.id) as { detail: string } | undefined
    expect(row?.detail).toMatch(/Every claude seat is unavailable/)
  })

  it('never falls back for a card pinned to one engine', async () => {
    await call('PUT', '/api/admin/seats/failover/ws-test', { enabled: true })
    await claudeSeatsAllDown()
    const c = card()
    const pin = await call('PUT', `/api/admin/seats/card/${c.id}/failover`, { mode: 'pinned' })
    expect(pin.json.failover).toBe('pinned')
    const stored = getDb().prepare('SELECT engine_failover FROM objectives WHERE id = ?').get(c.id) as { engine_failover: string }
    expect(assign.assignSeatForStart({ ...c, engine_failover: stored.engine_failover }, 'claude')).toBeNull()
  })
})

describe('expiry warning', () => {
  it('warns 14 days ahead (and only then), once per seat and expiry date', async () => {
    const soon = new Date(Date.now() + 10 * 86400_000).toISOString()
    const later = new Date(Date.now() + 40 * 86400_000).toISOString()
    const a = (await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat soon', credential: TOKEN_1, expiresAt: soon })).json.seat
    const b = (await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat later', credential: TOKEN_2, expiresAt: later })).json.seat
    expect(a.credential.expiry).toBe('expiring')
    expect(b.credential.expiry).toBeNull()
    expect(health.warnExpiringSeats()).toEqual([a.id])
    const alerts = getDb().prepare(`SELECT title FROM alerts WHERE source = 'seat-pool'`).all() as { title: string }[]
    expect(alerts.map(x => x.title)).toEqual(['Seat credential expires soon: Seat soon'])
  })
})

describe('no secret value in any API response, log line or audit entry', () => {
  it('holds across add, list, rotate, update, test, pool view, account status and remove', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN = SERVER_TOKEN
    const added = await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 1', credential: TOKEN_1 })
    const id = added.json.seat.id
    await call('POST', '/api/admin/seats', { kind: 'claude', label: 'Seat 2', credential: TOKEN_2 })
    expect(added.json.seat.credential).toEqual(expect.objectContaining({ kind: 'setup_token', last4: TOKEN_1.slice(-4) }))
    await call('GET', '/api/admin/seats')
    await call('POST', `/api/admin/seats/${id}/rotate`, { credential: TOKEN_3 })
    await call('PATCH', `/api/admin/seats/${id}`, { label: 'Seat 1b', priority: 2, enabled: true })
    const tested = await call('POST', `/api/admin/seats/${id}/test`)
    expect(tested.json.outcome).toBe('healthy')
    await call('GET', '/api/admin/accounts')
    const pool = await call('GET', '/api/agent/seats')
    expect(pool.json.engines.find((e: { kind: string }) => e.kind === 'claude').seats).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(pool.json)).not.toMatch(/last4|homeDir|CC_SEAT_/)
    // The session env is the one sanctioned place the value goes.
    const seat = router.getAccountById(id)!
    expect(creds.seatCredentialEnv(seat).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN_3)
    const listed = await call('GET', '/api/admin/seats')
    for (const s of listed.json.seats) {
      expect(Object.keys(s).sort()).toEqual(['available', 'consecutiveFailures', 'cooldownUntil', 'credential', 'enabled', 'health', 'id', 'kind', 'label', 'priority', 'sessions', 'usage', 'usageToday'])
    }
    await call('DELETE', `/api/admin/seats/${id}`)

    // Seat credentials are never bulk-injected into other sessions.
    expect(Object.keys(store.resolveSecrets({}))).not.toContain(creds.seatSecretKey(id))
    expect(store.resolveSecretNames({}).some(k => k.startsWith('CC_SEAT_'))).toBe(false)

    const audit = JSON.stringify(getDb().prepare('SELECT * FROM seat_audit_log').all())
    const secretAudit = JSON.stringify(getDb().prepare('SELECT * FROM secret_access_log').all())
    const alerts = JSON.stringify(getDb().prepare('SELECT * FROM alerts').all())
    const stateFile = fs.readFileSync(process.env.CC_ACCOUNT_ROUTER_STATE_FILE!, 'utf-8')
    const rateLog = fs.existsSync(process.env.CC_RATE_LIMIT_LOG!) ? fs.readFileSync(process.env.CC_RATE_LIMIT_LOG!, 'utf-8') : ''
    expect(audit).toMatch(/rotate/)
    const haystacks: Record<string, string> = {
      responses: responses.join('\n'),
      logs: logged.join('\n'),
      seat_audit_log: audit,
      secret_access_log: secretAudit,
      alerts,
      stateFile,
      rateLog,
    }
    for (const [where, text] of Object.entries(haystacks)) {
      for (const token of ALL_TOKENS) {
        expect(text.includes(token), `credential leaked into ${where}`).toBe(false)
        // Not even a long fragment of it.
        expect(text.includes(token.slice(0, 24)), `credential prefix leaked into ${where}`).toBe(false)
      }
    }
    expect(responses.length).toBeGreaterThan(10)
  })
})
