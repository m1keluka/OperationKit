// obj 64 Part C — same-title duplicate guard over the REAL express routes:
//   POST /api/objectives (incl. start:true), PATCH /api/objectives/:id/status,
//   POST /api/internal/objectives (bulk), PATCH /api/internal/objectives/:id/status.
// Session spawn is stubbed; everything else (DB, routers, guard) is real.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-dup-guard-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-dup-guard'

const startSessionMock = vi.fn(async (o: { id: number }) => `sess-${o.id}`)
vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/session-manager.js')>()
  return { ...actual, startSession: (o: { id: number }) => startSessionMock(o) }
})

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: internalRouter } = await import('./internal.js')

const ADMIN_ID = 1
let server: http.Server
let baseUrl: string
const token = () => jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(method: string, url: string, body?: unknown, cookie = true) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `token=${token()}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, any> }
}
const createPublic = (body: Record<string, unknown>) => call('POST', '/api/objectives', { workspace: 'example', agent_context: 'cto', description: '', ...body })
const createBulk = (items: unknown[]) => call('POST', '/api/internal/objectives', items, false)

function seed(title: string, status = 'queue', extra: { workspace?: string; parent_id?: number; routine_id?: number; minutesAgo?: number } = {}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, agent_context, workspace, created_by, status, parent_id, routine_id, created_at)
       VALUES (?, 'cto', ?, ?, ?, ?, ?, datetime('now', ?))`,
    )
    .run(title, extra.workspace ?? 'example', ADMIN_ID, status, extra.parent_id ?? null, extra.routine_id ?? null, `-${extra.minutesAgo ?? 0} minutes`)
  return Number(r.lastInsertRowid)
}
const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n
const dedupeKinds = () =>
  (getDb().prepare("SELECT metadata FROM activity_log WHERE event_type = 'decision' ORDER BY id").all() as { metadata: string }[])
    .map(r => JSON.parse(r.metadata) as { kind: string; source: string; existing_id: number })

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/internal', internalRouter)
  await new Promise<void>(r => { server = app.listen(0, () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* ignore */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})
beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  getDb().prepare('DELETE FROM activity_log').run()
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'duplicate_guard_%'").run()
  startSessionMock.mockClear()
})

describe('POST /api/objectives — duplicate guard', () => {
  it('refuses a same-title twin with 409 + existing id, records the metric', async () => {
    const first = await createPublic({ title: 'Fix the login bug' })
    expect(first.status).toBe(201)
    const twin = await createPublic({ title: '  fix the LOGIN bug! (2)' })
    expect(twin.status).toBe(409)
    expect(twin.json).toMatchObject({ reason: 'duplicate_24h', duplicate: true, existing_id: first.json.id })
    expect(twin.json.existing).toMatchObject({ id: first.json.id, status: 'queue' })
    expect(count()).toBe(1)
    expect(dedupeKinds()).toEqual([expect.objectContaining({ kind: 'duplicate_refused', source: 'POST /api/objectives', existing_id: first.json.id })])
  })

  it('force:true creates anyway and records duplicate_forced', async () => {
    const first = await createPublic({ title: 'Fix the login bug' })
    const forced = await createPublic({ title: 'Fix the login bug', force: true })
    expect(forced.status).toBe(201)
    expect(forced.json.id).not.toBe(first.json.id)
    expect(count()).toBe(2)
    expect(dedupeKinds()).toEqual([expect.objectContaining({ kind: 'duplicate_forced', existing_id: first.json.id })])
  })

  it('start:true duplicate is refused before insert — nothing created, nothing started', async () => {
    const first = await createPublic({ title: 'Ship the report' })
    const twin = await createPublic({ title: 'Ship the report', start: true })
    expect(twin.status).toBe(409)
    expect(twin.json.existing_id).toBe(first.json.id)
    expect(count()).toBe(1)
    expect(startSessionMock).not.toHaveBeenCalled()
  })

  it('allows: different workspace, done/cancelled twin, >24h-old twin, parent→child same title, kill switch off', async () => {
    seed('Same title', 'queue', { workspace: 'example-project' })
    expect((await createPublic({ title: 'Same title' })).status).toBe(201)

    getDb().prepare('DELETE FROM objectives').run()
    seed('Done twin', 'done'); seed('Done twin', 'cancelled')
    expect((await createPublic({ title: 'Done twin' })).status).toBe(201)

    seed('Old twin', 'queue', { minutesAgo: 24 * 60 + 1 })
    expect((await createPublic({ title: 'Old twin' })).status).toBe(201)

    const parent = seed('Parent title', 'working')
    expect((await createPublic({ title: 'Parent title', parent_id: parent })).status).toBe(201)

    seed('Switch off', 'queue')
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('duplicate_guard_enabled', '0')").run()
    expect((await createPublic({ title: 'Switch off' })).status).toBe(201)
  })
})

