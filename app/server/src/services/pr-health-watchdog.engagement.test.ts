/**
 * Engagement expiry (obj 704784) — the convergence hole and its fix.
 *
 * THE HOLE, AS MEASURED ON THE LIVE BOARD 2026-08-06 23:26Z.
 * `GET /api/internal/pr-health` reported seven red PRs stuck on
 * `action: skip-owner-engaged, owner: owned-active`:
 *
 *   example3 #678 (obj 704687 done, idle  90m) — remediation rows 104–261m old
 *   example3 #677 (obj 704694 done, idle  98m) — rows  99m old
 *   example3 #676 (obj 704688 review, idle 142m)
 *   example3 #675 (obj 704693 done, idle 130m)
 *   example3 #674 (obj 704689 review, idle 150m)
 *   example3 #668 (obj 704650 review, idle 304m)
 *   example     #475 (obj 704677 done, idle 315m) — rows 390–402m old
 *
 * resolveOwner() had already correctly called every one of them `owned-stale`. They were
 * flipped back to `owned-active` by the engagement override, purely because a
 * non-`watchdog:` row existed in external_check_remediations for (repo, pr, head_sha) —
 * and NOTHING ever clears or expires such a row. The reconciler that exists precisely to
 * catch "the owning objective finished, so nobody is watching" was defeated by exactly
 * that case.
 *
 * These tests pin both halves of the fix: engagement EXPIRES (owner finished, or the row
 * aged out), and a genuinely live owner is still deferred to.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-prengage-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const W = await import('./pr-health-watchdog.js')
type PrSummary = import('./pr-health-watchdog.js').PrSummary
type WatchdogDeps = import('./pr-health-watchdog.js').WatchdogDeps

const REPO = 'EXAMPLE2/example3-platform'
const NOW = new Date('2026-08-06T23:26:00Z')
/** The real head_sha of example3 #678 on the day the hole was measured. */
const SHA = '2dfadf3535dadd427a074534debf42bd91ebc894'

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM external_check_remediations')
  db.exec("DELETE FROM objectives WHERE title LIKE 'engage-test%'")
  db.exec("DELETE FROM settings WHERE key LIKE 'pr_health_watchdog%'")
})

// ── Fixtures ────────────────────────────────────────────────────────────────────

/** SQLite stores these unzoned; `minutesAgo` mirrors the real writer (datetime('now')). */
function minutesAgo(n: number): string {
  return new Date(NOW.getTime() - n * 60_000).toISOString().replace('T', ' ').slice(0, 19)
}

function objective(fields: {
  status: string
  /** How long ago the objective row was last touched. */
  idleMinutes: number
  terminalByHuman?: boolean
  prNumber?: number
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO objectives (title, status, pr_url, updated_at, terminal_by_human, session_id)
       VALUES (?, ?, ?, ?, ?, 'sess-1')`,
    )
    .run(
      `engage-test ${fields.status}`,
      fields.status,
      `https://github.com/${REPO}/pull/${fields.prNumber ?? 678}`,
      minutesAgo(fields.idleMinutes),
      fields.terminalByHuman ? 1 : 0,
    )
  return Number(info.lastInsertRowid)
}

/** A row as the EVENT path writes them: a real check name, no `watchdog:` prefix. */
function remediationRow(objectiveId: number, ageMinutes: number, checkName = 'Vitest unit suite (7 pure configs)'): void {
  getDb()
    .prepare(
      `INSERT INTO external_check_remediations
         (objective_id, repo, pr_number, check_name, head_sha, attempt, created_at)
       VALUES (?, ?, 678, ?, ?, 1, ?)`,
    )
    .run(objectiveId, REPO, checkName, SHA, minutesAgo(ageMinutes))
}

function engagement(objectiveId?: number) {
  void objectiveId
  return W.eventPathEngagement(getDb(), REPO, 678, SHA, NOW)
}

/** example3 #678 as GitHub returned it: cancellation-only, red for hours. */
function livePr(): PrSummary {
  return {
    number: 678,
    title: 'engage-test pr',
    isDraft: false,
    headRefOid: SHA,
    headRefName: 'cto/704687-value-gate',
    createdAt: '2026-08-06T18:00:00Z',
    author: { login: 'oss-user', is_bot: false },
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'Vitest unit suite (7 pure configs)',
        status: 'COMPLETED',
        conclusion: 'CANCELLED',
        completedAt: '2026-08-06T21:42:35Z',
        detailsUrl: `https://github.com/${REPO}/actions/runs/31123744553/job/92708452407`,
      },
      { __typename: 'CheckRun', name: 'ok', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: '2026-08-06T21:00:00Z' },
    ],
  }
}

