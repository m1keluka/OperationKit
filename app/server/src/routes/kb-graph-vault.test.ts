import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Whole-vault graph over real HTTP + SQLite (obj 900815): the Graph route sees
// every folder, a plain write through /api/docs/file (the editor, MCP
// write_doc, a card session) reindexes that page without waiting for a read,
// and a workspace whose folder sits inside another's stays out of its graph.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kbgraph-'))
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.JWT_SECRET = 'test-secret-kbgraph'
process.env.AI_WORKSPACE_DIR = path.join(TMP, 'ai-workspace')
const KB = path.join(TMP, 'vault', 'acme')
const NESTED = path.join(KB, 'clients', 'beta')

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { PACK_ID } = await import('../services/doc-ingest/service.js')
const { settingKey } = await import('../services/starter-packs.js')
const { stopWikiLintScheduler } = await import('../services/kb-wiki/scheduler.js')
const { clearGraphCache } = await import('../services/kb-wiki/graph.js')
const { noteKbFileWritten } = await import('../services/kb-wiki/graph-sync.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { default: kbWikiRouter } = await import('./kb-wiki.js')
const { default: docsRouter } = await import('./docs.js')

const cookie = (role: 'admin' | 'member', id: number) => `token=${jwt.sign({ id, username: `u${id}`, role }, 'test-secret-kbgraph', { expiresIn: '1h' })}`
const ADMIN = cookie('admin', 1)
const OUTSIDER = cookie('member', 99)
let server: http.Server
let base: string
const keys: Record<string, string> = {}

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), text)
}

async function get<T = Record<string, unknown>>(url: string, who = ADMIN): Promise<{ status: number; body: T }> {
  const r = await fetch(`${base}${url}`, { headers: { cookie: who } })
  return { status: r.status, body: await r.json() as T }
}

interface GraphBody { nodes: Array<{ rel: string; kind: string; degree: number }>; links: Array<{ a: string; b: string }>; counts: { pages: number; links: number; unresolved: number; by_kind: Record<string, number> } }

const edgeRows = (ws: string) => getDb().prepare('SELECT from_rel, to_rel, kind FROM kb_edges WHERE workspace = ? ORDER BY from_rel, to_rel').all(ws) as Array<{ from_rel: string; to_rel: string; kind: string }>

