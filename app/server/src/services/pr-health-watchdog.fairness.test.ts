/**
 * pr-health-watchdog — sweep-cap FAIRNESS and orphan surfacing (obj 704787).
 *
 * Kept in its own file on purpose: obj 704784 is concurrently editing
 * pr-health-watchdog.test.ts, and these cases are about the reconciler's BUDGET ORDER
 * rather than its classification table.
 *
 * THE BUG. The reconciler spent its per-sweep action cap walking `report.prs` in
 * enumeration order, which is constant across sweeps. The same head-of-list PRs won the
 * budget every time and the tail was never reached. Captured live from
 * GET /api/internal/pr-health across FIVE consecutive sweeps on 2026-08-06 (the real
 * numbers the CANDIDATES fixture below reproduces):
 *
 *   23:25:26Z  served {gras#629, gras#340, gras#338}   deferred {gras#331, example#239}
 *   23:27:39Z  served {gras#629, gras#340, gras#338}   deferred {gras#331, example#239}
 *   23:29:21Z  served {gras#629, gras#340, gras#338}   deferred {gras#331, example#239}
 *
 * Byte-identical every sweep. example#239 was 44,858 minutes (31 days) red and was never
 * once going to be served. These tests pin the fix and would fail against that build.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-prhealth-fair-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const W = await import('./pr-health-watchdog.js')
type PrHealth = import('./pr-health-watchdog.js').PrHealth
type SweepResult = import('./pr-health-watchdog.js').SweepResult

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

function health(over: Partial<PrHealth> = {}): PrHealth {
  return {
    repo: 'EXAMPLE2/example3-platform', number: 1, title: 't', url: 'u', author: 'a',
    authorIsBot: false, headSha: 'sha1', branch: 'b', baseBranch: 'main',
    mergeStateStatus: 'BLOCKED', isDraft: false,
    classification: 'unowned', failureKind: 'real-failure', owner: 'unowned',
    // The ruleset was read and does require a context; these fixtures carry no per-check
    // detail (the cases here are about BUDGET ORDER, not the classification table), so the
    // required/advisory split is empty and mirrors `redChecks: []` below.
    requiredGateState: 'enforced', requiredContexts: ['Vitest unit suite (7 pure configs)'],
    requiredRedChecks: [], advisoryRedChecks: [], requiredFailureKind: 'none',
    mergeableNow: false,
    objectiveId: null, objectiveStatus: null, ownerReason: 'no objective references this PR',
    attemptsSpent: 0, redChecks: [], pendingCount: 0, successCount: 0,
    redSince: '2026-08-01T00:00:00Z', redForMinutes: 100,
    action: 'escalate', actionDetail: null, deferred: false, wouldOnly: true, ...over,
  }
}

/** The live act-path candidate set, 2026-08-06T23:25Z, in gh enumeration order. */
const CANDIDATES = (): PrHealth[] => [
  health({ number: 629, redForMinutes: 5998, classification: 'environmental' }),
  health({ number: 340, redForMinutes: 34463, authorIsBot: true, author: 'app/dependabot' }),
  health({ number: 338, redForMinutes: null, authorIsBot: true, author: 'app/dependabot' }),
  health({ number: 331, redForMinutes: 16194, authorIsBot: true, author: 'app/dependabot' }),
  health({ repo: 'your-org/example-platform', number: 239, redForMinutes: 44858 }),
]

const key = (p: PrHealth) => `${p.repo.split('/')[1]}#${p.number}`
const CAP3 = { PR_HEALTH_WATCHDOG_MAX_ACTIONS: '3', PR_HEALTH_WATCHDOG_ROTATION_MINUTES: '10' }
const at = (min: number) => new Date(Date.UTC(2026, 7, 6, 0, min))

