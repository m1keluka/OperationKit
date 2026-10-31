// Resolution-gap coverage for the external-remediation loop (obj 702632).
//
// Three silent-drop gaps closed here, each with its own describe block:
//   A. branch-name → objective-id fallback (sessions push `fix/<id>-…` branches
//      without registering pr_number/pr_url/branch_name)
//   B. pull_request auto-link (stamp PR linkage onto the objective on open/sync)
//   D. trunk-branch failures (Railway statuses on main) → merged-PR resolution,
//      else a deduped + daily-capped auto-created objective card.
// (Gap C, the done-grace, is covered in external-remediation.test.ts.)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

const TMP_DB = path.join(os.tmpdir(), `cc-extrem-res-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  parseObjectiveIdCandidates,
  isWithinDays,
  doneGraceDays,
} = await import('./external-remediation-classify.js')
const {
  resolveObjective,
  collectObjectiveCandidates,
  autoLinkPullRequest,
} = await import('./external-remediation-resolve.js')
const {
  workspaceForRepo,
  maxTrunkCardsPerDay,
  handleExternalCheckEvent,
  trunkDedupeKey,
} = await import('./external-remediation-act.js')
const { detectInfraBlock } = await import('./external-remediation-classify.js')

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

const REPO = 'your-org/example-platform'
const ENV = { AUTO_REMEDIATION_ENABLED: '1' }
const noExec = async () => ''

let nextId = 702500
/** Explicit 6-digit ids — the branch-id parser only considers 4-8 digit runs, so
 *  auto-increment 1-digit test ids would never exercise it. */
function insertObjective(fields: Partial<Objective> & { title?: string }): number {
  const id = fields.id ?? nextId++
  const info = getDb()
    .prepare(
      `INSERT INTO objectives (id, title, status, session_id, pr_number, pr_url, branch_name, workspace, project)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      fields.title || 'test obj',
      fields.status || 'working',
      fields.session_id ?? 'cc-sess-1',
      fields.pr_number ?? null,
      fields.pr_url ?? null,
      fields.branch_name ?? null,
      fields.workspace ?? 'example',
      fields.project ?? null,
    )
  return Number(info.lastInsertRowid)
}

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM external_check_remediations')
  try { db.exec('DELETE FROM ci_followup_log') } catch { /* shared CI follow-up cap table (lazy) */ }
  db.exec("DELETE FROM objectives")
})

// ── A. Branch-name → objective-id parser ────────────────────────────────────────
describe('parseObjectiveIdCandidates', () => {
  it('parses the fix/<id>-slug convention', () => {
    expect(parseObjectiveIdCandidates('fix/702577-funnel-full-month')).toContain(702577)
  })

  it('parses the w3/<id>-slug convention', () => {
    expect(parseObjectiveIdCandidates('w3/702583-bounce-deploy')).toContain(702583)
  })

  it('parses the cc/obj-<id>-w1-slug convention, and prefers the obj-<id> token', () => {
    const ids = parseObjectiveIdCandidates('cc/obj-702450-w1-thread-scanner')
    expect(ids[0]).toBe(702450)
  })

  it('does not hardcode 6 digits — accepts 4-8 digit ids', () => {
    expect(parseObjectiveIdCandidates('fix/1234-short')).toContain(1234)
    expect(parseObjectiveIdCandidates('fix/12345678-long')).toContain(12345678)
    // 9+ digit runs are not ids
    expect(parseObjectiveIdCandidates('fix/123456789-huge')).toEqual([])
  })

  it('yields NOTHING for trunk branches', () => {
    expect(parseObjectiveIdCandidates('main')).toEqual([])
    expect(parseObjectiveIdCandidates('master')).toEqual([])
    expect(parseObjectiveIdCandidates('redesign')).toEqual([])
  })

  it('yields NOTHING for dependabot branches', () => {
    expect(parseObjectiveIdCandidates('dependabot/npm_and_yarn/vite-6.3.5')).toEqual([])
  })

  it('yields NOTHING for id-less branches', () => {
    expect(parseObjectiveIdCandidates('feature/dark-mode')).toEqual([])
    expect(parseObjectiveIdCandidates('')).toEqual([])
    expect(parseObjectiveIdCandidates(null)).toEqual([])
  })

  it('an unrelated number IS a candidate — the DB existence check is the filter', () => {
    // The parser is pure; `release-2026` yields 2026 as a candidate and the
    // resolver rejects it because no objective 2026 exists (covered below).
    expect(parseObjectiveIdCandidates('release-2026')).toContain(2026)
  })
})

