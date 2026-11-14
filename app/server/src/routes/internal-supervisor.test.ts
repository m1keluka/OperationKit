/**
 * obj 900795 — High Agency supervisor routes. Synthetic fixtures only: a
 * throwaway SQLite DB with two made-up workspaces and made-up bots.
 *
 *   - a bot reads ONLY the flags routed to it, and a card session only its own workspace;
 *   - a scoped session asking for another workspace is a loud 403;
 *   - run-now is localhost + X-Internal-Secret (it is the only route that writes);
 *   - there is no route that decides/withdraws/edits a flag.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-supervisor-routes-')))
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'test-secret-supervisor-900795'
process.env.INTERNAL_API_SECRET = 'test-internal-secret-900795'
delete process.env.CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL
delete process.env.INTERNAL_TRUSTED_PEER_CIDRS

const { initDb, getDb } = await import('../db/index.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { internalApiGate } = await import('../middleware/internal-api-gate.js')
const { runSupervisor } = await import('../services/high-agency-supervisor.js')
const { default: supervisorRouter } = await import('./internal-supervisor.js')

let server: http.Server
let baseUrl: string
let alphaToken = ''
const SECRET = { 'X-Internal-Secret': 'test-internal-secret-900795' }

async function call(method: string, p: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers })
  let body: any = null
  try { body = await res.json() } catch { body = null }
  return { status: res.status, body }
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  const adminId = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('sup-admin', 'x', 'admin')").run().lastInsertRowid)
  const casey = Number(db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('sup-casey', 'x', 'member')").run().lastInsertRowid)
  db.prepare("INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'ws-alpha', 'member')").run(casey)
  const r1 = Number(db.prepare("INSERT INTO routines (name, cron_expr, objective_template, enabled) VALUES ('high-agency:alpha-bot', '0 9 * * *', '{}', 1)").run().lastInsertRowid)
  const r2 = Number(db.prepare("INSERT INTO routines (name, cron_expr, objective_template, enabled) VALUES ('high-agency:beta-bot', '0 9 * * *', '{}', 1)").run().lastInsertRowid)
  db.prepare(`INSERT INTO agent_chat_high_agency (slug, enabled, workspace, run_as_user_id, routine_id)
              VALUES ('alpha-bot', 1, 'ws-alpha', ?, ?), ('beta-bot', 1, 'ws-beta', ?, ?)`).run(adminId, r1, adminId, r2)
  const ins = db.prepare("INSERT INTO objectives (title, description, workspace, agent_context, status) VALUES (?, 'synthetic', ?, ?, 'working')")
  // ws-alpha: a same-owner twin pair (→ alpha-bot) and an orphan-style twin with Operator's own card (→ human).
  const a1 = Number(ins.run('Alpha twin', 'ws-alpha', 'alpha-bot').lastInsertRowid)
  ins.run('Alpha twin', 'ws-alpha', 'alpha-bot')
  ins.run('Shared task', 'ws-alpha', 'general')
  ins.run('Shared task', 'ws-alpha', 'alpha-bot')
  // ws-beta: a twin pair owned by beta-bot.
  ins.run('Beta twin', 'ws-beta', 'beta-bot')
  ins.run('Beta twin', 'ws-beta', 'beta-bot')
  runSupervisor(db, { knownBots: ['alpha-bot', 'beta-bot'], trigger: 'manual' })
  alphaToken = mintSessionToken({ objectiveId: a1, workspace: 'ws-alpha', actingUserId: casey })

  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalApiGate)
  app.use('/api/internal/supervisor', supervisorRouter)
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      resolve()
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('GET /api/internal/supervisor/flags', () => {
  it('a bot reads only the flags routed to it', async () => {
    const r = await call('GET', '/api/internal/supervisor/flags?bot=alpha-bot', SECRET)
    expect(r.status).toBe(200)
    expect(r.body.count).toBe(1)
    expect(r.body.flags[0]).toMatchObject({ routed_to: 'agent:alpha-bot', workspace: 'ws-alpha', kind: 'decision' })
    expect(r.body.flags[0].ask).toMatch(/^Supervisor — duplicate:/)
  })

  it('routed_to=human returns the flags that need a person', async () => {
    const r = await call('GET', '/api/internal/supervisor/flags?routed_to=human', SECRET)
    expect(r.status).toBe(200)
    expect(r.body.flags.map((f: { routed_to: string }) => f.routed_to)).toEqual(['human:sup-admin'])
  })

  it('a card session sees only its own workspace', async () => {
    const r = await call('GET', '/api/internal/supervisor/flags', { 'X-CC-Session-Token': alphaToken })
    expect(r.status).toBe(200)
    expect(new Set(r.body.flags.map((f: { workspace: string }) => f.workspace))).toEqual(new Set(['ws-alpha']))
    expect(r.body.count).toBe(2)
  })

  it('a card session asking for another workspace is a loud 403', async () => {
    const r = await call('GET', '/api/internal/supervisor/flags?workspace=ws-beta', { 'X-CC-Session-Token': alphaToken })
    expect(r.status).toBe(403)
  })

  it('rejects a malformed bot slug and an unsupported routed_to', async () => {
    expect((await call('GET', '/api/internal/supervisor/flags?bot=../x', SECRET)).status).toBe(400)
    expect((await call('GET', '/api/internal/supervisor/flags?routed_to=agent:alpha-bot', SECRET)).status).toBe(400)
  })
})

describe('GET /api/internal/supervisor (status)', () => {
  it('reports on/off, the stall window, rights and recent runs', async () => {
    const r = await call('GET', '/api/internal/supervisor', SECRET)
    expect(r.status).toBe(200)
    expect(r.body.enabled).toBe(true)
    expect(r.body.stalled_after_minutes).toBeNull()
    expect(r.body.rights).toMatch(/no send, spend, merge, deploy/)
    expect(r.body.live_flags).toEqual({ total: 3, to_bots: 2, to_human: 1 })
    expect(r.body.runs[0]).toMatchObject({ trigger: 'manual', status: 'ok', flags: 3, filed: 3 })
  })
})

describe('POST /api/internal/supervisor/run', () => {
  it('refuses without the internal secret', async () => {
    const r = await call('POST', '/api/internal/supervisor/run', { 'X-CC-Session-Token': alphaToken })
    expect([401, 403]).toContain(r.status)
  })

  it('runs with the secret and records a manual run', async () => {
    const r = await call('POST', '/api/internal/supervisor/run', SECRET)
    expect(r.status).toBe(200)
    expect(r.body.trigger).toBe('manual')
    expect(typeof r.body.run_id).toBe('number')
  })

  it('exposes no route that decides, withdraws or edits a flag', async () => {
    for (const [m, p] of [['POST', '/api/internal/supervisor/flags/1/decide'], ['DELETE', '/api/internal/supervisor/flags/1'], ['PATCH', '/api/internal/supervisor/flags/1']]) {
      expect((await call(m, p, SECRET)).status).toBe(404)
    }
  })
})
