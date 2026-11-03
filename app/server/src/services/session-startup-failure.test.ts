/**
 * obj 900038 — a session that dies before the agent starts must say so.
 *
 * The old wrapper ran `cd <workdir> || exit 1` BEFORE its first log write, so an
 * un-enterable /workspace produced an empty transcript, an empty log, and a card
 * that merely read "ended, 0 tools, 0 tokens" — which the poller then treated as
 * a no-op spawn and RE-SPAWNED into the identical failure.
 */
import { describe, it, expect } from 'vitest'
import {
  buildWorkdirGuard,
  detectStartupFailure,
  describeStartupFailure,
  tailLines,
  STARTUP_FAILURE_EXIT,
  STARTUP_FAILURE_MARKER,
  STARTUP_FAILURE_SUBTYPE,
} from './session-startup-failure.js'
import { classifyNoOpSpawn, MAX_NOOP_RESPAWNS } from './poller-decisions.js'

const guard = () =>
  buildWorkdirGuard({
    workdirGuest: JSON.stringify('/workspace'),
    logGuest: JSON.stringify('/home/jailuser/.cc/s.log'),
    jsonlGuest: JSON.stringify('/home/jailuser/.cc/s.jsonl'),
    sessionId: 'cc-900038-1',
  })

describe('buildWorkdirGuard — log BEFORE cd', () => {
  const g = guard()

  it('writes a Starting line to the log before the cd is attempted', () => {
    const startAt = g.indexOf('[wrapper] Starting at')
    const cdAt = g.indexOf('if ! cd "$CC_WORKDIR"')
    expect(startAt).toBeGreaterThan(-1)
    expect(cdAt).toBeGreaterThan(-1)
    expect(startAt).toBeLessThan(cdAt)
  })

  it('records the workdir in the Starting line, so the log names the bad path', () => {
    expect(g).toContain('CC_WORKDIR="/workspace"')
    expect(g).toContain('(workdir=$CC_WORKDIR)')
  })

  it('captures the real stderr of the failing cd into the log', () => {
    expect(g).toContain('if ! cd "$CC_WORKDIR" 2>> "/home/jailuser/.cc/s.log"')
  })

  it('emits a machine-readable startup_failure event into the jsonl', () => {
    expect(g).toContain(`"subtype":"${STARTUP_FAILURE_SUBTYPE}"`)
    expect(g).toContain('"type":"error"')
    expect(g).toContain('>> "/home/jailuser/.cc/s.jsonl"')
  })

  it('exits with EX_CONFIG (78), distinguishable from a generic exit 1', () => {
    expect(g).toContain(`exit ${STARTUP_FAILURE_EXIT}`)
    expect(STARTUP_FAILURE_EXIT).toBe(78)
    expect(g).not.toContain('|| exit 1')
  })

  it('includes an ls/id diagnostic so a permissions cause is visible without a repro', () => {
    expect(g).toContain('ls -ld "$CC_WORKDIR"')
    expect(g).toContain('id 2>&1')
    expect(g).toContain(STARTUP_FAILURE_MARKER)
  })
})

