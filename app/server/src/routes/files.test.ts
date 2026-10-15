/**
 * /api/files — read-only, workspace-scoped search/stat/download (obj 715485).
 * Builds a throwaway vault + uploads tree under os.tmpdir(), points the
 * allowlist at it via CC_FILE_ROOTS, and drives the real router over HTTP
 * with real cc_live_ API keys.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcrypt'

const TMP_DB = path.join(os.tmpdir(), `cc-files-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-files-api-xxxx'

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-files-')))
const VAULT = path.join(BASE, 'vault')
const UPLOADS = path.join(BASE, 'uploads')
const OUTSIDE = path.join(BASE, 'outside')
process.env.CC_FILE_ROOTS = JSON.stringify([
  { id: 'vault', path: VAULT, kind: 'vault' },
  { id: 'uploads', path: UPLOADS, kind: 'uploads' },
])
process.env.CC_FILE_SHARED_PATHS = path.join(VAULT, 'shared')
process.env.CC_FILES_MAX_DOWNLOAD_BYTES = String(1024 * 1024) // 1 MiB for the cap test
process.env.CC_FILES_RATE_PER_MIN = '1000'
process.env.CC_FILES_DOWNLOAD_RATE_PER_MIN = '1000'

const { initDb, getDb } = await import('../db/index.js')
const { issueApiKey } = await import('../lib/api-keys.js')
const { resetRateLimits, isDeniedPath, globToRegExp } = await import('../services/file-access.js')
const { default: filesRouter } = await import('./files.js')

let server: http.Server
let baseUrl: string
let adminKey: string
let memberKey: string
let otherObjId: number
let example2ObjId: number

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 1)])
// Assembled at runtime so no literal PEM block sits in source — the OSS publish
// gate's gitleaks pass (scripts/oss-gitleaks.toml) does not blanket-allow tests.
const DASHES = '-'.repeat(5)
const PEM = `${DASHES}BEGIN RSA PRIVATE KEY${DASHES}\nMIIEow...\n${DASHES}END RSA PRIVATE KEY${DASHES}\n`

function write(p: string, data: string | Buffer, mtime?: Date): string {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, data)
  if (mtime) fs.utimesSync(p, mtime, mtime)
  return p
}

const F = {
  example2Deck: path.join(VAULT, 'workspaces/example2/talks/Vanderbilt Background Deck.pptx'),
  example2Pdf: path.join(VAULT, 'workspaces/example2/reports/q3.pdf'),
  example2Png: path.join(VAULT, 'workspaces/example2/img/logo.png'),
  example2Keynote: path.join(VAULT, 'workspaces/example2/talks/talk.key'),
  example2PrivKey: path.join(VAULT, 'workspaces/example2/talks/server.key'),
  example2Env: path.join(VAULT, 'workspaces/example2/.env.local'),
  example2Pem: path.join(VAULT, 'workspaces/example2/cert.pem'),
  example2IdRsa: path.join(VAULT, 'workspaces/example2/id_rsa'),
  example2Ssh: path.join(VAULT, 'workspaces/example2/.ssh/config.pdf'),
  example2Git: path.join(VAULT, 'workspaces/example2/.git/objects/blob.pdf'),
  example2NodeMods: path.join(VAULT, 'workspaces/example2/node_modules/pkg/readme.pdf'),
  example2Creds: path.join(VAULT, 'workspaces/example2/aws-credentials.json'),
  example2Db: path.join(VAULT, 'workspaces/example2/data.db'),
  example2PemNamedPdf: path.join(VAULT, 'workspaces/example2/looks-innocent.txt'),
  exampleDeck: path.join(VAULT, 'workspaces/example/board.pptx'),
  sharedPdf: path.join(VAULT, 'shared/brand-guide.pdf'),
  vaultTop: path.join(VAULT, 'CLAUDE-attachment.pdf'),
  big: path.join(VAULT, 'workspaces/example2/huge.pdf'),
  outsideSecret: path.join(OUTSIDE, 'payroll.xlsx'),
  escapeLink: path.join(VAULT, 'workspaces/example2/escape.xlsx'),
  escapeDirLink: path.join(VAULT, 'workspaces/example2/escape-dir'),
  inScopeLink: path.join(VAULT, 'workspaces/example2/alias.pdf'),
  crossWsLink: path.join(VAULT, 'workspaces/example2/example-board.pptx'),
}

function key(token: string) {
  return { Authorization: `Bearer ${token}` }
}

async function get(p: string, token?: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${p}`, { headers: { ...(token ? key(token) : {}), ...headers } })
}

beforeAll(async () => {
  write(F.example2Deck, ZIP, new Date('2026-10-01T00:00:00Z'))
  write(F.example2Pdf, '%PDF-1.7 q3', new Date('2026-06-01T00:00:00Z'))
  write(F.example2Png, Buffer.from([0x89, 0x50, 0x4e, 0x47]), new Date('2026-09-01T00:00:00Z'))
  write(F.example2Keynote, ZIP)
  write(F.example2PrivKey, PEM)
  write(F.example2Env, 'SECRET=1')
  write(F.example2Pem, PEM)
  write(F.example2IdRsa, PEM)
  write(F.example2Ssh, '%PDF')
  write(F.example2Git, '%PDF')
  write(F.example2NodeMods, '%PDF')
  write(F.example2Creds, '{}')
  write(F.example2Db, 'SQLite format 3')
  write(F.example2PemNamedPdf, PEM)
  write(F.exampleDeck, ZIP)
  write(F.sharedPdf, '%PDF shared')
  write(F.vaultTop, '%PDF top')
  write(F.big, Buffer.alloc(1024 * 1024 + 1, 0x20))
  write(F.outsideSecret, 'ssn,salary')
  fs.symlinkSync(F.outsideSecret, F.escapeLink)
  fs.symlinkSync(OUTSIDE, F.escapeDirLink)
  fs.symlinkSync(F.example2Pdf, F.inScopeLink)
  fs.symlinkSync(F.exampleDeck, F.crossWsLink)

  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const hash = bcrypt.hashSync('pw', 4)
  const adminId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('mike', hash, 'admin').lastInsertRowid)
  const memberId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('bot', hash, 'member').lastInsertRowid)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'example2', 'member')`).run(memberId)
  adminKey = issueApiKey(adminId).token
  memberKey = issueApiKey(memberId).token
  example2ObjId = Number(db.prepare(`INSERT INTO objectives (title, workspace, agent_context) VALUES ('g', 'example2', 'cto')`).run().lastInsertRowid)
  otherObjId = Number(db.prepare(`INSERT INTO objectives (title, workspace, agent_context) VALUES ('a', 'example', 'cto')`).run().lastInsertRowid)
  write(path.join(UPLOADS, String(example2ObjId), 'brief.docx'), ZIP)
  write(path.join(UPLOADS, String(otherObjId), 'example-only.xlsx'), ZIP)

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/files', filesRouter)
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
  fs.rmSync(BASE, { recursive: true, force: true })
})

beforeEach(() => resetRateLimits())

type SearchBody = { results: Array<{ path: string; name: string; size: number; mime: string; mtime: string; workspace: string | null; root: string }>; total: number; next_offset: number | null }
const paths = (b: SearchBody) => b.results.map(r => r.path).sort()

describe('auth', () => {
  it.each(['search?q=deck', `stat?path=${encodeURIComponent(F.example2Pdf)}`, `download?path=${encodeURIComponent(F.example2Pdf)}`])(
    '401 without a key: %s', async route => {
      const res = await get(`/api/files/${route}`)
      expect(res.status).toBe(401)
    })

  it('401 with a bogus cc_live_ key', async () => {
    const res = await get('/api/files/search', 'cc_live_nope')
    expect(res.status).toBe(401)
  })
})

describe('GET /api/files/search', () => {
  it('finds by name substring and returns path/name/size/mime/mtime/workspace', async () => {
    const res = await get('/api/files/search?q=vanderbilt', adminKey)
    expect(res.status).toBe(200)
    const body = await res.json() as SearchBody
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({
      path: F.example2Deck,
      name: 'Vanderbilt Background Deck.pptx',
      size: ZIP.length,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      mtime: '2026-10-01T00:00:00.000Z',
      workspace: 'example2',
      root: 'vault',
    })
  })

  it('filters by glob', async () => {
    const body = await (await get(`/api/files/search?glob=${encodeURIComponent('*deck*.pptx')}`, adminKey)).json() as SearchBody
    expect(paths(body)).toEqual([F.example2Deck])
  })

  it('filters by ext list and by type group', async () => {
    const byExt = await (await get('/api/files/search?ext=pptx,.key', adminKey)).json() as SearchBody
    expect(paths(byExt)).toEqual([F.exampleDeck, F.example2Keynote, F.example2Deck].sort())
    const byType = await (await get('/api/files/search?type=image', adminKey)).json() as SearchBody
    expect(paths(byType)).toEqual([F.example2Png])
  })

  it('filters by path_prefix', async () => {
    const body = await (await get(`/api/files/search?ext=pdf&path_prefix=${encodeURIComponent(path.join(VAULT, 'workspaces/example2/reports'))}`, adminKey)).json() as SearchBody
    expect(paths(body)).toEqual([F.example2Pdf])
  })

  it('filters by modified_after / modified_before', async () => {
    const body = await (await get('/api/files/search?type=pptx,pdf,png&modified_after=2026-05-01T00:00:00Z&modified_before=2026-09-15T00:00:00Z', adminKey)).json() as SearchBody
    expect(paths(body)).toEqual([F.example2Pdf, F.example2Png].sort())
    const bad = await get('/api/files/search?modified_after=not-a-date', adminKey)
    expect(bad.status).toBe(400)
  })

  it('paginates newest-first with total + next_offset', async () => {
    const p1 = await (await get('/api/files/search?type=pptx,pdf,png&modified_after=2026-05-01T00:00:00Z&modified_before=2026-10-02T00:00:00Z&limit=2', adminKey)).json() as SearchBody
    expect(p1.total).toBe(3)
    expect(p1.results.map(r => r.path)).toEqual([F.example2Deck, F.example2Png])
    expect(p1.next_offset).toBe(2)
    const p2 = await (await get('/api/files/search?type=pptx,pdf,png&modified_after=2026-05-01T00:00:00Z&modified_before=2026-10-02T00:00:00Z&limit=2&offset=2', adminKey)).json() as SearchBody
    expect(p2.results.map(r => r.path)).toEqual([F.example2Pdf])
    expect(p2.next_offset).toBeNull()
  })

  it('never lists denylisted files, even for admin', async () => {
    const body = await (await get('/api/files/search?limit=200', adminKey)).json() as SearchBody
    const listed = new Set(paths(body))
    for (const denied of [F.example2PrivKey, F.example2Env, F.example2Pem, F.example2IdRsa, F.example2Ssh, F.example2Git, F.example2NodeMods, F.example2Creds, F.example2Db]) {
      expect(listed.has(denied), denied).toBe(false)
    }
    expect(listed.has(F.example2Keynote)).toBe(true) // Keynote .key (ZIP magic) is allowed
  })

  it('drops symlinks that escape the roots and never descends symlinked dirs', async () => {
    const body = await (await get('/api/files/search?q=payroll', adminKey)).json() as SearchBody
    expect(body.results).toEqual([])
    const all = await (await get('/api/files/search?limit=200', adminKey)).json() as SearchBody
    expect(all.results.some(r => r.path.startsWith(OUTSIDE))).toBe(false)
  })

  it('member key sees only its workspace subtrees + shared + its objectives\' uploads', async () => {
    const body = await (await get('/api/files/search?limit=200', memberKey)).json() as SearchBody
    const listed = paths(body)
    expect(listed).toContain(F.example2Deck)
    expect(listed).toContain(F.sharedPdf)
    expect(listed).toContain(path.join(UPLOADS, String(example2ObjId), 'brief.docx'))
    expect(listed).not.toContain(F.exampleDeck)
    expect(listed).not.toContain(F.vaultTop)
    expect(listed).not.toContain(path.join(UPLOADS, String(otherObjId), 'example-only.xlsx'))
    // A example2→example symlink resolves outside the member's scope, so it is dropped too.
    expect(listed.some(p => p.includes('/workspaces/example/'))).toBe(false)
    const shared = body.results.find(r => r.path === F.sharedPdf)
    expect(shared?.workspace).toBe('shared')
    const upload = body.results.find(r => r.name === 'brief.docx')
    expect(upload).toMatchObject({ workspace: 'example2', root: 'uploads' })
  })

  it('admin sees every root', async () => {
    const body = await (await get('/api/files/search?limit=200', adminKey)).json() as SearchBody
    const listed = paths(body)
    expect(listed).toEqual(expect.arrayContaining([F.exampleDeck, F.vaultTop, path.join(UPLOADS, String(otherObjId), 'example-only.xlsx')]))
  })

  it('?workspace= narrows; non-member workspace is 403', async () => {
    const narrowed = await (await get('/api/files/search?workspace=example&limit=200', adminKey)).json() as SearchBody
    expect(paths(narrowed)).toEqual(expect.arrayContaining([F.exampleDeck, path.join(UPLOADS, String(otherObjId), 'example-only.xlsx')]))
    expect(paths(narrowed)).not.toContain(F.example2Deck)
    const res = await get('/api/files/search?workspace=example', memberKey)
    expect(res.status).toBe(403)
  })

  it('path_prefix outside scope is 403 for a member', async () => {
    const res = await get(`/api/files/search?path_prefix=${encodeURIComponent(path.join(VAULT, 'workspaces/example'))}`, memberKey)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/files/stat', () => {
  it('returns size, mime, mtime, created, workspace', async () => {
    const res = await get(`/api/files/stat?path=${encodeURIComponent(F.example2Deck)}`, memberKey)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({
      path: F.example2Deck,
      name: 'Vanderbilt Background Deck.pptx',
      size: ZIP.length,
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      mtime: '2026-10-01T00:00:00.000Z',
      workspace: 'example2',
      downloadable: true,
    })
    expect(body).toHaveProperty('created')
    expect(body).not.toHaveProperty('sha256')
  })

  it('computes sha256 on request', async () => {
    const body = await (await get(`/api/files/stat?sha256=1&path=${encodeURIComponent(F.example2Pdf)}`, memberKey)).json() as { sha256: string }
    const { createHash } = await import('crypto')
    expect(body.sha256).toBe(createHash('sha256').update('%PDF-1.7 q3').digest('hex'))
  })

  it('400 for a relative path, 404 for a missing file, 400 for a directory', async () => {
    expect((await get('/api/files/stat?path=workspaces/example2/reports/q3.pdf', adminKey)).status).toBe(400)
    expect((await get(`/api/files/stat?path=${encodeURIComponent(path.join(VAULT, 'nope.pdf'))}`, adminKey)).status).toBe(404)
    expect((await get(`/api/files/stat?path=${encodeURIComponent(path.join(VAULT, 'workspaces'))}`, adminKey)).status).toBe(400)
  })
})

describe('GET /api/files/download', () => {
  it('streams bytes with Content-Type, Content-Disposition, Content-Length', async () => {
    const res = await get(`/api/files/download?path=${encodeURIComponent(F.example2Deck)}`, memberKey)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="Vanderbilt Background Deck.pptx"; filename*=UTF-8''Vanderbilt%20Background%20Deck.pptx`)
    expect(res.headers.get('content-length')).toBe(String(ZIP.length))
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer()).equals(ZIP)).toBe(true)
  })

  it('honours a single Range with 206 + Content-Range; bad range is 416', async () => {
    const res = await get(`/api/files/download?path=${encodeURIComponent(F.example2Pdf)}`, memberKey, { Range: 'bytes=2-5' })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 2-5/11')
    expect(await res.text()).toBe('DF-1')
    const bad = await get(`/api/files/download?path=${encodeURIComponent(F.example2Pdf)}`, memberKey, { Range: 'bytes=50-60' })
    expect(bad.status).toBe(416)
  })

  it('refuses files over the size cap with 413', async () => {
    const res = await get(`/api/files/download?path=${encodeURIComponent(F.big)}`, adminKey)
    expect(res.status).toBe(413)
    const body = await res.json() as { size: number; max_bytes: number }
    expect(body).toMatchObject({ size: 1024 * 1024 + 1, max_bytes: 1024 * 1024 })
  })

  it('writes an activity_log audit row (path, key, workspace, bytes)', async () => {
    getDb().prepare(`DELETE FROM activity_log WHERE title = 'file_download'`).run()
    const res = await get(`/api/files/download?path=${encodeURIComponent(F.example2Pdf)}`, memberKey)
    await res.arrayBuffer()
    await new Promise(r => setTimeout(r, 50))
    const row = getDb().prepare(`SELECT workspace, detail, metadata FROM activity_log WHERE title = 'file_download'`).get() as { workspace: string; detail: string; metadata: string }
    expect(row.workspace).toBe('example2')
    const meta = JSON.parse(row.metadata)
    expect(meta).toMatchObject({ path: F.example2Pdf, workspace: 'example2', bytes: 11, complete: true, username: 'bot', auth: 'api_key', key_last4: memberKey.slice(-4) })
  })
})

describe('traversal, symlink escape, denylist, scoping (stat + download)', () => {
  const both = ['stat', 'download'] as const

  it.each(both)('%s: ../ traversal out of the roots / into another workspace is 403', async route => {
    for (const p of [`${VAULT}/workspaces/example2/../../../outside/payroll.xlsx`, `${VAULT}/workspaces/example2/../example/board.pptx`]) {
      const res = await get(`/api/files/${route}?path=${encodeURIComponent(p)}`, memberKey)
      expect(res.status, p).toBe(403)
    }
  })

  it.each(both)('%s: system paths are refused', async route => {
    for (const p of ['/etc/passwd', '/root/.bashrc', '/proc/self/environ']) {
      const res = await get(`/api/files/${route}?path=${encodeURIComponent(p)}`, adminKey)
      expect(res.status, p).toBe(403)
    }
  })

  it.each(both)('%s: symlink escaping the roots is 403 (file + via dir link)', async route => {
    for (const p of [F.escapeLink, path.join(F.escapeDirLink, 'payroll.xlsx')]) {
      const res = await get(`/api/files/${route}?path=${encodeURIComponent(p)}`, adminKey)
      expect(res.status, p).toBe(403)
    }
  })

  it.each(both)('%s: in-scope symlink resolves to its real target', async route => {
    const res = await get(`/api/files/${route}?path=${encodeURIComponent(F.inScopeLink)}`, memberKey)
    expect(res.status).toBe(200)
    if (route === 'stat') expect((await res.json() as { path: string }).path).toBe(F.example2Pdf)
    else await res.arrayBuffer()
  })

  it.each(both)('%s: denylisted files are 403 even for admin, inside an allowed root', async route => {
    for (const p of [F.example2PrivKey, F.example2Env, F.example2Pem, F.example2IdRsa, F.example2Ssh, F.example2Git, F.example2NodeMods, F.example2Creds, F.example2Db, F.example2PemNamedPdf]) {
      const res = await get(`/api/files/${route}?path=${encodeURIComponent(p)}`, adminKey)
      expect(res.status, p).toBe(403)
    }
  })

  it.each(both)('%s: Keynote .key (ZIP magic) is allowed', async route => {
    const res = await get(`/api/files/${route}?path=${encodeURIComponent(F.example2Keynote)}`, memberKey)
    expect(res.status).toBe(200)
    if (route === 'download') {
      expect(res.headers.get('content-type')).toBe('application/vnd.apple.keynote')
      await res.arrayBuffer()
    } else {
      await res.json()
    }
  })

  it.each(both)('%s: member cannot reach another workspace, the vault top, or foreign uploads', async route => {
    for (const p of [F.exampleDeck, F.vaultTop, F.crossWsLink, path.join(UPLOADS, String(otherObjId), 'example-only.xlsx')]) {
      const res = await get(`/api/files/${route}?path=${encodeURIComponent(p)}`, memberKey)
      expect(res.status, p).toBe(403)
    }
  })

  it.each(both)('%s: admin can reach every root', async route => {
    for (const p of [F.exampleDeck, F.vaultTop, path.join(UPLOADS, String(otherObjId), 'example-only.xlsx')]) {
      const res = await get(`/api/files/${route}?path=${encodeURIComponent(p)}`, adminKey)
      expect(res.status, p).toBe(200)
      await res.arrayBuffer()
    }
  })

  it.each(both)('%s: NUL byte in path is rejected', async route => {
    const res = await get(`/api/files/${route}?path=${encodeURIComponent(F.example2Pdf + '\0.png')}`, adminKey)
    expect(res.status).toBe(400)
  })
})

describe('rate limit', () => {
  it('returns 429 + Retry-After past the per-minute budget', async () => {
    process.env.CC_FILES_DOWNLOAD_RATE_PER_MIN = '2'
    try {
      for (let i = 0; i < 2; i++) {
        const ok = await get(`/api/files/download?path=${encodeURIComponent(F.example2Pdf)}`, memberKey)
        expect(ok.status).toBe(200)
        await ok.arrayBuffer()
      }
      const res = await get(`/api/files/download?path=${encodeURIComponent(F.example2Pdf)}`, memberKey)
      expect(res.status).toBe(429)
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    } finally {
      process.env.CC_FILES_DOWNLOAD_RATE_PER_MIN = '1000'
    }
  })
})

describe('policy units', () => {
  it('isDeniedPath', () => {
    for (const p of ['/x/.env', '/x/.env.production', '/x/a.pem', '/x/id_ed25519.pub', '/x/.ssh/known', '/x/.git/HEAD',
      '/x/node_modules/a.pdf', '/x/my-secret.pdf', '/x/api_token.txt', '/x/credentials.json', '/app/data/command-center.db',
      '/etc/hosts', '/root/a.pdf', '/x/.secrets-master-key']) {
      expect(isDeniedPath(p), p).toBe(true)
    }
    for (const p of ['/x/deck.pptx', '/x/talk.key', '/x/report.pdf', '/x/photo.jpg']) {
      expect(isDeniedPath(p), p).toBe(false)
    }
  })

  it('globToRegExp escapes regex metacharacters', () => {
    expect(globToRegExp('*.pdf').test('a.pdf')).toBe(true)
    expect(globToRegExp('*.pdf').test('apdf')).toBe(false)
    expect(globToRegExp('deck(1)?.pptx').test('deck(1)a.pptx')).toBe(true)
  })
})
