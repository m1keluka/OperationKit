import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import { spawnSync } from 'child_process'

// obj 900624 — agent chat answered "Not logged in · Please run /login" (as an
// HTTP 200 with role=error) while card sessions were running on the same
// Claude login. This drives the REAL path end to end: HTTP route → engine →
// Claude provider → seat pool (account-router + seat-credentials + the
// secrets store) → runClaudeTurn spawning a `claude` binary. Only the binary
// is fake: a small script that behaves like the CLI (stream-json out, "Not
// logged in" when no credential reaches it, a usage-limit error for a
// rate-limited token) and logs which HOME and which credential each turn got.
//
// Fake credentials only. They must never appear in a response or a log line.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-seats-'))
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')
process.env.CC_SEAT_HOME_ROOT = path.join(TMP, 'seats')
process.env.CC_LEGACY_CODEX_HOME = path.join(TMP, 'no-legacy-codex')
process.env.GROK_HOME_DIR = path.join(TMP, 'no-legacy-grok')
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.JWT_SECRET = 'test-secret-chat-seat-failover-xx'
process.env.AGENT_FILES_DIR = path.join(TMP, 'agents')
process.env.KNOWLEDGE_BASE_DIR = path.join(TMP, 'kb')
process.env.AGENT_CHAT_PROVIDER = 'claude'
process.env.AGENT_CHAT_TIMEOUT_MS = '20000'
delete process.env.AGENT_CHAT_CLAUDE_OAUTH_TOKEN
delete process.env.AGENT_CHAT_SLOTS
delete process.env.LLM_GATEWAY_SLOTS
// The OVH trial install: sandboxed card sessions + the installer's one server token.
process.env.SESSION_ISOLATION = 'docker'
const SERVER_TOKEN = 'fake-server-token-for-tests-3333333333333333-ddd4'
process.env.SESSION_JAIL_CLAUDE_OAUTH_TOKEN = SERVER_TOKEN
const TOKEN_1 = 'fake-setup-token-for-tests-0000000000000000-aaa1'
const TOKEN_2 = 'fake-setup-token-for-tests-1111111111111111-bbb2'
const ALL_TOKENS = [TOKEN_1, TOKEN_2, SERVER_TOKEN]
const LABEL: Record<string, string> = { [TOKEN_1]: 'seat-1', [TOKEN_2]: 'seat-2', [SERVER_TOKEN]: 'server' }

// ── the fake `claude` CLI ──
const CALLS = path.join(TMP, 'calls.jsonl')
const BEHAVIOUR = path.join(TMP, 'behaviour.json')
const FAKE_CLAUDE = `#!${process.execPath}
const fs = require('fs'), path = require('path')
const START = Date.now()
if (process.argv[2] === '--probe') { console.log('fake-claude'); process.exit(0) }
const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(BEHAVIOUR)}, 'utf8'))
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || ''
const who = cfg.labels[token] || (token ? 'unknown' : 'none')
const home = process.env.HOME
const out = o => process.stdout.write(JSON.stringify(o) + '\\n')
const log = extra => fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ who, home, pid: process.pid, t: START, ...extra }) + '\\n')
let stdin = ''
process.stdin.on('data', d => { stdin += d })
process.stdin.on('end', () => {
  // The CLI rewrites its config in HOME on every start. Two turns sharing one
  // HOME is the clobber this objective removes: fail loudly if it happens.
  const marker = path.join(home, '.claude.json')
  const shared = fs.existsSync(marker)
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid }))
  if (!token || cfg.notLoggedIn.includes(who) || shared) {
    log({ outcome: shared ? 'shared-home' : 'not-logged-in' })
    out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } })
    out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', usage: {} })
    process.exit(1)
  }
  if (cfg.rateLimited.includes(who)) {
    log({ outcome: 'rate-limited' })
    out({ type: 'result', subtype: 'error', is_error: true, result: "You've hit your usage limit", usage: {} })
    process.exit(1)
  }
  setTimeout(() => {
    log({ outcome: 'ok', end: Date.now() })
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Answered by ' + who } } })
    out({ type: 'result', subtype: 'success', is_error: false, result: 'Answered by ' + who, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 })
    process.exit(0)
  }, 250)
})
`

