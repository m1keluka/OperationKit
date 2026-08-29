// obj 704718 — the two convergence defects that keep cc-infra PRs from ever reaching
// green on their own. Both are grounded in LIVE rows from the production board, so the
// fixtures below use the real objective ids and PR numbers rather than invented ones.
//
//   DEFECT 1 — an ALREADY-EARNED `harness/test-agent` is permanently lost when a branch
//              is updated, because the self-heal only looks at objectives updated in the
//              last 2 days.
//   DEFECT 2 — `objectives.pr_number` is not repo-scoped, so readers keying on it alone
//              attribute one repo's PR to another repo's objective.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-repo-scope-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { repoForObjective, objectiveIsForRepo, classifyObjectiveRepo } = await import('./objective-prs.js')
const { selectAgedEarnedStatusTargets, selfHealHarnessStatus, discoverAndBackfillPR, PR_LINKAGE_REPO } =
  await import('./pr-linkage.js')

const HARNESS = 'your-org/command-center-infra'
const EXAMPLE3 = 'EXAMPLE2/example3-platform'
const EXAMPLE_PROJECT = 'Example-Project/example-project-platform'

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
  const db = getDb()
  db.exec('DELETE FROM objectives')
  db.exec('DELETE FROM objective_prs')
})

interface ObjFixture {
  id: number
  pr_number?: number | null
  pr_url?: string | null
  project?: string | null
  status?: string
  verdict?: string | null
  /** SQLite datetime string; omit for "now". */
  updated_at?: string | null
}

function insertObjective(f: ObjFixture): number {
  getDb()
    .prepare(
      `INSERT INTO objectives (id, title, status, pr_number, pr_url, project, ai_review_verdict, workspace, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'personal', COALESCE(?, datetime('now')))`,
    )
    .run(
      f.id,
      `obj ${f.id}`,
      f.status ?? 'done',
      f.pr_number ?? null,
      f.pr_url ?? null,
      f.project ?? null,
      f.verdict === undefined ? 'pass' : f.verdict,
      f.updated_at ?? null,
    )
  return f.id
}

function getObjective(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never
}

/** The three REAL cross-repo collisions with cc-infra PR numbers, all `pass` verdict. */
function insertLiveCollisions() {
  insertObjective({ id: 2040, pr_number: 202, pr_url: `https://github.com/${EXAMPLE3}/pull/202`, project: 'example3-platform', updated_at: '2026-06-26 15:16:59' })
  insertObjective({ id: 702028, pr_number: 245, pr_url: `https://github.com/${EXAMPLE_PROJECT}/pull/245`, project: 'example-project-platform', updated_at: '2026-07-14 13:45:48' })
  insertObjective({ id: 701986, pr_number: 241, pr_url: `https://github.com/${EXAMPLE_PROJECT}/pull/241`, project: 'example-project-platform', updated_at: '2026-07-14 01:28:33' })
}

