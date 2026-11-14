// High Agency (obj 900748; levels 1-10 + the close-out operating loop, obj 900794).
// Proves, over HTTP and through the real routine scheduler tick:
//   - the level → wakes-a-day mapping (1, 4, 6, 9, 11, 14, 16, 19, 21, 24), level 1
//     = one wake at NIGHT and level 10 = hourly, spread evenly across the day in the
//     install timezone (America/New_York), converted to the server-time cron and
//     moved with DST;
//   - default OFF: no bot wakes and no routine exists until an admin switches it on;
//   - only a signed-in admin can change it (not a member, not an API key);
//   - on → one managed high-agency:<slug> routine whose brief is the vault
//     activation prompt verbatim, in order, plus the bot's permissions; off → disabled;
//   - a wake runs on whatever model the bot is set to, when the board can run it;
//   - the scheduler wakes the bot on schedule (a card worked by the bot) and only then;
//   - the boot resync never un-pauses a paused wake and stops a removed bot's wakes.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import Database from 'better-sqlite3'

process.env.JWT_SECRET = 'test-secret-high-agency-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-high-agency-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// A dead port: the scheduler's spawn PATCH must never reach a live Command Center.
process.env.PORT = '59948'
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-high-agency-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
process.env.AGENT_CHAT_PROVIDER = 'demo'
delete process.env.CC_INSTALL_TIMEZONE