describe('actionQueueOrder — the cap must not starve the tail', () => {
  it('ranks by starvation: the un-rotated queue is oldest-red first', () => {
    // In the window where the rotation offset is 0 the queue is pure ageing order.
    // example#239 (31d red) and example3#340 (24d) outrank example3#629 (4d), which used to
    // win the budget permanently just for being first in the enumeration.
    const orders = Array.from({ length: 5 }, (_, i) => W.actionQueueOrder(CANDIDATES(), at(i * 10), CAP3).map(key))
    const unrotated = orders.find(o => o[0] === 'example-platform#239')
    expect(unrotated).toEqual([
      'example-platform#239',      // 44858m
      'example3-platform#340',  // 34463m
      'example3-platform#331',  // 16194m
      'example3-platform#629',  //  5998m
      'example3-platform#338',  //  null — no completion timestamp from GitHub
    ])
    for (const o of orders) {
      expect(o).toHaveLength(5)
      expect(new Set(o).size).toBe(5) // no candidate ever dropped or duplicated
    }
  })

  it('EVERY candidate is served within ceil(n/cap) consecutive sweeps', () => {
    const n = 5, cap = 3
    const bound = Math.ceil(n / cap) // 2
    const served = new Set<string>()
    for (let sweep = 0; sweep < bound; sweep++) {
      for (const p of W.actionQueueOrder(CANDIDATES(), at(sweep * 10), CAP3).slice(0, cap)) {
        served.add(key(p))
      }
    }
    expect(served.size).toBe(n)
    // The two PRs that were starved forever are both in there.
    expect(served.has('example3-platform#331')).toBe(true)
    expect(served.has('example-platform#239')).toBe(true)
  })

  it('holds the starvation bound for many shapes of (n, cap) — including nulls', () => {
    for (const n of [4, 5, 7, 11, 20]) {
      for (const cap of [1, 2, 3, 5]) {
        const env = { PR_HEALTH_WATCHDOG_MAX_ACTIONS: String(cap), PR_HEALTH_WATCHDOG_ROTATION_MINUTES: '10' }
        // Every third candidate has a null red-age: those sort last under ageing alone
        // and would starve forever without the rotation.
        const set = Array.from({ length: n }, (_, i) =>
          health({ number: 1000 + i, redForMinutes: i % 3 === 0 ? null : i * 10 }))
        const served = new Set<string>()
        for (let sweep = 0; sweep < Math.ceil(n / cap); sweep++) {
          for (const p of W.actionQueueOrder(set, at(sweep * 10), env).slice(0, cap)) served.add(key(p))
        }
        expect({ n, cap, served: served.size }).toEqual({ n, cap, served: n })
      }
    }
  })

  it('is pure and stable within one rotation window', () => {
    const a = W.actionQueueOrder(CANDIDATES(), at(3), CAP3).map(key)
    const b = W.actionQueueOrder(CANDIDATES(), at(7), CAP3).map(key)
    expect(a).toEqual(b) // same 10-minute window → identical order, no hidden state
    const c = W.actionQueueOrder(CANDIDATES(), at(13), CAP3).map(key)
    expect(c).not.toEqual(a) // next window → the queue has advanced
  })

  it('does not reorder when everyone fits under the cap', () => {
    const few = CANDIDATES().slice(0, 3)
    expect(W.actionQueueOrder(few, at(0), CAP3).map(key)).toEqual(few.map(key))
  })
})

// ── The regression the objective actually cares about ───────────────────────────

function pr(number: number, branch: string, red: string) {
  return {
    number, title: `t${number}`, isDraft: false, headRefOid: `sha${number}`,
    headRefName: branch, createdAt: '2026-07-02T00:00:00Z',
    author: { login: 'app/dependabot', is_bot: true },
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'Vitest unit suite (7 pure configs)', status: 'COMPLETED', conclusion: 'FAILURE', completedAt: red, detailsUrl: '' },
      { __typename: 'CheckRun', name: 'ok', status: 'COMPLETED', conclusion: 'SUCCESS', completedAt: red, detailsUrl: '' },
    ],
  }
}

/** Five unowned red PRs — more than the cap of 3, so two must be deferred every sweep. */
// Red timestamps are all comfortably BEFORE the simulated `now` of 2026-08-06T00:00Z,
// so every one of the five clears the 30-minute grace and is a genuine candidate.
const FIVE = [
  pr(629, 'dependabot/npm_and_yarn/a', '2026-08-02T00:00:00Z'),
  pr(340, 'dependabot/npm_and_yarn/b', '2026-07-13T00:00:00Z'),
  pr(338, 'dependabot/npm_and_yarn/c', '2026-08-01T00:00:00Z'),
  pr(331, 'dependabot/npm_and_yarn/d', '2026-07-26T00:00:00Z'),
  pr(239, 'dependabot/npm_and_yarn/e', '2026-07-06T00:00:00Z'),
]

