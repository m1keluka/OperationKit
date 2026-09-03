import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcrypt'
import { LOGIN_RATE_LIMIT, resetLoginRateLimit } from '../middleware/login-rate-limit.js'

const TMP_DB = path.join(os.tmpdir(), `cc-auth-login-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-auth-login-xx'

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('./auth.js')

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const hash = bcrypt.hashSync('correct-horse', 4)
  getDb().prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).run('mike', hash, 'admin')

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
  resetLoginRateLimit()
})

async function login(body: object, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /api/auth/login', () => {
  it('sets an httpOnly cookie on success', async () => {
    const res = await login({ username: 'mike', password: 'correct-horse' })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toMatch(/token=/)
    expect(setCookie.toLowerCase()).toContain('httponly')
    expect(setCookie.toLowerCase()).toContain('samesite=strict')
    const json = await res.json() as { user: { username: string } }
    expect(json.user.username).toBe('mike')
  })

  it('returns the same 401 for a missing user and a wrong password', async () => {
    const missing = await login({ username: 'nope', password: 'whatever' })
    const wrong = await login({ username: 'mike', password: 'nope' })
    expect(missing.status).toBe(401)
    expect(wrong.status).toBe(401)
    expect(await missing.json()).toEqual({ error: 'Invalid credentials' })
    expect(await wrong.json()).toEqual({ error: 'Invalid credentials' })
  })

  it('429s after too many failures for one identity', async () => {
    let last: Response | undefined
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_PER_IDENTITY + 1; i++) {
      last = await login(
        { username: 'mike', password: 'wrong' },
        { 'X-Forwarded-For': '203.0.113.9' },
      )
    }
    expect(last!.status).toBe(429)
    expect(last!.headers.get('retry-after')).toBeTruthy()
    const json = await last!.json() as { error: string }
    expect(json.error).toMatch(/Too many login attempts/)
  })

  it('successful login clears the failure bucket', async () => {
    const ip = { 'X-Forwarded-For': '203.0.113.10' }
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_PER_IDENTITY - 1; i++) {
      const fail = await login({ username: 'mike', password: 'wrong' }, ip)
      expect(fail.status).toBe(401)
    }
    const ok = await login({ username: 'mike', password: 'correct-horse' }, ip)
    expect(ok.status).toBe(200)
    const failAgain = await login({ username: 'mike', password: 'wrong' }, ip)
    expect(failAgain.status).toBe(401)
  })

  it('does not put the JWT in the login JSON body (cookie only)', async () => {
    const res = await login({ username: 'mike', password: 'correct-horse' })
    const json = await res.json() as Record<string, unknown>
    expect(json.token).toBeUndefined()
    expect(json.user).toBeTruthy()
  })
})

describe('POST /api/auth/token', () => {
  async function token(body: object) {
    return fetch(`${baseUrl}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('returns a Bearer JWT in JSON and does not set a cookie', async () => {
    const res = await token({ username: 'mike', password: 'correct-horse' })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).not.toMatch(/token=/)
    const json = await res.json() as { token: string; token_type: string; expires_in: number; user: { username: string } }
    expect(json.token_type).toBe('Bearer')
    expect(json.token.split('.')).toHaveLength(3)
    expect(json.expires_in).toBe(7 * 24 * 60 * 60)
    expect(json.user.username).toBe('mike')
  })

  it('the token authenticates GET /api/auth/me', async () => {
    const issued = await token({ username: 'mike', password: 'correct-horse' })
    const { token: jwt } = await issued.json() as { token: string }
    const me = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${jwt}` },
    })
    expect(me.status).toBe(200)
    const user = await me.json() as { username: string }
    expect(user.username).toBe('mike')
  })

  it('rejects bad credentials with 401', async () => {
    const res = await token({ username: 'mike', password: 'nope' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid credentials' })
  })
})
