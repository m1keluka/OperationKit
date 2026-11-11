import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'

// End to end for the knowledge-base link graph (obj 720162): a test workspace
// is built from the made-up sample chats and calls (services/kb-wiki/sample-data,
// "Fernleaf Garden Supply"), then an agent asks "who knows about the supplier?"
// over MCP: MCP → loopback → agentKeyGuard (vault:read) → /api/kb-wiki/graph →
// kb_edges. Everything is real except the AI, which is a small rule-based
// stand-in that reads the actual sample text and answers like the extractor.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kbgraph-'))
const KB = path.join(TMP, 'kb')
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.JWT_SECRET = 'test-secret-kbgraph-xxxx'
process.env.AI_WORKSPACE_DIR = path.join(TMP, 'ai-workspace')

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { PACK_ID } = await import('../services/doc-ingest/service.js')
const { settingKey } = await import('../services/starter-packs.js')
const { FOLDER_FOR } = await import('../services/doc-ingest/notes.js')
const { setWikiLlmForTests } = await import('../services/kb-wiki/llm.js')
const { createImport, sampleImportFiles, startImport, whenImportsIdle } = await import('../services/kb-wiki/imports.js')
const { stopWikiLintScheduler } = await import('../services/kb-wiki/scheduler.js')
const { readEdges } = await import('../services/kb-wiki/graph.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { default: kbWikiRouter } = await import('./kb-wiki.js')
const { default: agentMcpRouter } = await import('./agent-mcp.js')

const WS = 'garden-demo'
const PEOPLE = FOLDER_FOR.person
const ORGS = FOLDER_FOR.organization

/** The sample cast (sample-data/README.md) and how each one relates to the others. */
const CAST: Array<{ type: 'person' | 'organization'; name: string; related?: { type: 'person' | 'organization'; name: string; label: string; when?: RegExp } }> = [
  { type: 'person', name: 'Rosa Delgado', related: { type: 'organization', name: 'Fernleaf Garden Supply', label: 'owns' } },
  { type: 'person', name: 'Sam Okafor', related: { type: 'organization', name: 'Fernleaf Garden Supply', label: 'works for' } },
  { type: 'person', name: 'Priya Nair', related: { type: 'organization', name: 'Fernleaf Garden Supply', label: 'works for' } },
  { type: 'person', name: 'Jo Fairweather', related: { type: 'organization', name: 'Fernleaf Garden Supply', label: 'works for' } },
  { type: 'person', name: 'Tom Whitfield', related: { type: 'organization', name: 'Greenway Growers', label: 'works for' } },
  { type: 'person', name: 'Marcus Bell', related: { type: 'organization', name: 'Hillcrest Property Management', label: 'works for' } },
  { type: 'organization', name: 'Greenway Growers', related: { type: 'organization', name: 'Fernleaf Garden Supply', label: 'supplier of', when: /supplier/i } },
  { type: 'organization', name: 'Riverbend Nursery' },
  { type: 'organization', name: 'Hillcrest Property Management', related: { type: 'organization', name: 'Fernleaf Garden Supply', label: 'customer of' } },
  { type: 'organization', name: 'Fernleaf Garden Supply' },
]

/** Stand-in for the extraction AI: per conversation, every cast member the text names, with the relations it states. */
function extractor(_system: string, prompt: string): string {
  const blocks = [...prompt.matchAll(/=== CONVERSATION (c\d+) ===\n([\s\S]*?)=== END \1 ===/g)]
  return JSON.stringify({
    conversations: blocks.map(([, key, text]) => {
      const title = text.match(/^Title: (.*)$/m)?.[1] ?? key
      const named = CAST.filter(c => text.includes(c.name) || (c.name === 'Greenway Growers' && /\bGreenway\b/.test(text)))
      if (!named.length || /cat|quiz|formula/i.test(title)) return { key, skip: true, skip_reason: 'no business facts' }
      return {
        key, skip: false, title, summary: `About ${title}.`, decisions: [], todos: [],
        entities: named.map(c => ({
          type: c.type,
          name: c.name,
          summary: c.name === 'Greenway Growers' ? 'Main plant supplier for the garden centre.' : undefined,
          facts: [{ fact: `${c.name} came up in "${title}"`, where: 'whole conversation' }],
          // "Our plant supplier Greenway Growers": the business itself is the unnamed "our".
          related: c.related && (c.related.when ? c.related.when.test(text) : named.some(n => n.name === c.related!.name))
            ? [{ type: c.related.type, name: c.related.name, label: c.related.label }]
            : [],
        })),
      }
    }),
  })
}

let server: http.Server
let baseUrl: string
let readerKey: string
let boardOnlyKey: string

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'owner', 'x', 'admin')`).run()
  createWorkspace({ slug: WS, name: 'Garden demo', vault_path: KB })
  db.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(settingKey(PACK_ID))
  setWikiLlmForTests(async (s, p) => extractor(s, p))

  const mint = (label: string, scopes: string[]) => {
    const r = createAgentKey({ id: 1, role: 'admin' }, { label, scopes, workspaces: [WS] })
    if (!r.ok) throw new Error(r.error)
    return r.key.token
  }
  readerKey = mint('kb reader', ['vault:read'])
  boardOnlyKey = mint('board only', ['board:read'])

  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/kb-wiki', kbWikiRouter)
  app.use('/api', agentMcpRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  // Build the workspace from the sample data: every sample chat export and call transcript.
  const jobs = createImport(KB, sampleImportFiles(), { by: 'test' })
  for (const j of jobs) startImport(KB, j.id)
  await whenImportsIdle(KB)
}, 60_000)

afterAll(async () => {
  setWikiLlmForTests(null)
  stopWikiLintScheduler()
  await whenImportsIdle(KB)
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

let nextId = 1
async function callTool(name: string, args: Record<string, unknown>, key = readerKey) {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  })
  expect(res.status).toBe(200)
  const result = (await res.json()).result as { content: Array<{ text: string }>; isError?: boolean }
  return { isError: !!result.isError, text: result.content[0].text, data: result.isError ? null : JSON.parse(result.content[0].text) }
}

describe('knowledge-base link graph over MCP (sample data)', () => {
  it('the sample import filled kb_edges as the wiki compiled', () => {
    expect(fs.existsSync(path.join(KB, `${PEOPLE}/tom-whitfield.md`))).toBe(true)
    const edges = readEdges(getDb(), WS)
    const kinds = new Set(edges.map(e => e.kind))
    expect(kinds).toEqual(new Set(['related', 'mentions', 'cited_by']))
    expect(edges).toContainEqual(expect.objectContaining({ from_rel: `${PEOPLE}/tom-whitfield.md`, to_rel: `${ORGS}/greenway-growers.md`, kind: 'related', label: 'works for' }))
    expect(edges).toContainEqual(expect.objectContaining({ from_rel: `${ORGS}/greenway-growers.md`, to_rel: `${ORGS}/fernleaf-garden-supply.md`, kind: 'related', label: 'supplier of' }))
  })

  it('kb_who_knows answers who knows about the supplier', async () => {
    const { data } = await callTool('kb_who_knows', { workspace: WS, topic: 'the supplier' })
    console.log('[kb_who_knows "the supplier"]', JSON.stringify({ matched: data.matched, people: data.people.map((p: { title: string; sources: number; latest: string; links: unknown[] }) => ({ title: p.title, sources: p.sources, latest: p.latest, links: p.links })) }, null, 1))
    expect(data.matched.map((m: { title: string }) => m.title)).toEqual(['Greenway Growers'])
    const names = data.people.map((p: { title: string }) => p.title)
    expect(names).toContain('Tom Whitfield')
    expect(names).toContain('Rosa Delgado')
    expect(names).toContain('Sam Okafor')
    // Marcus Bell (the client's facilities manager) never talks about the supplier.
    expect(names).not.toContain('Marcus Bell')
    const tom = data.people.find((p: { title: string }) => p.title === 'Tom Whitfield')
    expect(tom.sources).toBeGreaterThanOrEqual(2)
    expect(tom.links).toContainEqual({ from: `${PEOPLE}/tom-whitfield.md`, to: `${ORGS}/greenway-growers.md`, kind: 'related', label: 'works for' })
    // Ranked by number of citing sources, then recency.
    const counts = data.people.map((p: { sources: number }) => p.sources)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
  })

  it('kb_related returns connected pages with kind and label', async () => {
    const { data } = await callTool('kb_related', { workspace: WS, page: 'Tom Whitfield' })
    expect(data.page.rel).toBe(`${PEOPLE}/tom-whitfield.md`)
    const greenway = data.related.find((r: { rel: string }) => r.rel === `${ORGS}/greenway-growers.md`)
    expect(greenway.via).toContainEqual({ from: `${PEOPLE}/tom-whitfield.md`, to: `${ORGS}/greenway-growers.md`, kind: 'related', label: 'works for' })
    expect(data.related.some((r: { kind: string }) => r.kind === 'source')).toBe(true)

    const two = await callTool('kb_related', { workspace: WS, page: `${PEOPLE}/tom-whitfield.md`, depth: 2 })
    expect(two.data.related.some((r: { depth: number }) => r.depth === 2)).toBe(true)
    // depth is capped at 2.
    const big = await callTool('kb_related', { workspace: WS, page: 'Tom Whitfield', depth: 9 })
    expect(Math.max(...big.data.related.map((r: { depth: number }) => r.depth))).toBeLessThanOrEqual(2)
  })

  it('needs vault:read: a board-only key is refused by the guard', async () => {
    const r = await callTool('kb_who_knows', { workspace: WS, topic: 'supplier' }, boardOnlyKey)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/vault:read/)
  })

  it('an unknown page is a plain error, not a crash', async () => {
    const r = await callTool('kb_related', { workspace: WS, page: 'Nobody At All' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/No page called/)
  })
})
