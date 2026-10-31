import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// End to end over real SQLite + real HTTP: switch the knowledge-import pack on
// through the internal starter-pack route (which calls the pack's own setup
// hook over loopback), upload a file, let the stubbed AI organize it, read the
// notes back, ask a question, then switch the pack off.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kbingest-'))
const TMP_DB = path.join(TMP, 'test.db')
const KB = path.join(TMP, 'kb')
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-kbingest'
process.env.INTERNAL_API_SECRET = 'test-internal-secret'
process.env.AI_WORKSPACE_DIR = path.join(TMP, 'ai-workspace')

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace, getWorkspace } = await import('../services/workspaces.js')
const { setIngestLlmForTests, PACK_ID } = await import('../services/doc-ingest/service.js')
const { default: kbIngestRouter, internalKbIngestRouter, safeKbPath } = await import('./kb-ingest.js')
const { default: starterPacksRouter, internalStarterPacksRouter } = await import('./starter-packs.js')
const { listPacks, validateManifest } = await import('../services/starter-packs.js')

let server: http.Server
let base: string
const cookie = (role: 'admin' | 'member', id = 1) => `token=${jwt.sign({ id, username: `u${id}`, role }, 'test-secret-kbingest', { expiresIn: '1h' })}`
const ADMIN = cookie('admin')
const OUTSIDER = cookie('member', 99)
const INTERNAL = { 'X-Internal-Secret': 'test-internal-secret', 'Content-Type': 'application/json' }

const llmCalls: string[] = []

beforeAll(async () => {
  initDb()
  createWorkspace({ slug: 'acme-services', name: 'Acme Services', vault_path: KB })
  setIngestLlmForTests(async (sys, prompt) => {
    llmCalls.push(sys)
    if (prompt.startsWith('QUESTION:')) return 'Maple Street Dental pays $180 a visit [[organizations/maple-street-dental.md]].'
    return JSON.stringify({
      title: 'Price list', summary: 'Prices 2025.',
      entities: [{ type: 'organization', name: 'Maple Street Dental', facts: [{ fact: 'Price $180 per visit', where: 'row 2' }] }],
    })
  })
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/internal/starter-packs', internalStarterPacksRouter)
  app.use('/api/internal/kb-ingest', internalKbIngestRouter)
  app.use('/api/starter-packs', starterPacksRouter)
  app.use('/api/kb-ingest', kbIngestRouter)
  await new Promise<void>(r => { server = app.listen(0, () => r()) })
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
  process.env.PORT = String(addr.port) // the loader's setup call goes to "this server"
})

