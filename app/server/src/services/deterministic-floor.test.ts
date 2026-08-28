import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  isFloorEnabled,
  getFloorConfig,
  runFloor,
  resolveFloorCwd,
  buildFloorFailFollowUp,
  type CommandRunner,
  type FloorConfig,
  type FloorCommandResult,
} from './deterministic-floor.js'

// ── test helpers ──────────────────────────────────────────────────────────
function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

function setSetting(db: Database.Database, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

// A fake runner driven by a per-command outcome map.
function fakeRunner(map: Record<string, Partial<FloorCommandResult>>): CommandRunner {
  return (command, _cwd, _timeout) => ({
    command,
    exitCode: 0,
    output: '',
    durationMs: 1,
    ...(map[command] || {}),
  })
}

const CFG = (commands: string[]): FloorConfig => ({ enabled: true, commands })

// ── (c) feature flag ────────────────────────────────────────────────────────
describe('isFloorEnabled — flag OFF by default, fail-safe', () => {
  it('flag OFF: env unset + no setting → false (transition path unchanged)', () => {
    const db = freshDb()
    expect(isFloorEnabled(db, {})).toBe(false)
  })

  it('settings deterministic_floor_enabled=0 → false', () => {
    const db = freshDb()
    setSetting(db, 'deterministic_floor_enabled', '0')
    expect(isFloorEnabled(db, {})).toBe(false)
  })

  it('settings deterministic_floor_enabled=1 → true', () => {
    const db = freshDb()
    setSetting(db, 'deterministic_floor_enabled', '1')
    expect(isFloorEnabled(db, {})).toBe(true)
  })

  it('env CC_DETERMINISTIC_FLOOR_ENABLED=true overrides a missing/0 setting', () => {
    const db = freshDb()
    expect(isFloorEnabled(db, { CC_DETERMINISTIC_FLOOR_ENABLED: 'true' })).toBe(true)
    expect(isFloorEnabled(db, { CC_DETERMINISTIC_FLOOR_ENABLED: '1' })).toBe(true)
    expect(isFloorEnabled(db, { CC_DETERMINISTIC_FLOOR_ENABLED: 'no' })).toBe(false)
  })

  it('missing settings table → false (never throws)', () => {
    const db = new Database(':memory:')
    expect(isFloorEnabled(db, {})).toBe(false)
  })
})

// ── (d) per-project opt-in ───────────────────────────────────────────────────
describe('getFloorConfig — per-project opt-in', () => {
  it('project not opted in (no row) → null (NO-OP, not a fail)', () => {
    const db = freshDb()
    expect(getFloorConfig(db, 'some-project')).toBeNull()
  })

  it('null project → null', () => {
    const db = freshDb()
    expect(getFloorConfig(db, null)).toBeNull()
  })

  it('row present but enabled!==true → null', () => {
    const db = freshDb()
    setSetting(db, 'floor_config:p', JSON.stringify({ enabled: false, commands: ['x'] }))
    expect(getFloorConfig(db, 'p')).toBeNull()
  })

  it('enabled but empty/whitespace commands → null', () => {
    const db = freshDb()
    setSetting(db, 'floor_config:p', JSON.stringify({ enabled: true, commands: ['', '   '] }))
    expect(getFloorConfig(db, 'p')).toBeNull()
  })

  it('valid opt-in → parsed config with commands', () => {
    const db = freshDb()
    setSetting(db, 'floor_config:p', JSON.stringify({ enabled: true, commands: ['tsc --noEmit', 'npm test'], timeoutMs: 5000 }))
    const cfg = getFloorConfig(db, 'p')
    expect(cfg).not.toBeNull()
    expect(cfg!.commands).toEqual(['tsc --noEmit', 'npm test'])
    expect(cfg!.timeoutMs).toBe(5000)
  })

  it('malformed JSON THROWS (caller fails-safe-open) — does NOT silently disable', () => {
    const db = freshDb()
    setSetting(db, 'floor_config:p', '{not valid json')
    expect(() => getFloorConfig(db, 'p')).toThrow()
  })
})

// ── (a) red floor / (b) green floor / (e) fail-safe-open ──────────────────────
describe('runFloor — gating outcomes', () => {
  it('(b) green floor: all commands exit 0 → pass', () => {
    const r = runFloor(CFG(['tsc', 'build', 'test']), '/tmp', fakeRunner({}))
    expect(r.outcome).toBe('pass')
    expect(r.commands).toHaveLength(3)
  })

  it('(a) red floor: a clean non-zero exit → fail, captures failing command + output', () => {
    const r = runFloor(
      CFG(['tsc', 'build', 'test']),
      '/tmp',
      fakeRunner({ build: { exitCode: 2, output: 'TS2304: cannot find name X' } }),
    )
    expect(r.outcome).toBe('fail')
    expect(r.failedCommand).toBe('build')
    expect(r.failingOutput).toContain('TS2304')
    // stops at first failure — 'test' never runs
    expect(r.commands.map(c => c.command)).toEqual(['tsc', 'build'])
  })

  it('(a) red floor: first command fails → short-circuits immediately', () => {
    const r = runFloor(CFG(['tsc', 'build']), '/tmp', fakeRunner({ tsc: { exitCode: 1, output: 'type error' } }))
    expect(r.outcome).toBe('fail')
    expect(r.failedCommand).toBe('tsc')
    expect(r.commands).toHaveLength(1)
  })

  it('(e) fail-safe-open: infraError (timeout) → open, NOT fail', () => {
    const r = runFloor(CFG(['tsc', 'test']), '/tmp', fakeRunner({ test: { infraError: 'timeout', exitCode: null } }))
    expect(r.outcome).toBe('open')
    expect(r.openReason).toContain('timeout')
  })

  it('(e) fail-safe-open: command-not-found (exit 127) classified by execRunner as infra → open', () => {
    // simulate what execRunner returns for a 127: infraError set
    const r = runFloor(CFG(['nonexistent-cmd']), '/tmp', fakeRunner({ 'nonexistent-cmd': { exitCode: 127, infraError: 'shell-exit-127' } }))
    expect(r.outcome).toBe('open')
  })

  it('(e) fail-safe-open: a runner that THROWS is treated as infra → open (never propagates)', () => {
    const throwingRunner: CommandRunner = () => {
      throw new Error('exec subsystem exploded')
    }
    const r = runFloor(CFG(['tsc']), '/tmp', throwingRunner)
    expect(r.outcome).toBe('open')
    expect(r.openReason).toContain('runner-threw')
  })

  it('precedence: infra error short-circuits before any later command runs', () => {
    const r = runFloor(CFG(['a', 'b', 'c']), '/tmp', fakeRunner({ b: { infraError: 'spawn-failure', exitCode: null } }))
    expect(r.outcome).toBe('open')
    expect(r.commands.map(c => c.command)).toEqual(['a', 'b'])
  })
})

// ── load-bearing property: red floor produces actionable worker feedback ───────
describe('buildFloorFailFollowUp — the message routed back to the worker', () => {
  it('includes the failing command and its output (so the worker can fix it)', () => {
    const r = runFloor(CFG(['tsc']), '/tmp', fakeRunner({ tsc: { exitCode: 2, output: 'TS1005: ";" expected' } }))
    const msg = buildFloorFailFollowUp(r)
    expect(msg).toContain('Deterministic Floor — FAILED')
    expect(msg).toContain('`tsc`')
    expect(msg).toContain('TS1005')
    expect(msg).toContain('automatic fail')
  })
})

// ── worktree-aware cwd resolution ─────────────────────────────────────────────
describe('resolveFloorCwd', () => {
  it('non-PR objective → falls back to resolveWorkdir', () => {
    const cwd = resolveFloorCwd({ id: 1, create_pr: false }, () => '/home/operator/projects/foo')
    expect(cwd).toBe('/home/operator/projects/foo')
  })

  it('PR objective with no existing worktree → falls back to resolveWorkdir', () => {
    // /tmp/cc-worktree-999999 should not exist
    const cwd = resolveFloorCwd({ id: 999999, create_pr: true }, () => '/home/operator/projects/foo')
    expect(cwd).toBe('/home/operator/projects/foo')
  })
})
