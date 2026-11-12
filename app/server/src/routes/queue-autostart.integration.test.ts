import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 900625 — end to end over the real routers: a card created with start=true
// that hits the session cap is flagged, stays in queue, and is started by the
// queue auto-starter once a slot frees. Also covers the PATCH status=working
// (start_objective) cap path, the hold/blocked_by fields on create/update, the
// admin toggle, and get_progress's last_start_reason. Only the tmux spawn is mocked.
const TMP_DB = path.join(os.tmpdir(), `cc-queue-autostart-int-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-queue-autostart'

const startSessionMock = vi.fn(async (o: { id: number }) => `sess-${o.id}`)
vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, startSession: (o: { id: number }) => startSessionMock(o) }
})

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: adminQueueAutostartRouter } = await import('./admin-queue-autostart.js')
const { requireAuth, requireAdmin } = await import('../middleware/auth.js')
const { MAX_CONCURRENT_SESSIONS } = await import('@operationkit/shared')
const { runQueueAutostartTick } = await import('../services/queue-autostart.js')
const { invalidateWorkspacesCache } = await import('../services/workspaces.js')

const ADMIN_ID = 1
const MEMBER_ID = 2
const WS = 'qa-int-ws'
const BUSY_WS = 'qa-busy-ws'
const ENV: NodeJS.ProcessEnv = { CC_QUEUE_AUTOSTART_GRACE_MIN: '0' }
const okSeat = () => ({ ok: true, engine: 'claude' as const })

let server: http.Server
let baseUrl: string

function token(role: 'admin' | 'member'): string {
  const id = role === 'admin' ? ADMIN_ID : MEMBER_ID
  return jwt.sign({ id, username: role, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, url: string, opts: { role?: 'admin' | 'member'; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token(opts.role ?? 'admin')}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) as Record<string, any> }
}

function fillSessionCap(): number[] {
  const ins = getDb().prepare(`INSERT INTO objectives (title, agent_context, workspace, status, created_by) VALUES (?, 'general', ?, 'working', ?)`)
  const out: number[] = []
  for (let i = 0; i < MAX_CONCURRENT_SESSIONS; i++) out.push(Number(ins.run(`busy ${i}`, BUSY_WS, ADMIN_ID).lastInsertRowid))
  return out
}

function tick() {
  return runQueueAutostartTick({ db: getDb(), env: ENV, seatCheck: okSeat })
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const ins = db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`)
  ins.run(ADMIN_ID, 'admin', 'admin')
  ins.run(MEMBER_ID, 'member', 'member')
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(MEMBER_ID, WS)
  for (const slug of [WS, BUSY_WS]) {
    db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(slug, slug)
  }
  invalidateWorkspacesCache()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/admin', requireAuth, requireAdmin, adminQueueAutostartRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP_DB + s)) fs.unlinkSync(TMP_DB + s)
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM objectives').run()
  db.prepare('DELETE FROM objective_audit').run()
  db.prepare("DELETE FROM settings WHERE key LIKE 'queue_autostart%' OR key LIKE 'job_%'").run()
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`job_wallclock_ceiling_ms:${WS}`, '3600000')
  startSessionMock.mockClear()
})

describe('admin toggle', () => {
  it('admin turns a workspace on/off; enabled_at is stamped; members are refused', async () => {
    const off = await call('GET', '/api/admin/queue-autostart')
    expect(off.status).toBe(200)
    expect(off.json.workspaces).toEqual([])
    expect(off.json.max_concurrent).toBe(4)

    expect((await call('PUT', `/api/admin/queue-autostart/${WS}`, { role: 'member', body: { enabled: true } })).status).toBe(403)
    expect((await call('PUT', `/api/admin/queue-autostart/${WS}`, { body: { enabled: 'yes' } })).status).toBe(400)
    expect((await call('PUT', '/api/admin/queue-autostart/no-such-ws', { body: { enabled: true } })).status).toBe(404)

    const on = await call('PUT', `/api/admin/queue-autostart/${WS}`, { body: { enabled: true } })
    expect(on.status).toBe(200)
    expect(on.json.workspaces).toEqual([
      expect.objectContaining({ workspace: WS, enabled: true, source: 'setting', ceiling_policy: 'enforce', ceiling_configured: true }),
    ])
    expect(on.json.workspaces[0].enabled_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/)

    const back = await call('PUT', `/api/admin/queue-autostart/${WS}`, { body: { enabled: false } })
    expect(back.json.workspaces).toEqual([])
  })
})

