/**
 * Unit tests for the CI-green completion gate (obj 704785).
 *
 * The four branches that matter, one describe block each:
 *   1. failed-required          → HOLDS, and names the failing checks
 *   2. absent-required          → does NOT hold indefinitely (bounded, then records)
 *   3. advisory-red             → NEVER holds
 *   4. hold-cap                 → escalates to Operator instead of bouncing forever
 * plus the required-set derivation (ruleset, not check names) and the Operator-facing
 * surface, end to end against a real SQLite DB.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RollupEntry, RequiredChecks, ExecFn } from './ci-green-gate.js'

const TMP_DB = path.join(os.tmpdir(), `cc-cigate-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  evaluateCiGate,
  normaliseRollup,
  fetchRequiredChecks,
  clearRequiredChecksCache,
  runCompletionGate,
  applyGateHandback,
  listNonGreenCompletions,
  renderNonGreenCompletions,
  buildHandback,
  repoFromPrUrl,
  loadConfig,
  DEFAULT_CONFIG,
  ensureGateTable,
  isHarnessOwnStatus,
} = await import('./ci-green-gate.js')
// Cross-module agreement check: this gate's exclusion predicate and the remediation
// loop's must stay in lockstep (they are deliberately duplicated — see ci-green-gate.ts).
const { isHarnessCheck } = await import('./external-remediation-classify.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  ensureGateTable(getDb())
})

afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix) } catch { /* ignore */ }
  }
})

// ── Fixtures ────────────────────────────────────────────────────────────────────

/** The two checks that are genuinely required on EXAMPLE2/example3-platform today. */
const REQ = ['Vitest unit suite (7 pure configs)', 'Adversarial RLS suite (8th config)']
const ruleset = (contexts: string[] = REQ): RequiredChecks => ({ contexts, source: 'ruleset' })

function checkRun(name: string, conclusion: string, status = 'COMPLETED'): RollupEntry {
  return { __typename: 'CheckRun', name, status, conclusion }
}
function statusContext(context: string, state: string): RollupEntry {
  return { __typename: 'StatusContext', context, state }
}

function inputs(over: Partial<Parameters<typeof evaluateCiGate>[0]> = {}) {
  return {
    requiredChecks: ruleset(),
    rollup: [] as RollupEntry[],
    holdCount: 0,
    waitedMinutes: 0,
    mode: 'enforce' as const,
    config: DEFAULT_CONFIG,
    ...over,
  }
}

// ── 1. failed-required HOLDS ────────────────────────────────────────────────────

describe('failed required check → HOLD', () => {
  it('holds and names the specific failing required check', () => {
    const d = evaluateCiGate(inputs({
      rollup: [
        checkRun(REQ[0], 'FAILURE'),
        checkRun(REQ[1], 'SUCCESS'),
      ],
    }))
    expect(d.action).toBe('hold')
    expect(d.failingRequired).toEqual([REQ[0]])
    expect(d.reason).toContain(REQ[0])
  })

  it('the handback message carries the check names and a concrete command', () => {
    const d = evaluateCiGate(inputs({ rollup: [checkRun(REQ[0], 'TIMED_OUT'), checkRun(REQ[1], 'SUCCESS')] }))
    const msg = buildHandback(d, 'EXAMPLE2/example3-platform', 679)
    expect(msg).toContain(REQ[0])
    expect(msg).toContain('gh pr checks 679 --repo EXAMPLE2/example3-platform')
    expect(msg).toContain('Do NOT merge')
  })

  // Intent: a StatusContext (as opposed to a CheckRun) in state ERROR must hold. This
  // used to assert it via `harness/test-agent`, which the gate now deliberately ignores
  // as self-referential (obj 706069) — so the same assertion is made through a
  // third-party status context, preserving what the test was actually for.
  it('a required StatusContext in state ERROR also holds', () => {
    const d = evaluateCiGate(inputs({
      requiredChecks: ruleset(['ci/circleci: build']),
      rollup: [statusContext('ci/circleci: build', 'ERROR')],
    }))
    expect(d.action).toBe('hold')
    expect(d.failingRequired).toEqual(['ci/circleci: build'])
  })

  it('a failing required check keeps holding even at the wall-clock bound — only ABSENT checks are time-released', () => {
    const d = evaluateCiGate(inputs({
      rollup: [checkRun(REQ[0], 'FAILURE'), checkRun(REQ[1], 'SUCCESS')],
      waitedMinutes: 10_000,
    }))
    expect(d.action).toBe('hold')
  })
})

