// ── Kitchen Loop Phase-0 SHADOW proof (obj 700099) ──────────────────────────
// Proves, against the REAL DB schema (run by the real initDb):
//   0. the additive migration creates kitchen_loop_runs + loop_drift_metrics and
//      seeds kitchen_loop_enabled + kitchen_loop_killed OFF — no existing table touched.
//   1. flags are OFF by default; startKitchenLoop() is a complete no-op while OFF
//      (no kitchen_loop_runs row is ever written by boot).
//   2. nextPhase cycles the six phases and holds on paused/monitor_only.
//   3. computeIdeateTickets returns the P0 seed for command-center, [] otherwise.
//   4. evaluatePauseGates is pure threshold logic.
//   5. a SHADOW tick at the ideate phase LOGS the would-be tickets and writes ZERO
//      objectives (board untouched).
//   6. a SHADOW tick at the regress phase runs the oracle READ-ONLY, writes exactly
//      one loop_drift_metrics snapshot, and LOGS all three pause gates (no action).
//   7. buildDriftSnapshot increments consecutive_red on a RED oracle, resets on GREEN.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-kitchen-loop-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// Ensure no ambient env flag flips the loop on during the test.
delete process.env.CC_KITCHEN_LOOP_ENABLED
delete process.env.CC_KITCHEN_LOOP_KILLED

const { initDb, getDb } = await import('../db/index.js')
const kl = await import('./kitchen-loop.js')
type BoardEmitItem = import('./kitchen-loop.js').BoardEmitItem

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  kl.stopKitchenLoop()
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix) } catch { /* ignore */ }
  }
})

describe('obj 700099 — kitchen-loop migration', () => {
  it('creates kitchen_loop_runs with the W2 columns', () => {
    const cols = (getDb().prepare('PRAGMA table_info(kitchen_loop_runs)').all() as { name: string }[]).map((c) => c.name)
    for (const c of ['scope', 'iteration', 'phase', 'mode', 'started_at', 'ended_at', 'detail']) {
      expect(cols).toContain(c)
    }
  })

  it('creates loop_drift_metrics with the W2 rollup columns', () => {
    const cols = (getDb().prepare('PRAGMA table_info(loop_drift_metrics)').all() as { name: string }[]).map((c) => c.name)
    for (const c of [
      'scope', 'iteration', 'captured_at', 'test_count', 'pass_rate', 'oracle_pass_rate',
      'bug_discovery_rate', 'blocked_combos', 'canary_catch_rate', 'canary_escape_rate',
      'false_pass_rate', 'coverage_filled', 'coverage_total', 'consecutive_red',
    ]) {
      expect(cols).toContain(c)
    }
  })

  it('seeds both flags OFF by default', () => {
    const get = (k: string) => (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value?: string } | undefined)?.value
    expect(get('kitchen_loop_enabled')).toBe('0')
    expect(get('kitchen_loop_killed')).toBe('0')
  })
})

describe('flags + scheduler no-op while OFF', () => {
  it('isKitchenLoopEnabled is false by default; killed is false', () => {
    const db = getDb()
    expect(kl.isKitchenLoopEnabled(db, {})).toBe(false)
    expect(kl.isKitchenLoopKilled(db, {})).toBe(false)
  })

  it('startKitchenLoop() with the flag OFF writes NO kitchen_loop_runs rows (complete no-op)', () => {
    const db = getDb()
    const before = (db.prepare('SELECT COUNT(*) n FROM kitchen_loop_runs').get() as { n: number }).n
    kl.startKitchenLoop(db)
    kl.stopKitchenLoop()
    const after = (db.prepare('SELECT COUNT(*) n FROM kitchen_loop_runs').get() as { n: number }).n
    expect(after).toBe(before)
  })

  it('env flag overrides settings for enabled/killed', () => {
    const db = getDb()
    expect(kl.isKitchenLoopEnabled(db, { CC_KITCHEN_LOOP_ENABLED: '1' })).toBe(true)
    expect(kl.isKitchenLoopKilled(db, { CC_KITCHEN_LOOP_KILLED: 'yes' })).toBe(true)
  })
})

