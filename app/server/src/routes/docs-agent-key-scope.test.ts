/**
 * obj 900021 — the doc routes (and the MCP tools that forward to them) honour
 * the agent key's WORKSPACE list, an admin's key included.
 *
 * The repro from the card: an admin mints a key with vault:write and
 * workspaces = [example, operationkit], then calls MCP write_doc / PUT
 * /api/docs/file on `workspaces/your-org/zz-scope-test.md`. Before the fix
 * the file was written (the admin roots are the whole vault). Now: 403
 * `workspace_not_allowed`, and nothing lands on disk.
 *
 * Fixtures only: a throwaway vault + DB under os.tmpdir(). Routers are mounted
 * behind the real agentKeyGuard, the same order index.ts uses, and MCP calls go
 * MCP → loopback → guard → /api/docs exactly as in production.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-keyscope-')))
const VAULT = path.join(TMP, 'vault')
const OUTSIDE = path.join(TMP, 'outside')
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'test-secret-docs-keyscope'
process.env.SECOND_BRAIN_ROOT = VAULT
process.env.CC_FILE_ROOTS = JSON.stringify([{ id: 'vault', path: VAULT, kind: 'vault' }])
process.env.CC_FILE_SHARED_PATHS = ''

const { initDb, getDb } = await import('../db/index.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { createWorkspace, invalidateWorkspacesCache } = await import('../services/workspaces.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { workspaceOfPath } = await import('../lib/doc-path-workspace.js')
const { default: docsRouter } = await import('./docs.js')
const { default: filesRouter } = await import('./files.js')
const { default: agentMcpRouter } = await import('./agent-mcp.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN_ID = 1
const MEMBER_ID = 2
const ws = (slug: string, ...rest: string[]) => path.join(VAULT, 'workspaces', slug, ...rest)

let server: http.Server
let baseUrl: string
/** Admin-owned key pinned to [example, operationkit] — the card's repro key. */
let scopedKey: string
/** Admin-owned key with workspaces = null (every workspace). */
let unscopedKey: string
/** Admin-owned key pinned to [example] only. */
let exampleOnlyKey: string
/** Member-owned key, member of example + your-org, key pinned to [example]. */
let memberKey: string
let sessionToken: string