function deps(now: Date) {
  const exec = async (file: string, args: string[]): Promise<string> =>
    args[0] === 'pr' && args[1] === 'list' ? JSON.stringify(FIVE) : ''
  return {
    db: getDb(), exec, now: () => now,
    env: { ...process.env, PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform', ...CAP3 },
  } as import('./pr-health-watchdog.js').WatchdogDeps
}

const deferredSet = (r: SweepResult) => r.prs.filter(p => p.deferred).map(p => p.number).sort()
const servedSet = (r: SweepResult) =>
  r.prs.filter(p => !p.deferred && p.action === 'escalate').map(p => p.number).sort()

describe('runWatchdogOnce — the deferred set drains across consecutive sweeps', () => {
  it('does NOT defer the same PRs every sweep (the live bug)', async () => {
    const sweeps: SweepResult[] = []
    for (let i = 0; i < 3; i++) sweeps.push(await W.runWatchdogOnce(deps(at(i * 10))))

    // Sanity: the fixture really does overflow the cap.
    for (const s of sweeps) expect(deferredSet(s).length).toBeGreaterThan(0)

    // THE ASSERTION. Pre-fix, every one of these was identical.
    const distinct = new Set(sweeps.map(s => deferredSet(s).join(',')))
    expect(distinct.size).toBeGreaterThan(1)

    // And within ceil(5/3)=2 sweeps every PR has actually been served.
    const served = new Set([...servedSet(sweeps[0]), ...servedSet(sweeps[1])])
    expect([...served].sort()).toEqual([239, 331, 338, 340, 629])
  })

  it('THE CAP SURVIVES — never more than maxActionsPerSweep served in one sweep', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await W.runWatchdogOnce(deps(at(i * 10)))
      expect(servedSet(r).length).toBeLessThanOrEqual(3)
      expect(servedSet(r).length + deferredSet(r).length).toBe(5) // nothing silently dropped
    }
    // The cap is still a real, configurable bound — not removed, not unbounded.
    expect(W.maxActionsPerSweep({ PR_HEALTH_WATCHDOG_MAX_ACTIONS: '3' })).toBe(3)
    expect(W.maxActionsPerSweep({})).toBe(3)
  })

  it('report.prs keeps enumeration order — only the budget order changed', async () => {
    const r = await W.runWatchdogOnce(deps(at(0)))
    expect(r.prs.map(p => p.number)).toEqual([629, 340, 338, 331, 239])
  })

  it('a deferred PR reports its real queue slot, not a bare promise', async () => {
    const r = await W.runWatchdogOnce(deps(at(0)))
    const d = r.prs.find(p => p.deferred)!
    expect(d.actionDetail).toMatch(/sweep cap 3 reached; queued \d+\/5, served within 2 sweep\(s\)/)
    expect(d.action).toBe('escalate') // the DECIDED action stays visible
  })
})

// ── Orphan cause + surfacing (Part C) ───────────────────────────────────────────

describe('objectiveIdFromBranch — rescues sibling PRs the single pr_url column drops', () => {
  it('reads the objective id out of every live Command Center branch shape', () => {
    // All six observed live on 2026-08-06 as unowned-but-obviously-owned PRs.
    expect(W.objectiveIdFromBranch('cc/obj-703394-w2-confirm-popup')).toBe(703394)
    expect(W.objectiveIdFromBranch('cc/obj704093-disconnect-protection')).toBe(704093)
    expect(W.objectiveIdFromBranch('fix/704650-lead-geo-circular-import')).toBe(704650)
    expect(W.objectiveIdFromBranch('cto/704656-topup-guardrail-delta')).toBe(704656)
    expect(W.objectiveIdFromBranch('feature/701061-mockup-v5-polish')).toBe(701061)
    expect(W.objectiveIdFromBranch('cc/obj-704787-w19-pr-health-sweep-fairness')).toBe(704787)
  })

  it('never invents an owner for a dependabot branch', () => {
    // `next-16.2.10` and friends must stay unowned: no objective ever opened them, and a
    // version number is not an objective id.
    expect(W.objectiveIdFromBranch('dependabot/npm_and_yarn/next-16.2.10')).toBeNull()
    expect(W.objectiveIdFromBranch('dependabot/npm_and_yarn/supabase/supabase-js-2.110.2')).toBeNull()
    expect(W.objectiveIdFromBranch('dependabot/npm_and_yarn/multi-b0dfc253ff')).toBeNull()
  })

  it('ignores branches with no id and short numbers that are not objective ids', () => {
    expect(W.objectiveIdFromBranch('sec/phase1-hygiene')).toBeNull()
    expect(W.objectiveIdFromBranch('fix/booking-queue-render-loop')).toBeNull()
    expect(W.objectiveIdFromBranch('')).toBeNull()
    expect(W.objectiveIdFromBranch('release/v2-1234')).toBeNull() // 4 digits ≠ objective id
  })
})

