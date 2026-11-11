import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Real SQLite via initDb() — exercises the actual changelog_entries + dev_items
// schema (including the 5 additive columns and the bidirectional link), not a fake.
const TMP_DB = path.join(os.tmpdir(), `cc-devchangelog-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-devchangelog'

const { initDb, getDb } = await import('../db/index.js')
const { default: devChangelogRouter } = await import('./dev-changelog.js')

let server: http.Server
let baseUrl: string
let adminCookie: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/dev-changelog', devChangelogRouter)
  return app
}

function token(role: 'admin' | 'member'): string {
  return jwt.sign({ id: 1, username: 'tester', role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
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
  getDb().exec('DELETE FROM changelog_entries')
  getDb().exec('DELETE FROM dev_item_prs')
  getDb().exec('DELETE FROM dev_item_notes')
  getDb().exec('DELETE FROM dev_items')
  getDb().exec("DELETE FROM workspace_integrations WHERE workspace = 'example'")
})

async function req(method: string, url: string, body?: unknown, cookie = adminCookie) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { status: res.status, json: json as any }
}

let prSeq = 1000

function makeEntry(over: Record<string, unknown> = {}): number {
  const prNumber = over.pr_number ?? ++prSeq
  const info = getDb()
    .prepare(
      `INSERT INTO changelog_entries
         (repo, pr_number, pr_url, platform, author, merged_at, category, status,
          title_eng, headline, body_stakeholder, overview, screenshots, workspace, dev_item_id)
       VALUES (@repo, @pr_number, @pr_url, @platform, @author, @merged_at, @category, @status,
               @title_eng, @headline, @body_stakeholder, @overview, @screenshots, @workspace, @dev_item_id)`,
    )
    .run({
      repo: 'your-org/example-platform',
      pr_number: prNumber,
      pr_url: `https://github.com/your-org/example-platform/pull/${prNumber}`,
      platform: 'Example Platform',
      author: 'octocat',
      merged_at: '2026-07-01T12:00:00Z',
      category: 'feature',
      status: 'draft',
      title_eng: 'feat: engineering title',
      headline: 'A shiny new thing',
      body_stakeholder: 'It does the thing you wanted.',
      overview: '',
      screenshots: '[]',
      workspace: null,
      dev_item_id: null,
      ...over,
    })
  return Number(info.lastInsertRowid)
}

function makeDevItem(title = 'A dev item'): number {
  const info = getDb()
    .prepare("INSERT INTO dev_items (workspace, type, title) VALUES ('example', 'bug', ?)")
    .run(title)
  return Number(info.lastInsertRowid)
}