// ── DEFECT 1 ───────────────────────────────────────────────────────────────────
describe('defect 1 — an already-earned harness status survives a branch update', () => {
  it('selects a pass-verdict harness objective older than the 2-day discovery window', () => {
    // The live #243 trap: obj 704214, green on head 891a8f50, last updated 2026-08-03.
    insertObjective({ id: 704214, pr_number: 243, pr_url: `https://github.com/${HARNESS}/pull/243`, updated_at: '2026-08-03 15:05:41' })
    const picked = selectAgedEarnedStatusTargets(getDb(), HARNESS).map(o => o.id)
    expect(picked).toContain(704214)
  })

  it('does NOT double-count objectives the recent window already covers', () => {
    insertObjective({ id: 704900, pr_number: 249, pr_url: `https://github.com/${HARNESS}/pull/249` }) // updated now
    expect(selectAgedEarnedStatusTargets(getDb(), HARNESS).map(o => o.id)).not.toContain(704900)
  })

  it('never widens the verdict gate — only a genuine pass is re-posted', () => {
    const old = '2026-07-01 00:00:00'
    insertObjective({ id: 704901, pr_number: 250, pr_url: `https://github.com/${HARNESS}/pull/250`, verdict: null, updated_at: old })
    insertObjective({ id: 704902, pr_number: 251, pr_url: `https://github.com/${HARNESS}/pull/251`, verdict: 'blocked', updated_at: old })
    insertObjective({ id: 704903, pr_number: 252, pr_url: `https://github.com/${HARNESS}/pull/252`, verdict: 'fail', updated_at: old })
    const picked = selectAgedEarnedStatusTargets(getDb(), HARNESS).map(o => o.id)
    expect(picked).not.toContain(704901)
    expect(picked).not.toContain(704902)
    expect(picked).not.toContain(704903)
  })

  it('never widens the status gate — only review/done', () => {
    const old = '2026-07-01 00:00:00'
    insertObjective({ id: 704904, pr_number: 253, pr_url: `https://github.com/${HARNESS}/pull/253`, status: 'working', updated_at: old })
    insertObjective({ id: 704905, pr_number: 254, pr_url: `https://github.com/${HARNESS}/pull/254`, status: 'review', updated_at: old })
    const picked = selectAgedEarnedStatusTargets(getDb(), HARNESS).map(o => o.id)
    expect(picked).not.toContain(704904)
    expect(picked).toContain(704905)
  })

  it('is bounded and never throws on a broken table', () => {
    for (let i = 0; i < 60; i++) {
      insertObjective({ id: 710000 + i, pr_number: 900 + i, pr_url: `https://github.com/${HARNESS}/pull/${900 + i}`, updated_at: '2026-07-01 00:00:00' })
    }
    expect(selectAgedEarnedStatusTargets(getDb(), HARNESS)).toHaveLength(50)
    expect(() => selectAgedEarnedStatusTargets({ prepare: () => { throw new Error('no such table') } } as never, HARNESS)).not.toThrow()
    expect(selectAgedEarnedStatusTargets({ prepare: () => { throw new Error('no such table') } } as never, HARNESS)).toEqual([])
  })
})