// ── 2. absent-required does NOT deadlock ────────────────────────────────────────

describe('absent / queued / cancelled required check → bounded, never indefinite', () => {
  it('holds inside the wait window', () => {
    const d = evaluateCiGate(inputs({ rollup: [checkRun('Vercel', 'SUCCESS')], waitedMinutes: 5 }))
    expect(d.action).toBe('hold')
    expect(d.failingRequired).toEqual([])
    expect(d.missingRequired).toHaveLength(2)
  })

  it('COMPLETES once the bounded wait elapses, with a recorded reason', () => {
    const d = evaluateCiGate(inputs({
      rollup: [checkRun('Vercel', 'SUCCESS')],
      waitedMinutes: DEFAULT_CONFIG.absentWaitMinutes + 1,
    }))
    expect(d.action).toBe('complete-with-red')
    expect(d.reason).toMatch(/never reported/)
    expect(d.reason).toMatch(/not a worker failure/)
  })

  it('reproduces the 2026-08-06 Actions outage: only Vercel checks present, zero Actions runs', () => {
    // PR #679 head cf95539 carried Vercel checks and NO check runs at all.
    const outage = evaluateCiGate(inputs({
      rollup: [
        statusContext('Vercel', 'SUCCESS'),
        statusContext('Vercel Preview Comments', 'SUCCESS'),
      ],
      waitedMinutes: 120,
    }))
    expect(outage.action).toBe('complete-with-red')
    expect(outage.missingRequired.every(m => m.includes('never scheduled'))).toBe(true)
  })

  it('a required check CANCELLED at a concurrency gate is treated as absent, not as a failure', () => {
    const d = evaluateCiGate(inputs({
      rollup: [checkRun(REQ[0], 'CANCELLED'), checkRun(REQ[1], 'SUCCESS')],
      waitedMinutes: 1,
    }))
    expect(d.failingRequired).toEqual([])
    expect(d.missingRequired).toEqual([`${REQ[0]} (cancelled)`])
    expect(d.action).toBe('hold') // bounded — and released below
    const released = evaluateCiGate(inputs({
      rollup: [checkRun(REQ[0], 'CANCELLED'), checkRun(REQ[1], 'SUCCESS')],
      waitedMinutes: DEFAULT_CONFIG.absentWaitMinutes,
    }))
    expect(released.action).toBe('complete-with-red')
  })

  it('a queued required check is absent, not failing', () => {
    const d = evaluateCiGate(inputs({
      rollup: [checkRun(REQ[0], '', 'QUEUED'), checkRun(REQ[1], 'SUCCESS')],
      waitedMinutes: DEFAULT_CONFIG.absentWaitMinutes,
    }))
    expect(d.action).toBe('complete-with-red')
    expect(d.missingRequired).toEqual([`${REQ[0]} (queued/in progress)`])
  })

  it('the hold cap also releases an absent check, so the two bounds cannot conspire to wedge it', () => {
    const d = evaluateCiGate(inputs({
      rollup: [],
      waitedMinutes: 0,
      holdCount: DEFAULT_CONFIG.holdCap,
    }))
    expect(d.action).toBe('complete-with-red')
  })
})

// ── 3. advisory red NEVER holds ─────────────────────────────────────────────────

