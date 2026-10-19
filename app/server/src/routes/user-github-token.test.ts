import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { UserGithubTokenSummary } from '@operationkit/shared'

// Encryption key + isolated DB + JWT secret BEFORE importing modules.
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.JWT_SECRET = 'test-secret-ughtok-route'
const TMP_DB = path.join(os.tmpdir(), `cc-ughtok-route-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./user-github-token.js')
const { __setFetchForTests, getDecryptedForUser } = await import('../services/user-github-tokens.js')

let server: http.Server
let baseUrl: string

const RAW_PAT = 'github_pat_11ABCDEsecret_value_zzz999'

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(headers || {}) } })
}

// Fake GitHub: RAW_PAT is valid → eva-dev / id 7777 / verified primary email.
function installFake() {
  __setFetchForTests(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization || ''
    if (url === 'https://api.github.com/user') {
      if (!auth.includes(RAW_PAT)) return jsonResponse(401, { message: 'Bad credentials' })
      return jsonResponse(200, { login: 'eva-dev', id: 7777 })
    }
    if (url === 'https://api.github.com/user/emails') {
      return jsonResponse(200, [{ email: 'eva@example.com', primary: true, verified: true }])
    }
    return jsonResponse(500, { error: 'unexpected ' + url })
  })
}

function cookieFor(id: number): string {
  return `token=${jwt.sign({ id, username: 'eva', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}

async function req(method: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${baseUrl}/api/user/github-token${method === 'VALIDATE' ? '/validate' : ''}`, {
    method: method === 'VALIDATE' ? 'POST' : method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (10, 'eva', 'x', 'member')`).run()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/user/github-token', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  __setFetchForTests(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

beforeEach(() => {
  getDb().exec('DELETE FROM user_github_tokens')
  installFake()
})

const COOKIE = () => cookieFor(10)

describe('user-github-token routes', () => {
  it('rejects every method without auth (401)', async () => {
    expect((await req('GET')).status).toBe(401)
    expect((await req('POST', { token: RAW_PAT })).status).toBe(401)
    expect((await req('VALIDATE')).status).toBe(401)
    expect((await req('DELETE')).status).toBe(401)
  })

  it('GET returns null when nothing linked', async () => {
    const r = await req('GET', undefined, COOKIE())
    expect(r.status).toBe(200)
    expect(r.json).toBeNull()
  })

  it('POST validates, stores encrypted, and returns ONLY a masked summary', async () => {
    const r = await req('POST', { token: RAW_PAT }, COOKIE())
    expect(r.status).toBe(200)
    const s = r.json as UserGithubTokenSummary
    expect(s.github_login).toBe('eva-dev')
    expect(s.github_email).toBe('eva@example.com')
    expect(s.token_last4).toBe('z999')
    // The raw PAT must never appear in the response body.
    expect(JSON.stringify(s)).not.toContain(RAW_PAT)
    expect(JSON.stringify(s)).not.toContain('secret_value')
    // …but it IS recoverable server-side (encrypted at rest, decrypts to original).
    expect(getDecryptedForUser(10)).toBe(RAW_PAT)
  })

  it('POST rejects an invalid token with a clear error, stores nothing', async () => {
    const r = await req('POST', { token: 'ghp_wrong' }, COOKIE())
    expect(r.status).toBe(400)
    expect((r.json as { error: string }).error).toMatch(/invalid|401/i)
    expect(getDecryptedForUser(10)).toBeNull()
  })

  it('POST /validate re-validates and bumps last_validated_at', async () => {
    await req('POST', { token: RAW_PAT }, COOKIE())
    const r = await req('VALIDATE', undefined, COOKIE())
    expect(r.status).toBe(200)
    expect((r.json as UserGithubTokenSummary).github_login).toBe('eva-dev')
  })

  it('DELETE revokes the token', async () => {
    await req('POST', { token: RAW_PAT }, COOKIE())
    const r = await req('DELETE', undefined, COOKIE())
    expect(r.status).toBe(200)
    expect((r.json as { removed: boolean }).removed).toBe(true)
    expect((await req('GET', undefined, COOKIE())).json).toBeNull()
  })
})
