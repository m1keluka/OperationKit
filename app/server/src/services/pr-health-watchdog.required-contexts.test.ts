/**
 * pr-health-watchdog — REQUIRED-vs-ADVISORY check awareness (obj 704763).
 *
 * THE DEFECT THIS LOCKS DOWN
 * --------------------------
 * The watchdog had no concept of a required status check. It treated every red square in
 * the rollup as a merge blocker, and on 2026-08-06 20:15:20 that produced a real
 * `watchdog:escalate` row on EXAMPLE2/example3-platform#564 — a PR whose ONLY red check was
 * `Verify migrations applied to prod`, a context that is NOT in that repo's ruleset and
 * therefore gates nothing. A human was paged for paint.
 *
 * THE FIXTURES ARE THE LIVE RULESETS, read this session with
 * `GH_CONFIG_DIR=/etc/gh gh api repos/{owner}/{repo}/rules/branches/{branch}`:
 *
 *   EXAMPLE2/example3-platform @ main       -> "Vitest unit suite (7 pure configs)",
 *                                           "Adversarial RLS suite (8th config)"
 *   your-org/example-platform @ main     -> "e2e-smoke"
 *   your-org/example-platform @ redesign -> []   <- literally an empty array
 *   your-org/command-center-infra @ main -> "harness/test-agent"
 *
 * The `redesign` case is not hypothetical padding: most open example PRs target `redesign`,
 * and GitHub returns `[]` for it. That is a SUCCESSFUL read meaning "nothing gates this
 * branch" — deliberately distinct from an unreadable ruleset, and deliberately NOT the
 * same as "checks verified green". Both distinctions are asserted below.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-prhealth-req-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const W = await import('./pr-health-watchdog.js')

type PrSummary = import('./pr-health-watchdog.js').PrSummary
type RollupEntry = import('./pr-health-watchdog.js').RollupEntry
type WatchdogDeps = import('./pr-health-watchdog.js').WatchdogDeps
type RequiredGate = import('./pr-health-watchdog.js').RequiredGate

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
  db.exec("DELETE FROM objectives WHERE title LIKE 'prhealth-req%'")
  db.exec("DELETE FROM settings WHERE key LIKE 'pr_health_watchdog%'")
  W.resetRulesetCache()
})

// ── The live ruleset payloads, verbatim shapes ──────────────────────────────────

const RULESETS: Record<string, unknown[]> = {
  'EXAMPLE2/example3-platform@main': [
    { type: 'deletion', parameters: {} },
    { type: 'non_fast_forward', parameters: {} },
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [
          { context: 'Vitest unit suite (7 pure configs)' },
          { context: 'Adversarial RLS suite (8th config)' },
        ],
      },
      ruleset_id: 18147196,
    },
  ],
  'your-org/example-platform@main': [
    {
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: 'e2e-smoke' }],
      },
      ruleset_id: 18147168,
    },
  ],
  // Verbatim: GitHub returns an empty array for this branch. Nothing gates `redesign`.
  'your-org/example-platform@redesign': [],
}

const ZERO_TS = '0001-01-01T00:00:00Z'

function checkRun(name: string, conclusion: string, completedAt = '2026-08-01T00:00:00Z', runId = '31122668102'): RollupEntry {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion,
    completedAt,
    detailsUrl: `https://github.com/o/r/actions/runs/${runId}/job/9`,
  }
}

function pr(number: number, over: Partial<PrSummary> = {}): PrSummary {
  return {
    number,
    title: `test pr ${number}`,
    isDraft: false,
    headRefOid: `sha${number}`.padEnd(40, '0'),
    headRefName: `branch-${number}`,
    baseRefName: 'main',
    mergeStateStatus: 'UNSTABLE',
    createdAt: '2026-07-01T00:00:00Z',
    author: { login: 'm1keluka', is_bot: false },
    statusCheckRollup: [],
    ...over,
  }
}

const NOW = new Date('2026-08-06T21:00:00Z')

/**
 * exec stub serving both `gh pr list` and `gh api repos/../rules/branches/..`.
 * `rulesetFail` makes every ruleset call throw, which is how the fail-safe path is driven.
 */