// The fake must really be the one that runs. Some machines mount /tmp noexec,
// and then execvp silently falls through to the next PATH entry — a real
// `claude`. So: put it in the first dir where it actually executes, and make
// it the ONLY thing on PATH, so a failure is ENOENT, never the real CLI.
const EXTRA_DIRS: string[] = []
function installFakeClaude(): string {
  const candidates = [path.join(TMP, 'bin'), path.join(process.cwd(), `.cc-test-fake-claude-${process.pid}`)]
  for (const dir of candidates) {
    fs.mkdirSync(dir, { recursive: true })
    if (!dir.startsWith(TMP)) EXTRA_DIRS.push(dir)
    const bin = path.join(dir, 'claude')
    fs.writeFileSync(bin, FAKE_CLAUDE, { mode: 0o755 })
    // An extensionless script under a "type": "module" package would load as ESM.
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}')
    const r = spawnSync(bin, ['--probe'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim() === 'fake-claude') return dir
  }
  throw new Error('could not install an executable fake claude')
}
const BIN = installFakeClaude()
process.env.CC_CLI_BIN_DIR = BIN
process.env.PATH = BIN

function behave(b: { notLoggedIn?: string[]; rateLimited?: string[] } = {}): void {
  fs.writeFileSync(BEHAVIOUR, JSON.stringify({ labels: LABEL, notLoggedIn: b.notLoggedIn ?? [], rateLimited: b.rateLimited ?? [] }))
  fs.rmSync(CALLS, { force: true })
}
function calls(): { who: string; home: string; pid: number; t: number; end?: number; outcome: string }[] {
  if (!fs.existsSync(CALLS)) return []
  return fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

vi.mock('../../ws/index.js', () => ({ broadcast: vi.fn() }))

const logged: string[] = []
for (const fn of ['log', 'warn', 'error', 'info'] as const) {
  vi.spyOn(console, fn).mockImplementation((...args: unknown[]) => {
    logged.push(args.map(a => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a) } catch { return String(a) } })())).join(' '))
  })
}

const express = (await import('express')).default
const cookieParser = (await import('cookie-parser')).default
const jwt = (await import('jsonwebtoken')).default
const { initDb, getDb } = await import('../../db/index.js')
const seatRouter = await import('../account-router.js')
const creds = await import('../seat-credentials.js')
const { default: chatRouter } = await import('../../routes/agent-chat.js')

const OWNER = 2
const BOTS = ['your-org-general', 'your-org-cfo', 'your-org-cto']
// The card sessions from the incident, all live on the same logins.
const CARD_SESSIONS = ['cc-900591', 'cc-900613', 'cc-900620', 'cc-900499']

let server: http.Server
let baseUrl = ''
const bodies: string[] = []

async function say(slug: string, text: string): Promise<{ status: number; json: any; retryAfter: string | null }> {
  const t = jwt.sign({ id: OWNER, username: 'owner', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  const res = await fetch(`${baseUrl}/api/agent-chat/agents/${slug}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${t}` },
    body: JSON.stringify({ text }),
  })
  const body = await res.text()
  bodies.push(body)
  return { status: res.status, json: body ? JSON.parse(body) : null, retryAfter: res.headers.get('retry-after') }
}

