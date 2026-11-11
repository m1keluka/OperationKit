// Bearer-auth gate for cross-host objective creation (obj 702304).
//
// POST /api/internal/objectives historically trusted network origin only
// (localhost). The Cattle AI thread scanner runs on the example2-ops droplet and
// must create fix-objectives cross-host, so the route now also accepts a valid
// `Authorization: Bearer <OBJECTIVES_API_TOKEN>`. This proves:
//
//   1. remote request, NO token            -> 401
//   2. remote request, BLANK bearer token  -> 401
//   3. remote request, WRONG token         -> 401
//   4. remote request, CORRECT token       -> 201 create (objective persisted)
//   5. localhost request, NO token         -> 201 (first-party callers unbroken)
//
// "remote" is simulated with trust proxy + an X-Forwarded-For public IP, exactly
// as internal-auth.test.ts does; "localhost" is a request with no XFF (req.ip
// resolves to the loopback the test server listens on).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

// Env + DB must be set BEFORE importing the router / db (both read at load time).
const TOKEN = 'obj-token-test-4f3a9c2b7e11'
process.env.OBJECTIVES_API_TOKEN = TOKEN
const TMP_DB = path.join(os.tmpdir(), `cc-obj-bearer-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')

let server: http.Server
let baseUrl: string

const REMOTE_IP = '203.0.113.9' // TEST-NET-3, guaranteed non-localhost

async function create(
  items: unknown[],
  opts: { auth?: string | null; remote?: boolean } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.remote) headers['X-Forwarded-For'] = REMOTE_IP
  if (opts.auth != null) headers['Authorization'] = opts.auth
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers,
    body: JSON.stringify(items),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = express()
  app.set('trust proxy', true) // honor X-Forwarded-For, matching production (index.ts)
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      resolve()
    })
  })
})

afterAll(() => {
  try { server?.close() } catch { /* ignore */ }
  try { getDb().close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  delete process.env.OBJECTIVES_API_TOKEN
})

describe('POST /api/internal/objectives — cross-host bearer auth (obj 702304)', () => {
  it('rejects a remote request with NO token (401)', async () => {
    const { status, json } = await create([{ title: 'no-token remote' }], { remote: true })
    expect(status).toBe(401)
    expect(String(json.error)).toMatch(/Authorization: Bearer/i)
  })

  it('rejects a remote request with a BLANK bearer token (401)', async () => {
    const { status } = await create([{ title: 'blank-token remote' }], { remote: true, auth: 'Bearer ' })
    expect(status).toBe(401)
  })

  it('rejects a remote request with a WRONG token (401)', async () => {
    const { status } = await create([{ title: 'wrong-token remote' }], { remote: true, auth: 'Bearer not-the-real-token' })
    expect(status).toBe(401)
  })

  it('accepts a remote request with the CORRECT token and creates the objective (201)', async () => {
    const { status, json } = await create([{ title: 'correct-token remote' }], { remote: true, auth: `Bearer ${TOKEN}` })
    expect(status).toBe(201)
    const objectives = json.objectives as Array<{ id: number; title: string }>
    expect(objectives).toHaveLength(1)
    expect(objectives[0].title).toBe('correct-token remote')
    const row = getDb().prepare('SELECT title FROM objectives WHERE id = ?').get(objectives[0].id) as { title: string }
    expect(row.title).toBe('correct-token remote')
  })

  it('still accepts a localhost first-party request with NO token (201) — internal callers unbroken', async () => {
    const { status, json } = await create([{ title: 'localhost no-token' }])
    expect(status).toBe(201)
    expect((json.objectives as Array<unknown>)).toHaveLength(1)
  })
})