function makeExec(byRepo: Record<string, PrSummary[]>, opts: { rulesetFail?: string } = {}) {
  const calls: string[][] = []
  const exec = async (file: string, args: string[]): Promise<string> => {
    calls.push([file, ...args])
    if (args[0] === 'pr' && args[1] === 'list') {
      const repo = args[args.indexOf('--repo') + 1]
      return JSON.stringify(byRepo[repo] ?? [])
    }
    if (args[0] === 'api') {
      if (opts.rulesetFail) throw new Error(opts.rulesetFail)
      const m = args[1].match(/^repos\/(.+)\/rules\/branches\/(.+)$/)
      if (!m) throw new Error(`unexpected gh api path: ${args[1]}`)
      const key = `${m[1]}@${decodeURIComponent(m[2])}`
      if (!(key in RULESETS)) throw new Error(`HTTP 404: no ruleset fixture for ${key}`)
      return JSON.stringify(RULESETS[key])
    }
    return ''
  }
  return { exec, calls }
}

function deps(over: Partial<WatchdogDeps> = {}): WatchdogDeps {
  const { exec } = makeExec({})
  return { db: getDb(), exec, now: () => NOW, env: { ...process.env }, ...over } as WatchdogDeps
}

function gateOf(state: RequiredGate['state'], contexts: string[] = []): RequiredGate {
  return { state, contexts, error: state === 'unknown' ? 'boom' : null }
}

// ── 1. Parsing the ruleset ──────────────────────────────────────────────────────

describe('parseRequiredContexts', () => {
  it("reads example3's two required contexts verbatim, ignoring the other rule types", () => {
    const g = W.parseRequiredContexts(JSON.stringify(RULESETS['EXAMPLE2/example3-platform@main']))
    expect(g.state).toBe('enforced')
    expect(g.contexts).toEqual([
      'Vitest unit suite (7 pure configs)',
      'Adversarial RLS suite (8th config)',
    ])
  })

  it('an EMPTY array is a successful read meaning "nothing gates this branch" — not an error', () => {
    const g = W.parseRequiredContexts('[]')
    expect(g.state).toBe('no-ruleset')
    expect(g.contexts).toEqual([])
    expect(g.error).toBeNull()
  })

  it('a ruleset with rules but no required_status_checks rule is also no-ruleset', () => {
    const g = W.parseRequiredContexts(JSON.stringify([{ type: 'deletion', parameters: {} }]))
    expect(g.state).toBe('no-ruleset')
  })

  it('unions several required_status_checks rules — a repo can carry more than one ruleset', () => {
    const g = W.parseRequiredContexts(JSON.stringify([
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'a' }, { context: 'b' }] } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'b' }, { context: 'c' }] } },
    ]))
    expect(g.contexts).toEqual(['a', 'b', 'c'])
  })

  it('unparseable or non-array output is UNKNOWN, never no-ruleset', () => {
    expect(W.parseRequiredContexts('not json').state).toBe('unknown')
    expect(W.parseRequiredContexts('{"message":"Not Found"}').state).toBe('unknown')
  })
})

// ── 2. Fetching, keyed on the BASE branch, and cached ───────────────────────────

