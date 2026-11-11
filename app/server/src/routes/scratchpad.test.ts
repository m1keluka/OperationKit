import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Isolated DB + JWT secret BEFORE importing modules that read them.
process.env.JWT_SECRET = 'test-secret-scratchpad'
const TMP_DB = path.join(os.tmpdir(), `cc-scratchpad-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./scratchpad.js')

let server: http.Server
let baseUrl: string

const USER_A = 1
const USER_B = 2

function cookieFor(id: number): string {
  return `token=${jwt.sign({ id, username: `u${id}`, role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}

async function call(method: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${baseUrl}/api/scratchpad`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, json }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'a', 'x', 'member')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'b', 'x', 'member')`).run()

  const app = express()
  app.use(express.json({ limit: '2mb' }))
  app.use(cookieParser())
  app.use('/api/scratchpad', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

describe('scratchpad routes', () => {
  it('requires auth', async () => {
    const r = await call('GET')
    expect(r.status).toBe(401)
  })

  it('GET returns empty string for a fresh user', async () => {
    const r = await call('GET', undefined, cookieFor(USER_A))
    expect(r.status).toBe(200)
    expect(r.json.content).toBe('')
    expect(r.json.updated_at).toBeNull()
  })

  it('PUT then GET round-trips content for the same user', async () => {
    const put = await call('PUT', { content: '# Hello\n\n- a note' }, cookieFor(USER_A))
    expect(put.status).toBe(200)
    expect(put.json.ok).toBe(true)
    expect(typeof put.json.updated_at).toBe('string')

    const get = await call('GET', undefined, cookieFor(USER_A))
    expect(get.status).toBe(200)
    expect(get.json.content).toBe('# Hello\n\n- a note')
    expect(typeof get.json.updated_at).toBe('string')
  })

  it('is strictly per-account — user B never sees user A content', async () => {
    // A already wrote above. B is untouched.
    const getB = await call('GET', undefined, cookieFor(USER_B))
    expect(getB.json.content).toBe('')

    await call('PUT', { content: 'B private' }, cookieFor(USER_B))
    const getBAgain = await call('GET', undefined, cookieFor(USER_B))
    expect(getBAgain.json.content).toBe('B private')

    // A is unchanged by B's write.
    const getA = await call('GET', undefined, cookieFor(USER_A))
    expect(getA.json.content).toBe('# Hello\n\n- a note')
  })

  it('PUT upserts (overwrites) on the same user', async () => {
    await call('PUT', { content: 'v2' }, cookieFor(USER_A))
    const get = await call('GET', undefined, cookieFor(USER_A))
    expect(get.json.content).toBe('v2')
  })

  it('rejects a non-string body with 400', async () => {
    const r = await call('PUT', { content: 123 }, cookieFor(USER_A))
    expect(r.status).toBe(400)
  })

  it('rejects an over-cap body with 413', async () => {
    const r = await call('PUT', { content: 'x'.repeat(100_001) }, cookieFor(USER_A))
    expect(r.status).toBe(413)
  })
})