describe('A12 GET /api/dev-changelog', () => {
  it('requires an admin session', async () => {
    const anon = await fetch(`${baseUrl}/api/dev-changelog`)
    expect(anon.status).toBe(401)
    const member = await req('GET', '/api/dev-changelog', undefined, `token=${token('member')}`)
    expect(member.status).toBe(403)
  })

  it('lists entries with every internal column, including the joined dev item', async () => {
    const devItemId = makeDevItem('Broken checkout total')
    const id = makeEntry({ workspace: 'example', dev_item_id: devItemId })
    makeEntry({ workspace: 'example-project', headline: 'Other platform' })

    const all = await req('GET', '/api/dev-changelog')
    expect(all.status).toBe(200)
    expect(all.json.data.length).toBe(2)
    expect(all.json.page).toHaveProperty('has_more', false)

    const row = all.json.data.find((r: any) => r.id === id)
    // The INTERNAL view: the opposite of the public feed's redaction.
    expect(row.title_eng).toBe('feat: engineering title')
    expect(row.status).toBe('draft')
    expect(row.author).toBe('octocat')
    expect(row.dev_item_id).toBe(devItemId)
    expect(row.dev_item_title).toBe('Broken checkout total')
    expect(row.dev_item_status).toBe('new')
    expect(Array.isArray(row.screenshots)).toBe(true)
  })

  it('filters by workspace, status, has_dev_item and q', async () => {
    const devItemId = makeDevItem()
    makeEntry({ workspace: 'example', dev_item_id: devItemId, headline: 'Linked example entry' })
    makeEntry({ workspace: 'example-project', headline: 'Unlinked ws entry', status: 'published' })

    const byWorkspace = await req('GET', '/api/dev-changelog?workspace=example')
    expect(byWorkspace.json.data.map((r: any) => r.headline)).toEqual(['Linked example entry'])

    const byStatus = await req('GET', '/api/dev-changelog?status=published')
    expect(byStatus.json.data.map((r: any) => r.headline)).toEqual(['Unlinked ws entry'])

    const linked = await req('GET', '/api/dev-changelog?has_dev_item=1')
    expect(linked.json.data.length).toBe(1)
    const unlinked = await req('GET', '/api/dev-changelog?has_dev_item=0')
    expect(unlinked.json.data.length).toBe(1)

    const search = await req('GET', '/api/dev-changelog?q=Unlinked')
    expect(search.json.data.length).toBe(1)
  })

  it('rejects an unknown status filter with the error envelope', async () => {
    const bad = await req('GET', '/api/dev-changelog?status=nope')
    expect(bad.status).toBe(400)
    expect(bad.json.error.code).toBe('validation_failed')
    expect(bad.json.error.request_id).toBeTruthy()
  })

  it('paginates via the cursor', async () => {
    makeEntry({ merged_at: '2026-07-01T00:00:00Z', headline: 'older' })
    makeEntry({ merged_at: '2026-07-02T00:00:00Z', headline: 'newer' })

    const first = await req('GET', '/api/dev-changelog?limit=1')
    expect(first.json.data.map((r: any) => r.headline)).toEqual(['newer'])
    expect(first.json.page.has_more).toBe(true)

    const second = await req('GET', `/api/dev-changelog?limit=1&cursor=${encodeURIComponent(first.json.page.next_cursor)}`)
    expect(second.json.data.map((r: any) => r.headline)).toEqual(['older'])
    expect(second.json.page.has_more).toBe(false)
  })
})

describe('A13 PATCH /api/dev-changelog/:id', () => {
  it('refuses a status write — publishing must go through A14', async () => {
    const id = makeEntry()
    const res = await req('PATCH', `/api/dev-changelog/${id}`, { status: 'published' })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('validation_failed')
    const row = getDb().prepare('SELECT status FROM changelog_entries WHERE id = ?').get(id) as { status: string }
    expect(row.status).toBe('draft')
  })

  it('writes the allowed copy fields and stringifies screenshots', async () => {
    const id = makeEntry()
    const res = await req('PATCH', `/api/dev-changelog/${id}`, {
      headline: 'Hand-written headline',
      how_to: 'Open Settings and click it.',
      screenshots: ['https://cdn/a.png'],
      workspace: 'example',
    })
    expect(res.status).toBe(200)
    expect(res.json.data.headline).toBe('Hand-written headline')
    expect(res.json.data.how_to).toBe('Open Settings and click it.')
    expect(res.json.data.screenshots).toEqual(['https://cdn/a.png'])
    const raw = getDb().prepare('SELECT screenshots FROM changelog_entries WHERE id = ?').get(id) as { screenshots: string }
    expect(raw.screenshots).toBe('["https://cdn/a.png"]')
  })

  it('rejects a non-array screenshots value', async () => {
    const id = makeEntry()
    const res = await req('PATCH', `/api/dev-changelog/${id}`, { screenshots: 'https://cdn/a.png' })
    expect(res.status).toBe(400)
    expect(res.json.error.details.some((d: any) => d.field === 'screenshots')).toBe(true)
  })

  it('back-stamps dev_items.changelog_entry_id bidirectionally, and releases the previous item', async () => {
    const id = makeEntry()
    const first = makeDevItem('first item')
    const second = makeDevItem('second item')

    const link = await req('PATCH', `/api/dev-changelog/${id}`, { dev_item_id: first })
    expect(link.status).toBe(200)
    expect(link.json.data.dev_item_id).toBe(first)
    const firstRow = getDb().prepare('SELECT changelog_entry_id FROM dev_items WHERE id = ?').get(first) as any
    expect(firstRow.changelog_entry_id).toBe(id)

    // Re-pointing must move the back-stamp, not leave two items claiming it.
    const relink = await req('PATCH', `/api/dev-changelog/${id}`, { dev_item_id: second })
    expect(relink.status).toBe(200)
    const afterFirst = getDb().prepare('SELECT changelog_entry_id FROM dev_items WHERE id = ?').get(first) as any
    const afterSecond = getDb().prepare('SELECT changelog_entry_id FROM dev_items WHERE id = ?').get(second) as any
    expect(afterFirst.changelog_entry_id).toBeNull()
    expect(afterSecond.changelog_entry_id).toBe(id)

    // Clearing releases the last one too.
    await req('PATCH', `/api/dev-changelog/${id}`, { dev_item_id: null })
    const cleared = getDb().prepare('SELECT changelog_entry_id FROM dev_items WHERE id = ?').get(second) as any
    expect(cleared.changelog_entry_id).toBeNull()
  })

  it('rejects an unknown dev_item_id', async () => {
    const id = makeEntry()
    const res = await req('PATCH', `/api/dev-changelog/${id}`, { dev_item_id: 999999 })
    expect(res.status).toBe(400)
  })

  it('404s on an unknown entry', async () => {
    const res = await req('PATCH', '/api/dev-changelog/424242', { headline: 'x' })
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('not_found')
  })
})