describe('resolveRequiredGate', () => {
  it('queries the ruleset endpoint for the PR BASE branch, not hardcoded main', async () => {
    const { exec, calls } = makeExec({})
    const g = await W.resolveRequiredGate(exec, 'your-org/example-platform', 'redesign', NOW)
    expect(calls).toContainEqual(['gh', 'api', 'repos/your-org/example-platform/rules/branches/redesign'])
    expect(g.state).toBe('no-ruleset')

    const g2 = await W.resolveRequiredGate(exec, 'your-org/example-platform', 'main', NOW)
    expect(g2.contexts).toEqual(['e2e-smoke'])
  })

  it('caches per (repo, baseBranch) so a sweep does not hammer the API', async () => {
    const { exec, calls } = makeExec({})
    await W.resolveRequiredGate(exec, 'EXAMPLE2/example3-platform', 'main', NOW)
    await W.resolveRequiredGate(exec, 'EXAMPLE2/example3-platform', 'main', NOW)
    await W.resolveRequiredGate(exec, 'EXAMPLE2/example3-platform', 'main', NOW)
    expect(calls.filter(c => c[1] === 'api')).toHaveLength(1)
  })

  it('does not share a cache entry between two base branches of the same repo', async () => {
    const { exec, calls } = makeExec({})
    await W.resolveRequiredGate(exec, 'your-org/example-platform', 'main', NOW)
    await W.resolveRequiredGate(exec, 'your-org/example-platform', 'redesign', NOW)
    expect(calls.filter(c => c[1] === 'api')).toHaveLength(2)
  })

  it('expires the cache after the TTL', async () => {
    const { exec, calls } = makeExec({})
    await W.resolveRequiredGate(exec, 'EXAMPLE2/example3-platform', 'main', NOW)
    const later = new Date(NOW.getTime() + 61 * 60 * 1000)
    await W.resolveRequiredGate(exec, 'EXAMPLE2/example3-platform', 'main', later)
    expect(calls.filter(c => c[1] === 'api')).toHaveLength(2)
  })

  it('an API error resolves to UNKNOWN and carries the reason', async () => {
    const { exec } = makeExec({}, { rulesetFail: 'HTTP 503: upstream unavailable' })
    const g = await W.resolveRequiredGate(exec, 'EXAMPLE2/example3-platform', 'main', NOW)
    expect(g.state).toBe('unknown')
    expect(g.error).toContain('503')
  })

  it('retries a failed lookup sooner than a good one — errors get a short TTL', async () => {
    const { exec, calls } = makeExec({}, { rulesetFail: 'boom' })
    await W.resolveRequiredGate(exec, 'EXAMPLE2/example3-platform', 'main', NOW)
    // Inside the error TTL: still cached.
    await W.resolveRequiredGate(exec, 'EXAMPLE2/example3-platform', 'main', new Date(NOW.getTime() + 30_000))
    expect(calls.filter(c => c[1] === 'api')).toHaveLength(1)
    // Past it: retried, well before the hour a good answer would have been held for.
    await W.resolveRequiredGate(exec, 'EXAMPLE2/example3-platform', 'main', new Date(NOW.getTime() + 3 * 60_000))
    expect(calls.filter(c => c[1] === 'api')).toHaveLength(2)
  })

  it('a PR with no base branch is UNKNOWN, not silently no-ruleset', async () => {
    const { exec, calls } = makeExec({})
    const g = await W.resolveRequiredGate(exec, 'EXAMPLE2/example3-platform', '', NOW)
    expect(g.state).toBe('unknown')
    expect(calls.filter(c => c[1] === 'api')).toHaveLength(0)
  })
})

// ── 3. Splitting red checks ─────────────────────────────────────────────────────

describe('splitRedChecks', () => {
  const red = [
    { name: 'Verify migrations applied to prod', kind: 'failed' as const, environmental: true, completedAt: null, url: null },
    { name: 'Vitest unit suite (7 pure configs)', kind: 'failed' as const, environmental: false, completedAt: null, url: null },
    { name: 'Scan for secrets', kind: 'failed' as const, environmental: false, completedAt: null, url: null },
  ]

  it('puts only the ruleset contexts on the required side', () => {
    const s = W.splitRedChecks(red, gateOf('enforced', [
      'Vitest unit suite (7 pure configs)', 'Adversarial RLS suite (8th config)',
    ]))
    expect(s.required.map(c => c.name)).toEqual(['Vitest unit suite (7 pure configs)'])
    expect(s.advisory.map(c => c.name)).toEqual(['Verify migrations applied to prod', 'Scan for secrets'])
  })

  it('no-ruleset makes every red check advisory', () => {
    const s = W.splitRedChecks(red, gateOf('no-ruleset'))
    expect(s.required).toEqual([])
    expect(s.advisory).toHaveLength(3)
  })

  it('FAIL-SAFE: an unknown gate makes every red check REQUIRED, never advisory', () => {
    const s = W.splitRedChecks(red, gateOf('unknown'))
    expect(s.required).toHaveLength(3)
    expect(s.advisory).toEqual([])
  })

  it('matches context names case-insensitively after trimming', () => {
    const s = W.splitRedChecks(
      [{ name: '  e2e-smoke ', kind: 'failed' as const, environmental: false, completedAt: null, url: null }],
      gateOf('enforced', ['E2E-Smoke']),
    )
    expect(s.required).toHaveLength(1)
  })
})

// ── 4. mergeableNow ─────────────────────────────────────────────────────────────

