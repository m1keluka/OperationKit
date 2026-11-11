/**
 * obj 900108 — an install that signs people in at the Cloudflare Access door
 * must never ask them to set or change a password.
 *
 * Cloudflare verifies the person; they have never had a password. Three things
 * used to ask for one anyway, and each is covered here:
 *   1. a session cookie minted earlier from the one-time setup password (`pwc`)
 *   2. the `users.must_change_password` row, which only POST /change-password
 *      ever clears — it blocked API keys and the websocket forever
 *   3. the installer, which set that row even when Access is the sign-in
 *
 * The other half matters just as much: nothing here may let anyone IN. Every
 * bad assertion (wrong signature, expired, wrong AUD, wrong issuer, an email
 * that belongs to nobody, to somebody else, or to two users) must leave the
 * old prompt exactly where it was, and an install with no Access configured
 * must behave as it always did.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-cfa-no-pw-prompt-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-cfa-no-password-prompt'

const TEAM = 'acme.cloudflareaccess.com'
const AUD = 'aud-tag-no-password-prompt'
const ISS = `https://${TEAM}`

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('./auth.js')
const { requireAuth } = await import('../middleware/auth.js')
const { issueApiKey } = await import('../lib/api-keys.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { authorizeUpgrade } = await import('../ws/upgrade-auth.js')
const { runBootstrap, validateBootstrapInput } = await import('../scripts/install-bootstrap.js')
const { CfAccessVerifier, cfAccessConfig, setCfAccessVerifierForTests } = await import('../lib/cf-access.js')
const { resetLoginRateLimit } = await import('../middleware/login-rate-limit.js')

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const imposter = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const certs = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] }

const ACCESS_EMAIL = 'chris@example-client.com'
const SETUP_PASSWORD = 'one-time-setup-pass-900108'

function assertion(claims: object = {}, opts: jwt.SignOptions = {}, key = privateKey) {
  return jwt.sign({ email: ACCESS_EMAIL, ...claims }, key, {
    algorithm: 'RS256', keyid: 'k1', audience: [AUD], issuer: ISS, expiresIn: 600, ...opts,
  })
}

function accessOn() {
  process.env.OK_CF_ACCESS_TEAM = TEAM
  process.env.OK_CF_ACCESS_AUD = AUD
  setCfAccessVerifierForTests(new CfAccessVerifier(cfAccessConfig()!, async () => ({ ok: true, status: 200, json: async () => certs })))
}
function accessOff() {
  delete process.env.OK_CF_ACCESS_TEAM
  delete process.env.OK_CF_ACCESS_AUD
  setCfAccessVerifierForTests(null)
}

let server: http.Server
let baseUrl: string
/** The person Cloudflare Access verifies, still carrying the installer's flag. */
let accessUserId: number
let legacyKey: string
let agentKey: string

const CF = 'Cf-Access-Jwt-Assertion'