beforeAll(async () => {
  initDb()
  clearGraphCache()
  getDb().prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(settingKey(PACK_ID))
  createWorkspace({ slug: 'acme', name: 'Acme', vault_path: KB })
  createWorkspace({ slug: 'beta', name: 'Beta', vault_path: NESTED })
  write(KB, 'decisions/2026-01-05-use-sqlite.md', '# Use SQLite\n\nSee [[graph-store]].\n\n## Related\n\n- Project: [[command-center]]\n')
  write(KB, 'architecture/graph-store.md', '# Graph store\n\nThree tables.\n')
  write(KB, 'projects/command-center.md', '# Command Center\n\nThe board.\n')
  write(KB, 'runbooks/reindex.md', '# Reindex\n\nNothing linked yet.\n')
  getDb().prepare('INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('u1', 'x', 'admin')
  const mint = (label: string, scopes: string[], workspaces: string[]) => {
    const r = createAgentKey({ id: 1, role: 'admin' }, { label, scopes, workspaces })
    if (!r.ok) throw new Error(r.error)
    return r.key.token
  }
  keys.acmeReader = mint('acme reader', ['vault:read'], ['acme'])
  keys.betaReader = mint('beta reader', ['vault:read'], ['beta'])
  keys.boardOnly = mint('board only', ['board:read'], ['acme'])
  write(NESTED, 'notes/beta-plan.md', '# Beta plan\n\n[[command-center]]\n')

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/kb-wiki', kbWikiRouter)
  app.use('/api/docs', docsRouter)
  await new Promise<void>(r => { server = app.listen(0, () => r()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  stopWikiLintScheduler()
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('whole-vault graph routes', () => {
  it('GET /graph shows every folder, typed by folder, and connected', async () => {
    const r = await get<GraphBody>('/api/kb-wiki/graph?workspace=acme')
    expect(r.status).toBe(200)
    expect(r.body.nodes.map(n => n.rel).sort()).toEqual([
      'architecture/graph-store.md', 'decisions/2026-01-05-use-sqlite.md', 'projects/command-center.md', 'runbooks/reindex.md',
    ])
    expect(r.body.counts.by_kind).toEqual({ architecture: 1, decision: 1, project: 1, runbook: 1 })
    expect(r.body.counts.links).toBe(2)
    expect(r.body.counts.unresolved).toBe(0)
  })

  it('a workspace nested inside another keeps its own pages, and only its own', async () => {
    const acme = await get<GraphBody>('/api/kb-wiki/graph?workspace=acme')
    expect(acme.body.nodes.some(n => n.rel.includes('beta-plan'))).toBe(false)
    const beta = await get<GraphBody>('/api/kb-wiki/graph?workspace=beta')
    expect(beta.body.nodes.map(n => n.rel)).toEqual(['notes/beta-plan.md'])
    // Its [[command-center]] link is acme's page, so in beta's graph it is reported, not drawn.
    expect(beta.body.counts.unresolved).toBe(1)
  })

  it('someone outside the workspace gets a 403 from the graph and the unresolved list', async () => {
    expect((await get('/api/kb-wiki/graph?workspace=acme', OUTSIDER)).status).toBe(403)
    expect((await get('/api/kb-wiki/graph/unresolved?workspace=acme', OUTSIDER)).status).toBe(403)
  })

  it('agent keys: vault:read on the workspace is required, and the workspace list is enforced', async () => {
    const as = (key: string, url: string) => fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${key}` } })
    const ok = await as(keys.acmeReader, '/api/kb-wiki/graph?workspace=acme')
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as GraphBody).counts.pages).toBe(4)
    expect((await as(keys.acmeReader, '/api/kb-wiki/graph/unresolved?workspace=acme')).status).toBe(200)
    // A key for the nested workspace cannot read the parent one, and the reverse.
    expect((await as(keys.betaReader, '/api/kb-wiki/graph?workspace=acme')).status).toBe(403)
    expect((await as(keys.acmeReader, '/api/kb-wiki/graph/unresolved?workspace=beta')).status).toBe(403)
    // No vault:read scope, no graph.
    expect((await as(keys.boardOnly, '/api/kb-wiki/graph/unresolved?workspace=acme')).status).toBe(403)
  })

  it('PUT /api/docs/file reindexes that page straight away (no graph read needed)', async () => {
    const abs = path.join(KB, 'runbooks/reindex.md')
    const r = await fetch(`${base}/api/docs/file`, {
      method: 'PUT',
      headers: { cookie: ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: abs, content: '# Reindex\n\nRun it when [[Graph store]] looks empty. Also [[Missing Page]].\n' }),
    })
    expect(r.status).toBe(200)
    // The reindex runs right after the response.
    await new Promise(res => setTimeout(res, 50))
    expect(edgeRows('acme')).toContainEqual({ from_rel: 'runbooks/reindex.md', to_rel: 'architecture/graph-store.md', kind: 'mentions' })
    const u = await get<{ total: number; targets: Array<{ target: string; from: string[] }> }>('/api/kb-wiki/graph/unresolved?workspace=acme')
    expect(u.status).toBe(200)
    expect(u.body.targets).toEqual([{ target: 'Missing Page', count: 1, from: ['runbooks/reindex.md'] }])
  })

  it('a new page written through the API connects in both directions', async () => {
    const abs = path.join(KB, 'audits/graph-audit.md')
    const r = await fetch(`${base}/api/docs/file`, {
      method: 'PUT',
      headers: { cookie: ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: abs, content: '# Graph audit\n\nThe [runbook](../runbooks/reindex.md) fixed it.\n', create_dirs: true }),
    })
    expect(r.status).toBe(200)
    await new Promise(res => setTimeout(res, 50))
    expect(edgeRows('acme')).toContainEqual({ from_rel: 'audits/graph-audit.md', to_rel: 'runbooks/reindex.md', kind: 'mentions' })
    const g = await get<GraphBody>('/api/kb-wiki/graph?workspace=acme')
    expect(g.body.counts.by_kind.audit).toBe(1)
  })

  it('noteKbFileWritten picks the deepest workspace and ignores paths outside every knowledge folder', () => {
    write(NESTED, 'notes/second.md', '# Second\n\n[[Beta plan]]\n')
    expect(noteKbFileWritten(path.join(NESTED, 'notes/second.md'))?.workspace).toBe('beta')
    expect(edgeRows('beta')).toContainEqual({ from_rel: 'notes/second.md', to_rel: 'notes/beta-plan.md', kind: 'mentions' })
    expect(edgeRows('acme').some(e => e.from_rel.includes('second'))).toBe(false)
    expect(noteKbFileWritten(path.join(TMP, 'elsewhere.md'))).toBeNull()
  })
})
