/**
 * pr-health-watchdog tests (obj 704700).
 *
 * The classification cases are NOT invented — they are the verified live inventory of
 * EXAMPLE2/example3-platform and your-org/example-platform as of 2026-08-06 17:20Z, captured
 * with read-only `gh pr view --json statusCheckRollup`. Keeping the real shapes here means
 * the classifier is tested against GitHub's actual payloads (CheckRun vs StatusContext,
 * the 0001-01-01 zero timestamp, "" conclusions on QUEUED jobs) rather than a tidied-up
 * model of them.
 *
 * A real SQLite DB is used (per external-remediation.test.ts convention) so the shared
 * external_check_remediations UNIQUE constraint — which IS the idempotency mechanism —
 * is exercised for real rather than mocked away.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-prhealth-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const W = await import('./pr-health-watchdog.js')
// `W` is a runtime value (dynamic import), so its types are NOT reachable as `W.Foo`.
// Pull them in separately as type-only aliases.
type PrSummary = import('./pr-health-watchdog.js').PrSummary
type RollupEntry = import('./pr-health-watchdog.js').RollupEntry
type WatchdogDeps = import('./pr-health-watchdog.js').WatchdogDeps
type OwnerState = import('./pr-health-watchdog.js').OwnerState
type Classification = import('./pr-health-watchdog.js').Classification
type PrHealth = import('./pr-health-watchdog.js').PrHealth

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
  db.exec("DELETE FROM objectives WHERE title LIKE 'prhealth-test%'")
  db.exec("DELETE FROM settings WHERE key LIKE 'pr_health_watchdog%'")
})

// ── Live-shaped fixture builders ────────────────────────────────────────────────

const ZERO_TS = '0001-01-01T00:00:00Z'

function checkRun(name: string, status: string, conclusion: string, completedAt = ZERO_TS, runId = '31122668102'): RollupEntry {
  return {
    __typename: 'CheckRun',
    name,
    status,
    conclusion,
    completedAt,
    detailsUrl: `https://github.com/EXAMPLE2/example3-platform/actions/runs/${runId}/job/92686390992`,
    workflowName: 'Vitest Suite',
  }
}

function statusCtx(context: string, state: string): RollupEntry {
  return { __typename: 'StatusContext', context, state, targetUrl: 'https://vercel.com/x' }
}

function pr(number: number, over: Partial<PrSummary> = {}): PrSummary {
  return {
    number,
    title: `test pr ${number}`,
    isDraft: false,
    headRefOid: `sha${number}`.padEnd(40, '0'),
    headRefName: `branch-${number}`,
    createdAt: '2026-08-01T00:00:00Z',
    author: { login: 'm1keluka', is_bot: false },
    statusCheckRollup: [],
    ...over,
  }
}

/** The verified 2026-08-06 inventory, as GitHub actually returned it. */
const LIVE = {
  // #667 — one real failure (Adversarial RLS) alongside 6 gate-cancelled jobs.
  p667: pr(667, {
    headRefName: 'cc/obj-704665-w6-puller-side-ingest-distance-gate-boun',
    statusCheckRollup: [
      checkRun('Adversarial RLS suite (8th config)', 'COMPLETED', 'FAILURE', '2026-08-06T17:07:31Z'),
      checkRun('hermetic parse/normalize contracts', 'COMPLETED', 'CANCELLED', '2026-08-06T17:07:20Z'),
      checkRun('Playwright unauth @safe subset', 'COMPLETED', 'CANCELLED', '2026-08-06T17:07:21Z'),
      checkRun('tsc --noEmit (full repo incl. tests/e2e)', 'COMPLETED', 'CANCELLED', '2026-08-06T17:07:22Z'),
      checkRun('Vitest unit suite (7 pure configs)', 'COMPLETED', 'CANCELLED', '2026-08-06T17:07:23Z'),
      checkRun('Scan for secrets', 'COMPLETED', 'CANCELLED', '2026-08-06T17:07:24Z'),
      checkRun('Claude security review (advisory)', 'COMPLETED', 'CANCELLED', '2026-08-06T17:07:25Z'),
      checkRun('a', 'COMPLETED', 'SUCCESS'),
      checkRun('b', 'COMPLETED', 'SUCCESS'),
    ],
  }),
  // #674/#673/#672 — zero real failures, 1 cancelled job, rest still queued.
  p674: pr(674, {
    statusCheckRollup: [
      checkRun('Playwright unauth @safe subset', 'QUEUED', ''),
      checkRun('tsc --noEmit (full repo incl. tests/e2e)', 'QUEUED', ''),
      checkRun('Vitest unit suite (7 pure configs)', 'QUEUED', ''),
      checkRun('Scan for secrets', 'QUEUED', ''),
      checkRun('Claude security review (advisory)', 'QUEUED', ''),
      checkRun('Adversarial RLS suite (8th config)', 'COMPLETED', 'CANCELLED', '2026-08-06T17:17:10Z'),
      statusCtx('Vercel', 'SUCCESS'),
      checkRun('Vercel Preview Comments', 'COMPLETED', 'SUCCESS', '2026-08-06T17:17:28Z'),
    ],
  }),
  p673: pr(673, {
    statusCheckRollup: [
      checkRun('Adversarial RLS suite (8th config)', 'COMPLETED', 'CANCELLED', '2026-08-06T17:16:55Z'),
      ...Array.from({ length: 5 }, (_, i) => checkRun(`q${i}`, 'QUEUED', '')),
      checkRun('ok', 'COMPLETED', 'SUCCESS'),
    ],
  }),
  p672: pr(672, {
    statusCheckRollup: [
      checkRun('Playwright unauth @safe subset', 'COMPLETED', 'CANCELLED', '2026-08-06T17:23:27Z'),
      checkRun('q', 'IN_PROGRESS', ''),
      checkRun('ok', 'COMPLETED', 'SUCCESS'),
    ],
  }),
  // #646/#629/#564/#563 — the sole failure is the prod-migration verifier: unfixable
  // by pushing a commit.
  p646: pr(646, {
    statusCheckRollup: [
      checkRun('Verify migrations applied to prod', 'COMPLETED', 'FAILURE', '2026-08-04T12:36:48Z'),
      checkRun('ok', 'COMPLETED', 'SUCCESS'),
    ],
  }),
  p629: pr(629, {
    statusCheckRollup: [
      checkRun('Verify migrations applied to prod', 'COMPLETED', 'FAILURE', '2026-08-02T19:26:27Z'),
    ],
  }),
  p564: pr(564, {
    statusCheckRollup: [
      checkRun('Verify migrations applied to prod', 'COMPLETED', 'FAILURE', '2026-07-26T02:55:43Z'),
    ],
  }),
  p563: pr(563, {
    isDraft: true,
    statusCheckRollup: [
      checkRun('Verify migrations applied to prod', 'COMPLETED', 'FAILURE', '2026-07-26T02:35:38Z'),
    ],
  }),
  // #340/#338/#331 — dependabot, no objective will ever own these.
  p340: pr(340, {
    author: { login: 'app/dependabot', is_bot: true },
    headRefName: 'dependabot/npm_and_yarn/supabase/supabase-js-2.110.2',
    statusCheckRollup: [
      checkRun('Adversarial RLS suite (8th config)', 'COMPLETED', 'FAILURE', '2026-07-14T01:01:54Z'),
    ],
  }),
  p338: pr(338, {
    author: { login: 'app/dependabot', is_bot: true },
    headRefName: 'dependabot/npm_and_yarn/multi-b0dfc253ff',
    statusCheckRollup: [
      checkRun('Vitest unit suite (7 pure configs)', 'COMPLETED', 'FAILURE', '2026-07-30T03:18:50Z'),
      statusCtx('Vercel', 'FAILURE'),
    ],
  }),
  p331: pr(331, {
    author: { login: 'app/dependabot', is_bot: true },
    headRefName: 'dependabot/npm_and_yarn/next-16.2.10',
    statusCheckRollup: [
      checkRun('Playwright unauth @safe subset', 'COMPLETED', 'FAILURE', '2026-07-26T17:31:13Z'),
      checkRun('Adversarial RLS test suite', 'COMPLETED', 'FAILURE', '2026-07-26T17:31:10Z'),
      checkRun('tsc --noEmit (full repo incl. tests/e2e)', 'COMPLETED', 'FAILURE', '2026-07-26T17:31:11Z'),
      checkRun('Vitest unit suite (7 pure configs)', 'COMPLETED', 'FAILURE', '2026-07-26T17:31:12Z'),
      statusCtx('Vercel', 'ERROR'),
    ],
  }),
  // #335/#573 — cancellation-only, one of them dependabot-authored.
  p335: pr(335, {
    author: { login: 'app/dependabot', is_bot: true },
    statusCheckRollup: [
      checkRun('Adversarial RLS suite (8th config)', 'COMPLETED', 'CANCELLED', '2026-07-12T22:05:21Z'),
    ],
  }),
  p573: pr(573, {
    statusCheckRollup: [
      checkRun('Gate logic unit test', 'COMPLETED', 'CANCELLED', '2026-07-26T17:37:20Z'),
      checkRun('Verify migrations applied to prod', 'COMPLETED', 'CANCELLED', '2026-07-26T17:37:29Z'),
    ],
  }),
  // example #239
  p239: pr(239, {
    headRefName: 'sec/phase1-hygiene',
    statusCheckRollup: [
      checkRun('Scan for secrets', 'COMPLETED', 'FAILURE', '2026-07-06T19:47:03Z'),
    ],
  }),
}

