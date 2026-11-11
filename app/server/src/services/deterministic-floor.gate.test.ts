// ── Per-project activation + shared gate decision (obj 2335) ────────────────
// Covers the NEW mechanism that lets ONE pilot project arm the deterministic
// floor via a DB row WITHOUT flipping the global default flag, plus the shared
// evaluateFloorGate decision used by both the poller and the working→done route.

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  isFloorEnabled,
  isFloorKilled,
  hasProjectFloorOptIn,
  isFloorActiveForProject,
  evaluateFloorGate,
  runFloor,
  type CommandRunner,
  type FloorConfig,
  type FloorCommandResult,
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
function optIn(db: Database.Database, project: string, commands = ['echo ok']) {
  setSetting(db, `floor_config:${project}`, JSON.stringify({ enabled: true, commands }))
}
function fakeRunner(map: Record<string, Partial<FloorCommandResult>>): CommandRunner {
  return (command) => ({ command, exitCode: 0, output: '', durationMs: 1, ...(map[command] || {}) })
}
const CFG = (commands: string[]): FloorConfig => ({ enabled: true, commands })

// ── THE headline mechanism: pilot opt-in arms the floor with global flag OFF ──
describe('isFloorActiveForProject — pilot opt-in WITHOUT flipping the global default', () => {
  it('global flag 0 + pilot opt-in row → ACTIVE for the pilot, INACTIVE for everyone else', () => {
    const db = freshDb()
    // Global default stays OFF — exactly as it ships in code (db/index.ts:1038).
    expect(isFloorEnabled(db, {})).toBe(false)

    optIn(db, 'pilot-project')

    // The pilot is armed purely by its own row…
    expect(isFloorActiveForProject(db, 'pilot-project', {})).toBe(true)
    // …and NO other project is affected (no global flip happened).
    expect(isFloorActiveForProject(db, 'some-other-project', {})).toBe(false)
    expect(isFloorActiveForProject(db, null, {})).toBe(false)
    // Global flag is STILL off — we never touched it.
    expect(isFloorEnabled(db, {})).toBe(false)
  })

  it('global flag 1 → active for any opted-in project (original semantics preserved)', () => {
    const db = freshDb()
    setSetting(db, 'deterministic_floor_enabled', '1')
    // Global on activates even projects with no per-project row.
    expect(isFloorActiveForProject(db, 'anything', {})).toBe(true)
  })

  it('hasProjectFloorOptIn is a pure presence check (true even for a malformed row)', () => {
    const db = freshDb()
    expect(hasProjectFloorOptIn(db, 'p')).toBe(false)
    setSetting(db, 'floor_config:p', '{not valid json')
    // Presence is true so the malformed row reaches getFloorConfig → fail-safe-open,
    // instead of being silently treated as "not opted in".
    expect(hasProjectFloorOptIn(db, 'p')).toBe(true)
    expect(isFloorActiveForProject(db, 'p', {})).toBe(true)
  })

  it('empty/whitespace opt-in value does NOT arm the floor', () => {
    const db = freshDb()
    setSetting(db, 'floor_config:p', '   ')
    expect(hasProjectFloorOptIn(db, 'p')).toBe(false)
    expect(isFloorActiveForProject(db, 'p', {})).toBe(false)
  })
})

// ── Hard kill switch overrides everything ─────────────────────────────────────
describe('isFloorKilled — belt-and-suspenders global OFF', () => {
  it('kill setting disables the floor even with a pilot opt-in AND global flag on', () => {
    const db = freshDb()
    setSetting(db, 'deterministic_floor_enabled', '1')
    optIn(db, 'pilot')
    setSetting(db, 'deterministic_floor_killed', '1')
    expect(isFloorKilled(db, {})).toBe(true)
    expect(isFloorActiveForProject(db, 'pilot', {})).toBe(false)
  })

  it('env CC_DETERMINISTIC_FLOOR_KILLED overrides a missing kill row', () => {
    const db = freshDb()
    optIn(db, 'pilot')
    expect(isFloorActiveForProject(db, 'pilot', { CC_DETERMINISTIC_FLOOR_KILLED: '1' })).toBe(false)
  })
})

// ── Shared gate decision (used by BOTH the poller and the working→done route) ──
describe('evaluateFloorGate — block ONLY on a clean red floor; fail-safe-open otherwise', () => {
  const baseDeps = (overrides: Partial<Parameters<typeof evaluateFloorGate>[0]>) => {
    const milestones: Array<[string, string]> = []
    const recorded: FloorRunResult[] = []
    const deps = {
      getConfig: () => CFG(['tsc', 'build']),
      resolveCwd: () => '/tmp/x',
      run: (cfg: FloorConfig, cwd: string) => runFloor(cfg, cwd, fakeRunner({})),
      record: (_cwd: string, run: FloorRunResult) => { recorded.push(run) },
      logMilestone: (t: string, d: string) => { milestones.push([t, d]) },
      ...overrides,
    }
    return { deps, milestones, recorded }
  }

  it('green floor → proceed(green), run recorded, floor_pass milestone', () => {
    const { deps, milestones, recorded } = baseDeps({})
    const d = evaluateFloorGate(deps)
    expect(d.action).toBe('proceed')
    expect(recorded).toHaveLength(1)
    expect(recorded[0].outcome).toBe('pass')
    expect(milestones.some(([t]) => t === 'floor_pass')).toBe(true)
  })

  it('red floor (clean non-zero exit) → BLOCK with worker follow-up + run recorded', () => {
    const { deps, recorded } = baseDeps({
      run: (cfg, cwd) => runFloor(cfg, cwd, fakeRunner({ build: { exitCode: 2, output: 'TS2304: boom' } })),
    })
    const d = evaluateFloorGate(deps)
    expect(d.action).toBe('block')
    if (d.action === 'block') {
      expect(d.run.failedCommand).toBe('build')
      expect(d.followUp).toContain('Deterministic Floor — FAILED')
      expect(d.followUp).toContain('TS2304')
    }
    expect(recorded[0].outcome).toBe('fail')
  })

  it('not opted in (getConfig→null) → proceed(not-opted-in), nothing recorded', () => {
    const { deps, recorded } = baseDeps({ getConfig: () => null })
    const d = evaluateFloorGate(deps)
    expect(d).toEqual({ action: 'proceed', reason: 'not-opted-in' })
    expect(recorded).toHaveLength(0)
  })

  it('malformed config (getConfig throws) → proceed(cfg-error), fail-safe-open', () => {
    const { deps } = baseDeps({ getConfig: () => { throw new Error('bad json') } })
    const d = evaluateFloorGate(deps)
    expect(d).toEqual({ action: 'proceed', reason: 'cfg-error' })
  })

  it('infra error (timeout) → proceed(open), NOT block', () => {
    const { deps } = baseDeps({
      run: (cfg, cwd) => runFloor(cfg, cwd, fakeRunner({ tsc: { infraError: 'timeout', exitCode: null } })),
    })
    const d = evaluateFloorGate(deps)
    expect(d.action).toBe('proceed')
    if (d.action === 'proceed') expect(d.reason).toBe('open')
  })

  it('resolveCwd throws → proceed(open), fail-safe-open', () => {
    const { deps } = baseDeps({ resolveCwd: () => { throw new Error('no workdir') } })
    const d = evaluateFloorGate(deps)
    expect(d.action).toBe('proceed')
    if (d.action === 'proceed') expect(d.reason).toBe('open')
  })
})
