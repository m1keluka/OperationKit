/**
 * obj 900204 — a CARD SESSION reaching its own workspace's knowledge base with
 * the objective-scoped `CC_SESSION_TOKEN` the server mints at spawn.
 *
 * Fixtures only: a throwaway vault tree under os.tmpdir(). Nothing here touches
 * the real knowledge base or any real contact export.
 *
 * Covered, in the order the card asks for them:
 *   1. authorized same-workspace reads (search / stat / download, md + non-md)
 *   2. denial for files outside the workspace, and for another WORKSPACE
 *   3. denial across USERS (acting user not a member of the card's workspace)
 *   4. CHILD sessions — a child card gets its own card's workspace, not its parent's
 *   5. missing-file errors that distinguish INACCESSIBLE (403) from NONEXISTENT (404)
 *   6. traversal and symlink escapes (file link, dir link, `..`), both routers
 *   7. no admin inheritance, no system roots, no `?workspace=` override
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcrypt'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-session-kb-')))
const KB = path.join(TMP, 'vault')
const UPLOADS = path.join(TMP, 'uploads')
const OUTSIDE = path.join(TMP, 'outside')
const SYSROOT = path.join(TMP, 'sysconf')
const TMP_DB = path.join(TMP, 'cc.db')

process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-session-kb-9000'
process.env.SECOND_BRAIN_ROOT = KB
process.env.CC_FILE_ROOTS = JSON.stringify([
  { id: 'vault', path: KB, kind: 'vault' },
  { id: 'uploads', path: UPLOADS, kind: 'uploads' },
])
process.env.CC_FILE_SHARED_PATHS = ''
process.env.CC_SYSTEM_FILE_ROOTS = JSON.stringify([{ id: 'svc', path: SYSROOT, workspaces: ['example'] }])
process.env.CC_FILES_RATE_PER_MIN = '1000'
process.env.CC_FILES_DOWNLOAD_RATE_PER_MIN = '1000'

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace, invalidateWorkspacesCache } = await import('../services/workspaces.js')
const { mintSessionToken, SESSION_KB_ACCESS_FLAG } = await import('../lib/session-trust.js')
const { resetRateLimits } = await import('../services/file-access.js')
const { default: filesRouter } = await import('./files.js')
const { default: docsRouter } = await import('./docs.js')

let server: http.Server
let baseUrl: string
/** example card (parent), its child card, and a example2 card. */
let exampleObj: number
let childObj: number
let example2Obj: number
/** A card whose acting user is NOT a member of its workspace. */
let strangerObj: number
let mikeId: number
let avaId: number
let bobId: number

function write(p: string, body: string | Buffer = 'x'): string {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}

const F = {
  // example — the card's own workspace
  exampleCsv: path.join(KB, 'workspaces/example/data/linkedin-connections-2026-09-03/Connections.csv'),
  examplePdf: path.join(KB, 'workspaces/example/reports/q3.pdf'),
  exampleNote: path.join(KB, 'workspaces/example/notes/playbook.md'),
  exampleDecisionsDir: path.join(KB, 'workspaces/example/decisions'),
  // example2 — another workspace
  example2Csv: path.join(KB, 'workspaces/example2/data/example2-leads.csv'),
  example2Note: path.join(KB, 'workspaces/example2/notes/private.md'),
  // outside every root
  outsideCsv: path.join(OUTSIDE, 'payroll.csv'),
  outsideNote: path.join(OUTSIDE, 'payroll.md'),
  // escapes planted INSIDE the example subtree
  escapeFile: path.join(KB, 'workspaces/example/escape.csv'),
  escapeDir: path.join(KB, 'workspaces/example/escape-dir'),
  escapeNote: path.join(KB, 'workspaces/example/leak.md'),
  escapeNoteDir: path.join(KB, 'workspaces/example/leak-dir'),
  // system root
  sysFile: path.join(SYSROOT, 'docker-compose.yml'),
}

const CSV = 'First Name,Last Name,Company\nFixture,Person,Acme\n'

function hdr(token: string) {
  return { 'X-CC-Session-Token': token }
}