describe('A14 POST /api/dev-changelog/:id/publish', () => {
  it('refuses to publish an entry with a NULL workspace', async () => {
    const id = makeEntry({ workspace: null })
    const res = await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'publish' })
    expect(res.status).toBe(400)
    expect(res.json.error.details.some((d: any) => d.field === 'workspace')).toBe(true)
    const row = getDb().prepare('SELECT status, published_at FROM changelog_entries WHERE id = ?').get(id) as any
    expect(row.status).toBe('draft')
    expect(row.published_at).toBeNull()
  })

  it('refuses to publish without headline or body_stakeholder', async () => {
    const id = makeEntry({ workspace: 'example', headline: '', body_stakeholder: '' })
    const res = await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'publish' })
    expect(res.status).toBe(400)
    const fields = res.json.error.details.map((d: any) => d.field)
    expect(fields).toContain('headline')
    expect(fields).toContain('body_stakeholder')
  })

  it('publishes with a workspace and stamps published_at', async () => {
    const id = makeEntry({ workspace: 'example' })
    const res = await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'publish' })
    expect(res.status).toBe(200)
    expect(res.json.data.status).toBe('published')
    expect(res.json.data.published_at).toBeTruthy()
  })

  it('unpublish preserves published_at unless reset_published_at is passed', async () => {
    const id = makeEntry({ workspace: 'example' })
    const published = await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'publish' })
    const stamp = published.json.data.published_at

    const unpublished = await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'unpublish' })
    expect(unpublished.json.data.status).toBe('draft')
    expect(unpublished.json.data.published_at).toBe(stamp)

    // Re-publishing keeps the ORIGINAL public date.
    const republished = await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'publish' })
    expect(republished.json.data.published_at).toBe(stamp)

    const reset = await req('POST', `/api/dev-changelog/${id}/publish`, {
      action: 'unpublish',
      reset_published_at: true,
    })
    expect(reset.json.data.published_at).toBeNull()
  })

  it('skips an entry', async () => {
    const id = makeEntry({ workspace: 'example' })
    const res = await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'skip' })
    expect(res.json.data.status).toBe('skipped')
  })

  it('rejects an unknown action', async () => {
    const id = makeEntry({ workspace: 'example' })
    const res = await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'delete' })
    expect(res.status).toBe(400)
  })
})