describe('computeMergeableNow', () => {
  const none: never[] = []
  const oneRed = [{ name: 'x', kind: 'failed' as const, environmental: false, completedAt: null, url: null }]

  it('true when no required context is red and GitHub reports UNSTABLE (its word for "mergeable, non-required check red")', () => {
    expect(W.computeMergeableNow({
      gate: gateOf('enforced', ['e2e-smoke']), requiredRed: none,
      mergeStateStatus: 'UNSTABLE', isDraft: false,
    })).toBe(true)
  })

  it('false when a required context is red, however clean the merge state', () => {
    expect(W.computeMergeableNow({
      gate: gateOf('enforced', ['x']), requiredRed: oneRed, mergeStateStatus: 'CLEAN', isDraft: false,
    })).toBe(false)
  })

  it.each(['BLOCKED', 'DIRTY'])('false when merge state is %s', (state) => {
    expect(W.computeMergeableNow({
      gate: gateOf('enforced', ['e2e-smoke']), requiredRed: none, mergeStateStatus: state, isDraft: false,
    })).toBe(false)
  })

  it('false for a draft — a draft cannot be merged no matter how green it is', () => {
    expect(W.computeMergeableNow({
      gate: gateOf('no-ruleset'), requiredRed: none, mergeStateStatus: 'CLEAN', isDraft: true,
    })).toBe(false)
  })

  it('false when the gate is UNKNOWN — we do not assert mergeability from a gate we failed to read', () => {
    expect(W.computeMergeableNow({
      gate: gateOf('unknown'), requiredRed: none, mergeStateStatus: 'CLEAN', isDraft: false,
    })).toBe(false)
  })

  it('no-ruleset defers to GitHub: CLEAN is mergeable, BEHIND is too, DIRTY is not', () => {
    const base = { gate: gateOf('no-ruleset'), requiredRed: none, isDraft: false }
    expect(W.computeMergeableNow({ ...base, mergeStateStatus: 'CLEAN' })).toBe(true)
    expect(W.computeMergeableNow({ ...base, mergeStateStatus: 'BEHIND' })).toBe(true)
    expect(W.computeMergeableNow({ ...base, mergeStateStatus: 'DIRTY' })).toBe(false)
  })
})

// ── 5. THE HEADLINE: advisory-only must not escalate ────────────────────────────

/** example3#564 as it actually was on 2026-08-06: one red check, and it gates nothing. */
const P564_ADVISORY_ONLY = pr(564, {
  title: 'feat(billing): operator confirm popup + pending-confirm lane',
  baseRefName: 'main',
  mergeStateStatus: 'BEHIND',
  statusCheckRollup: [
    checkRun('Verify migrations applied to prod', 'FAILURE', '2026-07-26T02:55:43Z'),
    checkRun('Vitest unit suite (7 pure configs)', 'SUCCESS', '2026-07-26T02:55:43Z'),
    checkRun('Adversarial RLS suite (8th config)', 'SUCCESS', '2026-07-26T02:55:43Z'),
  ],
})

/** The SAME PR with the same advisory red, plus one REQUIRED context failing. */
const P564_REQUIRED_RED = pr(564, {
  title: 'feat(billing): operator confirm popup + pending-confirm lane',
  baseRefName: 'main',
  mergeStateStatus: 'BLOCKED',
  statusCheckRollup: [
    checkRun('Verify migrations applied to prod', 'FAILURE', '2026-07-26T02:55:43Z'),
    checkRun('Vitest unit suite (7 pure configs)', 'FAILURE', '2026-07-26T02:55:43Z'),
    checkRun('Adversarial RLS suite (8th config)', 'SUCCESS', '2026-07-26T02:55:43Z'),
  ],
})

async function sweepOne(prs: PrSummary[], repo = 'EXAMPLE2/example3-platform', opts: { rulesetFail?: string } = {}) {
  const { exec } = makeExec({ [repo]: prs }, opts)
  return W.runWatchdogOnce(deps({ exec, env: { PR_HEALTH_WATCHDOG_REPOS: repo } }))
}

