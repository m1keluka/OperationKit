/**
 * Sprint 6 secrets hardening (obj 900498): masking sweep, rotate, metadata,
 * refused+audited reveal, the append-only audit log + its read API, and
 * last-used stamping. Fixture values only; nothing here touches a live store.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { SecretSummary, SecretAuditPage } from '@operationkit/shared'
import { clearSecretAuditLogForTests } from '../__fixtures__/secret-audit-log.js'

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.JWT_SECRET = 'test-secret-secrets-hardening'
const TMP_DB = path.join(os.tmpdir(), `cc-secrets-hardening-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: router, REVEAL_DISABLED_MESSAGE } = await import('./secrets.js')
const store = await import('../services/secrets-store.js')

const ADMIN = 1
const EXAMPLE_MEMBER = 2
const OTHER_MEMBER = 3
const V1 = 'fixture-plaintext-ONE-7f3a9c'
const V2 = 'fixture-plaintext-TWO-b81e44'

let server: http.Server
let baseUrl: string

const cookie = (id: number, role: 'admin' | 'member') =>
  `token=${jwt.sign({ id, username: `u${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
const ADMIN_C = () => cookie(ADMIN, 'admin')
const EXAMPLE_C = () => cookie(EXAMPLE_MEMBER, 'member')
const OTHER_C = () => cookie(OTHER_MEMBER, 'member')

async function call(method: string, p: string, body?: unknown, c?: string, bearer?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (c) headers.Cookie = c
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  const res = await fetch(`${baseUrl}/api/secrets${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, json, text }
}

/** No response body may ever carry a plaintext or the ciphertext column. */
function assertMasked(text: string) {
  expect(text).not.toContain(V1)
  expect(text).not.toContain(V2)
  expect(text).not.toContain('value_encrypted')
  expect(text).not.toContain('valueEncrypted')
  // The on-disk ciphertext format is iv.tag.ct (base64). Make sure the stored
  // ciphertext itself never leaks either.
  const rows = getDb().prepare('SELECT value_encrypted FROM secrets').all() as { value_encrypted: string }[]
  for (const r of rows) expect(text).not.toContain(r.value_encrypted)
}