describe('pure phase machine', () => {
  it('cycles the six phases and rolls regress → backlog', () => {
    expect(kl.nextPhase('backlog')).toBe('ideate')
    expect(kl.nextPhase('ideate')).toBe('triage')
    expect(kl.nextPhase('triage')).toBe('execute')
    expect(kl.nextPhase('execute')).toBe('polish')
    expect(kl.nextPhase('polish')).toBe('regress')
    expect(kl.nextPhase('regress')).toBe('backlog')
  })
  it('holds on paused / monitor_only', () => {
    expect(kl.nextPhase('paused')).toBe('paused')
    expect(kl.nextPhase('monitor_only')).toBe('monitor_only')
  })
})

describe('computeIdeateTickets', () => {
  it('returns the P0 seed for the command-center scope', () => {
    const t = kl.computeIdeateTickets(kl.DEFAULT_SCOPE)
    expect(t.length).toBeGreaterThan(0)
    expect(t.every((x) => x.priority === 'P0')).toBe(true)
  })
  it('returns [] for any other scope (shadow does not ideate non-pilot scopes)', () => {
    expect(kl.computeIdeateTickets('example-project')).toEqual([])
  })
})

describe('evaluatePauseGates (pure)', () => {
  it('trips G1 at the regression threshold, not below', () => {
    expect(kl.evaluatePauseGates({ consecutiveRed: 2, openWip: 0, consecutiveZeroMerged: 0 }).g1Regression.tripped).toBe(false)
    expect(kl.evaluatePauseGates({ consecutiveRed: 3, openWip: 0, consecutiveZeroMerged: 0 }).g1Regression.tripped).toBe(true)
  })
  it('trips G2 at the WIP ceiling and G3 at the starvation threshold', () => {
    const d = kl.evaluatePauseGates({ consecutiveRed: 0, openWip: 12, consecutiveZeroMerged: 3 })
    expect(d.g2Backpressure.tripped).toBe(true)
    expect(d.g3Starvation.tripped).toBe(true)
  })
})

describe('buildDriftSnapshot consecutive_red tracking', () => {
  it('increments consecutive_red on RED, resets on GREEN', () => {
    const db = getDb()
    const red = { verdict: 'RED (regressed)', counts: { pass: 4, warn: 0, fail: 1 } }
    const green = { verdict: 'GREEN (at-least-as-good)', counts: { pass: 5, warn: 0, fail: 0 } }
    expect(kl.buildDriftSnapshot(db, 's', 1, red, 2).consecutive_red).toBe(3)
    expect(kl.buildDriftSnapshot(db, 's', 2, green, 5).consecutive_red).toBe(0)
    // oracle_pass_rate is the GREEN/total ratio
    expect(kl.buildDriftSnapshot(db, 's', 3, green, 0).oracle_pass_rate).toBeCloseTo(1.0)
  })
})

describe('SHADOW tick — ideate dry-run writes NO objectives', () => {
  it('logs the would-be tickets and creates zero objectives', async () => {
    const db = getDb()
    // Seed a run sitting at backlog so the next tick advances to ideate.
    db.prepare(
      "INSERT INTO kitchen_loop_runs (scope, iteration, phase, mode) VALUES (?, 1, 'backlog', 'shadow')",
    ).run(kl.DEFAULT_SCOPE)
    const objBefore = (db.prepare('SELECT COUNT(*) n FROM objectives').get() as { n: number }).n
    const logs: string[] = []
    let emitCalled = 0
    await kl.tickKitchenLoop(db, {
      runOracle: () => null,
      log: (m) => logs.push(m),
      emitToBoard: async () => { emitCalled++; return [] },
    })
    const objAfter = (db.prepare('SELECT COUNT(*) n FROM objectives').get() as { n: number }).n
    // No board write whatsoever — emitter is never even called while the flag is OFF.
    expect(objAfter).toBe(objBefore)
    expect(emitCalled).toBe(0)
    // The new run row is at ideate, recorded as shadow, and logged the dry-run.
    const last = db.prepare("SELECT phase, mode, detail FROM kitchen_loop_runs WHERE scope=? ORDER BY id DESC LIMIT 1").get(kl.DEFAULT_SCOPE) as { phase: string; mode: string; detail: string }
    expect(last.phase).toBe('ideate')
    expect(last.mode).toBe('shadow')
    expect(logs.some((m) => m.includes('WOULD POST') && m.includes('wrote NONE'))).toBe(true)
    expect(JSON.parse(last.detail).would_post).toBeGreaterThan(0)
    expect(JSON.parse(last.detail).emitted_ids).toBeUndefined()
  })
})

