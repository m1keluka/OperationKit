import { describe, it, expect } from 'vitest'
import { classifyNoOpSpawn } from './state-poller.js'

// Objective 840: a worker `claude` process can exit near-instantly producing 0
// tool calls / 0 file changes. The pre-fix poller routed that empty tree to a
// reviewer (false FAIL + wasted bounce). classifyNoOpSpawn is the pure branch
// the poller now consults BEFORE spawning a reviewer.

const intel = (toolCalls: number, filesCreated: number, filesModified: number) => ({
  toolCalls,
  filesCreated,
  filesModified,
})

describe('classifyNoOpSpawn (0-tool worker spawn guard)', () => {
  it('a real session (tool calls > 0) → action none, never a no-op', () => {
    const d = classifyNoOpSpawn(intel(5, 1, 2), 0)
    expect(d.isNoOp).toBe(false)
    expect(d.action).toBe('none')
  })

  it('files modified but 0 tool calls is still real work → none', () => {
    // toolCalls counts Write/Edit etc.; in practice filesModified implies tools,
    // but the guard must not classify ANY file change as a no-op.
    expect(classifyNoOpSpawn(intel(0, 0, 1), 0).action).toBe('none')
    expect(classifyNoOpSpawn(intel(0, 1, 0), 0).action).toBe('none')
  })

  it('THE BUG: 0 tools / 0 created / 0 modified on first sight → respawn (NOT reviewed)', () => {
    const d = classifyNoOpSpawn(intel(0, 0, 0), 0)
    expect(d.isNoOp).toBe(true)
    expect(d.action).toBe('respawn')
    expect(d.attempt).toBe(1)
  })

  it('re-spawns are bounded and the attempt number increments', () => {
    expect(classifyNoOpSpawn(intel(0, 0, 0), 0).attempt).toBe(1)
    expect(classifyNoOpSpawn(intel(0, 0, 0), 1).attempt).toBe(2)
  })

  it('once the re-spawn budget is exhausted → block, never a silent done/false-FAIL', () => {
    // default cap MAX_NOOP_RESPAWNS = 2: priorAttempts 2 means 2 re-spawns already done.
    const d = classifyNoOpSpawn(intel(0, 0, 0), 2)
    expect(d.isNoOp).toBe(true)
    expect(d.action).toBe('block')
    expect(d.attempt).toBeUndefined()
  })

  it('honours a custom cap', () => {
    expect(classifyNoOpSpawn(intel(0, 0, 0), 0, 1).action).toBe('respawn')
    expect(classifyNoOpSpawn(intel(0, 0, 0), 1, 1).action).toBe('block')
  })

  it('boundary: attempts just under the cap respawns, exactly at the cap blocks', () => {
    expect(classifyNoOpSpawn(intel(0, 0, 0), 1, 2).action).toBe('respawn')
    expect(classifyNoOpSpawn(intel(0, 0, 0), 2, 2).action).toBe('block')
  })

  it('short session with tool calls but zero files → skip-reviewer (no extra Claude process)', () => {
    const d = classifyNoOpSpawn({ ...intel(8, 0, 0), durationMs: 20_000 }, 0)
    expect(d.isNoOp).toBe(false)
    expect(d.action).toBe('skip-reviewer')
  })

  it('short session WITH file changes is real work → none', () => {
    expect(classifyNoOpSpawn({ ...intel(8, 0, 1), durationMs: 20_000 }, 0).action).toBe('none')
  })

  it('long session with zero files is not skipped (might still be a real investigation)', () => {
    expect(classifyNoOpSpawn({ ...intel(8, 0, 0), durationMs: 120_000 }, 0).action).toBe('none')
  })

  it('missing duration does not skip-reviewer', () => {
    expect(classifyNoOpSpawn(intel(8, 0, 0), 0).action).toBe('none')
  })
})
