/**
 * The SCHEDULED tick's arming matrix (obj 704734).
 *
 * The watchdog has two entry points and only one of them was ever configurable:
 *
 *   - the read-only route, which passes an explicit `dryRun: true`;
 *   - the 10-minute scheduled tick, which called `buildDefaultDeps(db, undefined)` and
 *     therefore ran with `dryRun: undefined`.
 *
 * `undefined` was the worst of both worlds. `sweepHealth` publishes
 * `dryRun: deps.dryRun !== false`, so the REPORT said "dry-run"; `runWatchdogOnce`
 * computed `armed = enabled && deps.dryRun !== true`, so the SWEEP was live. Flipping
 * pr_health_watchdog_enabled='1' went straight to acting on real PRs, while the surface
 * Operator reads insisted it was only observing. There was no runtime lever either way.
 *
 * These tests pin the fixed contract: the act-path is reached ONLY with
 * enabled='1' AND dry_run='0'. Every dep is injected via WatchdogDeps — `exec` is a fake
 * that answers `gh pr list` from an in-memory fixture — so nothing here reaches GitHub,
 * posts a status, or spawns a process.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-prhealth-arming-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const W = await import('./pr-health-watchdog.js')
type PrSummary = import('./pr-health-watchdog.js').PrSummary
type WatchdogDeps = import('./pr-health-watchdog.js').WatchdogDeps

const REPO = 'EXAMPLE2/example3-platform'
const ENV = { PR_HEALTH_WATCHDOG_REPOS: REPO }

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
  db.exec("DELETE FROM settings WHERE key LIKE 'pr_health_watchdog%'")
  delete process.env.PR_HEALTH_WATCHDOG_ENABLED
  delete process.env.PR_HEALTH_WATCHDOG_DRY_RUN
})

function setting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

/** An unowned PR with a long-red non-harness check → decides `escalate`, an act-path action. */
function redPr(number = 5501): PrSummary {
  return {
    number,
    title: `arming-matrix pr ${number}`,
    isDraft: false,
    headRefOid: `sha${number}`.padEnd(40, '0'),
    headRefName: `branch-${number}`,
    createdAt: '2026-07-01T00:00:00Z',
    author: { login: 'app/dependabot', is_bot: true },
    statusCheckRollup: [
      {
        __typename: 'CheckRun',
        name: 'Vitest Suite',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        completedAt: '2026-07-01T00:00:00Z',
        detailsUrl: 'https://github.com/EXAMPLE2/example3-platform/actions/runs/1/job/2',
        workflowName: 'Vitest Suite',
      },
    ],
  } as PrSummary
}

/** Fake `gh`. Answers `pr list` from the fixture; records every other invocation so a
 *  test can assert that NOTHING was written to GitHub. */
function makeExec(prs: PrSummary[]): { exec: WatchdogDeps['exec']; calls: string[][] } {
  const calls: string[][] = []
  const exec: WatchdogDeps['exec'] = async (_file, args) => {
    calls.push(args)
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs)
    return ''
  }
  return { exec, calls }
}

/**
 * The SCHEDULED tick's exact wiring: buildDefaultDeps with NO dryRun override, which is
 * what `tickOnce(undefined)` does. Only `exec`/`notify` are swapped afterwards, so the
 * dryRun value under test is the one the real scheduler would run with.
 */
async function scheduledDeps(
  prs: PrSummary[],
): Promise<{ deps: WatchdogDeps; calls: string[][]; notified: unknown[] }> {
  const { exec, calls } = makeExec(prs)
  const notified: unknown[] = []
  const built = await W.buildDefaultDeps(getDb())
  const deps: WatchdogDeps = {
    ...built,
    exec,
    notify: a => { notified.push(a) },
    sendFollowUp: () => 'not-sent',
    env: ENV,
  }
  return { deps, calls, notified }
}

/** Did the sweep actually DO anything? Three independent witnesses, so a partial
 *  regression cannot hide behind one of them. */
function actedEvidence(report: import('./pr-health-watchdog.js').SweepResult, notified: unknown[]) {
  return {
    wouldOnly: report.prs.every(p => p.wouldOnly),
    notifications: notified.length,
    claimRows: (getDb()
      .prepare("SELECT COUNT(*) n FROM external_check_remediations WHERE check_name LIKE 'watchdog:%'")
      .get() as { n: number }).n,
  }
}

// ── 1. The defect itself ────────────────────────────────────────────────────────

