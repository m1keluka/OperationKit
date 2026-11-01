import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

// obj 720210: install-bootstrap.ts writes workspaces/agents from a SEPARATE
// process, so the running server's in-memory registries go stale. Simulate that
// with raw SQL behind the cache's back, then prove the reload hook fixes it.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-internal-install-'))
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.INTERNAL_API_SECRET = 'test-internal-secret'
process.env.AI_WORKSPACE_DIR = path.join(TMP, 'ai-workspace')

const { initDb, getDb } = await import('../db/index.js')
const { getWorkspace, getWorkspaceSlugs } = await import('../services/workspaces.js')
const { listAgents } = await import('../services/agent-registry.js')
const { enablePack, listPacks } = await import('../services/starter-packs.js')
const { default: internalInstallRouter } = await import('./internal-install.js')

let server: http.Server
let base: string
const H = { 'X-Internal-Secret': 'test-internal-secret', 'Content-Type': 'application/json' }

beforeAll(async () => {
  initDb()
  const app = express()
  app.use(express.json())
  app.use('/api/internal/install', internalInstallRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => {
  server?.close()
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

/** What install-bootstrap.ts does, minus the cache: a write the server never saw. */
function bootstrapBehindTheCache(slug: string): void {
  getDb().prepare('INSERT INTO workspaces (slug, name) VALUES (?, ?)').run(slug, 'Example Client')
  getDb().prepare('UPDATE workspaces SET archived = 1 WHERE slug != ?').run(slug)
  getDb().prepare('UPDATE agents SET archived = 1').run()
}

describe('installer cache reload (obj 720210)', () => {
  it('needs the internal secret', async () => {
    const r = await fetch(`${base}/api/internal/install/reload-caches`, { method: 'POST' })
    expect(r.status).toBe(401)
  })

  it('a bootstrap write is invisible until the caches are reloaded', async () => {
    const agentsBefore = listAgents().length
    getWorkspaceSlugs() // warm the cache, as the running server would have
    bootstrapBehindTheCache('example-client')
    expect(getWorkspace('example-client')).toBeUndefined() // the bug: stale cache
    expect(listAgents().length).toBe(agentsBefore)          // archived agents still listed

    const r = await fetch(`${base}/api/internal/install/reload-caches`, { method: 'POST', headers: H })
    expect(r.status).toBe(200)
    const body = await r.json() as { workspaces: string[]; agents: string[] }
    expect(body.workspaces).toEqual(['example-client'])     // sample workspaces now archived
    expect(body.agents).toEqual([])
    expect(getWorkspace('example-client')?.name).toBe('Example Client')
  })

  it('enablePack re-reads the workspace table once before saying "no workspace named"', async () => {
    getWorkspaceSlugs()
    getDb().prepare('INSERT INTO workspaces (slug, name) VALUES (?, ?)').run('late-client', 'Late Client')
    const pack = listPacks()[0]
    expect(pack).toBeTruthy()
    const res = await enablePack(pack.manifest.id, { workspace: 'late-client', dryRun: true, agentsDir: path.join(TMP, 'agents') })
    expect(res.workspace).toBe('late-client')
    await expect(enablePack(pack.manifest.id, { workspace: 'never-created', dryRun: true })).rejects.toThrow(/no workspace named/)
  })

  it('reports whether a Claude seat is usable', async () => {
    const r = await fetch(`${base}/api/internal/install/seat-status`, { headers: H })
    expect(r.status).toBe(200)
    const body = await r.json() as { claude: { usable: boolean; seats: number }; reason: string | null }
    expect(typeof body.claude.usable).toBe('boolean')
    expect(typeof body.claude.seats).toBe('number')
    if (!body.claude.usable) expect(body.reason).toMatch(/no Claude seat/)
  })
})