// ── A. Resolver fallback + branch_name backfill ─────────────────────────────────
describe('resolveObjective — branch-parsed id fallback', () => {
  it('resolves a fully-NULL-linkage objective from its fix/<id>-slug branch and backfills branch_name', () => {
    const id = insertObjective({ pr_number: null, pr_url: null, branch_name: null, status: 'working' })
    const branch = `fix/${id}-funnel-full-month`
    const obj = resolveObjective(getDb(), { prNumberHint: null, headSha: 'x', repoFullName: REPO }, branch)
    expect(obj?.id).toBe(id)
    // Backfill: future events for this branch resolve directly via branch_name.
    const row = getDb().prepare('SELECT branch_name FROM objectives WHERE id = ?').get(id) as { branch_name: string }
    expect(row.branch_name).toBe(branch)
  })

  it('resolves the cc/obj-<id>-w1 convention', () => {
    const id = insertObjective({ status: 'review' })
    const obj = resolveObjective(getDb(), { prNumberHint: null, headSha: 'x', repoFullName: REPO }, `cc/obj-${id}-w1-scanner`)
    expect(obj?.id).toBe(id)
  })

  it('does NOT backfill/overwrite an existing branch_name', () => {
    const id = insertObjective({ branch_name: 'the-real-branch', status: 'working' })
    resolveObjective(getDb(), { prNumberHint: null, headSha: 'x', repoFullName: REPO }, `fix/${id}-other-branch`)
    const row = getDb().prepare('SELECT branch_name FROM objectives WHERE id = ?').get(id) as { branch_name: string }
    expect(row.branch_name).toBe('the-real-branch')
  })

  it('rejects a branch whose number matches NO objective', () => {
    insertObjective({ status: 'working' })
    const obj = resolveObjective(getDb(), { prNumberHint: null, headSha: 'x', repoFullName: REPO }, 'fix/999999-unrelated')
    expect(obj).toBeNull()
  })
})

// ── B. PR auto-link ─────────────────────────────────────────────────────────────
describe('autoLinkPullRequest', () => {
  it('stamps pr_number/pr_url/branch_name onto a NULL-linkage objective (via parsed branch id)', () => {
    const id = insertObjective({ pr_number: null, pr_url: null, branch_name: null })
    const branch = `w3/${id}-bounce-deploy`
    const res = autoLinkPullRequest(getDb(), {
      repoFullName: REPO, prNumber: 407, prUrl: `https://github.com/${REPO}/pull/407`, branch,
    })
    expect(res.reason).toBe('linked')
    const row = getDb().prepare('SELECT pr_number, pr_url, branch_name FROM objectives WHERE id = ?').get(id) as { pr_number: number; pr_url: string; branch_name: string }
    expect(row.pr_number).toBe(407)
    expect(row.pr_url).toContain('/pull/407')
    expect(row.branch_name).toBe(branch)
  })

  it('is idempotent: a second synchronize event no-ops', () => {
    const id = insertObjective({})
    const branch = `fix/${id}-slug`
    const args = { repoFullName: REPO, prNumber: 12, prUrl: `https://github.com/${REPO}/pull/12`, branch }
    expect(autoLinkPullRequest(getDb(), args).reason).toBe('linked')
    expect(autoLinkPullRequest(getDb(), args).reason).toBe('already-linked')
  })

  it('NEVER overwrites a DIFFERENT existing pr_number — logs a mismatch instead', () => {
    const id = insertObjective({ pr_number: 99, pr_url: `https://github.com/${REPO}/pull/99`, branch_name: null })
    const res = autoLinkPullRequest(getDb(), {
      repoFullName: REPO, prNumber: 100, prUrl: `https://github.com/${REPO}/pull/100`, branch: `fix/${id}-slug`,
    })
    expect(res.reason).toBe('mismatch')
    const row = getDb().prepare('SELECT pr_number FROM objectives WHERE id = ?').get(id) as { pr_number: number }
    expect(row.pr_number).toBe(99)
  })

  it('ignores trunk branches and unresolvable branches', () => {
    expect(autoLinkPullRequest(getDb(), { repoFullName: REPO, prNumber: 1, prUrl: null, branch: 'main' }).reason).toBe('no-branch')
    expect(autoLinkPullRequest(getDb(), { repoFullName: REPO, prNumber: 1, prUrl: null, branch: 'feature/dark-mode' }).reason).toBe('no-objective')
  })
})

