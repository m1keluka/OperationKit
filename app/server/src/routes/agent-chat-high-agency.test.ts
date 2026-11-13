// High Agency (obj 900748): a per-bot on/off + daily cadence that wakes the bot
// with a "what's next?" check. Proves, over HTTP and through the real routine
// scheduler tick:
//   - default OFF: no bot wakes and no routine exists until an admin switches it on;
//   - only a signed-in admin can change it (not a member, not an API key);
//   - on → one managed routine with the cadence's cron, the high-agency brief and
//     the card / workflow permissions; off → that routine is disabled, not deleted;
//   - the scheduler wakes the bot on cadence (a card worked by the bot) and only then;
//   - "Reset to file" on the bot's model/tools does not switch High Agency off;
//   - the boot resync never un-pauses a paused wake and stops a removed bot's wakes.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-high-agency-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-high-agency-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// A dead port: the scheduler's spawn PATCH must never reach a live Command Center.
process.env.PORT = '59948'
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-high-agency-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { runRoutineTickForTests, validateCronExpr, overFireGuardReason } = await import('../services/routine-scheduler.js')
const { resyncHighAgencyRoutines } = await import('../services/agent-chat/high-agency.js')
const { listAgents } = await import('../services/agent-chat/engine.js')
const { highAgencyCron, wakeHours, wakeMinute, wakeTimes } = await import('../../../shared/high-agency.js')

const ADMIN = 1
const MEMBER = 2

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string
let agentKey = ''
const realFetch = globalThis.fetch

function tokenFor(id: number, role: string) {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, p: string, opts: { as?: number; role?: string; body?: unknown; key?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`
  else if (opts.as) headers.Cookie = `token=${tokenFor(opts.as, opts.role ?? 'member')}`
  const res = await realFetch(`${baseUrl}/api/agent-chat${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

const admin = (method: string, p: string, body?: unknown) => call(method, p, { as: ADMIN, role: 'admin', body })

/** The scheduler's spawn PATCH answers 200; every other request is real. */
function stubSpawn() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.includes('/api/internal/objectives/') && url.endsWith('/status')) {
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    return realFetch(input, init)
  }) as typeof fetch)
}

function routine(slug: string) {
  return getDb().prepare('SELECT * FROM routines WHERE name = ?').get(`high-agency:${slug}`) as Loose
}

