import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'

// Real SQLite via initDb(). Env MUST be set before the dynamic import of
// db/index.js (and of the router, which reads GITHUB_WEBHOOK_SECRET per call
// but pulls in the whole service graph at import time).
const TMP_DB = path.join(os.tmpdir(), `cc-ghwebhook-test-${process.pid}-${Date.now()}.db`)
const TMP_SPOOL = path.join(os.tmpdir(), `cc-ghwebhook-spool-${process.pid}-${Date.now()}`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-ghwebhook'
process.env.GITHUB_WEBHOOK_SECRET = 'test-webhook-secret'
// Keep the preview-teardown side effect off the real spool dir and off docker.
process.env.PREVIEW_SPOOL_DIR = TMP_SPOOL
process.env.PREVIEW_SPOOL_HOST_KICK = '0'
// Force the deterministic no-LLM path in translateEntry().
delete process.env.ANTHROPIC_API_KEY

const { initDb, getDb } = await import('../db/index.js')
const { default: githubWebhookRouter, resetDeliveryDedupe } = await import('./github-webhook.js')

let server: http.Server
let baseUrl: string

function makeApp(): express.Express {
  const app = express()
  // Exactly how index.ts:180 mounts it — a RAW body, so the HMAC is computed
  // over the same bytes GitHub signed.
  app.use('/api/webhooks/github', express.raw({ type: '*/*', limit: '5mb' }), githubWebhookRouter)
  return app
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
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  fs.rmSync(TMP_SPOOL, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().exec('DELETE FROM dev_item_prs')
  getDb().exec('DELETE FROM dev_item_notes')
  getDb().exec('DELETE FROM changelog_entries')
  getDb().exec('DELETE FROM dev_items')
  getDb().exec('DELETE FROM objective_prs')
  getDb().exec('DELETE FROM objectives')
  resetDeliveryDedupe()
})

let deliverySeq = 0

/** Sign and POST a webhook exactly as GitHub does (api.md §7 W1). */
async function deliver(
  event: string,
  payload: unknown,
  opts: { signature?: string; delivery?: string } = {},
): Promise<{ status: number; json: any }> {
  const raw = JSON.stringify(payload)
  const signature =
    opts.signature ??
    'sha256=' +
      crypto
        .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET as string)
        .update(Buffer.from(raw, 'utf8'))
        .digest('hex')
  const res = await fetch(`${baseUrl}/api/webhooks/github`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': opts.delivery ?? `delivery-${++deliverySeq}`,
      'x-hub-signature-256': signature,
    },
    body: raw,
  })
  const json = (await res.json().catch(() => null)) as any
  return { status: res.status, json }
}

const REPO = 'Example-Project/example-project-platform' // has a seeded workspace_repos row
let prSeq = 900

function prPayload(over: {
  action: string
  merged?: boolean
  body?: string | null
  branch?: string
  repo?: string
  number?: number
}): Record<string, unknown> {
  const number = over.number ?? ++prSeq
  const repo = over.repo ?? REPO
  return {
    action: over.action,
    number,
    pull_request: {
      merged: over.merged ?? false,
      html_url: `https://github.com/${repo}/pull/${number}`,
      merge_commit_sha: 'abc123',
      merged_at: over.merged ? '2026-07-15T09:30:00Z' : null,
      title: 'feat: ship the thing',
      body: over.body ?? '',
      user: { login: 'octocat' },
      labels: [],
      base: { ref: 'main' },
      head: { ref: over.branch ?? 'feature/some-branch' },
    },
    repository: { full_name: repo },
  }
}

function makeDevItem(over: { workspace?: string; status?: string; objectiveId?: number } = {}): number {
  const info = getDb()
    .prepare("INSERT INTO dev_items (workspace, type, title, status, objective_id) VALUES (?, 'bug', 'An item', ?, ?)")
    .run(over.workspace ?? 'example-project', over.status ?? 'new', over.objectiveId ?? null)
  return Number(info.lastInsertRowid)
}

function devItem(id: number): any {
  return getDb().prepare('SELECT * FROM dev_items WHERE id = ?').get(id)
}

// ── Regression guards: everything that already worked must keep working ─────