// ── D. Trunk-branch failures ────────────────────────────────────────────────────
describe('trunk-branch failures → objective card', () => {
  // Railway posts commit statuses: context "<project> - <service>", state failure.
  function railwayStatus(sha: string, repo = REPO, branch = 'main') {
    return {
      repository: { full_name: repo },
      state: 'failure',
      context: 'example-platform - example-platform',
      sha,
      target_url: 'https://railway.app/project/x/deploy/y',
      description: 'Deployment failed during build',
      branches: [{ name: branch }],
    }
  }
  const deps = () => ({ db: getDb(), sendFollowUp: () => 'cc-s', broadcast: () => {}, exec: noExec, env: ENV })

  it('maps repos to workspaces (verified against the workspaces table, with fallback)', () => {
    expect(workspaceForRepo(getDb(), 'your-org/example-platform')).toBe('example')
    expect(workspaceForRepo(getDb(), 'your-org/example-project-platform')).toBe('example-project')
    expect(workspaceForRepo(getDb(), 'your-org/operationkit')).toBe('operator')
    // example2 exists in the LIVE workspaces table but is not among the seeded test
    // rows → the existence check falls back rather than FK-failing the insert.
    expect(workspaceForRepo(getDb(), 'your-org/unknown-repo')).toBe('operator')
  })

  it('creates ONE card for a Railway failure on main, deduped on re-delivery', async () => {
    const r1 = await handleExternalCheckEvent('status', railwayStatus('sha-main-1'), deps())
    expect(r1.reason).toBe('trunk-card-created')
    const obj = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(r1.objectiveId!) as Objective & { origin: string }
    expect(obj.title).toContain('[Auto] Deploy/check failure on example-platform main')
    expect(obj.title).toContain('example-platform - example-platform')
    expect(obj.status).toBe('queue')
    expect(obj.workspace).toBe('example')
    expect(obj.origin).toBe('trunk-failure')
    expect(obj.description).toContain('sha-main-1')
    expect(obj.description).toContain('https://railway.app/project/x/deploy/y')
    expect(obj.description).toContain('Open a PR')

    // GitHub re-delivers → strict (repo, sha, check) dedupe, no second card.
    const r2 = await handleExternalCheckEvent('status', railwayStatus('sha-main-1'), deps())
    expect(r2.reason).toBe('trunk-duplicate')
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM objectives WHERE title LIKE '[Auto]%'").get() as { n: number }
    expect(n.n).toBe(1)
  })

  it('caps auto-created cards at 3/day/repo — beyond that: log + drop', async () => {
    // Distinct checks: since obj 712948 a new sha on the SAME check appends to the open
    // card, so only distinct (repo, branch, check) triples create — and hit the cap.
    for (let i = 1; i <= 3; i++) {
      const r = await handleExternalCheckEvent('status', { ...railwayStatus(`cap-sha-${i}`), context: `svc-${i}` }, deps())
      expect(r.reason).toBe('trunk-card-created')
    }
    const r4 = await handleExternalCheckEvent('status', { ...railwayStatus('cap-sha-4'), context: 'svc-4' }, deps())
    expect(r4.reason).toBe('trunk-cap')
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM objectives WHERE title LIKE '[Auto]%'").get() as { n: number }
    expect(n.n).toBe(3)
  })

  it('resolves the MERGED PR for a trunk sha and remediates into that objective instead of filing a card', async () => {
    const id = insertObjective({ pr_number: 250, pr_url: `https://github.com/${REPO}/pull/250`, status: 'review', session_id: 'cc-s' })
    let spawned = 0
    // gh api repos/{repo}/commits/{sha}/pulls --jq '[.[].number]' → the merged PR.
    const exec = async (_f: string, args: string[]) => {
      expect(args.join(' ')).toContain('/commits/merged-sha/pulls')
      return '[250]'
    }
    const res = await handleExternalCheckEvent('status', railwayStatus('merged-sha'), {
      db: getDb(), sendFollowUp: () => { spawned++; return 'cc-s' }, broadcast: () => {}, exec, env: ENV,
    })
    expect(res.reason).toBe('remediated')
    expect(res.objectiveId).toBe(id)
    expect(spawned).toBe(1)
    const cards = getDb().prepare("SELECT COUNT(*) AS n FROM objectives WHERE title LIKE '[Auto]%'").get() as { n: number }
    expect(cards.n).toBe(0)
  })

  it('skips pending/success states (classifier) — no card, no dedupe row', async () => {
    const res = await handleExternalCheckEvent('status', { ...railwayStatus('s'), state: 'pending' }, deps())
    expect(res.reason).toBe('not-a-failure')
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM external_check_remediations').get() as { n: number }
    expect(n.n).toBe(0)
  })

  it("never files a trunk card for the harness's own status context", async () => {
    const res = await handleExternalCheckEvent('status', { ...railwayStatus('s2'), context: 'harness/test-agent' }, deps())
    expect(res.reason).toBe('not-a-failure')
  })

  it('a NON-trunk branch with no objective still files NO card (obj 704698: dropped with a more precise reason)', async () => {
    // A provider deploy status off-trunk with no owning objective: nobody is nudged and
    // no card is filed, exactly as before — the drop is just classified accurately now.
    const res = await handleExternalCheckEvent('status', railwayStatus('s3', REPO, 'fix/999999-nope'), deps())
    expect(res.reason).toBe('not-code-fixable-unowned')
    expect(res.checkClass).toBe('environmental')
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM objectives WHERE title LIKE '[Auto]%'").get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('trunk cap default is 3 and env-overridable; done-grace default is 7 days', () => {
    expect(maxTrunkCardsPerDay({})).toBe(3)
    expect(maxTrunkCardsPerDay({ MAX_TRUNK_FAILURE_CARDS_PER_DAY: '5' })).toBe(5)
    expect(doneGraceDays({})).toBe(7)
    expect(doneGraceDays({ REMEDIATION_DONE_GRACE_DAYS: '2' })).toBe(2)
    expect(isWithinDays('2026-07-17 12:00:00', 7, Date.parse('2026-07-18T12:00:00Z'))).toBe(true)
    expect(isWithinDays('2026-07-01 12:00:00', 7, Date.parse('2026-07-18T12:00:00Z'))).toBe(false)
    expect(isWithinDays(null, 7)).toBe(false)
    expect(isWithinDays('garbage', 7)).toBe(false)
  })
})