describe('the scheduled tick resolves dry-run at runtime', () => {
  it('RED against origin/main: buildDefaultDeps left dryRun undefined', async () => {
    // On unmodified main this is `undefined` — neither dry (the report claimed dry) nor
    // deliberate (nobody could set it). It must now be an explicit boolean.
    const built = await W.buildDefaultDeps(getDb())
    expect(typeof built.dryRun).toBe('boolean')
  })

  it('defaults to DRY-RUN with the setting absent — fail-safe, not fail-open', async () => {
    expect(W.watchdogDryRun(getDb(), {})).toBe(true)
    expect((await W.buildDefaultDeps(getDb())).dryRun).toBe(true)
  })

  it("dry_run='0' un-dries the scheduled tick with no code change and no restart", async () => {
    setting('pr_health_watchdog_dry_run', '0')
    expect(W.watchdogDryRun(getDb(), {})).toBe(false)
    expect((await W.buildDefaultDeps(getDb())).dryRun).toBe(false)
    // …and back again, at call time.
    setting('pr_health_watchdog_dry_run', '1')
    expect(W.watchdogDryRun(getDb(), {})).toBe(true)
  })

  it('an env var can only ever make it SAFER, never arm it', () => {
    setting('pr_health_watchdog_dry_run', '0')
    expect(W.watchdogDryRun(getDb(), { PR_HEALTH_WATCHDOG_DRY_RUN: 'true' })).toBe(true)
  })

  it('tolerates a DB that cannot be queried, by staying dry', () => {
    expect(W.watchdogDryRun(null, {})).toBe(true)
    expect(W.watchdogDryRun({} as never, {})).toBe(true)
  })

  it('the read-only route still wins: an explicit dryRun override is never overwritten', async () => {
    setting('pr_health_watchdog_dry_run', '0') // settings say ACT…
    const built = await W.buildDefaultDeps(getDb(), { dryRun: true }) // …route says no.
    expect(built.dryRun).toBe(true)
  })

  it('the report no longer contradicts the sweep it describes', async () => {
    // RED against origin/main: with dryRun undefined, report.dryRun was `true` while
    // `armed` was `enabled && dryRun !== true` → live. The surface lied.
    setting('pr_health_watchdog_enabled', '1')
    const { deps, notified } = await scheduledDeps([redPr()])
    const report = await W.runWatchdogOnce(deps)
    const evidence = actedEvidence(report, notified)
    expect(report.dryRun).toBe(true)
    expect(evidence.wouldOnly).toBe(true) // report said dry-run; sweep WAS dry-run
  })
})

// ── 2. The arming matrix ────────────────────────────────────────────────────────

describe('act-path arming matrix — both locks, or nothing', () => {
  const CASES: {
    name: string
    enabled: string | null
    dryRun: string | null
    expectArmed: boolean
  }[] = [
    { name: 'unset / unset — fully dark', enabled: null, dryRun: null, expectArmed: false },
    { name: "enabled='1' / dry_run unset — observes only", enabled: '1', dryRun: null, expectArmed: false },
    { name: "enabled='1' / dry_run='1' — observes only", enabled: '1', dryRun: '1', expectArmed: false },
    { name: "disabled / dry_run='0' — observes only", enabled: null, dryRun: '0', expectArmed: false },
    { name: "enabled='0' / dry_run='0' — observes only", enabled: '0', dryRun: '0', expectArmed: false },
    { name: "enabled='1' / dry_run='0' — ARMED", enabled: '1', dryRun: '0', expectArmed: true },
  ]

  for (const c of CASES) {
    it(c.name, async () => {
      if (c.enabled !== null) setting('pr_health_watchdog_enabled', c.enabled)
      if (c.dryRun !== null) setting('pr_health_watchdog_dry_run', c.dryRun)

      const { deps, calls, notified } = await scheduledDeps([redPr()])
      const report = await W.runWatchdogOnce(deps)

      // The DECISION is identical in every cell — a dry-run is a truthful preview of the
      // armed run, not a different code path. Only the execution differs.
      expect(report.prs.map(p => p.action)).toEqual(['escalate'])

      const evidence = actedEvidence(report, notified)
      if (c.expectArmed) {
        expect(evidence).toEqual({ wouldOnly: false, notifications: 1, claimRows: 1 })
      } else {
        expect(evidence).toEqual({ wouldOnly: true, notifications: 0, claimRows: 0 })
      }
      // Read-only either way: the only `gh` invocation permitted is `pr list`.
      expect(calls.filter(a => !(a[0] === 'pr' && a[1] === 'list'))).toEqual([])
    })
  }

  it('with both settings unset the tick is inert before it even shells out', async () => {
    // The cheap gate in tickOnce is `isWatchdogEnabled`; prove it is still false-by-default
    // so a default-dark deployment never spends a `gh` call.
    expect(W.isWatchdogEnabled(getDb(), {})).toBe(false)
    expect(W.watchdogDryRun(getDb(), {})).toBe(true)
  })
})
