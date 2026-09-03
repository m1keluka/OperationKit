import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Real SQLite — exercises the changelog collector against the actual schema,
// including the audited-feature-brief join from objective_reviews (obj 937).
const TMP_DB = path.join(os.tmpdir(), `cc-changelog-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// Ensure the LLM fallback path stays offline/deterministic in CI.
delete process.env.ANTHROPIC_API_KEY

const { initDb, getDb } = await import('../db/index.js')
const { classifyPR, collectFromMergedPR, listPublished } = await import('./changelog.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* noop */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('classifyPR — conventional-commit + label gate', () => {
  it('treats feat/fix/perf as stakeholder-worthy', () => {
    expect(classifyPR('feat: add login', [])).toEqual({ worthy: true, category: 'feature' })
    expect(classifyPR('fix: stop crash on save', [])).toEqual({ worthy: true, category: 'fix' })
    expect(classifyPR('perf: faster board', [])).toEqual({ worthy: true, category: 'improvement' })
  })

  it('skips pure chores/refactors/docs by default', () => {
    expect(classifyPR('chore: bump deps', []).worthy).toBe(false)
    expect(classifyPR('refactor: extract helper', []).worthy).toBe(false)
    expect(classifyPR('docs: update readme', []).worthy).toBe(false)
  })

  it('lets labels override the default', () => {
    expect(classifyPR('chore: internal but shippable', ['stakeholder']).worthy).toBe(true)
    expect(classifyPR('feat: secret internal tool', ['skip-changelog']).worthy).toBe(false)
    expect(classifyPR('feat: x', ['changelog:fix']).category).toBe('fix')
  })
})

describe('collectFromMergedPR — audited feature brief (dogfood path)', () => {
  it('publishes with brief + screenshots pulled from objective_reviews', () => {
    const db = getDb()
    // Simulate a PR audited by this command-center: an objective with the PR
    // linked and a passing review carrying the reviewer-emitted feature brief.
    const prUrl = 'https://github.com/your-org/command-center-infra/pull/9001'
    const obj = db
      .prepare(
        `INSERT INTO objectives (title, description, status, pr_url, pr_number)
         VALUES ('[Review] Ship changelog', 'x', 'review', ?, 9001)`
      )
      .run(prUrl)
    const objectiveId = obj.lastInsertRowid as number
    const brief = JSON.stringify({
      headline: 'See exactly what shipped, in plain English',
      description: 'A new page shows stakeholders every feature that goes live, with screenshots.',
      overview: 'Each merged change is auto-collected, translated out of engineer-speak, and posted.',
      audience_worthy: true,
    })
    db.prepare(
      `INSERT INTO objective_reviews
        (objective_id, iteration, reviewer_session_id, mode, verdict, feature_brief, screenshot_paths)
       VALUES (?, 1, 'sess-1', 'browser', 'pass', ?, ?)`
    ).run(objectiveId, brief, JSON.stringify(['https://cdn.example.com/a.png']))

    const { entryId, status } = collectFromMergedPR({
      repo: 'your-org/command-center-infra',
      prNumber: 9001,
      prUrl,
      mergeCommitSha: 'deadbeef',
      author: 'm1keluka',
      mergedAt: '2026-06-20T12:00:00Z',
      title: 'feat: stakeholder changelog',
      body: '## What\'s shipping\nA changelog for stakeholders.',
      labels: [],
    })

    expect(status).toBe('published')
    const row = db.prepare('SELECT * FROM changelog_entries WHERE id = ?').get(entryId) as any
    expect(row.platform).toBe('Command Center')
    expect(row.headline).toContain('plain English')
    expect(row.overview).toContain('translated')
    expect(JSON.parse(row.screenshots)).toEqual(['https://cdn.example.com/a.png'])
    expect(row.objective_id).toBe(objectiveId)

    const published = listPublished()
    expect(published.find((e) => e.id === entryId)).toBeTruthy()
  })

  it('marks a non-worthy PR as skipped (not published)', () => {
    const { status } = collectFromMergedPR({
      repo: 'your-org/command-center-infra',
      prNumber: 9002,
      prUrl: 'https://github.com/your-org/command-center-infra/pull/9002',
      mergedAt: '2026-06-20T13:00:00Z',
      title: 'chore: bump eslint',
      labels: [],
    })
    expect(status).toBe('skipped')
    const published = listPublished()
    expect(published.find((e) => e.pr_number === 9002)).toBeUndefined()
  })

  it('is idempotent on re-delivery of the same PR (UNIQUE repo,pr_number)', () => {
    const payload = {
      repo: 'your-org/command-center-infra',
      prNumber: 9001,
      prUrl: 'https://github.com/your-org/command-center-infra/pull/9001',
      mergedAt: '2026-06-20T12:00:00Z',
      title: 'feat: stakeholder changelog',
      labels: [],
    }
    const a = collectFromMergedPR(payload)
    const b = collectFromMergedPR(payload)
    expect(a.entryId).toBe(b.entryId)
  })
})

// obj 704718 — `objectives.pr_number` is not repo-scoped, and this collector's
// objective lookup used to fall back to a bare `pr_number = ?` with `ORDER BY id DESC`.
// The live collisions with cc-infra numbers are obj 2040 (example3#202), 702028
// (example-project#245) and 701986 (example-project#241). Un-scoped, a merged PR in one
// repo would publish ANOTHER repo's objective's audited brief and screenshots.
describe('collectFromMergedPR — the objective lookup is repo-scoped (obj 704718)', () => {
  it('does not attribute a example3 PR to a cc-infra objective with the same number', () => {
    const db = getDb()
    const ccUrl = 'https://github.com/your-org/command-center-infra/pull/9202'
    const ccObj = db
      .prepare(
        `INSERT INTO objectives (title, description, status, pr_url, pr_number)
         VALUES ('[Review] cc-infra work', 'x', 'review', ?, 9202)`,
      )
      .run(ccUrl)
    const ccObjectiveId = ccObj.lastInsertRowid as number
    db.prepare(
      `INSERT INTO objective_reviews
        (objective_id, iteration, reviewer_session_id, mode, verdict, feature_brief, screenshot_paths)
       VALUES (?, 1, 'sess-cc', 'browser', 'pass', ?, ?)`,
    ).run(
      ccObjectiveId,
      JSON.stringify({
        headline: 'A COMMAND CENTER FEATURE THAT DID NOT SHIP IN EXAMPLE3',
        description: 'cc-infra only',
        overview: 'cc-infra only',
        audience_worthy: true,
      }),
      JSON.stringify(['https://cdn.example.com/cc-infra-leak.png']),
    )

    // Same PR NUMBER, different repo, and no pr_url match.
    const { entryId } = collectFromMergedPR({
      repo: 'EXAMPLE2/example3-platform',
      prNumber: 9202,
      prUrl: 'https://github.com/EXAMPLE2/example3-platform/pull/9202',
      mergeCommitSha: 'cafe1234',
      author: 'm1keluka',
      mergedAt: '2026-08-06T12:00:00Z',
      title: 'feat: something in example3',
      body: '',
      labels: [],
    })

    const row = db.prepare('SELECT * FROM changelog_entries WHERE id = ?').get(entryId) as {
      objective_id: number | null
      headline: string | null
      screenshots: string | null
    }
    expect(row.objective_id, 'must not borrow the cc-infra objective').not.toBe(ccObjectiveId)
    expect(row.headline || '').not.toContain('DID NOT SHIP IN EXAMPLE3')
    expect(row.screenshots || '').not.toContain('cc-infra-leak.png')
  })

  it('still links by pr_number when the repo DOES match and no pr_url was supplied', () => {
    const db = getDb()
    const obj = db
      .prepare(
        `INSERT INTO objectives (title, description, status, pr_url, pr_number, project)
         VALUES ('[Review] number-only linkage', 'x', 'review', NULL, 9303, 'command-center-infra')`,
      )
      .run()
    const objectiveId = obj.lastInsertRowid as number
    db.prepare(
      `INSERT INTO objective_reviews
        (objective_id, iteration, reviewer_session_id, mode, verdict, feature_brief, screenshot_paths)
       VALUES (?, 1, 'sess-n', 'browser', 'pass', ?, '[]')`,
    ).run(
      objectiveId,
      JSON.stringify({ headline: 'Linked by number within one repo', description: 'd', overview: 'o', audience_worthy: true }),
    )

    const { entryId } = collectFromMergedPR({
      repo: 'your-org/command-center-infra',
      prNumber: 9303,
      prUrl: '',
      mergeCommitSha: 'beef5678',
      author: 'm1keluka',
      mergedAt: '2026-08-06T13:00:00Z',
      title: 'feat: number-only linkage still works',
      body: '',
      labels: [],
    })
    const row = db.prepare('SELECT objective_id FROM changelog_entries WHERE id = ?').get(entryId) as { objective_id: number }
    expect(row.objective_id).toBe(objectiveId)
  })
})
