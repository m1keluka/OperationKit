import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Real SQLite via initDb() — exercises the actual dev_items schema (CHECK
// constraints, FKs to workspaces/objectives, cascade deletes), not a fake.
const TMP_DB = path.join(os.tmpdir(), `cc-devitems-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-devitems'

const { initDb, getDb } = await import('../db/index.js')
const { default: devItemsRouter } = await import('./dev-items.js')

let server: http.Server
let baseUrl: string
let adminCookie: string

const WS = 'example-project'
const PROJECT = 'example-project-platform'

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/dev-items', devItemsRouter)
  return app
}

function token(role: 'admin' | 'member'): string {
  return jwt.sign({ id: 1, username: 'tester', role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  // dev_item_notes.author_user_id is a real FK to users(id), and the JWT below
  // claims id 1 — so the session user must actually exist, as it does in prod.
  getDb()
    .prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'tester', 'x', 'admin')")
    .run()
  const app = makeApp()
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  adminCookie = `token=${token('admin')}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().exec('DELETE FROM dev_item_prs')
  getDb().exec('DELETE FROM dev_item_notes')
  getDb().exec('DELETE FROM dev_items')
  getDb().exec("DELETE FROM objectives WHERE category = 'development'")
})

async function req(method: string, url: string, body?: unknown, cookie: string | null = adminCookie) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = res.status === 204 ? null : await res.json().catch(() => null)
  return { status: res.status, json: json as any }
}

async function createItem(overrides: Record<string, unknown> = {}) {
  const res = await req('POST', '/api/dev-items', {
    workspace: WS,
    project: PROJECT,
    title: 'Checkout total flickers to $0',
    description: 'It briefly renders $0.',
    ...overrides,
  })
  expect(res.status).toBe(201)
  return res.json.data as { id: number; status: string; triaged_at: string | null }
}

describe('admin auth gate (§3.7)', () => {
  it('401s with no session cookie', async () => {
    const res = await req('GET', '/api/dev-items', undefined, null)
    expect(res.status).toBe(401)
  })

  it('403s a non-admin session', async () => {
    const res = await req('GET', '/api/dev-items', undefined, `token=${token('member')}`)
    expect(res.status).toBe(403)
  })

  it('403s a non-admin trying to create an item, and writes nothing', async () => {
    const res = await req(
      'POST',
      '/api/dev-items',
      { workspace: WS, title: 'sneaky' },
      `token=${token('member')}`,
    )
    expect(res.status).toBe(403)
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM dev_items').get()).toEqual({ c: 0 })
  })
})

