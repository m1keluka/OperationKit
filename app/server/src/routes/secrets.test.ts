import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { SecretSummary, SecretVersionSummary } from '@operationkit/shared'

// Dedicated crypto key + isolated DB + JWT secret BEFORE importing modules.
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.JWT_SECRET = 'test-secret-secrets-route'
const TMP_DB = path.join(os.tmpdir(), `cc-secrets-route-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./secrets.js')

let server: http.Server
let baseUrl: string

// Users:
//   1 = global admin
//   2 = member of 'example'
//   3 = member of 'example4' (NOT example)
const ADMIN = 1
const EXAMPLE_MEMBER = 2
const OTHER_MEMBER = 3

const SECRET_VALUE = 'super-secret-plaintext-VALUE-9000'

function cookieFor(id: number, role: 'admin' | 'member'): string {
  return `token=${jwt.sign({ id, username: `u${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}
const ADMIN_C = () => cookieFor(ADMIN, 'admin')
const EXAMPLE_C = () => cookieFor(EXAMPLE_MEMBER, 'member')
const OTHER_C = () => cookieFor(OTHER_MEMBER, 'member')

async function call(method: string, p: string, body?: unknown, cookie?: string) {
  const res = await fetch(`${baseUrl}/api/secrets${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, json, text }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'examplemem', 'x', 'member')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (3, 'othermem', 'x', 'member')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (2, 'example', 'member')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (3, 'example4', 'member')`).run()
  // GET /principals joins the `workspaces` table. initDb seeds example/example-project/
  // operator; 'example4' (user 3's org) has to be added, plus an ARCHIVED org that
  // must never show up in either principals view.
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name, sort_order) VALUES ('example4', 'Example4', 4)`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name, sort_order, archived) VALUES ('retired-co', 'Retired Co', 5, 1)`).run()

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
  getDb().exec('DELETE FROM secret_versions; DELETE FROM secret_access_log; DELETE FROM secrets;')
})

/** Assert a response body never leaks the plaintext or the encrypted column. */
function assertMasked(json: unknown) {
  const str = JSON.stringify(json)
  expect(str).not.toContain(SECRET_VALUE)
  expect(str).not.toContain('value_encrypted')
  expect(str).not.toContain('valueEncrypted')
}

describe('secrets routes — auth', () => {
  it('rejects without auth (401)', async () => {
    expect((await call('GET', '/')).status).toBe(401)
    expect((await call('POST', '/', { scopeType: 'global', key: 'K', value: 'v' })).status).toBe(401)
  })
})

describe('secrets routes — global scope (admin only)', () => {
  it('admin can CRUD a global secret; summary is masked', async () => {
    const created = await call('POST', '/', { scopeType: 'global', key: 'OPENAI_KEY', value: SECRET_VALUE }, ADMIN_C())
    expect(created.status).toBe(201)
    const s = created.json as SecretSummary
    expect(s.scopeType).toBe('global')
    expect(s.key).toBe('OPENAI_KEY')
    expect(s.version).toBe(1)
    expect(s).not.toHaveProperty('value')
    assertMasked(created.json)

    // list (admin, no filter) sees it, masked
    const list = await call('GET', '/', undefined, ADMIN_C())
    expect(list.status).toBe(200)
    expect((list.json as SecretSummary[]).some(x => x.key === 'OPENAI_KEY')).toBe(true)
    assertMasked(list.json)

    // update bumps version, still masked
    const upd = await call('POST', '/', { scopeType: 'global', key: 'OPENAI_KEY', value: SECRET_VALUE }, ADMIN_C())
    expect(upd.status).toBe(201)
    expect((upd.json as SecretSummary).version).toBe(2)

    // delete
    const del = await call('DELETE', '/?scopeType=global&key=OPENAI_KEY', undefined, ADMIN_C())
    expect(del.status).toBe(204)
    const after = await call('GET', '/?scopeType=global', undefined, ADMIN_C())
    expect((after.json as SecretSummary[]).length).toBe(0)
  })

  it('a member cannot read or write global (403)', async () => {
    await call('POST', '/', { scopeType: 'global', key: 'G', value: SECRET_VALUE }, ADMIN_C())
    expect((await call('GET', '/?scopeType=global', undefined, EXAMPLE_C())).status).toBe(403)
    expect((await call('POST', '/', { scopeType: 'global', key: 'X', value: 'v' }, EXAMPLE_C())).status).toBe(403)
    // unfiltered list for a member shows NO global rows
    const list = await call('GET', '/', undefined, EXAMPLE_C())
    expect(list.status).toBe(200)
    expect((list.json as SecretSummary[]).some(x => x.scopeType === 'global')).toBe(false)
  })
})

describe('secrets routes — workspace scope', () => {
  it('a member of the ws can CRUD that ws; a non-member gets 403', async () => {
    const created = await call('POST', '/', { scopeType: 'workspace', workspace: 'example', key: 'WS_KEY', value: SECRET_VALUE }, EXAMPLE_C())
    expect(created.status).toBe(201)
    assertMasked(created.json)

    // non-member of example denied on read + write + delete
    expect((await call('GET', '/?scopeType=workspace&workspace=example', undefined, OTHER_C())).status).toBe(403)
    expect((await call('POST', '/', { scopeType: 'workspace', workspace: 'example', key: 'Z', value: 'v' }, OTHER_C())).status).toBe(403)
    expect((await call('DELETE', '/?scopeType=workspace&workspace=example&key=WS_KEY', undefined, OTHER_C())).status).toBe(403)

    // member sees it in the unfiltered list
    const list = await call('GET', '/', undefined, EXAMPLE_C())
    expect((list.json as SecretSummary[]).some(x => x.scopeType === 'workspace' && x.workspace === 'example')).toBe(true)
    // the other member does NOT see example's ws secret
    const otherList = await call('GET', '/', undefined, OTHER_C())
    expect((otherList.json as SecretSummary[]).some(x => x.workspace === 'example')).toBe(false)

    // admin can also CRUD it
    expect((await call('GET', '/?scopeType=workspace&workspace=example', undefined, ADMIN_C())).status).toBe(200)
  })
})

describe('secrets routes — user scope', () => {
  it('only the user themselves (or admin) can manage their user secret', async () => {
    const created = await call('POST', '/', { scopeType: 'user', userId: EXAMPLE_MEMBER, key: 'MY_KEY', value: SECRET_VALUE }, EXAMPLE_C())
    expect(created.status).toBe(201)
    assertMasked(created.json)

    // another user cannot touch user:2's secret
    expect((await call('GET', '/?scopeType=user&userId=2', undefined, OTHER_C())).status).toBe(403)
    expect((await call('POST', '/', { scopeType: 'user', userId: EXAMPLE_MEMBER, key: 'Z', value: 'v' }, OTHER_C())).status).toBe(403)

    // but the user can; admin can too
    expect((await call('GET', '/?scopeType=user&userId=2', undefined, EXAMPLE_C())).status).toBe(200)
    expect((await call('GET', '/?scopeType=user&userId=2', undefined, ADMIN_C())).status).toBe(200)
  })
})

describe('secrets routes — workspace_user scope', () => {
  it('requires BOTH self-ownership and ws membership', async () => {
    // example member owns workspace_user(example, 2)
    const ok = await call('POST', '/', { scopeType: 'workspace_user', workspace: 'example', userId: EXAMPLE_MEMBER, key: 'WU', value: SECRET_VALUE }, EXAMPLE_C())
    expect(ok.status).toBe(201)
    assertMasked(ok.json)

    // wrong workspace (member of example4, not example) → 403 even though userId matches
    expect((await call('POST', '/', { scopeType: 'workspace_user', workspace: 'example4', userId: EXAMPLE_MEMBER, key: 'X', value: 'v' }, EXAMPLE_C())).status).toBe(403)
    // someone else (other member) cannot read user 2's workspace_user secret
    expect((await call('GET', '/?scopeType=workspace_user&workspace=example&userId=2', undefined, OTHER_C())).status).toBe(403)
    // admin can
    expect((await call('GET', '/?scopeType=workspace_user&workspace=example&userId=2', undefined, ADMIN_C())).status).toBe(200)
  })
})

describe('secrets routes — versions + rollback', () => {
  it('lists version metadata (masked) and rolls back to a new version', async () => {
    await call('POST', '/', { scopeType: 'global', key: 'V', value: SECRET_VALUE }, ADMIN_C())
    await call('POST', '/', { scopeType: 'global', key: 'V', value: SECRET_VALUE + '-2' }, ADMIN_C())

    const versions = await call('GET', '/versions?scopeType=global&key=V', undefined, ADMIN_C())
    expect(versions.status).toBe(200)
    const vs = versions.json as SecretVersionSummary[]
    expect(vs.length).toBe(2)
    expect(vs[0].version).toBe(2) // newest first
    assertMasked(versions.json)

    const rb = await call('POST', '/rollback', { scopeType: 'global', key: 'V', toVersion: 1 }, ADMIN_C())
    expect(rb.status).toBe(200)
    expect((rb.json as SecretSummary).version).toBe(3) // append-only
    assertMasked(rb.json)

    // rollback to missing version → 404
    expect((await call('POST', '/rollback', { scopeType: 'global', key: 'V', toVersion: 99 }, ADMIN_C())).status).toBe(404)
    // rollback non-existent key → 404
    expect((await call('POST', '/rollback', { scopeType: 'global', key: 'NOPE', toVersion: 1 }, ADMIN_C())).status).toBe(404)
  })

  it('versions is access-checked (non-member 403)', async () => {
    await call('POST', '/', { scopeType: 'workspace', workspace: 'example', key: 'WV', value: SECRET_VALUE }, EXAMPLE_C())
    expect((await call('GET', '/versions?scopeType=workspace&workspace=example&key=WV', undefined, OTHER_C())).status).toBe(403)
    expect((await call('GET', '/versions?scopeType=workspace&workspace=example&key=WV', undefined, EXAMPLE_C())).status).toBe(200)
  })
})

describe('secrets routes — validation + not-found', () => {
  it('400 on bad scopeType / missing dims / missing key', async () => {
    expect((await call('POST', '/', { scopeType: 'bogus', key: 'K', value: 'v' }, ADMIN_C())).status).toBe(400)
    expect((await call('POST', '/', { scopeType: 'workspace', key: 'K', value: 'v' }, ADMIN_C())).status).toBe(400) // no workspace
    expect((await call('POST', '/', { scopeType: 'user', key: 'K', value: 'v' }, ADMIN_C())).status).toBe(400) // no userId
    expect((await call('POST', '/', { scopeType: 'global', key: '', value: 'v' }, ADMIN_C())).status).toBe(400) // empty key
    expect((await call('POST', '/', { scopeType: 'global', key: 'K' }, ADMIN_C())).status).toBe(400) // no value
    expect((await call('GET', '/versions?scopeType=global', undefined, ADMIN_C())).status).toBe(400) // no key
  })

  it('404 on delete of a missing secret', async () => {
    expect((await call('DELETE', '/?scopeType=global&key=GHOST', undefined, ADMIN_C())).status).toBe(404)
  })

  it('access-log is global-admin only', async () => {
    await call('POST', '/', { scopeType: 'global', key: 'L', value: SECRET_VALUE }, ADMIN_C())
    const log = await call('GET', '/access-log', undefined, ADMIN_C())
    expect(log.status).toBe(200)
    assertMasked(log.json)
    expect((await call('GET', '/access-log', undefined, EXAMPLE_C())).status).toBe(403)
  })
})

/** Seed one secret at each of the four scopes (as admin, who can reach them all). */
async function seedAllFourScopes(): Promise<void> {
  await call('POST', '/', { scopeType: 'global', key: 'S_GLOBAL', value: SECRET_VALUE }, ADMIN_C())
  await call('POST', '/', { scopeType: 'workspace', workspace: 'example', key: 'S_WS', value: SECRET_VALUE }, ADMIN_C())
  await call('POST', '/', { scopeType: 'user', userId: EXAMPLE_MEMBER, key: 'S_USER', value: SECRET_VALUE }, ADMIN_C())
  await call('POST', '/', { scopeType: 'workspace_user', workspace: 'example', userId: EXAMPLE_MEMBER, key: 'S_WSUSER', value: SECRET_VALUE }, ADMIN_C())
}

describe('secrets routes — all-scopes admin view', () => {
  it('admin GET / with no query returns secrets from ALL FOUR scopes in one response', async () => {
    await seedAllFourScopes()

    const list = await call('GET', '/', undefined, ADMIN_C())
    expect(list.status).toBe(200)
    const rows = list.json as SecretSummary[]
    expect([...new Set(rows.map(r => r.scopeType))].sort()).toEqual([
      'global', 'user', 'workspace', 'workspace_user',
    ])
    expect(rows.map(r => r.key).sort()).toEqual(['S_GLOBAL', 'S_USER', 'S_WS', 'S_WSUSER'])
    assertMasked(list.json)
  })

  it('a member GET / with no query returns ONLY the subset they can access', async () => {
    await seedAllFourScopes()
    // A secret belonging to the OTHER member's org + user, which must not appear.
    await call('POST', '/', { scopeType: 'workspace', workspace: 'example4', key: 'S_OTHER_WS', value: SECRET_VALUE }, ADMIN_C())
    await call('POST', '/', { scopeType: 'user', userId: OTHER_MEMBER, key: 'S_OTHER_USER', value: SECRET_VALUE }, ADMIN_C())

    const list = await call('GET', '/', undefined, EXAMPLE_C())
    expect(list.status).toBe(200)
    const rows = list.json as SecretSummary[]
    expect(rows.map(r => r.key).sort()).toEqual(['S_USER', 'S_WS', 'S_WSUSER'])
    expect(rows.some(r => r.scopeType === 'global')).toBe(false)
    expect(rows.some(r => r.workspace === 'example4')).toBe(false)
    expect(rows.some(r => r.userId === OTHER_MEMBER)).toBe(false)
    assertMasked(list.json)
  })
})

describe('secrets routes — CRUD at every scope (round trip via the API)', () => {
  const CASES: { label: string; body: Record<string, unknown>; query: string; expect: Partial<SecretSummary> }[] = [
    {
      label: 'global',
      body: { scopeType: 'global' },
      query: '?scopeType=global',
      expect: { scopeType: 'global', workspace: null, userId: null },
    },
    {
      label: 'workspace',
      body: { scopeType: 'workspace', workspace: 'example' },
      query: '?scopeType=workspace&workspace=example',
      expect: { scopeType: 'workspace', workspace: 'example', userId: null },
    },
    {
      label: 'user',
      body: { scopeType: 'user', userId: EXAMPLE_MEMBER },
      query: `?scopeType=user&userId=${EXAMPLE_MEMBER}`,
      expect: { scopeType: 'user', workspace: null, userId: EXAMPLE_MEMBER },
    },
    {
      label: 'workspace_user',
      body: { scopeType: 'workspace_user', workspace: 'example', userId: EXAMPLE_MEMBER },
      query: `?scopeType=workspace_user&workspace=example&userId=${EXAMPLE_MEMBER}`,
      expect: { scopeType: 'workspace_user', workspace: 'example', userId: EXAMPLE_MEMBER },
    },
  ]

  for (const c of CASES) {
    it(`admin can create → read back → delete at scope '${c.label}'`, async () => {
      const created = await call('POST', '/', { ...c.body, key: 'RT_KEY', value: SECRET_VALUE }, ADMIN_C())
      expect(created.status).toBe(201)
      expect(created.json).toMatchObject({ key: 'RT_KEY', version: 1, ...c.expect })
      assertMasked(created.json)

      // READ-BACK at that scope proves the row actually landed there.
      const read = await call('GET', c.query, undefined, ADMIN_C())
      expect(read.status).toBe(200)
      const rows = read.json as SecretSummary[]
      expect(rows.length).toBe(1)
      expect(rows[0]).toMatchObject({ key: 'RT_KEY', ...c.expect })
      assertMasked(read.json)

      const del = await call('DELETE', `${c.query}&key=RT_KEY`, undefined, ADMIN_C())
      expect(del.status).toBe(204)
      const after = await call('GET', c.query, undefined, ADMIN_C())
      expect((after.json as SecretSummary[]).length).toBe(0)
    })
  }
})

describe('secrets routes — move (scope change)', () => {
  it('admin moves a secret across scopes; read-back confirms the new scope and absence at the old', async () => {
    const created = await call('POST', '/', { scopeType: 'workspace', workspace: 'example', key: 'MV', value: SECRET_VALUE }, ADMIN_C())
    expect(created.status).toBe(201)

    const moved = await call('POST', '/move', {
      scopeType: 'workspace', workspace: 'example', key: 'MV',
      to: { scopeType: 'global' },
    }, ADMIN_C())
    expect(moved.status).toBe(200)
    const s = moved.json as SecretSummary
    expect(s.scopeType).toBe('global')
    expect(s.workspace).toBeNull()
    expect(s.id).toBe((created.json as SecretSummary).id) // same row, re-parented
    assertMasked(moved.json)

    // READ-BACK: present at the new scope...
    const atNew = await call('GET', '/?scopeType=global', undefined, ADMIN_C())
    expect((atNew.json as SecretSummary[]).map(x => x.key)).toEqual(['MV'])
    // ...and gone from the old one.
    const atOld = await call('GET', '/?scopeType=workspace&workspace=example', undefined, ADMIN_C())
    expect((atOld.json as SecretSummary[]).length).toBe(0)
  })

  it('403 when a member moves into a scope they do not own', async () => {
    await call('POST', '/', { scopeType: 'user', userId: EXAMPLE_MEMBER, key: 'MINE', value: SECRET_VALUE }, EXAMPLE_C())
    // member → global (destination denied)
    const up = await call('POST', '/move', {
      scopeType: 'user', userId: EXAMPLE_MEMBER, key: 'MINE', to: { scopeType: 'global' },
    }, EXAMPLE_C())
    expect(up.status).toBe(403)
    // member → another org's workspace (destination denied)
    expect((await call('POST', '/move', {
      scopeType: 'user', userId: EXAMPLE_MEMBER, key: 'MINE', to: { scopeType: 'workspace', workspace: 'example4' },
    }, EXAMPLE_C())).status).toBe(403)
    // and the source is untouched
    const still = await call('GET', `/?scopeType=user&userId=${EXAMPLE_MEMBER}`, undefined, EXAMPLE_C())
    expect((still.json as SecretSummary[]).map(x => x.key)).toEqual(['MINE'])
  })

  it('403 when a member moves OUT of a scope they do not own', async () => {
    await call('POST', '/', { scopeType: 'global', key: 'G_MV', value: SECRET_VALUE }, ADMIN_C())
    expect((await call('POST', '/move', {
      scopeType: 'global', key: 'G_MV', to: { scopeType: 'user', userId: EXAMPLE_MEMBER },
    }, EXAMPLE_C())).status).toBe(403)
  })

  it('409 when the key already exists at the target scope', async () => {
    await call('POST', '/', { scopeType: 'workspace', workspace: 'example', key: 'DUP', value: SECRET_VALUE }, ADMIN_C())
    await call('POST', '/', { scopeType: 'global', key: 'DUP', value: SECRET_VALUE }, ADMIN_C())
    const conflict = await call('POST', '/move', {
      scopeType: 'workspace', workspace: 'example', key: 'DUP', to: { scopeType: 'global' },
    }, ADMIN_C())
    expect(conflict.status).toBe(409)
    // Source survived the refusal.
    const src = await call('GET', '/?scopeType=workspace&workspace=example', undefined, ADMIN_C())
    expect((src.json as SecretSummary[]).map(x => x.key)).toEqual(['DUP'])
  })

  it('404 when the source secret does not exist', async () => {
    expect((await call('POST', '/move', {
      scopeType: 'global', key: 'GHOST', to: { scopeType: 'workspace', workspace: 'example' },
    }, ADMIN_C())).status).toBe(404)
  })

  it('400 on a malformed `to` (and on a malformed source / missing key)', async () => {
    await call('POST', '/', { scopeType: 'global', key: 'B', value: SECRET_VALUE }, ADMIN_C())
    // `to` missing its required workspace dimension
    const badTo = await call('POST', '/move', {
      scopeType: 'global', key: 'B', to: { scopeType: 'workspace' },
    }, ADMIN_C())
    expect(badTo.status).toBe(400)
    expect(String((badTo.json as { error: string }).error)).toContain('to:')
    // unknown `to` scopeType
    expect((await call('POST', '/move', { scopeType: 'global', key: 'B', to: { scopeType: 'bogus' } }, ADMIN_C())).status).toBe(400)
    // `to` omitted entirely
    expect((await call('POST', '/move', { scopeType: 'global', key: 'B' }, ADMIN_C())).status).toBe(400)
    // malformed SOURCE is labelled `from:`
    const badFrom = await call('POST', '/move', { scopeType: 'workspace', key: 'B', to: { scopeType: 'global' } }, ADMIN_C())
    expect(badFrom.status).toBe(400)
    expect(String((badFrom.json as { error: string }).error)).toContain('from:')
    // missing key
    expect((await call('POST', '/move', { scopeType: 'global', to: { scopeType: 'global' } }, ADMIN_C())).status).toBe(400)
  })
})

describe('secrets routes — principals', () => {
  interface Principals {
    organizations: { slug: string; name: string }[]
    users: { id: number; username: string }[]
    canUseGlobal: boolean
  }

  it('admin sees every (unarchived) org, every user, and canUseGlobal true', async () => {
    const res = await call('GET', '/principals', undefined, ADMIN_C())
    expect(res.status).toBe(200)
    const p = res.json as Principals
    expect(p.canUseGlobal).toBe(true)
    expect(p.organizations.map(o => o.slug)).toContain('example')
    expect(p.organizations.map(o => o.slug)).toContain('example4')
    expect(p.organizations.map(o => o.slug)).not.toContain('retired-co') // archived
    expect(p.users.map(u => u.id).sort()).toEqual([ADMIN, EXAMPLE_MEMBER, OTHER_MEMBER])
  })

  it('a member sees only their own org(s), only themselves, canUseGlobal false', async () => {
    const p = (await call('GET', '/principals', undefined, EXAMPLE_C())).json as Principals
    expect(p.canUseGlobal).toBe(false)
    expect(p.organizations.map(o => o.slug)).toEqual(['example'])
    expect(p.users).toEqual([{ id: EXAMPLE_MEMBER, username: 'examplemem' }])

    const other = (await call('GET', '/principals', undefined, OTHER_C())).json as Principals
    expect(other.canUseGlobal).toBe(false)
    expect(other.organizations.map(o => o.slug)).toEqual(['example4'])
    expect(other.users).toEqual([{ id: OTHER_MEMBER, username: 'othermem' }])
  })

  it('requires auth and returns no secret data', async () => {
    expect((await call('GET', '/principals')).status).toBe(401)
    await call('POST', '/', { scopeType: 'global', key: 'P', value: SECRET_VALUE }, ADMIN_C())
    const res = await call('GET', '/principals', undefined, ADMIN_C())
    expect(res.text).not.toContain(SECRET_VALUE)
    expect(res.text).not.toContain('"key"')
  })
})

// The explicit "a value is never readable back over the wire" criterion. A
// distinctive sentinel is scanned for in the RAW response body of every route,
// so leakage is caught at ANY nesting depth — not just on the fields we thought
// to assert about.
describe('secrets routes — no value exposure', () => {
  const SENTINEL = 'sk-live-DO-NOT-LEAK-9f3a2b'
  const FORBIDDEN_FIELDS = ['value', 'value_encrypted', 'plaintext', 'valueEncrypted']

  /** Scan a raw response body for the sentinel and any value-bearing field name. */
  function assertNoLeak(where: string, res: { status: number; text: string }) {
    expect(`${where}: ${res.text}`).not.toContain(SENTINEL)
    for (const f of FORBIDDEN_FIELDS) {
      expect(`${where}: ${res.text}`).not.toContain(`"${f}"`)
    }
  }

  /** No value-bearing property survives on a returned summary object. */
  function assertNoValueKeys(json: unknown) {
    const keys = Object.keys(json as object)
    for (const f of FORBIDDEN_FIELDS) expect(keys).not.toContain(f)
  }

  it('no route ever echoes the plaintext back — create, list, versions, rollback, move, access-log', async () => {
    const created = await call('POST', '/', { scopeType: 'workspace', workspace: 'example', key: 'LEAK', value: SENTINEL }, ADMIN_C())
    expect(created.status).toBe(201)
    assertNoLeak('POST /', created)
    // and the summary object itself carries no value-bearing key
    assertNoValueKeys(created.json)

    // A second write so there is a version history to roll back to.
    const updated = await call('POST', '/', { scopeType: 'workspace', workspace: 'example', key: 'LEAK', value: `${SENTINEL}-v2` }, ADMIN_C())
    assertNoLeak('POST / (update)', updated)

    assertNoLeak('GET / (all scopes)', await call('GET', '/', undefined, ADMIN_C()))
    assertNoLeak('GET /?scopeType=workspace', await call('GET', '/?scopeType=workspace&workspace=example', undefined, ADMIN_C()))
    assertNoLeak('GET /versions', await call('GET', '/versions?scopeType=workspace&workspace=example&key=LEAK', undefined, ADMIN_C()))

    const rb = await call('POST', '/rollback', { scopeType: 'workspace', workspace: 'example', key: 'LEAK', toVersion: 1 }, ADMIN_C())
    expect(rb.status).toBe(200)
    assertNoLeak('POST /rollback', rb)

    const mv = await call('POST', '/move', {
      scopeType: 'workspace', workspace: 'example', key: 'LEAK', to: { scopeType: 'global' },
    }, ADMIN_C())
    expect(mv.status).toBe(200)
    assertNoLeak('POST /move', mv)
    assertNoValueKeys(mv.json)

    // The audit tail has seen every one of those operations by now.
    const log = await call('GET', '/access-log', undefined, ADMIN_C())
    expect(log.status).toBe(200)
    assertNoLeak('GET /access-log', log)

    // Sanity: the secret really is still there (so the scans above were not
    // passing merely because the responses were empty).
    const still = await call('GET', '/?scopeType=global', undefined, ADMIN_C())
    expect((still.json as SecretSummary[]).map(x => x.key)).toEqual(['LEAK'])
  })

  it('the member-visible surfaces do not leak either', async () => {
    await call('POST', '/', { scopeType: 'user', userId: EXAMPLE_MEMBER, key: 'MLEAK', value: SENTINEL }, EXAMPLE_C())
    assertNoLeak('GET / (member)', await call('GET', '/', undefined, EXAMPLE_C()))
    assertNoLeak('GET /?scopeType=user (member)', await call('GET', `/?scopeType=user&userId=${EXAMPLE_MEMBER}`, undefined, EXAMPLE_C()))
    assertNoLeak('GET /versions (member)', await call('GET', `/versions?scopeType=user&userId=${EXAMPLE_MEMBER}&key=MLEAK`, undefined, EXAMPLE_C()))
    assertNoLeak('GET /principals (member)', await call('GET', '/principals', undefined, EXAMPLE_C()))
  })
})
