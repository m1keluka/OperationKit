import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// obj 712954 — getSessionState end to end over a real transcript file: a
// trailing `result` with pending background work keeps a LIVE tmux session
// `working`; with nothing pending (or a dead tmux) it routes exactly as before.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pending-work-'))
process.env.TRANSCRIPT_DIR = DIR
process.env.DB_PATH = path.join(DIR, 'test.db')

const alive = new Set<string>()
vi.mock('./session-tmux.js', () => ({
  tmuxSessionAlive: (name: string) => alive.has(name),
}))

const { getSessionState, transcriptHasPendingWork } = await import('./session-control.js')

const J = (o: unknown) => JSON.stringify(o)
const now = () => new Date().toISOString()
function write(sessionId: string, lines: string[]): void {
  fs.writeFileSync(path.join(DIR, `${sessionId}.jsonl`), lines.join('\n') + '\n')
}
const wakeup = (inSeconds: number) =>
  J({
    type: 'user',
    timestamp: now(),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: `Next wakeup scheduled for 19:45:00 (in ${inSeconds}s).` }] },
  })
const result = J({ type: 'result', subtype: 'success', is_error: false, result: 'Waiting…', session_id: 's', uuid: 'r' })

beforeAll(() => {
  write('cc-1-1', [wakeup(1500), result])
  write('cc-2-2', [J({ type: 'assistant', timestamp: now(), message: { content: [{ type: 'text', text: 'done' }] } }), result])
  write('cc-3-3', [wakeup(1500)])
})
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }) })

describe('getSessionState with interim turn-end results', () => {
  it('result + pending ScheduleWakeup + tmux alive → working', () => {
    alive.add('cc-1-1')
    expect(getSessionState('cc-1-1')).toBe('working')
    expect(transcriptHasPendingWork('cc-1-1').reasons).toEqual(['wakeup'])
  })

  it('result + nothing pending + tmux alive → review (unchanged)', () => {
    alive.add('cc-2-2')
    expect(getSessionState('cc-2-2')).toBe('review')
  })

  it('tmux dead → today’s behaviour even with a pending wakeup (result → review)', () => {
    alive.delete('cc-1-1')
    expect(getSessionState('cc-1-1')).toBe('review')
  })

  it('no trailing result + tmux alive → working (unchanged)', () => {
    alive.add('cc-3-3')
    expect(getSessionState('cc-3-3')).toBe('working')
  })

  it('missing transcript → not pending (fail-safe)', () => {
    expect(transcriptHasPendingWork('cc-9-9').pending).toBe(false)
  })
})