describe('an advisory-only red PR does NOT escalate — the 704763 defect', () => {
  it('example3#564 with only `Verify migrations applied to prod` red yields action NONE', async () => {
    const report = await sweepOne([P564_ADVISORY_ONLY])
    const h = report.prs[0]

    // It is still honestly reported as red — we did not paper over it.
    expect(h.redChecks.map(c => c.name)).toEqual(['Verify migrations applied to prod'])
    expect(h.requiredRedChecks).toEqual([])
    expect(h.advisoryRedChecks.map(c => c.name)).toEqual(['Verify migrations applied to prod'])
    expect(h.classification).toBe('advisory-only')

    // And the whole point:
    expect(h.action).toBe('none')
    expect(h.actionDetail).toContain('advisory-only')
    // Specifically NOT the old verdict.
    expect(h.classification).not.toBe('environmental')
  })

  it('the SAME PR with a REQUIRED context red DOES escalate', async () => {
    const report = await sweepOne([P564_REQUIRED_RED])
    const h = report.prs[0]

    expect(h.requiredRedChecks.map(c => c.name)).toEqual(['Vitest unit suite (7 pure configs)'])
    expect(h.advisoryRedChecks.map(c => c.name)).toEqual(['Verify migrations applied to prod'])
    expect(h.classification).toBe('unowned') // real failure, and no objective owns it
    expect(h.action).toBe('escalate')
  })

  it('escalating on a required check does not name the advisory paint as the reason', async () => {
    const report = await sweepOne([P564_REQUIRED_RED])
    expect(report.prs[0].actionDetail).not.toContain('Verify migrations applied to prod')
  })

  it('a required ENVIRONMENTAL check still escalates — only the required-ness changed', async () => {
    // Hypothetical: the migration gate promoted INTO example3's ruleset. Same check name,
    // now required, so the environmental escalation is correct again.
    const saved = RULESETS['EXAMPLE2/example3-platform@main']
    RULESETS['EXAMPLE2/example3-platform@main'] = [{
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: 'Verify migrations applied to prod' }] },
    }]
    try {
      const report = await sweepOne([P564_ADVISORY_ONLY])
      expect(report.prs[0].classification).toBe('environmental')
      expect(report.prs[0].action).toBe('escalate')
    } finally {
      RULESETS['EXAMPLE2/example3-platform@main'] = saved
    }
  })
})

// ── 6. The fail-safe ────────────────────────────────────────────────────────────

describe('fail-safe when the ruleset API is unavailable', () => {
  it('still escalates a red PR rather than silently calling everything advisory', async () => {
    const report = await sweepOne([P564_ADVISORY_ONLY], 'EXAMPLE2/example3-platform', {
      rulesetFail: 'HTTP 500: GitHub is having a bad day',
    })
    const h = report.prs[0]

    expect(h.requiredGateState).toBe('unknown')
    // Every red check is treated as blocking — the pre-704763 behaviour, on purpose.
    expect(h.requiredRedChecks.map(c => c.name)).toEqual(['Verify migrations applied to prod'])
    expect(h.advisoryRedChecks).toEqual([])
    expect(h.classification).toBe('environmental')
    expect(h.action).toBe('escalate')
    // And we refuse to claim mergeability from a gate we could not read.
    expect(h.mergeableNow).toBe(false)
  })

  it('surfaces the unreadable gate in the report and the digest rather than hiding it', async () => {
    const report = await sweepOne([P564_ADVISORY_ONLY], 'EXAMPLE2/example3-platform', {
      rulesetFail: 'HTTP 500: GitHub is having a bad day',
    })
    expect(report.gates['EXAMPLE2/example3-platform@main'].state).toBe('unknown')
    const md = W.renderDigest(report)
    expect(md).toContain('RULESET UNREADABLE')
    expect(md).toContain('GitHub is having a bad day')
  })

  it('a 404 on the ruleset endpoint is UNKNOWN, not "nothing is required"', async () => {
    // No fixture for `some-other-branch`, so the stub throws a 404 exactly as gh would.
    const report = await sweepOne([pr(700, {
      baseRefName: 'some-other-branch',
      statusCheckRollup: [checkRun('Verify migrations applied to prod', 'FAILURE', '2026-07-26T02:55:43Z')],
    })])
    expect(report.prs[0].requiredGateState).toBe('unknown')
    expect(report.prs[0].action).toBe('escalate')
  })
})

// ── 7. The empty required list, represented honestly ────────────────────────────

