// ── Canary harness proof (obj-2376, Rec #2) ─────────────────────────────────
// Proves, against the REAL DB schema and the REAL deterministic floor:
//   1. a (simulated) ESCAPE — a Tier-1 known-bad canary the gate fails to reject —
//      writes a gate_false_pass row with source='canary' (NULL objective_id) and
//      raises a critical alarm (an activity_log 'error' row);
//   2. a correctly-REJECTED canary (real tsc/node runner) writes NO false-pass row;
//   3. the human-reopen false-pass metric (getFalsePassRate) is UNAFFECTED by the
//      canary escape rows (it filters to source='reopen');
//   4. the SCHEDULED run is OFF by default and only enabled by the flag (+ kill switch).

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { CommandRunner } from './deterministic-floor.js'

const TMP_DB = path.join(os.tmpdir(), `cc-canary-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  runCanaryHarness,
  loadCanaries,
  getCanaryCatchRate,
  isCanaryHarnessEnabled,
  isCanaryHarnessKilled,
  isReviewEnforceEnabled,
} = await import('./canary-harness.js')
const { recordReopenFalsePass, getFalsePassRate } = await import('./false-pass.js')

// A runner that always reports a clean exit-0 → simulates the gate FAILING to
// reject a known-bad canary (an escape) without us having to break a fixture.
const escapeRunner: CommandRunner = (command, _cwd, _t) => ({
  command,
  exitCode: 0,
  output: '',
  durationMs: 1,
})

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM gate_false_pass')
  db.exec('DELETE FROM canary_runs')
  db.exec("DELETE FROM activity_log WHERE event_type = 'error'")
  db.exec('DELETE FROM objective_reviews')
  db.exec('DELETE FROM objectives')
  db.exec("DELETE FROM settings WHERE key IN ('canary_harness_enabled','canary_harness_killed')")
  delete process.env.CC_CANARY_HARNESS_ENABLED
  delete process.env.CC_CANARY_HARNESS_KILLED
})

afterAll(() => { try { fs.unlinkSync(TMP_DB) } catch {} })

describe('fixtures', () => {
  it('ships at least 3 Tier-1 canaries, each declaring expectedVerdict=reject', () => {
    const canaries = loadCanaries()
    const tier1 = canaries.filter(c => c.tier === 1)
    expect(tier1.length).toBeGreaterThanOrEqual(3)
    for (const c of tier1) expect(c.expectedVerdict).toBe('reject')
    // the three required broken kinds are present
    const kinds = new Set(canaries.map(c => c.brokenKind))
    expect(kinds.has('non-compiling')).toBe(true)
    expect(kinds.has('empty-stub')).toBe(true)
    expect(kinds.has('weakened-test')).toBe(true)
  })
})

describe('escape → sourced false-pass row + critical alarm', () => {
  it('writes a gate_false_pass row with source=canary and raises an alarm when a Tier-1 canary is NOT rejected', () => {
    const db = getDb()
    const summary = runCanaryHarness(db, { runner: escapeRunner, trigger: 'test' })

    // every known-bad canary escaped under the simulated-pass runner
    expect(summary.escaped).toBe(summary.total)
    expect(summary.escaped).toBeGreaterThanOrEqual(3)
    expect(summary.catchRate).toBe(0)

    const rows = db
      .prepare("SELECT * FROM gate_false_pass WHERE source = 'canary'")
      .all() as Array<{ source: string; canary_id: string | null; objective_id: number | null; review_id: number | null }>
    expect(rows.length).toBe(summary.total)
    for (const r of rows) {
      expect(r.source).toBe('canary')
      expect(r.canary_id).toBeTruthy()
      expect(r.objective_id).toBeNull() // no real objective backs a canary
      expect(r.review_id).toBeNull()
    }

    // a critical alarm per escape
    const alarms = db
      .prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'error' AND title LIKE 'Canary escape:%'")
      .get() as { n: number }
    expect(alarms.n).toBe(summary.total)

    // a canary_runs summary row was recorded
    const run = db.prepare('SELECT * FROM canary_runs ORDER BY id DESC LIMIT 1').get() as { escaped: number; catch_rate: number }
    expect(run.escaped).toBe(summary.total)
    expect(run.catch_rate).toBe(0)
  })
})

describe('correct rejection → no false-pass row', () => {
  it('writes NO gate_false_pass row when the real gate rejects the canaries', () => {
    const db = getDb()
    // real runner (tsc/node) — the fixtures genuinely fail to compile / fail checks
    const summary = runCanaryHarness(db, { trigger: 'test' })
    expect(summary.caught).toBeGreaterThanOrEqual(3)
    expect(summary.escaped).toBe(0)
    expect(summary.catchRate).toBe(1)

    const n = db.prepare("SELECT COUNT(*) AS n FROM gate_false_pass WHERE source = 'canary'").get() as { n: number }
    expect(n.n).toBe(0)
    const alarms = db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE event_type = 'error' AND title LIKE 'Canary escape:%'").get() as { n: number }
    expect(alarms.n).toBe(0)
  }, 60_000)

  // KL-4 (obj 2508): the layer-4 canary passes compile + the author's own unit test
  // (layers 1–3) yet is CAUGHT by the real floor via its state_delta_command. It must
  // be in the shipped set and the gate must NOT let it escape.
  it('the layer4-state-delta-noop canary ships and is CAUGHT by the real floor (layer 4)', () => {
    const db = getDb()
    expect(loadCanaries().some(c => c.id === 'layer4-state-delta-noop')).toBe(true)
    const summary = runCanaryHarness(db, { trigger: 'test', only: ['layer4-state-delta-noop'] })
    expect(summary.total).toBe(1)
    expect(summary.caught).toBe(1)
    expect(summary.escaped).toBe(0)
    const n = db.prepare("SELECT COUNT(*) AS n FROM gate_false_pass WHERE source = 'canary'").get() as { n: number }
    expect(n.n).toBe(0)
  }, 60_000)
})

describe('reopen metric is uncorrupted by canary rows', () => {
  it('getFalsePassRate counts only source=reopen rows', () => {
    const db = getDb()
    // a genuine human-reopen false pass for personal
    const objId = 1
    db.prepare("INSERT INTO objectives (id, title, agent_context, workspace, status) VALUES (?, 'o', 'cto', 'personal', 'done')").run(objId)
    db.prepare(
      "INSERT INTO objective_reviews (objective_id, iteration, reviewer_session_id, mode, verdict, created_at) VALUES (?, 1, 'r1', 'api', 'pass', datetime('now'))",
    ).run(objId)
    const reopenId = recordReopenFalsePass({ id: objId, workspace: 'personal', agent_context: 'cto' })
    expect(reopenId).not.toBeNull()

    const before = getFalsePassRate(30).find(r => r.workspace === 'personal')!
    expect(before.false_passes).toBe(1)

    // now flood with canary escapes (also bookkept under personal)
    runCanaryHarness(db, { runner: escapeRunner, trigger: 'test', workspace: 'personal' })

    const after = getFalsePassRate(30).find(r => r.workspace === 'personal')!
    expect(after.false_passes).toBe(1) // UNCHANGED — canary rows excluded

    // sanity: canary rows DID land, just under source='canary'
    const canaryN = db.prepare("SELECT COUNT(*) AS n FROM gate_false_pass WHERE source='canary'").get() as { n: number }
    expect(canaryN.n).toBeGreaterThanOrEqual(3)
  })
})

describe('scheduled run is OFF by default', () => {
  it('isCanaryHarnessEnabled defaults to false and is gated by the flag + kill switch', () => {
    const db = getDb()
    // default: no settings row, no env → OFF
    expect(isCanaryHarnessEnabled(db)).toBe(false)

    // arm via settings
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('canary_harness_enabled', '1')").run()
    expect(isCanaryHarnessEnabled(db)).toBe(true)

    // kill switch overrides (the scheduled wrapper gate is: killed || !enabled)
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('canary_harness_killed', '1')").run()
    expect(isCanaryHarnessKilled(db)).toBe(true)

    // simulate the scheduled gate decision
    const wouldRun = !isCanaryHarnessKilled(db) && isCanaryHarnessEnabled(db)
    expect(wouldRun).toBe(false)
  })

  it('catch-rate metric reflects the latest run', () => {
    const db = getDb()
    expect(getCanaryCatchRate(30).runs).toBe(0)
    runCanaryHarness(db, { runner: escapeRunner, trigger: 'test' })
    const m = getCanaryCatchRate(30)
    expect(m.runs).toBe(1)
    expect(m.latestCatchRate).toBe(0)
    expect(m.escapes).toBeGreaterThanOrEqual(3)
  })
})

// ── Stage-C review enforcement (obj 700316; kitchen_loop_review_enforce) ────────
describe('kitchen_loop_review_enforce — escape becomes a hard block, log-only by default', () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM settings WHERE key = 'kitchen_loop_review_enforce'")
    delete process.env.CC_KITCHEN_LOOP_REVIEW_ENFORCE
  })

  it('flag OFF by default; reads settings + env', () => {
    const db = getDb()
    expect(isReviewEnforceEnabled(db, {})).toBe(false)
    db.prepare("INSERT INTO settings (key, value) VALUES ('kitchen_loop_review_enforce', '1')").run()
    expect(isReviewEnforceEnabled(db, {})).toBe(true)
    db.exec("DELETE FROM settings WHERE key = 'kitchen_loop_review_enforce'")
    expect(isReviewEnforceEnabled(db, { CC_KITCHEN_LOOP_REVIEW_ENFORCE: 'on' })).toBe(true)
  })

  it('[review-enforce-off-logonly] flag OFF → escape is log-only (enforcing=false, blocked=false)', () => {
    const db = getDb()
    const summary = runCanaryHarness(db, { runner: escapeRunner, trigger: 'test' })
    expect(summary.escaped).toBeGreaterThanOrEqual(3)
    expect(summary.enforcing).toBe(false)
    expect(summary.blocked).toBe(false) // escape still only raises an alarm — current behaviour
  })

  it('[review-enforce-on-cc-only] flag ON + escape → blocked=true (would-block turned real)', () => {
    const db = getDb()
    db.prepare("INSERT INTO settings (key, value) VALUES ('kitchen_loop_review_enforce', '1')").run()
    const summary = runCanaryHarness(db, { runner: escapeRunner, trigger: 'test' })
    expect(summary.enforcing).toBe(true)
    expect(summary.escaped).toBeGreaterThanOrEqual(3)
    expect(summary.blocked).toBe(true)
  })

  it('enforcing but ZERO escapes (gate works) → NOT blocked', () => {
    const db = getDb()
    const summary = runCanaryHarness(db, { trigger: 'test', enforce: true }) // real runner rejects known-bad
    expect(summary.enforcing).toBe(true)
    expect(summary.escaped).toBe(0)
    expect(summary.blocked).toBe(false)
  })
})