describe('A15 POST /api/dev-changelog/:id/retranslate', () => {
  it('refuses on a published entry unless force is passed', async () => {
    const id = makeEntry({ workspace: 'example' })
    await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'publish' })
    const refused = await req('POST', `/api/dev-changelog/${id}/retranslate`, {})
    expect(refused.status).toBe(400)

    const forced = await req('POST', `/api/dev-changelog/${id}/retranslate`, { force: true })
    expect(forced.status).toBe(200)
  })

  it('preserves admin-edited copy by default', async () => {
    const id = makeEntry({ workspace: 'example' })
    await req('PATCH', `/api/dev-changelog/${id}`, {
      headline: 'Admin wrote this',
      body_stakeholder: 'And this.',
      how_to: 'And this too.',
    })
    const res = await req('POST', `/api/dev-changelog/${id}/retranslate`, {})
    expect(res.status).toBe(200)
    expect(res.json.data.headline).toBe('Admin wrote this')
    expect(res.json.data.body_stakeholder).toBe('And this.')
    expect(res.json.data.how_to).toBe('And this too.')
  })
})

describe('A16 POST /api/dev-changelog/:id/notify', () => {
  function configureNotify(notify: unknown) {
    getDb()
      .prepare(
        `INSERT INTO workspace_integrations (workspace, kind, config, status)
         VALUES ('example', 'development', ?, 'connected')
         ON CONFLICT(workspace, kind) DO UPDATE SET config = excluded.config`,
      )
      .run(JSON.stringify({ enabled: true, ...(notify === undefined ? {} : { notify }) }))
  }

  it('refuses when the entry is not published', async () => {
    configureNotify({ provider: 'resend', from: 'no-reply@example.com' })
    const id = makeEntry({ workspace: 'example' })
    const res = await req('POST', `/api/dev-changelog/${id}/notify`, {})
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('validation_failed')
  })

  it('refuses when the workspace has no notify provider', async () => {
    configureNotify(undefined)
    const id = makeEntry({ workspace: 'example' })
    await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'publish' })
    const res = await req('POST', `/api/dev-changelog/${id}/notify`, {})
    expect(res.status).toBe(400)
    expect(res.json.error.message).toContain('no notify provider')

    configureNotify({ provider: 'none' })
    const none = await req('POST', `/api/dev-changelog/${id}/notify`, {})
    expect(none.status).toBe(400)
  })

  it('dry_run renders the payload without stamping notified_at', async () => {
    configureNotify({ provider: 'resend', from: 'no-reply@example.com' })
    const id = makeEntry({ workspace: 'example' })
    await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'publish' })

    const res = await req('POST', `/api/dev-changelog/${id}/notify`, { dry_run: true })
    expect(res.status).toBe(200)
    expect(res.json.dry_run).toBe(true)
    expect(res.json.payload.headline).toBe('A shiny new thing')
    expect(res.json.recipient_count).toBe(0)
    const row = getDb().prepare('SELECT notified_at FROM changelog_entries WHERE id = ?').get(id) as any
    expect(row.notified_at).toBeNull()
  })

  it('stamps notified_at once and is idempotent thereafter', async () => {
    configureNotify({ provider: 'resend', from: 'no-reply@example.com' })
    const id = makeEntry({ workspace: 'example' })
    await req('POST', `/api/dev-changelog/${id}/publish`, { action: 'publish' })

    const first = await req('POST', `/api/dev-changelog/${id}/notify`, {})
    expect(first.status).toBe(200)
    expect(first.json.already_notified).toBeUndefined()
    const stamp = first.json.data.notified_at
    expect(stamp).toBeTruthy()

    const second = await req('POST', `/api/dev-changelog/${id}/notify`, {})
    expect(second.status).toBe(200)
    expect(second.json.already_notified).toBe(true)
    const row = getDb().prepare('SELECT notified_at FROM changelog_entries WHERE id = ?').get(id) as any
    expect(row.notified_at).toBe(stamp)
  })
})