describe('pre-existing webhook contract (NO REGRESSION)', () => {
  it('(a) still 401s on a bad signature and writes nothing', async () => {
    const devItemId = makeDevItem()
    const res = await deliver('pull_request', prPayload({ action: 'closed', merged: true, body: `Fixes DEV-${devItemId}` }), {
      signature: 'sha256=' + '0'.repeat(64),
    })
    expect(res.status).toBe(401)
    expect(devItem(devItemId).status).toBe('new')
    expect(getDb().prepare('SELECT COUNT(*) c FROM changelog_entries').get()).toEqual({ c: 0 })
  })

  it('(d) still auto-stamps pr_url/pr_number onto an objective matched by branch_name', async () => {
    const objInfo = getDb()
      .prepare("INSERT INTO objectives (title, status, branch_name) VALUES ('Branch-linked objective', 'working', ?)")
      .run('fix/704214-checkout-total')
    const objectiveId = Number(objInfo.lastInsertRowid)

    const res = await deliver(
      'pull_request',
      prPayload({ action: 'opened', branch: 'fix/704214-checkout-total', number: 4242 }),
    )
    expect(res.status).toBe(200)

    const obj = getDb().prepare('SELECT pr_url, pr_number, branch_name FROM objectives WHERE id = ?').get(objectiveId) as any
    expect(obj.pr_number).toBe(4242)
    expect(obj.pr_url).toBe(`https://github.com/${REPO}/pull/4242`)
    expect(obj.branch_name).toBe('fix/704214-checkout-total')
  })

  it('(e) still routes a check_run event to the external-check handler, not the PR path', async () => {
    const res = await deliver('check_run', {
      action: 'completed',
      check_run: { name: 'build', conclusion: 'failure', head_sha: 'deadbeef', pull_requests: [] },
      repository: { full_name: REPO },
    })
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(res.json.event).toBe('check_run')
    // Not treated as a pull_request: nothing was collected.
    expect(getDb().prepare('SELECT COUNT(*) c FROM changelog_entries').get()).toEqual({ c: 0 })
  })

  it('still collects a merged PR into changelog_entries (collectFromMergedPR untouched)', async () => {
    const res = await deliver('pull_request', prPayload({ action: 'closed', merged: true, number: 5150 }))
    expect(res.status).toBe(200)
    expect(res.json.entryId).toBeGreaterThan(0)
    const entry = getDb().prepare('SELECT * FROM changelog_entries WHERE pr_number = ?').get(5150) as any
    expect(entry.repo).toBe(REPO)
    expect(entry.title_eng).toBe('feat: ship the thing')
  })

  it('still marks objective_prs state on close', async () => {
    getDb()
      .prepare("INSERT INTO objectives (title, status, branch_name) VALUES ('x', 'working', 'fix/704215-thing')")
      .run()
    await deliver('pull_request', prPayload({ action: 'opened', branch: 'fix/704215-thing', number: 7777 }))
    await deliver('pull_request', prPayload({ action: 'closed', merged: true, branch: 'fix/704215-thing', number: 7777 }))
    const row = getDb().prepare('SELECT state FROM objective_prs WHERE pr_number = ?').get(7777) as any
    expect(row?.state).toBe('merged')
  })

  it('a ping and an unknown event are still 200s', async () => {
    expect((await deliver('ping', { zen: 'hi' })).status).toBe(200)
    expect((await deliver('issues', { action: 'opened' })).status).toBe(200)
  })
})

// ── New: DEV-ref linkage (api.md §6.1-§6.4) ─────────────────────────────────