describe('resolveOwner — a second PR from one objective is no longer an orphan', () => {
  it('links example3#564 to obj 703394 via its branch when pr_url points at #563', () => {
    const db = getDb()
    db.prepare("DELETE FROM objectives WHERE title LIKE 'fairness-test%'").run()
    db.prepare(
      `INSERT INTO objectives (id, title, status, pr_url, branch_name, updated_at)
       VALUES (703394, 'fairness-test w1', 'working',
               'https://github.com/EXAMPLE2/example3-platform/pull/563',
               'cc/obj-703394-w1-payment-failure-confirm', ?)`,
    ).run('2026-08-06 23:00:00')

    const now = new Date('2026-08-06T23:25:00Z')
    // #563: the PR the objective actually records → owned, as before.
    const owned = W.resolveOwner(db, 'EXAMPLE2/example3-platform', 563, 'cc/obj-703394-w1-payment-failure-confirm', now)
    expect(owned.objectiveId).toBe(703394)

    // #564: same objective, second branch. This was 'unowned' live.
    const sibling = W.resolveOwner(db, 'EXAMPLE2/example3-platform', 564, 'cc/obj-703394-w2-confirm-popup', now)
    expect(sibling.objectiveId).toBe(703394)
    expect(sibling.owner).not.toBe('unowned')
    expect(sibling.reason).toContain('linked via branch name, not pr_url')
  })

  it('still reports unowned when the branch names an objective that does not exist', () => {
    const r = W.resolveOwner(getDb(), 'EXAMPLE2/example3-platform', 999, 'cc/obj-999999-nope', new Date())
    expect(r.owner).toBe('unowned')
    expect(r.objectiveId).toBeNull()
  })
})

describe('renderDigest — the unowned backlog is surfaced regardless of cap or arming', () => {
  it('censuses every unowned PR even when the act-path is dark', () => {
    const report: SweepResult = {
      ranAt: '2026-08-06T23:25:26.654Z', enabled: false, dryRun: true,
      repos: ['EXAMPLE2/example3-platform'], prsScanned: 3, errors: [],
      gates: {
        'EXAMPLE2/example3-platform@main': {
          state: 'enforced', contexts: ['Vitest unit suite (7 pure configs)'], error: null,
        },
        'your-org/example-platform@main': {
          state: 'enforced', contexts: ['Vitest unit suite (7 pure configs)'], error: null,
        },
      },
      prs: [
        health({ number: 340, redForMinutes: 34463, authorIsBot: true, author: 'app/dependabot', title: 'bump supabase-js', action: 'none' }),
        health({ number: 700, owner: 'owned-active', objectiveId: 1, classification: 'green', action: 'none' }),
        health({ repo: 'your-org/example-platform', number: 239, redForMinutes: 44858, title: 'Phase 1 hygiene floor', action: 'none' }),
      ],
    }
    const md = W.renderDigest(report)
    expect(md).toContain('Unowned backlog')
    expect(md).toContain('**2 of 3 open PR(s)** have no owning objective (1 bot, 1 human)')
    expect(md).toContain('example-platform#239')
    expect(md).toContain('red 31d') // 44858 min — the ageing is impossible to miss
    expect(md).toContain('example3-platform#340')
    expect(md).not.toContain('#700') // owned PRs are not orphans
  })

  it('omits the section entirely when nothing is unowned', () => {
    const report: SweepResult = {
      ranAt: 'x', enabled: true, dryRun: false, repos: [], prsScanned: 1, errors: [],
      gates: {},
      prs: [health({ owner: 'owned-active', objectiveId: 1, classification: 'green', action: 'none' })],
    }
    expect(W.renderDigest(report)).not.toContain('Unowned backlog')
  })
})
