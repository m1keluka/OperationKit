// ── Oracle hard merge gate (obj 700316, Stage-C enforcement) ────────────────
// Proves the four invariants the acceptance criteria grade:
//   1. flag OFF → gate inactive → floor behaviour byte-for-byte unchanged.
//   2. flag ON + command-center PR + non-GREEN oracle → BLOCK.
//   3. flag ON + non-command-center PR → NOT gated (blast-radius isolation).
//   4. flag ON + command-center PR + GREEN oracle → proceed.
// Plus fail-safe-OPEN on an oracle infra error.

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  isOracleGateEnabled,
  isCommandCenterTarget,
  isOracleGateActiveForObjective,
  evaluateOracleGate,
  runFloor,
  COMMAND_CENTER_PROJECT,
  ORACLE_COMMAND,
  type CommandRunner,
  type FloorCommandResult,
  type OracleGateDeps,
} from './deterministic-floor.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}
function setSetting(db: Database.Database, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

/** A runner that returns a chosen result for ORACLE_COMMAND (simulates the verdict). */
function oracleRunner(result: Partial<FloorCommandResult>): CommandRunner {
  return (command, _cwd, _t) => ({ command, exitCode: 0, output: '', durationMs: 1, ...result })
}

/** Build evaluateOracleGate deps, capturing milestones, wiring runFloor with the fake runner. */
function deps(runner: CommandRunner, milestones: string[] = []): OracleGateDeps & { milestones: string[] } {
  return {
    milestones,
    resolveCwd: () => '/tmp/cc-worktree-test',
    run: (cfg, cwd) => runFloor(cfg, cwd, runner),
    logMilestone: (title, detail) => milestones.push(`${title}:${detail}`),
  }
}

// ── Flag + scope predicates ───────────────────────────────────────────────────
describe('oracle gate flag + scope guard', () => {
  it('flag OFF by default (no row, no env)', () => {
    const db = freshDb()
    expect(isOracleGateEnabled(db, {})).toBe(false)
  })

  it('reads kitchen_loop_oracle_gate from settings and env', () => {
    const db = freshDb()
    setSetting(db, 'kitchen_loop_oracle_gate', '1')
    expect(isOracleGateEnabled(db, {})).toBe(true)
    const db2 = freshDb()
    expect(isOracleGateEnabled(db2, { CC_KITCHEN_LOOP_ORACLE_GATE: 'true' })).toBe(true)
  })

  it('scope guard matches ONLY command-center-infra', () => {
    expect(isCommandCenterTarget(COMMAND_CENTER_PROJECT)).toBe(true)
    expect(isCommandCenterTarget('command-center-infra')).toBe(true)
    expect(isCommandCenterTarget('example-platform')).toBe(false)
    expect(isCommandCenterTarget('example3-platform')).toBe(false)
    expect(isCommandCenterTarget(null)).toBe(false)
    expect(isCommandCenterTarget(undefined)).toBe(false)
  })

  it('[oracle-gate-off-unchanged] flag OFF → INACTIVE for command-center (gate never arms)', () => {
    const db = freshDb()
    expect(isOracleGateActiveForObjective(db, { project: COMMAND_CENTER_PROJECT }, {})).toBe(false)
  })

  it('[oracle-gate-scope-isolation] flag ON → ACTIVE for command-center, INACTIVE for every other repo', () => {
    const db = freshDb()
    setSetting(db, 'kitchen_loop_oracle_gate', '1')
    expect(isOracleGateActiveForObjective(db, { project: COMMAND_CENTER_PROJECT }, {})).toBe(true)
    // The blast-radius guarantee: NO other workspace/repo is gated, even with the flag ON.
    for (const other of ['example-platform', 'example3-platform', 'example-project-platform', null]) {
      expect(isOracleGateActiveForObjective(db, { project: other }, {})).toBe(false)
    }
  })
})

// ── evaluateOracleGate decision (run via the real runFloor classifier) ─────────
describe('evaluateOracleGate decision', () => {
  it('[oracle-gate-blocks-red] non-GREEN oracle (exit 1) → BLOCK with worker follow-up', () => {
    const d = deps(oracleRunner({ exitCode: 1, output: 'verdict: RED (regressed)' }))
    const decision = evaluateOracleGate(d)
    expect(decision.action).toBe('block')
    if (decision.action === 'block') {
      expect(decision.run.outcome).toBe('fail')
      expect(decision.run.failedCommand).toBe(ORACLE_COMMAND)
      expect(decision.followUp).toContain('Regression Oracle — FAILED')
      expect(decision.followUp).toContain('RED')
    }
  })

  it('GREEN oracle (exit 0) → proceed', () => {
    const m: string[] = []
    const decision = evaluateOracleGate(deps(oracleRunner({ exitCode: 0, output: 'verdict: GREEN' }), m))
    expect(decision.action).toBe('proceed')
    if (decision.action === 'proceed') expect(decision.reason).toBe('green')
    expect(m.some(x => x.startsWith('oracle_pass'))).toBe(true)
  })

  it('oracle infra error (e.g. node missing → exit 127) → fail-safe-OPEN (proceed)', () => {
    const m: string[] = []
    const decision = evaluateOracleGate(
      deps(oracleRunner({ exitCode: 127, output: 'node: not found', infraError: 'shell-exit-127' }), m),
    )
    expect(decision.action).toBe('proceed')
    if (decision.action === 'proceed') expect(decision.reason).toBe('open')
    expect(m.some(x => x.startsWith('oracle_open'))).toBe(true)
  })

  it('resolveCwd throwing → fail-safe-OPEN (proceed), never block', () => {
    const m: string[] = []
    const decision = evaluateOracleGate({
      resolveCwd: () => {
        throw new Error('no worktree')
      },
      run: (cfg, cwd) => runFloor(cfg, cwd, oracleRunner({ exitCode: 1 })),
      logMilestone: (t, dt) => m.push(`${t}:${dt}`),
    })
    expect(decision.action).toBe('proceed')
    expect(m.some(x => x.startsWith('oracle_open'))).toBe(true)
  })

  it('runs the oracle as a commands-empty layer-4 floor (ORACLE_COMMAND only)', () => {
    let seenCfg: { commands: string[]; stateDeltaCommand?: string } | null = null
    const decision = evaluateOracleGate({
      resolveCwd: () => '/tmp/x',
      run: (cfg) => {
        seenCfg = { commands: cfg.commands, stateDeltaCommand: cfg.stateDeltaCommand }
        return runFloor(cfg, '/tmp/x', oracleRunner({ exitCode: 0 }))
      },
      logMilestone: () => {},
    })
    expect(decision.action).toBe('proceed')
    expect(seenCfg).toEqual({ commands: [], stateDeltaCommand: ORACLE_COMMAND })
  })
})
