import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Real SQLite — exercises discovery logic against actual schema (workspace_repos,
// dev_items). The `gh` runner is faked; no network calls are made.
const TMP_DB = path.join(os.tmpdir(), `cc-posthog-bot-prs-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  discoverPosthogBotPrs,
  fetchPosthogBotPrs,
  persistPosthogBotPr,
  reposForDiscovery,
  POSTHOG_BOT_LOGIN,
} = await import('./posthog-bot-prs.js')

beforeAll(() => {
  initDb()
  // Seed a workspace so dev_items workspace FK is satisfied
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('example2', 'EXAMPLE2')",
    )
    .run()
  // Seed workspace_repos rows for discovery tests
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO workspace_repos (workspace, name, github, description, stack, docs_path, docs_enabled)
       VALUES ('example2', 'example3-platform', 'EXAMPLE2/example3-platform', null, '[]', 'docs', 0)`,
    )
    .run()
})

beforeEach(() => {
  // Clean dev_items between tests so idempotency tests start fresh
  getDb().prepare("DELETE FROM dev_items WHERE source_system = 'posthog-bot'").run()
})

// ── Helper: build a fake posthog[bot] PR response ──────────────────────────

function makePrJson(n: number, title = `Self-Driving PR #${n}`) {
  return {
    number: n,
    title,
    url: `https://github.com/EXAMPLE2/example3-platform/pull/${n}`,
    headRefName: `posthog/self-driving-${n}`,
    createdAt: '2026-09-21T00:00:00Z',
  }
}

function makeGhExec(prs: ReturnType<typeof makePrJson>[]): (args: string[]) => Promise<string> {
  return async (_args: string[]) => JSON.stringify(prs)
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('reposForDiscovery', () => {
  it('returns workspace_repos rows with a non-null github field', () => {
    const repos = reposForDiscovery(getDb())
    expect(repos.length).toBeGreaterThanOrEqual(1)
    expect(repos.some(r => r.github === 'EXAMPLE2/example3-platform')).toBe(true)
  })
})

describe('fetchPosthogBotPrs', () => {
  it('returns PRs from gh output and maps fields correctly', async () => {
    const gh = makeGhExec([makePrJson(101)])
    const prs = await fetchPosthogBotPrs(gh, 'EXAMPLE2/example3-platform', 'example2')
    expect(prs).toHaveLength(1)
    expect(prs[0].number).toBe(101)
    expect(prs[0].url).toBe('https://github.com/EXAMPLE2/example3-platform/pull/101')
    expect(prs[0].workspace).toBe('example2')
  })

  it('returns empty array when gh emits empty JSON array (zero PRs)', async () => {
    const gh = makeGhExec([])
    const prs = await fetchPosthogBotPrs(gh, 'EXAMPLE2/example3-platform', 'example2')
    expect(prs).toHaveLength(0)
  })

  it('returns empty array when gh emits malformed JSON', async () => {
    const gh = async () => 'not-json'
    const prs = await fetchPosthogBotPrs(gh, 'EXAMPLE2/example3-platform', 'example2')
    expect(prs).toHaveLength(0)
  })
})

describe('persistPosthogBotPr', () => {
  it('inserts a new dev_item row and returns true', () => {
    const pr = {
      repo: 'EXAMPLE2/example3-platform',
      workspace: 'example2',
      number: 200,
      title: 'PostHog Self-Driving PR #200',
      url: 'https://github.com/EXAMPLE2/example3-platform/pull/200',
      headRef: 'posthog/self-driving-200',
      createdAt: '2026-09-21T00:00:00Z',
    }
    const inserted = persistPosthogBotPr(getDb(), pr)
    expect(inserted).toBe(true)

    const row = getDb()
      .prepare("SELECT * FROM dev_items WHERE source_system = 'posthog-bot' AND source_id = ?")
      .get(pr.url) as { title: string; area: string } | undefined
    expect(row).toBeDefined()
    expect(row?.title).toBe(pr.title)
    expect(row?.area).toBe('posthog-self-driving')
  })

  it('is idempotent: inserting same URL twice creates only one row (returns false on 2nd run)', () => {
    const pr = {
      repo: 'EXAMPLE2/example3-platform',
      workspace: 'example2',
      number: 201,
      title: 'Idempotency PR #201',
      url: 'https://github.com/EXAMPLE2/example3-platform/pull/201',
      headRef: 'posthog/self-driving-201',
      createdAt: '2026-09-21T00:00:00Z',
    }
    const first = persistPosthogBotPr(getDb(), pr)
    const second = persistPosthogBotPr(getDb(), pr)
    expect(first).toBe(true)
    expect(second).toBe(false)

    const count = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM dev_items WHERE source_system = 'posthog-bot' AND source_id = ?")
        .get(pr.url) as { n: number }
    ).n
    expect(count).toBe(1)
  })
})

describe('discoverPosthogBotPrs', () => {
  it('returns repos_scanned list, correct prs_found and prs_persisted', async () => {
    const gh = makeGhExec([makePrJson(300), makePrJson(301)])
    const result = await discoverPosthogBotPrs(getDb(), gh)
    expect(result.repos_scanned).toContain('EXAMPLE2/example3-platform')
    // Mock returns 2 PRs per repo (same URLs, so deduped by uq_dev_items_source)
    expect(result.prs_found).toBeGreaterThanOrEqual(2)
    expect(result.prs_persisted).toBeGreaterThanOrEqual(2)
    expect(result.prs_persisted).toBeLessThanOrEqual(result.prs_found)
    expect(result.errors).toHaveLength(0)
  })

  it('zero-PRs case: scans repos but persists nothing', async () => {
    const gh = makeGhExec([])
    const result = await discoverPosthogBotPrs(getDb(), gh)
    expect(result.repos_scanned.length).toBeGreaterThanOrEqual(1)
    expect(result.prs_found).toBe(0)
    expect(result.prs_persisted).toBe(0)
  })

  it('idempotency on re-run: second call persists zero new rows', async () => {
    const gh = makeGhExec([makePrJson(400)])
    await discoverPosthogBotPrs(getDb(), gh)
    const second = await discoverPosthogBotPrs(getDb(), gh)
    expect(second.prs_persisted).toBe(0)
  })

  it('records errors for repos where gh fails, continues for others', async () => {
    const gh = async () => { throw new Error('gh: auth failed') }
    const result = await discoverPosthogBotPrs(getDb(), gh)
    expect(result.errors.length).toBeGreaterThanOrEqual(1)
    expect(result.errors[0].message).toContain('gh: auth failed')
  })

  it('POSTHOG_BOT_LOGIN constant is the expected GitHub login', () => {
    expect(POSTHOG_BOT_LOGIN).toBe('posthog[bot]')
  })
})