// ── DEFECT 2 ───────────────────────────────────────────────────────────────────
describe('defect 2 — pr_number is repo-scoped at every reader', () => {
  it('the aged backstop excludes the three real cross-repo collisions', () => {
    insertLiveCollisions()
    insertObjective({ id: 704214, pr_number: 243, pr_url: `https://github.com/${HARNESS}/pull/243`, updated_at: '2026-08-03 15:05:41' })
    const picked = selectAgedEarnedStatusTargets(getDb(), HARNESS).map(o => o.id)
    expect(picked).toEqual([704214])
    // Named individually so a regression says WHICH repo leaked back in.
    expect(picked, 'example3#202 must not be treated as cc-infra#202').not.toContain(2040)
    expect(picked, 'example-project#245 must not be treated as cc-infra#245').not.toContain(702028)
    expect(picked, 'example-project#241 must not be treated as cc-infra#241').not.toContain(701986)
  })

  it('repoForObjective names a repo from pr_url, else from the objective_prs log, else null', () => {
    const db = getDb()
    insertObjective({ id: 800001, pr_number: 245, pr_url: `https://github.com/${EXAMPLE_PROJECT}/pull/245` })
    expect(repoForObjective(db, getObjective(800001))).toBe(EXAMPLE_PROJECT)

    // No pr_url, but the per-objective PR log knows the repo.
    insertObjective({ id: 800002, pr_number: 245, pr_url: null })
    db.prepare('INSERT INTO objective_prs (objective_id, repo, pr_number) VALUES (?,?,?)').run(800002, EXAMPLE_PROJECT, 245)
    expect(repoForObjective(db, getObjective(800002))).toBe(EXAMPLE_PROJECT)

    // A bare `project` name is NOT strong enough to name a repo.
    insertObjective({ id: 800003, pr_number: 245, pr_url: null, project: 'command-center-infra' })
    expect(repoForObjective(db, getObjective(800003))).toBeNull()

    // Nothing at all.
    insertObjective({ id: 800004, pr_number: 245, pr_url: null })
    expect(repoForObjective(db, getObjective(800004))).toBeNull()
  })

  it('classifyObjectiveRepo distinguishes same / other / unknown — unknown is never "mine"', () => {
    const db = getDb()
    insertObjective({ id: 800005, pr_number: 245, pr_url: `https://github.com/${EXAMPLE_PROJECT}/pull/245` })
    expect(classifyObjectiveRepo(db, getObjective(800005), HARNESS)).toBe('other')

    insertObjective({ id: 800006, pr_number: 243, pr_url: `https://github.com/${HARNESS}/pull/243` })
    expect(classifyObjectiveRepo(db, getObjective(800006), HARNESS)).toBe('same')

    // project alone: weak, but enough to CONFIRM or to REVEAL a mismatch.
    insertObjective({ id: 800007, pr_number: 245, pr_url: null, project: 'command-center-infra' })
    expect(classifyObjectiveRepo(db, getObjective(800007), HARNESS)).toBe('same')
    insertObjective({ id: 800008, pr_number: 245, pr_url: null, project: 'example-project-platform' })
    expect(classifyObjectiveRepo(db, getObjective(800008), HARNESS)).toBe('other')

    // No evidence at all.
    insertObjective({ id: 800009, pr_number: 245, pr_url: null })
    expect(classifyObjectiveRepo(db, getObjective(800009), HARNESS)).toBe('unknown')
    expect(objectiveIsForRepo(db, getObjective(800009), HARNESS)).toBe(false)

    // pr_url always beats the project hint.
    insertObjective({ id: 800011, pr_number: 245, pr_url: `https://github.com/${HARNESS}/pull/245`, project: 'example-project-platform' })
    expect(classifyObjectiveRepo(db, getObjective(800011), HARNESS)).toBe('same')
  })

  it('selfHealHarnessStatus refuses to post on an unresolvable repo instead of assuming harness', async () => {
    // Pre-fix this posted a GREEN REQUIRED STATUS onto cc-infra#245 on behalf of an
    // objective that may well have been example-project's.
    insertObjective({ id: 800010, pr_number: 245, pr_url: null })
    const posted: number[] = []
    const res = await selfHealHarnessStatus(
      getDb(),
      getObjective(800010),
      async () => { throw new Error('gh must not be called') },
      (_o, n) => { posted.push(n) },
    )
    expect(res).toMatchObject({ posted: false, reason: 'unknown-repo' })
    expect(posted).toEqual([])
  })

  it('selfHealHarnessStatus still refuses an explicitly other-repo objective', async () => {
    insertObjective({ id: 2040, pr_number: 202, pr_url: `https://github.com/${EXAMPLE3}/pull/202` })
    const posted: number[] = []
    const res = await selfHealHarnessStatus(
      getDb(),
      getObjective(2040),
      async () => { throw new Error('gh must not be called') },
      (_o, n) => { posted.push(n) },
    )
    expect(res).toMatchObject({ posted: false, reason: 'other-repo' })
    expect(posted).toEqual([])
  })

  it('discoverAndBackfillPR refuses to attach a harness PR to a known other-repo objective', async () => {
    // Branch names are templated across repos, so a `--head` match is not ownership.
    insertObjective({ id: 800020, pr_number: null, pr_url: null, project: 'example-project-platform', status: 'review' })
    getDb().prepare('INSERT INTO objective_prs (objective_id, repo, pr_number) VALUES (?,?,?)').run(800020, EXAMPLE_PROJECT, 99)
    getDb().prepare('UPDATE objectives SET branch_name = ? WHERE id = ?').run('cc/obj-800020-shared-template', 800020)

    let ghCalled = false
    const res = await discoverAndBackfillPR(getDb(), getObjective(800020), async () => {
      ghCalled = true
      return JSON.stringify([{ number: 245, url: `https://github.com/${HARNESS}/pull/245`, headRefName: 'cc/obj-800020-shared-template' }])
    })
    expect(res).toMatchObject({ linked: false, reason: 'other-repo' })
    expect(ghCalled, 'must short-circuit before spending a gh call').toBe(false)
    expect((getObjective(800020) as { pr_number: number | null }).pr_number).toBeNull()
  })

  it('discoverAndBackfillPR still links a fresh objective with no repo evidence, and tags the log row', async () => {
    insertObjective({ id: 800021, pr_number: null, pr_url: null, status: 'review' })
    getDb().prepare('UPDATE objectives SET branch_name = ? WHERE id = ?').run('cc/obj-800021-new', 800021)
    const res = await discoverAndBackfillPR(getDb(), getObjective(800021), async () =>
      JSON.stringify([{ number: 249, url: `https://github.com/${HARNESS}/pull/249`, headRefName: 'cc/obj-800021-new' }]),
    )
    expect(res).toMatchObject({ linked: true, pr_number: 249 })
    const logged = getDb().prepare('SELECT repo FROM objective_prs WHERE objective_id = ?').get(800021) as { repo: string }
    expect(logged.repo).toBe(PR_LINKAGE_REPO)
  })
})