const { initDb, getDb } = await import('../db/index.js')
const { initAgentChatSchema } = await import('../db/schema/agent-chat.js')
const { default: router } = await import('./agent-chat.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { runRoutineTickForTests, validateCronExpr, overFireGuardReason, nextRunAt } = await import('../services/routine-scheduler.js')
const {
  activationPrompt, buildHighAgencyBrief, cronFor, installTimeZone, refreshHighAgencyCrons, resyncHighAgencyRoutines,
} = await import('../services/agent-chat/high-agency.js')
const { listAgents } = await import('../services/agent-chat/engine.js')
const {
  DEFAULT_INSTALL_TIMEZONE, HIGH_AGENCY_LEVELS, NIGHT_HOUR, highAgencyCron, levelSummary, runsPerDay, tzOffsetMinutes,
  wakeHours, wakeMinute, wakeTimes,
} = await import('../../../shared/high-agency.js')

const ADMIN = 1
const MEMBER = 2
const NY = 'America/New_York'
const WINTER = new Date(Date.UTC(2027, 0, 15, 12)) // EST, UTC-5
const SUMMER = new Date(Date.UTC(2027, 6, 15, 12)) // EDT, UTC-4

// The activation prompt exactly as the operationkit vault note
// decisions/2026-11-13-high-agency-activation-prompt-and-operating-loop.md has it.
const VAULT_ACTIVATION_PROMPT = `You are waking in High Agency mode for your area of the business. You own your projects end to end. Do the following in order, then stop.

1. Orient.
   - Read the current objectives for your area in the knowledge base.
   - Read the latest relevant data and metrics.
   - List every board card you own (open, working, blocked, in review, or otherwise unfinished).

2. Close the loop first.
   - For each owned card, compare it to its success criteria.
   - Mark done what has been met. Unblock what you can. Cancel what is obsolete.
   - Write short learnings back to the knowledge base.
   - Do not start new work until this pass is honest and complete.

3. Choose the next project — only one.
   - If, after the close-out, there is a single highest-leverage next project that would move your area forward, name it.
   - Include: rationale (why this, why now), success criteria, and the metric you will use to know it worked.
   - If nothing is worth doing right now, say so clearly, leave a short report, and stop. No busywork, no filler cards, no chores invented to look active.

4. If you chose a project, file it and run it.
   - File it as a board card you own, with the rationale, success criteria, and metric in the brief.
   - Start it and manage it toward completion.
   - Stay inside the spend cap, your workspace access list, and standing approval rules.
   - Sends, spend, and deploys do not happen on your say-so — route them to the decision queue for Operator.
   - Do not merge, deploy, send messages in Operator's name, or touch Shared secrets or PR 645.

5. Leave a short report note on this wake: what you closed, what you started (or why you started nothing), and any risks or asks for Operator.`

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

/** Circular gaps (hours) between consecutive wakes over one day. */
function gaps(hours: number[]): number[] {
  return hours.map((h, i) => (i + 1 < hours.length ? hours[i + 1] - h : 24 - h + hours[0]))
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'user2', 'x', 'member')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('ops', 'Ops'), ('sales', 'Sales')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (1, 'ops', 'admin'), (1, 'sales', 'admin'), (2, 'ops', 'member')`).run()
  writeBot('cto', 'name: CTO\ndescription: Runs engineering.\nmodel: claude-opus-5-5\nsystem_prompt: You own engineering health and the release train.\ntools: [list_objectives, create_objective]\n')
  writeBot('sdr', 'name: SDR\nsystem_prompt: You own outbound pipeline.\n')
  writeBot('temp', 'name: Temp\nsystem_prompt: Short-lived bot.\n')
  // obj 900797: these bots stand for bots that existed before per-bot workspace
  // access lists, so the one-time boot seed keeps them unrestricted (today's
  // behaviour). The restricted path is covered in bot-workspaces.test.ts.
  const { seedExistingBotsOnce } = await import('../services/agent-chat/bot-workspaces.js')
  seedExistingBotsOnce(['cto', 'sdr', 'temp'])
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

describe('levels 1-10 → wakes a day (shared with the panel preview)', () => {
  it('maps level to runs/day = round(1 + (level-1)*23/9): 1, 4, 6, 9, 11, 14, 16, 19, 21, 24', () => {
    expect(HIGH_AGENCY_LEVELS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(HIGH_AGENCY_LEVELS.map(runsPerDay)).toEqual([1, 4, 6, 9, 11, 14, 16, 19, 21, 24])
    for (const l of HIGH_AGENCY_LEVELS) expect(runsPerDay(l)).toBe(Math.round(1 + ((l - 1) * 23) / 9))
  })

  it('level 1 is ONE wake, at night, in the install timezone', () => {
    expect(wakeHours(1)).toEqual([NIGHT_HOUR])
    expect(NIGHT_HOUR).toBeGreaterThanOrEqual(0)
    expect(NIGHT_HOUR).toBeLessThan(5) // the small hours
    expect(wakeTimes('cto', 1)).toEqual([`0${NIGHT_HOUR}:${String(wakeMinute('cto')).padStart(2, '0')}`])
    expect(levelSummary(1)).toBe('Once a day, at night')
  })

  it('level 10 is every hour: 24 wakes, cron "M * * * *"', () => {
    expect(wakeHours(10)).toEqual(Array.from({ length: 24 }, (_, h) => h))
    expect(highAgencyCron('cto', 10, { timeZone: NY, at: WINTER, serverOffsetMinutes: 0 })).toBe(`${wakeMinute('cto')} * * * *`)
    expect(levelSummary(10)).toBe('Every hour')
  })

  it('levels 2-9 spread their wakes across the whole 24-hour day, as evenly as whole hours allow', () => {
    for (const l of HIGH_AGENCY_LEVELS) {
      const hours = wakeHours(l)
      const runs = runsPerDay(l)
      expect(hours).toHaveLength(runs)
      expect(hours).toContain(NIGHT_HOUR) // every level keeps the night wake
      for (const g of gaps(hours)) {
        expect(g).toBeGreaterThanOrEqual(Math.floor(24 / runs))
        expect(g).toBeLessThanOrEqual(Math.ceil(24 / runs))
      }
      if (24 % runs === 0) expect(new Set(gaps(hours)).size).toBe(1) // exactly equal when runs divides 24
    }
    expect(wakeHours(2)).toEqual([2, 8, 14, 20]) // every 6 hours
    expect(wakeHours(3)).toEqual([2, 6, 10, 14, 18, 22]) // every 4 hours from 02:00
    expect(levelSummary(4)).toBe('9 times a day (every 2–3 hours)')
  })

  it('gives each bot a stable minute so bots switched on together do not all wake in one tick', () => {
    expect(wakeMinute('cto')).toBe(wakeMinute('cto'))
    for (const s of ['cto', 'sdr', 'general', 'a']) {
      expect(wakeMinute(s)).toBeGreaterThanOrEqual(0)
      expect(wakeMinute(s)).toBeLessThan(60)
    }
  })
})

describe('install timezone → the server-time cron', () => {
  it('defaults to America/New_York and converts with the offset in force (EST vs EDT)', () => {
    expect(installTimeZone()).toBe(DEFAULT_INSTALL_TIMEZONE)
    expect(DEFAULT_INSTALL_TIMEZONE).toBe(NY)
    expect(tzOffsetMinutes(NY, WINTER)).toBe(-300)
    expect(tzOffsetMinutes(NY, SUMMER)).toBe(-240)
    const m = wakeMinute('cto')
    // 02:mm New York = 07:mm UTC in winter, 06:mm UTC in summer.
    expect(highAgencyCron('cto', 1, { timeZone: NY, at: WINTER, serverOffsetMinutes: 0 })).toBe(`${m} 7 * * *`)
    expect(highAgencyCron('cto', 1, { timeZone: NY, at: SUMMER, serverOffsetMinutes: 0 })).toBe(`${m} 6 * * *`)
    // Level 2 (every 6h from 02:00 NY) in winter UTC: 01, 07, 13, 19.
    expect(highAgencyCron('cto', 2, { timeZone: NY, at: WINTER, serverOffsetMinutes: 0 })).toBe(`${m} 1,7,13,19 * * *`)
  })

  it('an operator can set another install timezone; an unknown zone falls back to the default', () => {
    const db = getDb()
    db.prepare("INSERT INTO settings (key, value) VALUES ('install_timezone', 'Europe/London') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    expect(installTimeZone()).toBe('Europe/London')
    expect(installTimeZone({ CC_INSTALL_TIMEZONE: 'Asia/Tokyo' } as NodeJS.ProcessEnv)).toBe('Asia/Tokyo')
    db.prepare("UPDATE settings SET value = 'Not/AZone' WHERE key = 'install_timezone'").run()
    expect(installTimeZone()).toBe(NY)
    db.prepare("DELETE FROM settings WHERE key = 'install_timezone'").run()
  })

  it('every level yields a cron the scheduler accepts, and the over-fire guard never eats a scheduled wake', () => {
    for (const l of HIGH_AGENCY_LEVELS) {
      for (const at of [WINTER, SUMMER]) {
        const cron = highAgencyCron('cto', l, { timeZone: NY, at })
        expect(validateCronExpr(cron)).toBeNull()
        // Walk a day of scheduled wakes: each one may fire after the previous one.
        let prev = nextRunAt(cron, at)!
        const fires = [prev]
        for (let i = 1; i < runsPerDay(l) + 1; i++) {
          const next = nextRunAt(cron, prev)!
          expect(overFireGuardReason(cron, prev.toISOString(), next)).toBeNull()
          fires.push(next)
          prev = next
        }
        // Over the next 24 hours the scheduler fires exactly runs/day times.
        const dayEnd = fires[0].getTime() + 24 * 3600_000
        expect(fires.filter(f => f.getTime() < dayEnd)).toHaveLength(runsPerDay(l))
      }
    }
  })
})

describe('default off', () => {
  it('no bot has High Agency and no wake routine exists until an admin switches it on', async () => {
    const list = await call('GET', '/agents', { as: MEMBER })
    expect(list.status).toBe(200)
    for (const a of list.json.agents) expect(a.high_agency).toEqual({ enabled: false, level: 1 })

    const r = await call('GET', '/agents/cto/high-agency', { as: MEMBER })
    expect(r.status).toBe(200)
    expect(r.json.high_agency.enabled).toBe(false)
    expect(r.json.high_agency.level).toBe(1)
    expect(r.json.high_agency.runs_per_day).toBe(1)
    expect(r.json.high_agency.timezone).toBe(NY)
    expect(r.json.high_agency.routine).toBeNull()
    expect(r.json.high_agency.next_wake_at).toBeNull()
    expect(r.json.levels).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(r.json.max_new_projects_per_wake).toBe(1)
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

  it('rejects a level it does not offer, the retired cadence fields, and an unknown bot', async () => {
    for (const level of [0, 11, 2.5, '3', null]) {
      expect((await admin('PUT', '/agents/cto/high-agency', { enabled: true, level })).status).toBe(400)
    }
    expect((await admin('PUT', '/agents/cto/high-agency', { enabled: true, times_per_day: 2 })).status).toBe(400)
    expect((await admin('PUT', '/agents/cto/high-agency', { enabled: true, first_hour: 9 })).status).toBe(400)
    expect((await admin('PUT', '/agents/cto/high-agency', { enabled: 'yes' })).status).toBe(400)
    expect((await admin('PUT', '/agents/cto/high-agency', { workspace: 'not-mine' })).status).toBe(403)
    expect((await admin('PUT', '/agents/nobody/high-agency', { enabled: true })).status).toBe(404)
    expect(routine('cto')).toBeUndefined()
  })
})

describe('the wake brief = the vault activation prompt + the operating loop', () => {
  it('the five steps are the vault text, verbatim and in order', () => {
    expect(activationPrompt('Operator')).toBe(VAULT_ACTIVATION_PROMPT)
  })

  it('the brief opens with the activation prompt, then who the bot is, then how to do each step', () => {
    const agent = { slug: 'cto', name: 'CTO', description: 'Runs engineering.', system_prompt: 'You own engineering health.', knowledge_folders: [] as string[] }
    const brief = buildHighAgencyBrief(agent, { level: 4, workspace: 'ops', allow_cards: true, allow_workflows: true }, 'Operator')
    expect(brief).toContain(VAULT_ACTIVATION_PROMPT)
    const order = ['1. Orient.', '2. Close the loop first.', '3. Choose the next project — only one.', '4. If you chose a project, file it and run it.', '5. Leave a short report note', '## Who you are', '## How to do each step', '## Limits on a wake']
    const at = order.map(s => brief.indexOf(s))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(brief).toContain('level 4: 9 times a day (every 2–3 hours)')
    expect(brief).toContain('agent_context is `cto`') // what "a card you own" means
    // PR 757's supervisor hook stays in the Orient step, before Close the loop.
    expect(brief).toContain('/api/internal/supervisor/flags?bot=cto')
    expect(brief.indexOf('/api/internal/supervisor/flags?bot=cto')).toBeLessThan(brief.indexOf('**2. Close the loop.**'))
    expect(brief).toContain('at most 1 new card on this wake')
    expect(brief).toContain('"status":"working"') // start it
    expect(brief).toContain('"acceptance_criteria":[{"id":"c1","criterion":') // the shape POST /api/internal/objectives takes
    expect(brief).toContain('/api/flows') // a recurring project may be a workflow DRAFT
    expect(brief).toContain('job-disposition')
    expect(brief).toContain("Operator's decision queue")
    // No busywork quotas and no self-granted send/spend/deploy.
    expect(brief).not.toMatch(/at most (2|3|three) /i)
    expect(brief).toContain('Never send email or messages to people, spend money, merge, deploy')
  })

  it('switching a permission off says so, and the operating loop stays', () => {
    const agent = { slug: 'sdr', name: 'SDR', description: '', system_prompt: '', knowledge_folders: [] as string[] }
    const brief = buildHighAgencyBrief(agent, { level: 1, workspace: 'ops', allow_cards: false, allow_workflows: false })
    expect(brief).toContain(activationPrompt('the owner'))
    expect(brief).toContain('Filing cards is switched OFF')
    expect(brief).not.toContain('/api/internal/objectives -H')
    expect(brief).not.toContain('/api/flows')
  })
})

describe('switching it on and off', () => {
  it('on → one managed routine with the level\'s cron, the activation-prompt brief and the permissions', async () => {
    const r = await admin('PUT', '/agents/cto/high-agency', { enabled: true, level: 4, workspace: 'sales' })
    expect(r.status).toBe(200)
    const h = r.json.high_agency
    expect(h.enabled).toBe(true)
    expect(h.level).toBe(4)
    expect(h.runs_per_day).toBe(9)
    expect(h.wake_times).toEqual(wakeTimes('cto', 4))
    expect(h.timezone).toBe(NY)
    expect(h.next_wake_at).toBeTruthy()
    expect(h.routine.enabled).toBe(true)
    expect(h.updated_by).toBe('user1')

    const row = routine('cto')
    expect(row.enabled).toBe(1)
    expect(row.kind).toBe('ai')
    expect(row.max_queue_depth).toBe(1)
    expect(row.cron_expr).toBe(cronFor('cto', 4))
    const tpl = JSON.parse(row.objective_template)
    expect(tpl.title).toBe('CTO: High Agency wake')
    expect(tpl.agent_context).toBe('cto')
    expect(tpl.workspace).toBe('sales')
    expect(tpl.assigned_user_id).toBe(ADMIN)
    expect(tpl.description).toContain(activationPrompt('User1')) // the admin who switched it on approves
    expect(tpl.description).toContain('You own engineering health and the release train.') // the bot's own instructions
    expect(tpl.completion_goal).toMatch(/close out every owned card/)

    const list = await call('GET', '/agents', { as: MEMBER })
    expect(list.json.agents.find((a: Loose) => a.slug === 'cto').high_agency).toEqual({ enabled: true, level: 4 })
  })

  it('a changed level rewrites the same routine', async () => {
    const before = routine('cto').id
    const r = await admin('PUT', '/agents/cto/high-agency', { level: 10 })
    expect(r.status).toBe(200)
    expect(routine('cto').id).toBe(before)
    expect(routine('cto').cron_expr).toBe(`${wakeMinute('cto')} * * * *`)
    await admin('PUT', '/agents/cto/high-agency', { level: 2 })
    expect(routine('cto').cron_expr).toBe(cronFor('cto', 2))
  })

  it('off → the routine is disabled but kept (its wake history survives)', async () => {
    const r = await admin('PUT', '/agents/sdr/high-agency', { enabled: true })
    expect(r.status).toBe(200)
    expect(r.json.high_agency.level).toBe(1) // first switch-on = one night wake
    const id = routine('sdr').id
    const off = await admin('PUT', '/agents/sdr/high-agency', { enabled: false })
    expect(off.json.high_agency.enabled).toBe(false)
    expect(off.json.high_agency.next_wake_at).toBeNull()
    expect(routine('sdr').id).toBe(id)
    expect(routine('sdr').enabled).toBe(0)
  })
})

describe('any model the bot may use', () => {
  const tplModel = (slug: string) => JSON.parse(routine(slug).objective_template).model

  it('the wake runs on the bot\'s own model when the board can run it', async () => {
    expect(tplModel('cto')).toBe('claude-opus-5-5') // from the agent file
    expect((await call('GET', '/agents/cto/high-agency', { as: MEMBER })).json.high_agency.wake_model).toBe('claude-opus-5-5')
  })

  it('changing the bot\'s model on the bot page re-renders the wake (Codex, Grok, …) and keeps it running', async () => {
    for (const model of ['gpt-5.5', 'grok-4.6']) {
      expect((await admin('PUT', '/agents/cto/config', { model })).status).toBe(200)
      expect(tplModel('cto')).toBe(model)
      expect(routine('cto').enabled).toBe(1)
    }
  })

  it('a model enabled later (e.g. a new Claude) works the day it is in Settings → Models — nothing is hard-coded', async () => {
    getDb().prepare("INSERT OR IGNORE INTO models (id, label, engine, enabled, is_default, is_planner, sort_order) VALUES ('claude-fable-5-2', 'Fable 5.2', 'claude', 1, 0, 0, 2)").run()
    await admin('PUT', '/agents/cto/config', { model: 'claude-fable-5-2' })
    expect(tplModel('cto')).toBe('claude-fable-5-2')
  })

  it('a chat-only model the board cannot run falls back to the board default instead of breaking the wake', async () => {
    await admin('PUT', '/agents/cto/config', { model: 'my-local-llm' })
    expect(tplModel('cto')).toBeUndefined()
    expect((await call('GET', '/agents/cto/high-agency', { as: MEMBER })).json.high_agency.wake_model).toBeNull()
  })

  it('"Reset to file" restores the file\'s model and leaves High Agency on', async () => {
    expect((await admin('DELETE', '/agents/cto/config')).status).toBe(200)
    expect(tplModel('cto')).toBe('claude-opus-5-5')
    const r = await call('GET', '/agents/cto/high-agency', { as: MEMBER })
    expect(r.json.high_agency.enabled).toBe(true)
    expect(routine('cto').enabled).toBe(1)
  })
})

describe('waking on schedule', () => {
  it('the scheduler tick at a wake time files a card worked by the bot — and nothing at other minutes', async () => {
    const spawn = stubSpawn()
    const db = getDb()
    const row = routine('cto')
    const wakeAt = nextRunAt(row.cron_expr, new Date(2030, 0, 15, 0, 0))!
    const offMinute = new Date(wakeAt.getTime() + 60_000)

    await runRoutineTickForTests(offMinute)
    expect((db.prepare('SELECT COUNT(*) AS n FROM objectives WHERE routine_id = ?').get(row.id) as { n: number }).n).toBe(0)

    await runRoutineTickForTests(wakeAt)
    const cards = db.prepare('SELECT * FROM objectives WHERE routine_id = ?').all(row.id) as Loose[]
    expect(cards).toHaveLength(1)
    expect(cards[0].title).toBe('CTO: High Agency wake')
    expect(cards[0].agent_context).toBe('cto')
    expect(cards[0].origin).toBe('routine')
    expect(cards[0].assigned_user_id).toBe(ADMIN)
    expect(cards[0].model).toBe('claude-opus-5-5') // the bot's model reached the card
    expect(cards[0].description).toContain('You are waking in High Agency mode for your area of the business.')
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
    // Clear last_run_at so the over-fire guard cannot be what refuses this slot.
    db.prepare('UPDATE routines SET last_run_at = NULL WHERE id = ?').run(row.id)
    const log = vi.spyOn(console, 'log')
    const next = nextRunAt(row.cron_expr, new Date(2030, 0, 15, 12, 0))!
    await runRoutineTickForTests(next)
    expect(log.mock.calls.some(c => String(c[0]).includes('queue depth guard'))).toBe(true)
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

describe('DST: the cron follows the install timezone', () => {
  it('refreshHighAgencyCrons moves each cron to the current offset, touching nothing else', () => {
    const db = getDb()
    const before = routine('cto')
    refreshHighAgencyCrons(WINTER)
    const winter = routine('cto').cron_expr
    expect(winter).toBe(cronFor('cto', 2, WINTER))
    expect(refreshHighAgencyCrons(SUMMER)).toBeGreaterThan(0)
    const summer = routine('cto').cron_expr
    expect(summer).toBe(cronFor('cto', 2, SUMMER))
    if (new Date().getTimezoneOffset() === 0) expect(summer).not.toBe(winter) // a UTC server sees the hour move
    expect(refreshHighAgencyCrons(SUMMER)).toBe(0) // idempotent
    const after = routine('cto')
    expect(after.enabled).toBe(before.enabled)
    expect(after.objective_template).toBe(before.objective_template)
    refreshHighAgencyCrons(new Date())
    expect(db.prepare("SELECT COUNT(*) AS n FROM routines WHERE name LIKE 'high-agency:%' AND cron_expr = ''").get()).toEqual({ n: 0 })
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

describe('upgrade from the cadence picker (obj 900748 rows)', () => {
  it('adds the level column and keeps at least as many wakes a day as the old cadence', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE agent_chat_high_agency (
      slug TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, times_per_day INTEGER NOT NULL DEFAULT 1,
      first_hour INTEGER NOT NULL DEFAULT 9, workspace TEXT, allow_cards INTEGER NOT NULL DEFAULT 1,
      allow_workflows INTEGER NOT NULL DEFAULT 1, run_as_user_id INTEGER, routine_id INTEGER, updated_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')))`)
    const ins = db.prepare('INSERT INTO agent_chat_high_agency (slug, enabled, times_per_day) VALUES (?, 1, ?)')
    for (const [slug, t] of [['a', 1], ['b', 2], ['c', 4], ['d', 6]] as const) ins.run(slug, t)
    initAgentChatSchema(db)
    const levels = Object.fromEntries((db.prepare('SELECT slug, level FROM agent_chat_high_agency').all() as { slug: string; level: number }[]).map(r => [r.slug, r.level]))
    expect(levels).toEqual({ a: 1, b: 2, c: 2, d: 3 })
    for (const [slug, t] of [['a', 1], ['b', 2], ['c', 4], ['d', 6]] as const) expect(runsPerDay(levels[slug] as 1 | 2 | 3)).toBeGreaterThanOrEqual(t)
    initAgentChatSchema(db) // idempotent
    db.close()
  })
})