describe('advisory (non-required) red → never blocks', () => {
  it('allows completion with tsc, gitleaks, Playwright, security-review and Vercel all red', () => {
    const d = evaluateCiGate(inputs({
      rollup: [
        checkRun(REQ[0], 'SUCCESS'),
        checkRun(REQ[1], 'SUCCESS'),
        checkRun('tsc', 'FAILURE'),
        checkRun('gitleaks', 'FAILURE'),
        checkRun('Playwright e2e', 'FAILURE'),
        checkRun('Claude security review', 'FAILURE'),
        statusContext('Vercel', 'FAILURE'),
      ],
    }))
    expect(d.action).toBe('allow')
    expect(d.advisoryRed).toEqual(['tsc', 'gitleaks', 'Playwright e2e', 'Claude security review', 'Vercel'])
    expect(d.reason).toContain('advisory never blocks')
  })

  it('a branch with no required checks at all never holds, however red', () => {
    const d = evaluateCiGate(inputs({
      requiredChecks: { contexts: [], source: 'none' },
      rollup: [checkRun('anything', 'FAILURE')],
    }))
    expect(d.action).toBe('allow')
  })

  it('SKIPPED and NEUTRAL required conclusions count as satisfied, not as failures', () => {
    const d = evaluateCiGate(inputs({
      rollup: [checkRun(REQ[0], 'SKIPPED'), checkRun(REQ[1], 'NEUTRAL')],
    }))
    expect(d.action).toBe('allow')
  })
})

// ── 3b. the gate must not grade its own output (obj 706069) ─────────────────────

describe('self-referential harness status → never gates completion', () => {
  // The live deadlock this closes. `harness/test-agent` is required by the ruleset but
  // has no CI producer: the gate's own caller posts it = failure whenever the gate holds.
  // So holding once made the required set permanently unsatisfiable.
  const HARNESS = 'harness/test-agent'
  const CC_REQ = ['vitest (client)', 'vitest (server)']

  it('does not hold on its own failure status when every third-party required check is green', () => {
    const d = evaluateCiGate(inputs({
      requiredChecks: ruleset([...CC_REQ, HARNESS]),
      rollup: [
        checkRun(CC_REQ[0], 'SUCCESS'),
        checkRun(CC_REQ[1], 'SUCCESS'),
        statusContext(HARNESS, 'FAILURE'),
      ],
    }))
    expect(d.action).toBe('allow')
    expect(d.failingRequired).toEqual([])
    expect(d.missingRequired).toEqual([])
  })

  it('EXACT PR #273 sequence: iteration-1 blocked posts red, iteration-2 passes, gate must release', () => {
    // 02:08 review blocked by a dead preview → harness/test-agent=failure (legitimate then).
    // 02:53 preview fixed. 03:03:38 review iteration 2 PASSED. The gate then refused
    // completion by reading iteration 1's superseded status, and re-posted it — forever.
    const withStaleRed = inputs({
      requiredChecks: ruleset([...CC_REQ, HARNESS]),
      rollup: [
        checkRun(CC_REQ[0], 'SUCCESS'),
        checkRun(CC_REQ[1], 'SUCCESS'),
        statusContext(HARNESS, 'FAILURE'),
      ],
      holdCount: 1,
    })
    const d = evaluateCiGate(withStaleRed)
    expect(d.action).toBe('allow')
    // and it must not merely be time-released — it is green on the merits, immediately.
    expect(d.waitedMinutes).toBe(0)
    expect(d.reason).toContain('green')
  })

  it('is not reported as advisory red either — it is not evidence in any column', () => {
    const d = evaluateCiGate(inputs({
      requiredChecks: ruleset(CC_REQ),
      rollup: [
        checkRun(CC_REQ[0], 'SUCCESS'),
        checkRun(CC_REQ[1], 'SUCCESS'),
        statusContext(HARNESS, 'FAILURE'),
      ],
    }))
    expect(d.action).toBe('allow')
    expect(d.advisoryRed).toEqual([])
  })

  it('an ABSENT harness status does not consume the bounded absent-wait window', () => {
    // Pushing a new commit rotates the SHA, so the harness status is missing rather than
    // red. That must not read as "required check never scheduled" and burn the clock.
    const d = evaluateCiGate(inputs({
      requiredChecks: ruleset([...CC_REQ, HARNESS]),
      rollup: [checkRun(CC_REQ[0], 'SUCCESS'), checkRun(CC_REQ[1], 'SUCCESS')],
    }))
    expect(d.action).toBe('allow')
    expect(d.missingRequired).toEqual([])
  })

  it('STILL HOLDS on a genuine third-party failure alongside its own red — the fix narrows by exactly one self-reference', () => {
    const d = evaluateCiGate(inputs({
      requiredChecks: ruleset([...CC_REQ, HARNESS]),
      rollup: [
        checkRun(CC_REQ[0], 'FAILURE'),
        checkRun(CC_REQ[1], 'SUCCESS'),
        statusContext(HARNESS, 'FAILURE'),
      ],
    }))
    expect(d.action).toBe('hold')
    expect(d.failingRequired).toEqual([CC_REQ[0]])
    expect(d.failingRequired).not.toContain(HARNESS)
  })

  it('a branch whose ONLY required check is the harness status says so, rather than "none configured"', () => {
    const d = evaluateCiGate(inputs({
      requiredChecks: ruleset([HARNESS]),
      rollup: [statusContext(HARNESS, 'FAILURE')],
    }))
    expect(d.action).toBe('allow')
    expect(d.reason).toContain("harness's own status")
    expect(d.reason).not.toContain('No required checks configured')
  })

  it('isHarnessOwnStatus agrees with external-remediation.isHarnessCheck', () => {
    for (const n of ['harness/test-agent', 'HARNESS/TEST-AGENT', ' harness/anything ']) {
      expect(isHarnessOwnStatus(n)).toBe(true)
      expect(isHarnessCheck(n)).toBe(true)
    }
    for (const n of ['vitest (server)', 'harnessed', '', 'ci/harness']) {
      expect(isHarnessOwnStatus(n)).toBe(false)
      expect(isHarnessCheck(n)).toBe(false)
    }
  })
})