describe('create start=true → session_cap → auto-start when a slot frees', () => {
  it('flags the capped card, leaves it queued, then the sweep starts it once a slot frees', async () => {
    await call('PUT', `/api/admin/queue-autostart/${WS}`, { body: { enabled: true } })
    const busy = fillSessionCap()

    const res = await call('POST', '/api/objectives', { body: { title: 'Capped but wanted', workspace: WS, start: true } })
    expect(res.status).toBe(409)
    expect(res.json.start).toMatchObject({
      started: false,
      reason: 'session_cap',
      auto_start: { requested: true, workspace_enabled: true },
    })
    expect(res.json.start.detail).toMatch(/auto-start as soon as a session slot frees/)
    const id = res.json.objective.id as number
    const flagged = getDb().prepare('SELECT status, auto_start_requested_at FROM objectives WHERE id = ?').get(id) as Record<string, unknown>
    expect(flagged.status).toBe('queue')
    expect(flagged.auto_start_requested_at).toBeTruthy()

    // Cap still full → the sweep must not start it.
    const blocked = await tick()
    expect(blocked.stoppedBy).toBe('session_cap')
    expect(startSessionMock).not.toHaveBeenCalled()

    // A slot frees.
    getDb().prepare("UPDATE objectives SET status = 'review' WHERE id = ?").run(busy[0])
    const r = await tick()
    expect(r.started).toEqual([id])
    expect(startSessionMock).toHaveBeenCalledTimes(1)
    const row = getDb().prepare('SELECT status, session_id, auto_start_requested_at FROM objectives WHERE id = ?').get(id) as Record<string, unknown>
    expect(row).toMatchObject({ status: 'working', session_id: `sess-${id}`, auto_start_requested_at: null })
    const audit = getDb().prepare("SELECT pathway FROM objective_audit WHERE objective_id = ? AND to_status = 'working'").all(id)
    expect(audit).toEqual([{ pathway: 'queue-autostart' }])

    // get_progress surfaces who started it.
    const prog = await call('GET', `/api/objectives/${id}/progress`)
    expect(prog.status).toBe(200)
    expect(prog.json.last_start_reason).toBe('queue_autostart')
    expect(prog.json.queue_autostart).toMatchObject({ workspace_enabled: true, requested_at: null })
    expect(prog.json.queue_autostart.autostarted_at).toBeTruthy()
  })

  it('in a workspace without auto-start the capped card is still flagged but the response says start it later', async () => {
    fillSessionCap()
    const res = await call('POST', '/api/objectives', { body: { title: 'Capped elsewhere', workspace: WS, start: true } })
    expect(res.status).toBe(409)
    expect(res.json.start.auto_start).toEqual({ requested: true, workspace_enabled: false })
    expect(res.json.start.detail).toMatch(/PATCH \/api\/objectives\/\{id\}\/status/)
    const r = await tick()
    expect(r.workspaces).toEqual([])
    expect(startSessionMock).not.toHaveBeenCalled()
  })

  it('PATCH status=working (start_objective) on a backlog card at the cap flags it; it starts after a slot frees', async () => {
    // A backlog card: created long before the workspace was switched on.
    const id = Number(
      getDb()
        .prepare(`INSERT INTO objectives (title, agent_context, workspace, status, type, created_by, created_at) VALUES ('Old backlog', 'general', ?, 'queue', 'task', ?, datetime('now', '-3 days'))`)
        .run(WS, ADMIN_ID).lastInsertRowid,
    )
    await call('PUT', `/api/admin/queue-autostart/${WS}`, { body: { enabled: true } })
    expect((await tick()).candidates).toBe(0) // backlog is not swept up

    const busy = fillSessionCap()
    const res = await call('PATCH', `/api/objectives/${id}/status`, { body: { status: 'working' } })
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ reason: 'session_cap', auto_start: { requested: true, workspace_enabled: true } })

    getDb().prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(busy[1])
    const r = await tick()
    expect(r.started).toEqual([id])
  })
})

describe('hold / blocked_by on create and update', () => {
  it('create with queue_hold → never auto-started; clearing the hold via PUT releases it', async () => {
    await call('PUT', `/api/admin/queue-autostart/${WS}`, { body: { enabled: true } })
    getDb().prepare("UPDATE settings SET value = datetime('now', '-1 hour') WHERE key = ?").run(`queue_autostart_enabled_at:${WS}`)
    const res = await call('POST', '/api/objectives', { body: { title: 'Wait for legal', workspace: WS, queue_hold: 'WAIT: legal sign-off' } })
    expect(res.status).toBe(201)
    expect(res.json.queue_hold).toBe('WAIT: legal sign-off')
    expect((await tick()).candidates).toBe(0)

    const cleared = await call('PUT', `/api/objectives/${res.json.id}`, { body: { queue_hold: null } })
    expect(cleared.status).toBe(200)
    expect(cleared.json.queue_hold).toBeNull()
    expect((await tick()).started).toEqual([res.json.id])
  })

  it('blocked_by is validated (same workspace, not self) and honoured until the dependency is done', async () => {
    await call('PUT', `/api/admin/queue-autostart/${WS}`, { body: { enabled: true } })
    getDb().prepare("UPDATE settings SET value = datetime('now', '-1 hour') WHERE key = ?").run(`queue_autostart_enabled_at:${WS}`)
    const dep = await call('POST', '/api/objectives', { body: { title: 'Dependency', workspace: WS, queue_hold: 'manual' } })
    const foreign = await call('POST', '/api/objectives', { body: { title: 'Foreign', workspace: BUSY_WS } })

    expect((await call('POST', '/api/objectives', { body: { title: 'Bad dep', workspace: WS, blocked_by: foreign.json.id } })).status).toBe(400)
    const waiting = await call('POST', '/api/objectives', { body: { title: 'Waits on dep', workspace: WS, blocked_by: dep.json.id } })
    expect(waiting.status).toBe(201)
    expect(waiting.json.blocked_by).toBe(dep.json.id)
    expect((await call('PUT', `/api/objectives/${waiting.json.id}`, { body: { blocked_by: waiting.json.id } })).status).toBe(400)

    expect((await tick()).started).toEqual([])
    getDb().prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(dep.json.id)
    expect((await tick()).started).toEqual([waiting.json.id])
  })
})