describe('PATCH /api/objectives/:id/status — start refused while a twin runs', () => {
  it('409 when the twin is working; force:true starts it', async () => {
    const running = seed('Nightly digest', 'working')
    const queued = seed('Nightly digest (copy)', 'queue')
    const refused = await call('PATCH', `/api/objectives/${queued}/status`, { status: 'working' })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ reason: 'duplicate_24h', existing_id: running })
    expect(startSessionMock).not.toHaveBeenCalled()

    const forced = await call('PATCH', `/api/objectives/${queued}/status`, { status: 'working', force: true })
    expect(forced.status).toBe(200)
    expect(startSessionMock).toHaveBeenCalledTimes(1)
    expect(dedupeKinds().map(k => k.kind)).toEqual(['duplicate_refused', 'duplicate_forced'])
  })

  it('a merely-queued twin does not block a start, nor does a routine card', async () => {
    seed('Queued twin', 'queue')
    const mine = seed('Queued twin', 'queue')
    expect((await call('PATCH', `/api/objectives/${mine}/status`, { status: 'working' })).status).toBe(200)

    seed('Routine run', 'working')
    const routineCard = seed('Routine run', 'queue', { routine_id: 99 })
    expect((await call('PATCH', `/api/objectives/${routineCard}/status`, { status: 'working' })).status).toBe(200)
  })
})

describe('POST /api/internal/objectives — per-item duplicate report', () => {
  it('reports a duplicate item (reason duplicate_24h) and inserts the rest', async () => {
    const existing = seed('Audit billing', 'queue')
    const res = await createBulk([
      { title: 'Audit billing', agent_context: 'cto' },
      { title: 'Something new', agent_context: 'cto' },
    ])
    expect(res.status).toBe(201)
    expect(res.json.created).toBe(1)
    expect(res.json.objectives[0].title).toBe('Something new')
    expect(res.json.deduped).toBe(1)
    expect(res.json.deduped_details).toEqual([
      { title: 'Audit billing', id: existing, status: 'queue', deduped: true, reason: 'duplicate_24h' },
    ])
    expect(dedupeKinds()).toEqual([expect.objectContaining({ kind: 'duplicate_refused', source: 'POST /api/internal/objectives', existing_id: existing })])
  })

  it('409 with existing_ids when EVERY item is a duplicate; twins within one batch collapse', async () => {
    const a = seed('Alpha', 'queue')
    const all = await createBulk([{ title: 'alpha!', agent_context: 'cto' }])
    expect(all.status).toBe(409)
    expect(all.json).toMatchObject({ reason: 'duplicate_24h', existing_ids: [a], created: 0 })

    const batch = await createBulk([{ title: 'Beta', agent_context: 'cto' }, { title: 'Beta (2)', agent_context: 'cto' }])
    expect(batch.status).toBe(201)
    expect(batch.json.created).toBe(1)
    expect(batch.json.deduped_details[0]).toMatchObject({ id: batch.json.objectives[0].id, reason: 'duplicate_24h' })
  })

  it('per-item force:true inserts anyway (and force is an accepted key)', async () => {
    const existing = seed('Gamma', 'queue')
    const res = await createBulk([{ title: 'Gamma', agent_context: 'cto', force: true }])
    expect(res.status).toBe(201)
    expect(res.json.created).toBe(1)
    expect(dedupeKinds()).toEqual([expect.objectContaining({ kind: 'duplicate_forced', existing_id: existing })])
    const row = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(res.json.objectives[0].id) as Record<string, unknown>
    expect(row).not.toHaveProperty('force')
  })
})

describe('PATCH /api/internal/objectives/:id/status — start refused while a twin runs', () => {
  it('409 with existing id; force:true starts', async () => {
    const running = seed('Sync CRM', 'ai_review')
    const queued = seed('Sync CRM', 'queue')
    const refused = await call('PATCH', `/api/internal/objectives/${queued}/status`, { status: 'working' }, false)
    expect(refused.status).toBe(409)
    expect(refused.json.existing_id).toBe(running)
    expect(startSessionMock).not.toHaveBeenCalled()
    const forced = await call('PATCH', `/api/internal/objectives/${queued}/status`, { status: 'working', force: true }, false)
    expect(forced.status).toBe(200)
    expect(startSessionMock).toHaveBeenCalledTimes(1)
  })

  it('a parent and its same-titled child are not twins', async () => {
    const parent = seed('Delegated work', 'working')
    const child = seed('Delegated work', 'queue', { parent_id: parent })
    expect((await call('PATCH', `/api/internal/objectives/${child}/status`, { status: 'working' }, false)).status).toBe(200)
  })
})