async function get(p: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${p}`, { headers })
}

function tok(objectiveId: number, workspace: string, actingUserId: number | null): string {
  return mintSessionToken({ objectiveId, workspace, actingUserId })
}

let exampleToken: string
let childToken: string
let example2Token: string
let strangerToken: string

beforeAll(async () => {
  write(F.exampleCsv, CSV)
  write(F.examplePdf, '%PDF-1.7 example')
  write(F.exampleNote, '# playbook\n')
  write(F.example2Csv, 'do,not,leak\n')
  write(F.example2Note, '# private\n')
  write(F.outsideCsv, 'ssn,salary\n')
  write(F.outsideNote, '# payroll\n')
  write(F.sysFile, 'services: {}\n')
  fs.symlinkSync(F.outsideCsv, F.escapeFile)
  fs.symlinkSync(OUTSIDE, F.escapeDir)
  fs.symlinkSync(F.outsideNote, F.escapeNote)
  fs.symlinkSync(OUTSIDE, F.escapeNoteDir)

  initDb()
  const db = getDb()
  db.prepare('DELETE FROM workspaces').run()
  invalidateWorkspacesCache()
  createWorkspace({
    slug: 'example', name: 'Example',
    doc_read_roots: [path.join(KB, 'workspaces/example')],
    doc_write_roots: [path.join(KB, 'workspaces/example')],
  })
  createWorkspace({
    slug: 'example2', name: 'Example3',
    doc_read_roots: [path.join(KB, 'workspaces/example2')],
    doc_write_roots: [path.join(KB, 'workspaces/example2')],
  })

  const hash = bcrypt.hashSync('pw', 4)
  // Mike is an ADMIN. A card of his must still NOT inherit admin-wide file access.
  mikeId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('mike', hash, 'admin').lastInsertRowid)
  avaId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('ava', hash, 'member').lastInsertRowid)
  bobId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('bob', hash, 'member').lastInsertRowid)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'example', 'member')`).run(avaId)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'example2', 'member')`).run(bobId)

  const ins = db.prepare(`INSERT INTO objectives (title, workspace, agent_context) VALUES (?, ?, 'general')`)
  exampleObj = Number(ins.run('example card', 'example').lastInsertRowid)
  childObj = Number(ins.run('child of example card', 'example').lastInsertRowid)
  example2Obj = Number(ins.run('example2 card', 'example2').lastInsertRowid)
  strangerObj = Number(ins.run('example2 card run by ava', 'example2').lastInsertRowid)

  exampleToken = tok(exampleObj, 'example', mikeId)
  childToken = tok(childObj, 'example', avaId)
  example2Token = tok(example2Obj, 'example2', bobId)
  strangerToken = tok(strangerObj, 'example2', avaId) // ava is not in example2

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/files', filesRouter)
  app.use('/api/docs', docsRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  resetRateLimits()
  try { getDb().prepare('DELETE FROM settings WHERE key = ?').run(SESSION_KB_ACCESS_FLAG) } catch { /* no table */ }
})

type SearchBody = { results: Array<{ path: string; workspace: string | null; root: string }>; total: number }

// ── 1. Authorized same-workspace reads ──────────────────────────────────────

describe('authorized same-workspace reads', () => {
  it('finds a non-markdown file in its OWN workspace by name', async () => {
    const res = await get('/api/files/search?q=connections&ext=csv', hdr(exampleToken))
    expect(res.status).toBe(200)
    const body = await res.json() as SearchBody
    expect(body.results.map(r => r.path)).toEqual([F.exampleCsv])
    expect(body.results[0].workspace).toBe('example')
  })

  it('stats and downloads that file', async () => {
    const stat = await get(`/api/files/stat?path=${encodeURIComponent(F.exampleCsv)}`, hdr(exampleToken))
    expect(stat.status).toBe(200)
    expect(await stat.json()).toMatchObject({ workspace: 'example', size: CSV.length, downloadable: true })

    const dl = await get(`/api/files/download?path=${encodeURIComponent(F.exampleCsv)}`, hdr(exampleToken))
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe(CSV)
  })

  it('supports a Range read so a big export can be sampled', async () => {
    const res = await get(`/api/files/download?path=${encodeURIComponent(F.exampleCsv)}`, { ...hdr(exampleToken), Range: 'bytes=0-9' })
    expect(res.status).toBe(206)
    expect(await res.text()).toBe(CSV.slice(0, 10))
  })

  it('reads a MARKDOWN note in its own workspace via /api/docs', async () => {
    const res = await get(`/api/docs/file?path=${encodeURIComponent(F.exampleNote)}`, hdr(exampleToken))
    expect(res.status).toBe(200)
    expect((await res.json() as { content: string }).content).toBe('# playbook\n')
  })

  it('lists its own workspace folder and nothing else via /api/docs/tree', async () => {
    const res = await get('/api/docs/tree', hdr(exampleToken))
    expect(res.status).toBe(200)
    const body = await res.json() as { roots: string[] }
    expect(body.roots).toEqual([path.join(KB, 'workspaces/example')])
  })

  it('can write its vault-capture decision doc, creating decisions/ on the way', async () => {
    expect(fs.existsSync(F.exampleDecisionsDir)).toBe(false)
    const target = path.join(F.exampleDecisionsDir, '2026-11-05-fixture.md')
    const res = await fetch(`${baseUrl}/api/docs/file`, {
      method: 'PUT',
      headers: { ...hdr(exampleToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: target, content: '# decision\n', create_dirs: true }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    expect(fs.readFileSync(target, 'utf8')).toBe('# decision\n')
    fs.rmSync(F.exampleDecisionsDir, { recursive: true, force: true })
  })
})

// ── 2/3. Denial: other workspaces, other users ──────────────────────────────

describe('denial for unauthorized workspaces and users', () => {
  it('a example2 file is invisible to an example card — search omits it', async () => {
    const body = await (await get('/api/files/search?ext=csv', hdr(exampleToken))).json() as SearchBody
    expect(body.results.map(r => r.path)).toEqual([F.exampleCsv])
  })

  it('a example2 file is 403, not 404, for an example card (both routers)', async () => {
    expect((await get(`/api/files/stat?path=${encodeURIComponent(F.example2Csv)}`, hdr(exampleToken))).status).toBe(403)
    expect((await get(`/api/files/download?path=${encodeURIComponent(F.example2Csv)}`, hdr(exampleToken))).status).toBe(403)
    expect((await get(`/api/docs/file?path=${encodeURIComponent(F.example2Note)}`, hdr(exampleToken))).status).toBe(403)
  })

  it('and symmetrically, a example2 card cannot see example', async () => {
    expect((await get(`/api/files/stat?path=${encodeURIComponent(F.exampleCsv)}`, hdr(example2Token))).status).toBe(403)
    const body = await (await get('/api/files/search?ext=csv', hdr(example2Token))).json() as SearchBody
    expect(body.results.map(r => r.path)).toEqual([F.example2Csv])
  })

  it('rejects a ?workspace= override naming someone else', async () => {
    const res = await get('/api/files/search?ext=csv&workspace=example2', hdr(exampleToken))
    expect(res.status).toBe(403)
    expect((await res.json() as { error: string }).error).toContain('example2')
  })

  it('accepts ?workspace= naming its OWN workspace (and `all`)', async () => {
    expect((await get('/api/files/search?ext=csv&workspace=example', hdr(exampleToken))).status).toBe(200)
    expect((await get('/api/files/search?ext=csv&workspace=all', hdr(exampleToken))).status).toBe(200)
  })

  it('403s a card whose ACTING USER is not a member of the card workspace', async () => {
    const res = await get('/api/files/search?ext=csv', hdr(strangerToken))
    expect(res.status).toBe(403)
    expect((await res.json() as { code: string }).code).toBe('workspace_forbidden')
  })

  it('an admin acting user grants NO admin-wide access — only the card workspace', async () => {
    // exampleToken's acting user is `mike`, role admin.
    const body = await (await get('/api/files/search?ext=csv', hdr(exampleToken))).json() as SearchBody
    expect(body.results.map(r => r.path)).toEqual([F.exampleCsv])
    expect((await get(`/api/files/stat?path=${encodeURIComponent(F.example2Csv)}`, hdr(exampleToken))).status).toBe(403)
    const tree = await (await get('/api/docs/tree', hdr(exampleToken))).json() as { roots: string[] }
    expect(tree.roots).toEqual([path.join(KB, 'workspaces/example')])
  })

  it('never serves a SYSTEM root (service configs / logs), even tagged for the workspace', async () => {
    const body = await (await get('/api/files/search?q=docker-compose&system=1', hdr(exampleToken))).json() as SearchBody
    expect(body.results).toEqual([])
    expect((await get(`/api/files/stat?path=${encodeURIComponent(F.sysFile)}`, hdr(exampleToken))).status).toBe(403)
  })
})

// ── 4. Child sessions ───────────────────────────────────────────────────────

describe('child sessions', () => {
  it('a child card reads its own workspace with its own token', async () => {
    const res = await get(`/api/files/stat?path=${encodeURIComponent(F.exampleCsv)}`, hdr(childToken))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ workspace: 'example' })
  })

  it('a child card is scoped by ITS OWN objective row, not by the token claim', async () => {
    // A token that claims 'example' but whose objective row says 'example2' must follow
    // the row. This is also what happens when a card is MOVED between workspaces.
    const lying = tok(example2Obj, 'example', bobId)
    expect((await get(`/api/files/stat?path=${encodeURIComponent(F.exampleCsv)}`, hdr(lying))).status).toBe(403)
    expect((await get(`/api/files/stat?path=${encodeURIComponent(F.example2Csv)}`, hdr(lying))).status).toBe(200)
  })

  it('a token for a deleted card is refused', async () => {
    const db = getDb()
    const gone = Number(db.prepare(`INSERT INTO objectives (title, workspace, agent_context) VALUES ('gone', 'example', 'general')`).run().lastInsertRowid)
    const t = tok(gone, 'example', avaId)
    db.prepare('DELETE FROM objectives WHERE id = ?').run(gone)
    const res = await get('/api/files/search?ext=csv', hdr(t))
    expect(res.status).toBe(401)
    expect((await res.json() as { code: string }).code).toBe('bad_session_token')
  })
})

// ── 5. Missing-file errors: inaccessible vs nonexistent ─────────────────────

describe('missing-file errors distinguish inaccessible from nonexistent', () => {
  it('404 for a path INSIDE the card workspace that does not exist', async () => {
    const missing = path.join(KB, 'workspaces/example/data/nope.csv')
    const res = await get(`/api/files/stat?path=${encodeURIComponent(missing)}`, hdr(exampleToken))
    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toBe('File not found')
  })

  it('403 for a path OUTSIDE the card workspace — existent or not, the same answer', async () => {
    const realOther = await get(`/api/files/stat?path=${encodeURIComponent(F.example2Csv)}`, hdr(exampleToken))
    const fakeOther = await get(`/api/files/stat?path=${encodeURIComponent(path.join(KB, 'workspaces/example2/data/nope.csv'))}`, hdr(exampleToken))
    expect(realOther.status).toBe(403)
    expect(fakeOther.status).toBe(403)
    // Identical bodies: the 403 must not become an existence oracle for another workspace.
    expect(await realOther.json()).toEqual(await fakeOther.json())
  })

  it('/api/docs mirrors the split: 404 in-scope-missing, 403 out-of-scope', async () => {
    const missing = await get(`/api/docs/file?path=${encodeURIComponent(path.join(KB, 'workspaces/example/notes/nope.md'))}`, hdr(exampleToken))
    expect(missing.status).toBe(404)
    expect((await missing.json() as { error: string }).error).toBe('File not found')
    const forbidden = await get(`/api/docs/file?path=${encodeURIComponent(F.example2Note)}`, hdr(exampleToken))
    expect(forbidden.status).toBe(403)
    expect((await forbidden.json() as { error: string }).error).toBe('Path not allowed')
  })
})

// ── 6. Traversal and symlink escapes ────────────────────────────────────────

describe('traversal and symlink escapes', () => {
  it('rejects `..` out of the workspace', async () => {
    const climb = path.join(KB, 'workspaces/example/../example2/data/example2-leads.csv')
    expect((await get(`/api/files/stat?path=${encodeURIComponent(climb)}`, hdr(exampleToken))).status).toBe(403)
    expect((await get(`/api/docs/file?path=${encodeURIComponent(path.join(KB, 'workspaces/example/../example2/notes/private.md'))}`, hdr(exampleToken))).status).toBe(403)
  })

  it('rejects a FILE symlink pointing out of the root (/api/files)', async () => {
    expect((await get(`/api/files/stat?path=${encodeURIComponent(F.escapeFile)}`, hdr(exampleToken))).status).toBe(403)
    expect((await get(`/api/files/download?path=${encodeURIComponent(F.escapeFile)}`, hdr(exampleToken))).status).toBe(403)
  })

  it('rejects a DIRECTORY symlink pointing out of the root (/api/files)', async () => {
    const through = path.join(F.escapeDir, 'payroll.csv')
    expect((await get(`/api/files/stat?path=${encodeURIComponent(through)}`, hdr(exampleToken))).status).toBe(403)
  })

  it('rejects a FILE symlink pointing out of the root (/api/docs)', async () => {
    const res = await get(`/api/docs/file?path=${encodeURIComponent(F.escapeNote)}`, hdr(exampleToken))
    expect(res.status).toBe(403)
  })

  it('rejects a DIRECTORY symlink pointing out of the root (/api/docs)', async () => {
    const through = path.join(F.escapeNoteDir, 'payroll.md')
    expect((await get(`/api/docs/file?path=${encodeURIComponent(through)}`, hdr(exampleToken))).status).toBe(403)
  })

  it('refuses to WRITE through a symlink that leaves the write root', async () => {
    const res = await fetch(`${baseUrl}/api/docs/file`, {
      method: 'PUT',
      headers: { ...hdr(exampleToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: path.join(F.escapeNoteDir, 'injected.md'), content: 'pwn', create_dirs: true }),
    })
    expect(res.status).toBe(403)
    expect(fs.existsSync(path.join(OUTSIDE, 'injected.md'))).toBe(false)
  })

  it('never serves a file outside every root', async () => {
    expect((await get(`/api/files/stat?path=${encodeURIComponent(F.outsideCsv)}`, hdr(exampleToken))).status).toBe(403)
    expect((await get(`/api/docs/file?path=${encodeURIComponent(F.outsideNote)}`, hdr(exampleToken))).status).toBe(403)
  })
})

// ── 7. Token handling and the kill switch ───────────────────────────────────

describe('token handling', () => {
  it('401s a forged / malformed token rather than falling through to requireAuth', async () => {
    for (const bad of ['ccs_nope.nope', 'ccs_' + Buffer.from('{}').toString('base64url') + '.x']) {
      const res = await get('/api/files/search?ext=csv', { 'X-CC-Session-Token': bad })
      expect(res.status).toBe(401)
      expect((await res.json() as { code?: string }).code).toBe('bad_session_token')
    }
  })

  it('401s an EXPIRED token', async () => {
    const { mintSessionToken: mint } = await import('../lib/session-trust.js')
    const expired = mint({ objectiveId: exampleObj, workspace: 'example', actingUserId: avaId }, Date.now() - 10_000, 1)
    expect((await get('/api/files/search?ext=csv', { 'X-CC-Session-Token': expired })).status).toBe(401)
  })

  it('accepts the token as `Authorization: Bearer ccs_…` too', async () => {
    const res = await get('/api/files/search?q=connections&ext=csv', { Authorization: `Bearer ${exampleToken}` })
    expect(res.status).toBe(200)
  })

  it('still 401s a caller with NO credential at all', async () => {
    expect((await get('/api/files/search?ext=csv')).status).toBe(401)
    expect((await get('/api/docs/tree')).status).toBe(401)
  })

  it('403s every session token when session_kb_access is turned off', async () => {
    getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, '0')
                     ON CONFLICT(key) DO UPDATE SET value = '0'`).run(SESSION_KB_ACCESS_FLAG)
    const res = await get('/api/files/search?ext=csv', hdr(exampleToken))
    expect(res.status).toBe(403)
    expect((await res.json() as { code: string }).code).toBe('session_kb_disabled')
  })
})
