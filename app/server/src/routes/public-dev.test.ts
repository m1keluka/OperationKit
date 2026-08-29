import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

// Real SQLite via initDb() — this exercises the actual dev_items /
// dev_ingest_idempotency / workspace_integrations schema and the seeded
// registry, not a fake. DB_PATH must be set BEFORE db/index.js is imported.
const TMP_DB = path.join(os.tmpdir(), `cc-publicdev-test-${process.pid}-${Date.now()}.db`)
const TMP_UPLOADS = path.join(os.tmpdir(), `cc-publicdev-uploads-${process.pid}-${Date.now()}`)
process.env.DB_PATH = TMP_DB
process.env.DEV_ITEM_UPLOAD_DIR = TMP_UPLOADS

const { initDb, getDb } = await import('../db/index.js')
const { hashIngestToken, resetRateLimits } = await import('../middleware/dev-ingest-token.js')
const { default: publicDevRouter } = await import('./public-dev.js')

// A real-shaped token: dvi_<slug>_<32 hex>. Only sha256(token) is persisted.
const TOKEN = `dvi_example-project_${'9f3c1a77b2e04d6a8c15f0b3d7e29a4c'}`
const OTHER_TOKEN = `dvi_example2_${'1122334455667788990011223344556677'.slice(0, 32)}`

let server: http.Server
let baseUrl: string

function makeApp(): express.Express {
  const app = express()
  // No global body parser: the router owns `express.json({limit:'1mb'})`, which
  // is how it is mounted in index.ts.
  app.use('/api/public', publicDevRouter)
  return app
}

/** Point a seeded integration's config at a known token hash. */
function setTokenHash(workspace: string, token: string): void {
  const row = getDb()
    .prepare("SELECT config FROM workspace_integrations WHERE workspace = ? AND kind = 'development'")
    .get(workspace) as { config: string }
  const config = JSON.parse(row.config) as Record<string, unknown>
  config.ingest_token_hash = hashIngestToken(token)
  getDb()
    .prepare("UPDATE workspace_integrations SET config = ? WHERE workspace = ? AND kind = 'development'")
    .run(JSON.stringify(config), workspace)
}

function patchConfig(workspace: string, patch: Record<string, unknown>): void {
  const row = getDb()
    .prepare("SELECT config FROM workspace_integrations WHERE workspace = ? AND kind = 'development'")
    .get(workspace) as { config: string }
  const config = { ...(JSON.parse(row.config) as Record<string, unknown>), ...patch }
  getDb()
    .prepare("UPDATE workspace_integrations SET config = ? WHERE workspace = ? AND kind = 'development'")
    .run(JSON.stringify(config), workspace)
}

beforeAll(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  initDb()
  setTokenHash('example-project', TOKEN)
  setTokenHash('example2', OTHER_TOKEN)

  const app = makeApp()
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try {
    getDb().close()
  } catch {
    /* already closed */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  fs.rmSync(TMP_UPLOADS, { recursive: true, force: true })
})

beforeEach(() => {
  // The rate-limit buckets are module-global and would otherwise leak between
  // specs (20 P1s/min per token is well within a single test file).
  resetRateLimits()
  getDb().exec('DELETE FROM dev_item_attachments')
  getDb().exec('DELETE FROM dev_items')
  getDb().exec('DELETE FROM dev_ingest_idempotency')
  getDb().exec('DELETE FROM changelog_entries')
})

interface Res {
  status: number
  json: any
  headers: Headers
}

async function post(
  path: string,
  body: unknown,
  opts: { token?: string | null; key?: string | null; headers?: Record<string, string> } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) }
  const tok = opts.token === undefined ? TOKEN : opts.token
  if (tok) headers.Authorization = `Bearer ${tok}`
  const key = opts.key === undefined ? crypto.randomUUID() : opts.key
  if (key) headers['Idempotency-Key'] = key
  const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }
}

async function get(path: string, opts: { token?: string | null; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  const tok = opts.token === undefined ? TOKEN : opts.token
  if (tok) headers.Authorization = `Bearer ${tok}`
  const res = await fetch(`${baseUrl}${path}`, { headers })
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }
}