// ── 4. hold cap escalates ───────────────────────────────────────────────────────

describe('hold cap → escalate to Operator, never an infinite worker→review bounce', () => {
  it('escalates once holdCount reaches the cap on a genuine failure', () => {
    const failing = { rollup: [checkRun(REQ[0], 'FAILURE'), checkRun(REQ[1], 'SUCCESS')] }
    expect(evaluateCiGate(inputs({ ...failing, holdCount: 0 })).action).toBe('hold')
    expect(evaluateCiGate(inputs({ ...failing, holdCount: 1 })).action).toBe('hold')
    const capped = evaluateCiGate(inputs({ ...failing, holdCount: DEFAULT_CONFIG.holdCap }))
    expect(capped.action).toBe('escalate')
    expect(capped.reason).toMatch(/Hold cap reached/)
    expect(capped.reason).toContain(REQ[0])
  })

  it('escalation is terminal for the bounce loop: it never returns to hold', () => {
    const d = evaluateCiGate(inputs({
      rollup: [checkRun(REQ[0], 'FAILURE'), checkRun(REQ[1], 'SUCCESS')],
      holdCount: 99,
    }))
    expect(d.action).toBe('escalate')
  })
})

// ── record-only mode (the limbo-breaking sweeper) ───────────────────────────────

describe('record-only mode never holds', () => {
  it('completes with a record even on a genuinely failing required check', () => {
    const d = evaluateCiGate(inputs({
      rollup: [checkRun(REQ[0], 'FAILURE')],
      mode: 'record-only',
    }))
    expect(d.action).toBe('complete-with-red')
    expect(d.failingRequired).toEqual([REQ[0]])
  })
})

// ── required-vs-advisory comes from the ruleset ─────────────────────────────────

