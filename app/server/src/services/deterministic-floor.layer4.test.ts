// ── KL-4 LAYER 4 (state-delta / E2E ground truth) — obj 2508 ─────────────────
//
// Proves the optional 4th floor layer:
//   • getFloorConfig parses the per-project `state_delta_command` opt-in (and the
//     camelCase alias); absent ⇒ undefined ⇒ layers-1–2 fallback unchanged.
//   • runFloor runs layer 4 ONLY after layers 1–3 pass, attributes a clean non-zero
//     exit to layer 4 (gatingLayer===4, layer4Outcome='fail'), fails-safe-OPEN on a
//     layer-4 infra error, and is byte-for-byte unchanged when no layer-4 is set.
//   • The DIFFERENTIAL PROOF against the real `layer4-state-delta-noop` fixture
//     (executed for real via execRunner): commands-only ⇒ pass (ESCAPE); the same
//     fixture WITH its state_delta_command ⇒ fail (CAUGHT). Layer 4 earns its place.
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  getFloorConfig,
  runFloor,
  buildFloorFailFollowUp,
  execRunner,
  type CommandRunner,
  type FloorConfig,
  type FloorCommandResult,
} from './deterministic-floor.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}
function setSetting(db: Database.Database, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}
function fakeRunner(map: Record<string, Partial<FloorCommandResult>>): CommandRunner {
  return (command, _cwd, _timeout) => ({ command, exitCode: 0, output: '', durationMs: 1, ...(map[command] || {}) })
}
const CFG = (commands: string[], stateDeltaCommand?: string): FloorConfig => ({ enabled: true, commands, stateDeltaCommand })

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/canaries/layer4-state-delta-noop',
)

describe('getFloorConfig — layer-4 state_delta_command opt-in', () => {
  it('parses state_delta_command (snake_case, the roadmap/settings key)', () => {
    const db = freshDb()
    setSetting(db, 'floor_config:proj', JSON.stringify({ enabled: true, commands: ['tsc'], state_delta_command: 'node delta.mjs' }))
    expect(getFloorConfig(db, 'proj')?.stateDeltaCommand).toBe('node delta.mjs')
  })
  it('parses stateDeltaCommand (camelCase alias)', () => {
    const db = freshDb()
    setSetting(db, 'floor_config:proj', JSON.stringify({ enabled: true, commands: ['tsc'], stateDeltaCommand: 'node d.mjs' }))
    expect(getFloorConfig(db, 'proj')?.stateDeltaCommand).toBe('node d.mjs')
  })
  it('absent → undefined (project falls back to layers 1–2 unchanged)', () => {
    const db = freshDb()
    setSetting(db, 'floor_config:proj', JSON.stringify({ enabled: true, commands: ['tsc'] }))
    expect(getFloorConfig(db, 'proj')?.stateDeltaCommand).toBeUndefined()
  })
  it('blank/non-string state_delta_command → undefined (an empty layer-4 cannot gate)', () => {
    const db = freshDb()
    setSetting(db, 'floor_config:proj', JSON.stringify({ enabled: true, commands: ['tsc'], state_delta_command: '   ' }))
    expect(getFloorConfig(db, 'proj')?.stateDeltaCommand).toBeUndefined()
  })
})

describe('runFloor — layer 4 sequencing & attribution', () => {
  it('FALLBACK: no stateDeltaCommand → pass, no layer4Outcome (pre-layer-4 behaviour unchanged)', () => {
    const r = runFloor(CFG(['tsc', 'build', 'test']), '/tmp', fakeRunner({}))
    expect(r.outcome).toBe('pass')
    expect(r.layer4Outcome).toBeUndefined()
    expect(r.commands.every(c => c.layer === undefined)).toBe(true)
  })

  it('layers 1–3 fail → layer 4 NEVER runs (gatingLayer 1, no layer4Outcome)', () => {
    const r = runFloor(CFG(['tsc', 'test'], 'node delta.mjs'), '/tmp', fakeRunner({ test: { exitCode: 1, output: 'boom' } }))
    expect(r.outcome).toBe('fail')
    expect(r.gatingLayer).toBe(1)
    expect(r.layer4Outcome).toBeUndefined()
    expect(r.commands.find(c => c.command === 'node delta.mjs')).toBeUndefined()
  })

  it('layers 1–3 pass + layer 4 PASS → pass, layer4Outcome=pass', () => {
    const r = runFloor(CFG(['tsc'], 'node delta.mjs'), '/tmp', fakeRunner({}))
    expect(r.outcome).toBe('pass')
    expect(r.layer4Outcome).toBe('pass')
    expect(r.layer4Command).toBe('node delta.mjs')
    expect(r.commands.find(c => c.command === 'node delta.mjs')?.layer).toBe(4)
  })

  it('layers 1–3 pass + layer 4 clean non-zero → FAIL attributed to layer 4', () => {
    const r = runFloor(CFG(['tsc'], 'node delta.mjs'), '/tmp', fakeRunner({ 'node delta.mjs': { exitCode: 1, output: 'STATE-DELTA FAIL' } }))
    expect(r.outcome).toBe('fail')
    expect(r.gatingLayer).toBe(4)
    expect(r.layer4Outcome).toBe('fail')
    expect(r.failedCommand).toBe('node delta.mjs')
    expect(r.failingOutput).toContain('STATE-DELTA FAIL')
  })

  it('layer 4 infra error → fail-safe-OPEN (layers 1–3 passed; never block on infra)', () => {
    const r = runFloor(CFG(['tsc'], 'node delta.mjs'), '/tmp', fakeRunner({ 'node delta.mjs': { infraError: 'timeout', exitCode: null } }))
    expect(r.outcome).toBe('open')
    expect(r.layer4Outcome).toBe('open')
    expect(r.openReason).toContain('layer-4')
  })
})

describe('buildFloorFailFollowUp — layer-4 catch is labelled', () => {
  it('a layer-4 fail produces a state-delta-specific message', () => {
    const r = runFloor(CFG(['tsc'], 'node delta.mjs'), '/tmp', fakeRunner({ 'node delta.mjs': { exitCode: 1, output: 'no row written' } }))
    const msg = buildFloorFailFollowUp(r)
    expect(msg).toContain('Layer 4')
    expect(msg).toContain('compiled and the tests passed')
    expect(msg).toContain('node delta.mjs')
  })
})

describe('DIFFERENTIAL PROOF — real layer4-state-delta-noop fixture (executed)', () => {
  // Runs the REAL fixture via execRunner (node), not a fake. This is the load-bearing
  // proof for the acceptance criterion: the same known-bad artifact escapes layers
  // 1–3 and is caught only when layer 4 is enabled.
  it('layers 1–3 ONLY (no state-delta) → PASS — the broken outcome ESCAPES', () => {
    const r = runFloor(
      { enabled: true, commands: ['node --check handler.mjs', 'node unit.test.mjs'] },
      FIXTURE_DIR,
      execRunner,
    )
    expect(r.outcome).toBe('pass')
    expect(r.layer4Outcome).toBeUndefined()
  })

  it('layers 1–3 + LAYER 4 → FAIL — the same artifact is CAUGHT by the state-delta', () => {
    const r = runFloor(
      { enabled: true, commands: ['node --check handler.mjs', 'node unit.test.mjs'], stateDeltaCommand: 'node state-delta-check.mjs' },
      FIXTURE_DIR,
      execRunner,
    )
    expect(r.outcome).toBe('fail')
    expect(r.gatingLayer).toBe(4)
    expect(r.layer4Outcome).toBe('fail')
    expect(r.failingOutput).toContain('STATE-DELTA FAIL')
  })
})