const VALID_BODY = {
  project: 'example-project-platform',
  type: 'bug',
  title: 'Checkout total flickers to $0',
  description: 'On first paint the total shows $0 for ~300ms.',
  severity: 'high',
  area: 'checkout',
  route: '/checkout?token=secret#frag',
  submitter_platform_user_id: 'user-abc',
  submitter_email: 'dana@example-shop.com',
  route_history: [{ path: '/cart', ts: '2026-08-02T14:02:41Z' }],
  client_meta: { viewport: { w: 1512, h: 858 }, role: 'consultant' },
}

describe('P1 POST /api/public/dev-items', () => {
  it('creates a dev_items row scoped to the token workspace', async () => {
    const res = await post('/api/public/dev-items', VALID_BODY)
    expect(res.status).toBe(201)
    expect(res.json.data.ref).toBe(`DEV-${res.json.data.id}`)
    expect(res.json.data.workspace).toBe('example-project')

    const row = getDb().prepare('SELECT * FROM dev_items WHERE id = ?').get(res.json.data.id) as any
    expect(row.workspace).toBe('example-project')
    expect(row.title).toBe(VALID_BODY.title)
    expect(row.status).toBe('new')
    expect(row.submitted_via).toBe('widget')
    expect(row.source_system).toBe('native')
    // Query string and fragment are stripped server-side — they carry tokens.
    expect(row.route).toBe('/checkout')
    expect(JSON.parse(row.client_meta).role).toBe('consultant')
    // attachment_upload_url is absent for a supabase-storage platform.
    expect(res.json.data.attachment_upload_url).toBeUndefined()
  })

  it('ignores server-owned fields sent by the client', async () => {
    const res = await post('/api/public/dev-items', {
      ...VALID_BODY,
      status: 'shipped',
      objective_id: 999,
      priority_rank: 1,
      submitted_via: 'admin',
      id: 12345,
    })
    expect(res.status).toBe(201)
    const row = getDb().prepare('SELECT * FROM dev_items WHERE id = ?').get(res.json.data.id) as any
    expect(row.status).toBe('new')
    expect(row.objective_id).toBeNull()
    expect(row.priority_rank).toBeNull()
    expect(row.submitted_via).toBe('widget')
  })

  it('rejects an absent or bogus token with 401 unauthorized', async () => {
    const none = await post('/api/public/dev-items', VALID_BODY, { token: null })
    expect(none.status).toBe(401)
    expect(none.json.error.code).toBe('unauthorized')

    const bogus = await post('/api/public/dev-items', VALID_BODY, {
      token: `dvi_example-project_${'0'.repeat(32)}`,
    })
    expect(bogus.status).toBe(401)
    expect(bogus.json.error.code).toBe('unauthorized')
    expect(getDb().prepare('SELECT COUNT(*) c FROM dev_items').get()).toEqual({ c: 0 })
  })

  it('requires an Idempotency-Key', async () => {
    const res = await post('/api/public/dev-items', VALID_BODY, { key: null })
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('validation_failed')
    expect(res.json.error.details.some((d: any) => d.field === 'Idempotency-Key')).toBe(true)
  })

  it('requires a title', async () => {
    const res = await post('/api/public/dev-items', { ...VALID_BODY, title: '   ' })
    expect(res.status).toBe(400)
    expect(res.json.error.details.some((d: any) => d.field === 'title')).toBe(true)
  })

  it('replays the same key + same body verbatim with the original status', async () => {
    const key = 'replay-key-1'
    const first = await post('/api/public/dev-items', VALID_BODY, { key })
    expect(first.status).toBe(201)
    const second = await post('/api/public/dev-items', VALID_BODY, { key })
    expect(second.status).toBe(201)
    expect(second.headers.get('idempotency-replayed')).toBe('true')
    expect(second.json.data.id).toBe(first.json.data.id)
    expect(getDb().prepare('SELECT COUNT(*) c FROM dev_items').get()).toEqual({ c: 1 })
  })

  it('409s on the same key with a different body', async () => {
    const key = 'replay-key-2'
    await post('/api/public/dev-items', VALID_BODY, { key })
    const res = await post('/api/public/dev-items', { ...VALID_BODY, title: 'Different title' }, { key })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('conflict')
  })

  it('403s when the body workspace disagrees with the credential', async () => {
    const res = await post('/api/public/dev-items', { ...VALID_BODY, workspace: 'example2' })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('forbidden')
    expect(getDb().prepare('SELECT COUNT(*) c FROM dev_items').get()).toEqual({ c: 0 })
  })

  it('403s on a project that is not registered for the workspace', async () => {
    const res = await post('/api/public/dev-items', { ...VALID_BODY, project: 'example3-platform' })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('forbidden')
    expect(getDb().prepare('SELECT COUNT(*) c FROM dev_items').get()).toEqual({ c: 0 })
  })

  it('403s on a screenshot bucket that is not the configured one', async () => {
    const res = await post('/api/public/dev-items', {
      ...VALID_BODY,
      screenshot: { provider: 'supabase', bucket: 'someone-elses-bucket', path: 'x.png' },
    })
    expect(res.status).toBe(403)
  })

  it('accepts a Route-A screenshot and stamps screenshot_path', async () => {
    const res = await post('/api/public/dev-items', {
      ...VALID_BODY,
      screenshot: {
        provider: 'supabase',
        bucket: 'feedback-attachments',
        path: 'ws/2026/08/shot.png',
        mime_type: 'image/png',
        size_bytes: 184320,
      },
    })
    expect(res.status).toBe(201)
    const row = getDb().prepare('SELECT screenshot_path FROM dev_items WHERE id = ?').get(res.json.data.id) as any
    expect(row.screenshot_path).toBe('ws/2026/08/shot.png')
    const att = getDb().prepare('SELECT * FROM dev_item_attachments WHERE dev_item_id = ?').get(res.json.data.id) as any
    expect(att.storage_provider).toBe('supabase')
    expect(att.storage_bucket).toBe('feedback-attachments')
  })

  it('rejects a non-array route_history and a non-object client_meta', async () => {
    const res = await post('/api/public/dev-items', { ...VALID_BODY, route_history: 'nope', client_meta: [1, 2] })
    expect(res.status).toBe(400)
    const fields = res.json.error.details.map((d: any) => d.field)
    expect(fields).toContain('route_history')
    expect(fields).toContain('client_meta')
  })

  it('keeps only the last 100 route_history entries and truncates console_log from the front', async () => {
    const history = Array.from({ length: 150 }, (_, i) => ({ path: `/p${i}`, ts: '2026-08-02T14:02:41Z' }))
    const consoleLog = 'X'.repeat(70 * 1024) + 'TAIL-MARKER'
    const res = await post('/api/public/dev-items', { ...VALID_BODY, route_history: history, console_log: consoleLog })
    expect(res.status).toBe(201)
    const row = getDb().prepare('SELECT route_history, console_log FROM dev_items WHERE id = ?').get(res.json.data.id) as any
    const parsed = JSON.parse(row.route_history)
    expect(parsed.length).toBe(100)
    expect(parsed[99].path).toBe('/p149')
    expect(row.console_log.startsWith('…[truncated ')).toBe(true)
    expect(row.console_log.endsWith('TAIL-MARKER')).toBe(true)
    expect(Buffer.byteLength(row.console_log, 'utf8')).toBeLessThanOrEqual(64 * 1024)
  })

  it('derives posthog_replay_url from the session id + configured project', async () => {
    patchConfig('example-project', { posthog_project_id: '12345' })
    const res = await post('/api/public/dev-items', { ...VALID_BODY, posthog_session_id: 'sess-1' })
    expect(res.status).toBe(201)
    const row = getDb().prepare('SELECT posthog_replay_url FROM dev_items WHERE id = ?').get(res.json.data.id) as any
    expect(row.posthog_replay_url).toBe('https://us.posthog.com/project/12345/replay/sess-1')
    patchConfig('example-project', { posthog_project_id: undefined })
  })

  it('stores client_submitted_at and the widget version in legacy_ref', async () => {
    const res = await post(
      '/api/public/dev-items',
      { ...VALID_BODY, client_submitted_at: '2026-08-02T14:03:05Z' },
      { headers: { 'X-CC-Widget-Version': '1.4.2' } },
    )
    expect(res.status).toBe(201)
    const row = getDb().prepare('SELECT legacy_ref FROM dev_items WHERE id = ?').get(res.json.data.id) as any
    expect(JSON.parse(row.legacy_ref)).toEqual({
      client_submitted_at: '2026-08-02T14:03:05Z',
      widget_version: '1.4.2',
    })
  })

  it('requires submitter_platform_user_id unless allow_anonymous is set', async () => {
    const res = await post('/api/public/dev-items', { ...VALID_BODY, submitter_platform_user_id: undefined })
    expect(res.status).toBe(400)
    expect(res.json.error.details.some((d: any) => d.field === 'submitter_platform_user_id')).toBe(true)

    patchConfig('example-project', { allow_anonymous: true })
    const ok = await post('/api/public/dev-items', { ...VALID_BODY, submitter_platform_user_id: undefined })
    expect(ok.status).toBe(201)
    patchConfig('example-project', { allow_anonymous: false })
  })

  it('rate limits at 20/min per token', async () => {
    let last: Res | null = null
    for (let i = 0; i < 21; i++) {
      last = await post('/api/public/dev-items', { ...VALID_BODY, submitter_platform_user_id: `u${i}` })
    }
    expect(last!.status).toBe(429)
    expect(last!.json.error.code).toBe('rate_limited')
    expect(last!.headers.get('retry-after')).toBeTruthy()
  })

  it('rate limits at 5/min per submitter', async () => {
    let last: Res | null = null
    for (let i = 0; i < 6; i++) last = await post('/api/public/dev-items', VALID_BODY)
    expect(last!.status).toBe(429)
  })

  it('503s when the integration is disconnected', async () => {
    getDb()
      .prepare("UPDATE workspace_integrations SET status = 'disconnected' WHERE workspace = ? AND kind = 'development'")
      .run('example-project')
    const res = await post('/api/public/dev-items', VALID_BODY)
    expect(res.status).toBe(503)
    expect(res.json.error.code).toBe('integration_disconnected')
    getDb()
      .prepare("UPDATE workspace_integrations SET status = 'connected' WHERE workspace = ? AND kind = 'development'")
      .run('example-project')
  })
})