describe('DEV-ref linkage on opened/synchronize (§6.2)', () => {
  it('upserts a dev_item_prs row and advances the item to in_progress', async () => {
    const devItemId = makeDevItem()
    const res = await deliver(
      'pull_request',
      prPayload({ action: 'opened', body: `Fixes DEV-${devItemId}\n\nSome description.`, number: 111 }),
    )
    expect(res.status).toBe(200)

    const link = getDb().prepare('SELECT * FROM dev_item_prs WHERE dev_item_id = ?').get(devItemId) as any
    expect(link.repo).toBe(REPO)
    expect(link.pr_number).toBe(111)
    expect(link.state).toBe('open')
    expect(link.link_source).toBe('pr_body')
    expect(devItem(devItemId).status).toBe('in_progress')
  })

  it('synchronize re-fires as an upsert, not a duplicate insert', async () => {
    const devItemId = makeDevItem()
    const payload = prPayload({ action: 'opened', body: `Refs DEV-${devItemId}`, number: 112 })
    await deliver('pull_request', payload)
    await deliver('pull_request', { ...payload, action: 'synchronize' })
    const rows = getDb().prepare('SELECT * FROM dev_item_prs WHERE dev_item_id = ?').all(devItemId)
    expect(rows.length).toBe(1)
  })

  it('falls back to the branch name only when the body carries no DEV ref (§6.4)', async () => {
    // The branch parser only recognises 4-8 digit ids, so seed an explicit one.
    const objectiveId = 704214
    getDb()
      .prepare("INSERT INTO objectives (id, title, status) VALUES (?, 'Branch fallback objective', 'working')")
      .run(objectiveId)
    const devItemId = makeDevItem({ objectiveId })

    await deliver('pull_request', prPayload({ action: 'opened', branch: `obj-${objectiveId}-work`, number: 113 }))

    const link = getDb().prepare('SELECT * FROM dev_item_prs WHERE dev_item_id = ?').get(devItemId) as any
    // The enum has no `branch` value, so a fallback link is recorded as 'manual'.
    expect(link.link_source).toBe('manual')
    expect(devItem(devItemId).status).toBe('in_progress')
  })

  it('an explicit DEV ref in the body wins over the branch fallback', async () => {
    const objectiveId = 704215
    getDb().prepare("INSERT INTO objectives (id, title, status) VALUES (?, 'obj', 'working')").run(objectiveId)
    const branchItem = makeDevItem({ objectiveId })
    const bodyItem = makeDevItem()

    await deliver(
      'pull_request',
      prPayload({ action: 'opened', body: `Fixes DEV-${bodyItem}`, branch: `obj-${objectiveId}-work`, number: 114 }),
    )

    expect(getDb().prepare('SELECT 1 FROM dev_item_prs WHERE dev_item_id = ?').get(bodyItem)).toBeTruthy()
    expect(getDb().prepare('SELECT 1 FROM dev_item_prs WHERE dev_item_id = ?').get(branchItem)).toBeUndefined()
  })

  it('(f) an unknown DEV-99999 logs and still returns 200', async () => {
    const res = await deliver('pull_request', prPayload({ action: 'opened', body: 'Fixes DEV-99999', number: 115 }))
    expect(res.status).toBe(200)
    expect(res.json.ok).toBe(true)
    expect(getDb().prepare('SELECT COUNT(*) c FROM dev_item_prs').get()).toEqual({ c: 0 })
  })
})

