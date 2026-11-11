/**
 * obj 900497 — Settings → Email API, invite/temp-password emails, email
 * sign-in links and the onboarding checklist, end to end against an in-process
 * SMTP sink. No real email leaves the test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcrypt'
import { startSmtpSink, decodeParts, type SmtpSink } from '../services/mailer/smtp-sink.testkit.js'

// Sprint 3's branding checks (isCustomized / findLogo) read a single
// repo-relative config/branding.json + a DB_PATH-derived logo dir. Both are
// mutable global state that other suites (branding.test.ts) also write to
// concurrently under vitest's fork pool, so asserting the real value here is
// racy by construction — this suite only cares about the branding step's
// *ordering and ticking logic*, not branding.ts's own detection, which has its
// own tests. Stub both to a fixed "not customized" value for determinism.
vi.mock('../services/branding-config.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/branding-config.js')>()),
  isCustomized: () => false,
}))
vi.mock('./branding.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./branding.js')>()),
  findLogo: () => null,
}))

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.JWT_SECRET = 'test-secret-admin-email-xx'
const TMP_DB = path.join(os.tmpdir(), `cc-admin-email-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: adminRouter } = await import('./admin.js')
const { default: usersRouter } = await import('./admin-users.js')
const { default: authRouter } = await import('./auth.js')
const { resetEmailLinkRateLimit } = await import('./auth-email-link.js')

let server: http.Server
let base: string
let sink: SmtpSink
let adminId: number

const ADMIN_COOKIE = () => `token=${jwt.sign({ id: adminId, username: 'owner', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function call(method: string, url: string, body?: unknown, cookie = ADMIN_COOKIE()) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers }
}

async function waitForMessages(n: number) {
  for (let i = 0; i < 100 && sink.messages.length < n; i++) await new Promise(r => setTimeout(r, 20))
}

function configureSmtp(extra: Record<string, unknown> = {}) {
  return call('PUT', '/api/admin/email', {
    provider: 'smtp', from_name: 'Acme Ops', from_address: 'no-reply@acme.test', reply_to: '',
    app_url: 'https://ops.acme.test/', smtp: { host: '127.0.0.1', port: sink.port, security: 'none', username: 'mailer' },
    credential: 'smtp-pass-123', ...extra,
  })
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  adminId = Number(getDb().prepare("INSERT INTO users (username, password_hash, role, email) VALUES ('owner', ?, 'admin', 'owner@acme.test')").run(bcrypt.hashSync('x', 4)).lastInsertRowid)
  sink = await startSmtpSink()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/auth', authRouter)
  app.use('/api/admin/users', usersRouter)
  app.use('/api/admin', adminRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await sink.close()
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${TMP_DB}${s}`)) fs.unlinkSync(`${TMP_DB}${s}`)
})

beforeEach(() => { resetEmailLinkRateLimit() })

describe('when email is NOT configured', () => {
  it('reports what is missing and the sign-in-link option is hidden', async () => {
    const r = await call('GET', '/api/admin/email')
    expect(r.status).toBe(200)
    expect(r.json.configured).toBe(false)
    expect(r.json.problems).toEqual(['Pick an email provider'])
    const avail = await call('GET', '/api/auth/email-link', undefined, '')
    expect(avail.json).toEqual({ available: false })
    expect((await call('POST', '/api/auth/email-link', { email: 'owner@acme.test' }, '')).status).toBe(409)
  })

  it('creating a user with send_email falls back (not sent) and still creates the user', async () => {
    const r = await call('POST', '/api/admin/users', { username: 'early', password: 'Temp-Pass-0001', email: 'early@acme.test', send_email: true })
    expect(r.status).toBe(201)
    expect(r.json.invite_email).toMatchObject({ sent: false, not_configured: true })
    expect(sink.messages).toHaveLength(0)
    const row = getDb().prepare("SELECT must_change_password FROM users WHERE username='early'").get() as { must_change_password: number }
    expect(Number(row.must_change_password)).toBe(0)
  })

  it('setup checklist: nothing done yet, in branding → email → models order', async () => {
    const r = await call('GET', '/api/admin/setup-status')
    expect(r.json.steps.map((s: { id: string }) => s.id)).toEqual(['branding', 'email', 'models'])
    expect(r.json.steps.map((s: { done: boolean }) => s.done)).toEqual([false, false, false])
  })

  it('is admin-only', async () => {
    const member = `token=${jwt.sign({ id: 999, username: 'm', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
    expect((await call('GET', '/api/admin/email', undefined, member)).status).toBe(403)
    expect((await call('GET', '/api/admin/email', undefined, '')).status).toBe(401)
  })
})

describe('configuring SMTP', () => {
  it('validates input', async () => {
    expect((await call('PUT', '/api/admin/email', { provider: 'sendgrid' })).status).toBe(400)
    expect((await call('PUT', '/api/admin/email', { provider: 'smtp', from_address: 'not-an-email' })).json.field).toBe('from_address')
    expect((await call('PUT', '/api/admin/email', { provider: 'smtp', from_address: 'a@acme.test', app_url: 'javascript:x' })).json.field).toBe('app_url')
  })

  it('stores the credential in the secrets store as service-only and never returns it', async () => {
    const r = await configureSmtp()
    expect(r.status).toBe(200)
    expect(r.text).not.toContain('smtp-pass-123')
    expect(r.json.configured).toBe(true)
    expect(r.json.app_url).toBe('https://ops.acme.test')
    expect(r.json.has_credential.smtp).toBe(true)
    const row = getDb().prepare("SELECT service_only, value_encrypted FROM secrets WHERE key = 'CC_EMAIL_SMTP_PASSWORD' AND scope_type = 'global'").get() as { service_only: number; value_encrypted: string }
    expect(Number(row.service_only)).toBe(1)
    expect(row.value_encrypted).not.toContain('smtp-pass-123')
    const settings = getDb().prepare("SELECT value FROM settings WHERE key = 'email_config'").get() as { value: string }
    expect(settings.value).not.toContain('smtp-pass-123')
    const get = await call('GET', '/api/admin/email')
    expect(get.text).not.toContain('smtp-pass-123')
  })

  it('sends a test email and records the result (checklist step 2 ticks)', async () => {
    const before = sink.messages.length
    const r = await call('POST', '/api/admin/email/test', { to: 'owner@acme.test' })
    expect(r.status).toBe(200)
    expect(r.json.last_test).toMatchObject({ ok: true, to_domain: 'acme.test' })
    expect(sink.messages).toHaveLength(before + 1)
    expect(sink.messages.at(-1)!.auth).toEqual({ user: 'mailer', pass: 'smtp-pass-123' })
    const status = await call('GET', '/api/admin/setup-status')
    expect(status.json.steps[1]).toMatchObject({ id: 'email', done: true })
  })

  it('changing the sender clears the last test until re-tested', async () => {
    const r = await configureSmtp({ from_address: 'hello@acme.test', credential: '' })
    expect(r.json.last_test).toBeNull()
    expect(r.json.has_credential.smtp).toBe(true)
    await call('POST', '/api/admin/email/test', { to: 'owner@acme.test' })
  })

  it('a failed send is reported with a readable error and recorded', async () => {
    const r = await call('PUT', '/api/admin/email', { provider: 'smtp', from_address: 'hello@acme.test', app_url: 'https://ops.acme.test', smtp: { host: '127.0.0.1', port: 1, security: 'none', username: '' } })
    expect(r.json.configured).toBe(true)
    const t = await call('POST', '/api/admin/email/test', { to: 'owner@acme.test' })
    expect(t.status).toBe(502)
    expect(t.json.error).toMatch(/Could not connect/)
    expect(t.json.last_test.ok).toBe(false)
    await configureSmtp({ credential: '' })
    await call('POST', '/api/admin/email/test', { to: 'owner@acme.test' })
  })

  it('serves DNS help for the from domain', async () => {
    const r = await call('GET', '/api/admin/email/dns?provider=postmark&domain=acme.test')
    expect(r.status).toBe(200)
    expect(r.json.records.some((x: { purpose: string }) => x.purpose === 'DKIM')).toBe(true)
    expect(r.json.check.domain).toBe('acme.test')
  })
})

describe('account emails once configured', () => {
  it('invite: emails sign-in URL + temp password and forces a password change', async () => {
    const before = sink.messages.length
    const r = await call('POST', '/api/admin/users', { username: 'jane', password: 'Temp-Pass-1234', email: 'Jane@Example.com', send_email: true })
    expect(r.status).toBe(201)
    expect(r.json.invite_email).toEqual({ sent: true })
    expect(sink.messages).toHaveLength(before + 1)
    const msg = sink.messages.at(-1)!
    expect(msg.to).toEqual(['jane@example.com'])
    const { text, html } = decodeParts(msg.data)
    expect(text).toContain('https://ops.acme.test/login')
    expect(text).toContain('Username: jane')
    expect(text).toContain('Temporary password: Temp-Pass-1234')
    expect(html).toContain('Temp-Pass-1234')
    const row = getDb().prepare("SELECT must_change_password FROM users WHERE username='jane'").get() as { must_change_password: number }
    expect(Number(row.must_change_password)).toBe(1)
  })

  it('without send_email nothing is emailed (today\'s behaviour)', async () => {
    const before = sink.messages.length
    const r = await call('POST', '/api/admin/users', { username: 'quiet', password: 'Temp-Pass-5678', email: 'quiet@acme.test' })
    expect(r.status).toBe(201)
    expect(r.json.invite_email).toEqual({ sent: false })
    expect(sink.messages).toHaveLength(before)
  })

  it('temp password reset: emailed to the user', async () => {
    const id = (getDb().prepare("SELECT id FROM users WHERE username='quiet'").get() as { id: number }).id
    const before = sink.messages.length
    const r = await call('POST', `/api/admin/users/${id}/reset-password`, { password: 'Reset-Pass-9999', send_email: true })
    expect(r.json).toEqual({ ok: true, temp_password_email: { sent: true } })
    expect(sink.messages).toHaveLength(before + 1)
    expect(decodeParts(sink.messages.at(-1)!.data).text).toContain('Temporary password: Reset-Pass-9999')
  })

  it('temp password reset for a user without email falls back', async () => {
    getDb().prepare("INSERT INTO users (username, password_hash, role) VALUES ('noemail', 'x', 'member')").run()
    const id = (getDb().prepare("SELECT id FROM users WHERE username='noemail'").get() as { id: number }).id
    const r = await call('POST', `/api/admin/users/${id}/reset-password`, { password: 'Reset-Pass-0000', send_email: true })
    expect(r.json.temp_password_email).toMatchObject({ sent: false })
  })
})

describe('email sign-in link', () => {
  it('is offered once email is configured', async () => {
    expect((await call('GET', '/api/auth/email-link', undefined, '')).json).toEqual({ available: true })
  })

  it('emails a single-use link that signs the person in', async () => {
    const before = sink.messages.length
    const r = await call('POST', '/api/auth/email-link', { email: 'OWNER@acme.test' }, '')
    expect(r.status).toBe(202)
    await waitForMessages(before + 1)
    const { text } = decodeParts(sink.messages.at(-1)!.data)
    const m = /https:\/\/ops\.acme\.test\/login\?link=([A-Za-z0-9_-]+)/.exec(text)
    expect(m).not.toBeNull()
    const token = m![1]
    // DB holds only the hash.
    const stored = getDb().prepare('SELECT token_hash FROM email_login_tokens ORDER BY id DESC LIMIT 1').get() as { token_hash: string }
    expect(stored.token_hash).not.toBe(token)
    const redeem = await call('POST', '/api/auth/email-link/redeem', { token }, '')
    expect(redeem.status).toBe(200)
    expect(redeem.json.user.username).toBe('owner')
    expect(redeem.headers.get('set-cookie')).toMatch(/token=.+HttpOnly/i)
    const again = await call('POST', '/api/auth/email-link/redeem', { token }, '')
    expect(again.status).toBe(401)
  })

  it('answers the same for an unknown address and sends nothing', async () => {
    const before = sink.messages.length
    const r = await call('POST', '/api/auth/email-link', { email: 'nobody@acme.test' }, '')
    expect(r.status).toBe(202)
    await new Promise(res => setTimeout(res, 150))
    expect(sink.messages).toHaveLength(before)
  })

  it('is not issued to an account that must still change its temp password', async () => {
    const before = sink.messages.length
    await call('POST', '/api/auth/email-link', { email: 'jane@example.com' }, '')
    await new Promise(res => setTimeout(res, 150))
    expect(sink.messages).toHaveLength(before)
  })

  it('rejects expired and malformed tokens', async () => {
    expect((await call('POST', '/api/auth/email-link/redeem', { token: 'short' }, '')).status).toBe(401)
    const { hashLinkToken } = await import('./auth-email-link.js')
    getDb().prepare("INSERT INTO email_login_tokens (user_id, token_hash, expires_at) VALUES (?, ?, datetime('now', '-1 minute'))").run(adminId, hashLinkToken('expired-token-aaaaaaaaaaaaaaaa'))
    expect((await call('POST', '/api/auth/email-link/redeem', { token: 'expired-token-aaaaaaaaaaaaaaaa' }, '')).status).toBe(401)
  })
})

describe('onboarding checklist', () => {
  it('branding can be accepted as-is; models stays open with no coding account', async () => {
    const r = await call('POST', '/api/admin/setup/branding', { done: true })
    expect(r.json.steps.map((s: { done: boolean }) => s.done)).toEqual([true, true, false])
    expect(r.json.complete).toBe(false)
  })

  it('turning email off clears credentials and unticks the step', async () => {
    const r = await call('DELETE', '/api/admin/email')
    expect(r.json.provider).toBeNull()
    expect(r.json.has_credential.smtp).toBe(false)
    const s = await call('GET', '/api/admin/setup-status')
    expect(s.json.steps[1].done).toBe(false)
  })
})
