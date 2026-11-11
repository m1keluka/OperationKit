/**
 * obj 719935 — a one-time setup password must be replaced before anything else
 * works, must expire, and the replacement must drop the restriction at once.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcrypt'
import { resetLoginRateLimit } from '../middleware/login-rate-limit.js'

const TMP_DB = path.join(os.tmpdir(), `cc-auth-forced-pw-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-forced-password-xx'

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter, newPasswordProblem } = await import('./auth.js')
const { requireAuth } = await import('../middleware/auth.js')
const { runBootstrap, validateBootstrapInput } = await import('../scripts/install-bootstrap.js')
const { parseVerifyUserInput, runVerifyUser } = await import('../scripts/install-verify-user.js')

let server: http.Server
let baseUrl: string
const SETUP = 'one-time-setup-pass-123'

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  await runBootstrap(validateBootstrapInput({
    client_slug: 'example-capital', client_name: 'Example Capital', admin_username: 'admin',
    setup_password: SETUP, agents: ['general', 'coo'],
  }), () => {})
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/auth', authRouter)
  app.get('/api/objectives', requireAuth, (_req, res) => { res.json([]) })
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

beforeEach(() => resetLoginRateLimit())

function post(p: string, body: object, cookie = '') {
  return fetch(`${baseUrl}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  })
}
const cookieOf = (res: Response) => (res.headers.get('set-cookie') || '').split(';')[0]

describe('install bootstrap', () => {
  it('creates the workspace, the admin with must_change_password, and archives the rest', () => {
    const db = getDb()
    const u = db.prepare('SELECT role, must_change_password, password_setup_expires_at FROM users WHERE username = ?').get('admin') as
      { role: string; must_change_password: number; password_setup_expires_at: string }
    expect(u.role).toBe('admin')
    expect(u.must_change_password).toBe(1)
    expect(Date.parse(u.password_setup_expires_at)).toBeGreaterThan(Date.now())
    const visible = db.prepare('SELECT slug FROM workspaces WHERE archived = 0').all() as Array<{ slug: string }>
    expect(visible.map(w => w.slug)).toEqual(['example-capital'])
    const agents = db.prepare('SELECT slug FROM agents WHERE archived = 0 ORDER BY slug').all() as Array<{ slug: string }>
    expect(agents.map(a => a.slug)).toEqual(['coo', 'general'])
  })

  it('rejects a short setup password and bad slugs', () => {
    expect(() => validateBootstrapInput({ client_slug: 'x', client_name: 'X', admin_username: 'admin', setup_password: 'a'.repeat(20) })).toThrow()
    expect(() => validateBootstrapInput({ client_slug: 'abc', client_name: 'X', admin_username: 'admin', setup_password: 'short' })).toThrow()
  })

  it('re-running without reset leaves the password alone', async () => {
    const before = (getDb().prepare('SELECT password_hash FROM users WHERE username = ?').get('admin') as { password_hash: string }).password_hash
    await runBootstrap(validateBootstrapInput({ client_slug: 'example-capital', client_name: 'Example Capital', admin_username: 'admin', setup_password: 'another-setup-password-9' }), () => {})
    const after = (getDb().prepare('SELECT password_hash FROM users WHERE username = ?').get('admin') as { password_hash: string }).password_hash
    expect(after).toBe(before)
  })
})

describe('forced password change', () => {
  it('signs in with the setup password but flags must_change_password', async () => {
    const res = await post('/api/auth/login', { username: 'admin', password: SETUP })
    expect(res.status).toBe(200)
    expect((await res.json()).user.must_change_password).toBe(true)
  })

  it('blocks every other route for the setup session', async () => {
    const cookie = cookieOf(await post('/api/auth/login', { username: 'admin', password: SETUP }))
    const res = await fetch(`${baseUrl}/api/objectives`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('password_change_required')
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    expect((await me.json()).must_change_password).toBe(true)
  })

  it('refuses a bearer token for a setup-password account', async () => {
    const res = await post('/api/auth/token', { username: 'admin', password: SETUP })
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('password_change_required')
  })

  it('rejects weak or wrong change requests', async () => {
    const cookie = cookieOf(await post('/api/auth/login', { username: 'admin', password: SETUP }))
    expect((await post('/api/auth/change-password', { current_password: 'nope', new_password: 'a-good-long-password' }, cookie)).status).toBe(400)
    expect((await post('/api/auth/change-password', { current_password: SETUP, new_password: 'short' }, cookie)).status).toBe(400)
    expect(newPasswordProblem('admin-is-my-password', 'admin')).toMatch(/username/)
    expect(newPasswordProblem('aaaaaaaaaaaaaa', 'bob')).toMatch(/repeated/)
  })

  it('a successful change clears the flag, unlocks the app, and kills the setup password', async () => {
    const cookie = cookieOf(await post('/api/auth/login', { username: 'admin', password: SETUP }))
    const res = await post('/api/auth/change-password', { current_password: SETUP, new_password: 'a-good-long-password' }, cookie)
    expect(res.status).toBe(200)
    expect((await res.json()).user.must_change_password).toBeUndefined()
    const fresh = cookieOf(res)
    expect((await fetch(`${baseUrl}/api/objectives`, { headers: { Cookie: fresh } })).status).toBe(200)
    // The old setup-session cookie fails closed instead of turning into a full session.
    expect((await fetch(`${baseUrl}/api/objectives`, { headers: { Cookie: cookie } })).status).toBe(401)
    expect((await post('/api/auth/login', { username: 'admin', password: SETUP })).status).toBe(401)
    expect((await post('/api/auth/login', { username: 'admin', password: 'a-good-long-password' })).status).toBe(200)
  })

  it('an expired setup password no longer signs in', async () => {
    await runBootstrap(validateBootstrapInput({ client_slug: 'example-capital', client_name: 'Example Capital', admin_username: 'admin', setup_password: 'expired-setup-pass-0001', reset: true }), () => {})
    getDb().prepare("UPDATE users SET password_setup_expires_at = '2000-01-01T00:00:00.000Z' WHERE username = 'admin'").run()
    const res = await post('/api/auth/login', { username: 'admin', password: 'expired-setup-pass-0001' })
    expect(res.status).toBe(401)
    expect((await res.json()).error).toMatch(/expired/)
  })
})

describe('install verify user', () => {
  it('only touches ok-verify* accounts', () => {
    expect(() => parseVerifyUserInput({ action: 'remove', username: 'admin' })).toThrow()
    expect(() => parseVerifyUserInput({ action: 'create', username: 'ok-verify', password: 'short', workspace: 'x' })).toThrow()
  })

  it('creates a signed-in-able admin and removes it again', async () => {
    await runVerifyUser(parseVerifyUserInput({ action: 'create', username: 'ok-verify', password: 'v'.repeat(8) + '-verify-pass-123', workspace: 'example-capital' }), () => {})
    const res = await post('/api/auth/token', { username: 'ok-verify', password: 'v'.repeat(8) + '-verify-pass-123' })
    expect(res.status).toBe(200)
    await runVerifyUser(parseVerifyUserInput({ action: 'remove', username: 'ok-verify' }), () => {})
    expect(getDb().prepare('SELECT 1 FROM users WHERE username = ?').get('ok-verify')).toBeUndefined()
  })
})
