import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Real SQLite — exercises the per-objective PR log (obj 2300) against the actual
// schema, including the UNIQUE(objective_id, pr_number) upsert and the migration
// backfill from objectives rows that already carry a linked PR.
const TMP_DB = path.join(os.tmpdir(), `cc-objprs-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { upsertObjectivePR, listObjectivePRs, markPRStateByRepoAndNumber, parseRepoFromPrUrl } =
  await import('./objective-prs.js')

const REPO = 'your-org/command-center-infra'
function prUrl(n: number): string {
  return `https://github.com/${REPO}/pull/${n}`
}

/** Insert a minimal objective row and return its id. */
function makeObjective(title = 'Test objective'): number {
  const r = getDb()
    .prepare(
      "INSERT INTO objectives (title, description, status, agent_context, workspace) VALUES (?, '', 'queue', 'cto', 'personal')"
    )
    .run(title)
  return Number(r.lastInsertRowid)
}

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

describe('parseRepoFromPrUrl', () => {
  it('extracts owner/name from a canonical PR URL', () => {
    expect(parseRepoFromPrUrl(prUrl(7))).toBe(REPO)
  })
  it('returns null on non-PR / empty input', () => {
    expect(parseRepoFromPrUrl('')).toBeNull()
    expect(parseRepoFromPrUrl(null)).toBeNull()
    expect(parseRepoFromPrUrl('https://example.com/foo')).toBeNull()
  })
})

describe('upsertObjectivePR — append vs upsert', () => {
  it('two distinct PRs on one objective produce two rows, newest-first', () => {
    const objId = makeObjective('multi-PR objective')
    upsertObjectivePR({ objective_id: objId, pr_number: 101, pr_url: prUrl(101), title: 'First PR' })
    upsertObjectivePR({ objective_id: objId, pr_number: 102, pr_url: prUrl(102), title: 'Second PR' })

    const rows = listObjectivePRs(objId)
    expect(rows).toHaveLength(2)
    // newest-first
    expect(rows[0].pr_number).toBe(102)
    expect(rows[1].pr_number).toBe(101)
    // repo parsed from the URL even though not passed explicitly
    expect(rows[0].repo).toBe(REPO)
    expect(rows[0].state).toBe('open')
  })

  it('re-reporting the same PR upserts (one row) and refreshes fields', () => {
    const objId = makeObjective('re-report objective')
    upsertObjectivePR({ objective_id: objId, pr_number: 200, pr_url: prUrl(200), title: 'Draft title' })
    upsertObjectivePR({ objective_id: objId, pr_number: 200, pr_url: prUrl(200), title: 'Final title', branch_name: 'cc/obj-x' })

    const rows = listObjectivePRs(objId)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Final title')
    expect(rows[0].branch_name).toBe('cc/obj-x')
  })

  it('a branch-only report (no resolvable PR number) inserts no row', () => {
    const objId = makeObjective('branch-only objective')
    const result = upsertObjectivePR({ objective_id: objId, branch_name: 'cc/obj-branch-only' })
    expect(result).toBeNull()
    expect(listObjectivePRs(objId)).toHaveLength(0)
  })

  it('derives the PR number from the URL when not supplied', () => {
    const objId = makeObjective('url-only objective')
    upsertObjectivePR({ objective_id: objId, pr_url: prUrl(303) })
    const rows = listObjectivePRs(objId)
    expect(rows).toHaveLength(1)
    expect(rows[0].pr_number).toBe(303)
  })
})

describe('markPRStateByRepoAndNumber — webhook freshness', () => {
  it('transitions a PR to merged', () => {
    const objId = makeObjective('merge objective')
    upsertObjectivePR({ objective_id: objId, pr_number: 401, pr_url: prUrl(401) })
    const touched = markPRStateByRepoAndNumber(REPO, 401, 'merged')
    expect(touched).toBe(1)
    expect(listObjectivePRs(objId)[0].state).toBe('merged')
  })

  it('transitions a PR to closed', () => {
    const objId = makeObjective('close objective')
    upsertObjectivePR({ objective_id: objId, pr_number: 402, pr_url: prUrl(402) })
    markPRStateByRepoAndNumber(REPO, 402, 'closed')
    expect(listObjectivePRs(objId)[0].state).toBe('closed')
  })

  it('a later metadata upsert does NOT clobber state set by the webhook', () => {
    const objId = makeObjective('state-preserve objective')
    upsertObjectivePR({ objective_id: objId, pr_number: 403, pr_url: prUrl(403) })
    markPRStateByRepoAndNumber(REPO, 403, 'merged')
    upsertObjectivePR({ objective_id: objId, pr_number: 403, pr_url: prUrl(403), title: 'renamed' })
    const row = listObjectivePRs(objId)[0]
    expect(row.state).toBe('merged')
    expect(row.title).toBe('renamed')
  })
})

describe('migration backfill — seeds objective_prs from existing objectives', () => {
  it('rebuilding the schema backfills objectives that already have a pr_number', () => {
    // Simulate a "pre-2300" objective: PR pointer set on the objective row, but
    // no objective_prs row yet (delete the one the upsert path would create).
    const db = getDb()
    const objId = makeObjective('legacy objective')
    db.prepare("UPDATE objectives SET pr_url = ?, pr_number = 999, branch_name = 'cc/legacy' WHERE id = ?")
      .run(prUrl(999), objId)
    db.prepare('DELETE FROM objective_prs WHERE objective_id = ?').run(objId)
    expect(listObjectivePRs(objId)).toHaveLength(0)

    // Re-run init (idempotent) — the backfill INSERT OR IGNORE seeds the row.
    initDb()
    const rows = listObjectivePRs(objId)
    expect(rows).toHaveLength(1)
    expect(rows[0].pr_number).toBe(999)
    expect(rows[0].repo).toBe(REPO)
    expect(rows[0].branch_name).toBe('cc/legacy')

    // Idempotent: a second init does not duplicate.
    initDb()
    expect(listObjectivePRs(objId)).toHaveLength(1)
  })
})