describe('A3 create + A1 list', () => {
  it('creates an admin-authored item with submitted_via=admin', async () => {
    const item = await createItem()
    expect(item.id).toBeGreaterThan(0)
    const row = getDb().prepare('SELECT * FROM dev_items WHERE id = ?').get(item.id) as any
    expect(row.submitted_via).toBe('admin')
    expect(row.workspace).toBe(WS)
    expect(row.status).toBe('new')
  })

  it('stamps triage when a triage dimension is supplied at create time', async () => {
    const item = await createItem({ severity: 'high', title: 'Triaged at birth' })
    const row = getDb().prepare('SELECT * FROM dev_items WHERE id = ?').get(item.id) as any
    expect(row.status).toBe('triaged')
    expect(row.triaged_by).toBe('tester')
    expect(row.triaged_at).not.toBeNull()
  })

  it('rejects an unknown workspace and an unknown project', async () => {
    const badWs = await req('POST', '/api/dev-items', { workspace: 'no-such-ws', title: 'x' })
    expect(badWs.status).toBe(400)
    expect(badWs.json.error.code).toBe('validation_failed')

    const badProject = await req('POST', '/api/dev-items', { workspace: WS, project: 'nope', title: 'x' })
    expect(badProject.status).toBe(400)
  })

  it('lists the item with facets and meta', async () => {
    const item = await createItem()
    const list = await req('GET', '/api/dev-items')
    expect(list.status).toBe(200)
    expect(list.json.data.map((r: any) => r.id)).toContain(item.id)
    expect(list.json.data[0].ref).toBe(`DEV-${item.id}`)
    expect(list.json.facets.status.new).toBe(1)
    expect(list.json.facets.workspace[WS]).toBe(1)
    expect(list.json.facets.type.bug).toBe(1)
    expect(list.json.meta.total_matching).toBe(1)
    expect(list.json.meta.filters_applied).toBe(0)
    expect(list.json.page.has_more).toBe(false)
    expect(list.json.page.next_cursor).toBeNull()
  })

  it('scopes the list by workspace and counts filters_applied', async () => {
    const mine = await createItem()
    const other = await createItem({ workspace: 'example2', project: 'example3-platform', title: 'example2 bug' })

    const scoped = await req('GET', `/api/dev-items?workspace=${WS}`)
    const ids = scoped.json.data.map((r: any) => r.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(other.id)
    expect(scoped.json.meta.total_matching).toBe(1)
    expect(scoped.json.meta.filters_applied).toBe(1)
    // The workspace facet ignores its own dimension, so it still sees both.
    expect(scoped.json.facets.workspace.example2).toBe(1)
  })

  it('400s on limit > 200 and on an unparseable cursor', async () => {
    expect((await req('GET', '/api/dev-items?limit=201')).status).toBe(400)
    expect((await req('GET', '/api/dev-items?cursor=not-a-cursor')).status).toBe(400)
    expect((await req('GET', '/api/dev-items?status=bogus')).status).toBe(400)
  })

  it('paginates with an opaque cursor', async () => {
    await createItem({ title: 'one' })
    await createItem({ title: 'two' })
    const first = await req('GET', '/api/dev-items?limit=1')
    expect(first.json.data.length).toBe(1)
    expect(first.json.page.has_more).toBe(true)
    const second = await req('GET', `/api/dev-items?limit=1&cursor=${encodeURIComponent(first.json.page.next_cursor)}`)
    expect(second.json.data.length).toBe(1)
    expect(second.json.data[0].id).not.toBe(first.json.data[0].id)
  })
})

describe('A2 detail', () => {
  it('returns item, workspace, notes, attachments and prs', async () => {
    const item = await createItem()
    await req('POST', `/api/dev-items/${item.id}/notes`, { body: 'Repro-d on staging.' })
    await req('POST', `/api/dev-items/${item.id}/attach-pr`, {
      repo: 'https://github.com/Example-Project/example-project-platform/pull/912',
    })

    const res = await req('GET', `/api/dev-items/${item.id}`)
    expect(res.status).toBe(200)
    expect(res.json.data.item.id).toBe(item.id)
    expect(res.json.data.workspace.slug).toBe(WS)
    expect(res.json.data.notes.length).toBe(1)
    expect(res.json.data.attachments).toEqual([])
    expect(res.json.data.prs[0].pr_number).toBe(912)
    expect(res.json.data.prs[0].via).toBe('manual')
    // Attachments/PR rows carry the stored columns; no signed_url is minted.
    expect(res.json.data.prs[0].signed_url).toBeUndefined()
  })

  it('honours ?include and 404s an unknown id', async () => {
    const item = await createItem()
    const res = await req('GET', `/api/dev-items/${item.id}?include=notes`)
    expect(res.json.data.notes).toEqual([])
    expect(res.json.data.prs).toBeUndefined()
    expect((await req('GET', '/api/dev-items/999999')).status).toBe(404)
  })
})

describe('A4 patch', () => {
  it('applies a merge patch and refuses to patch workspace', async () => {
    const item = await createItem()
    const res = await req('PATCH', `/api/dev-items/${item.id}`, { title: 'New title', severity: 'low' })
    expect(res.status).toBe(200)
    expect(res.json.data.title).toBe('New title')
    expect(res.json.data.severity).toBe('low')

    const rehome = await req('PATCH', `/api/dev-items/${item.id}`, { workspace: 'example2' })
    expect(rehome.status).toBe(400)
    const row = getDb().prepare('SELECT workspace FROM dev_items WHERE id = ?').get(item.id) as any
    expect(row.workspace).toBe(WS)
  })

  it('400s status=duplicate without duplicate_of_id', async () => {
    const item = await createItem()
    const res = await req('PATCH', `/api/dev-items/${item.id}`, { status: 'duplicate' })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('validation_failed')
    const row = getDb().prepare('SELECT status FROM dev_items WHERE id = ?').get(item.id) as any
    expect(row.status).toBe('new')
  })

  it('403s a duplicate_of_id in another workspace and 400s self-duplication', async () => {
    const item = await createItem()
    const foreign = await createItem({ workspace: 'example2', project: 'example3-platform', title: 'example2' })

    const cross = await req('PATCH', `/api/dev-items/${item.id}`, {
      status: 'duplicate',
      duplicate_of_id: foreign.id,
    })
    expect(cross.status).toBe(403)

    const self = await req('PATCH', `/api/dev-items/${item.id}`, {
      status: 'duplicate',
      duplicate_of_id: item.id,
    })
    expect(self.status).toBe(400)
  })

  it('stamps closed_at when moving into a closed status', async () => {
    const item = await createItem()
    const res = await req('PATCH', `/api/dev-items/${item.id}`, { status: 'declined' })
    expect(res.status).toBe(200)
    expect(res.json.data.closed_at).not.toBeNull()
  })
})

describe('A5 triage', () => {
  it('stamps triaged_at and moves new -> triaged', async () => {
    const item = await createItem()
    expect(item.status).toBe('new')
    const res = await req('POST', `/api/dev-items/${item.id}/triage`, {
      severity: 'high',
      impact: 3,
      effort: 1,
      area: 'checkout',
      note: 'One-line fix.',
    })
    expect(res.status).toBe(200)
    expect(res.json.data.status).toBe('triaged')
    expect(res.json.data.triaged_at).not.toBeNull()
    expect(res.json.data.severity).toBe('high')

    const row = getDb().prepare('SELECT triaged_by FROM dev_items WHERE id = ?').get(item.id) as any
    expect(row.triaged_by).toBe('tester')
    const notes = getDb().prepare('SELECT * FROM dev_item_notes WHERE dev_item_id = ?').all(item.id) as any[]
    expect(notes.length).toBe(1)
    expect(notes[0].visibility).toBe('internal')
  })

  it('does NOT downgrade an item that is already shipped', async () => {
    const item = await createItem()
    await req('PATCH', `/api/dev-items/${item.id}`, { status: 'shipped' })
    const res = await req('POST', `/api/dev-items/${item.id}/triage`, { severity: 'low' })
    expect(res.status).toBe(200)
    expect(res.json.data.status).toBe('shipped')
    expect(res.json.data.triaged_at).not.toBeNull()
  })

  it('400s impact/effort outside 1..3', async () => {
    const item = await createItem()
    const res = await req('POST', `/api/dev-items/${item.id}/triage`, { impact: 5 })
    expect(res.status).toBe(400)
    expect(res.json.error.details[0].field).toBe('impact')
  })
})

describe('A6 promote', () => {
  it('creates a development objective and is idempotent', async () => {
    const item = await createItem()
    const first = await req('POST', `/api/dev-items/${item.id}/promote`, {})
    expect(first.status).toBe(201)
    expect(first.json.already_promoted).toBe(false)
    const objectiveId = first.json.data.objective.id

    const objective = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(objectiveId) as any
    expect(objective.category).toBe('development')
    expect(objective.workspace).toBe(WS)
    expect(objective.description).toContain(`DEV-${item.id}`)
    expect(first.json.data.dev_item.status).toBe('planned')

    const second = await req('POST', `/api/dev-items/${item.id}/promote`, {})
    expect(second.status).toBe(200)
    expect(second.json.already_promoted).toBe(true)
    expect(second.json.data.objective.id).toBe(objectiveId)
    const count = getDb()
      .prepare("SELECT COUNT(*) AS c FROM objectives WHERE category = 'development'")
      .get() as any
    expect(count.c).toBe(1)
  })

  it('404s an unknown item', async () => {
    expect((await req('POST', '/api/dev-items/999999/promote', {})).status).toBe(404)
  })
})

describe('A7 rank', () => {
  it('lands the midpoint between two neighbours', async () => {
    const top = await createItem({ title: 'top' })
    const bottom = await createItem({ title: 'bottom' })
    const dragged = await createItem({ title: 'dragged' })
    getDb().prepare('UPDATE dev_items SET priority_rank = ? WHERE id = ?').run(1000, top.id)
    getDb().prepare('UPDATE dev_items SET priority_rank = ? WHERE id = ?').run(2000, bottom.id)

    const res = await req('POST', `/api/dev-items/${dragged.id}/rank`, {
      before_id: top.id,
      after_id: bottom.id,
    })
    expect(res.status).toBe(200)
    expect(res.json.data.priority_rank).toBe(1500)
    expect(res.json.renormalized).toBe(false)
  })

  it('400s when neither neighbour is given', async () => {
    const item = await createItem()
    const res = await req('POST', `/api/dev-items/${item.id}/rank`, {})
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('validation_failed')
  })
})

describe('A8 attach-pr', () => {
  it('accepts owner/repo, then repeats as a 200 no-op upsert', async () => {
    const item = await createItem()
    const first = await req('POST', `/api/dev-items/${item.id}/attach-pr`, {
      repo: 'Example-Project/example-project-platform',
      pr_number: 918,
      state: 'open',
    })
    expect(first.status).toBe(201)
    expect(first.json.data.link_source).toBe('manual')

    const again = await req('POST', `/api/dev-items/${item.id}/attach-pr`, {
      repo: 'Example-Project/example-project-platform',
      pr_number: 918,
    })
    expect(again.status).toBe(200)
    const rows = getDb().prepare('SELECT * FROM dev_item_prs WHERE dev_item_id = ?').all(item.id)
    expect(rows.length).toBe(1)
  })

  it('derives repo + pr_number from a PR URL, and 400s garbage', async () => {
    const item = await createItem()
    const res = await req('POST', `/api/dev-items/${item.id}/attach-pr`, {
      repo: 'https://github.com/Example-Project/example-project-platform/pull/912',
    })
    expect(res.status).toBe(201)
    expect(res.json.data.repo).toBe('Example-Project/example-project-platform')
    expect(res.json.data.pr_number).toBe(912)

    expect((await req('POST', `/api/dev-items/${item.id}/attach-pr`, { repo: 'not a repo' })).status).toBe(400)
  })

  it('advises objective_prs but still writes the row when the item is promoted', async () => {
    const item = await createItem()
    await req('POST', `/api/dev-items/${item.id}/promote`, {})
    const res = await req('POST', `/api/dev-items/${item.id}/attach-pr`, {
      repo: 'Example-Project/example-project-platform',
      pr_number: 920,
    })
    expect(res.status).toBe(201)
    expect(res.json.note).toContain('objective_prs')
    const rows = getDb().prepare('SELECT * FROM dev_item_prs WHERE dev_item_id = ?').all(item.id)
    expect(rows.length).toBe(1)
  })
})

describe('A9 notes', () => {
  it('creates a note honouring an agent author_label', async () => {
    const item = await createItem()
    const res = await req('POST', `/api/dev-items/${item.id}/notes`, {
      body: 'Fix shipped in #912.',
      visibility: 'submitter',
      author_label: 'agent',
    })
    expect(res.status).toBe(201)
    expect(res.json.data.author_label).toBe('agent')
    expect(res.json.data.author_user_id).toBe(1)
    expect(res.json.data.visibility).toBe('submitter')
  })

  it('400s an empty body', async () => {
    const item = await createItem()
    expect((await req('POST', `/api/dev-items/${item.id}/notes`, { body: '  ' })).status).toBe(400)
  })
})

describe('A10 soft delete', () => {
  it('204s, hides the item from A1, and restores with ?restore=1', async () => {
    const item = await createItem()
    const del = await req('DELETE', `/api/dev-items/${item.id}`)
    expect(del.status).toBe(204)

    const list = await req('GET', '/api/dev-items')
    expect(list.json.data.map((r: any) => r.id)).not.toContain(item.id)
    expect(list.json.meta.total_matching).toBe(0)
    expect((await req('GET', `/api/dev-items/${item.id}`)).status).toBe(404)
    // Nothing cascades — the row is still there, just stamped.
    const row = getDb().prepare('SELECT deleted_at FROM dev_items WHERE id = ?').get(item.id) as any
    expect(row.deleted_at).not.toBeNull()

    const restored = await req('DELETE', `/api/dev-items/${item.id}?restore=1`)
    expect(restored.status).toBe(200)
    const after = await req('GET', '/api/dev-items')
    expect(after.json.data.map((r: any) => r.id)).toContain(item.id)
  })
})

describe('A11 bulk', () => {
  it('sets status over three ids in one transaction', async () => {
    const a = await createItem({ title: 'a' })
    const b = await createItem({ title: 'b' })
    const c = await createItem({ title: 'c' })
    const res = await req('POST', '/api/dev-items/bulk', {
      ids: [a.id, b.id, c.id],
      op: 'set_status',
      params: { status: 'declined' },
    })
    expect(res.status).toBe(200)
    expect(res.json.data.updated).toBe(3)
    expect(res.json.data.ids).toEqual([a.id, b.id, c.id])
    const rows = getDb().prepare('SELECT status, closed_at FROM dev_items').all() as any[]
    expect(rows.every(r => r.status === 'declined' && r.closed_at !== null)).toBe(true)
  })

  it('is ALL-OR-NOTHING: one bad id changes nothing', async () => {
    const a = await createItem({ title: 'a' })
    const b = await createItem({ title: 'b' })
    const before = getDb().prepare('SELECT id, status, updated_at FROM dev_items ORDER BY id').all()

    const res = await req('POST', '/api/dev-items/bulk', {
      ids: [a.id, 999999, b.id],
      op: 'set_status',
      params: { status: 'declined' },
    })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('validation_failed')
    expect(res.json.error.details.some((d: any) => d.field === 'ids[999999]')).toBe(true)

    const after = getDb().prepare('SELECT id, status, updated_at FROM dev_items ORDER BY id').all()
    expect(after).toEqual(before)
  })

  it('bulk-deletes and bulk-restores', async () => {
    const a = await createItem({ title: 'a' })
    const b = await createItem({ title: 'b' })
    expect((await req('POST', '/api/dev-items/bulk', { ids: [a.id, b.id], op: 'delete' })).status).toBe(200)
    expect((await req('GET', '/api/dev-items')).json.meta.total_matching).toBe(0)
    expect((await req('POST', '/api/dev-items/bulk', { ids: [a.id, b.id], op: 'restore' })).status).toBe(200)
    expect((await req('GET', '/api/dev-items')).json.meta.total_matching).toBe(2)
  })

  it('400s more than 200 ids and an unknown op', async () => {
    const tooMany = await req('POST', '/api/dev-items/bulk', {
      ids: Array.from({ length: 201 }, (_, i) => i + 1),
      op: 'delete',
    })
    expect(tooMany.status).toBe(400)
    expect((await req('POST', '/api/dev-items/bulk', { ids: [1], op: 'nuke' })).status).toBe(400)
  })
})