const EXAMPLE = { scopeType: 'workspace', workspace: 'example' } as const

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'examplemem', 'x', 'member')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (3, 'othermem', 'x', 'member')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (2, 'example', 'member')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (3, 'example4', 'member')`).run()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/secrets', router)
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
  clearSecretAuditLogForTests(getDb())
  getDb().exec('DELETE FROM secret_versions; DELETE FROM secrets;')
})

async function seed(description?: string) {
  const r = await call('POST', '/', { ...EXAMPLE, key: 'STRIPE_KEY', value: V1, description }, ADMIN_C())
  expect(r.status).toBe(201)
  return r.json as SecretSummary
}

describe('masking — no surface ever returns a value', () => {
  it('sweeps every read + write response for plaintext / ciphertext', async () => {
    await seed('billing worker')
    await call('POST', '/rotate', { ...EXAMPLE, key: 'STRIPE_KEY', value: V2 }, ADMIN_C())
    const q = 'scopeType=workspace&workspace=example'
    const responses = [
      await call('GET', '/', undefined, ADMIN_C()),
      await call('GET', `/?${q}`, undefined, ADMIN_C()),
      await call('GET', `/?${q}`, undefined, EXAMPLE_C()),
      await call('GET', `/versions?${q}&key=STRIPE_KEY`, undefined, ADMIN_C()),
      await call('GET', '/access-log', undefined, ADMIN_C()),
      await call('GET', '/audit', undefined, ADMIN_C()),
      await call('GET', `/audit?${q}&key=STRIPE_KEY`, undefined, EXAMPLE_C()),
      await call('GET', '/principals', undefined, ADMIN_C()),
      await call('POST', '/', { ...EXAMPLE, key: 'OTHER', value: V1 }, ADMIN_C()),
      await call('POST', '/rotate', { ...EXAMPLE, key: 'STRIPE_KEY', value: V1 }, ADMIN_C()),
      await call('PATCH', '/metadata', { ...EXAMPLE, key: 'STRIPE_KEY', description: 'x' }, ADMIN_C()),
      await call('POST', '/reveal', { ...EXAMPLE, key: 'STRIPE_KEY' }, ADMIN_C()),
      await call('POST', '/rollback', { ...EXAMPLE, key: 'STRIPE_KEY', toVersion: 1 }, ADMIN_C()),
    ]
    for (const r of responses) {
      expect(r.status).toBeLessThan(500)
      assertMasked(r.text)
    }
  })

  it('list summaries carry description + lastUsedAt but no value field', async () => {
    await seed('billing worker')
    const list = (await call('GET', '/', undefined, ADMIN_C())).json as SecretSummary[]
    expect(list).toHaveLength(1)
    expect(list[0]!.description).toBe('billing worker')
    expect(list[0]!.lastUsedAt).toBeNull()
    expect(Object.keys(list[0]!)).not.toContain('value')
  })
})

describe('POST / description (backward compatible)', () => {
  it('a value-only update keeps the existing description', async () => {
    await seed('billing worker')
    const r = await call('POST', '/', { ...EXAMPLE, key: 'STRIPE_KEY', value: V2 }, ADMIN_C())
    expect((r.json as SecretSummary).description).toBe('billing worker')
  })
  it('rejects a non-string or over-long description', async () => {
    expect((await call('POST', '/', { ...EXAMPLE, key: 'K', value: 'v', description: 5 }, ADMIN_C())).status).toBe(400)
    expect((await call('POST', '/', { ...EXAMPLE, key: 'K', value: 'v', description: 'x'.repeat(501) }, ADMIN_C())).status).toBe(400)
  })
})

describe('POST /rotate', () => {
  it('replaces the value as a new version, keeps the old one for rollback, audits rotate', async () => {
    const before = await seed()
    const r = await call('POST', '/rotate', { ...EXAMPLE, key: 'STRIPE_KEY', value: V2 }, ADMIN_C())
    expect(r.status).toBe(200)
    expect((r.json as SecretSummary).version).toBe(before.version + 1)
    expect(store.getSecretValue(EXAMPLE, 'STRIPE_KEY')).toBe(V2)
    const versions = getDb().prepare('SELECT version FROM secret_versions WHERE secret_id = ?').all(before.id)
    expect(versions).toHaveLength(2)
    const actions = store.queryAccessLog({ secretId: before.id }).entries.map(e => e.action)
    expect(actions).toContain('rotate')
  })

  it('never creates: 404 for a key that does not exist', async () => {
    const r = await call('POST', '/rotate', { ...EXAMPLE, key: 'TYPO_KEY', value: V2 }, ADMIN_C())
    expect(r.status).toBe(404)
    expect(store.getSecret(EXAMPLE, 'TYPO_KEY')).toBeNull()
  })

  it('requires a non-empty value and scope access', async () => {
    await seed()
    expect((await call('POST', '/rotate', { ...EXAMPLE, key: 'STRIPE_KEY', value: '' }, ADMIN_C())).status).toBe(400)
    expect((await call('POST', '/rotate', { ...EXAMPLE, key: 'STRIPE_KEY', value: V2 }, OTHER_C())).status).toBe(403)
    expect((await call('POST', '/rotate', { ...EXAMPLE, key: 'STRIPE_KEY', value: V2 }, EXAMPLE_C())).status).toBe(200)
  })
})

describe('PATCH /metadata', () => {
  it('changes the description only — value, version and ciphertext untouched', async () => {
    const before = await seed('old note')
    const ct = (getDb().prepare('SELECT value_encrypted FROM secrets WHERE id = ?').get(before.id) as { value_encrypted: string }).value_encrypted
    const r = await call('PATCH', '/metadata', { ...EXAMPLE, key: 'STRIPE_KEY', description: '  new note  ' }, EXAMPLE_C())
    expect(r.status).toBe(200)
    const s = r.json as SecretSummary
    expect(s.description).toBe('new note')
    expect(s.version).toBe(before.version)
    const after = (getDb().prepare('SELECT value_encrypted FROM secrets WHERE id = ?').get(before.id) as { value_encrypted: string }).value_encrypted
    expect(after).toBe(ct)
    expect(store.queryAccessLog({ secretId: before.id }).entries[0]!.action).toBe('describe')
  })
  it('clears with null; 404 when missing; 403 without access; 400 without description', async () => {
    await seed('note')
    expect(((await call('PATCH', '/metadata', { ...EXAMPLE, key: 'STRIPE_KEY', description: null }, ADMIN_C())).json as SecretSummary).description).toBeNull()
    expect((await call('PATCH', '/metadata', { ...EXAMPLE, key: 'NOPE', description: 'x' }, ADMIN_C())).status).toBe(404)
    expect((await call('PATCH', '/metadata', { ...EXAMPLE, key: 'STRIPE_KEY', description: 'x' }, OTHER_C())).status).toBe(403)
    expect((await call('PATCH', '/metadata', { ...EXAMPLE, key: 'STRIPE_KEY' }, ADMIN_C())).status).toBe(400)
  })
})

describe('POST /reveal — refused and audited', () => {
  it('always 403s (even for a global admin) and records a reveal_attempt', async () => {
    const s = await seed()
    const r = await call('POST', '/reveal', { ...EXAMPLE, key: 'STRIPE_KEY' }, ADMIN_C())
    expect(r.status).toBe(403)
    expect((r.json as { message: string }).message).toBe(REVEAL_DISABLED_MESSAGE)
    const e = store.queryAccessLog({ action: 'reveal_attempt' }).entries
    expect(e).toHaveLength(1)
    expect(e[0]).toMatchObject({ actorUserId: ADMIN, key: 'STRIPE_KEY', secretId: s.id, source: 'ui', detail: 'refused:write-only' })
  })
  it('logs a probe from a caller without scope access, without resolving the secret id', async () => {
    await seed()
    const r = await call('POST', '/reveal', { ...EXAMPLE, key: 'STRIPE_KEY' }, OTHER_C())
    expect(r.status).toBe(403)
    const e = store.queryAccessLog({ action: 'reveal_attempt' }).entries[0]!
    expect(e).toMatchObject({ actorUserId: OTHER_MEMBER, secretId: null, detail: 'refused:no-scope-access' })
  })
  it('records source=api for a bearer token', async () => {
    await seed()
    const token = jwt.sign({ id: ADMIN, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string)
    await call('POST', '/reveal', { ...EXAMPLE, key: 'STRIPE_KEY' }, undefined, token)
    expect(store.queryAccessLog({ action: 'reveal_attempt' }).entries[0]!.source).toBe('api')
  })
})

describe('D1 (obj 900540): no flag can turn reveal on', () => {
  it('stays 403 and value-free with every plausible reveal flag set in settings and env', async () => {
    await seed()
    const db = getDb()
    for (const k of ['secrets_reveal_enabled', 'secret_reveal', 'reveal_enabled', 'secrets_revealable']) {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')`).run(k)
    }
    process.env.SECRETS_REVEAL_ENABLED = '1'
    try {
      for (const c of [ADMIN_C(), EXAMPLE_C()]) {
        const r = await call('POST', '/reveal', { ...EXAMPLE, key: 'STRIPE_KEY', password: 'x', assertion: {} }, c)
        expect(r.status).toBe(403)
        assertMasked(r.text)
      }
    } finally {
      delete process.env.SECRETS_REVEAL_ENABLED
    }
  })
})

