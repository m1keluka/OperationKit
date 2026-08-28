import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@command-center/shared'

// Real SQLite — exercises the obj-2352 PR auto-link + self-heal logic against the
// actual schema (objectives, objective_reviews, branch_leases, settings). The `gh`
// runner is faked so no network/shell is touched; postHarnessStatus is a spy.
const TMP_DB = path.join(os.tmpdir(), `cc-prlink-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// Pin the repo so the faked gh argv is deterministic regardless of env.
process.env.HARNESS_REPO = 'your-org/command-center-infra'

const { initDb, getDb } = await import('../db/index.js')
const {
  discoverAndBackfillPR,
  selfHealHarnessStatus,
  isPrAutolinkKilled,
  resolveBranchForObjective,
  HARNESS_CONTEXT,
  PR_LINKAGE_REPO,
} = await import('./pr-linkage.js')

const REPO = PR_LINKAGE_REPO
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`

/** Insert an objective and return its full row, applying the extra (migrated)
 *  columns via UPDATE so we don't depend on column order in the INSERT. */
function makeObjective(over: Partial<Objective> = {}): Objective {
  const db = getDb()
  const r = db
    .prepare(
      "INSERT INTO objectives (title, description, status, agent_context, workspace) VALUES (?, '', 'queue', 'cto', 'personal')",
    )
    .run(over.title ?? 'Test objective')
  const id = Number(r.lastInsertRowid)
  db.prepare(
    `UPDATE objectives SET
        status = ?, create_pr = ?, project = ?, type = ?, branch_name = ?,
        pr_url = ?, pr_number = ?, ai_review_verdict = ?
      WHERE id = ?`,
  ).run(
    over.status ?? 'review',
    over.create_pr ? 1 : 0,
    over.project ?? 'command-center-infra',
    over.type ?? 'project',
    over.branch_name ?? null,
    over.pr_url ?? null,
    over.pr_number ?? null,
    over.ai_review_verdict ?? null,
    id,
  )
  return db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective
}

function addReview(objectiveId: number, verdict: string, criteria: unknown[] = [], iteration = 1) {
  getDb()
    .prepare(
      `INSERT INTO objective_reviews (objective_id, iteration, reviewer_session_id, mode, verdict, criteria_results)
       VALUES (?, ?, 'sess-test', 'api', ?, ?)`,
    )
    .run(objectiveId, iteration, verdict, JSON.stringify(criteria))
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

beforeEach(() => {
  // clean state between cases
  getDb().exec('DELETE FROM objective_reviews; DELETE FROM objectives; DELETE FROM branch_leases; DELETE FROM settings;')
})

describe('Part 1 — discoverAndBackfillPR', () => {
  it('backfills pr_number + pr_url for an objective with a known branch but null pr_number', async () => {
    const branch = 'cc/obj-999-floor-pilot'
    const obj = makeObjective({ create_pr: true, branch_name: branch, pr_number: null })
    expect(obj.pr_number).toBeNull()

    const calls: string[][] = []
    const gh = async (args: string[]) => {
      calls.push(args)
      // gh pr list --head <branch> ...
      expect(args[0]).toBe('pr')
      expect(args).toContain(branch)
      return JSON.stringify([{ number: 147, url: prUrl(147), headRefName: branch }])
    }

    const res = await discoverAndBackfillPR(getDb(), obj, gh)
    expect(res.linked).toBe(true)
    expect(res.pr_number).toBe(147)

    // objectives "latest pointer" backfilled via the same /pr-created write path
    const row = getDb().prepare('SELECT pr_number, pr_url, branch_name FROM objectives WHERE id = ?').get(obj.id) as {
      pr_number: number; pr_url: string; branch_name: string
    }
    expect(row.pr_number).toBe(147)
    expect(row.pr_url).toBe(prUrl(147))
    expect(row.branch_name).toBe(branch)

    // per-objective PR log row appended (upsertObjectivePR write path)
    const logged = getDb().prepare('SELECT pr_number FROM objective_prs WHERE objective_id = ?').get(obj.id) as {
      pr_number: number
    } | undefined
    expect(logged?.pr_number).toBe(147)
  })

  it('is idempotent — no-ops when pr_number is already set (does not call gh)', async () => {
    const obj = makeObjective({ create_pr: true, branch_name: 'cc/obj-1-x', pr_number: 50, pr_url: prUrl(50) })
    let called = false
    const gh = async () => { called = true; return '[]' }
    const res = await discoverAndBackfillPR(getDb(), obj, gh)
    expect(res.linked).toBe(false)
    expect(res.reason).toBe('already-linked')
    expect(called).toBe(false)
  })

  it('returns no-pr (and does not write) when GitHub reports no matching PR', async () => {
    const obj = makeObjective({ create_pr: true, branch_name: 'cc/obj-2-y', pr_number: null })
    const gh = async () => '[]'
    const res = await discoverAndBackfillPR(getDb(), obj, gh)
    expect(res.linked).toBe(false)
    expect(res.reason).toBe('no-pr')
    const row = getDb().prepare('SELECT pr_number FROM objectives WHERE id = ?').get(obj.id) as { pr_number: number | null }
    expect(row.pr_number).toBeNull()
  })

  it('swallows a gh failure (never throws) and reports gh-error', async () => {
    const obj = makeObjective({ create_pr: true, branch_name: 'cc/obj-3-z', pr_number: null })
    const gh = async () => { throw new Error('gh: not logged in') }
    const res = await discoverAndBackfillPR(getDb(), obj, gh)
    expect(res.linked).toBe(false)
    expect(res.reason).toBe('gh-error')
  })

  it('resolves the branch from branch_leases when the objective row has no branch_name', async () => {
    // create_pr=0 so deriveBranchName returns null → forces the lease fallback
    const obj = makeObjective({ create_pr: false, branch_name: null, pr_number: null })
    const branch = 'cc/obj-leased-branch'
    getDb()
      .prepare(
        `INSERT INTO branch_leases (branch_name, objective_id, session_id, acquired_at, heartbeat_at, released_at)
         VALUES (?, ?, 's1', datetime('now'), datetime('now'), NULL)`,
      )
      .run(branch, obj.id)
    expect(resolveBranchForObjective(getDb(), obj)).toBe(branch)

    const gh = async (args: string[]) => {
      expect(args).toContain(branch)
      return JSON.stringify([{ number: 321, url: prUrl(321), headRefName: branch }])
    }
    const res = await discoverAndBackfillPR(getDb(), obj, gh)
    expect(res.linked).toBe(true)
    expect(res.pr_number).toBe(321)
  })
})

describe('Part 2 — selfHealHarnessStatus', () => {
  it('posts harness/test-agent=success when a pass-verdict PR head SHA lacks the status', async () => {
    const obj = makeObjective({ status: 'review', ai_review_verdict: 'pass', pr_number: 147, pr_url: prUrl(147) })
    addReview(obj.id, 'pass')

    const gh = async (args: string[]) => {
      const ep = args[1] // args[0]==='api'
      if (ep === `repos/${REPO}/pulls/147`) return 'deadbeef'
      if (ep === `repos/${REPO}/commits/deadbeef/statuses`) return 'some-other-check\nvercel' // no harness ctx
      throw new Error(`unexpected gh api ${ep}`)
    }
    const posted: Array<{ id: number; pr: number }> = []
    const res = await selfHealHarnessStatus(getDb(), obj, gh, (o, prNumber) => posted.push({ id: o.id, pr: prNumber }))

    expect(res.posted).toBe(true)
    expect(res.reason).toBe('posted')
    expect(posted).toEqual([{ id: obj.id, pr: 147 }])
  })

  it('does NOT double-post when harness/test-agent is already present', async () => {
    const obj = makeObjective({ status: 'review', ai_review_verdict: 'pass', pr_number: 147, pr_url: prUrl(147) })
    addReview(obj.id, 'pass')

    const gh = async (args: string[]) => {
      const ep = args[1]
      if (ep === `repos/${REPO}/pulls/147`) return 'cafef00d'
      if (ep === `repos/${REPO}/commits/cafef00d/statuses`) return `vercel\n${HARNESS_CONTEXT}`
      throw new Error(`unexpected gh api ${ep}`)
    }
    let postCount = 0
    const res = await selfHealHarnessStatus(getDb(), obj, gh, () => { postCount++ })

    expect(res.posted).toBe(false)
    expect(res.reason).toBe('already-present')
    expect(postCount).toBe(0)
  })

  // ── obj 704734: a FAILURE status must be healable, a FAIL verdict must not ────
  //
  // The defect: the presence check ignored STATE. A review that ends blocked/fail posts
  // harness/test-agent=FAILURE; once that sat on the head SHA the self-heal returned
  // 'already-present' forever, so a PR that LATER earned a pass stayed permanently
  // unmergeable. PR #250 had to be un-stranded by hand.
  //
  // These fakes emit the real `/statuses` shape the fix asks gh for — "<context>\t<state>",
  // newest-first — so the tests exercise the actual parse, not a convenient stand-in.
  const statusLine = (context: string, state: string) => `${context}\t${state}`

  it('re-posts success over a FAILURE harness status once the verdict is a pass', async () => {
    const obj = makeObjective({ status: 'review', ai_review_verdict: 'pass', pr_number: 250, pr_url: prUrl(250) })
    addReview(obj.id, 'pass', [], 2)

    const gh = async (args: string[]) => {
      const ep = args[1]
      if (ep === `repos/${REPO}/pulls/250`) return 'f00dface'
      if (ep === `repos/${REPO}/commits/f00dface/statuses`) {
        // Newest-first, exactly as GitHub returns it: the live harness status is the
        // FAILURE left by the earlier blocked review.
        return [
          statusLine(HARNESS_CONTEXT, 'failure'),
          statusLine('vercel', 'success'),
        ].join('\n')
      }
      throw new Error(`unexpected gh api ${ep}`)
    }
    const posted: Array<{ id: number; pr: number }> = []
    const res = await selfHealHarnessStatus(getDb(), obj, gh, (o, prNumber) => posted.push({ id: o.id, pr: prNumber }))

    expect(res.posted).toBe(true)
    expect(res.reason).toBe('healed-failure')
    expect(posted).toEqual([{ id: obj.id, pr: 250 }])
  })

  it('reads the NEWEST status per context, not a stale one further down the list', async () => {
    const obj = makeObjective({ status: 'review', ai_review_verdict: 'pass', pr_number: 251, pr_url: prUrl(251) })
    addReview(obj.id, 'pass')

    const gh = async (args: string[]) => {
      const ep = args[1]
      if (ep === `repos/${REPO}/pulls/251`) return 'beefcafe'
      if (ep === `repos/${REPO}/commits/beefcafe/statuses`) {
        // Same context twice: the live one is SUCCESS, the older FAILURE is history.
        // Taking the last (or any) match instead of the first would re-post pointlessly.
        return [
          statusLine(HARNESS_CONTEXT, 'success'),
          statusLine(HARNESS_CONTEXT, 'failure'),
        ].join('\n')
      }
      throw new Error(`unexpected gh api ${ep}`)
    }
    let postCount = 0
    const res = await selfHealHarnessStatus(getDb(), obj, gh, () => { postCount++ })

    expect(res.posted).toBe(false)
    expect(res.reason).toBe('already-present')
    expect(postCount).toBe(0)
  })

  it('a FAILURE status is NOT healed while the verdict is non-pass — the gate stays in front', async () => {
    // The heal branch can only ever RATIFY a verdict the reviewer already gave. If it
    // could be reached without the gate, a blocked review would self-clear the very
    // status that is gating it.
    const obj = makeObjective({ status: 'review', ai_review_verdict: 'fail', pr_number: 252, pr_url: prUrl(252) })
    addReview(obj.id, 'fail')

    let postCount = 0
    // Throws if reached: proves we short-circuit BEFORE reading any status state, so the
    // failure/error branch is unreachable for a non-pass verdict by construction.
    const gh = async () => { throw new Error('gh must not be called for a non-pass verdict') }
    const res = await selfHealHarnessStatus(getDb(), obj, gh, () => { postCount++ })

    expect(res.posted).toBe(false)
    expect(res.reason).toBe('not-pass')
    expect(postCount).toBe(0)
  })

  it('does not heal a FAILURE when the objective verdict passed but the latest review row did not', async () => {
    // Same guard, one layer deeper: objective says pass, the newest per-iteration review
    // row says fail. latestVerdictIsPass must still refuse.
    const obj = makeObjective({ status: 'review', ai_review_verdict: 'pass', pr_number: 253, pr_url: prUrl(253) })
    addReview(obj.id, 'pass', [], 1)
    addReview(obj.id, 'fail', [], 2)

    let postCount = 0
    const gh = async () => { throw new Error('gh must not be called when the latest review is a fail') }
    const res = await selfHealHarnessStatus(getDb(), obj, gh, () => { postCount++ })

    expect(res.posted).toBe(false)
    expect(res.reason).toBe('not-pass')
    expect(postCount).toBe(0)
  })

  it('never converts a FAIL verdict into success', async () => {
    const obj = makeObjective({ status: 'review', ai_review_verdict: 'fail', pr_number: 147, pr_url: prUrl(147) })
    addReview(obj.id, 'fail')
    let postCount = 0
    // gh would throw if called — proves we short-circuit before any GitHub read
    const gh = async () => { throw new Error('gh must not be called for a fail verdict') }
    const res = await selfHealHarnessStatus(getDb(), obj, gh, () => { postCount++ })

    expect(res.posted).toBe(false)
    expect(res.reason).toBe('not-pass')
    expect(postCount).toBe(0)
  })

  it('skips an objective whose PR lives in another repo (no gh call, no API burn)', async () => {
    // example/example2/example-project PRs gate on their own checks, never harness/test-agent.
    // The sweep must NOT fire a doomed gh call at the harness repo for them (obj 1955 footgun).
    const obj = makeObjective({
      status: 'review', ai_review_verdict: 'pass', pr_number: 209,
      pr_url: 'https://github.com/your-org/example-platform/pull/209',
    })
    addReview(obj.id, 'pass')
    let ghCalls = 0
    let postCount = 0
    const gh = async () => { ghCalls++; return '' }
    const res = await selfHealHarnessStatus(getDb(), obj, gh, () => { postCount++ })

    expect(res.posted).toBe(false)
    expect(res.reason).toBe('other-repo')
    expect(ghCalls).toBe(0) // the whole point: no doomed call against the wrong repo
    expect(postCount).toBe(0)
  })

  it('does not post for a pass verdict that still has an unresolved critical FAIL criterion', async () => {
    const obj = makeObjective({ status: 'review', ai_review_verdict: 'pass', pr_number: 147, pr_url: prUrl(147) })
    addReview(obj.id, 'pass', [{ severity: 'critical', status: 'fail', id: 'c1' }])
    let postCount = 0
    const gh = async () => { throw new Error('gh must not be called') }
    const res = await selfHealHarnessStatus(getDb(), obj, gh, () => { postCount++ })
    expect(res.posted).toBe(false)
    expect(res.reason).toBe('not-pass')
    expect(postCount).toBe(0)
  })

  it('skips objectives that are not in review/done', async () => {
    const obj = makeObjective({ status: 'working', ai_review_verdict: 'pass', pr_number: 147 })
    let postCount = 0
    const gh = async () => { throw new Error('gh must not be called') }
    const res = await selfHealHarnessStatus(getDb(), obj, gh, () => { postCount++ })
    expect(res.posted).toBe(false)
    expect(res.reason).toBe('wrong-status')
    expect(postCount).toBe(0)
  })
})

describe('kill switch', () => {
  it('isPrAutolinkKilled is false by default (feature ON) and true when settings row set', () => {
    const db = getDb()
    expect(isPrAutolinkKilled(db, {})).toBe(false)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_autolink_killed', '1')").run()
    expect(isPrAutolinkKilled(db, {})).toBe(true)
  })

  it('isPrAutolinkKilled honours the env override', () => {
    expect(isPrAutolinkKilled(getDb(), { CC_PR_AUTOLINK_KILLED: 'true' })).toBe(true)
  })
})
