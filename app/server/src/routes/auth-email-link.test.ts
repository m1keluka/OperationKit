/**
 * Rate limits on the pre-auth email sign-in link routes (CodeQL
 * js/missing-rate-limiting, public sync PR #81). The routes are reachable
 * without a session, so they must not let anyone use this install's sender to
 * flood an inbox, enumerate addresses, or brute-force link tokens.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'

const TMP_DB = path.join(os.tmpdir(), `cc-email-link-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-email-link-xx'

const sent: string[] = []
vi.mock('../services/mailer/config.js', () => ({ emailConfigured: () => true }))
vi.mock('../services/mailer/account-emails.js', () => ({
  sendSignInLink: async (o: { to: string }) => { sent.push(o.to); return { ok: true, provider: 'test' } },
}))

const { initDb, getDb } = await import('../db/index.js')
const { default: router, MAX_PER_IP, MAX_PER_EMAIL, MAX_REDEEM_PER_IP, resetEmailLinkRateLimit } = await import('./auth-email-link.js')

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)')
    .run('ada', 'x', 'member', 'ada@example.test')
  const app = express()
  app.set('trust proxy', true) // lets each test pick its client IP via X-Forwarded-For
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/auth/email-link', router)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
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

beforeEach(() => { resetEmailLinkRateLimit(); sent.length = 0 })

function post(p: string, body: object, ip: string) {
  return fetch(`${baseUrl}/api/auth/email-link${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  })
}
const tick = () => new Promise(r => setTimeout(r, 20))

describe('POST /api/auth/email-link — per-IP limit', () => {
  it(`allows ${MAX_PER_IP} requests from one IP, then answers the next with 429 + Retry-After`, async () => {
    for (let i = 0; i < MAX_PER_IP; i++) {
      const r = await post('/', { email: `nobody${i}@example.test` }, '203.0.113.7')
      expect(r.status).toBe(202)
    }
    const over = await post('/', { email: 'nobody-x@example.test' }, '203.0.113.7')
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  it('keys on the client IP: a different IP is not blocked by the first', async () => {
    for (let i = 0; i <= MAX_PER_IP; i++) await post('/', { email: 'a@example.test' }, '203.0.113.8')
    expect((await post('/', { email: 'a@example.test' }, '203.0.113.9')).status).toBe(202)
  })
})

describe('POST /api/auth/email-link — per-email limit', () => {
  it(`sends at most ${MAX_PER_EMAIL} links to one address, even from many IPs, without revealing it`, async () => {
    for (let i = 0; i < MAX_PER_EMAIL + 2; i++) {
      const r = await post('/', { email: 'ADA@example.test' }, `198.51.100.${i + 1}`)
      // Same 202 every time: the limit must not become an account-existence oracle.
      expect(r.status).toBe(202)
    }
    await tick()
    expect(sent).toHaveLength(MAX_PER_EMAIL)
    expect(new Set(sent)).toEqual(new Set(['ada@example.test']))
  })

  it('an unknown address gets the same 202 and nothing is sent', async () => {
    expect((await post('/', { email: 'ghost@example.test' }, '198.51.100.200')).status).toBe(202)
    await tick()
    expect(sent).toHaveLength(0)
  })
})

describe('POST /api/auth/email-link/redeem — per-IP limit', () => {
  it(`allows ${MAX_REDEEM_PER_IP} token attempts per IP, then 429`, async () => {
    const bogus = 'A'.repeat(43)
    for (let i = 0; i < MAX_REDEEM_PER_IP; i++) {
      expect((await post('/redeem', { token: bogus }, '192.0.2.10')).status).toBe(401)
    }
    const over = await post('/redeem', { token: bogus }, '192.0.2.10')
    expect(over.status).toBe(429)
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await post('/redeem', { token: bogus }, '192.0.2.11')).status).toBe(401)
  })
})

describe('CodeQL suppressions are justified, not bare', () => {
  it('every codeql[js/missing-rate-limiting] comment carries a reason and sits on a limited route', () => {
    const src = fs.readFileSync(new URL('./auth-email-link.ts', import.meta.url), 'utf8')
    const lines = src.split('\n')
    const marks = lines.map((l, i) => [l, i] as const).filter(([l]) => /codeql\[js\/missing-rate-limiting\]/.test(l))
    expect(marks).toHaveLength(2)
    for (const [l, i] of marks) {
      expect(l).toMatch(/\]\s+--\s+\S+/)
      expect(lines[i + 1]).toMatch(/^router\.post\(/)
    }
  })
})