describe('required set is read from the repo, not guessed', () => {
  beforeEach(() => clearRequiredChecksCache())

  it('parses required contexts out of GET /repos/:o/:r/rules/branches/:b', async () => {
    const exec: ExecFn = async (_f, args) => {
      expect(args.join(' ')).toContain('rules/branches/main')
      return JSON.stringify([
        { type: 'pull_request', parameters: {} },
        { type: 'required_status_checks', parameters: { required_status_checks: [{ context: REQ[0] }, { context: REQ[1] }] } },
      ])
    }
    const r = await fetchRequiredChecks('EXAMPLE2/example3-platform', 'main', exec)
    expect(r.source).toBe('ruleset')
    expect(r.contexts).toEqual(REQ)
  })

  it('falls back to classic branch protection when rulesets return nothing', async () => {
    const exec: ExecFn = async (_f, args) => {
      if (args.join(' ').includes('rules/branches')) return '[]'
      return JSON.stringify({ required_status_checks: { contexts: ['harness/test-agent'] } })
    }
    const r = await fetchRequiredChecks('your-org/example-platform', 'main', exec)
    expect(r.source).toBe('branch-protection')
    expect(r.contexts).toEqual(['harness/test-agent'])
  })

  it('404 from both endpoints means "unprotected branch", not "unknown"', async () => {
    const exec: ExecFn = async () => { throw new Error('gh: HTTP 404: Not Found') }
    const r = await fetchRequiredChecks('o/r', 'main', exec)
    expect(r.source).toBe('none')
    expect(r.contexts).toEqual([])
  })

  it('a real API error yields source=unknown, and unknown NEVER holds', async () => {
    const exec: ExecFn = async () => { throw new Error('HTTP 500: server error') }
    const r = await fetchRequiredChecks('o/r', 'main', exec)
    expect(r.source).toBe('unknown')
    const d = evaluateCiGate(inputs({ requiredChecks: r, rollup: [checkRun('anything', 'FAILURE')] }))
    expect(d.action).toBe('complete-with-red') // recorded, but not held
    expect(['hold', 'escalate']).not.toContain(d.action)
  })

  it('check NAMES are never used to infer required-ness — the same red check blocks or not purely by ruleset', () => {
    const red = [checkRun('tsc', 'FAILURE')]
    expect(evaluateCiGate(inputs({ requiredChecks: ruleset(['tsc']), rollup: red })).action).toBe('hold')
    expect(evaluateCiGate(inputs({ requiredChecks: ruleset(REQ), rollup: red, waitedMinutes: 999 })).failingRequired).toEqual([])
  })
})

// ── rollup normalisation ────────────────────────────────────────────────────────

describe('normaliseRollup', () => {
  it('flattens CheckRun and StatusContext into one comparable shape', () => {
    expect(normaliseRollup([
      checkRun('a', 'SUCCESS'),
      checkRun('b', 'FAILURE'),
      checkRun('c', '', 'IN_PROGRESS'),
      statusContext('d', 'PENDING'),
      statusContext('e', 'FAILURE'),
    ])).toEqual([
      { name: 'a', state: 'success', url: null },
      { name: 'b', state: 'failure', url: null },
      { name: 'c', state: 'pending', url: null },
      { name: 'd', state: 'pending', url: null },
      { name: 'e', state: 'failure', url: null },
    ])
  })

  it('tolerates null/garbage', () => {
    expect(normaliseRollup(null)).toEqual([])
    expect(normaliseRollup([{}, { name: '   ' }])).toEqual([])
  })
})

describe('repoFromPrUrl', () => {
  it('extracts owner/repo', () => {
    expect(repoFromPrUrl('https://github.com/EXAMPLE2/example3-platform/pull/679')).toBe('EXAMPLE2/example3-platform')
    expect(repoFromPrUrl(null)).toBeNull()
    expect(repoFromPrUrl('not a url')).toBeNull()
  })
})

describe('loadConfig', () => {
  it('is ON by default and killable with an explicit 0', () => {
    expect(loadConfig(null, {}).enabled).toBe(true)
    expect(loadConfig(null, { CI_GREEN_GATE_ENABLED: '0' }).enabled).toBe(false)
    expect(loadConfig(null, { CI_GREEN_GATE_HOLD_CAP: '5' }).holdCap).toBe(5)
  })
})

// ── End to end against the real DB ──────────────────────────────────────────────