const NOW = new Date('2026-08-06T17:30:00Z')

function insertObjective(fields: {
  title: string; status: string; pr_url?: string; pr_number?: number
  branch_name?: string; updated_at?: string; session_id?: string
}): number {
  const db = getDb()
  const info = db
    .prepare(
      `INSERT INTO objectives (title, status, pr_url, pr_number, branch_name, updated_at, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fields.title, fields.status, fields.pr_url ?? null, fields.pr_number ?? null,
      fields.branch_name ?? null, fields.updated_at ?? '2026-08-06 17:29:00', fields.session_id ?? null,
    )
  return Number(info.lastInsertRowid)
}

/** exec stub that serves a fixed PR list per repo and records every gh invocation. */
function makeExec(byRepo: Record<string, PrSummary[]>) {
  const calls: string[][] = []
  const exec = async (file: string, args: string[]): Promise<string> => {
    calls.push([file, ...args])
    if (args[0] === 'pr' && args[1] === 'list') {
      const repo = args[args.indexOf('--repo') + 1]
      return JSON.stringify(byRepo[repo] ?? [])
    }
    return ''
  }
  return { exec, calls }
}

function deps(over: Partial<WatchdogDeps> = {}): WatchdogDeps {
  const { exec } = makeExec({})
  return { db: getDb(), exec, now: () => NOW, env: { ...process.env }, ...over } as WatchdogDeps
}

// ── 1. Classification against the live inventory ────────────────────────────────

describe('summariseRollup — real GitHub payload shapes', () => {
  it('splits CheckRun failures, cancellations, pending and success', () => {
    const s = W.summariseRollup(LIVE.p667.statusCheckRollup)
    expect(s.red.filter(r => r.kind === 'failed').map(r => r.name)).toEqual([
      'Adversarial RLS suite (8th config)',
    ])
    expect(s.red.filter(r => r.kind === 'cancelled')).toHaveLength(6)
    expect(s.pending).toBe(0)
    expect(s.success).toBe(2)
  })

  it('reads StatusContext entries via `state`, not `conclusion`', () => {
    const s = W.summariseRollup(LIVE.p331.statusCheckRollup)
    expect(s.red.map(r => r.name)).toContain('Vercel') // state: ERROR
    expect(s.red.filter(r => r.kind === 'failed')).toHaveLength(5)
  })

  it('treats a QUEUED CheckRun with empty conclusion as pending, not failed', () => {
    const s = W.summariseRollup(LIVE.p674.statusCheckRollup)
    expect(s.pending).toBe(5)
    expect(s.red.filter(r => r.kind === 'failed')).toHaveLength(0)
  })

  it('drops the 0001-01-01 zero timestamp rather than reporting a 2000-year-old failure', () => {
    const s = W.summariseRollup([checkRun('x', 'COMPLETED', 'FAILURE', ZERO_TS)])
    expect(s.red[0].completedAt).toBeNull()
  })

  it('ignores harness/* contexts entirely', () => {
    const s = W.summariseRollup([
      statusCtx('harness/test-agent', 'FAILURE'),
      checkRun('harness/gate', 'COMPLETED', 'FAILURE', '2026-08-01T00:00:00Z'),
      checkRun('real', 'COMPLETED', 'FAILURE', '2026-08-01T00:00:00Z'),
    ])
    expect(s.red.map(r => r.name)).toEqual(['real'])
  })

  it('counts NEUTRAL/SKIPPED as neither red nor green', () => {
    const s = W.summariseRollup([
      checkRun('n', 'COMPLETED', 'NEUTRAL'),
      checkRun('s', 'COMPLETED', 'SKIPPED'),
    ])
    expect(s.red).toHaveLength(0)
    expect(s.success).toBe(0)
    expect(s.pending).toBe(0)
  })
})

describe('failureKindOf', () => {
  it('cancellation-only when there are red checks but zero real failures', () => {
    const { red, pending } = W.summariseRollup(LIVE.p673.statusCheckRollup)
    expect(W.failureKindOf(red, pending)).toBe('cancellation-only')
  })

  it('environmental when EVERY real failure is unfixable-by-push', () => {
    const { red, pending } = W.summariseRollup(LIVE.p646.statusCheckRollup)
    expect(W.failureKindOf(red, pending)).toBe('environmental')
  })

  it('real-failure when a genuine failure sits alongside an environmental one', () => {
    const red = [
      { name: 'Verify migrations applied to prod', kind: 'failed' as const, environmental: true, completedAt: null, url: null },
      { name: 'Vitest', kind: 'failed' as const, environmental: false, completedAt: null, url: null },
    ]
    expect(W.failureKindOf(red, 0)).toBe('real-failure')
  })

  it('real-failure when a genuine failure sits alongside cancellations (#667)', () => {
    const { red, pending } = W.summariseRollup(LIVE.p667.statusCheckRollup)
    expect(W.failureKindOf(red, pending)).toBe('real-failure')
  })
})

describe('classify — the verified 2026-08-06 inventory', () => {
  const cases: [string, RollupEntry[], OwnerState, Classification][] = [
    ['#674 cancellation-only noise', LIVE.p674.statusCheckRollup!, 'owned-active', 'cancellation-only'],
    ['#673 cancellation-only noise', LIVE.p673.statusCheckRollup!, 'owned-stale', 'cancellation-only'],
    ['#672 cancellation-only noise', LIVE.p672.statusCheckRollup!, 'owned-stale', 'cancellation-only'],
    ['#335 cancellation-only (dependabot)', LIVE.p335.statusCheckRollup!, 'unowned', 'cancellation-only'],
    ['#573 cancellation-only', LIVE.p573.statusCheckRollup!, 'owned-stale', 'cancellation-only'],
    ['#646 environmental', LIVE.p646.statusCheckRollup!, 'owned-stale', 'environmental'],
    // #629 and #564 have NO objective row on the live board (verified 2026-08-06), so
    // these two also lock in that environmental outranks unowned.
    ['#629 environmental', LIVE.p629.statusCheckRollup!, 'unowned', 'environmental'],
    ['#564 environmental', LIVE.p564.statusCheckRollup!, 'unowned', 'environmental'],
    ['#563 environmental', LIVE.p563.statusCheckRollup!, 'owned-stale', 'environmental'],
    ['#340 unowned dependabot', LIVE.p340.statusCheckRollup!, 'unowned', 'unowned'],
    ['#338 unowned dependabot', LIVE.p338.statusCheckRollup!, 'unowned', 'unowned'],
    ['#331 unowned dependabot', LIVE.p331.statusCheckRollup!, 'unowned', 'unowned'],
    ['#667 real failure', LIVE.p667.statusCheckRollup!, 'owned-stale', 'real-failure'],
    ['example #239 real failure', LIVE.p239.statusCheckRollup!, 'owned-stale', 'real-failure'],
  ]

  for (const [label, rollup, owner, expected] of cases) {
    it(`classifies ${label} as ${expected}`, () => {
      const { red, pending } = W.summariseRollup(rollup)
      expect(W.classify(W.failureKindOf(red, pending), owner, pending)).toBe(expected)
    })
  }

  it('an unfixable-by-push failure stays environmental even with nobody to tell', () => {
    // Regression lock: ownership must NOT overwrite the remedy label. If this flips,
    // example3 #629/#564 silently become "unowned" and the reader loses the one fact
    // that decides what to do with them.
    const { red, pending } = W.summariseRollup(LIVE.p629.statusCheckRollup)
    expect(W.classify(W.failureKindOf(red, pending), 'unowned', pending)).toBe('environmental')
  })

  it('but a genuine failure on an unowned PR is still reported as unowned', () => {
    const { red, pending } = W.summariseRollup(LIVE.p340.statusCheckRollup)
    expect(W.classify(W.failureKindOf(red, pending), 'unowned', pending)).toBe('unowned')
  })

  it('green when nothing is red and nothing is pending', () => {
    expect(W.classify('none', 'unowned', 0)).toBe('green')
  })

  it('pending when nothing is red but checks are still running', () => {
    expect(W.classify('none', 'unowned', 3)).toBe('pending')
  })
})

// ── 2. Ownership ────────────────────────────────────────────────────────────────

describe('resolveOwner', () => {
  it('matches on pr_url so the same PR number in two repos does not cross-attribute', () => {
    const example = insertObjective({
      title: 'prhealth-test example', status: 'working',
      pr_url: 'https://github.com/your-org/example-platform/pull/239', pr_number: 239,
    })
    insertObjective({
      title: 'prhealth-test example2', status: 'working',
      pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/239', pr_number: 239,
    })
    const r = W.resolveOwner(getDb(), 'your-org/example-platform', 239, 'sec/phase1-hygiene', NOW)
    expect(r.objectiveId).toBe(example)
  })

  it('falls back to branch_name when pr_url was never backfilled', () => {
    const id = insertObjective({
      title: 'prhealth-test branch', status: 'working', branch_name: 'branch-667',
    })
    const r = W.resolveOwner(getDb(), 'EXAMPLE2/example3-platform', 667, 'branch-667', NOW)
    expect(r.objectiveId).toBe(id)
  })

  it('reports unowned for a dependabot PR nothing references', () => {
    const r = W.resolveOwner(getDb(), 'EXAMPLE2/example3-platform', 331, 'dependabot/npm_and_yarn/next-16.2.10', NOW)
    expect(r.owner).toBe('unowned')
    expect(r.objectiveId).toBeNull()
  })

  it('owned-active for a working objective touched minutes ago', () => {
    insertObjective({
      title: 'prhealth-test live', status: 'working',
      pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/700', updated_at: '2026-08-06 17:29:00',
    })
    expect(W.resolveOwner(getDb(), 'EXAMPLE2/example3-platform', 700, '', NOW).owner).toBe('owned-active')
  })

  it('owned-stale for a done objective', () => {
    insertObjective({
      title: 'prhealth-test done', status: 'done',
      pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/701', updated_at: '2026-08-06 17:29:00',
    })
    expect(W.resolveOwner(getDb(), 'EXAMPLE2/example3-platform', 701, '', NOW).owner).toBe('owned-stale')
  })

  it('explains WHY a done objective still counts as actively owned (terminal_by_human)', () => {
    // Live case: example3 #563 → obj 703394, status=done, terminal_by_human=1. The digest
    // used to render this as the baffling "obj 703394 (done, owned-active)".
    const id = insertObjective({
      title: 'prhealth-test terminal', status: 'done',
      pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/703', updated_at: '2026-07-31 01:56:17',
    })
    getDb().prepare('UPDATE objectives SET terminal_by_human = 1 WHERE id = ?').run(id)
    const r = W.resolveOwner(getDb(), 'EXAMPLE2/example3-platform', 703, '', NOW)
    expect(r.owner).toBe('owned-active')
    expect(r.reason).toBe('ended by a human — hands off')
  })

  it('explains WHY an unowned PR is unowned', () => {
    const r = W.resolveOwner(getDb(), 'EXAMPLE2/example3-platform', 331, 'dependabot/x', NOW)
    expect(r.reason).toBe('no objective references this PR')
  })

  it('owned-stale for a working objective that has gone quiet past the stale window', () => {
    insertObjective({
      title: 'prhealth-test quiet', status: 'working',
      pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/702', updated_at: '2026-08-01 00:00:00',
    })
    expect(W.resolveOwner(getDb(), 'EXAMPLE2/example3-platform', 702, '', NOW).owner).toBe('owned-stale')
  })
})

// ── 3. Decision table & bounds ──────────────────────────────────────────────────

function health(over: Partial<PrHealth> = {}): PrHealth {
  return {
    repo: 'EXAMPLE2/example3-platform', number: 1, title: 't', url: 'u', author: 'a',
    authorIsBot: false, headSha: 'sha1', branch: 'b', baseBranch: 'main',
    mergeStateStatus: 'BLOCKED', isDraft: false,
    classification: 'real-failure', failureKind: 'real-failure', owner: 'owned-stale',
    // Default fixture: the ruleset was read and the one red check IS a required context,
    // so the pre-704763 decision table is reproduced exactly. Cases that need advisory
    // paint override requiredRedChecks/advisoryRedChecks explicitly.
    requiredGateState: 'enforced', requiredContexts: ['Vitest unit suite (7 pure configs)'],
    requiredRedChecks: [
      { name: 'Vitest unit suite (7 pure configs)', kind: 'failed', environmental: false, completedAt: null, url: null },
    ],
    advisoryRedChecks: [], requiredFailureKind: 'real-failure', mergeableNow: false,
    objectiveId: 42, objectiveStatus: 'done', ownerReason: 'objective is done',
    attemptsSpent: 0, redChecks: [
      { name: 'Vitest unit suite (7 pure configs)', kind: 'failed', environmental: false, completedAt: null, url: null },
    ],
    pendingCount: 0, successCount: 0, redSince: '2026-08-01T00:00:00Z', redForMinutes: 9999,
    action: 'none', actionDetail: null, deferred: false, wouldOnly: true, ...over,
  }
}

describe('decideAction', () => {
  it('never acts on a PR an owner is actively driving', () => {
    expect(W.decideAction(health({ owner: 'owned-active' })).action).toBe('skip-owner-engaged')
  })

  it('never acts inside the grace period — the webhook gets first refusal', () => {
    const r = W.decideAction(health({ redForMinutes: 5 }), { PR_HEALTH_WATCHDOG_GRACE_MINUTES: '30' })
    expect(r.action).toBe('skip-grace')
  })

  it('acts once the grace period has elapsed', () => {
    const r = W.decideAction(health({ redForMinutes: 45 }), { PR_HEALTH_WATCHDOG_GRACE_MINUTES: '30' })
    expect(r.action).toBe('refire-remediation')
  })

  it('stops at the per-PR attempt cap', () => {
    expect(W.decideAction(health({ attemptsSpent: 8 }), { PR_HEALTH_WATCHDOG_MAX_ATTEMPTS: '8' }).action)
      .toBe('skip-cap')
  })

  it('does nothing on a draft PR', () => {
    expect(W.decideAction(health({ isDraft: true })).action).toBe('none')
  })

  it('does nothing on green or pending', () => {
    expect(W.decideAction(health({ classification: 'green' })).action).toBe('none')
    expect(W.decideAction(health({ classification: 'pending' })).action).toBe('none')
  })

  it('re-runs cancelled jobs rather than burning a worker session', () => {
    expect(W.decideAction(health({ classification: 'cancellation-only' })).action).toBe('rerun-cancelled')
  })

  it('escalates environmental failures instead of re-firing a pointless push', () => {
    expect(W.decideAction(health({ classification: 'environmental' })).action).toBe('escalate')
  })

  it('escalates unowned PRs — there is no session to nudge', () => {
    expect(W.decideAction(health({ classification: 'unowned', objectiveId: null })).action).toBe('escalate')
  })
})

describe('configuration is config, not scattered constants', () => {
  it('defaults to the three tracked repos', () => {
    expect(W.watchdogRepos(getDb(), {})).toEqual([
      'EXAMPLE2/example3-platform', 'your-org/example-platform', 'Example-Project/example-project-platform',
    ])
  })

  it('takes the repo list from settings without a code change', () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_repos', ?)")
      .run('Foo/bar, Baz/qux')
    expect(W.watchdogRepos(getDb(), {})).toEqual(['Foo/bar', 'Baz/qux'])
  })

  it('ignores malformed repo entries rather than shelling out with garbage', () => {
    expect(W.watchdogRepos(null, { PR_HEALTH_WATCHDOG_REPOS: 'not a repo; rm -rf /' }))
      .toEqual(['EXAMPLE2/example3-platform', 'your-org/example-platform', 'Example-Project/example-project-platform'])
  })
})

// ── 4. Ships dark ───────────────────────────────────────────────────────────────

describe('ships dark', () => {
  it('is OFF by default', () => {
    expect(W.isWatchdogEnabled(getDb(), {})).toBe(false)
  })

  it('arms from the settings row at call time — no restart', () => {
    expect(W.isWatchdogEnabled(getDb(), {})).toBe(false)
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    expect(W.isWatchdogEnabled(getDb(), {})).toBe(true) // same process, no reload
    getDb().prepare("UPDATE settings SET value='0' WHERE key='pr_health_watchdog_enabled'").run()
    expect(W.isWatchdogEnabled(getDb(), {})).toBe(false) // disarms just as fast
  })

  it('with the flag OFF, posts nothing and writes no claim rows', async () => {
    const { exec, calls } = makeExec({ 'EXAMPLE2/example3-platform': [LIVE.p331, LIVE.p646] })
    const report = await W.runWatchdogOnce(deps({
      exec, env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform' },
    }))

    expect(report.enabled).toBe(false)
    // Decisions are still computed — a dry-run is a truthful preview, not a dead path.
    expect(report.prs.map(p => p.action).sort()).toEqual(['escalate', 'escalate'])
    expect(report.prs.every(p => p.wouldOnly)).toBe(true)
    // …but nothing left the process.
    expect(calls.filter(c => c[1] !== 'pr').length).toBe(0)
    expect(getDb().prepare('SELECT COUNT(*) n FROM external_check_remediations').get()).toEqual({ n: 0 })
  })

  it('dryRun forces report-only even when the flag is ARMED', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    const { exec, calls } = makeExec({ 'EXAMPLE2/example3-platform': [LIVE.p331] })
    const notified: unknown[] = []
    const report = await W.runWatchdogOnce(deps({
      exec, dryRun: true, notify: a => { notified.push(a) },
      env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform' },
    }))
    expect(report.enabled).toBe(true)
    expect(report.prs[0].wouldOnly).toBe(true)
    expect(notified).toHaveLength(0)
    expect(calls.filter(c => c[1] === 'run')).toHaveLength(0)
    expect(getDb().prepare('SELECT COUNT(*) n FROM external_check_remediations').get()).toEqual({ n: 0 })
  })

  it('never auto-merges and never re-runs a harness context', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    const harnessOnly = pr(900, {
      statusCheckRollup: [
        { __typename: 'StatusContext', context: 'harness/test-agent', state: 'FAILURE' },
        checkRun('harness/gate', 'COMPLETED', 'CANCELLED', '2026-08-01T00:00:00Z'),
      ],
    })
    const { exec, calls } = makeExec({ 'EXAMPLE2/example3-platform': [harnessOnly] })
    const report = await W.runWatchdogOnce(deps({
      exec, env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform' },
    }))
    // harness/* is filtered out entirely, so the PR reads green — nothing to act on.
    expect(report.prs[0].classification).toBe('green')
    expect(report.prs[0].redChecks).toHaveLength(0)
    expect(calls.some(c => c.includes('merge'))).toBe(false)
  })

  it('caps total actions in a single sweep', async () => {
    const many = Array.from({ length: 10 }, (_, i) => pr(800 + i, {
      author: { login: 'app/dependabot', is_bot: true },
      statusCheckRollup: [checkRun('Vitest', 'COMPLETED', 'FAILURE', '2026-07-01T00:00:00Z')],
    }))
    const { exec } = makeExec({ 'EXAMPLE2/example3-platform': many })
    const report = await W.runWatchdogOnce(deps({
      exec, env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform', PR_HEALTH_WATCHDOG_MAX_ACTIONS: '3' },
    }))
    // All 10 still show their DECIDED action — only 3 are actually acted on this sweep.
    expect(report.prs.filter(p => p.action === 'escalate')).toHaveLength(10)
    expect(report.prs.filter(p => !p.deferred)).toHaveLength(3)
    expect(report.prs.filter(p => p.deferred)).toHaveLength(7)
  })

  it('the cap defers rather than hiding what the watchdog intended', async () => {
    // Regression lock: an earlier build overwrote `action` with 'skip-cap', which turned
    // the digest into a wall of "skip-cap" and hid every real intention from Mike.
    const many = Array.from({ length: 4 }, (_, i) => pr(810 + i, {
      author: { login: 'app/dependabot', is_bot: true },
      statusCheckRollup: [checkRun('Vitest', 'COMPLETED', 'FAILURE', '2026-07-01T00:00:00Z')],
    }))
    const { exec } = makeExec({ 'EXAMPLE2/example3-platform': many })
    const report = await W.runWatchdogOnce(deps({
      exec, env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform', PR_HEALTH_WATCHDOG_MAX_ACTIONS: '1' },
    }))
    const md = W.renderDigest(report)
    expect(md).not.toContain('skip-cap')
    // "(next sweep)" until obj 704787 — but the budget was spent in a fixed enumeration
    // order, so a deferred PR was NOT served next sweep, or ever. The marker now says
    // "(queued)" and actionDetail carries the real slot. See the fairness suite.
    expect(md).toContain('WOULD escalate (queued)')
    expect(md).toContain('deferred, sweep cap 1 reached')
  })

  it('bounds re-runs to at most 2 distinct workflow runs per PR', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    const noisy = pr(901, {
      statusCheckRollup: [1, 2, 3, 4, 5].map(i =>
        checkRun(`job${i}`, 'COMPLETED', 'CANCELLED', '2026-07-01T00:00:00Z', `9000${i}`)),
    })
    const { exec, calls } = makeExec({ 'EXAMPLE2/example3-platform': [noisy] })
    await W.runWatchdogOnce(deps({ exec, env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform' } , dryRun: false}))
    expect(calls.filter(c => c[1] === 'run' && c[2] === 'rerun')).toHaveLength(2)
  })
})

// ── 5. Idempotency & no double-driving ──────────────────────────────────────────

describe('idempotency — repeated sweeps do not re-act', () => {
  it('running the sweep TWICE produces exactly ONE action', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    const notified: unknown[] = []
    const { exec } = makeExec({ 'EXAMPLE2/example3-platform': [LIVE.p331] })
    const d = deps({
      exec, notify: a => { notified.push(a) }, dryRun: false,
      env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform' },
    })

    const first = await W.runWatchdogOnce(d)
    expect(first.prs[0].action).toBe('escalate')
    expect(first.prs[0].wouldOnly).toBe(false)

    const second = await W.runWatchdogOnce(d)
    expect(second.prs[0].action).toBe('skip-duplicate')

    // Exactly one action, and exactly one claim row, after two full sweeps.
    expect(notified).toHaveLength(1)
    const rows = getDb()
      .prepare("SELECT check_name FROM external_check_remediations WHERE check_name LIKE 'watchdog:%'")
      .all()
    expect(rows).toEqual([{ check_name: 'watchdog:escalate' }])
  })

  it('a NEW head_sha is a new situation and may be acted on again', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    const notified: unknown[] = []
    const notify = (a: unknown) => { notified.push(a) }
    const env = { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform' }

    const a = makeExec({ 'EXAMPLE2/example3-platform': [LIVE.p331] })
    await W.runWatchdogOnce(deps({ exec: a.exec, notify, dryRun: false, env }))

    const pushed = { ...LIVE.p331, headRefOid: 'a-brand-new-sha' }
    const b = makeExec({ 'EXAMPLE2/example3-platform': [pushed] })
    const second = await W.runWatchdogOnce(deps({ exec: b.exec, notify, dryRun: false, env }))

    expect(second.prs[0].action).toBe('escalate')
    expect(notified).toHaveLength(2)
  })

  it('stands down when external-remediation.ts is CURRENTLY acting on this commit', async () => {
    // Updated for obj 704784. This used to assert that ANY remediation row on the
    // head_sha forced owned-active — including the row here, whose objective_id (42)
    // did not exist. That unconditional override WAS the convergence hole: a row is
    // never cleared, so the watchdog deferred to a long-finished owner forever. The
    // interlock is still tested, but with what it actually means: a live objective that
    // the event path nudged moments ago. Expiry is covered in
    // pr-health-watchdog.engagement.test.ts.
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_health_watchdog_enabled','1')").run()
    const ownerId = insertObjective({
      title: 'prhealth-test live owner', status: 'working',
      pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/667',
      updated_at: '2026-08-06 17:28:00', // 2m before NOW
    })
    // The EVENT path's row: a real check name (no `watchdog:` prefix) on this head_sha.
    getDb()
      .prepare(
        `INSERT INTO external_check_remediations (objective_id, repo, pr_number, check_name, head_sha, attempt, created_at)
         VALUES (?, ?, ?, ?, ?, 1, '2026-08-06 17:25:00')`,
      )
      .run(ownerId, 'EXAMPLE2/example3-platform', 667, 'Adversarial RLS suite (8th config)', LIVE.p667.headRefOid)

    const notified: unknown[] = []
    const { exec, calls } = makeExec({ 'EXAMPLE2/example3-platform': [LIVE.p667] })
    const report = await W.runWatchdogOnce(deps({
      exec, notify: a => { notified.push(a) }, dryRun: false,
      env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform' },
    }))

    expect(report.prs[0].owner).toBe('owned-active')
    expect(report.prs[0].ownerReason).toBe(
      `external-remediation acted 5m ago; objective ${ownerId} is working`,
    )
    expect(report.prs[0].action).toBe('skip-owner-engaged')
    expect(notified).toHaveLength(0)
    expect(calls.filter(c => c[1] === 'run')).toHaveLength(0)
  })

  it('counts attempts spent by BOTH loops against the shared budget', async () => {
    const db = getDb()
    const ins = db.prepare(
      `INSERT INTO external_check_remediations (objective_id, repo, pr_number, check_name, head_sha, attempt)
       VALUES (?, ?, ?, ?, ?, 0)`,
    )
    ins.run(1, 'EXAMPLE2/example3-platform', 331, 'Vitest', 'old-sha-1')      // event path
    ins.run(1, 'EXAMPLE2/example3-platform', 331, 'watchdog:escalate', 'old-sha-2') // watchdog
    expect(W.attemptsSpent(db, 'EXAMPLE2/example3-platform', 331)).toBe(2)
  })
})

// ── 6. Sweep robustness ─────────────────────────────────────────────────────────

describe('sweepHealth', () => {
  it('issues exactly one read-only gh call per repo', async () => {
    const { exec, calls } = makeExec({ 'A/a': [], 'B/b': [] })
    await W.sweepHealth(deps({ exec, env: { PR_HEALTH_WATCHDOG_REPOS: 'A/a,B/b' } }))
    expect(calls).toHaveLength(2)
    expect(calls.every(c => c[1] === 'pr' && c[2] === 'list')).toBe(true)
  })

  it('reports a partial result instead of throwing when one repo is unreachable', async () => {
    const exec = async (_f: string, args: string[]) => {
      if (args[args.indexOf('--repo') + 1] === 'Bad/repo') throw new Error('HTTP 404')
      return JSON.stringify([LIVE.p667])
    }
    const report = await W.sweepHealth(deps({ exec, env: { PR_HEALTH_WATCHDOG_REPOS: 'Bad/repo,Good/repo' } }))
    expect(report.errors).toEqual([{ repo: 'Bad/repo', message: 'HTTP 404' }])
    expect(report.prsScanned).toBe(1)
  })

  it('cross-references the owning objective and its attempt count into the report', async () => {
    const objId = insertObjective({
      title: 'prhealth-test owner', status: 'done',
      pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/667', updated_at: '2026-08-01 00:00:00',
    })
    getDb().prepare(
      `INSERT INTO external_check_remediations (objective_id, repo, pr_number, check_name, head_sha, attempt)
       VALUES (?, 'EXAMPLE2/example3-platform', 667, 'Vitest', 'older-sha', 1)`,
    ).run(objId)

    const { exec } = makeExec({ 'EXAMPLE2/example3-platform': [LIVE.p667] })
    const report = await W.sweepHealth(deps({ exec, env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform' } }))
    const p = report.prs[0]
    expect(p.objectiveId).toBe(objId)
    expect(p.objectiveStatus).toBe('done')
    expect(p.owner).toBe('owned-stale')
    expect(p.attemptsSpent).toBe(1)
    expect(p.classification).toBe('real-failure')
  })
})

describe('distinctRunIds', () => {
  it('extracts distinct Actions run ids from cancelled job urls only', () => {
    const ids = W.distinctRunIds([
      { name: 'a', kind: 'cancelled', environmental: false, completedAt: null, url: 'https://github.com/o/r/actions/runs/111/job/1' },
      { name: 'b', kind: 'cancelled', environmental: false, completedAt: null, url: 'https://github.com/o/r/actions/runs/111/job/2' },
      { name: 'c', kind: 'cancelled', environmental: false, completedAt: null, url: 'https://github.com/o/r/actions/runs/222/job/3' },
      { name: 'd', kind: 'failed', environmental: false, completedAt: null, url: 'https://github.com/o/r/actions/runs/333/job/4' },
      { name: 'e', kind: 'cancelled', environmental: false, completedAt: null, url: 'https://vercel.com/github' },
    ])
    expect(ids).toEqual(['111', '222'])
  })
})

// ── 7. The Mike-facing surface ──────────────────────────────────────────────────

describe('renderDigest', () => {
  it('answers which/why/who/attempts for every red PR, worst-first', async () => {
    const objId = insertObjective({
      title: 'prhealth-test digest', status: 'done',
      pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/667', updated_at: '2026-08-01 00:00:00',
    })
    getDb().prepare(
      `INSERT INTO external_check_remediations (objective_id, repo, pr_number, check_name, head_sha, attempt)
       VALUES (?, 'EXAMPLE2/example3-platform', 667, 'Vitest', 'older', 1)`,
    ).run(objId)

    const { exec } = makeExec({
      'EXAMPLE2/example3-platform': [LIVE.p667, LIVE.p646, LIVE.p331, LIVE.p674, pr(999)],
    })
    const report = await W.runWatchdogOnce(deps({
      exec, env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform' },
    }))
    const md = W.renderDigest(report)

    // Header tally + posture. These fixtures carry NO baseRefName, so the ruleset lookup
    // resolves to state 'unknown' and the watchdog FAILS SAFE — every red check counts as
    // blocking and the classifications are exactly the pre-704763 ones. That is the point
    // of leaving this suite as-is; the required-context behaviour has its own file
    // (pr-health-watchdog.required-contexts.test.ts).
    expect(md).toContain('**4 red · 4 with a REQUIRED check failing · 0 mergeable now · 0 pending · 1 green**')
    expect(md).toContain('act-path DARK')
    expect(report.prs.every(p => p.requiredGateState === 'unknown')).toBe(true)
    expect(report.prs.every(p => p.mergeableNow === false)).toBe(true)

    // Worst-first ordering.
    const order = ['## REAL FAILURE', '## ENVIRONMENTAL', '## UNOWNED', '## NOISE']
    const idx = order.map(h => md.indexOf(h))
    expect(idx.every(i => i >= 0)).toBe(true)
    expect([...idx].sort((a, b) => a - b)).toEqual(idx)

    // WHICH checks are red, and real-vs-noise.
    expect(md).toContain('`Adversarial RLS suite (8th config)`')
    expect(md).toContain('_(environmental)_')
    expect(md).toContain('cancelled (noise): 6')

    // WHO owns it, and attempts spent.
    expect(md).toContain(`obj ${objId} (done) → owned-stale — objective is done`)
    expect(md).toContain('**no owning objective**')
    expect(md).toContain('attempts spent: 1')

    // What happens next.
    expect(md).toContain('WOULD escalate')

    // Green PRs collapse to the tally — they are not re-listed.
    expect(md).not.toContain('#999')
  })

  it('says so plainly when nothing is red', () => {
    const md = W.renderDigest({
      ranAt: '2026-08-06T17:30:00Z', enabled: false, dryRun: true,
      repos: ['A/a'], prsScanned: 0, errors: [], prs: [], gates: {},
    })
    expect(md).toContain('No red PRs. Nothing to hunt.')
  })

  it('flags a partial report rather than silently under-reporting', () => {
    const md = W.renderDigest({
      ranAt: '2026-08-06T17:30:00Z', enabled: false, dryRun: true,
      repos: ['A/a'], prsScanned: 0, errors: [{ repo: 'A/a', message: 'HTTP 404' }], prs: [], gates: {},
    })
    expect(md).toContain('PARTIAL REPORT')
    expect(md).toContain('A/a (HTTP 404)')
  })
})
