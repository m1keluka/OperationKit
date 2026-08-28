import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// QW5 / audit B#9: skip_ai_review bypasses the QA gate, so only admins may
// ENABLE it. These tests exercise the real objectives router over HTTP and
// demonstrate both verifier signals: a non-admin's attempt to enable the
// toggle is rejected (403), while an admin's succeeds.
const TMP_DB = path.join(os.tmpdir(), `cc-skipai-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-skipai'

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')

const ADMIN_ID = 1
const MEMBER_ID = 2
const WS = 'test-ws'

let server: http.Server
let baseUrl: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  return app
}

function token(role: 'admin' | 'member'): string {
  const id = role === 'admin' ? ADMIN_ID : MEMBER_ID
  return jwt.sign({ id, username: role, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function post(role: 'admin' | 'member', body: unknown) {
  const res = await fetch(`${baseUrl}/api/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token(role)}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

async function put(role: 'admin' | 'member', id: number, body: unknown) {
  const res = await fetch(`${baseUrl}/api/objectives/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token(role)}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  // Seed the two users referenced by the JWTs (user_workspaces has an FK to users).
  const ins = getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`)
  ins.run(ADMIN_ID, 'admin', 'admin')
  ins.run(MEMBER_ID, 'member', 'member')
  // Member must have workspace access so the workspace-gate isn't what rejects
  // them — we want to prove the skip_ai_review gate specifically.
  getDb().prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(MEMBER_ID, WS)
  const app = makeApp()
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
})

describe('POST /api/objectives — skip_ai_review admin gate (QW5)', () => {
  it('REJECTS a non-admin enabling skip_ai_review (403)', async () => {
    const { status, json } = await post('member', { title: 'm', workspace: WS, agent_context: 'cto', skip_ai_review: true })
    expect(status).toBe(403)
    expect(json.error).toMatch(/admin/i)
  })

  it('ALLOWS an admin to enable skip_ai_review (201, persisted)', async () => {
    const { status, json } = await post('admin', { title: 'a', workspace: WS, agent_context: 'cto', skip_ai_review: true })
    expect(status).toBe(201)
    expect(json.skip_ai_review).toBe(true)
  })

  it('control: a non-admin can still create WITHOUT skip_ai_review (proves the gate is skip-specific)', async () => {
    const { status, json } = await post('member', { title: 'm2', workspace: WS, agent_context: 'cto' })
    expect(status).toBe(201)
    expect(json.skip_ai_review).toBe(false)
  })
})

describe('PUT /api/objectives/:id — skip_ai_review admin gate (QW5)', () => {
  function seedObjective(skip: number): number {
    const r = getDb().prepare(
      `INSERT INTO objectives (title, agent_context, workspace, created_by, status, skip_ai_review)
       VALUES ('o', 'cto', ?, ?, 'queue', ?)`
    ).run(WS, MEMBER_ID, skip)
    return Number(r.lastInsertRowid)
  }

  it('REJECTS a non-admin turning skip_ai_review on (403)', async () => {
    const id = seedObjective(0)
    const { status, json } = await put('member', id, { skip_ai_review: true })
    expect(status).toBe(403)
    expect(json.error).toMatch(/admin/i)
  })

  it('ALLOWS an admin to turn skip_ai_review on (200, persisted)', async () => {
    const id = seedObjective(0)
    const { status, json } = await put('admin', id, { skip_ai_review: true })
    expect(status).toBe(200)
    expect(json.skip_ai_review).toBe(true)
  })

  it('ALLOWS a non-admin to turn skip_ai_review OFF (re-arming QA is not privileged)', async () => {
    const id = seedObjective(1)
    const { status, json } = await put('member', id, { skip_ai_review: false })
    expect(status).toBe(200)
    expect(json.skip_ai_review).toBe(false)
  })
})