describe('DEV-ref shipping on merge (§6.3)', () => {
  it('(b) Fixes DEV-<id> on a merged PR ships the item and marks the PR row merged', async () => {
    const devItemId = makeDevItem()
    const res = await deliver(
      'pull_request',
      prPayload({ action: 'closed', merged: true, body: `Fixes DEV-${devItemId}`, number: 201 }),
    )
    expect(res.status).toBe(200)

    const item = devItem(devItemId)
    expect(item.status).toBe('shipped')
    // merged_at, never now() — a replayed delivery must not misdate the ship.
    expect(item.closed_at).toBe('2026-07-15T09:30:00Z')
    expect(item.changelog_entry_id).toBe(res.json.entryId)

    const link = getDb().prepare('SELECT * FROM dev_item_prs WHERE dev_item_id = ?').get(devItemId) as any
    expect(link.pr_number).toBe(201)
    expect(link.state).toBe('merged')

    const entry = getDb().prepare('SELECT * FROM changelog_entries WHERE id = ?').get(res.json.entryId) as any
    expect(entry.workspace).toBe('example-project')
    expect(entry.dev_item_id).toBe(devItemId)
  })

  it('(c) Refs DEV-<id> does NOT ship — the item stays in_progress', async () => {
    const devItemId = makeDevItem()
    await deliver('pull_request', prPayload({ action: 'opened', body: `Refs DEV-${devItemId}`, number: 202 }))
    expect(devItem(devItemId).status).toBe('in_progress')

    const res = await deliver(
      'pull_request',
      prPayload({ action: 'closed', merged: true, body: `Refs DEV-${devItemId}`, number: 202 }),
    )
    expect(res.status).toBe(200)
    const item = devItem(devItemId)
    expect(item.status).toBe('in_progress')
    expect(item.closed_at).toBeNull()
    // The PR link still transitions to merged; only SHIPPING is withheld.
    const link = getDb().prepare('SELECT state FROM dev_item_prs WHERE dev_item_id = ?').get(devItemId) as any
    expect(link.state).toBe('merged')
  })

  it('a closed-but-unmerged PR ships nothing and marks the link closed', async () => {
    const devItemId = makeDevItem()
    await deliver('pull_request', prPayload({ action: 'opened', body: `Fixes DEV-${devItemId}`, number: 203 }))
    const res = await deliver(
      'pull_request',
      prPayload({ action: 'closed', merged: false, body: `Fixes DEV-${devItemId}`, number: 203 }),
    )
    expect(res.status).toBe(200)
    expect(devItem(devItemId).status).toBe('in_progress')
    const link = getDb().prepare('SELECT state FROM dev_item_prs WHERE dev_item_id = ?').get(devItemId) as any
    expect(link.state).toBe('closed')
  })

  it('with multiple closing refs the LOWEST id is stamped and the others get an internal note', async () => {
    const first = makeDevItem()
    const second = makeDevItem()
    const res = await deliver(
      'pull_request',
      prPayload({
        action: 'closed',
        merged: true,
        body: `Fixes DEV-${first}\nCloses DEV-${second}`,
        number: 204,
      }),
    )
    expect(res.status).toBe(200)
    expect(devItem(first).status).toBe('shipped')
    expect(devItem(second).status).toBe('shipped')

    const entry = getDb().prepare('SELECT dev_item_id FROM changelog_entries WHERE id = ?').get(res.json.entryId) as any
    expect(entry.dev_item_id).toBe(Math.min(first, second))

    const notes = getDb().prepare('SELECT * FROM dev_item_notes').all() as any[]
    expect(notes.length).toBe(1)
    expect(notes[0].dev_item_id).toBe(Math.max(first, second))
    expect(notes[0].visibility).toBe('internal')
    expect(notes[0].body).toContain(`alongside DEV-${Math.min(first, second)}`)
  })

  it('a repo with no workspace_repos row leaves workspace NULL (fail closed, never fan out)', async () => {
    const res = await deliver(
      'pull_request',
      prPayload({ action: 'closed', merged: true, repo: 'Some-Org/unmapped-repo', number: 205 }),
    )
    expect(res.status).toBe(200)
    const entry = getDb().prepare('SELECT workspace FROM changelog_entries WHERE id = ?').get(res.json.entryId) as any
    expect(entry.workspace).toBeNull()
  })

  it('merged-before-opened creates the link directly as merged and a late synchronize cannot downgrade it', async () => {
    const devItemId = makeDevItem()
    await deliver(
      'pull_request',
      prPayload({ action: 'closed', merged: true, body: `Fixes DEV-${devItemId}`, number: 206 }),
    )
    let link = getDb().prepare('SELECT state FROM dev_item_prs WHERE dev_item_id = ?').get(devItemId) as any
    expect(link.state).toBe('merged')

    await deliver(
      'pull_request',
      prPayload({ action: 'synchronize', body: `Fixes DEV-${devItemId}`, number: 206 }),
    )
    link = getDb().prepare('SELECT state FROM dev_item_prs WHERE dev_item_id = ?').get(devItemId) as any
    expect(link.state).toBe('merged')
    // ...and the item is not un-shipped by the late event.
    expect(devItem(devItemId).status).toBe('shipped')
  })
})

describe('(g) delivery dedupe (§6.5)', () => {
  it('replaying the same x-github-delivery is an immediate 200 with no second write', async () => {
    const first = makeDevItem()
    const second = makeDevItem()
    const payload = prPayload({
      action: 'closed',
      merged: true,
      body: `Fixes DEV-${first}\nFixes DEV-${second}`,
      number: 301,
    })

    const one = await deliver('pull_request', payload, { delivery: 'replay-me' })
    expect(one.status).toBe(200)
    expect(one.json.duplicate).toBeUndefined()
    expect(getDb().prepare('SELECT COUNT(*) c FROM dev_item_notes').get()).toEqual({ c: 1 })

    const two = await deliver('pull_request', payload, { delivery: 'replay-me' })
    expect(two.status).toBe(200)
    expect(two.json.duplicate).toBe(true)

    // Nothing ran a second time.
    expect(getDb().prepare('SELECT COUNT(*) c FROM dev_item_notes').get()).toEqual({ c: 1 })
    expect(getDb().prepare('SELECT COUNT(*) c FROM dev_item_prs').get()).toEqual({ c: 2 })
    expect(getDb().prepare('SELECT COUNT(*) c FROM changelog_entries').get()).toEqual({ c: 1 })
  })

  it('a request with no delivery header is never treated as a duplicate', async () => {
    const res = await fetch(`${baseUrl}/api/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-github-event': 'ping',
        'x-hub-signature-256':
          'sha256=' +
          crypto
            .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET as string)
            .update(Buffer.from(JSON.stringify({ zen: 'a' }), 'utf8'))
            .digest('hex'),
      },
      body: JSON.stringify({ zen: 'a' }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as any
    expect(json.duplicate).toBeUndefined()
  })
})