function deps(over: Partial<WatchdogDeps> = {}): WatchdogDeps {
  const exec = async (_f: string, args: string[]): Promise<string> =>
    args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([livePr()]) : ''
  return {
    db: getDb(),
    exec,
    now: () => NOW,
    env: { PR_HEALTH_WATCHDOG_REPOS: REPO },
    ...over,
  } as WatchdogDeps
}

// ── 1. Expiry by owner status ───────────────────────────────────────────────────

describe('eventPathEngagement — the owner must still exist', () => {
  it('is not engaged when there is no remediation row at all', () => {
    const e = engagement()
    expect(e.engaged).toBe(false)
    expect(e.reason).toBe('no event-path remediation on this commit')
    expect(e.rowAgeMinutes).toBeNull()
  })

  it('EXPIRES engagement when the owning objective is done (the 704784 hole)', () => {
    const id = objective({ status: 'done', idleMinutes: 90 })
    remediationRow(id, 104)
    const e = engagement()
    expect(e.engaged).toBe(false)
    expect(e.reason).toContain(`objective ${id} is done`)
    expect(e.reason).toContain('owner finished')
    expect(e.rowObjectiveStatus).toBe('done')
  })

  it('EXPIRES engagement when the owning objective is cancelled', () => {
    const id = objective({ status: 'cancelled', idleMinutes: 10 })
    remediationRow(id, 5)
    expect(engagement().engaged).toBe(false)
  })

  it('EXPIRES engagement when the objective row is gone entirely', () => {
    remediationRow(999_999, 5)
    const e = engagement()
    expect(e.engaged).toBe(false)
    expect(e.reason).toContain('no live objective row')
  })

  it('EXPIRES engagement when a live objective has gone quiet past the stale window', () => {
    // example3 #668's real shape: still `review`, but untouched for 304 minutes.
    const id = objective({ status: 'review', idleMinutes: 304 })
    remediationRow(id, 10)
    const e = engagement()
    expect(e.engaged).toBe(false)
    expect(e.reason).toContain('idle 304m')
  })
})

// ── 2. Expiry by row age ────────────────────────────────────────────────────────

describe('eventPathEngagement — the row itself ages out', () => {
  it('EXPIRES engagement once the newest row is past the freshness window', () => {
    const id = objective({ status: 'working', idleMinutes: 2 })
    remediationRow(id, 61) // default window is 60m
    const e = engagement()
    expect(e.engaged).toBe(false)
    expect(e.reason).toContain('engagement expired')
    expect(e.rowAgeMinutes).toBe(61)
  })

  it('honours PR_HEALTH_WATCHDOG_ENGAGED_MINUTES', () => {
    const id = objective({ status: 'working', idleMinutes: 2 })
    remediationRow(id, 61)
    const wide = W.eventPathEngagement(getDb(), REPO, 678, SHA, NOW, 120, {
      PR_HEALTH_WATCHDOG_ENGAGED_MINUTES: '90',
    })
    expect(wide.engaged).toBe(true)
    expect(W.engagedFreshnessMinutes({ PR_HEALTH_WATCHDOG_ENGAGED_MINUTES: '90' })).toBe(90)
    expect(W.engagedFreshnessMinutes({})).toBe(60)
  })

  it('measures age from the NEWEST row, so a fresh action revives a stale history', () => {
    const id = objective({ status: 'working', idleMinutes: 2 })
    remediationRow(id, 300, 'old check')
    remediationRow(id, 4, 'new check')
    const e = engagement()
    expect(e.engaged).toBe(true)
    expect(e.rowAgeMinutes).toBe(4)
  })

  it('ignores the watchdog\'s OWN claim rows — they are not evidence of an event-path owner', () => {
    const id = objective({ status: 'working', idleMinutes: 2 })
    getDb()
      .prepare(
        `INSERT INTO external_check_remediations
           (objective_id, repo, pr_number, check_name, head_sha, attempt, created_at)
         VALUES (?, ?, 678, 'watchdog:rerun-cancelled', ?, 0, ?)`,
      )
      .run(id, REPO, SHA, minutesAgo(1))
    expect(engagement().engaged).toBe(false)
  })
})

// ── 3. The no-double-driving intent is preserved ────────────────────────────────

describe('eventPathEngagement — a genuinely live owner is still deferred to', () => {
  it('is engaged for a fresh row on a working objective', () => {
    const id = objective({ status: 'working', idleMinutes: 3 })
    remediationRow(id, 8)
    const e = engagement()
    expect(e.engaged).toBe(true)
    expect(e.reason).toContain('external-remediation acted 8m ago')
    expect(e.reason).toContain(`objective ${id} is working`)
  })

  it('is engaged for a fresh row on an objective in review', () => {
    const id = objective({ status: 'review', idleMinutes: 20 })
    remediationRow(id, 20)
    expect(engagement().engaged).toBe(true)
  })

  it('stays engaged forever when a human explicitly ended the objective', () => {
    // terminal_by_human outranks every expiry rule: hands off, at any age.
    const id = objective({ status: 'done', idleMinutes: 5000, terminalByHuman: true })
    remediationRow(id, 5000)
    const e = engagement()
    expect(e.engaged).toBe(true)
    expect(e.reason).toContain('ended by a human')
  })
})