const adminCookie = () =>
  `token=${jwt.sign({ id: ADMIN_ID, username: 'operator', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

function mint(owner: { id: number; role: 'admin' | 'member' }, label: string, workspaces: string[] | null): string {
  const r = createAgentKey(owner, { label, scopes: ['vault:read', 'vault:write'], workspaces })
  if (!r.ok) throw new Error(r.error)
  return r.key.token
}

function write(p: string, body = '# note\n'): string {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}

async function call(method: string, p: string, opts: { bearer?: string; cookie?: boolean; session?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  if (opts.cookie) headers.Cookie = adminCookie()
  if (opts.session) headers['X-CC-Session-Token'] = opts.session
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

const put = (filePath: string, opts: { bearer?: string; cookie?: boolean; session?: string; createDirs?: boolean } = {}) =>
  call('PUT', '/api/docs/file', { ...opts, body: { path: filePath, content: '# written\n', ...(opts.createDirs ? { create_dirs: true } : {}) } })
const read = (filePath: string, opts: { bearer?: string; cookie?: boolean; session?: string } = {}) =>
  call('GET', `/api/docs/file?path=${encodeURIComponent(filePath)}`, opts)

let rpcId = 1
async function mcpTool(name: string, args: Record<string, unknown>, bearer: string) {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  const json = await res.json() as Loose
  const result = json.result as { content: { text: string }[]; isError?: boolean }
  return { isError: !!result.isError, text: result.content[0]?.text ?? '' }
}

beforeAll(async () => {
  write(ws('example', 'active.md'), '# example active\nscopeprobe example\n')
  write(ws('operationkit', 'active.md'), '# opkit active\nscopeprobe operationkit\n')
  write(ws('your-org', 'secret.md'), '# growth secret\nscopeprobe your-org\n')
  write(path.join(VAULT, 'inbox.md'), '# vault root note\nscopeprobe root\n')
  write(path.join(OUTSIDE, 'payroll.md'), '# payroll\n')
  fs.mkdirSync(ws('example', 'notes'), { recursive: true })
  // Escapes planted INSIDE an allowed workspace, pointing at a forbidden one.
  fs.symlinkSync(ws('your-org'), ws('example', 'growth-link'))
  fs.symlinkSync(ws('your-org', 'secret.md'), ws('example', 'secret-link.md'))
  // Nested-name spoof: a folder named workspaces/example inside your-org.
  write(ws('your-org', 'notes', 'workspaces', 'example', 'spoof.md'))

  initDb()
  const db = getDb()
  db.prepare('DELETE FROM workspaces').run()
  invalidateWorkspacesCache()
  // Mirror the real install: the admin's doc_write_roots on a workspace can be
  // the WHOLE vault — the reason a path check alone never stopped the repro.
  createWorkspace({ slug: 'example', name: 'Example', doc_read_roots: [VAULT], doc_write_roots: [VAULT] })
  createWorkspace({ slug: 'operationkit', name: 'OperationKit', doc_read_roots: [ws('operationkit')], doc_write_roots: [ws('operationkit')] })
  createWorkspace({ slug: 'your-org', name: 'Example Growth', doc_read_roots: [ws('your-org')], doc_write_roots: [ws('your-org')] })

  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(ADMIN_ID)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'casey', 'x', 'member')`).run(MEMBER_ID)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'example', 'member')`).run(MEMBER_ID)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'your-org', 'member')`).run(MEMBER_ID)

  scopedKey = mint({ id: ADMIN_ID, role: 'admin' }, 'scoped [example, operationkit]', ['example', 'operationkit'])
  unscopedKey = mint({ id: ADMIN_ID, role: 'admin' }, 'unscoped', null)
  exampleOnlyKey = mint({ id: ADMIN_ID, role: 'admin' }, 'example only', ['example'])
  memberKey = mint({ id: MEMBER_ID, role: 'member' }, 'member example only', ['example'])

  const objId = Number(db.prepare(`INSERT INTO objectives (title, workspace, agent_context) VALUES ('opkit card', 'operationkit', 'general')`).run().lastInsertRowid)
  sessionToken = mintSessionToken({ objectiveId: objId, workspace: 'operationkit', actingUserId: ADMIN_ID })

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/docs', docsRouter)
  app.use('/api/files', filesRouter)
  app.use('/api', agentMcpRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

// ── The repro ────────────────────────────────────────────────────────────────

describe('repro: key [example, operationkit] cannot write under workspaces/your-org/', () => {
  const target = ws('your-org', 'zz-scope-test.md')

  it('PUT /api/docs/file → 403 workspace_not_allowed, nothing written', async () => {
    const r = await put(target, { bearer: scopedKey })
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('workspace_not_allowed')
    expect(r.json.error).toMatch(/Workspace not allowed/)
    expect(r.json.workspace).toBe('your-org')
    expect(r.json.allowed_workspaces).toEqual(['example', 'operationkit'])
    expect(fs.existsSync(target)).toBe(false)
  })

  it('create_dirs does not create a folder in the forbidden workspace', async () => {
    const deep = ws('your-org', 'new-dir', 'zz.md')
    const r = await put(deep, { bearer: scopedKey, createDirs: true })
    expect(r.status).toBe(403)
    expect(fs.existsSync(path.dirname(deep))).toBe(false)
  })

  it('overwriting an EXISTING note in the forbidden workspace is refused too', async () => {
    const r = await put(ws('your-org', 'secret.md'), { bearer: scopedKey })
    expect(r.status).toBe(403)
    expect(fs.readFileSync(ws('your-org', 'secret.md'), 'utf8')).toContain('growth secret')
  })

  it('MCP write_doc → tool error, nothing written', async () => {
    const r = await mcpTool('write_doc', { path: target, content: '# x\n' }, scopedKey)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/Workspace not allowed|403/)
    expect(fs.existsSync(target)).toBe(false)
  })

  it('a member-owned key is limited by its list even inside the member\'s own workspaces', async () => {
    const r = await put(target, { bearer: memberKey })
    expect(r.status).toBe(403)
    expect(fs.existsSync(target)).toBe(false)
  })
})

// ── In-scope writes still work ───────────────────────────────────────────────

