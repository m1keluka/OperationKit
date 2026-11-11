// obj 64 Part B — routine create/update accept script + auto-pause fields, and
// the one-click resume endpoints (internal + the admin route the Jobs board calls).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const SECRET = 'test-internal-secret-routines-b' // gitleaks:allow — literal test fixture, not a credential
process.env.INTERNAL_API_SECRET = SECRET
const TMP_DB = path.join(os.tmpdir(), `cc-routine-routes-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRoutinesRouter } = await import('./internal-routines.js')
const { default: adminJobsRouter } = await import('./admin-jobs.js')

let server: http.Server
let baseUrl: string
const H = { 'Content-Type': 'application/json', 'X-Internal-Secret': SECRET }

const post = (p: string, body: unknown = {}) =>
  fetch(`${baseUrl}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) })
const patch = (p: string, body: unknown) =>
  fetch(`${baseUrl}${p}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) })

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = express()
  app.use(express.json())
  app.use('/api/internal/routines', internalRoutinesRouter)
  app.use('/api/admin', adminJobsRouter) // auth is applied by the admin.ts facade in prod
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})
beforeEach(() => {
  getDb().prepare('DELETE FROM routines').run()
})
afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* ignore */ }
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${TMP_DB}${s}`)) fs.unlinkSync(`${TMP_DB}${s}`)
})

function pausedRoutine(): number {
  const id = getDb()
    .prepare(
      `INSERT INTO routines (name, cron_expr, objective_template, enabled, kind, script_command,
         consecutive_failures, auto_paused_at, auto_pause_reason)
       VALUES ('paused-one', '0 * * * *', '{}', 0, 'script', 'x', 5, '2026-11-01T00:00:00Z',
               'auto-paused: 5 failures, last error exit 1')`,
    )
    .run().lastInsertRowid as number
  return id
}

describe('create/update accept script + auto-pause fields', () => {
  it('creates a script routine without an objective_template', async () => {
    const res = await post('/api/internal/routines', {
      name: 'disk-check',
      cron_expr: '0 * * * *',
      kind: 'script',
      script_command: 'bash /opt/check.sh',
      alert_marker: '!!',
      max_consecutive_failures: 3,
      script_timeout_sec: 120,
    })
    expect(res.status).toBe(201)
    const row = await res.json()
    expect(row).toMatchObject({
      kind: 'script',
      script_command: 'bash /opt/check.sh',
      alert_marker: '!!',
      max_consecutive_failures: 3,
      script_timeout_sec: 120,
      objective_template: '{}',
    })
  })

  it('rejects kind=script without script_command, and bad values', async () => {
    let res = await post('/api/internal/routines', { name: 'a', cron_expr: '0 * * * *', kind: 'script' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/script_command is required/)
    res = await post('/api/internal/routines', { name: 'b', cron_expr: '0 * * * *', kind: 'bogus', objective_template: { title: 't' } })
    expect(res.status).toBe(400)
    res = await post('/api/internal/routines', {
      name: 'c', cron_expr: '0 * * * *', objective_template: { title: 't' }, max_consecutive_failures: -1,
    })
    expect(res.status).toBe(400)
  })

  it('an AI routine still requires a template title', async () => {
    const res = await post('/api/internal/routines', { name: 'ai', cron_expr: '0 * * * *' })
    expect(res.status).toBe(400)
  })

  it('PATCH validates against the merged kind/command', async () => {
    const created = await (await post('/api/internal/routines', {
      name: 'ai-1', cron_expr: '0 * * * *', objective_template: { title: 'T' },
    })).json()
    let res = await patch(`/api/internal/routines/${created.id}`, { kind: 'script' })
    expect(res.status).toBe(400)
    res = await patch(`/api/internal/routines/${created.id}`, { kind: 'script', script_command: 'echo hi' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'script', script_command: 'echo hi' })
    res = await patch(`/api/internal/routines/${created.id}`, { script_command: '' })
    expect(res.status).toBe(400)
  })

  it('PATCH enabled=true clears auto-pause state', async () => {
    const id = pausedRoutine()
    const res = await patch(`/api/internal/routines/${id}`, { enabled: true })
    expect(await res.json()).toMatchObject({ enabled: 1, consecutive_failures: 0, auto_paused_at: null, auto_pause_reason: null })
  })
})

describe('resume endpoints', () => {
  it('POST /api/internal/routines/:id/resume clears the auto-pause and logs activity', async () => {
    const id = pausedRoutine()
    const res = await post(`/api/internal/routines/${id}/resume`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ enabled: 1, consecutive_failures: 0, auto_paused_at: null, auto_pause_reason: null })
    const act = getDb()
      .prepare("SELECT metadata FROM activity_log WHERE json_extract(metadata, '$.kind') = 'routine_resumed' AND json_extract(metadata, '$.routine_id') = ?")
      .get(id)
    expect(act).toBeTruthy()
    expect((await post('/api/internal/routines/99999/resume')).status).toBe(404)
  })

  it('POST /api/admin/routines/:id/resume (Jobs board) does the same', async () => {
    const id = pausedRoutine()
    const res = await post(`/api/admin/routines/${id}/resume`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.routine).toMatchObject({ enabled: 1, consecutive_failures: 0, auto_pause_reason: null })
    expect((await post('/api/admin/routines/99999/resume')).status).toBe(404)
  })

  it('GET /api/admin/routines surfaces the auto-pause + script fields', async () => {
    pausedRoutine()
    const body = await (await fetch(`${baseUrl}/api/admin/routines`)).json()
    expect(body.routines[0]).toMatchObject({
      kind: 'script',
      enabled: false,
      consecutive_failures: 5,
      auto_pause_threshold: 5,
      auto_pause_reason: 'auto-paused: 5 failures, last error exit 1',
    })
  })
})
