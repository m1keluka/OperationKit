/**
 * Named, scoped agent API keys (obj 714090).
 *
 * Boots the real auth + objectives routers behind the real agentKeyGuard, the
 * same order index.ts mounts them, on a throwaway DB.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-agent-keys-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-agent-keys-xxxx'

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('./auth.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { agentKeyGuard, requiredScope } = await import('../middleware/agent-key-guard.js')
const { requireAuth, requireAdmin } = await import('../middleware/auth.js')
const { resetAgentKeyTouchThrottle } = await import('../lib/agent-keys.js')

const ADMIN_ID = 1
let server: http.Server
let baseUrl: string
const cookie = () =>
  `token=${jwt.sign({ id: ADMIN_ID, username: 'mike', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

type Json = Record<string, unknown>
// Response bodies are asserted field-by-field; keep the fetch helper loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

async function call(method: string, p: string, opts: { bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else headers.Cookie = cookie()
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: unknown = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json: json as Loose }
}

async function mintAgentKey(body: Json): Promise<Json & { token: string; id: number }> {
  const r = await call('POST', '/api/auth/agent-keys', { body })
  expect(r.status).toBe(201)
  return r.json as Json & { token: string; id: number }
}

function seed(workspace: string, status = 'review', title = 'seeded'): number {
  const r = getDb()
    .prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status) VALUES (?, 'cto', ?, ?, ?)`)
    .run(title, workspace, ADMIN_ID, status)
  return Number(r.lastInsertRowid)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'mike', 'x', 'admin')`).run(ADMIN_ID)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/auth', authRouter)
  app.use('/api/objectives', objectivesRouter)
  // Stand-in for an off-surface admin route (secrets, deploy, …).
  app.get('/api/admin/ping', requireAuth, (_req, res) => { res.json({ ok: true }) })
  // Stand-in for /shell: outside /api, admin-gated.
  app.get('/shell', requireAuth, requireAdmin, (_req, res) => { res.json({ ok: true }) })
  // A route the guard does not know but which only checks requireAdmin.
  app.get('/api/sneaky-admin', requireAuth, requireAdmin, (_req, res) => { res.json({ ok: true }) })
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  getDb().prepare('DELETE FROM objective_audit').run()
  resetAgentKeyTouchThrottle()
})

describe('[legacy-key-backcompat] users.api_token_hash key is unchanged', () => {
  it('still authenticates with full access: create, done, delete, off-surface admin route', async () => {
    const minted = await call('POST', '/api/auth/api-key')
    expect(minted.status).toBe(201)
    const legacy = minted.json.token as string

    const me = await call('GET', '/api/auth/me', { bearer: legacy })
    expect(me.status).toBe(200)
    expect(me.json.username).toBe('mike')
    expect(me.json.api_key).toMatchObject({ kind: 'legacy', workspaces: null })
    expect((me.json.api_key as Json).scopes).toContain('board:done')

    const created = await call('POST', '/api/objectives', { bearer: legacy, body: { title: 'legacy card', workspace: 'example' } })
    expect(created.status).toBe(201)
    expect(created.json.origin).toBe('manual')
    expect(created.json.agent_key_label ?? null).toBeNull()

    const id = seed('example2')
    expect((await call('PATCH', `/api/objectives/${id}/status`, { bearer: legacy, body: { status: 'done' } })).status).toBe(200)
    expect((await call('DELETE', `/api/objectives/${created.json.id}`, { bearer: legacy })).status).toBe(200)
    expect((await call('GET', '/api/admin/ping', { bearer: legacy })).status).toBe(200)
    expect((await call('GET', '/api/auth/agent-keys', { bearer: legacy })).status).toBe(200)

    // No audit rows are attributed to an agent key for legacy calls.
    const agentRows = getDb().prepare("SELECT COUNT(*) AS n FROM objective_audit WHERE actor LIKE 'agent_key:%'").get() as { n: number }
    expect(agentRows.n).toBe(0)
  })
})

describe('key management (Settings → You)', () => {
  it('mints with default scopes (no board:done / board:delete), shows plaintext once, lists without it', async () => {
    const key = await mintAgentKey({ label: 'Grok: General' })
    expect(key.token.startsWith('cc_live_')).toBe(true)
    expect(key.token.slice(-4)).toBe(key.last4)
    expect(key.scopes).toEqual(['board:read', 'board:write', 'board:start', 'board:cancel', 'vault:read', 'vault:write'])
    expect(key.workspaces).toBeNull()
    expect(key.last_used_at).toBeNull()

    const listed = await call('GET', '/api/auth/agent-keys')
    expect(listed.status).toBe(200)
    const keys = listed.json.keys as Json[]
    expect(keys.find(k => k.id === key.id)).toMatchObject({ label: 'Grok: General', last4: key.last4 })
    expect(JSON.stringify(listed.json)).not.toContain(key.token)
    expect(JSON.stringify(getDb().prepare('SELECT * FROM agent_api_keys').all())).not.toContain(key.token)
  })

  it('rejects bad input', async () => {
    expect((await call('POST', '/api/auth/agent-keys', { body: {} })).status).toBe(400)
    expect((await call('POST', '/api/auth/agent-keys', { body: { label: 'x', scopes: ['board:root'] } })).status).toBe(400)
    expect((await call('POST', '/api/auth/agent-keys', { body: { label: 'x', scopes: [] } })).status).toBe(400)
    expect((await call('POST', '/api/auth/agent-keys', { body: { label: 'x', workspaces: [] } })).status).toBe(400)
  })

  it('an agent key cannot mint, list or revoke keys', async () => {
    const key = await mintAgentKey({ label: 'Grok: Example' })
    const mint = await call('POST', '/api/auth/agent-keys', { bearer: key.token, body: { label: 'escalate' } })
    expect(mint.status).toBe(403)
    expect((await call('GET', '/api/auth/agent-keys', { bearer: key.token })).status).toBe(403)
    expect((await call('POST', '/api/auth/api-key', { bearer: key.token })).status).toBe(403)
    expect((await call('DELETE', `/api/auth/agent-keys/${key.id}`, { bearer: key.token })).status).toBe(403)
  })
})

describe('[scope-enforcement] server-side scope guardrails', () => {
  it('a default key (no board:done) gets 403 missing_scope on PATCH status=done', async () => {
    const key = await mintAgentKey({ label: 'Grok: Example' })
    const id = seed('example')
    const r = await call('PATCH', `/api/objectives/${id}/status`, { bearer: key.token, body: { status: 'done' } })
    expect(r.status).toBe(403)
    expect(r.json.missing_scope).toBe('board:done')
    expect((getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status).toBe('review')

    // cancelled is its own scope (obj 718417): a key without board:cancel is
    // refused; the default key (which has it) can retire a duplicate.
    const noCancel = await mintAgentKey({ label: 'Grok: no-cancel', scopes: ['board:read', 'board:write'] })
    const refused = await call('PATCH', `/api/objectives/${id}/status`, { bearer: noCancel.token, body: { status: 'cancelled' } })
    expect(refused.status).toBe(403)
    expect(refused.json.missing_scope).toBe('board:cancel')
    const cancel = await call('PATCH', `/api/objectives/${id}/status`, { bearer: key.token, body: { status: 'cancelled' } })
    expect(cancel.status).toBe(200)
    expect((getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status).toBe('cancelled')

    const del = await call('DELETE', `/api/objectives/${id}`, { bearer: key.token })
    expect(del.status).toBe(403)
    expect(del.json.missing_scope).toBe('board:delete')
  })

  it('a key WITH board:done can sign off', async () => {
    const key = await mintAgentKey({ label: 'Grok: Closer', scopes: ['board:read', 'board:done'] })
    const id = seed('example')
    const r = await call('PATCH', `/api/objectives/${id}/status`, { bearer: key.token, body: { status: 'done' } })
    expect(r.status).toBe(200)
    expect(r.json.status).toBe('done')
  })

  it('a key without board:write gets 403 on POST /api/objectives; a board:write key succeeds', async () => {
    const ro = await mintAgentKey({ label: 'Grok: Read Only', scopes: ['board:read'] })
    const denied = await call('POST', '/api/objectives', { bearer: ro.token, body: { title: 'nope', workspace: 'example' } })
    expect(denied.status).toBe(403)
    expect(denied.json.missing_scope).toBe('board:write')
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n).toBe(0)
    // …but it can read.
    expect((await call('GET', '/api/objectives', { bearer: ro.token })).status).toBe(200)

    const rw = await mintAgentKey({ label: 'Grok: Writer', scopes: ['board:read', 'board:write'] })
    const ok = await call('POST', '/api/objectives', { bearer: rw.token, body: { title: 'yes', workspace: 'example' } })
    expect(ok.status).toBe(201)
  })

  it('board:start gates status=working; without board:read the list is 403', async () => {
    const key = await mintAgentKey({ label: 'Grok: No Start', scopes: ['board:write'] })
    const id = seed('example', 'queue')
    const r = await call('PATCH', `/api/objectives/${id}/status`, { bearer: key.token, body: { status: 'working' } })
    expect(r.status).toBe(403)
    expect(r.json.missing_scope).toBe('board:start')
    const list = await call('GET', '/api/objectives', { bearer: key.token })
    expect(list.status).toBe(403)
    expect(list.json.missing_scope).toBe('board:read')
  })

  it('anything off the agent surface is denied even with every scope', async () => {
    const key = await mintAgentKey({
      label: 'Grok: Everything',
      scopes: ['board:read', 'board:write', 'board:start', 'board:done', 'board:delete', 'vault:read', 'vault:write'],
    })
    const r = await call('GET', '/api/admin/ping', { bearer: key.token })
    expect(r.status).toBe(403)
    expect(r.json).toHaveProperty('missing_scope', null)
    // Outside /api too (the admin web terminal lives at /shell).
    expect((await call('GET', '/shell', { bearer: key.token })).status).toBe(403)
    expect((await call('GET', '/api/sneaky-admin', { bearer: key.token })).status).toBe(403)
    // Same routes still work for the human session.
    expect((await call('GET', '/shell')).status).toBe(200)
  })

  it('maps the documented surface to scopes', () => {
    expect(requiredScope('GET', '/api/objectives/12/output', undefined)).toEqual({ kind: 'scope', scope: 'board:read' })
    expect(requiredScope('POST', '/api/objectives/12/message', {})).toEqual({ kind: 'scope', scope: 'board:write' })
    expect(requiredScope('POST', '/api/objectives/12/planning/approve', {})).toEqual({ kind: 'scope', scope: 'board:start' })
    expect(requiredScope('PUT', '/api/docs/file', {})).toEqual({ kind: 'scope', scope: 'vault:write' })
    expect(requiredScope('POST', '/api/kb-wiki/answers', {})).toEqual({ kind: 'scope', scope: 'vault:write' })
    expect(requiredScope('POST', '/api/kb-wiki/rebuild', {})).toEqual({ kind: 'off_surface' })
    expect(requiredScope('GET', '/api/docs/search', undefined)).toEqual({ kind: 'scope', scope: 'vault:read' })
    expect(requiredScope('GET', '/api/secrets', undefined)).toEqual({ kind: 'off_surface' })
    expect(requiredScope('POST', '/api/internal/deploy', {})).toEqual({ kind: 'off_surface' })
  })
})

describe('[workspace-allowlist] a key pinned to one workspace stays in it', () => {
  it('cannot list, read or create in another workspace', async () => {
    const key = await mintAgentKey({ label: 'Grok: Example', workspaces: ['example'] })
    const mine = seed('example', 'review', 'example card')
    const theirs = seed('example2', 'review', 'example2 card')

    // Unfiltered list is narrowed to the allowlist.
    const list = await call('GET', '/api/objectives', { bearer: key.token })
    expect(list.status).toBe(200)
    const ids = (list.json as Json[]).map(o => o.id)
    expect(ids).toContain(mine)
    expect(ids).not.toContain(theirs)
    // ?workspace=all is the same as unfiltered.
    const all = await call('GET', '/api/objectives?workspace=all', { bearer: key.token })
    expect((all.json as Json[]).map(o => o.id)).not.toContain(theirs)

    // Explicitly asking for another workspace is a 403.
    const other = await call('GET', '/api/objectives?workspace=example2', { bearer: key.token })
    expect(other.status).toBe(403)
    expect(other.json.workspace).toBe('example2')
    const multi = await call('GET', '/api/objectives?workspaces=example,example2', { bearer: key.token })
    expect(multi.status).toBe(403)
    expect((await call('GET', '/api/objectives?workspace=example&workspace=example2', { bearer: key.token })).status).toBe(400)

    // Read by id.
    expect((await call('GET', `/api/objectives/${mine}`, { bearer: key.token })).status).toBe(200)
    const read = await call('GET', `/api/objectives/${theirs}`, { bearer: key.token })
    expect(read.status).toBe(403)
    expect(read.json.workspace).toBe('example2')
    expect((await call('GET', `/api/objectives/${theirs}/output`, { bearer: key.token })).status).toBe(403)

    // Create.
    const create = await call('POST', '/api/objectives', { bearer: key.token, body: { title: 'sneak', workspace: 'example2' } })
    expect(create.status).toBe(403)
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM objectives WHERE title = 'sneak'").get() as { n: number }).n).toBe(0)
    // Moving an allowed card into another workspace is also blocked.
    expect((await call('PUT', `/api/objectives/${mine}`, { bearer: key.token, body: { workspace: 'example2' } })).status).toBe(403)

    // No workspace on create → pinned to the key's only workspace.
    const pinned = await call('POST', '/api/objectives', { bearer: key.token, body: { title: 'pinned' } })
    expect(pinned.status).toBe(201)
    expect(pinned.json.workspace).toBe('example')
  })

  it('an unrestricted key still sees every workspace', async () => {
    const key = await mintAgentKey({ label: 'Grok: CoS' })
    const a = seed('example')
    const g = seed('example2')
    const list = await call('GET', '/api/objectives', { bearer: key.token })
    const ids = (list.json as Json[]).map(o => o.id)
    expect(ids).toEqual(expect.arrayContaining([a, g]))
  })
})

describe('[attribution] agent-key calls are attributed to the key label', () => {
  it('create stores origin=agent_api + label, audits it, and GET /:id returns the label', async () => {
    const key = await mintAgentKey({ label: 'Grok: Example', scopes: ['board:read', 'board:write', 'board:done'] })
    const created = await call('POST', '/api/objectives', { bearer: key.token, body: { title: 'from grok', workspace: 'example' } })
    expect(created.status).toBe(201)
    expect(created.json.origin).toBe('agent_api')
    expect(created.json.agent_key_label).toBe('Grok: Example')
    expect(created.json.agent_key_id).toBe(key.id)

    const row = getDb()
      .prepare('SELECT origin, agent_key_id, agent_key_label FROM objectives WHERE id = ?')
      .get(created.json.id) as Json
    expect(row).toEqual({ origin: 'agent_api', agent_key_id: key.id, agent_key_label: 'Grok: Example' })

    const detail = await call('GET', `/api/objectives/${created.json.id}`, { bearer: key.token })
    expect(detail.json.agent_key_label).toBe('Grok: Example')
    // The slim board list carries it too (card chip).
    const list = await call('GET', '/api/objectives')
    expect((list.json as Json[]).find(o => o.id === created.json.id)?.agent_key_label).toBe('Grok: Example')

    // Status change by the key is audited with the label.
    const done = await call('PATCH', `/api/objectives/${created.json.id}/status`, { bearer: key.token, body: { status: 'done' } })
    expect(done.status).toBe(200)

    const audit = getDb()
      .prepare("SELECT event_type, from_status, to_status, actor, pathway FROM objective_audit WHERE objective_id = ? AND actor LIKE 'agent_key:%' ORDER BY id")
      .all(created.json.id) as Json[]
    expect(audit).toEqual([
      { event_type: 'create', from_status: null, to_status: null, actor: `agent_key:${key.id}:Grok: Example`, pathway: 'agent_api POST /api/objectives' },
      {
        event_type: 'status_change',
        from_status: 'queue',
        to_status: 'done',
        actor: `agent_key:${key.id}:Grok: Example`,
        pathway: `agent_api PATCH /api/objectives/${created.json.id}/status`,
      },
    ])
  })

  it('a denied call writes no audit row', async () => {
    const key = await mintAgentKey({ label: 'Grok: Example' })
    const id = seed('example')
    await call('PATCH', `/api/objectives/${id}/status`, { bearer: key.token, body: { status: 'done' } })
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objective_audit').get() as { n: number }).n).toBe(0)
  })

  it('GET /api/auth/me returns the key identity, label and scopes', async () => {
    const key = await mintAgentKey({ label: 'Grok: Example Project', scopes: ['board:read', 'vault:read'], workspaces: ['example-project'] })
    const me = await call('GET', '/api/auth/me', { bearer: key.token })
    expect(me.status).toBe(200)
    expect(me.json.username).toBe('mike')
    expect(me.json.api_key).toEqual({
      kind: 'agent',
      id: key.id,
      label: 'Grok: Example Project',
      scopes: ['board:read', 'vault:read'],
      workspaces: ['example-project'],
    })
    // A browser session gets no api_key block (UI payload unchanged).
    const browser = await call('GET', '/api/auth/me')
    expect(browser.json).not.toHaveProperty('api_key')
  })
})

describe('key lifecycle', () => {
  it('updates last_used_at on use', async () => {
    const key = await mintAgentKey({ label: 'Grok: Inbox' })
    const before = getDb().prepare('SELECT last_used_at FROM agent_api_keys WHERE id = ?').get(key.id) as { last_used_at: string | null }
    expect(before.last_used_at).toBeNull()
    expect((await call('GET', '/api/auth/me', { bearer: key.token })).status).toBe(200)
    const after = getDb().prepare('SELECT last_used_at FROM agent_api_keys WHERE id = ?').get(key.id) as { last_used_at: string | null }
    expect(after.last_used_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const listed = await call('GET', '/api/auth/agent-keys')
    expect((listed.json.keys as Json[]).find(k => k.id === key.id)?.last_used_at).toBe(after.last_used_at)
  })

  it('a revoked key is 401 everywhere; other keys keep working', async () => {
    const doomed = await mintAgentKey({ label: 'Grok: Example Five' })
    const keeper = await mintAgentKey({ label: 'Grok: example3' })
    expect((await call('GET', '/api/auth/me', { bearer: doomed.token })).status).toBe(200)

    const revoke = await call('DELETE', `/api/auth/agent-keys/${doomed.id}`)
    expect(revoke.status).toBe(200)

    const me = await call('GET', '/api/auth/me', { bearer: doomed.token })
    expect(me.status).toBe(401)
    expect((await call('GET', '/api/objectives', { bearer: doomed.token })).status).toBe(401)
    expect((await call('GET', '/api/auth/me', { bearer: keeper.token })).status).toBe(200)

    const listed = await call('GET', '/api/auth/agent-keys')
    expect((listed.json.keys as Json[]).find(k => k.id === doomed.id)?.revoked_at).toBeTruthy()
    expect((await call('DELETE', '/api/auth/agent-keys/99999')).status).toBe(404)
  })

  it('an unknown cc_live_ key is 401', async () => {
    expect((await call('GET', '/api/auth/me', { bearer: 'cc_live_doesnotexist' })).status).toBe(401)
  })
})