// ── D2. One open trunk card per repo + branch + check (obj 712948) ──────────────
// The per-sha dedupe key made every new red commit on main "new": 76 open trunk
// cards for 25 distinct checks (22× example3 Migration backlog). A new sha now
// appends to the open card; a queued card is NEVER messaged (a message starts a worker).
describe('trunk failures — one open card per repo+branch+check (obj 712948)', () => {
  function status(sha: string, context = 'example-platform - example-platform', extra: Record<string, unknown> = {}) {
    return {
      repository: { full_name: REPO },
      state: 'failure',
      context,
      sha,
      target_url: `https://railway.app/deploy/${sha}`,
      description: 'Deployment failed during build',
      branches: [{ name: 'main' }],
      ...extra,
    }
  }
  let followUps = 0
  const deps = (env: Record<string, string> = ENV) => ({
    db: getDb(),
    sendFollowUp: () => { followUps++; return 'cc-trunk-s' },
    broadcast: () => {},
    exec: noExec,
    env,
  })
  const row = (id: number) =>
    getDb().prepare('SELECT status, description, dedupe_key FROM objectives WHERE id = ?').get(id) as { status: string; description: string; dedupe_key: string | null }
  const trunkCards = () => (getDb().prepare("SELECT COUNT(*) AS n FROM objectives WHERE origin = 'trunk-failure'").get() as { n: number }).n
  const repeatLines = (desc: string) => (desc.match(/failed again/g) || []).length

  beforeEach(() => { followUps = 0 })

  it('stamps dedupe_key = trunk:<repo>:<branch>:<check> on the created card', async () => {
    const r = await handleExternalCheckEvent('status', status('k-1'), deps())
    expect(r.reason).toBe('trunk-card-created')
    expect(row(r.objectiveId!).dedupe_key).toBe(trunkDedupeKey(REPO, 'main', 'example-platform - example-platform'))
  })

  it('different sha, card still queue → appends ONE line, no new card, no follow-up, still queue', async () => {
    const r1 = await handleExternalCheckEvent('status', status('aaaaaaa1111'), deps())
    const before = row(r1.objectiveId!).description
    const r2 = await handleExternalCheckEvent('status', status('bbbbbbb2222'), deps())
    expect(r2.reason).toBe('trunk-appended')
    expect(r2.objectiveId).toBe(r1.objectiveId)
    expect(trunkCards()).toBe(1)
    const after = row(r1.objectiveId!)
    expect(after.status).toBe('queue')
    expect(repeatLines(after.description)).toBe(1)
    expect(after.description.startsWith(before)).toBe(true)
    expect(after.description).toMatch(/- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z `bbbbbbb` failed again \(failure\) https:\/\/railway\.app\/deploy\/bbbbbbb2222/)
    expect(followUps).toBe(0)
    // The dedupe row is stamped with the reused card.
    const d = getDb().prepare("SELECT objective_id, check_class FROM external_check_remediations WHERE head_sha = 'bbbbbbb2222'").get() as { objective_id: number; check_class: string }
    expect(d).toEqual({ objective_id: r1.objectiveId, check_class: 'trunk-append' })
  })

  it('same-sha re-delivery after an append → trunk-duplicate, description unchanged', async () => {
    const r1 = await handleExternalCheckEvent('status', status('dup-1'), deps())
    await handleExternalCheckEvent('status', status('dup-2'), deps())
    const before = row(r1.objectiveId!).description
    const r3 = await handleExternalCheckEvent('status', status('dup-2'), deps())
    expect(r3.reason).toBe('trunk-duplicate')
    expect(row(r1.objectiveId!).description).toBe(before)
    expect(trunkCards()).toBe(1)
  })

  it('card being worked → follow-up sent once; a second failure inside the window is NOT sent', async () => {
    const r1 = await handleExternalCheckEvent('status', status('w-1'), deps())
    getDb().prepare("UPDATE objectives SET status = 'working', session_id = 'cc-live' WHERE id = ?").run(r1.objectiveId)
    const r2 = await handleExternalCheckEvent('status', status('w-2'), deps())
    expect(r2.reason).toBe('trunk-appended')
    expect(followUps).toBe(1)
    const r3 = await handleExternalCheckEvent('status', status('w-3'), deps())
    expect(r3.reason).toBe('trunk-appended')
    expect(followUps).toBe(1)
    expect(repeatLines(row(r1.objectiveId!).description)).toBe(2)
    expect(trunkCards()).toBe(1)
  })

  it('review / ai_review cards also get the (rate-limited) follow-up', async () => {
    for (const st of ['review', 'ai_review']) {
      getDb().exec("DELETE FROM external_check_remediations; DELETE FROM objectives")
      followUps = 0
      const r1 = await handleExternalCheckEvent('status', status(`${st}-1`), deps())
      getDb().prepare('UPDATE objectives SET status = ? WHERE id = ?').run(st, r1.objectiveId)
      await handleExternalCheckEvent('status', status(`${st}-2`), deps())
      expect(followUps).toBe(1)
    }
  })

  it('existing card done or cancelled → a NEW card is created', async () => {
    for (const st of ['done', 'cancelled']) {
      getDb().exec("DELETE FROM external_check_remediations; DELETE FROM objectives")
      const r1 = await handleExternalCheckEvent('status', status(`${st}-a`), deps())
      getDb().prepare('UPDATE objectives SET status = ? WHERE id = ?').run(st, r1.objectiveId)
      const r2 = await handleExternalCheckEvent('status', status(`${st}-b`), deps())
      expect(r2.reason).toBe('trunk-card-created')
      expect(r2.objectiveId).not.toBe(r1.objectiveId)
      expect(trunkCards()).toBe(2)
    }
  })

  it('a different check on the same repo gets its own card', async () => {
    const a = await handleExternalCheckEvent('status', status('c-1', 'svc-a'), deps())
    const b = await handleExternalCheckEvent('status', status('c-1', 'svc-b'), deps())
    expect(a.reason).toBe('trunk-card-created')
    expect(b.reason).toBe('trunk-card-created')
    expect(a.objectiveId).not.toBe(b.objectiveId)
  })

  it('daily cap applies to creates only — appends never consume it', async () => {
    const env = { ...ENV, MAX_TRUNK_FAILURE_CARDS_PER_DAY: '2' }
    const first = await handleExternalCheckEvent('status', status('cap-a1', 'svc-a'), deps(env))
    for (let i = 2; i <= 6; i++) {
      const r = await handleExternalCheckEvent('status', status(`cap-a${i}`, 'svc-a'), deps(env))
      expect(r.reason).toBe('trunk-appended')
      expect(r.objectiveId).toBe(first.objectiveId)
    }
    // Five appends later, the second create still fits under a cap of 2 …
    expect((await handleExternalCheckEvent('status', status('cap-b1', 'svc-b'), deps(env))).reason).toBe('trunk-card-created')
    // … and only a third distinct check hits it.
    expect((await handleExternalCheckEvent('status', status('cap-c1', 'svc-c'), deps(env))).reason).toBe('trunk-cap')
    // An open card still takes appends after the cap is reached.
    expect((await handleExternalCheckEvent('status', status('cap-a7', 'svc-a'), deps(env))).reason).toBe('trunk-appended')
  })

  it('legacy open card (no dedupe_key, filed before the column) is reused via its exact title', async () => {
    const legacy = Number(getDb()
      .prepare(`INSERT INTO objectives (title, description, workspace, status, origin)
                VALUES ('[Auto] Deploy/check failure on example-platform main: example-platform - example-platform', 'legacy', 'example', 'queue', 'trunk-failure')`)
      .run().lastInsertRowid)
    const r = await handleExternalCheckEvent('status', status('legacy-2'), deps())
    expect(r.reason).toBe('trunk-appended')
    expect(r.objectiveId).toBe(legacy)
    expect(trunkCards()).toBe(1)
  })

  it('billing annotation on a trunk workflow_run → trunk-infra-block, 0 objectives', async () => {
    const exec = async (_f: string, args: string[]) => {
      const a = args.join(' ')
      if (a.includes('[.jobs[].conclusion]')) return '["failure"]'
      if (a.includes('/jobs')) return JSON.stringify([{ id: 555, conclusion: 'failure', steps: 1 }])
      if (a.includes('/check-runs/555/annotations')) {
        return JSON.stringify(['The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the \'Billing & plans\' section in your settings'])
      }
      return '[]'
    }
    const payload = {
      repository: { full_name: REPO },
      workflow_run: { id: 9001, name: 'CI', status: 'completed', conclusion: 'failure', head_sha: 'bill-1', head_branch: 'main', event: 'push', html_url: 'https://github.com/x/actions/runs/9001' },
    }
    const r = await handleExternalCheckEvent('workflow_run', payload, { ...deps(), exec })
    expect(r.reason).toBe('trunk-infra-block')
    expect(trunkCards()).toBe(0)
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as { n: number }).n).toBe(0)
  })

  it('every job failed with ZERO steps run (runner never assigned) → trunk-infra-block', async () => {
    const exec = async (_f: string, args: string[]) => {
      const a = args.join(' ')
      if (a.includes('[.jobs[].conclusion]')) return '["failure","failure"]'
      if (a.includes('/jobs')) return JSON.stringify([{ id: 1, conclusion: 'failure', steps: 0 }, { id: 2, conclusion: 'failure', steps: 0 }])
      return '[]'
    }
    const payload = {
      repository: { full_name: REPO },
      workflow_run: { id: 9002, name: 'CI', status: 'completed', conclusion: 'failure', head_sha: 'bill-2', head_branch: 'main', event: 'push' },
    }
    const r = await handleExternalCheckEvent('workflow_run', payload, { ...deps(), exec })
    expect(r.reason).toBe('trunk-infra-block')
    expect(trunkCards()).toBe(0)
  })

  it('spending-limit wording in a status description → trunk-infra-block', async () => {
    const r = await handleExternalCheckEvent('status', status('bill-3', 'svc', { description: 'Build blocked: spending limit reached' }), deps())
    expect(r.reason).toBe('trunk-infra-block')
    expect(trunkCards()).toBe(0)
  })

  it('a real code failure with steps run and ordinary annotations still files a card', async () => {
    const exec = async (_f: string, args: string[]) => {
      const a = args.join(' ')
      if (a.includes('[.jobs[].conclusion]')) return '["failure"]'
      if (a.includes('/jobs')) return JSON.stringify([{ id: 7, conclusion: 'failure', steps: 5 }])
      if (a.includes('/annotations')) return JSON.stringify(['Process completed with exit code 1.'])
      return '[]'
    }
    const payload = {
      repository: { full_name: REPO },
      workflow_run: { id: 9003, name: 'CI', status: 'completed', conclusion: 'failure', head_sha: 'real-1', head_branch: 'main', event: 'push' },
    }
    const r = await handleExternalCheckEvent('workflow_run', payload, { ...deps(), exec })
    expect(r.reason).toBe('trunk-card-created')
  })
})