describe('in-scope writes still succeed', () => {
  it('PUT into each workspace on the key', async () => {
    for (const p of [ws('example', 'decisions', 'a.md'), ws('operationkit', 'decisions', 'b.md')]) {
      const r = await put(p, { bearer: scopedKey, createDirs: true })
      expect(r.status).toBe(200)
      expect(r.json.ok).toBe(true)
      expect(fs.readFileSync(p, 'utf8')).toBe('# written\n')
    }
  })

  it('MCP write_doc into an allowed workspace', async () => {
    const p = ws('operationkit', 'mcp-write.md')
    const r = await mcpTool('write_doc', { path: p, content: '# via mcp\n' }, scopedKey)
    expect(r.isError).toBe(false)
    expect(fs.readFileSync(p, 'utf8')).toBe('# via mcp\n')
  })

  it('member key writes in its own allowed workspace', async () => {
    const p = ws('example', 'member.md')
    const r = await put(p, { bearer: memberKey })
    expect(r.status).toBe(200)
  })

  it('unscoped admin key is unchanged: may write any workspace and the vault root', async () => {
    expect((await put(ws('your-org', 'unscoped.md'), { bearer: unscopedKey })).status).toBe(200)
    expect((await put(path.join(VAULT, 'unscoped-root.md'), { bearer: unscopedKey })).status).toBe(200)
  })

  it('admin cookie session is unchanged', async () => {
    expect((await put(ws('your-org', 'cookie.md'), { cookie: true })).status).toBe(200)
  })

  it('card-session (CC_SESSION_TOKEN) writes are unchanged: own workspace yes, other workspace no', async () => {
    const own = await put(ws('operationkit', 'decisions', 'session.md'), { session: sessionToken, createDirs: true })
    expect(own.status).toBe(200)
    const other = await put(ws('example', 'session-other.md'), { session: sessionToken })
    expect(other.status).toBe(403)
    expect(fs.existsSync(ws('example', 'session-other.md'))).toBe(false)
  })
})

// ── Reads / list / search by path ────────────────────────────────────────────

describe('path reads, list and search honour the key', () => {
  it('GET /api/docs/file: forbidden workspace → 403, allowed → 200', async () => {
    const no = await read(ws('your-org', 'secret.md'), { bearer: scopedKey })
    expect(no.status).toBe(403)
    expect(no.json.code).toBe('workspace_not_allowed')
    expect(JSON.stringify(no.json)).not.toContain('growth secret')
    const yes = await read(ws('example', 'active.md'), { bearer: scopedKey })
    expect(yes.status).toBe(200)
    expect(yes.json.writable).toBe(true)
  })

  it('a missing file in a forbidden workspace is 403, not 404 (no existence oracle)', async () => {
    expect((await read(ws('your-org', 'nope.md'), { bearer: scopedKey })).status).toBe(403)
    expect((await read(ws('example', 'nope.md'), { bearer: scopedKey })).status).toBe(404)
  })

  it('MCP read_file on a forbidden workspace is an error', async () => {
    const r = await mcpTool('read_file', { path: ws('your-org', 'secret.md') }, scopedKey)
    expect(r.isError).toBe(true)
    expect(r.text).not.toContain('growth secret')
  })

  it('a vault-root note (inside no workspace) is refused for a scoped key', async () => {
    expect((await read(path.join(VAULT, 'inbox.md'), { bearer: scopedKey })).status).toBe(403)
    expect((await put(path.join(VAULT, 'zz-root.md'), { bearer: scopedKey })).status).toBe(403)
    expect(fs.existsSync(path.join(VAULT, 'zz-root.md'))).toBe(false)
  })

  it('GET /api/docs/tree lists only the key\'s workspace folders', async () => {
    const r = await call('GET', '/api/docs/tree', { bearer: scopedKey })
    expect(r.status).toBe(200)
    expect([...r.json.roots].sort()).toEqual([ws('example'), ws('operationkit')])
    const flat = JSON.stringify(r.json.tree)
    expect(flat).not.toContain('your-org')
    for (const w of r.json.writeRoots as string[]) expect(w).not.toContain('your-org')
    expect(r.json.writeRoots).not.toContain(VAULT)
  })

  it('GET /api/docs/tree?root=<forbidden workspace> → 403', async () => {
    const r = await call('GET', `/api/docs/tree?root=${encodeURIComponent(ws('your-org'))}`, { bearer: scopedKey })
    expect(r.status).toBe(403)
  })

  it('GET /api/docs/search never returns another workspace\'s note', async () => {
    const all = await call('GET', '/api/docs/search?q=scopeprobe&limit=20', { bearer: scopedKey })
    expect(all.status).toBe(200)
    const paths = (all.json.results as { path: string }[]).map(h => h.path)
    expect(paths.some(p => p.includes(`${path.sep}your-org${path.sep}`))).toBe(false)
    expect(paths).not.toContain(path.join(VAULT, 'inbox.md'))
    // The unscoped key still sees it (proves the fixture is searchable).
    const wide = await call('GET', '/api/docs/search?q=scopeprobe&limit=20', { bearer: unscopedKey })
    expect((wide.json.results as { path: string }[]).map(h => h.path)).toContain(ws('your-org', 'secret.md'))
  })

  it('GET /api/docs/search?workspace=<forbidden> → 403', async () => {
    const r = await call('GET', '/api/docs/search?q=scopeprobe&workspace=your-org', { bearer: scopedKey })
    expect(r.status).toBe(403)
  })
})

