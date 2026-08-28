/**
 * Tests for the per-project TEST credential resolution seam (obj-2391) layered
 * on the existing test_credentials store. Covers: resolve-by-project precedence
 * (is_primary > convention slug > recency), workspace scoping, 404, masking on
 * list, the set-primary endpoint, and the localhost+secret internal resolve.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Dedicated crypto key + isolated DB + JWT secret BEFORE importing modules.
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.JWT_SECRET = 'test-secret-testcred-route'
process.env.INTERNAL_API_SECRET = 'test-internal-secret-testcred'
const TMP_DB = path.join(os.tmpdir(), `cc-testcred-route-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: router, internalTestCredentialsRouter } = await import('./test-credentials.js')

const INTERNAL_SECRET = 'test-internal-secret-testcred'

let server: http.Server
let baseUrl: string

const ADMIN = 1 // global admin
const EXAMPLE_ADMIN = 2 // workspace admin of 'example'
const OTHER = 3 // member of 'example4', no admin anywhere

function cookieFor(id: number, role: 'admin' | 'member'): string {
  return `token=${jwt.sign({ id, username: `u${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}
const ADMIN_C = () => cookieFor(ADMIN, 'admin')
const EXAMPLE_ADMIN_C = () => cookieFor(EXAMPLE_ADMIN, 'member')
const OTHER_C = () => cookieFor(OTHER, 'member')

async function call(method: string, p: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${baseUrl}/api/test-credentials${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, json: json as any, text }
}

async function callInternal(p: string, secret?: string) {
  const res = await fetch(`${baseUrl}/api/internal/test-credentials${p}`, {
    headers: secret ? { 'X-Internal-Secret': secret } : {},
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, json: json as any, text }
}

const PASSWORD = 'NonProd_E2E_pw_4242'

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1,'admin','x','admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2,'exampleadmin','x','member')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (3,'other','x','member')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (2,'example','admin')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (3,'example4','member')`).run()

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/test-credentials', router)
  app.use('/api/internal/test-credentials', internalTestCredentialsRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

beforeEach(() => {
  getDb().exec('DELETE FROM test_credentials;')
})

async function seedCred(over: Partial<{
  slug: string; workspace: string; project: string; label: string; login_url: string;
  fields: Record<string, string>
}> = {}) {
  const body = {
    slug: over.slug ?? 'example-platform-e2e',
    workspace: over.workspace ?? 'example',
    project: over.project ?? 'example-platform',
    label: over.label ?? 'Example E2E (non-prod)',
    login_url: over.login_url ?? 'https://example-platform-preview.example.dev',
    fields: over.fields ?? { username: 'e2e@example.test', password: PASSWORD },
  }
  const r = await call('POST', '/', body, ADMIN_C())
  expect(r.status).toBe(201)
  return r.json
}

describe('test-credentials resolve — auth', () => {
  it('rejects unauthenticated resolve (401)', async () => {
    expect((await call('GET', '/resolve?project=example-platform')).status).toBe(401)
  })
  it('400 when project missing', async () => {
    expect((await call('GET', '/resolve', undefined, ADMIN_C())).status).toBe(400)
  })
})

describe('test-credentials resolve — by project', () => {
  it('resolves decrypted login + testing link for a project', async () => {
    await seedCred()
    const r = await call('GET', '/resolve?project=example-platform', undefined, ADMIN_C())
    expect(r.status).toBe(200)
    expect(r.json.slug).toBe('example-platform-e2e')
    expect(r.json.testingUrl).toBe('https://example-platform-preview.example.dev')
    expect(r.json.fields.username).toBe('e2e@example.test')
    expect(r.json.fields.password).toBe(PASSWORD)
  })

  it('404 for a project with no managed credential', async () => {
    const r = await call('GET', '/resolve?project=ghost-project', undefined, ADMIN_C())
    expect(r.status).toBe(404)
  })

  it('workspace admin can resolve own workspace; outsider gets 403', async () => {
    await seedCred()
    expect((await call('GET', '/resolve?project=example-platform', undefined, EXAMPLE_ADMIN_C())).status).toBe(200)
    expect((await call('GET', '/resolve?project=example-platform', undefined, OTHER_C())).status).toBe(403)
  })

  it('precedence: is_primary beats a more-recent non-primary row', async () => {
    // Older row is the convention slug; newer row is a secondary login.
    await seedCred({ slug: 'example-platform-e2e', fields: { username: 'primary@example.test', password: PASSWORD } })
    await seedCred({ slug: 'example-platform-readonly', label: 'readonly', fields: { username: 'newer@example.test', password: PASSWORD } })
    // Mark the convention slug primary explicitly.
    expect((await call('POST', '/example-platform-e2e/primary', {}, ADMIN_C())).status).toBe(200)
    const r = await call('GET', '/resolve?project=example-platform', undefined, ADMIN_C())
    expect(r.json.slug).toBe('example-platform-e2e')
    expect(r.json.isPrimary).toBe(true)
    expect(r.json.fields.username).toBe('primary@example.test')
  })

  it('precedence fallback: convention slug wins when no primary set', async () => {
    await seedCred({ slug: 'example-platform-extra', label: 'extra', fields: { username: 'extra@example.test', password: PASSWORD } })
    await seedCred({ slug: 'example-platform-e2e', fields: { username: 'conv@example.test', password: PASSWORD } })
    const r = await call('GET', '/resolve?project=example-platform', undefined, ADMIN_C())
    expect(r.json.slug).toBe('example-platform-e2e')
  })

  it('only one primary per (workspace, project) — set-primary clears the sibling', async () => {
    await seedCred({ slug: 'example-platform-e2e', fields: { username: 'a@example.test', password: PASSWORD } })
    await seedCred({ slug: 'example-platform-alt', label: 'alt', fields: { username: 'b@example.test', password: PASSWORD } })
    await call('POST', '/example-platform-e2e/primary', {}, ADMIN_C())
    await call('POST', '/example-platform-alt/primary', {}, ADMIN_C())
    const db = getDb()
    const cnt = db.prepare("SELECT COUNT(*) c FROM test_credentials WHERE workspace='example' AND project='example-platform' AND is_primary=1").get() as { c: number }
    expect(cnt.c).toBe(1)
    const r = await call('GET', '/resolve?project=example-platform', undefined, ADMIN_C())
    expect(r.json.slug).toBe('example-platform-alt')
  })
})

describe('test-credentials — masking & internal resolve', () => {
  it('list never leaks the plaintext password', async () => {
    await seedCred()
    const r = await call('GET', '/?workspace=example', undefined, ADMIN_C())
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.json)).not.toContain(PASSWORD)
  })

  it('internal resolve requires the internal secret, then returns plaintext', async () => {
    await seedCred()
    expect((await callInternal('/resolve?project=example-platform')).status).toBe(401)
    const ok = await callInternal('/resolve?project=example-platform', INTERNAL_SECRET)
    expect(ok.status).toBe(200)
    expect(ok.json.fields.password).toBe(PASSWORD)
    expect(ok.json.testingUrl).toBe('https://example-platform-preview.example.dev')
  })

  it('internal resolve 404s for an unknown project', async () => {
    const r = await callInternal('/resolve?project=nope', INTERNAL_SECRET)
    expect(r.status).toBe(404)
  })
})