describe('detectInfraBlock (obj 712948)', () => {
  it('matches the GitHub billing / quota / runner wording', () => {
    expect(detectInfraBlock(['The job was not started because recent account payments have failed or your spending limit needs to be increased.'], [])).toBe(true)
    expect(detectInfraBlock(['You have exceeded your Actions minutes quota'], [])).toBe(true)
    expect(detectInfraBlock(['No runners available matching labels'], [])).toBe(true)
  })
  it('all-failed-zero-steps jobs are a block; any job that ran steps is not', () => {
    expect(detectInfraBlock([], [{ conclusion: 'failure', steps: 0 }])).toBe(true)
    expect(detectInfraBlock([], [{ conclusion: 'failure', steps: 0 }, { conclusion: 'failure', steps: 3 }])).toBe(false)
    expect(detectInfraBlock([], [{ conclusion: 'cancelled', steps: 0 }])).toBe(false)
  })
  it('ordinary failures and empty inputs are not a block', () => {
    expect(detectInfraBlock(['Process completed with exit code 1.', 'TS2345: Argument of type'], [])).toBe(false)
    expect(detectInfraBlock([], [])).toBe(false)
    expect(detectInfraBlock([null, undefined, ''], [])).toBe(false)
  })
})

// ── E. Cross-repo PR-number mis-route (obj 707783) ──────────────────────────────
// Example-platform and example-project-platform reuse small PR numbers. Strategy 1 used
// to match `pr_number = N` / `pr_url LIKE '%/pull/N%'` with NO repo qualifier, so a
// example-project PR 447 failure nudged the example objective that owned example PR 447.
// That really happened (obj 703235 checked out + `git mv`-ed a foreign branch; obj
// 703352 PUSHED commit a5765be onto another worker's live branch).
describe('collectObjectiveCandidates — repo-qualified PR-number match', () => {
  const EXAMPLE = 'your-org/example-platform'
  const WEIGHT = 'Example-Project/example-project-platform'

  function pair() {
    const exampleId = insertObjective({
      title: 'example owner of PR 447',
      pr_number: 447,
      pr_url: `https://github.com/${EXAMPLE}/pull/447`,
      branch_name: 'cc/obj-703235-example',
      workspace: 'example',
    })
    const weightId = insertObjective({
      title: 'example-project owner of PR 447',
      pr_number: 447,
      pr_url: `https://github.com/${WEIGHT}/pull/447`,
      branch_name: 'obj707506-w1-internal-transfer-rules',
      workspace: 'example',
    })
    return { exampleId, weightId }
  }

  it('routes a example-project PR 447 event to the example-project objective, NOT the example one', () => {
    const { exampleId, weightId } = pair()
    const ids = collectObjectiveCandidates(
      getDb(),
      { prNumberHint: 447, headSha: 'sha', repoFullName: WEIGHT },
      null,
    ).map(o => o.id)
    expect(ids).toEqual([weightId])
    expect(ids).not.toContain(exampleId)
    // and the resolver (the thing that actually nudges) agrees
    expect(resolveObjective(getDb(), { prNumberHint: 447, headSha: 'sha', repoFullName: WEIGHT }, null)?.id)
      .toBe(weightId)
  })

  it('routes an example PR 447 event to the example objective (the mirror case)', () => {
    const { exampleId, weightId } = pair()
    const ids = collectObjectiveCandidates(
      getDb(),
      { prNumberHint: 447, headSha: 'sha', repoFullName: EXAMPLE },
      null,
    ).map(o => o.id)
    expect(ids).toEqual([exampleId])
    expect(ids).not.toContain(weightId)
  })

  it('does NOT prefix-collide: a PR 447 event never matches PR 4478 in the same repo', () => {
    const collider = insertObjective({
      title: 'example-project owner of PR 4478',
      pr_number: 4478,
      pr_url: `https://github.com/${WEIGHT}/pull/4478`,
    })
    const ids = collectObjectiveCandidates(
      getDb(),
      { prNumberHint: 447, headSha: 'sha', repoFullName: WEIGHT },
      null,
    ).map(o => o.id)
    expect(ids).not.toContain(collider)
    expect(ids).toEqual([])
  })

  it('falls back to the repo-blind match when the event carries NO repo', () => {
    const { exampleId, weightId } = pair()
    const ids = collectObjectiveCandidates(
      getDb(),
      { prNumberHint: 447, headSha: 'sha', repoFullName: '' },
      null,
    ).map(o => o.id)
    // No repo to qualify by → old behavior: both owners are candidates.
    expect(ids.sort()).toEqual([exampleId, weightId].sort())
  })

  // ── the non-regression half: pr_number-only rows (no pr_url) ──────────────────
  // The bare `pr_number = N` arm is NARROWED, not dropped: a row with no pr_url has
  // no repo to be disqualified by, and a `workflow_run` event carries a repo + PR
  // number but NO branch — so if strategy 1 skipped these rows the PR would resolve
  // to nobody at all. This is the obj-702632 / obj-1138 path.
  it('a pr_number-only row (no pr_url, no branch) STILL resolves from the number alone', () => {
    const id = insertObjective({
      title: 'pr_number-only, nothing else registered',
      pr_number: 447,
      pr_url: null,
      branch_name: null,
    })
    const ids = collectObjectiveCandidates(
      getDb(),
      { prNumberHint: 447, headSha: 'sha', repoFullName: WEIGHT },
      null,
    ).map(o => o.id)
    expect(ids).toEqual([id])
  })

  it('a pr_number-only row with a registered branch_name still resolves', () => {
    const id = insertObjective({
      title: 'pr_number-only, branch registered',
      pr_number: 447,
      pr_url: null,
      branch_name: 'fix/702632-branch-registered',
    })
    const obj = resolveObjective(
      getDb(),
      { prNumberHint: 447, headSha: 'sha', repoFullName: WEIGHT },
      'fix/702632-branch-registered',
    )
    expect(obj?.id).toBe(id)
  })

  it('but a pr_number-only row that DECLARES a different project is still excluded', () => {
    // `project` is the repo short name — the only repo handle a URL-less row has.
    const foreign = insertObjective({
      title: 'example-platform owner of PR 447, no pr_url',
      pr_number: 447,
      pr_url: null,
      project: 'example-platform',
    })
    const ids = collectObjectiveCandidates(
      getDb(),
      { prNumberHint: 447, headSha: 'sha', repoFullName: WEIGHT },
      null,
    ).map(o => o.id)
    expect(ids).not.toContain(foreign)
    expect(ids).toEqual([])
  })

  it('the branch-parsed fallback (strategy 2b) is untouched for rows with no PR linkage at all', () => {
    const id = insertObjective({
      id: 702632,
      title: 'no linkage whatsoever',
      pr_number: null,
      pr_url: null,
      branch_name: null,
    })
    const obj = resolveObjective(
      getDb(),
      { prNumberHint: 447, headSha: 'sha', repoFullName: WEIGHT },
      'fix/702632-backfill-me',
    )
    expect(obj?.id).toBe(id)
    const row = getDb().prepare('SELECT branch_name FROM objectives WHERE id = ?').get(id) as { branch_name: string }
    expect(row.branch_name).toBe('fix/702632-backfill-me')
  })
})