// ── Traversal and symlink escapes ────────────────────────────────────────────

describe('traversal and symlink escapes are rejected', () => {
  it('`..` out of an allowed workspace into a forbidden one', async () => {
    const sneaky = `${ws('example')}/../your-org/zz-traversal.md`
    const r = await put(sneaky, { bearer: scopedKey })
    expect(r.status).toBe(403)
    expect(fs.existsSync(ws('your-org', 'zz-traversal.md'))).toBe(false)
    expect((await read(`${ws('example')}/../your-org/secret.md`, { bearer: scopedKey })).status).toBe(403)
  })

  it('a directory symlink inside example that points at your-org', async () => {
    const r = await put(ws('example', 'growth-link', 'zz-link.md'), { bearer: scopedKey })
    expect(r.status).toBe(403)
    expect(fs.existsSync(ws('your-org', 'zz-link.md'))).toBe(false)
  })

  it('a file symlink inside example that points at an your-org note', async () => {
    expect((await read(ws('example', 'secret-link.md'), { bearer: scopedKey })).status).toBe(403)
    expect((await put(ws('example', 'secret-link.md'), { bearer: scopedKey })).status).toBe(403)
    expect(fs.readFileSync(ws('your-org', 'secret.md'), 'utf8')).toContain('growth secret')
  })

  it('a nested `workspaces/example` folder inside your-org is ambiguous → refused', async () => {
    const spoof = ws('your-org', 'notes', 'workspaces', 'example', 'spoof.md')
    const r = await read(spoof, { bearer: exampleOnlyKey })
    expect(r.status).toBe(403)
    expect(r.json.reason).toBe('ambiguous')
    expect((await put(spoof, { bearer: exampleOnlyKey })).status).toBe(403)
  })
})

// ── Sibling routes: confirmed already enforced, no change (obj 900627) ───────

describe('/api/files already honours the key list (no change in this PR)', () => {
  it('?workspace=<forbidden> → 403 from the guard', async () => {
    const r = await call('GET', '/api/files/search?q=secret&workspace=your-org', { bearer: scopedKey })
    expect(r.status).toBe(403)
    expect(r.json.allowed_workspaces).toEqual(['example', 'operationkit'])
  })

  it('an allowed ?workspace= cannot reach a path in another workspace', async () => {
    const r = await call('GET', `/api/files/stat?workspace=example&path=${encodeURIComponent(ws('your-org', 'secret.md'))}`, { bearer: scopedKey })
    expect([403, 404]).toContain(r.status)
    expect(JSON.stringify(r.json)).not.toContain('growth secret')
  })
})

describe('workspaceOfPath', () => {
  it('resolves workspace folders, refuses roots and ambiguity', () => {
    expect(workspaceOfPath(ws('example', 'x.md'))).toMatchObject({ ok: true, workspace: 'example' })
    expect(workspaceOfPath(ws('your-org', 'x.md'))).toMatchObject({ ok: true, workspace: 'your-org' })
    expect(workspaceOfPath(path.join(VAULT, 'inbox.md'))).toMatchObject({ ok: false, reason: 'outside_workspace' })
    expect(workspaceOfPath(path.join(OUTSIDE, 'payroll.md'))).toMatchObject({ ok: false, reason: 'outside_workspace' })
    expect(workspaceOfPath(ws('example', 'growth-link', 'x.md'))).toMatchObject({ ok: true, workspace: 'your-org' })
    expect(workspaceOfPath(ws('your-org', 'notes', 'workspaces', 'example', 'spoof.md'))).toMatchObject({ ok: false, reason: 'ambiguous' })
    expect(workspaceOfPath('relative\0bad')).toMatchObject({ ok: false })
  })
})