describe('SHADOW tick — regress writes a drift snapshot + logs gates only', () => {
  it('runs the oracle read-only, writes exactly one loop_drift_metrics row, logs all 3 gates', async () => {
    const db = getDb()
    const scope = 'regress-proof'
    // Seed a run at polish so the next tick advances to regress.
    db.prepare(
      "INSERT INTO kitchen_loop_runs (scope, iteration, phase, mode) VALUES (?, 7, 'polish', 'shadow')",
    ).run(scope)
    const driftBefore = (db.prepare('SELECT COUNT(*) n FROM loop_drift_metrics WHERE scope=?').get(scope) as { n: number }).n
    const logs: string[] = []
    let oracleCalled = 0
    await kl.tickKitchenLoop(db, {
      scope,
      runOracle: () => { oracleCalled++; return { verdict: 'GREEN (at-least-as-good)', counts: { pass: 5, warn: 0, fail: 0 } } },
      log: (m) => logs.push(m),
    })
    const driftAfter = (db.prepare('SELECT COUNT(*) n FROM loop_drift_metrics WHERE scope=?').get(scope) as { n: number }).n
    expect(oracleCalled).toBe(1)
    expect(driftAfter).toBe(driftBefore + 1)
    // All three gates were evaluated + logged (no action — "no action taken in shadow").
    expect(logs.filter((m) => m.includes('SHADOW gate')).length).toBe(3)
    expect(logs.some((m) => m.includes('no action taken in shadow'))).toBe(true)
    // The advanced row is at regress and recorded shadow.
    const last = db.prepare('SELECT phase, mode FROM kitchen_loop_runs WHERE scope=? ORDER BY id DESC LIMIT 1').get(scope) as { phase: string; mode: string }
    expect(last.phase).toBe('regress')
    expect(last.mode).toBe('shadow')
  })
})

// ── Stage-C live-execution layer (obj 700315) ──────────────────────────────────

function setSetting(key: string, value: string) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

describe('Stage-C flag seeds default OFF', () => {
  it('seeds all five Stage-C flags (ideate_live/gates_enforce/oracle_gate/review_enforce OFF, wip_cap=8)', () => {
    const get = (k: string) => (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value?: string } | undefined)?.value
    expect(get('kitchen_loop_ideate_live')).toBe('0')
    expect(get('kitchen_loop_gates_enforce')).toBe('0')
    expect(get('kitchen_loop_oracle_gate')).toBe('0')
    expect(get('kitchen_loop_review_enforce')).toBe('0')
    expect(get('kitchen_loop_wip_cap')).toBe('8')
  })

  it('flag readers are false by default; env overrides settings', () => {
    const db = getDb()
    expect(kl.isIdeateLiveEnabled(db, {})).toBe(false)
    expect(kl.isGatesEnforceEnabled(db, {})).toBe(false)
    expect(kl.isIdeateLiveEnabled(db, { CC_KITCHEN_LOOP_IDEATE_LIVE: '1' })).toBe(true)
    expect(kl.isGatesEnforceEnabled(db, { CC_KITCHEN_LOOP_GATES_ENFORCE: 'yes' })).toBe(true)
    expect(kl.getWipCap(db)).toBe(8)
  })
})

