import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { classifyNoOpSpawn, MAX_NOOP_RESPAWNS } from './poller-decisions.js'
import { extractDeterministic } from './session-intel-parse.js'

// obj 79 — "completed with no tools" is not "spawn never produced output".
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-noop-answer-'))
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }))
const J = (o: unknown) => JSON.stringify(o)
function transcript(name: string, lines: unknown[]): string {
  const p = path.join(DIR, `${name}.jsonl`)
  fs.writeFileSync(p, lines.map(J).join('\n') + '\n')
  return p
}
const empty = { toolCalls: 0, filesCreated: 0, filesModified: 0 }

describe('classifyNoOpSpawn — answer-only sessions', () => {
  it('0 tools + clean answered result → not a no-op, never respawned or blocked', () => {
    const d = classifyNoOpSpawn({ ...empty, durationMs: 120_000, completedWithAnswer: true }, 0)
    expect(d).toEqual({ isNoOp: false, action: 'none' })
  })

  it('even with the respawn budget exhausted it is not blocked', () => {
    const d = classifyNoOpSpawn({ ...empty, durationMs: 120_000, completedWithAnswer: true }, MAX_NOOP_RESPAWNS)
    expect(d.action).toBe('none')
  })

  it('a short answer-only session goes to human review without the AI reviewer (existing short-session rule)', () => {
    const d = classifyNoOpSpawn({ ...empty, durationMs: 5_000, completedWithAnswer: true }, 0)
    expect(d).toEqual({ isNoOp: false, action: 'skip-reviewer' })
  })

  it('a spawn that never produced output is still a no-op (unchanged)', () => {
    expect(classifyNoOpSpawn({ ...empty, completedWithAnswer: false }, 0)).toEqual({ isNoOp: true, action: 'respawn', attempt: 1 })
    expect(classifyNoOpSpawn(empty, 0)).toEqual({ isNoOp: true, action: 'respawn', attempt: 1 })
  })
})

describe('extractDeterministic — completedWithAnswer', () => {
  it('true for a clean success result with answer text and no tool calls', async () => {
    const p = transcript('answer', [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Paris.' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'Paris.', duration_ms: 4000, uuid: 'a1' },
    ])
    const intel = await extractDeterministic(p)
    expect(intel.toolCalls).toBe(0)
    expect(intel.completedWithAnswer).toBe(true)
    expect(intel.finalResultText).toBe('Paris.')
  })

  it('false when the transcript has no result (spawn never produced output)', async () => {
    const p = transcript('nothing', [{ type: 'system', subtype: 'init' }])
    expect((await extractDeterministic(p)).completedWithAnswer).toBe(false)
  })

  it('false when the terminal result is an error', async () => {
    const p = transcript('err', [
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Failed to authenticate', uuid: 'e1' },
    ])
    expect((await extractDeterministic(p)).completedWithAnswer).toBe(false)
  })

  it('false when the result text is empty', async () => {
    const p = transcript('blank', [{ type: 'result', subtype: 'success', is_error: false, result: '   ', uuid: 'b1' }])
    expect((await extractDeterministic(p)).completedWithAnswer).toBe(false)
  })

  it('false when the terminal turn is a 429 usage-limit cut', async () => {
    const p = transcript('limit', [
      { type: 'result', subtype: 'success', is_error: false, result: "You've hit your usage limit · resets 5pm", uuid: 'l1' },
    ])
    expect((await extractDeterministic(p)).completedWithAnswer).toBe(false)
  })

  it('only the TERMINAL turn counts: an answer followed by an errored turn is false', async () => {
    const p = transcript('then-err', [
      { type: 'result', subtype: 'success', is_error: false, result: 'ok', uuid: 'x1' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', uuid: 'x2' },
    ])
    expect((await extractDeterministic(p)).completedWithAnswer).toBe(false)
  })

  it('missing transcript → false', async () => {
    expect((await extractDeterministic(path.join(DIR, 'absent.jsonl'))).completedWithAnswer).toBeFalsy()
  })
})