describe('D2/D4 admin surfaces (obj 900540)', () => {
  it('GET /kek-status is admin-only and carries a location, never key material', async () => {
    expect((await call('GET', '/kek-status', undefined, EXAMPLE_C())).status).toBe(403)
    const r = await call('GET', '/kek-status', undefined, ADMIN_C())
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, provider: 'env', location: 'env:SECRETS_MASTER_KEY' })
    expect(r.text).not.toContain(process.env.SECRETS_MASTER_KEY as string)
  })
  it('env-policy: admin-only; mode switch and allowlist edits are validated and audited', async () => {
    expect((await call('GET', '/env-policy', undefined, EXAMPLE_C())).status).toBe(403)
    expect((await call('PUT', '/env-policy/mode', { mode: 'enforce' }, EXAMPLE_C())).status).toBe(403)
    expect((await call('PUT', '/env-policy/mode', { mode: 'off' }, ADMIN_C())).status).toBe(400)
    expect((await call('POST', '/env-policy/allowlist', { subjectType: 'agent', subject: 'cto', key: 'BAD NAME' }, ADMIN_C())).status).toBe(400)
    const add = await call('POST', '/env-policy/allowlist', { subjectType: 'agent', subject: 'cto', key: 'FAKE_KEY' }, ADMIN_C())
    expect(add.json).toMatchObject({ changed: true })
    const put = await call('PUT', '/env-policy/mode', { mode: 'enforce' }, ADMIN_C())
    expect(put.json).toEqual({ mode: 'enforce' })
    const got = await call('GET', '/env-policy', undefined, ADMIN_C())
    expect(got.json).toMatchObject({ mode: 'enforce', allowlist: [{ subjectType: 'agent', subject: 'cto', key: 'FAKE_KEY' }] })
    const del = await call('DELETE', '/env-policy/allowlist', { subjectType: 'agent', subject: 'cto', key: 'FAKE_KEY' }, ADMIN_C())
    expect(del.json).toMatchObject({ changed: true, allowlist: [] })
    const audit = store.queryAccessLog({ action: 'env_policy' }).entries
    expect(audit.map(e => e.detail)).toEqual(['disallow:agent:cto', 'mode:migration->enforce', 'allow:agent:cto'])
    expect(audit.every(e => e.source === 'ui' && e.actorUserId === ADMIN)).toBe(true)
    getDb().exec(`DELETE FROM settings WHERE key = 'secrets_session_env_mode'`)
  })
})