let nextId = 900001
function insertObjective(fields: Record<string, unknown>): number {
  const db = getDb()
  const id = nextId++
  db.prepare(
    `INSERT INTO objectives (id, title, description, status, type, workspace, pr_number, pr_url)
     VALUES (?, ?, '', ?, ?, 'example2', ?, ?)`,
  ).run(id, fields.title ?? 'test ci gate', fields.status ?? 'ai_review', fields.type ?? 'task',
        fields.pr_number ?? null, fields.pr_url ?? null)
  return id
}

function execFor(rollup: RollupEntry[], required: string[] = REQ): ExecFn {
  return async (_file, args) => {
    const joined = args.join(' ')
    if (joined.includes('rules/branches')) {
      return JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: required.map(c => ({ context: c })) } }])
    }
    if (joined.startsWith('pr view')) {
      return JSON.stringify({
        number: 679, url: 'https://github.com/EXAMPLE2/example3-platform/pull/679',
        headRefOid: 'cf95539', baseRefName: 'main', statusCheckRollup: rollup,
      })
    }
    throw new Error(`unexpected exec: ${joined}`)
  }
}

describe('runCompletionGate (end to end, real DB)', () => {
  beforeEach(() => {
    clearRequiredChecksCache()
    getDb().exec('DELETE FROM objective_completion_gate')
  })

  it('no PR ⇒ nothing to gate on', async () => {
    const id = insertObjective({})
    const r = await runCompletionGate(getDb(), { id }, { pathway: 'test', exec: execFor([]) })
    expect(r.blocked).toBe(false)
    expect(r.decision.reason).toMatch(/no associated PR/)
  })

  it('a failing required check blocks, increments the hold count, and escalates at the cap', async () => {
    const db = getDb()
    const id = insertObjective({ pr_number: 679, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/679' })
    const obj = { id, pr_number: 679, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/679', session_id: null }
    const exec = execFor([checkRun(REQ[0], 'FAILURE'), checkRun(REQ[1], 'SUCCESS')])

    const alerts: unknown[] = []
    const first = await runCompletionGate(db, obj, { pathway: 'test', exec })
    expect(first.blocked).toBe(true)
    expect(first.decision.action).toBe('hold')
    expect(first.handback).toContain(REQ[0])
    applyGateHandback(db, obj, first)

    const second = await runCompletionGate(db, obj, { pathway: 'test', exec })
    expect(second.decision.action).toBe('hold')
    applyGateHandback(db, obj, second)

    const third = await runCompletionGate(db, obj, { pathway: 'test', exec, alert: a => alerts.push(a) })
    expect(third.decision.action).toBe('escalate')
    expect(third.blocked).toBe(true)
    expect(alerts).toHaveLength(1)

    // The bounce left it parked in review, not looping.
    const status = db.prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }
    expect(status.status).toBe('review')
  })

  it('the wall-clock bound releases an absent required check even with holds to spare', async () => {
    const db = getDb()
    const obj = { id: insertObjective({}), pr_number: 679, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/679' }
    const exec = execFor([statusContext('Vercel', 'SUCCESS')])
    const t0 = new Date('2026-08-06T00:00:00Z')

    const held = await runCompletionGate(db, obj, { pathway: 'test', exec, now: () => t0 })
    expect(held.decision.action).toBe('hold')

    const later = new Date(t0.getTime() + (DEFAULT_CONFIG.absentWaitMinutes + 1) * 60_000)
    const released = await runCompletionGate(db, obj, { pathway: 'test', exec, now: () => later })
    expect(released.blocked).toBe(false)
    expect(released.decision.action).toBe('complete-with-red')
  })

  it('fails OPEN when gh blows up, and records that it did', async () => {
    const db = getDb()
    const id = insertObjective({})
    const obj = { id, pr_number: 679, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/679' }
    const r = await runCompletionGate(db, obj, { pathway: 'test', exec: async () => { throw new Error('gh exploded') } })
    expect(r.blocked).toBe(false)
    const row = db.prepare('SELECT resolution FROM objective_completion_gate WHERE objective_id = ?').get(id) as { resolution: string }
    expect(row.resolution).toBe('completed-unverified')
  })

  it('the kill switch disables the gate entirely', async () => {
    const r = await runCompletionGate(getDb(), { id: insertObjective({}), pr_number: 1, pr_url: 'https://github.com/o/r/pull/1' },
      { pathway: 'test', env: { CI_GREEN_GATE_ENABLED: '0' }, exec: execFor([checkRun(REQ[0], 'FAILURE')]) })
    expect(r.blocked).toBe(false)
    expect(r.decision.reason).toMatch(/disabled/)
  })
})

// ── The Operator-facing surface ─────────────────────────────────────────────────────

// ── The worker-session-end apply path (the bypass caught in review) ─────────────

describe('worker-session-end apply path is gated', () => {
  beforeEach(() => {
    clearRequiredChecksCache()
    getDb().exec('DELETE FROM objective_completion_gate')
  })

  /**
   * The regression this locks down. `state-poller.ts` resolves a worker-end status
   * into a VARIABLE and writes it, so the write does not read as a `'done'` literal.
   * An objective that ALREADY passed AI review — which for a `create_pr` objective
   * means it has a PR — and is later resurrected to `working` gets forwarded straight
   * to `done` by the always-on re-review churn guard. Before the fix that forward was
   * ungated: it could close on a red PR while the gate looked closed.
   *
   * This exercises the gate contract at that call site (runCompletionGate +
   * applyGateHandback with pathway `worker-end-apply`), not the poller loop itself.
   */
  it('a create_pr objective forwarded by the re-review skip does NOT reach done on a failing required check', async () => {
    const db = getDb()
    const id = insertObjective({ title: 'already-passed, resurrected, forwarded', status: 'working' })
    const obj = { id, pr_number: 679, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/679', session_id: null }

    const gate = await runCompletionGate(db, obj, {
      pathway: 'worker-end-apply',
      exec: execFor([checkRun(REQ[0], 'FAILURE'), checkRun(REQ[1], 'SUCCESS')]),
    })
    expect(gate.blocked).toBe(true)
    expect(gate.decision.failingRequired).toEqual([REQ[0]])

    const landed = applyGateHandback(db, obj, gate)
    expect(landed).toBe('review')
    const row = db.prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }
    expect(row.status).not.toBe('done')
    expect(row.status).toBe('review')
  })

  it('with a live session the same forward bounces the worker back to working, not done', async () => {
    const db = getDb()
    const id = insertObjective({ status: 'working' })
    const obj = { id, pr_number: 679, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/679', session_id: 'sess-abc' }
    const gate = await runCompletionGate(db, obj, {
      pathway: 'worker-end-apply',
      exec: execFor([checkRun(REQ[0], 'FAILURE')]),
    })
    const landed = applyGateHandback(db, obj, gate, { sendFollowUp: () => 'sess-def' })
    expect(landed).toBe('working')
    const row = db.prepare('SELECT status, session_id FROM objectives WHERE id = ?').get(id) as { status: string; session_id: string }
    expect(row.status).toBe('working')
    expect(row.session_id).toBe('sess-def')
  })

  it('a GREEN PR on the same path is not blocked — the gate does not become a wall', async () => {
    const db = getDb()
    const obj = { id: insertObjective({ status: 'working' }), pr_number: 679, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/679' }
    const gate = await runCompletionGate(db, obj, {
      pathway: 'worker-end-apply',
      exec: execFor([checkRun(REQ[0], 'SUCCESS'), checkRun(REQ[1], 'SUCCESS')]),
    })
    expect(gate.blocked).toBe(false)
  })

  it('the ai-review cap-out path records instead of holding (it exists to stop bouncing)', async () => {
    const db = getDb()
    const id = insertObjective({ status: 'working' })
    const obj = { id, pr_number: 679, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/679' }
    const gate = await runCompletionGate(db, obj, {
      mode: 'record-only',
      pathway: 'ai-review-cap-out',
      exec: execFor([checkRun(REQ[0], 'FAILURE')]),
    })
    expect(gate.blocked).toBe(false)
    expect(gate.decision.action).toBe('complete-with-red')
    const entry = listNonGreenCompletions(db).find(e => e.objectiveId === id)
    expect(entry?.pathway).toBe('ai-review-cap-out')
    expect(entry?.failingChecks).toEqual([REQ[0]])
  })
})

// ── Structural guard: the enumerated done-paths stay wired ──────────────────────

describe('every enumerated done-transition keeps its gate call', () => {
  const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')

  it('state-poller.ts gates all five of its done-capable writes', () => {
    // Cap-out lives in poller-ai-review.ts; auto-accept / hard-expiry in poller-hygiene.ts;
    // worker-end-apply lives in poller-loop.ts.
    const src = [read('./state-poller.ts'), read('./poller-ai-review.ts'), read('./poller-hygiene.ts'), read('./poller-loop.ts')].join('\n')
    for (const pathway of ['reviewer-verdict', 'auto-accept-on-pass-ttl', 'review-hard-expiry', 'worker-end-apply', 'ai-review-cap-out']) {
      expect(src, `missing gate for pathway ${pathway}`).toContain(`pathway: '${pathway}'`)
    }
    // The worker-end apply write takes a VARIABLE status — the exact shape that hid
    // the bypass — so assert it stays behind the gate flag rather than the gate merely
    // existing somewhere in the file. Green-lane may stamp a synthetic verdict in
    // the same block; the UPDATE must still sit inside `if (!ciGateBlocked)`.
    expect(src).toMatch(
      /if \(!ciGateBlocked\) \{[\s\S]{0,800}?(?:db\.prepare|runMachineStatusUpdate)\([\s\S]{0,200}?UPDATE objectives SET[\s\S]{0,200}?status = \?/,
    )
  })

  it('both status routes gate their done branch', () => {
    const publicStatus = [read('../routes/objectives.ts'), read('../routes/objectives-status.ts')].join('\n')
    expect(publicStatus).toContain("pathway: 'human-patch-done'")
    const internalStatus = [read('../routes/internal.ts'), read('../routes/internal-hermes.ts')].join('\n')
    expect(internalStatus).toContain("pathway: 'internal-patch-done'")
  })
})

describe('non-green completions are visible to Operator', () => {
  beforeEach(() => {
    clearRequiredChecksCache()
    getDb().exec('DELETE FROM objective_completion_gate')
  })

  it('records a completed-with-red objective and renders it on the digest', async () => {
    const db = getDb()
    const id = insertObjective({ title: 'W17 demo objective', status: 'done' })
    const obj = { id, pr_number: 679, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/679' }
    await runCompletionGate(db, obj, {
      pathway: 'reviewer-verdict',
      exec: execFor([statusContext('Vercel', 'SUCCESS')]),
      now: () => new Date('2026-08-06T00:00:00Z'),
      mode: 'record-only',
    })

    const entries = listNonGreenCompletions(db)
    expect(entries).toHaveLength(1)
    expect(entries[0].objectiveId).toBe(id)
    expect(entries[0].resolution).toBe('completed-with-red')
    expect(entries[0].missingChecks).toHaveLength(2)

    const md = renderNonGreenCompletions(entries)
    expect(md).toContain('## Objectives completed with a non-green PR')
    expect(md).toContain(`obj ${id}`)
    expect(md).toContain('https://github.com/EXAMPLE2/example3-platform/pull/679')
    expect(md).toContain('Why released:')
  })

  it('a green completion is NOT listed', async () => {
    const db = getDb()
    const obj = { id: insertObjective({}), pr_number: 679, pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/679' }
    await runCompletionGate(db, obj, {
      pathway: 'test',
      exec: execFor([checkRun(REQ[0], 'SUCCESS'), checkRun(REQ[1], 'SUCCESS'), checkRun('tsc', 'FAILURE')]),
    })
    expect(listNonGreenCompletions(db)).toHaveLength(0)
  })

  it('renders an explicit all-clear rather than an empty section', () => {
    expect(renderNonGreenCompletions([])).toContain('Every completed objective closed on a green')
  })
})