describe('example `redesign` — an EMPTY required list is not verified-green', () => {
  const p475 = pr(475, {
    title: 'Reproduce + lock the intern Export Invoice route',
    baseRefName: 'redesign',
    mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [
      checkRun('vitest (app suite)', 'CANCELLED', '2026-08-05T12:00:00Z'),
      checkRun('typecheck (tsc ratchet)', 'CANCELLED', '2026-08-05T12:00:00Z'),
      checkRun('Vercel', 'SUCCESS'),
    ],
  })

  it('reports no-ruleset — a distinct state from both enforced and unknown', async () => {
    const report = await sweepOne([p475], 'your-org/example-platform')
    const h = report.prs[0]
    expect(h.baseBranch).toBe('redesign')
    expect(h.requiredGateState).toBe('no-ruleset')
    expect(h.requiredContexts).toEqual([])
  })

  it('is NOT classified green — the red checks are still reported as red', async () => {
    const report = await sweepOne([p475], 'your-org/example-platform')
    const h = report.prs[0]
    expect(h.classification).toBe('advisory-only')
    expect(h.classification).not.toBe('green')
    expect(h.advisoryRedChecks).toHaveLength(2)
    expect(h.failureKind).toBe('cancellation-only') // the check-level truth is preserved
  })

  it('the digest says "no required checks configured" and explicitly disclaims verified-green', async () => {
    const report = await sweepOne([p475], 'your-org/example-platform')
    const md = W.renderDigest(report)
    expect(md).toContain('no required checks configured')
    expect(md).toContain('NOT "checks verified green"')
    expect(md).toContain('base `redesign`')
  })

  it('takes no action on it', async () => {
    const report = await sweepOne([p475], 'your-org/example-platform')
    expect(report.prs[0].action).toBe('none')
  })
})

// ── 8. MERGEABLE-NOW on the surface ─────────────────────────────────────────────

describe('the MERGEABLE-NOW section', () => {
  // example3#669 as verified live: both required contexts SUCCESS, three advisory reds.
  const p669 = pr(669, {
    title: 'fix(validator): ownership before radius in the topup geo gate',
    mergeStateStatus: 'UNSTABLE',
    statusCheckRollup: [
      checkRun('tsc --noEmit (full repo incl. tests/e2e)', 'CANCELLED', '2026-08-06T17:00:00Z'),
      checkRun('Scan for secrets', 'CANCELLED', '2026-08-06T17:00:00Z'),
      checkRun('Claude security review (advisory)', 'CANCELLED', '2026-08-06T17:00:00Z'),
      checkRun('Vitest unit suite (7 pure configs)', 'SUCCESS'),
      checkRun('Adversarial RLS suite (8th config)', 'SUCCESS'),
    ],
  })
  const p668Blocked = pr(668, {
    title: 'fix(stage-tools): plumb --topup-max-miles through stage-tools',
    mergeStateStatus: 'BLOCKED',
    statusCheckRollup: [
      checkRun('Vitest unit suite (7 pure configs)', 'CANCELLED', '2026-08-06T17:00:00Z'),
      checkRun('Adversarial RLS suite (8th config)', 'CANCELLED', '2026-08-06T17:00:00Z'),
    ],
  })

  it('marks the advisory-red PR mergeable and the required-red one not', async () => {
    const report = await sweepOne([p669, p668Blocked])
    const by = Object.fromEntries(report.prs.map(p => [p.number, p]))
    expect(by[669].mergeableNow).toBe(true)
    expect(by[668].mergeableNow).toBe(false)
  })

  it('renders a MERGEABLE NOW section with a count in the header tally', async () => {
    const md = W.renderDigest(await sweepOne([p669, p668Blocked]))
    expect(md).toContain('## MERGEABLE NOW')
    expect(md).toContain('1 mergeable now')
    expect(md).toContain('1 with a REQUIRED check failing')
    expect(md).toContain('EXAMPLE2/example3-platform#669')
    // The advisory reds are named there too, so "mergeable" is never mistaken for "green".
    expect(md).toContain('3 advisory red')
  })

  it('a green PR with no red checks at all is mergeable-now and still not re-listed as red', async () => {
    const green = pr(680, { mergeStateStatus: 'CLEAN', statusCheckRollup: [checkRun('Vitest unit suite (7 pure configs)', 'SUCCESS')] })
    const report = await sweepOne([green])
    expect(report.prs[0].classification).toBe('green')
    expect(report.prs[0].mergeableNow).toBe(true)
    const md = W.renderDigest(report)
    expect(md).toContain('## MERGEABLE NOW')
    expect(md).toContain('No red PRs. Nothing to hunt.')
  })

  it('the digest names the gate behind every advisory claim', async () => {
    const md = W.renderDigest(await sweepOne([p669]))
    expect(md).toContain('`Vitest unit suite (7 pure configs)`')
    expect(md).toContain('`Adversarial RLS suite (8th config)`')
  })
})

