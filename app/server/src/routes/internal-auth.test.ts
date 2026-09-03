// Security tests for the internal-route shared-secret gate (audit B5 / threat T6).
//
// The three historically-unauthenticated localhost surfaces must now reject a
// request that lacks the valid X-Internal-Secret header (401), while still
// honoring the localhost origin check (defense-in-depth), and must accept a
// request carrying the correct secret.
//
// Surfaces covered:
//   1. routines CRUD            — GET  /api/internal/routines
//   2. deploy trigger           — POST /api/internal/deploy
//   3. test-credential fetch    — GET  /api/internal/test-credentials/:slug
//
// We assert auth strictly: WITHOUT the secret every surface returns 401; WITH the
// secret each gets PAST the auth gate (routines → 200; deploy with a bogus mode →
// 400 validation, never executing a real deploy; missing test-cred slug → 404).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

// Env + DB must be set BEFORE importing the routers / db (read at load time).
const SECRET = 'test-internal-secret-abc123' // gitleaks:allow — literal test fixture, not a credential
process.env.INTERNAL_API_SECRET = SECRET
const TMP_DB = path.join(os.tmpdir(), `cc-internal-auth-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')
const { default: internalRoutinesRouter } = await import('./internal-routines.js')
const { internalTestCredentialsRouter } = await import('./test-credentials.js')

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()

  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  app.use('/api/internal/routines', internalRoutinesRouter)
  app.use('/api/internal/test-credentials', internalTestCredentialsRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {/* ignore */}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('internal-routines GET /api/internal/routines', () => {
  it('rejects a request with NO secret header (401)', async () => {
    const res = await fetch(`${baseUrl}/api/internal/routines`)
    expect(res.status).toBe(401)
  })

  it('rejects a request with a WRONG secret header (401)', async () => {
    const res = await fetch(`${baseUrl}/api/internal/routines`, {
      headers: { 'X-Internal-Secret': 'not-the-secret' },
    })
    expect(res.status).toBe(401)
  })

  it('accepts a request with the CORRECT secret header (200)', async () => {
    const res = await fetch(`${baseUrl}/api/internal/routines`, {
      headers: { 'X-Internal-Secret': SECRET },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('routines')
  })
})

describe('internal deploy POST /api/internal/deploy', () => {
  it('rejects a request with no secret BEFORE doing any work (401)', async () => {
    const res = await fetch(`${baseUrl}/api/internal/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'frontend' }),
    })
    expect(res.status).toBe(401)
  })

  it('passes the auth gate with the correct secret (bogus mode → 400, never deploys)', async () => {
    const res = await fetch(`${baseUrl}/api/internal/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': SECRET },
      body: JSON.stringify({ mode: '__bogus__' }),
    })
    // 400 = got past localhost + secret gates, then failed mode validation.
    expect(res.status).toBe(400)
  })
})

describe('internal test-credentials GET /api/internal/test-credentials/:slug', () => {
  it('rejects a request with no secret (401)', async () => {
    const res = await fetch(`${baseUrl}/api/internal/test-credentials/anything`)
    expect(res.status).toBe(401)
  })

  it('passes the auth gate with the correct secret (missing slug → 404, plaintext never leaks)', async () => {
    const res = await fetch(`${baseUrl}/api/internal/test-credentials/does-not-exist`, {
      headers: { 'X-Internal-Secret': SECRET },
    })
    // 404 = got past localhost + secret gates, then no such credential.
    expect(res.status).toBe(404)
  })
})
