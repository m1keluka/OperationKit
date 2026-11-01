import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcrypt'

// obj 720348: the Knowledge base page shows ONE tree — the knowledge base — with
// no source picker. Agent config and code repos are never part of it, and notes
// stored outside the knowledge base folder (an old "source") stay reachable.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-docs-tree-'))
const KB = path.join(TMP, 'kb')
const AGENT_CONFIG = path.join(TMP, 'agent-config')   // what "AI workspace" pointed at
const OUTSIDE_KB = path.join(TMP, 'old-notes', 'beta') // a workspace KB stored outside the root
const TMP_DB = path.join(TMP, 'cc.db')
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-docs-tree-xxxxx'
process.env.SECOND_BRAIN_ROOT = KB

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace, invalidateWorkspacesCache } = await import('../services/workspaces.js')
const { default: docsRouter } = await import('./docs.js')

let server: http.Server
let baseUrl: string
let admin: string
let member: string

function write(p: string, body = '# page\n') {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
}

beforeAll(async () => {
  write(path.join(KB, 'workspaces', 'acme', 'people', 'dana-ruiz.md'))
  write(path.join(KB, 'workspaces', 'acme', 'index.md'))
  write(path.join(KB, 'shared', 'glossary.md'))
  write(path.join(AGENT_CONFIG, 'agents', 'cto.md'), '# agent config\n')
  write(path.join(OUTSIDE_KB, 'supplier-notes.md'), '# kept\n')

  initDb()
  const db = getDb()
  // Seeded rows point at a real vault path; this test owns the workspace set.
  db.prepare('DELETE FROM workspaces').run()
  invalidateWorkspacesCache()
  createWorkspace({
    slug: 'acme', name: 'Acme',
    doc_read_roots: [path.join(KB, 'workspaces', 'acme'), path.join(KB, 'shared'), path.join(AGENT_CONFIG, 'agents')],
    doc_write_roots: [path.join(KB, 'workspaces', 'acme')],
  })
  createWorkspace({ slug: 'beta', name: 'Beta', vault_path: OUTSIDE_KB, doc_read_roots: [OUTSIDE_KB], doc_write_roots: [OUTSIDE_KB] })

  const hash = bcrypt.hashSync('pw', 4)
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', hash, 'admin')
  const memberId = Number(db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('ava', hash, 'member').lastInsertRowid)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, 'acme', 'member')`).run(memberId)

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/docs', docsRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  const sign = (id: number, username: string, role: string) =>
    `token=${jwt.sign({ id, username, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
  admin = sign(1, 'owner', 'admin')
  member = sign(memberId, 'ava', 'member')
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  fs.rmSync(TMP, { recursive: true, force: true })
})

const get = async (url: string, cookie: string) => {
  const res = await fetch(`${baseUrl}${url}`, { headers: { Cookie: cookie } })
  return { status: res.status, body: await res.json() }
}

describe('GET /api/docs/tree — one knowledge base', () => {
  it('admin: one tree rooted at the knowledge base, plus a workspace folder stored outside it', async () => {
    const { status, body } = await get('/api/docs/tree', admin)
    expect(status).toBe(200)
    expect(body.root).toBe(KB)
    expect(body.label).toBe('Knowledge base')
    // The KB itself and the out-of-root workspace folder — never agent config or repos.
    expect(body.folders.map((f: { path: string }) => f.path)).toEqual([KB, OUTSIDE_KB])
    expect(body.roots).toEqual([KB, OUTSIDE_KB])
    const names = body.tree.map((n: { name: string }) => n.name)
    expect(names).toEqual(['Knowledge base', 'beta'])
    const json = JSON.stringify(body.tree)
    expect(json).toMatch(/dana-ruiz\.md/)
    expect(json).toMatch(/supplier-notes\.md/) // migration: nothing stored under an old source is lost
    expect(json).not.toMatch(/ai-workspace|\/projects|cto\.md/)
  })

  it('member: their workspace + shared knowledge folders only; agent config is not in the tree', async () => {
    const { status, body } = await get('/api/docs/tree', member)
    expect(status).toBe(200)
    expect(body.folders).toEqual([
      { path: path.join(KB, 'shared'), label: 'shared' },
      { path: path.join(KB, 'workspaces', 'acme'), label: 'workspaces/acme' },
    ])
    const json = JSON.stringify(body.tree)
    expect(json).toMatch(/dana-ruiz\.md/)
    expect(json).toMatch(/glossary\.md/)
    expect(json).not.toMatch(/cto\.md/)
    expect(json).not.toMatch(/supplier-notes/) // another workspace's folder
  })

  it('?root narrows to a folder inside the knowledge base (MCP list_folders)', async () => {
    const { status, body } = await get(`/api/docs/tree?root=${encodeURIComponent(path.join(KB, 'workspaces', 'acme'))}`, member)
    expect(status).toBe(200)
    expect(body.label).toBe('workspaces/acme')
    expect(body.tree.map((n: { name: string }) => n.name)).toEqual(['people', 'index.md'])
  })

  it('?root outside the knowledge base is refused — there is no other source to pick', async () => {
    const { status } = await get(`/api/docs/tree?root=${encodeURIComponent(path.join(AGENT_CONFIG, 'agents'))}`, member)
    expect(status).toBe(403)
  })

  it('a page from the old sources is still readable by path (links and agents keep working)', async () => {
    const { status, body } = await get(`/api/docs/file?path=${encodeURIComponent(path.join(AGENT_CONFIG, 'agents', 'cto.md'))}`, member)
    expect(status).toBe(200)
    expect(body.content).toMatch(/agent config/)
    expect(body.writable).toBe(false)
  })

  it('knowledge base pages are writable for the workspace', async () => {
    const { body } = await get(`/api/docs/file?path=${encodeURIComponent(path.join(KB, 'workspaces', 'acme', 'people', 'dana-ruiz.md'))}`, member)
    expect(body.writable).toBe(true)
  })

  it('an install with no knowledge base folder yet gets an empty tree, not an error', async () => {
    const prev = process.env.SECOND_BRAIN_ROOT
    process.env.SECOND_BRAIN_ROOT = path.join(TMP, 'does-not-exist')
    try {
      const { status, body } = await get('/api/docs/tree', admin)
      expect(status).toBe(200)
      // Only the out-of-root workspace folder remains.
      expect(body.folders.map((f: { path: string }) => f.path)).toEqual([OUTSIDE_KB])
    } finally {
      process.env.SECOND_BRAIN_ROOT = prev
    }
  })
})