async function history(slug: string): Promise<any[]> {
  const t = jwt.sign({ id: OWNER, username: 'owner', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  const res = await fetch(`${baseUrl}/api/agent-chat/agents/${slug}/messages`, { headers: { Cookie: `token=${t}` } })
  const body = await res.text()
  bodies.push(body)
  return (JSON.parse(body).messages ?? []) as any[]
}

const seats: { id: string }[] = []

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'owner', 'x', 'member')`).run(OWNER)
  for (const slug of BOTS) {
    fs.mkdirSync(path.join(process.env.AGENT_FILES_DIR!, slug), { recursive: true })
    fs.writeFileSync(
      path.join(process.env.AGENT_FILES_DIR!, slug, 'agent.yaml'),
      `name: ${slug}\nsystem_prompt: You help.\ntools: []\nversion: 1.0.0\nauthor: Test\n`,
    )
  }
  fs.mkdirSync(process.env.KNOWLEDGE_BASE_DIR!, { recursive: true })

  // Two pasted setup-token seats, exactly as Settings → Seats stores them.
  for (const [i, token] of [TOKEN_1, TOKEN_2].entries()) {
    const id = `s${i + 1}`
    const { ref, hint } = creds.storeSeatCredential(id, token)
    const seat = seatRouter.addAccountSlot({ label: `Seat ${i + 1}`, credentialKind: 'setup_token', credentialRef: ref, credentialHint: hint })
    seats.push(seat)
  }

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', chatRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* closed */ }
  vi.restoreAllMocks()
  fs.rmSync(TMP, { recursive: true, force: true })
  for (const d of EXTRA_DIRS) fs.rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  behave()
  // Every seat is busy with card sessions, as on the trial install.
  for (const s of seatRouter.listSeatRecords()) {
    s.authFailedAt = null
    s.rateLimitResetsAt = null
    s.lastRateLimit = null
    s.consecutiveFailures = 0
  }
  CARD_SESSIONS.forEach((sid, i) => seatRouter.recordSessionStart(seats[i % seats.length].id, sid))
  for (const slug of BOTS) getDb().prepare('DELETE FROM agent_chat_messages WHERE agent_slug = ?').run(slug)
})

describe('agent chat on the seat pool while card sessions run (obj 900624)', () => {
  it('every bot answers, concurrently, while four card sessions hold the seats — each turn signed in, in its own HOME', async () => {
    expect(seatRouter.listSeatRecords().reduce((n, s) => n + s.activeSessions.length, 0)).toBe(CARD_SESSIONS.length)

    // Three bots, two rounds, all in flight at the same time.
    const turns = await Promise.all(BOTS.flatMap(slug => [say(slug, 'status?'), say(slug, 'status?').catch(e => e)]))
    const ok = turns.filter(t => t.status === 200)
    // A second message to the same bot while the first is running is refused
    // as busy (409) by design — but nothing may come back "Not logged in".
    for (const t of turns) expect([200, 409]).toContain(t.status)
    expect(ok.length).toBeGreaterThanOrEqual(BOTS.length)
    for (const t of ok) {
      const roles = t.json.messages.map((m: any) => m.role)
      expect(roles).toEqual(['user', 'assistant'])
      expect(t.json.messages[1].content).toMatch(/^Answered by (seat-1|seat-2|server)$/)
    }
    for (const t of turns) expect(JSON.stringify(t.json)).not.toMatch(/not logged in/i)

    const log = calls()
    expect(log.length).toBe(ok.length)
    // Every CLI start had a credential, and none shared a config dir.
    for (const c of log) {
      expect(c.who).not.toBe('none')
      expect(c.outcome).toBe('ok')
      expect(c.home.startsWith(path.join(os.tmpdir(), 'cc-agent-chat-'))).toBe(true)
      expect(fs.existsSync(c.home)).toBe(false) // removed after the turn
    }
    expect(new Set(log.map(c => c.home)).size).toBe(log.length)
    // They really did overlap in time (so the HOME check above means something).
    const sorted = [...log].sort((a, b) => a.t - b.t)
    expect(sorted[1].t).toBeLessThan(sorted[0].end!)
    // The pool was used: the seats answered, not just the server token.
    expect(log.some(c => c.who === 'seat-1' || c.who === 'seat-2')).toBe(true)
  })

  it('a seat whose CLI says "Not logged in" is skipped and the next healthy seat answers — and it is not parked', async () => {
    behave({ notLoggedIn: ['seat-1'] })
    for (const slug of BOTS) {
      const r = await say(slug, 'hello')
      expect(r.status).toBe(200)
      expect(r.json.messages.map((m: any) => m.role)).toEqual(['user', 'assistant'])
      expect(r.json.messages[1].content).not.toMatch(/seat-1/)
    }
    const s1 = seatRouter.getAccountById(seats[0].id)!
    expect(s1.authFailedAt ?? null).toBeNull()
  })

  it('fails over from rate-limited seats to the server token as the last resort', async () => {
    behave({ rateLimited: ['seat-1', 'seat-2'] })
    const r = await say(BOTS[0], 'hello')
    expect(r.status).toBe(200)
    expect(r.json.messages[1].content).toBe('Answered by server')
    expect(calls().map(c => c.outcome)).toEqual(['rate-limited', 'rate-limited', 'ok'])
  })

  it('no seat available → HTTP 503 with a plain-language error, and the message is not stored half-answered', async () => {
    behave({ notLoggedIn: ['seat-1', 'seat-2', 'server'] })
    const r = await say(BOTS[1], 'hello')
    expect(r.status).toBe(503)
    expect(r.retryAfter).toBe('30')
    expect(r.json.code).toBe('ai_unavailable')
    expect(r.json.error).toMatch(/No Claude seat could sign in/)
    expect(r.json.error).not.toMatch(/claude exited|\/login/)
    expect(r.json.messages).toEqual([])
    expect(await history(BOTS[1])).toEqual([])
    // Every candidate was tried exactly once.
    expect(calls().map(c => c.who).sort()).toEqual(['seat-1', 'seat-2', 'server'])
  })

  it('never puts a credential value in a response or a log line', () => {
    const haystack = [...bodies, ...logged].join('\n')
    for (const t of ALL_TOKENS) expect(haystack).not.toContain(t)
  })
})