afterAll(async () => {
  setIngestLlmForTests(null)
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

async function waitDone(): Promise<Array<{ status: string; notes?: string[]; source_note?: string }>> {
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${base}/api/kb-ingest/status?workspace=acme-services`, { headers: { cookie: ADMIN } })
    const body = await r.json() as { files: Array<{ status: string }> }
    if (body.files.every(f => f.status === 'done' || f.status === 'failed')) return body.files
    await new Promise(res => setTimeout(res, 40))
  }
  throw new Error('ingest did not finish')
}

describe('starter pack: knowledge-import', () => {
  it('ships a valid manifest that the loader discovers', () => {
    const pack = listPacks().find(p => p.manifest.id === PACK_ID)
    expect(pack).toBeTruthy()
    const raw = JSON.parse(fs.readFileSync(path.join(pack!.dir, 'pack.json'), 'utf8'))
    expect(validateManifest(raw, PACK_ID)).toEqual([])
    for (const f of ['README.md', 'DEMO.md', 'prompts/organize.md', 'prompts/answer.md', 'agents/kb-librarian.md']) {
      expect(fs.existsSync(path.join(pack!.dir, f)), f).toBe(true)
    }
  })

  it('is off until switched on', async () => {
    const r = await fetch(`${base}/api/kb-ingest/enabled`, { headers: { cookie: ADMIN } })
    expect(await r.json()).toEqual({ pack_enabled: false })
    const up = await fetch(`${base}/api/kb-ingest/samples?workspace=acme-services`, { method: 'POST', headers: { cookie: ADMIN } })
    expect(up.status).toBe(404)
  })

  it('internal routes need the shared secret', async () => {
    const r = await fetch(`${base}/api/internal/starter-packs`, {})
    expect(r.status).toBe(401)
  })

  it('switches on: agent registered + pooled, setup hook ran, library folder readable', async () => {
    const dry = await fetch(`${base}/api/internal/starter-packs/${PACK_ID}/enable`, { method: 'POST', headers: INTERNAL, body: JSON.stringify({ workspace: 'acme-services', dry_run: true }) })
    expect(dry.status).toBe(200)
    expect(getDb().prepare("SELECT value FROM settings WHERE key = ?").get(`starter_pack:${PACK_ID}`)).toBeUndefined()

    const r = await fetch(`${base}/api/internal/starter-packs/${PACK_ID}/enable`, { method: 'POST', headers: INTERNAL, body: JSON.stringify({ workspace: 'acme-services' }) })
    const body = await r.json() as { steps: string[] }
    expect(r.status, JSON.stringify(body)).toBe(200)
    expect(body.steps.join('\n')).toContain('setup /api/internal/kb-ingest/setup: ok')
    expect(getDb().prepare('SELECT slug FROM agents WHERE slug = ?').get('kb-librarian')).toBeTruthy()
    expect(fs.existsSync(path.join(process.env.AI_WORKSPACE_DIR!, 'agents/kb-librarian.md'))).toBe(true)
    const ws = getWorkspace('acme-services')!
    expect(ws.default_agent_pool).toContain('kb-librarian')
    expect(ws.doc_read_roots).toContain(path.resolve(KB))
    expect(ws.doc_write_roots).toContain(path.resolve(KB))  // imported notes are editable on the Knowledge base page
    expect(fs.existsSync(path.join(KB, 'sources/inbox'))).toBe(true)

    // Idempotent: a second run converges, nothing duplicated.
    const again = await fetch(`${base}/api/internal/starter-packs/${PACK_ID}/enable`, { method: 'POST', headers: INTERNAL, body: JSON.stringify({ workspace: 'acme-services' }) })
    expect(again.status).toBe(200)
    expect(getWorkspace('acme-services')!.doc_read_roots.filter(r => r === path.resolve(KB))).toHaveLength(1)
    expect(getWorkspace('acme-services')!.doc_write_roots.filter(r => r === path.resolve(KB))).toHaveLength(1)

    const list = await (await fetch(`${base}/api/starter-packs`, { headers: { cookie: ADMIN } })).json() as { packs: Array<{ id: string; enabled: boolean }> }
    expect(list.packs.find(p => p.id === PACK_ID)?.enabled).toBe(true)
  })

  it('upload → organized notes with links back to the original', async () => {
    const fd = new FormData()
    fd.append('files', new Blob(['Customer,Price\nMaple Street Dental,180\n']), 'Price List – 2025.csv')
    const r = await fetch(`${base}/api/kb-ingest/upload?workspace=acme-services`, { method: 'POST', headers: { cookie: ADMIN }, body: fd })
    expect(r.status).toBe(202)
    const files = await waitDone()
    expect(files[0].status).toBe('done')
    expect(files[0].notes).toEqual(['organizations/maple-street-dental.md'])
    const note = await (await fetch(`${base}/api/kb-ingest/note?workspace=acme-services&path=organizations/maple-street-dental.md`, { headers: { cookie: ADMIN } })).json() as { content: string }
    expect(note.content).toContain('## From: Price List – 2025.csv')
    const link = note.content.match(/\[original file\]\(\.\.\/(sources\/files\/[^)]+)\)/)![1]
    const orig = await fetch(`${base}/api/kb-ingest/original?workspace=acme-services&path=${encodeURIComponent(link)}`, { headers: { cookie: ADMIN } })
    expect(orig.status).toBe(200)
    expect(await orig.text()).toContain('Maple Street Dental,180')
  })

  it('answers questions from the notes', async () => {
    const r = await fetch(`${base}/api/kb-ingest/ask`, { method: 'POST', headers: { cookie: ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: 'acme-services', question: 'Maple Street Dental price?' }) })
    const body = await r.json() as { answer: string; sources: Array<{ rel: string }> }
    expect(r.status).toBe(200)
    expect(body.sources.map(s => s.rel)).toEqual(['organizations/maple-street-dental.md'])
    expect(llmCalls.at(-1)).toContain('Cite every claim')
  })

  it('refuses outsiders and paths outside the library', async () => {
    const r = await fetch(`${base}/api/kb-ingest/status?workspace=acme-services`, { headers: { cookie: OUTSIDER } })
    expect(r.status).toBe(403)
    const t = await fetch(`${base}/api/kb-ingest/note?workspace=acme-services&path=${encodeURIComponent('../../etc/passwd.md')}`, { headers: { cookie: ADMIN } })
    expect(t.status).toBe(404)
    expect(safeKbPath('/kb', '../x.md')).toBeNull()
    expect(safeKbPath('/kb', '/etc/passwd')).toBeNull()
    expect(safeKbPath('/kb', 'organizations/a.md')).toBe('/kb/organizations/a.md')
    const o = await fetch(`${base}/api/kb-ingest/original?workspace=acme-services&path=sources/_manifest.json`, { headers: { cookie: ADMIN } })
    expect(o.status).toBe(404)
  })

  it('loads the sample files on request', async () => {
    const r = await fetch(`${base}/api/kb-ingest/samples?workspace=acme-services`, { method: 'POST', headers: { cookie: ADMIN } })
    const body = await r.json() as { added: Array<{ file_name: string }> }
    expect(r.status, JSON.stringify(body)).toBe(202)
    expect(body.added.length).toBeGreaterThanOrEqual(4)
    const files = await waitDone()
    expect(files.filter(f => f.status === 'done').length).toBeGreaterThanOrEqual(5)
  })

  it('switches off: library routes 404, notes are kept', async () => {
    const r = await fetch(`${base}/api/starter-packs/${PACK_ID}/disable`, { method: 'POST', headers: { cookie: ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: 'acme-services' }) })
    expect(r.status).toBe(200)
    const up = await fetch(`${base}/api/kb-ingest/ask`, { method: 'POST', headers: { cookie: ADMIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: 'acme-services', question: 'x' }) })
    expect(up.status).toBe(404)
    expect(fs.existsSync(path.join(KB, 'organizations/maple-street-dental.md'))).toBe(true)
  })

  it('member admin routes are admin-only', async () => {
    const r = await fetch(`${base}/api/starter-packs`, { headers: { cookie: cookie('member', 2) } })
    expect(r.status).toBe(403)
  })
})
