import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-api-key-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-api-key-xxxx'

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('./auth.js')
const { API_KEY_PREFIX } = await import('../lib/api-keys.js')

let server: http.Server
let baseUrl: string
let cookie: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const hash = bcrypt.hashSync('correct-horse', 4)
  getDb().prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
  ).run('admin', hash, 'admin')

  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/auth', authRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  cookie = `token=${jwt.sign({ id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

async function authed(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...(init.headers || {}) },
  })
}

describe('API key (Settings → You)', () => {
  it('starts with no key', async () => {
    const res = await authed('/api/auth/api-key')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ configured: false, last4: null, created_at: null })
  })

  it('mints a cc_live_ key once, authenticates /me, and hides the secret on GET', async () => {
    const minted = await authed('/api/auth/api-key', { method: 'POST' })
    expect(minted.status).toBe(201)
    const body = await minted.json() as { token: string; last4: string }
    expect(body.token.startsWith(API_KEY_PREFIX)).toBe(true)
    expect(body.token.slice(-4)).toBe(body.last4)

    const listed = await authed('/api/auth/api-key')
    const summary = await listed.json() as { configured: boolean; last4: string }
    expect(summary.configured).toBe(true)
    expect(summary.last4).toBe(body.last4)
    expect(JSON.stringify(summary)).not.toContain(body.token)

    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${body.token}` },
    })
    expect(me.status).toBe(200)
    expect((await me.json() as { username: string }).username).toBe('admin')
  })

  it('rotating kills the old key', async () => {
    const first = await (await authed('/api/auth/api-key', { method: 'POST' })).json() as { token: string }
    const second = await (await authed('/api/auth/api-key', { method: 'POST' })).json() as { token: string }
    expect(second.token).not.toBe(first.token)

    const old = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${first.token}` },
    })
    expect(old.status).toBe(401)

    const fresh = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${second.token}` },
    })
    expect(fresh.status).toBe(200)
  })

  it('revoke stops the key', async () => {
    const { token } = await (await authed('/api/auth/api-key', { method: 'POST' })).json() as { token: string }
    const del = await authed('/api/auth/api-key', { method: 'DELETE' })
    expect(del.status).toBe(200)
    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(me.status).toBe(401)
  })
})