describe('detectStartupFailure', () => {
  const failEvent = JSON.stringify({
    type: 'error',
    subtype: STARTUP_FAILURE_SUBTYPE,
    is_error: true,
    exit_code: 78,
    reason: 'workdir_unreachable',
    workdir: '/workspace',
    error: 'startup failed: cannot enter workdir /workspace',
  })

  it('reads the structured event, with exit code, workdir and stderr tail', () => {
    const f = detectStartupFailure({
      jsonlLines: [failEvent],
      logText: '[wrapper] Starting at 2026-11-03T00:00:00Z (workdir=/workspace)\nbash: cd: /workspace: Permission denied\n',
    })
    expect(f).toMatchObject({ reason: 'workdir_unreachable', exitCode: 78, workdir: '/workspace' })
    expect(f!.stderrTail).toContain('Permission denied')
  })

  it('falls back to the log marker when the jsonl was lost', () => {
    const f = detectStartupFailure({
      jsonlLines: [],
      logText: `[wrapper] Starting\n${STARTUP_FAILURE_MARKER} cannot enter workdir /workspace\n`,
    })
    expect(f).toMatchObject({ reason: 'workdir_unreachable', exitCode: 78 })
  })

  it('catches the LEGACY silent shape — no events at all and no wrapper banner', () => {
    // Sessions already running from a pre-fix wrapper must stop being
    // re-spawned too, so the original symptom is itself a detection signal.
    const f = detectStartupFailure({ jsonlLines: [], logText: '' })
    expect(f).toMatchObject({ reason: 'wrapper_never_started', exitCode: null })
  })

  it('does NOT fire on a quiet but real session (wrapper started, events present)', () => {
    expect(detectStartupFailure({
      jsonlLines: ['{"type":"result","subtype":"success","result":"42"}'],
      logText: '',
    })).toBeNull()
  })

  it('does NOT fire when the wrapper announced itself and simply produced nothing', () => {
    expect(detectStartupFailure({
      jsonlLines: [],
      logText: '[wrapper] Starting at 2026-11-03T00:00:00Z (workdir=/workspace)\n[wrapper] Entered /workspace\n',
    })).toBeNull()
  })

  it('ignores unparseable jsonl without throwing', () => {
    expect(detectStartupFailure({
      jsonlLines: ['not json at all', '{"type":"assistant"}'],
      logText: '[wrapper] Starting\n',
    })).toBeNull()
  })

  it('describeStartupFailure puts the exit code and the stderr on one card message', () => {
    const msg = describeStartupFailure({
      reason: 'workdir_unreachable', exitCode: 78, workdir: '/workspace',
      stderrTail: 'bash: cd: /workspace: Permission denied',
    })
    expect(msg).toContain('workdir_unreachable')
    expect(msg).toContain('exit code 78')
    expect(msg).toContain('Permission denied')
  })

  it('tailLines keeps the END of a long log and caps its size', () => {
    const t = tailLines([...Array(100).keys()].map(i => `line${i}`).join('\n'), 3)
    expect(t).toBe('line97\nline98\nline99')
    expect(tailLines('x'.repeat(5000), 8).length).toBeLessThanOrEqual(1200)
  })
})

describe('classifyNoOpSpawn — a startup failure must NOT loop re-spawns', () => {
  const empty = { toolCalls: 0, filesCreated: 0, filesModified: 0 }
  const failure = { reason: 'workdir_unreachable', exitCode: 78, stderrTail: 'Permission denied' }

  it('blocks immediately with the cause, on the FIRST attempt', () => {
    const d = classifyNoOpSpawn({ ...empty, startupFailure: failure }, 0)
    expect(d.action).toBe('startup-failed')
    expect(d.startupFailure).toEqual(failure)
    expect(d.attempt).toBeUndefined()
  })

  it('stays blocked at every prior-attempt count — it never becomes a respawn', () => {
    for (let n = 0; n <= MAX_NOOP_RESPAWNS + 2; n++) {
      expect(classifyNoOpSpawn({ ...empty, startupFailure: failure }, n).action).toBe('startup-failed')
    }
  })

  it('without a startup failure, an empty spawn still respawns then blocks (unchanged)', () => {
    expect(classifyNoOpSpawn({ ...empty, startupFailure: null }, 0).action).toBe('respawn')
    expect(classifyNoOpSpawn(empty, MAX_NOOP_RESPAWNS).action).toBe('block')
  })

  it('a real session is unaffected even if a stale failure is passed as null', () => {
    const d = classifyNoOpSpawn({ toolCalls: 12, filesCreated: 2, filesModified: 1, startupFailure: null }, 0)
    expect(d.action).toBe('none')
    expect(d.isNoOp).toBe(false)
  })
})
