// ── Outcome verification — generalized state-delta floor for NON-CODE objectives ──
// (obj 700028). Covers: flag default-OFF byte-identical no-op, kill switch, the
// per-objective/category/type opt-in precedence + fail-safe-open on a malformed
// row, the evaluateOutcomeGate decision (block ONLY on a clean non-zero exit), and
// the `source='outcome'` recording discriminator that keeps code-floor metrics
// uncorrupted.
import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  isOutcomeVerificationEnabled,
  isOutcomeVerificationKilled,
  hasOutcomeOptIn,
  isOutcomeVerificationActiveForObjective,
  getOutcomeAssertion,
  evaluateOutcomeGate,
  recordOutcomeRunRow,
  recordFloorRunRow,
  runFloor,
  buildOutcomeFailFollowUp,
  type OutcomeObjectiveRef,
  type OutcomeAssertionConfig,
  type CommandRunner,
  type FloorCommandResult,
  type FloorConfig,
  type FloorRunResult,
} from './deterministic-floor.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}
function setSetting(db: Database.Database, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}
const OBJ = (over: Partial<OutcomeObjectiveRef> = {}): OutcomeObjectiveRef => ({
  id: 1234,
  project: null,
  workspace: 'operator',
  session_id: null,
  type: 'task',
  category: 'general',
  ...over,
})
// Fake runner keyed by command; runFloor will invoke it for the synthesized layer-4 step.
function fakeRunner(map: Record<string, Partial<FloorCommandResult>>): CommandRunner {
  return (command) => ({ command, exitCode: 0, output: '', durationMs: 1, ...(map[command] || {}) })
}

