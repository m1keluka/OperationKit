import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// SAFETY: bind DB to a per-process temp FILE before importing db/index (read at
// module-load), so these HTTP tests never touch the live board DB.
const TMP_DB = path.join(os.tmpdir(), `cc-lifecycle-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-lifecycle'

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')

const ADMIN_ID = 1
const WS = 'example'
let server: http.Server
let baseUrl: string

const token = () => jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function patchStatus(id: number, status: string) {
  const res = await fetch(`${baseUrl}/api/objectives/${id}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: `token=${token()}` },
    body: JSON.stringify({ status }),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> }
}
async function del(id: number) {
  const res = await fetch(`${baseUrl}/api/objectives/${id}`, { method: 'DELETE', headers: { Cookie: `token=${token()}` } })
  return { status: res.status, json: await res.json().catch(() => ({})) as Record<string, unknown> }
}
async function list(includeDeleted = false) {
  const url = `${baseUrl}/api/objectives?workspace=${WS}${includeDeleted ? '&include_deleted=1' : ''}`
  const res = await fetch(url, { headers: { Cookie: `token=${token()}` } })
  return await res.json() as { id: number }[]
}

function seed(status = 'review'): number {
  const r = getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status) VALUES ('o', 'cto', ?, ?, ?)`
  ).run(WS, ADMIN_ID, status)
  return Number(r.lastInsertRowid)
}
const auditRows = (id: number) =>
  getDb().prepare('SELECT * FROM objective_audit WHERE objective_id = ? ORDER BY id').all(id) as Record<string, unknown>[]

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  const app = express()
  app.use(express.json()); app.use(cookieParser()); app.use('/api/objectives', objectivesRouter)
  await new Promise<void>(r => { server = app.listen(0, () => r()) })
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})
beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  getDb().prepare('DELETE FROM objective_audit').run()
  getDb().prepare("UPDATE settings SET value = '0' WHERE key = 'soft_delete_enabled'").run()
})

describe('[objective-audit-table] status change appends exactly one audit row', () => {
  it('review→done writes one status_change row with correct from/to/pathway + sets terminal_by_human', async () => {
    const id = seed('review')
    const { status } = await patchStatus(id, 'done')
    expect(status).toBe(200)
    const rows = auditRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      event_type: 'status_change', from_status: 'review', to_status: 'done', pathway: 'public-patch-status',
    })
    // Human ended it → terminal_by_human marker set (FIX B).
    const obj = getDb().prepare('SELECT terminal_by_human FROM objectives WHERE id = ?').get(id) as { terminal_by_human: number }
    expect(obj.terminal_by_human).toBe(1)
  })
})

describe('[soft-delete-gated] delete behavior + audit + include_deleted', () => {
  it('default (soft_delete OFF): HARD delete removes the row and writes one delete_hard audit row', async () => {
    const id = seed('review')
    const { status } = await del(id)
    expect(status).toBe(200)
    expect(getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id)).toBeUndefined()
    const rows = auditRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event_type: 'delete_hard', from_status: 'review' })
  })

  it('soft_delete ON: SOFT delete sets deleted_at, keeps the row, writes one delete_soft audit row', async () => {
    getDb().prepare("UPDATE settings SET value = '1' WHERE key = 'soft_delete_enabled'").run()
    const id = seed('review')
    const { status } = await del(id)
    expect(status).toBe(200)
    const row = getDb().prepare('SELECT deleted_at FROM objectives WHERE id = ?').get(id) as { deleted_at: string | null }
    expect(row.deleted_at).not.toBeNull()
    const rows = auditRows(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event_type: 'delete_soft' })
  })

  it('list hides soft-deleted rows by default and shows them with ?include_deleted=1', async () => {
    getDb().prepare("UPDATE settings SET value = '1' WHERE key = 'soft_delete_enabled'").run()
    const live = seed('review')
    const gone = seed('review')
    await del(gone)

    const def = await list(false)
    expect(def.some(o => o.id === live)).toBe(true)
    expect(def.some(o => o.id === gone)).toBe(false)

    const all = await list(true)
    expect(all.some(o => o.id === gone)).toBe(true)
  })
})