function writeBot(slug: string, yaml: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), yaml)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'user2', 'x', 'member')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('ops', 'Ops'), ('sales', 'Sales')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'ops', 'admin'), (1, 'sales', 'admin'), (2, 'ops', 'member')`).run()
  writeBot('cto', 'name: CTO\ndescription: Runs engineering.\nsystem_prompt: You own engineering health and the release train.\ntools: [list_objectives, create_objective]\n')
  writeBot('sdr', 'name: SDR\nsystem_prompt: You own outbound pipeline.\n')
  writeBot('temp', 'name: Temp\nsystem_prompt: Short-lived bot.\n')
  const k = createAgentKey({ id: ADMIN, role: 'admin' }, { label: 'grok-bot' })
  if (!k.ok) throw new Error(k.error)
  agentKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterEach(() => { vi.restoreAllMocks() })

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  for (const p of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) fs.rmSync(p, { force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

describe('the cadence → schedule math (shared with the panel preview)', () => {
  it('spreads 1x/2x/3x/4x/6x a day evenly over the 12 hours from the first wake', () => {
    expect(wakeHours(1, 9)).toEqual([9])
    expect(wakeHours(2, 9)).toEqual([9, 15])
    expect(wakeHours(3, 9)).toEqual([9, 13, 17])
    expect(wakeHours(4, 9)).toEqual([9, 12, 15, 18])
    expect(wakeHours(6, 9)).toEqual([9, 11, 13, 15, 17, 19])
    expect(wakeHours(2, 20)).toEqual([2, 20]) // wraps past midnight, sorted for cron
  })

  it('gives each bot a stable minute so bots switched on together do not all wake in one tick', () => {
    expect(wakeMinute('cto')).toBe(wakeMinute('cto'))
    for (const s of ['cto', 'sdr', 'general', 'a']) {
      expect(wakeMinute(s)).toBeGreaterThanOrEqual(0)
      expect(wakeMinute(s)).toBeLessThan(60)
    }
    expect(wakeTimes('cto', 2, 9)).toEqual([`09:${String(wakeMinute('cto')).padStart(2, '0')}`, `15:${String(wakeMinute('cto')).padStart(2, '0')}`])
  })

  it('produces a cron the scheduler accepts, and the over-fire guard never eats a scheduled wake', () => {
    for (const n of [1, 2, 3, 4, 6] as const) {
      const cron = highAgencyCron('cto', n, 9)
      expect(validateCronExpr(cron)).toBeNull()
      // The previous scheduled wake was one full interval ago → the next one may fire.
      const hours = wakeHours(n, 9)
      if (hours.length > 1) {
        const at = new Date(Date.UTC(2026, 10, 13, hours[1], wakeMinute('cto')))
        const prev = new Date(Date.UTC(2026, 10, 13, hours[0], wakeMinute('cto'))).toISOString()
        expect(overFireGuardReason(cron, prev, at)).toBeNull()
      }
    }
  })
})

describe('default off', () => {
  it('no bot has High Agency and no wake routine exists until an admin switches it on', async () => {
    const list = await call('GET', '/agents', { as: MEMBER })
    expect(list.status).toBe(200)
    for (const a of list.json.agents) expect(a.high_agency).toEqual({ enabled: false, times_per_day: 1 })

    const r = await call('GET', '/agents/cto/high-agency', { as: MEMBER })
    expect(r.status).toBe(200)
    expect(r.json.high_agency.enabled).toBe(false)
    expect(r.json.high_agency.routine).toBeNull()
    expect(r.json.high_agency.next_wake_at).toBeNull()
    expect(r.json.cadences).toEqual([1, 2, 3, 4, 6])
    expect(r.json.workspace_options).toBeUndefined() // members do not get the admin picker

    const n = getDb().prepare("SELECT COUNT(*) AS n FROM routines WHERE name LIKE 'high-agency:%'").get() as { n: number }
    expect(n.n).toBe(0)
  })
})

describe('who may change it', () => {
  it('refuses a member and an API key (a bot must not schedule itself)', async () => {
    expect((await call('PUT', '/agents/cto/high-agency', { as: MEMBER, body: { enabled: true } })).status).toBe(403)
    expect((await call('PUT', '/agents/cto/high-agency', { key: agentKey, body: { enabled: true } })).status).toBe(403)
    expect((await call('POST', '/agents/cto/high-agency/wake', { as: MEMBER })).status).toBe(403)
    expect(routine('cto')).toBeUndefined()
  })

  it('rejects a cadence or hour it does not offer, and an unknown bot', async () => {
    expect((await admin('PUT', '/agents/cto/high-agency', { enabled: true, times_per_day: 5 })).status).toBe(400)
    expect((await admin('PUT', '/agents/cto/high-agency', { enabled: true, first_hour: 24 })).status).toBe(400)
    expect((await admin('PUT', '/agents/cto/high-agency', { enabled: 'yes' })).status).toBe(400)
    expect((await admin('PUT', '/agents/cto/high-agency', { workspace: 'not-mine' })).status).toBe(403)
    expect((await admin('PUT', '/agents/nobody/high-agency', { enabled: true })).status).toBe(404)
    expect(routine('cto')).toBeUndefined()
  })
})

describe('switching it on and off', () => {
  it('on → one managed routine with the cadence, the high-agency brief and the permissions', async () => {
    const r = await admin('PUT', '/agents/cto/high-agency', { enabled: true, times_per_day: 2, first_hour: 9, workspace: 'sales' })
    expect(r.status).toBe(200)
    const h = r.json.high_agency
    expect(h.enabled).toBe(true)
    expect(h.times_per_day).toBe(2)
    expect(h.wake_times).toEqual(wakeTimes('cto', 2, 9))
    expect(h.next_wake_at).toBeTruthy()
    expect(h.routine.enabled).toBe(true)
    expect(h.updated_by).toBe('user1')

    const row = routine('cto')
    expect(row.enabled).toBe(1)
    expect(row.kind).toBe('ai')
    expect(row.max_queue_depth).toBe(1)
    expect(row.cron_expr).toBe(highAgencyCron('cto', 2, 9))
    const tpl = JSON.parse(row.objective_template)
    expect(tpl.title).toBe('CTO: High Agency check')
    expect(tpl.agent_context).toBe('cto')
    expect(tpl.workspace).toBe('sales')
    expect(tpl.assigned_user_id).toBe(ADMIN)
    expect(tpl.description).toContain("What's the next thing I need to do? If there's nothing urgent, what can I do to help move my area of the business forward?")
    expect(tpl.description).toContain('You own engineering health and the release train.') // the bot's own instructions
    expect(tpl.description).toContain('You may write cards to the board')
    expect(tpl.description).toContain('/api/internal/objectives')
    expect(tpl.description).toContain('You may propose repeatable workflows')
    expect(tpl.description).toContain('/api/flows')
    expect(tpl.description).toContain('Never publish a workflow')

    const list = await call('GET', '/agents', { as: MEMBER })
    expect(list.json.agents.find((a: Loose) => a.slug === 'cto').high_agency).toEqual({ enabled: true, times_per_day: 2 })
  })

  it('a changed cadence rewrites the same routine; switching a permission off says so in the brief', async () => {
    const before = routine('cto').id
    const r = await admin('PUT', '/agents/cto/high-agency', { times_per_day: 4, first_hour: 7, allow_cards: false, allow_workflows: false })
    expect(r.status).toBe(200)
    const row = routine('cto')
    expect(row.id).toBe(before)
    expect(row.cron_expr).toBe(highAgencyCron('cto', 4, 7))
    const tpl = JSON.parse(row.objective_template)
    expect(tpl.description).toContain('Board cards are switched OFF')
    expect(tpl.description).toContain('Workflow proposals are switched OFF')
    expect(tpl.description).not.toContain('You may write cards to the board')
    await admin('PUT', '/agents/cto/high-agency', { allow_cards: true, allow_workflows: true })
  })

  it('"Reset to file" on the bot\'s model/tools leaves High Agency on', async () => {
    await admin('PUT', '/agents/cto/config', { model: 'claude-opus-5-5' })
    expect((await admin('DELETE', '/agents/cto/config')).status).toBe(200)
    const r = await call('GET', '/agents/cto/high-agency', { as: MEMBER })
    expect(r.json.high_agency.enabled).toBe(true)
    expect(routine('cto').enabled).toBe(1)
  })

  it('off → the routine is disabled but kept (its wake history survives)', async () => {
    const r = await admin('PUT', '/agents/sdr/high-agency', { enabled: true })
    expect(r.status).toBe(200)
    const id = routine('sdr').id
    const off = await admin('PUT', '/agents/sdr/high-agency', { enabled: false })
    expect(off.json.high_agency.enabled).toBe(false)
    expect(off.json.high_agency.next_wake_at).toBeNull()
    expect(routine('sdr').id).toBe(id)
    expect(routine('sdr').enabled).toBe(0)
  })
})

describe('waking on cadence', () => {
  it('the scheduler tick at a wake time files a card worked by the bot — and nothing at other minutes', async () => {
    const spawn = stubSpawn()
    const db = getDb()
    const row = routine('cto')
    const [h0] = wakeHours(4, 7)
    const m = wakeMinute('cto')
    const wakeAt = new Date(2030, 0, 15, h0, m) // server-local, exactly as the scheduler matches
    const offMinute = new Date(2030, 0, 15, h0, (m + 1) % 60)

    await runRoutineTickForTests(offMinute)
    expect((db.prepare('SELECT COUNT(*) AS n FROM objectives WHERE routine_id = ?').get(row.id) as { n: number }).n).toBe(0)

    await runRoutineTickForTests(wakeAt)
    const cards = db.prepare('SELECT * FROM objectives WHERE routine_id = ?').all(row.id) as Loose[]
    expect(cards).toHaveLength(1)
    expect(cards[0].title).toBe('CTO: High Agency check')
    expect(cards[0].agent_context).toBe('cto')
    expect(cards[0].origin).toBe('routine')
    expect(cards[0].assigned_user_id).toBe(ADMIN)
    expect(cards[0].description).toContain('High Agency check for CTO')
    expect(spawn.mock.calls.some(c => String(c[0]).includes(`/objectives/${cards[0].id}/status`))).toBe(true)

    // A bot whose High Agency is off (sdr) never woke.
    expect((db.prepare('SELECT COUNT(*) AS n FROM objectives WHERE routine_id = ?').get(routine('sdr').id) as { n: number }).n).toBe(0)

    const view = await call('GET', '/agents/cto/high-agency', { as: MEMBER })
    expect(view.json.high_agency.last_wake.objective_id).toBe(cards[0].id)
  })

  it('one wake in flight at a time: the next slot is skipped while the last wake card is still open', async () => {
    stubSpawn()
    const db = getDb()
    const row = routine('cto')
    db.prepare("UPDATE objectives SET status = 'working' WHERE routine_id = ?").run(row.id)
    const [, h1] = wakeHours(4, 7)
    await runRoutineTickForTests(new Date(2030, 0, 15, h1, wakeMinute('cto')))
    expect((db.prepare('SELECT COUNT(*) AS n FROM objectives WHERE routine_id = ?').get(row.id) as { n: number }).n).toBe(1)
    db.prepare("UPDATE objectives SET status = 'done' WHERE routine_id = ?").run(row.id)
  })

  it('Wake now files one wake on demand, even while the schedule is off', async () => {
    stubSpawn()
    const r = await admin('POST', '/agents/temp/high-agency/wake')
    expect(r.status).toBe(200)
    expect(r.json.result.ok).toBe(true)
    const card = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(r.json.result.objective_id) as Loose
    expect(card.agent_context).toBe('temp')
    expect(card.workspace).toBe('ops') // the admin's first workspace
    expect(r.json.high_agency.enabled).toBe(false)
    expect(routine('temp').enabled).toBe(0) // trying a wake does not switch the schedule on
    getDb().prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(card.id)
  })
})

describe('boot resync', () => {
  it('never un-pauses a paused wake routine, but a Save does', async () => {
    const db = getDb()
    db.prepare("UPDATE routines SET enabled = 0, auto_paused_at = datetime('now'), auto_pause_reason = '5 consecutive failures' WHERE name = 'high-agency:cto'").run()
    resyncHighAgencyRoutines(listAgents().agents)
    expect(routine('cto').enabled).toBe(0)
    const v = await call('GET', '/agents/cto/high-agency', { as: MEMBER })
    expect(v.json.high_agency.routine.auto_pause_reason).toBe('5 consecutive failures')

    await admin('PUT', '/agents/cto/high-agency', { enabled: true })
    expect(routine('cto').enabled).toBe(1)
    expect(routine('cto').auto_paused_at).toBeNull()
  })

  it('switches off the wakes of a bot whose file was removed', async () => {
    await admin('PUT', '/agents/temp/high-agency', { enabled: true })
    expect(routine('temp').enabled).toBe(1)
    fs.rmSync(path.join(TMP_AGENTS, 'temp'), { recursive: true, force: true })
    const res = resyncHighAgencyRoutines(listAgents().agents)
    expect(res.disabled).toBe(1)
    expect(routine('temp').enabled).toBe(0)
  })
})