// ── 1. Flag default OFF → byte-identical no-op (the headline safety property) ──
describe('flag default OFF → byte-identical no-op', () => {
  it('with no env, no settings, and NO opt-in row → INACTIVE for every objective', () => {
    const db = freshDb()
    expect(isOutcomeVerificationEnabled(db, {})).toBe(false)
    // This is the real prod state: zero outcome_assertion rows exist → no check runs.
    expect(isOutcomeVerificationActiveForObjective(db, OBJ(), {})).toBe(false)
  })

  it('the new gate is never entered when inactive (record/run thunks untouched)', () => {
    const db = freshDb()
    // Simulate the call-site guard: the gate only runs when active.
    const run = vi.fn()
    const record = vi.fn()
    if (isOutcomeVerificationActiveForObjective(db, OBJ(), {})) {
      evaluateOutcomeGate({
        getConfig: () => getOutcomeAssertion(db, OBJ()),
        resolveFallbackCwd: () => '/tmp',
        run,
        record,
        logMilestone: () => {},
      })
    }
    expect(run).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('settings flag 0 stays OFF; flag 1 / env on flips ON', () => {
    const db = freshDb()
    setSetting(db, 'outcome_verification_enabled', '0')
    expect(isOutcomeVerificationEnabled(db, {})).toBe(false)
    setSetting(db, 'outcome_verification_enabled', '1')
    expect(isOutcomeVerificationEnabled(db, {})).toBe(true)
    expect(isOutcomeVerificationEnabled(freshDb(), { CC_OUTCOME_VERIFICATION_ENABLED: 'true' })).toBe(true)
  })
})

// ── 2. Opt-in arms ONE target without flipping the global default ──
describe('per-objective / type / category opt-in (global flag OFF)', () => {
  it('a per-objective row arms THIS objective only', () => {
    const db = freshDb()
    setSetting(db, 'outcome_assertion:1234', JSON.stringify({ enabled: true, command: 'node check.mjs' }))
    expect(isOutcomeVerificationActiveForObjective(db, OBJ({ id: 1234 }), {})).toBe(true)
    expect(isOutcomeVerificationActiveForObjective(db, OBJ({ id: 9999 }), {})).toBe(false)
  })

  it('a per-category row arms every objective in that category', () => {
    const db = freshDb()
    setSetting(db, 'outcome_assertion:category:marketing', JSON.stringify({ enabled: true, command: 'node pub.mjs' }))
    expect(isOutcomeVerificationActiveForObjective(db, OBJ({ category: 'marketing' }), {})).toBe(true)
    expect(hasOutcomeOptIn(db, OBJ({ category: 'marketing' }))).toBe(true)
    expect(hasOutcomeOptIn(db, OBJ({ category: 'finance' }))).toBe(false)
  })

  it('precedence: per-objective > category > type (most specific wins)', () => {
    const db = freshDb()
    setSetting(db, 'outcome_assertion:type:task', JSON.stringify({ enabled: true, command: 'TYPE' }))
    setSetting(db, 'outcome_assertion:category:general', JSON.stringify({ enabled: true, command: 'CATEGORY' }))
    setSetting(db, 'outcome_assertion:1234', JSON.stringify({ enabled: true, command: 'OBJECTIVE' }))
    expect(getOutcomeAssertion(db, OBJ())?.command).toBe('OBJECTIVE')
    expect(getOutcomeAssertion(db, OBJ())?.source).toBe('objective')
    // Remove the per-objective row → falls back to category.
    db.prepare('DELETE FROM settings WHERE key = ?').run('outcome_assertion:1234')
    expect(getOutcomeAssertion(db, OBJ())?.command).toBe('CATEGORY')
    db.prepare('DELETE FROM settings WHERE key = ?').run('outcome_assertion:category:general')
    expect(getOutcomeAssertion(db, OBJ())?.command).toBe('TYPE')
  })

  it('disabled / blank-command / not-present rows → null (NO-OP, not a fail)', () => {
    const db = freshDb()
    expect(getOutcomeAssertion(db, OBJ())).toBeNull()
    setSetting(db, 'outcome_assertion:1234', JSON.stringify({ enabled: false, command: 'x' }))
    expect(getOutcomeAssertion(db, OBJ())).toBeNull()
    setSetting(db, 'outcome_assertion:1234', JSON.stringify({ enabled: true, command: '   ' }))
    expect(getOutcomeAssertion(db, OBJ())).toBeNull()
  })

  it('a MATCHING but malformed row THROWS (→ caller fails-safe-OPEN, not a silent downgrade)', () => {
    const db = freshDb()
    setSetting(db, 'outcome_assertion:1234', '{not valid json')
    expect(() => getOutcomeAssertion(db, OBJ())).toThrow()
  })

  it('parses optional cwd + timeoutMs', () => {
    const db = freshDb()
    setSetting(db, 'outcome_assertion:1234', JSON.stringify({ enabled: true, command: 'node c.mjs', cwd: '/tmp/x', timeoutMs: 5000 }))
    const cfg = getOutcomeAssertion(db, OBJ())
    expect(cfg).toMatchObject({ command: 'node c.mjs', cwd: '/tmp/x', timeoutMs: 5000, source: 'objective' })
  })
})

// ── 3. Kill switch overrides every opt-in ──
describe('kill switch', () => {
  it('an opt-in objective is INACTIVE when killed (env or settings)', () => {
    const db = freshDb()
    setSetting(db, 'outcome_assertion:1234', JSON.stringify({ enabled: true, command: 'node check.mjs' }))
    expect(isOutcomeVerificationActiveForObjective(db, OBJ(), {})).toBe(true)
    setSetting(db, 'outcome_verification_killed', '1')
    expect(isOutcomeVerificationKilled(db, {})).toBe(true)
    expect(isOutcomeVerificationActiveForObjective(db, OBJ(), {})).toBe(false)
    // env kill also wins
    expect(isOutcomeVerificationActiveForObjective(freshDb(), OBJ(), { CC_OUTCOME_VERIFICATION_KILLED: '1' })).toBe(false)
  })
})

// ── 4. evaluateOutcomeGate — block ONLY on a clean non-zero exit ──
describe('evaluateOutcomeGate decision', () => {
  const cfg: OutcomeAssertionConfig = { command: 'node check.mjs', source: 'objective' }
  const baseDeps = (over: Record<string, unknown> = {}) => ({
    getConfig: () => cfg,
    resolveFallbackCwd: () => '/tmp',
    run: (c: FloorConfig, cwd: string) => runFloor(c, cwd, fakeRunner({})),
    record: () => {},
    logMilestone: () => {},
    ...over,
  })

  it('clean exit 0 → proceed(green)', () => {
    const d = evaluateOutcomeGate(baseDeps())
    expect(d.action).toBe('proceed')
    expect(d.action === 'proceed' && d.reason).toBe('green')
  })

  it('clean non-zero exit → BLOCK with an outcome-specific follow-up', () => {
    const d = evaluateOutcomeGate(
      baseDeps({ run: (c: FloorConfig, cwd: string) => runFloor(c, cwd, fakeRunner({ 'node check.mjs': { exitCode: 1, output: 'OUTCOME FAIL: no rows' } })) }),
    )
    expect(d.action).toBe('block')
    if (d.action === 'block') {
      expect(d.followUp).toContain('Outcome Verification — FAILED')
      expect(d.followUp).toContain('node check.mjs')
      expect(d.run.failingOutput).toContain('OUTCOME FAIL')
    }
  })

  it('not opted in (getConfig → null) → proceed(not-opted-in), no run', () => {
    const run = vi.fn()
    const d = evaluateOutcomeGate(baseDeps({ getConfig: () => null, run }))
    expect(d.action === 'proceed' && d.reason).toBe('not-opted-in')
    expect(run).not.toHaveBeenCalled()
  })

  it('malformed config (getConfig throws) → proceed(cfg-error) — fail-safe-open', () => {
    const d = evaluateOutcomeGate(baseDeps({ getConfig: () => { throw new Error('bad json') } }))
    expect(d.action === 'proceed' && d.reason).toBe('cfg-error')
  })

  it('infra error on the assertion → proceed(open) — never a wedge', () => {
    const d = evaluateOutcomeGate(
      baseDeps({ run: (c: FloorConfig, cwd: string) => runFloor(c, cwd, fakeRunner({ 'node check.mjs': { infraError: 'timeout', exitCode: null } })) }),
    )
    expect(d.action === 'proceed' && d.reason).toBe('open')
  })

  it('resolveFallbackCwd throws → proceed(open); but an explicit config cwd bypasses it', () => {
    const threw = vi.fn(() => { throw new Error('no workdir') })
    expect(evaluateOutcomeGate(baseDeps({ resolveFallbackCwd: threw })).action).toBe('proceed')
    // explicit cwd → fallback never called
    const fallback = vi.fn(() => '/should/not/be/used')
    const seen: string[] = []
    evaluateOutcomeGate({
      getConfig: () => ({ command: 'node check.mjs', cwd: '/explicit', source: 'objective' }),
      resolveFallbackCwd: fallback,
      run: (_c: FloorConfig, cwd: string) => { seen.push(cwd); return runFloor(_c, cwd, fakeRunner({})) },
      record: () => {},
      logMilestone: () => {},
    })
    expect(fallback).not.toHaveBeenCalled()
    expect(seen).toEqual(['/explicit'])
  })
})

// ── 5. Recording discriminator — outcome rows are distinct from code-floor rows ──
describe('recordOutcomeRunRow — source discriminator', () => {
  function dbWithFloorTable(): Database.Database {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE objectives (id INTEGER PRIMARY KEY);
      INSERT INTO objectives (id) VALUES (1234);
      CREATE TABLE objective_floor_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        objective_id INTEGER NOT NULL,
        iteration INTEGER NOT NULL DEFAULT 0,
        outcome TEXT NOT NULL CHECK(outcome IN ('pass','fail','open')),
        commands_json TEXT NOT NULL DEFAULT '[]',
        failed_command TEXT, open_reason TEXT, cwd TEXT, resolved_status TEXT,
        llm_would_have_run INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        project TEXT, passed INTEGER, exit_code INTEGER, command TEXT,
        layer4_outcome TEXT, source TEXT
      );
    `)
    return db
  }

  it("outcome run writes source='outcome' and layer4_outcome NULL; code-floor run writes source NULL", () => {
    const db = dbWithFloorTable()
    const obj = OBJ({ id: 1234 })
    // An outcome run (fail).
    const outcomeRun: FloorRunResult = runFloor(
      { enabled: true, commands: [], stateDeltaCommand: 'node check.mjs' },
      '/tmp',
      fakeRunner({ 'node check.mjs': { exitCode: 1, output: 'fail' } }),
    )
    recordOutcomeRunRow(db, obj, 'done', '/tmp', outcomeRun)
    // A code-floor run (pass) via the EXISTING recorder — must leave source NULL.
    const floorRun: FloorRunResult = runFloor({ enabled: true, commands: ['tsc'] }, '/tmp', fakeRunner({}))
    recordFloorRunRow(db, { id: 1234, project: null, workspace: 'operator', session_id: null }, 'done', '/tmp', floorRun, false)

    const rows = db.prepare('SELECT outcome, passed, command, source, layer4_outcome FROM objective_floor_runs ORDER BY id').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    // outcome row
    expect(rows[0].source).toBe('outcome')
    expect(rows[0].outcome).toBe('fail')
    expect(rows[0].passed).toBe(0)
    expect(rows[0].command).toBe('node check.mjs')
    expect(rows[0].layer4_outcome).toBeNull() // code-floor metric stays uncorrupted
    // code-floor row — the discriminator is NULL, mechanically distinct
    expect(rows[1].source).toBeNull()
    expect(rows[1].outcome).toBe('pass')

    // The audit query that isolates outcome runs never picks up code-floor rows.
    const outcomeCount = db.prepare("SELECT COUNT(*) c FROM objective_floor_runs WHERE source = 'outcome'").get() as { c: number }
    expect(outcomeCount.c).toBe(1)
  })
})

describe('buildOutcomeFailFollowUp', () => {
  it('labels the failure as outcome verification with the assertion + output', () => {
    const run: FloorRunResult = runFloor(
      { enabled: true, commands: [], stateDeltaCommand: 'node pub.mjs' },
      '/tmp',
      fakeRunner({ 'node pub.mjs': { exitCode: 1, output: 'OUTCOME FAIL: not published' } }),
    )
    const msg = buildOutcomeFailFollowUp(run)
    expect(msg).toContain('Outcome Verification — FAILED')
    expect(msg).toContain('node pub.mjs')
    expect(msg).toContain('not published')
  })
})