// ── 9. Base-branch keying end-to-end ────────────────────────────────────────────

describe('the gate is keyed on the base branch, per PR', () => {
  it('two PRs in ONE repo with different bases get different gates in one sweep', async () => {
    const toMain = pr(400, {
      baseRefName: 'main',
      statusCheckRollup: [checkRun('e2e-smoke', 'FAILURE', '2026-08-01T00:00:00Z')],
    })
    const toRedesign = pr(401, {
      baseRefName: 'redesign',
      statusCheckRollup: [checkRun('e2e-smoke', 'FAILURE', '2026-08-01T00:00:00Z')],
    })
    const report = await sweepOne([toMain, toRedesign], 'your-org/example-platform')
    const by = Object.fromEntries(report.prs.map(p => [p.number, p]))

    // Identical rollups, opposite verdicts — the base branch is the only difference.
    expect(by[400].requiredGateState).toBe('enforced')
    expect(by[400].requiredRedChecks.map(c => c.name)).toEqual(['e2e-smoke'])
    expect(by[400].action).toBe('escalate')

    expect(by[401].requiredGateState).toBe('no-ruleset')
    expect(by[401].requiredRedChecks).toEqual([])
    expect(by[401].action).toBe('none')

    expect(report.gates['your-org/example-platform@main'].contexts).toEqual(['e2e-smoke'])
    expect(report.gates['your-org/example-platform@redesign'].contexts).toEqual([])
  })

  it('the sweep makes ONE ruleset call per distinct base branch, not one per PR', async () => {
    const prs = Array.from({ length: 6 }, (_, i) => pr(500 + i, {
      statusCheckRollup: [checkRun('Scan for secrets', 'FAILURE', '2026-08-01T00:00:00Z')],
    }))
    const { exec, calls } = makeExec({ 'EXAMPLE2/example3-platform': prs })
    await W.sweepHealth(deps({ exec, env: { PR_HEALTH_WATCHDOG_REPOS: 'EXAMPLE2/example3-platform' } }))
    expect(calls.filter(c => c[1] === 'api')).toHaveLength(1)
  })
})

// ── 10. The zero-timestamp guard still holds on the new path ────────────────────

describe('regression guards preserved', () => {
  it('harness/* is still invisible, so a cc-infra harness gate never becomes a required red', async () => {
    // command-center-infra's only required context is `harness/test-agent`, and
    // summariseRollup drops harness/* by construction (the harness gates its own PRs and a
    // second driver would fight it). The PR is therefore advisory-only here, NOT escalated
    // on a harness failure — the pre-existing carve-out wins over required-ness, by design.
    RULESETS['your-org/command-center-infra@main'] = [{
      type: 'required_status_checks',
      parameters: { required_status_checks: [{ context: 'harness/test-agent' }] },
    }]
    const report = await sweepOne([pr(243, {
      statusCheckRollup: [
        checkRun('harness/test-agent', 'FAILURE', '2026-08-01T00:00:00Z'),
        checkRun('Scan for secrets', 'FAILURE', '2026-08-01T00:00:00Z'),
      ],
    })], 'your-org/command-center-infra')
    const h = report.prs[0]
    expect(h.redChecks.map(c => c.name)).toEqual(['Scan for secrets'])
    expect(h.requiredRedChecks).toEqual([])
    expect(h.action).toBe('none')
  })

  it('a zero completedAt still normalises to null on the required side', async () => {
    const report = await sweepOne([pr(701, {
      statusCheckRollup: [checkRun('Vitest unit suite (7 pure configs)', 'FAILURE', ZERO_TS)],
    })])
    expect(report.prs[0].requiredRedChecks[0].completedAt).toBeNull()
  })
})