function get(p: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${p}`, { headers })
}
function post(p: string, body: object, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
}
const cookieOf = (res: Response) => (res.headers.get('set-cookie') || '').split(';')[0]

/** The cookie the app mints when this person uses the one-time setup password. */
async function setupPasswordCookie(): Promise<string> {
  const res = await post('/api/auth/login', { username: 'chris', password: SETUP_PASSWORD })
  expect(res.status).toBe(200)
  expect((await res.json()).user.must_change_password).toBe(true)
  return cookieOf(res)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const hash = await bcrypt.hash(SETUP_PASSWORD, 4)
  const expires = new Date(Date.now() + 72 * 3600_000).toISOString()
  const r = db.prepare(
    `INSERT INTO users (username, password_hash, role, email, must_change_password, password_setup_expires_at)
     VALUES (?, ?, 'admin', ?, 1, ?)`,
  ).run('chris', hash, ACCESS_EMAIL, expires)
  accessUserId = Number(r.lastInsertRowid)
  // A second account on another email: its assertion must never unlock chris.
  db.prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)')
    .run('someone-else', hash, 'member', 'other@example-client.com')
  // Two users share this one: ambiguous, so it identifies nobody.
  db.prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)').run('twin-a', hash, 'member', 'twins@example-client.com')
  db.prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)').run('twin-b', hash, 'member', 'Twins@example-client.com')

  legacyKey = issueApiKey(accessUserId).token
  const agent = createAgentKey({ id: accessUserId, role: 'admin' }, { label: 'board bot' })
  if (!agent.ok) throw new Error(agent.error)
  agentKey = agent.key.token

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
  accessOff()
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP_DB + s)) fs.unlinkSync(TMP_DB + s)
})

beforeEach(() => resetLoginRateLimit())
afterEach(() => accessOff())

describe('a stale setup-password cookie, with Cloudflare Access verifying the person', () => {
  it('GET /me reports no forced change and normal routes work', async () => {
    const cookie = await setupPasswordCookie()
    accessOn()
    const headers = { Cookie: cookie, [CF]: assertion() }
    const me = await get('/api/auth/me', headers)
    expect(me.status).toBe(200)
    const body = await me.json()
    expect(body.username).toBe('chris')
    expect(body.must_change_password).toBeUndefined()
    expect((await get('/api/objectives', headers)).status).toBe(200)
  })

  it('without the Access header the same cookie is still held on the password page', async () => {
    const cookie = await setupPasswordCookie()
    accessOn()
    const me = await get('/api/auth/me', { Cookie: cookie })
    expect((await me.json()).must_change_password).toBe(true)
    const blocked = await get('/api/objectives', { Cookie: cookie })
    expect(blocked.status).toBe(403)
    expect((await blocked.json()).code).toBe('password_change_required')
  })
})

describe('the must_change_password row never blocks a Cloudflare-verified person', () => {
  it('the legacy API key works with a verified assertion and is refused without one', async () => {
    accessOn()
    expect((await get('/api/objectives', { Authorization: `Bearer ${legacyKey}`, [CF]: assertion() })).status).toBe(200)
    const without = await get('/api/objectives', { Authorization: `Bearer ${legacyKey}` })
    expect(without.status).toBe(403)
    expect((await without.json()).code).toBe('password_change_required')
  })

  it('an agent key works with a verified assertion and is refused without one', async () => {
    accessOn()
    expect((await get('/api/objectives', { Authorization: `Bearer ${agentKey}`, [CF]: assertion() })).status).toBe(200)
    expect((await get('/api/objectives', { Authorization: `Bearer ${agentKey}` })).status).toBe(403)
  })

  it('the websocket upgrade is allowed with a verified assertion and refused without one', async () => {
    const cookie = await setupPasswordCookie()
    accessOn()
    const allowed = await authorizeUpgrade({ cookie, [CF.toLowerCase()]: assertion() })
    expect(allowed?.id).toBe(accessUserId)
    expect(await authorizeUpgrade({ cookie })).toBeNull()
    expect(await authorizeUpgrade({})).toBeNull()
  })
})

describe('a bad Access assertion never skips the prompt', () => {
  const cases: Array<[string, () => string]> = [
    ['signed by somebody else', () => assertion({}, {}, imposter.privateKey)],
    ['issued for another Access app (AUD)', () => assertion({}, { audience: ['another-apps-aud'] })],
    ['issued by another team (issuer)', () => assertion({}, { issuer: 'https://evil.cloudflareaccess.com' })],
    ['expired', () => {
      const old = Math.floor(Date.now() / 1000) - 7200
      return jwt.sign({ email: ACCESS_EMAIL, iat: old, exp: old + 60 }, privateKey,
        { algorithm: 'RS256', keyid: 'k1', audience: [AUD], issuer: ISS })
    }],
    ['unsigned garbage', () => 'eyJhbGciOiJub25lIn0.e30.'],
    ['a different user\'s email', () => assertion({ email: 'other@example-client.com' })],
    ['an email no user has', () => assertion({ email: 'nobody@example-client.com' })],
    ['an email two users share', () => assertion({ email: 'twins@example-client.com' })],
    ['a service token with no email', () => assertion({ email: undefined, common_name: 'robot' })],
  ]

  it.each(cases)('%s leaves the session on the change-password page', async (_label, make) => {
    const cookie = await setupPasswordCookie()
    accessOn()
    const headers = { Cookie: cookie, [CF]: make() }
    expect((await (await get('/api/auth/me', headers)).json()).must_change_password).toBe(true)
    expect((await get('/api/objectives', headers)).status).toBe(403)
    expect(await authorizeUpgrade({ cookie, [CF.toLowerCase()]: make() })).toBeNull()
  })

  it.each(cases)('%s leaves API keys blocked', async (_label, make) => {
    accessOn()
    expect((await get('/api/objectives', { Authorization: `Bearer ${legacyKey}`, [CF]: make() })).status).toBe(403)
    expect((await get('/api/objectives', { Authorization: `Bearer ${agentKey}`, [CF]: make() })).status).toBe(403)
  })
})

describe('an install with no Cloudflare Access behaves exactly as before', () => {
  it('ignores an assertion header entirely: the prompt, the 403s and the 401 all stand', async () => {
    const cookie = await setupPasswordCookie()
    // Feature off (afterEach left it off) — a perfectly valid-looking token is
    // meaningless because there is no team or AUD to verify it against.
    const token = assertion()
    const headers = { Cookie: cookie, [CF]: token }
    expect((await (await get('/api/auth/me', headers)).json()).must_change_password).toBe(true)
    expect((await get('/api/objectives', headers)).status).toBe(403)
    expect((await get('/api/objectives', { Authorization: `Bearer ${legacyKey}`, [CF]: token })).status).toBe(403)
    expect(await authorizeUpgrade({ cookie, [CF.toLowerCase()]: token })).toBeNull()
    const signIn = await post('/api/auth/cloudflare-access', {}, { [CF]: token })
    expect(signIn.status).toBe(404)
  })
})

describe('the setup password still expires', () => {
  it('stops working at its expiry even when no password change is forced', async () => {
    const db = getDb()
    const hash = await bcrypt.hash('break-glass-pass-900108', 4)
    db.prepare(
      `INSERT INTO users (username, password_hash, role, email, must_change_password, password_setup_expires_at)
       VALUES (?, ?, 'admin', ?, 0, ?)`,
    ).run('glass', hash, 'glass@example-client.com', new Date(Date.now() + 3600_000).toISOString())

    // Unexpired: the break-glass login works and is NOT held on a change page.
    const ok = await post('/api/auth/login', { username: 'glass', password: 'break-glass-pass-900108' })
    expect(ok.status).toBe(200)
    expect((await ok.json()).user.must_change_password).toBeUndefined()

    db.prepare("UPDATE users SET password_setup_expires_at = '2000-01-01T00:00:00.000Z' WHERE username = 'glass'").run()
    const expired = await post('/api/auth/login', { username: 'glass', password: 'break-glass-pass-900108' })
    expect(expired.status).toBe(401)
    expect((await expired.json()).error).toMatch(/expired/)
  })

  it('a verified Access identity does not revive an expired setup password', async () => {
    accessOn()
    const res = await post('/api/auth/login', { username: 'glass', password: 'break-glass-pass-900108' }, { [CF]: assertion({ email: 'glass@example-client.com' }) })
    expect(res.status).toBe(401)
  })
})

describe('the installer and the forced password change', () => {
  const base = { client_slug: 'example-client', client_name: 'Example Client', setup_password: 'installer-setup-pass-01' }
  const row = (username: string) => getDb()
    .prepare('SELECT must_change_password, password_setup_expires_at, email FROM users WHERE username = ?')
    .get(username) as { must_change_password: number; password_setup_expires_at: string | null; email: string | null }

  it('with one login configured the first admin is not forced to change a password, but the setup password still expires', async () => {
    await runBootstrap(validateBootstrapInput({
      ...base, admin_username: 'owner-one-login', admin_email: 'Owner@Example-Client.com', access_one_login: true,
    }), () => {})
    const u = row('owner-one-login')
    expect(u.must_change_password).toBe(0)
    expect(u.email).toBe('owner@example-client.com')
    expect(Date.parse(u.password_setup_expires_at!)).toBeGreaterThan(Date.now())
  })

  it('without one login the first admin is forced to change a password, as before', async () => {
    await runBootstrap(validateBootstrapInput({ ...base, admin_username: 'owner-password' }), () => {})
    expect(row('owner-password').must_change_password).toBe(1)
  })

  it('one login with no admin email still forces the change — there is nothing to sign in with', async () => {
    await runBootstrap(validateBootstrapInput({ ...base, admin_username: 'owner-no-email', access_one_login: true }), () => {})
    expect(row('owner-no-email').must_change_password).toBe(1)
  })

  it('one login whose email is already taken falls back to forcing the change', async () => {
    const lines: string[] = []
    await runBootstrap(validateBootstrapInput({
      ...base, admin_username: 'owner-taken', admin_email: ACCESS_EMAIL, access_one_login: true,
    }), l => lines.push(l))
    expect(lines.join('\n')).toMatch(/NOT linked/)
    const u = row('owner-taken')
    expect(u.email).toBeNull()
    expect(u.must_change_password).toBe(1)
  })

  it('a one-login admin signs in through Access with no password prompt anywhere', async () => {
    accessOn()
    const email = 'owner@example-client.com'
    const signIn = await post('/api/auth/cloudflare-access', {}, { [CF]: assertion({ email }) })
    expect(signIn.status).toBe(200)
    const cookie = cookieOf(signIn)
    const me = await get('/api/auth/me', { Cookie: cookie })
    expect((await me.json()).must_change_password).toBeUndefined()
    expect((await get('/api/objectives', { Cookie: cookie })).status).toBe(200)
  })
})
