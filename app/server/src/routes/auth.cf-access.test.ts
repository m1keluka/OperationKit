import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'

// obj 720332: one login behind Cloudflare Access.
const TMP_DB = path.join(os.tmpdir(), `cc-auth-cfa-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-auth-cf-access-xx'

const TEAM = 'acme.cloudflareaccess.com'
const AUD = 'aud-tag-route-test'
const ISS = `https://${TEAM}`

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('./auth.js')
const { default: adminUsersRouter } = await import('./admin-users.js')
const { runBootstrap, validateBootstrapInput } = await import('../scripts/install-bootstrap.js')
const { CfAccessVerifier, cfAccessConfig, setCfAccessVerifierForTests } = await import('../lib/cf-access.js')

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const certs = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] }

function token(claims: object = {}, opts: jwt.SignOptions = {}, key = privateKey) {
  return jwt.sign({ email: 'alex.partner@example-capital.com', ...claims }, key, {
    algorithm: 'RS256', keyid: 'k1', audience: [AUD], issuer: ISS, expiresIn: 600, ...opts,
  })
}

function enable() {
  process.env.OK_CF_ACCESS_TEAM = TEAM
  process.env.OK_CF_ACCESS_AUD = AUD
  const cfg = cfAccessConfig()!
  setCfAccessVerifierForTests(new CfAccessVerifier(cfg, async () => ({ ok: true, status: 200, json: async () => certs })))
}
function disable() {
  delete process.env.OK_CF_ACCESS_TEAM
  delete process.env.OK_CF_ACCESS_AUD
  setCfAccessVerifierForTests(null)
}

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const hash = bcrypt.hashSync('correct-horse-battery', 4)
  const db = getDb()
  db.prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)')
    .run('admin', hash, 'admin', 'Alex.Partner@example-capital.com')
  // A first admin still holding the installer's one-time setup password.
  db.prepare(`INSERT INTO users (username, password_hash, role, email, must_change_password, password_setup_expires_at)
              VALUES (?, ?, 'admin', ?, 1, ?)`)
    .run('fresh', hash, 'fresh@example-capital.com', new Date(Date.now() + 3600_000).toISOString())
  db.prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)').run('dup1', hash, 'member', 'dup@example.com')
  db.prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)').run('dup2', hash, 'member', 'DUP@example.com')

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/auth', authRouter)
  app.use('/api/admin/users', adminUsersRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  disable()
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${TMP_DB}${s}`)) fs.unlinkSync(`${TMP_DB}${s}`)
})

afterEach(() => disable())

function cfSignIn(assertion?: string) {
  return fetch(`${baseUrl}/api/auth/cloudflare-access`, {
    method: 'POST',
    headers: assertion ? { 'Cf-Access-Jwt-Assertion': assertion } : {},
  })
}
function sessionCookie(res: Response): string | null {
  const c = res.headers.get('set-cookie') || ''
  const m = c.match(/(?:^|,\s*)token=([^;]+)/)
  return m && m[1] ? `token=${m[1]}` : null
}

describe('POST /api/auth/cloudflare-access', () => {
  it('feature off when the env is unset: 404, no cookie, even with a valid token', async () => {
    const res = await cfSignIn(token())
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('cf_access_off')
    expect(sessionCookie(res)).toBeNull()
  })

  it('valid token for a known email signs in and the session works', async () => {
    enable()
    const res = await cfSignIn(token())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.username).toBe('admin')
    expect(body.via).toBe('cloudflare_access')
    const cookie = sessionCookie(res)
    expect(cookie).toBeTruthy()
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/i)
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: cookie! } })
    expect(me.status).toBe(200)
    expect((await me.json()).username).toBe('admin')
  })

  it.each([
    ['bad signature', () => token({}, {}, other.privateKey), 'bad_signature'],
    ['wrong AUD', () => token({}, { audience: ['someone-elses-app'] }), 'wrong_audience'],
    ['wrong issuer', () => token({}, { issuer: 'https://evil.cloudflareaccess.com' }), 'wrong_issuer'],
    ['expired', () => {
      const old = Math.floor(Date.now() / 1000) - 7200
      return jwt.sign({ email: 'alex.partner@example-capital.com', iat: old, exp: old + 60 }, privateKey,
        { algorithm: 'RS256', keyid: 'k1', audience: [AUD], issuer: ISS })
    }, 'expired'],
    ['garbage header', () => 'eyJhbGciOiJub25lIn0.e30.', 'malformed'],
  ])('%s is rejected with no cookie', async (_label, make, reason) => {
    enable()
    const res = await cfSignIn(make())
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('cf_access_invalid')
    expect(body.reason).toBe(reason)
    expect(sessionCookie(res)).toBeNull()
  })

  it('missing header: 401 so the client shows the password page', async () => {
    enable()
    const res = await cfSignIn()
    expect(res.status).toBe(401)
    expect((await res.json()).code).toBe('cf_access_missing')
  })

  it('verified email with no matching user: 403 no_account, nothing created', async () => {
    enable()
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
    const res = await cfSignIn(token({ email: 'stranger@example-capital.com' }))
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('no_account')
    expect(body.email).toBe('stranger@example-capital.com')
    expect(body.logout_url).toBe('/cdn-cgi/access/logout')
    expect(sessionCookie(res)).toBeNull()
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(before)
  })

  it('two users on one email: refused, neither wins', async () => {
    enable()
    const res = await cfSignIn(token({ email: 'dup@example.com' }))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('ambiguous_account')
  })

  it('a Cloudflare sign-in is not held on the setup-password page', async () => {
    enable()
    const res = await cfSignIn(token({ email: 'fresh@example-capital.com' }))
    expect(res.status).toBe(200)
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: sessionCookie(res)! } })
    expect(me.status).toBe(200)
    expect((await me.json()).must_change_password).toBeUndefined()
  })
})

describe('password login stays as the break-glass path', () => {
  it('works with the feature on', async () => {
    enable()
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }),
    })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/auth/logout', () => {
  it('points at the Access logout when the feature is on', async () => {
    enable()
    const res = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' })
    expect(await res.json()).toEqual({ ok: true, access_logout_url: '/cdn-cgi/access/logout' })
    expect(res.headers.get('set-cookie')).toMatch(/token=;/)
  })
  it('is unchanged when the feature is off', async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' })
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('installer links the first admin to the Access email', () => {
  const base = { client_slug: 'example-capital', client_name: 'Example Capital', setup_password: 'a-long-setup-password-01' }
  it('sets users.email (lower-cased) so the Access email signs that admin in', async () => {
    await runBootstrap(validateBootstrapInput({ ...base, admin_username: 'boss', admin_email: 'Boss@Example-Capital.com' }), () => {})
    expect((getDb().prepare("SELECT email FROM users WHERE username = 'boss'").get() as { email: string }).email)
      .toBe('boss@example-capital.com')
    enable()
    const res = await cfSignIn(token({ email: 'boss@example-capital.com' }))
    expect(res.status).toBe(200)
    expect((await res.json()).user.username).toBe('boss')
  })
  it('refuses to steal an email another user already has', async () => {
    const lines: string[] = []
    await runBootstrap(validateBootstrapInput({ ...base, admin_username: 'boss2', admin_email: 'alex.partner@example-capital.com' }), l => lines.push(l))
    expect(lines.join('\n')).toMatch(/NOT linked/)
    expect((getDb().prepare("SELECT email FROM users WHERE username = 'boss2'").get() as { email: string | null }).email).toBeNull()
  })
  it('rejects a malformed email', () => {
    expect(() => validateBootstrapInput({ ...base, admin_username: 'x1', admin_email: 'not-an-email' })).toThrow(/admin_email/)
  })
})

describe('admins can link any user to a sign-in email', () => {
  async function adminCookie() {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'correct-horse-battery' }),
    })
    return sessionCookie(res)!
  }
  const patch = async (cookie: string, id: number, body: object) => fetch(`${baseUrl}/api/admin/users/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify(body),
  })

  it('creates a user with an email, then that email signs them in', async () => {
    const cookie = await adminCookie()
    const res = await fetch(`${baseUrl}/api/admin/users`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ username: 'teammate', password: 'temp-pass-123', email: 'Team.Mate@Example-Capital.com' }),
    })
    expect(res.status).toBe(201)
    expect((await res.json()).email).toBe('team.mate@example-capital.com')
    enable()
    const signIn = await cfSignIn(token({ email: 'team.mate@example-capital.com' }))
    expect((await signIn.json()).user.username).toBe('teammate')
  })

  it('PATCH sets, rejects duplicates and bad values, and clears', async () => {
    const cookie = await adminCookie()
    const id = (getDb().prepare("SELECT id FROM users WHERE username = 'dup1'").get() as { id: number }).id
    expect((await patch(cookie, id, { email: 'ALEX.partner@example-capital.com' })).status).toBe(409)
    expect((await patch(cookie, id, { email: 'nope' })).status).toBe(400)
    expect((await patch(cookie, id, {})).status).toBe(400)
    const ok = await patch(cookie, id, { email: 'only-dup1@example.com' })
    expect(ok.status).toBe(200)
    expect((await ok.json()).email).toBe('only-dup1@example.com')
    const cleared = await patch(cookie, id, { email: null })
    expect((await cleared.json()).email).toBeNull()
    expect((await patch(cookie, id, { role: 'member' })).status).toBe(200)
  })
})