describe('GET /audit', () => {
  it('whole log is admin-only; a member may read the history of a secret in their own scope', async () => {
    await seed()
    expect((await call('GET', '/audit', undefined, EXAMPLE_C())).status).toBe(403)
    const own = await call('GET', '/audit?scopeType=workspace&workspace=example&key=STRIPE_KEY', undefined, EXAMPLE_C())
    expect(own.status).toBe(200)
    expect((own.json as SecretAuditPage).entries.map(e => e.action)).toEqual(['create'])
    expect((own.json as SecretAuditPage).entries[0]!.actorUsername).toBe('admin')
    expect((await call('GET', '/audit?scopeType=workspace&workspace=example&key=STRIPE_KEY', undefined, OTHER_C())).status).toBe(403)
  })
  it('filters by action/key and paginates newest-first with beforeId', async () => {
    await seed()
    for (let i = 0; i < 5; i++) await call('POST', '/rotate', { ...EXAMPLE, key: 'STRIPE_KEY', value: `${V2}-${i}` }, ADMIN_C())
    const p1 = (await call('GET', '/audit?action=rotate&limit=2', undefined, ADMIN_C())).json as SecretAuditPage
    expect(p1.entries).toHaveLength(2)
    expect(p1.nextBeforeId).not.toBeNull()
    const p2 = (await call('GET', `/audit?action=rotate&limit=2&beforeId=${p1.nextBeforeId}`, undefined, ADMIN_C())).json as SecretAuditPage
    expect(p2.entries[0]!.id).toBeLessThan(p1.entries[1]!.id)
    const p3 = (await call('GET', `/audit?action=rotate&limit=2&beforeId=${p2.nextBeforeId}`, undefined, ADMIN_C())).json as SecretAuditPage
    expect(p3.entries).toHaveLength(1)
    expect(p3.nextBeforeId).toBeNull()
    expect(((await call('GET', '/audit?key=NOPE', undefined, ADMIN_C())).json as SecretAuditPage).entries).toEqual([])
  })
  it('a per-secret view also finds legacy rows written before secret_id existed', async () => {
    const s = await seed()
    getDb().prepare(`INSERT INTO secret_access_log (actor_user_id, action, scope, key) VALUES (1, 'update', 'workspace:example', 'STRIPE_KEY')`).run()
    const page = (await call('GET', '/audit?scopeType=workspace&workspace=example&key=STRIPE_KEY', undefined, ADMIN_C())).json as SecretAuditPage
    expect(page.entries.map(e => e.action)).toEqual(['update', 'create'])
    expect(page.entries[1]!.secretId).toBe(s.id)
  })
  it('rejects malformed paging params', async () => {
    expect((await call('GET', '/audit?limit=0', undefined, ADMIN_C())).status).toBe(400)
    expect((await call('GET', '/audit?beforeId=abc', undefined, ADMIN_C())).status).toBe(400)
  })
})

describe('append-only audit log (DB-enforced)', () => {
  it('UPDATE and DELETE on secret_access_log abort', async () => {
    await seed()
    const db = getDb()
    expect(() => db.prepare(`UPDATE secret_access_log SET key = 'tampered'`).run()).toThrow(/append-only/)
    expect(() => db.prepare(`DELETE FROM secret_access_log`).run()).toThrow(/append-only/)
    expect((db.prepare('SELECT COUNT(*) AS n FROM secret_access_log').get() as { n: number }).n).toBe(1)
  })
  it('deleting a secret keeps its audit trail', async () => {
    const s = await seed()
    expect((await call('DELETE', '/?scopeType=workspace&workspace=example&key=STRIPE_KEY', undefined, ADMIN_C())).status).toBe(204)
    const actions = store.queryAccessLog({ key: 'STRIPE_KEY' }).entries.map(e => [e.action, e.secretId])
    expect(actions).toEqual([['delete', s.id], ['create', s.id]])
  })
})

describe('last_used_at', () => {
  it('is stamped by an audited (spawn) resolve and by a server read, not by boot hydration', async () => {
    const s = await seed()
    store.resolveSecrets({ workspace: 'example', audit: false })
    expect(store.getSecret(EXAMPLE, 'STRIPE_KEY')!.lastUsedAt).toBeNull()
    store.resolveSecrets({ workspace: 'example', audit: true, actorUserId: null })
    expect(store.getSecret(EXAMPLE, 'STRIPE_KEY')!.lastUsedAt).toMatch(/^\d{4}-\d{2}-\d{2} /)
    const inj = store.queryAccessLog({ action: 'inject' }).entries[0]!
    expect(inj).toMatchObject({ secretId: s.id, source: 'spawn', scope: 'workspace:example' })
  })
})