describe('Stage-C ideate LIVE-EMIT (kitchen_loop_ideate_live)', () => {
  afterEach(() => {
    setSetting('kitchen_loop_ideate_live', '0')
    setSetting('kitchen_loop_wip_cap', '8')
    // Drop any objectives a test manually inserted to control the WIP/dedup window.
    getDb().prepare("DELETE FROM objectives WHERE category = 'kl-stage-c-test'").run()
  })

  it('OFF ⇒ byte-for-byte shadow: never calls the emitter, writes no board rows, mode=shadow', async () => {
    const db = getDb()
    setSetting('kitchen_loop_ideate_live', '0')
    db.prepare("INSERT INTO kitchen_loop_runs (scope, iteration, phase, mode) VALUES (?, 11, 'backlog', 'shadow')").run('cw1-off')
    let emitCalled = 0
    await kl.tickKitchenLoop(db, { scope: 'cw1-off', runOracle: () => null, log: () => {}, emitToBoard: async () => { emitCalled++; return [] } })
    expect(emitCalled).toBe(0)
    const last = db.prepare('SELECT phase, mode, detail FROM kitchen_loop_runs WHERE scope=? ORDER BY id DESC LIMIT 1').get('cw1-off') as { phase: string; mode: string; detail: string }
    // cw1-off is not the pilot scope, so computeIdeateTickets is [] anyway, but the
    // point is: flag OFF ⇒ shadow path, no emit.
    expect(last.mode).toBe('shadow')
  })

  it('ON ⇒ emits EXACTLY the computed command-center tickets, scoped + human-gated, ids recorded', async () => {
    const db = getDb()
    setSetting('kitchen_loop_ideate_live', '1')
    setSetting('kitchen_loop_wip_cap', '1000') // well above any open count
    db.prepare("INSERT INTO kitchen_loop_runs (scope, iteration, phase, mode) VALUES (?, 1, 'backlog', 'shadow')").run(kl.DEFAULT_SCOPE)
    let captured: BoardEmitItem[] | null = null
    await kl.tickKitchenLoop(db, {
      scope: kl.DEFAULT_SCOPE,
      runOracle: () => null,
      log: () => {},
      emitToBoard: async (items) => { captured = items; return items.map((_, i) => 9000 + i) },
    })
    const expected = kl.computeIdeateTickets(kl.DEFAULT_SCOPE)
    expect(captured).not.toBeNull()
    // Exactly the computed tickets, in order.
    expect(captured!.map((i) => i.title)).toEqual(expected.map((t) => t.title))
    // SCOPE pin: every emitted item targets the command-center pilot, no other workspace.
    expect(captured!.every((i) => i.project === kl.PILOT_PROJECT)).toBe(true)
    expect(captured!.every((i) => i.workspace === kl.PILOT_WORKSPACE)).toBe(true)
    // Human gate: the payload sets NO status ⇒ inherits the board default 'queue'
    // (non-auto-starting). Proven structurally here; DB default proven below.
    expect(captured!.every((i) => !('status' in i))).toBe(true)
    const last = db.prepare('SELECT phase, mode, detail FROM kitchen_loop_runs WHERE scope=? ORDER BY id DESC LIMIT 1').get(kl.DEFAULT_SCOPE) as { phase: string; mode: string; detail: string }
    expect(last.phase).toBe('ideate')
    expect(last.mode).toBe('live')
    expect(JSON.parse(last.detail).emitted_ids).toEqual(expected.map((_, i) => 9000 + i))
  })

  it('Stage-0 human gate: a board row created with the emit payload defaults to queue (no auto-spawn)', () => {
    const db = getDb()
    // Insert exactly the columns ticketToBoardItem supplies — no status — and prove
    // the DB default lands it in queue with no session, i.e. nothing auto-spawns.
    const item = kl.ticketToBoardItem(kl.computeIdeateTickets(kl.DEFAULT_SCOPE)[0])
    const r = db.prepare(
      "INSERT INTO objectives (title, description, project, workspace, category) VALUES (?,?,?,?,'kl-stage-c-test')",
    ).run(item.title + ' [gate-probe]', item.description, item.project, item.workspace)
    const row = db.prepare('SELECT status, session_id FROM objectives WHERE id = ?').get(r.lastInsertRowid) as { status: string; session_id: string | null }
    expect(row.status).toBe('queue')
    expect(row.session_id).toBeNull()
  })

  it('WIP ceiling ⇒ emits NOTHING when open objectives ≥ kitchen_loop_wip_cap', async () => {
    const db = getDb()
    setSetting('kitchen_loop_ideate_live', '1')
    // Guarantee at least one open objective, then pin the cap to the live open count
    // so openWip ≥ cap trips the ceiling deterministically regardless of other rows.
    db.prepare("INSERT INTO objectives (title, project, category) VALUES ('wip-filler', ?, 'kl-stage-c-test')").run(kl.PILOT_PROJECT)
    setSetting('kitchen_loop_wip_cap', String(kl.countOpenObjectives(db)))
    db.prepare("INSERT INTO kitchen_loop_runs (scope, iteration, phase, mode) VALUES (?, 1, 'backlog', 'shadow')").run(kl.DEFAULT_SCOPE)
    let emitCalled = 0
    await kl.tickKitchenLoop(db, {
      scope: kl.DEFAULT_SCOPE,
      runOracle: () => null,
      log: () => {},
      emitToBoard: async () => { emitCalled++; return [] },
    })
    expect(emitCalled).toBe(0)
    const last = db.prepare('SELECT detail FROM kitchen_loop_runs WHERE scope=? ORDER BY id DESC LIMIT 1').get(kl.DEFAULT_SCOPE) as { detail: string }
    const d = JSON.parse(last.detail)
    expect(d.emit_skipped).toBe('wip_ceiling')
    expect(d.emitted_ids).toEqual([])
  })

  it('SCOPE pin ⇒ never emits for a non-command-center scope even with the flag ON', async () => {
    const db = getDb()
    setSetting('kitchen_loop_ideate_live', '1')
    setSetting('kitchen_loop_wip_cap', '1000')
    db.prepare("INSERT INTO kitchen_loop_runs (scope, iteration, phase, mode) VALUES (?, 1, 'backlog', 'shadow')").run('example-project')
    let emitCalled = 0
    await kl.tickKitchenLoop(db, {
      scope: 'example-project',
      runOracle: () => null,
      log: () => {},
      emitToBoard: async () => { emitCalled++; return [] },
    })
    expect(emitCalled).toBe(0)
    const last = db.prepare('SELECT mode FROM kitchen_loop_runs WHERE scope=? ORDER BY id DESC LIMIT 1').get('example-project') as { mode: string }
    expect(last.mode).toBe('shadow')
  })

  it('DEDUP ⇒ skips any ticket whose title is already open on the board', async () => {
    const db = getDb()
    setSetting('kitchen_loop_ideate_live', '1')
    setSetting('kitchen_loop_wip_cap', '1000')
    const expected = kl.computeIdeateTickets(kl.DEFAULT_SCOPE)
    // Pre-seed an OPEN objective whose title matches the first computed ticket.
    db.prepare("INSERT INTO objectives (title, status, project, category) VALUES (?, 'queue', ?, 'kl-stage-c-test')").run(expected[0].title, kl.PILOT_PROJECT)
    db.prepare("INSERT INTO kitchen_loop_runs (scope, iteration, phase, mode) VALUES (?, 1, 'backlog', 'shadow')").run(kl.DEFAULT_SCOPE)
    let captured: BoardEmitItem[] | null = null
    await kl.tickKitchenLoop(db, {
      scope: kl.DEFAULT_SCOPE,
      runOracle: () => null,
      log: () => {},
      emitToBoard: async (items) => { captured = items; return items.map((_, i) => i) },
    })
    expect(captured!.map((i) => i.title)).toEqual(expected.slice(1).map((t) => t.title))
    const last = db.prepare('SELECT detail FROM kitchen_loop_runs WHERE scope=? ORDER BY id DESC LIMIT 1').get(kl.DEFAULT_SCOPE) as { detail: string }
    expect(JSON.parse(last.detail).deduped).toBe(1)
  })
})

