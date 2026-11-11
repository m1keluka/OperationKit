/**
 * Per-admin limit on the two admin user routes that hash a password and may
 * send an email (CodeQL js/missing-rate-limiting, public sync PR #81).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-admin-users-rl-xx'
const TMP_DB = path.join(os.tmpdir(), `cc-admin-users-rl-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: usersRouter, ADMIN_USER_WRITE_LIMIT } = await import('./admin-users.js')
const { resetRateLimits } = await import('../services/file-access.js')

let server: http.Server
let base: string
let adminA: number
let adminB: number
let target: number

const cookieFor = (id: number, username: string) =>
  `token=${jwt.sign({ id, username, role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const ins = getDb().prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
  adminA = Number(ins.run('admin-a', 'x', 'admin').lastInsertRowid)
  adminB = Number(ins.run('admin-b', 'x', 'admin').lastInsertRowid)
  target = Number(ins.run('member-1', 'x', 'member').lastInsertRowid)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin/users', usersRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => resetRateLimits())

function reset(cookie: string) {
  // Too-short password: a cheap 400 that still passes through the limiter.
  return fetch(`${base}/api/admin/users/${target}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ password: 'short' }),
  })
}

describe('admin user writes are rate limited per admin', () => {
  it(`allows ${ADMIN_USER_WRITE_LIMIT} calls, then 429 with Retry-After; another admin is unaffected`, async () => {
    const a = cookieFor(adminA, 'admin-a')
    for (let i = 0; i < ADMIN_USER_WRITE_LIMIT; i++) expect((await reset(a)).status).toBe(400)
    const over = await reset(a)
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await reset(cookieFor(adminB, 'admin-b'))).status).toBe(400)
  })

  it('create-user shares the same per-admin budget', async () => {
    const a = cookieFor(adminA, 'admin-a')
    for (let i = 0; i < ADMIN_USER_WRITE_LIMIT; i++) await reset(a)
    const r = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: a },
      body: JSON.stringify({ username: 'new-user', password: 'long-enough-pw' }),
    })
    expect(r.status).toBe(429)
  })

  it('unauthenticated callers are rejected before the limiter', async () => {
    expect((await reset('')).status).toBe(401)
  })
})
