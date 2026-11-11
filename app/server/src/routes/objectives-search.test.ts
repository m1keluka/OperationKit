import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Server-side objective search (obj 702388): keyword+fuzzy GET + AI POST.
// Real SQLite + real router. Seeds objectives across statuses + workspaces +
// owners so we can assert full-table search (incl. done/cancelled), fuzzy
// tolerance, RBAC scoping, and the AI endpoint (mocked fetch — no real API).
const TMP_DB = path.join(os.tmpdir(), `cc-search-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-search'
delete process.env.ANTHROPIC_API_KEY // default: AI endpoint should 502

const { initDb, getDb } = await import('../db/index.js')
const { default: searchRouter } = await import('./objectives-search.js')

let server: http.Server
let baseUrl: string

// User ids
const ADMIN = 1
const EXAMPLE_MEM = 2 // 'own' visibility in workspace 'example'
const EXAMPLE4_MEM = 3

// Seeded objective ids
const ids: Record<string, number> = {}

function tokenFor(id: number, role: 'admin' | 'member', username: string): string {
  return jwt.sign({ id, username, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

const cookieAdmin = () => `token=${tokenFor(ADMIN, 'admin', 'admin')}`
const cookieExampleMem = () => `token=${tokenFor(EXAMPLE_MEM, 'member', 'examplemem')}`

async function getSearch(qs: string, cookie: string) {
  const res = await fetch(`${baseUrl}/api/objectives/search${qs}`, { headers: { Cookie: cookie } })
  const json = await res.json().catch(() => null)
  return { status: res.status, json: json as { results: any[] } }
}

async function postAi(body: unknown, cookie: string) {
  const res = await fetch(`${baseUrl}/api/objectives/search/ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
  body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json: json as { results?: any[]; error?: string } }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()

  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'examplemem', 'x', 'member')`).run(EXAMPLE_MEM)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'example4mem', 'x', 'member')`).run(EXAMPLE4_MEM)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (4, 'otheruser', 'x', 'member')`).run()
  // examplemem has 'own' visibility in example; example4mem in example4.
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, 'example', 'member', 'own')`).run(EXAMPLE_MEM)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, 'example4', 'member', 'own')`).run(EXAMPLE4_MEM)

  const ins = db.prepare(
    `INSERT INTO objectives (title, description, completion_goal, last_session_summary, status, workspace, created_by, assigned_user_id, deleted_at)
     VALUES (@title, @description, @completion_goal, @last_session_summary, @status, @workspace, @created_by, @assigned_user_id, @deleted_at)`
  )
  function seed(key: string, row: Record<string, unknown>) {
    const r = ins.run({
      title: '', description: '', completion_goal: '', last_session_summary: '',
      created_by: null, assigned_user_id: null, deleted_at: null, ...row,
    })
    ids[key] = Number(r.lastInsertRowid)
  }

  // A DONE objective owned by examplemem — full-table search must surface it.
  seed('exampleDone', {
    title: 'Kubernetes migration rollout', description: 'move workloads to k8s',
    status: 'done', workspace: 'example', created_by: EXAMPLE_MEM,
  })
  // A PRIVATE working objective in example owned by someone else — examplemem ('own')
  // must NOT see it; admin must.
  seed('examplePrivate', {
    title: 'Private Kubernetes secret rotation', description: 'sensitive',
    status: 'working', workspace: 'example', created_by: 4, assigned_user_id: 4,
  })
  // A CANCELLED objective in a different workspace — cross-workspace exclusion.
  seed('example4Cancelled', {
    title: 'Kubernetes teardown', description: 'other workspace',
    status: 'cancelled', workspace: 'example4', created_by: EXAMPLE4_MEM,
  })
  // A soft-deleted objective — must never appear.
  seed('deleted', {
    title: 'Kubernetes deleted ghost', description: 'tombstoned',
    status: 'done', workspace: 'example', created_by: EXAMPLE_MEM, deleted_at: '2026-01-01T00:00:00Z',
  })

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives/search', searchRouter)
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

describe('GET /api/objectives/search — keyword + fuzzy', () => {
  it('finds a DONE objective by a title word (full-table, all statuses)', async () => {
    const { status, json } = await getSearch('?q=migration&workspace=all', cookieAdmin())
    expect(status).toBe(200)
    const found = json.results.find(r => r.id === ids.exampleDone)
    expect(found).toBeTruthy()
    expect(found.status).toBe('done')
    // contract shape
    expect(found).toHaveProperty('score')
    expect(found).toHaveProperty('snippet')
    expect(found).toHaveProperty('agent_context')
    expect(found).toHaveProperty('updated_at')
    expect(found).toHaveProperty('workspace')
  })

  it('includes cancelled matches too', async () => {
    const { json } = await getSearch('?q=teardown&workspace=all', cookieAdmin())
    const found = json.results.find(r => r.id === ids.example4Cancelled)
    expect(found).toBeTruthy()
    expect(found.status).toBe('cancelled')
  })

  it('tolerates a misspelled query token (fuzzy)', async () => {
    // "kubernets" (missing an 'e') must still surface the Kubernetes rows.
    const { status, json } = await getSearch('?q=kubernets&workspace=all', cookieAdmin())
    expect(status).toBe(200)
    const titles = json.results.map(r => r.title)
    expect(titles.some((t: string) => /Kubernetes/i.test(t))).toBe(true)
  })

  it('q=% does not dump the whole table', async () => {
    const { status, json } = await getSearch('?q=%&workspace=all', cookieAdmin())
    expect(status).toBe(200)
    expect(json.results).toEqual([])
  })

  it('excludes soft-deleted rows', async () => {
    const { json } = await getSearch('?q=kubernetes&workspace=all', cookieAdmin())
    expect(json.results.find(r => r.id === ids.deleted)).toBeUndefined()
  })

  it('RBAC: member with own-visibility gets only their rows; admin gets all', async () => {
    const mem = await getSearch('?q=kubernetes&workspace=all', cookieExampleMem())
    const memIds = mem.json.results.map(r => r.id)
    expect(memIds).toContain(ids.exampleDone) // own row
    expect(memIds).not.toContain(ids.examplePrivate) // other user's private row
    expect(memIds).not.toContain(ids.example4Cancelled) // other workspace
    expect(memIds).not.toContain(ids.deleted)

    const adm = await getSearch('?q=kubernetes&workspace=all', cookieAdmin())
    const admIds = adm.json.results.map(r => r.id)
    expect(admIds).toContain(ids.exampleDone)
    expect(admIds).toContain(ids.examplePrivate)
    expect(admIds).toContain(ids.example4Cancelled)
  })
})

describe('POST /api/objectives/search/ai', () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
    delete process.env.ANTHROPIC_API_KEY
  })

  it('returns 502 when ANTHROPIC_API_KEY is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const { status, json } = await postAi({ q: 'kubernetes' }, cookieAdmin())
    expect(status).toBe(502)
    expect(json.error).toBeTruthy()
  })

  it('hydrates model-picked ids from candidates and drops invented ids', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key'
    // Mock ONLY the Anthropic call; pass through server-bound fetches to realFetch.
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : input?.url
      if (typeof url === 'string' && url.includes('api.anthropic.com')) {
        const payload = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                results: [
                  { id: ids.exampleDone, reason: 'matches k8s migration' },
                  { id: 99999999, reason: 'model-invented id that must be dropped' },
                ],
              }),
            },
          ],
        }
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return realFetch(input, init)
    }) as typeof fetch

    const { status, json } = await postAi({ q: 'kubernetes migration' }, cookieAdmin())
    expect(status).toBe(200)
    const resIds = (json.results || []).map(r => r.id)
    expect(resIds).toContain(ids.exampleDone)
    expect(resIds).not.toContain(99999999)
    const hydrated = json.results!.find(r => r.id === ids.exampleDone)
    expect(hydrated.reason).toBe('matches k8s migration')
    expect(hydrated).toHaveProperty('title')
    expect(hydrated).toHaveProperty('status')
    expect(hydrated).toHaveProperty('workspace')
  })
})