describe('P2 POST /api/public/dev-items/:id/attachment', () => {
  async function createItem(): Promise<number> {
    const res = await post('/api/public/dev-items', VALID_BODY)
    return res.json.data.id as number
  }

  async function uploadPng(id: number, opts: { token?: string; kind?: string } = {}) {
    const form = new FormData()
    // 1x1 PNG magic bytes are enough for the sniff.
    const png = Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      Buffer.from('the rest of the file'),
    ])
    form.append('kind', opts.kind ?? 'screenshot')
    form.append('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'shot.png')
    const res = await fetch(`${baseUrl}/api/public/dev-items/${id}/attachment`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.token ?? TOKEN}` },
      body: form,
    })
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers }
  }

  it('stores the file and stamps screenshot_path', async () => {
    const id = await createItem()
    const res = await uploadPng(id)
    expect(res.status).toBe(201)
    expect(res.json.data.storage_provider).toBe('local')
    expect(res.json.data.storage_path.startsWith(path.join(TMP_UPLOADS, String(id)))).toBe(true)
    expect(fs.existsSync(res.json.data.storage_path)).toBe(true)

    const row = getDb().prepare('SELECT screenshot_path FROM dev_items WHERE id = ?').get(id) as any
    expect(row.screenshot_path).toBe(res.json.data.storage_path)
  })

  it('404s (not 403) for an item in another workspace', async () => {
    const id = await createItem()
    const res = await uploadPng(id, { token: OTHER_TOKEN })
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('not_found')
  })

  it('rejects a disallowed MIME type', async () => {
    const id = await createItem()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(Buffer.from('MZ...'))], { type: 'application/x-msdownload' }), 'x.exe')
    const res = await fetch(`${baseUrl}/api/public/dev-items/${id}/attachment`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: form,
    })
    expect(res.status).toBe(400)
    const json = (await res.json()) as any
    expect(json.error.code).toBe('validation_failed')
  })

  it('401s without a token', async () => {
    const id = await createItem()
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(Buffer.from('hello'))], { type: 'text/plain' }), 'a.txt')
    const res = await fetch(`${baseUrl}/api/public/dev-items/${id}/attachment`, { method: 'POST', body: form })
    expect(res.status).toBe(401)
  })
})

describe('P3 GET /api/public/dev-items/mine', () => {
  it("returns the submitter's items and redacts internal fields", async () => {
    const mine = await post('/api/public/dev-items', VALID_BODY)
    await post('/api/public/dev-items', { ...VALID_BODY, submitter_platform_user_id: 'someone-else' })

    const res = await get('/api/public/dev-items/mine?submitter_platform_user_id=user-abc')
    expect(res.status).toBe(200)
    expect(res.json.data.length).toBe(1)
    const item = res.json.data[0]
    expect(item.id).toBe(mine.json.data.id)
    expect(item.ref).toBe(`DEV-${mine.json.data.id}`)
    expect(item.status_label).toBe('Received')
    for (const forbidden of [
      'severity',
      'impact',
      'effort',
      'priority_rank',
      'area',
      'objective_id',
      'console_log',
      'client_meta',
      'submitter_email',
    ]) {
      expect(Object.keys(item)).not.toContain(forbidden)
    }
    expect(res.json.page).toEqual({ next_cursor: null, has_more: false })
  })

  it('requires submitter_platform_user_id', async () => {
    const res = await get('/api/public/dev-items/mine')
    expect(res.status).toBe(400)
    expect(res.json.error.details.some((d: any) => d.field === 'submitter_platform_user_id')).toBe(true)
  })

  it('rejects a bad status filter and an over-max limit', async () => {
    const bad = await get('/api/public/dev-items/mine?submitter_platform_user_id=user-abc&status=nope&limit=500')
    expect(bad.status).toBe(400)
    const fields = bad.json.error.details.map((d: any) => d.field)
    expect(fields).toContain('status')
    expect(fields).toContain('limit')
  })

  it('401s without a token', async () => {
    const res = await get('/api/public/dev-items/mine?submitter_platform_user_id=user-abc', { token: null })
    expect(res.status).toBe(401)
  })
})

describe('P4 GET /api/public/changelog/:workspace/feed.json', () => {
  function insertEntry(over: Record<string, unknown> = {}): number {
    const row = {
      repo: 'Example-Project/example-project-platform',
      pr_number: Math.floor(Math.random() * 100000),
      pr_url: 'https://github.com/Example-Project/example-project-platform/pull/912',
      platform: 'Example Project',
      author: 'oss-user',
      merged_at: '2026-08-05T22:41:00Z',
      category: 'fix',
      status: 'published',
      title_eng: 'fix(checkout): settle total on first paint',
      headline: 'Checkout totals now settle instantly',
      body_stakeholder: 'The total no longer flickers.',
      how_to: "Nothing to do — it's live.",
      screenshots: '["https://example.com/a.png"]',
      workspace: 'example-project',
      published_at: '2026-08-06T17:00:00Z',
      ...over,
    }
    const info = getDb()
      .prepare(
        `INSERT INTO changelog_entries
           (repo, pr_number, pr_url, platform, author, merged_at, category, status, title_eng,
            headline, body_stakeholder, how_to, screenshots, workspace, published_at)
         VALUES (@repo,@pr_number,@pr_url,@platform,@author,@merged_at,@category,@status,@title_eng,
                 @headline,@body_stakeholder,@how_to,@screenshots,@workspace,@published_at)`,
      )
      .run(row)
    return Number(info.lastInsertRowid)
  }

  it('401s on a non-public feed without a token', async () => {
    insertEntry()
    const res = await get('/api/public/changelog/example-project/feed.json', { token: null })
    expect(res.status).toBe(401)
    expect(res.json.error.code).toBe('unauthorized')
  })

  it('403s when the token is for another workspace', async () => {
    const res = await get('/api/public/changelog/example-project/feed.json', { token: OTHER_TOKEN })
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('forbidden')
  })

  it('404s for an unknown workspace', async () => {
    const res = await get('/api/public/changelog/nope/feed.json')
    expect(res.status).toBe(404)
    expect(res.json.error.code).toBe('not_found')
  })

  it('returns only published rows, with the redacted field set', async () => {
    const published = insertEntry()
    insertEntry({ status: 'draft', headline: 'Draft entry' })
    insertEntry({ status: 'published', published_at: null, headline: 'Unpublished date' })
    insertEntry({ workspace: 'example2', headline: 'Other platform' })

    const res = await get('/api/public/changelog/example-project/feed.json')
    expect(res.status).toBe(200)
    expect(res.json.data.length).toBe(1)
    const entry = res.json.data[0]
    expect(entry.id).toBe(published)
    expect(entry.headline).toBe('Checkout totals now settle instantly')
    expect(entry.body).toBe('The total no longer flickers.')
    expect(entry.screenshots).toEqual(['https://example.com/a.png'])
    for (const forbidden of ['dev_item_id', 'objective_id', 'author', 'title_eng', 'status', 'notified_at', 'merge_commit_sha']) {
      expect(Object.keys(entry)).not.toContain(forbidden)
    }
    expect(res.json.meta.workspace).toBe('example-project')
    expect(res.json.meta.generated_at).toBeTruthy()
  })

  it('serves a public feed with no token when feed_public is true', async () => {
    patchConfig('example-project', { feed_public: true })
    insertEntry()
    const res = await get('/api/public/changelog/example-project/feed.json', { token: null })
    expect(res.status).toBe(200)
    expect(res.json.data.length).toBe(1)
    patchConfig('example-project', { feed_public: false })
  })

  it('honours If-None-Match with a 304 and no body', async () => {
    insertEntry()
    const first = await get('/api/public/changelog/example-project/feed.json')
    const etag = first.headers.get('etag')
    expect(etag).toBeTruthy()
    expect(first.headers.get('cache-control')).toBe('public, max-age=300, stale-while-revalidate=3600')

    const second = await fetch(`${baseUrl}/api/public/changelog/example-project/feed.json`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'If-None-Match': etag as string },
    })
    expect(second.status).toBe(304)
    expect(await second.text()).toBe('')
  })

  it('intersects requested categories with config.feed_categories — a client cannot widen', async () => {
    insertEntry({ category: 'fix' })
    insertEntry({ category: 'infra', headline: 'Infra thing' })
    // config.feed_categories seeds as [feature, improvement, fix] — infra is not
    // in it, so asking for it must return nothing rather than the infra row.
    const res = await get('/api/public/changelog/example-project/feed.json?categories=infra')
    expect(res.status).toBe(200)
    expect(res.json.data.length).toBe(0)

    const all = await get('/api/public/changelog/example-project/feed.json')
    expect(all.json.data.map((e: any) => e.category)).toEqual(['fix'])
  })

  it('narrows by project via workspace_repos.github and 403s an unknown project', async () => {
    insertEntry()
    insertEntry({ repo: 'EXAMPLE2/example3-platform', headline: 'Wrong repo' })
    const ok = await get('/api/public/changelog/example-project/feed.json?project=example-project-platform')
    expect(ok.status).toBe(200)
    expect(ok.json.data.length).toBe(1)

    const bad = await get('/api/public/changelog/example-project/feed.json?project=example3-platform')
    expect(bad.status).toBe(403)
  })
})
