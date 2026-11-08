/**
 * obj 900309 — PR merge-state recording: durable, idempotent, monotonic.
 *
 * Every case here is drawn from a way the live board was observed to be wrong, or
 * from a delivery order GitHub genuinely produces:
 *   - a merged delivery that arrives before the card ever links its PR;
 *   - a redelivered / manually replayed delivery;
 *   - a `closed` arriving after a `merged` (an older event replayed);
 *   - a log row whose `repo` is NULL and so was invisible to the repo-scoped UPDATE.
 *
 * Real SQLite against the real schema — the point is the table's behaviour, not a mock's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-prmerge-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { upsertObjectivePR, recordPRTerminalState, markPRStateByRepoAndNumber } =
  await import('./objective-prs.js')

const REPO = 'your-org/operationkit'
const OTHER = 'EXAMPLE2/example3-platform'
const prUrl = (n: number, repo = REPO) => `https://github.com/${repo}/pull/${n}`

function makeObjective(title = 'Test objective'): number {
  const r = getDb()
    .prepare(
      "INSERT INTO objectives (title, description, status, agent_context, workspace) VALUES (?, '', 'queue', 'cto', 'operator')",
    )
    .run(title)
  return Number(r.lastInsertRowid)
}

function stateOf(objectiveId: number, prNumber: number): string | undefined {
  return (
    getDb()
      .prepare('SELECT state FROM objective_prs WHERE objective_id = ? AND pr_number = ?')
      .get(objectiveId, prNumber) as { state?: string } | undefined
  )?.state
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

describe('recordPRTerminalState — the ordinary case', () => {
  it('flips an existing row to merged and reports what it did', () => {
    const obj = makeObjective('row first, then merge')
    upsertObjectivePR({ objective_id: obj, pr_number: 2001, pr_url: prUrl(2001) })
    expect(stateOf(obj, 2001)).toBe('open')

    const rec = recordPRTerminalState({
      repo: REPO,
      prNumber: 2001,
      state: 'merged',
      mergedAt: '2026-11-08T14:58:20Z',
      deliveryId: 'd6860770-db84-11f1-9197-4746451e3ce6',
    })

    expect(rec).not.toBeNull()
    expect(rec!.state).toBe('merged')
    expect(rec!.rowsMatched).toBe(1)
    expect(rec!.rowsUpdated).toBe(1)
    expect(rec!.replay).toBe(false)
    expect(stateOf(obj, 2001)).toBe('merged')
  })

  it('records the delivery id and merged_at so a replay is identifiable', () => {
    const row = getDb()
      .prepare('SELECT * FROM pr_terminal_states WHERE repo = ? AND pr_number = ?')
      .get(REPO, 2001) as { state: string; merged_at: string; delivery_id: string }
    expect(row.state).toBe('merged')
    expect(row.merged_at).toBe('2026-11-08T14:58:20Z')
    expect(row.delivery_id).toBe('d6860770-db84-11f1-9197-4746451e3ce6')
  })

  it('a closed-unmerged PR records closed', () => {
    const obj = makeObjective('closed unmerged')
    upsertObjectivePR({ objective_id: obj, pr_number: 2002, pr_url: prUrl(2002) })
    const rec = recordPRTerminalState({ repo: REPO, prNumber: 2002, state: 'closed' })
    expect(rec!.state).toBe('closed')
    expect(stateOf(obj, 2002)).toBe('closed')
  })
})

describe('recordPRTerminalState — replay and out-of-order deliveries', () => {
  it('is idempotent: the same merge twice updates once and reports replay', () => {
    const obj = makeObjective('replayed delivery')
    upsertObjectivePR({ objective_id: obj, pr_number: 2010, pr_url: prUrl(2010) })

    const first = recordPRTerminalState({ repo: REPO, prNumber: 2010, state: 'merged' })
    const second = recordPRTerminalState({ repo: REPO, prNumber: 2010, state: 'merged' })

    expect(first!.rowsUpdated).toBe(1)
    expect(first!.replay).toBe(false)
    expect(second!.rowsUpdated).toBe(0)
    expect(second!.replay).toBe(true)
    expect(stateOf(obj, 2010)).toBe('merged')
  })

  it('NEVER downgrades merged to closed, however the events are ordered', () => {
    const obj = makeObjective('out of order close after merge')
    upsertObjectivePR({ objective_id: obj, pr_number: 2011, pr_url: prUrl(2011) })

    recordPRTerminalState({ repo: REPO, prNumber: 2011, state: 'merged' })
    const late = recordPRTerminalState({ repo: REPO, prNumber: 2011, state: 'closed' })

    expect(late!.downgradeRefused).toBe(true)
    expect(late!.state).toBe('merged')
    expect(stateOf(obj, 2011)).toBe('merged')
  })

  it('a merge observed BEFORE the card links its PR is not lost — the later row is born merged', () => {
    // This is the delivery order a worker that runs `gh pr create` and reports to
    // /api/internal/pr-created afterwards produces, and GitHub never redelivers the
    // closed event, so the old UPDATE-only path dropped the merge permanently.
    const rec = recordPRTerminalState({ repo: REPO, prNumber: 2020, state: 'merged' })
    expect(rec!.rowsMatched).toBe(0)
    expect(rec!.rowsUpdated).toBe(0)

    const obj = makeObjective('merge first, then row')
    const row = upsertObjectivePR({ objective_id: obj, pr_number: 2020, pr_url: prUrl(2020) })

    expect(row!.state).toBe('merged')
    expect(stateOf(obj, 2020)).toBe('merged')
  })

  it('replays onto every card that later links the same PR', () => {
    recordPRTerminalState({ repo: REPO, prNumber: 2021, state: 'merged' })
    const a = makeObjective('linker A')
    const b = makeObjective('linker B')
    upsertObjectivePR({ objective_id: a, pr_number: 2021, pr_url: prUrl(2021) })
    upsertObjectivePR({ objective_id: b, pr_number: 2021, pr_url: prUrl(2021) })
    expect(stateOf(a, 2021)).toBe('merged')
    expect(stateOf(b, 2021)).toBe('merged')
  })
})

describe('recordPRTerminalState — rows the old repo-scoped UPDATE could not see', () => {
  it('matches and backfills a log row whose repo is NULL but whose pr_url names the repo', () => {
    const obj = makeObjective('repo-less log row')
    getDb()
      .prepare(
        "INSERT INTO objective_prs (objective_id, repo, pr_number, pr_url, state) VALUES (?, NULL, ?, ?, 'open')",
      )
      .run(obj, 2030, prUrl(2030))

    const rec = recordPRTerminalState({ repo: REPO, prNumber: 2030, state: 'merged' })

    expect(rec!.rowsMatched).toBe(1)
    expect(rec!.rowsUpdated).toBe(1)
    expect(stateOf(obj, 2030)).toBe('merged')
    const repo = (
      getDb().prepare('SELECT repo FROM objective_prs WHERE objective_id = ? AND pr_number = ?').get(obj, 2030) as { repo: string }
    ).repo
    expect(repo).toBe(REPO)
  })

  it('does NOT touch another repo PR carrying the same number', () => {
    const mine = makeObjective('same number, my repo')
    const theirs = makeObjective('same number, other repo')
    upsertObjectivePR({ objective_id: mine, pr_number: 2040, pr_url: prUrl(2040) })
    upsertObjectivePR({ objective_id: theirs, pr_number: 2040, pr_url: prUrl(2040, OTHER) })

    recordPRTerminalState({ repo: REPO, prNumber: 2040, state: 'merged' })

    expect(stateOf(mine, 2040)).toBe('merged')
    expect(stateOf(theirs, 2040)).toBe('open')
  })
})

describe('recordPRTerminalState — refusals', () => {
  it('refuses a call with no repo, no number, or a non-terminal state', () => {
    expect(recordPRTerminalState({ repo: '', prNumber: 1, state: 'merged' })).toBeNull()
    expect(recordPRTerminalState({ repo: REPO, prNumber: 0, state: 'merged' })).toBeNull()
    expect(recordPRTerminalState({ repo: REPO, prNumber: 2050, state: 'open' })).toBeNull()
  })
})

describe('markPRStateByRepoAndNumber — back-compat shim', () => {
  it('still returns the number of rows it moved', () => {
    const obj = makeObjective('legacy caller')
    upsertObjectivePR({ objective_id: obj, pr_number: 2060, pr_url: prUrl(2060) })
    expect(markPRStateByRepoAndNumber(REPO, 2060, 'merged')).toBe(1)
    expect(markPRStateByRepoAndNumber(REPO, 2060, 'merged')).toBe(0)
    expect(stateOf(obj, 2060)).toBe('merged')
  })
})