describe('Stage-C pause-gate ENFORCEMENT (kitchen_loop_gates_enforce)', () => {
  afterEach(() => setSetting('kitchen_loop_gates_enforce', '0'))

  it('OFF ⇒ a would-trip gate only logs; phase stays regress (shadow)', async () => {
    const db = getDb()
    setSetting('kitchen_loop_gates_enforce', '0')
    const scope = 'enforce-off'
    db.prepare("INSERT INTO kitchen_loop_runs (scope, iteration, phase, mode) VALUES (?, 1, 'polish', 'shadow')").run(scope)
    // Force G1 to want to trip: prior consecutive_red=2 + RED oracle ⇒ 3 ≥ threshold.
    db.prepare("INSERT INTO loop_drift_metrics (scope, iteration, consecutive_red) VALUES (?, 0, 2)").run(scope)
    const logs: string[] = []
    await kl.tickKitchenLoop(db, {
      scope,
      runOracle: () => ({ verdict: 'RED (regressed)', counts: { pass: 1, warn: 0, fail: 4 } }),
      log: (m) => logs.push(m),
    })
    const last = db.prepare('SELECT phase, mode, detail FROM kitchen_loop_runs WHERE scope=? ORDER BY id DESC LIMIT 1').get(scope) as { phase: string; mode: string; detail: string }
    expect(last.phase).toBe('regress') // NOT paused while OFF
    expect(last.mode).toBe('shadow')
    expect(JSON.parse(last.detail).paused).toBeUndefined()
    expect(logs.some((m) => m.includes('WOULD-TRIP') && m.includes('no action taken in shadow'))).toBe(true)
  })

  it('ON ⇒ a tripped gate sets the loop phase to paused and records the reason', async () => {
    const db = getDb()
    setSetting('kitchen_loop_gates_enforce', '1')
    const scope = 'enforce-on'
    db.prepare("INSERT INTO kitchen_loop_runs (scope, iteration, phase, mode) VALUES (?, 1, 'polish', 'shadow')").run(scope)
    db.prepare("INSERT INTO loop_drift_metrics (scope, iteration, consecutive_red) VALUES (?, 0, 2)").run(scope)
    const logs: string[] = []
    await kl.tickKitchenLoop(db, {
      scope,
      runOracle: () => ({ verdict: 'RED (regressed)', counts: { pass: 1, warn: 0, fail: 4 } }),
      log: (m) => logs.push(m),
    })
    const last = db.prepare('SELECT phase, mode, detail FROM kitchen_loop_runs WHERE scope=? ORDER BY id DESC LIMIT 1').get(scope) as { phase: string; mode: string; detail: string }
    expect(last.phase).toBe('paused')
    expect(last.mode).toBe('live')
    const d = JSON.parse(last.detail)
    expect(d.paused).toBe(true)
    expect(Array.isArray(d.pause_reasons)).toBe(true)
    expect(d.pause_reasons.some((r: { gate: string }) => r.gate === 'g1Regression')).toBe(true)
    expect(logs.some((m) => m.includes('PAUSING loop') || m.includes('loop PAUSED'))).toBe(true)
    // A subsequent tick HOLDS — paused is a terminal hold until re-armed.
    const logs2: string[] = []
    await kl.tickKitchenLoop(db, { scope, runOracle: () => null, log: (m) => logs2.push(m) })
    expect(logs2.some((m) => m.includes("held in 'paused'"))).toBe(true)
  })
})