// ── 4. End-to-end regression: done objective + stale row => watchdog ACTS ────────

describe('runWatchdogOnce — convergence on a PR stuck at skip-owner-engaged', () => {
  it('REGRESSION: done objective + stale remediation row => not engaged => it acts', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    // Exactly the live example3 #678 shape: objective done 90m ago, event-path row 104m old.
    const id = objective({ status: 'done', idleMinutes: 90 })
    remediationRow(id, 104)

    const rerun: string[][] = []
    const exec = async (_f: string, args: string[]): Promise<string> => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([livePr()])
      rerun.push(args)
      return ''
    }
    const report = await W.runWatchdogOnce(deps({ exec, dryRun: false }))
    const p = report.prs[0]

    expect(p.owner).toBe('owned-stale')
    expect(p.action).not.toBe('skip-owner-engaged')
    expect(p.action).toBe('rerun-cancelled')
    expect(p.wouldOnly).toBe(false)
    // WHY it stopped counting stays on the surface for Operator.
    expect(p.ownerReason).toContain('owner finished')
    expect(p.ownerReason).toContain('objective is done')
    // It really acted: one `gh run rerun` for the cancelled job's run.
    expect(rerun).toEqual([['run', 'rerun', '31123744553', '--repo', REPO]])
  })

  it('still stands down (no gh writes) while the owner is genuinely live', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    const id = objective({ status: 'working', idleMinutes: 2 })
    remediationRow(id, 5)

    const writes: string[][] = []
    const notified: unknown[] = []
    const exec = async (_f: string, args: string[]): Promise<string> => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([livePr()])
      writes.push(args)
      return ''
    }
    const report = await W.runWatchdogOnce(deps({ exec, dryRun: false, notify: a => { notified.push(a) } }))

    expect(report.prs[0].owner).toBe('owned-active')
    expect(report.prs[0].action).toBe('skip-owner-engaged')
    expect(writes).toHaveLength(0)
    expect(notified).toHaveLength(0)
    expect(
      getDb().prepare("SELECT COUNT(*) n FROM external_check_remediations WHERE check_name LIKE 'watchdog:%'").get(),
    ).toEqual({ n: 0 })
  })

  it('expired engagement does NOT bypass the per-PR attempt budget', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    const id = objective({ status: 'done', idleMinutes: 90 })
    // 8 rows = the default maxAttemptsPerPr. Newest is 104m old, so engagement is expired
    // — but the shared budget must still stop the watchdog.
    for (let i = 0; i < 8; i++) remediationRow(id, 104 + i, `check ${i}`)

    const writes: string[][] = []
    const exec = async (_f: string, args: string[]): Promise<string> => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([livePr()])
      writes.push(args)
      return ''
    }
    const report = await W.runWatchdogOnce(deps({ exec, dryRun: false }))
    expect(report.prs[0].attemptsSpent).toBe(8)
    expect(report.prs[0].action).toBe('skip-cap')
    expect(writes).toHaveLength(0)
  })

  it('expired engagement does NOT bypass the grace window', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    const id = objective({ status: 'done', idleMinutes: 90 })
    remediationRow(id, 104)
    // Red only 5 minutes: the event path deserves its chance before we reconcile.
    const fresh = livePr()
    fresh.statusCheckRollup![0].completedAt = new Date(NOW.getTime() - 5 * 60_000).toISOString()

    const exec = async (_f: string, args: string[]): Promise<string> =>
      args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([fresh]) : ''
    const report = await W.runWatchdogOnce(deps({ exec, dryRun: false }))
    expect(report.prs[0].action).toBe('skip-grace')
  })

  it('expired engagement still observes only while the act-path is dark', async () => {
    // enabled flag left unset — the whole point of the call-time gate.
    const id = objective({ status: 'done', idleMinutes: 90 })
    remediationRow(id, 104)

    const writes: string[][] = []
    const exec = async (_f: string, args: string[]): Promise<string> => {
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([livePr()])
      writes.push(args)
      return ''
    }
    const report = await W.runWatchdogOnce(deps({ exec, dryRun: false }))
    expect(report.enabled).toBe(false)
    expect(report.prs[0].action).toBe('rerun-cancelled')
    expect(report.prs[0].wouldOnly).toBe(true)
    expect(writes).toHaveLength(0)
  })
})
