// P0-1 (obj 707004) — the delegator's READ half.
//
// Before this change `delegation.ts` appended every [child-complete] block to the
// parent's NOTES.md and the server never read it back, while nudgeDelegator()
// debounced 4s without resetting an armed timer. N children finishing inside one
// window therefore produced ONE wake naming ZERO of them; N-1 results existed
// only in a file nobody read. This suite proves:
//   1. buildWakeMessage emits EVERY pending block plus an explicit count line.
//   2. 3 children completing inside one 4s debounce window all reach the wake.
//   3. fireWake genuinely re-reads NOTES.md (a block written by another writer,
//      never passed through appendChildResult, still shows up).
//   4. The pre-existing skip conditions survive: parent done/review suppresses
//      the wake (and does NOT drain the pending children), and a child in
//      ai_review early-returns without appending or nudging.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

const TMP_DB = path.join(os.tmpdir(), `cc-wake-readback-${process.pid}-${Date.now()}.db`)
const TMP_MEM = path.join(os.tmpdir(), `cc-wake-readback-mem-${process.pid}-${Date.now()}`)
process.env.DB_PATH = TMP_DB
process.env.CC_OBJ_MEMORY_BASE = TMP_MEM

// Capture the follow-up text without driving a real Claude session.
const sendFollowUp = vi.fn((sessionId: string, _message: string, _objective?: unknown) => `${sessionId}-resumed`)
vi.mock('./session-manager.js', () => ({
  sendFollowUp: (sessionId: string, message: string, objective?: unknown) =>
    sendFollowUp(sessionId, message, objective),
}))

/** The follow-up text captured from the Nth sendFollowUp call. */
const wakeText = (n = 0): string => sendFollowUp.mock.calls[n][1]

const { initDb, getDb } = await import('../db/index.js')
const {
  buildWakeMessage,
  appendChildResult,
  wakeDelegator,
  nudgeDelegator,
  fireWake,
  parseChildCompleteBlocks,
  collectPendingForWake,
  notesPathFor,
  __resetDelegationState,
} = await import('./delegation.js')

const WAKE_DEBOUNCE_MS = 4000

function seed(opts: {
  title: string
  status?: string
  parent_id?: number | null
  delegate_mode?: 0 | 1
}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, depth, delegate_mode)
       VALUES (?, 'cto', 'personal', ?, ?, 0, ?)`,
    )
    .run(opts.title, opts.status ?? 'working', opts.parent_id ?? null, opts.delegate_mode ?? 0)
  return r.lastInsertRowid as number
}

function child(id: number, title: string, status = 'done'): Objective {
  return {
    id,
    title,
    status,
    last_session_summary: `${title} finished its work`,
  } as unknown as Objective
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  fs.mkdirSync(TMP_MEM, { recursive: true })
  initDb()
})

beforeEach(() => {
  __resetDelegationState()
  sendFollowUp.mockClear()
  vi.useRealTimers()
})

afterAll(() => {
  vi.useRealTimers()
  try { getDb().close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  fs.rmSync(TMP_MEM, { recursive: true, force: true })
})

describe('buildWakeMessage — all pending blocks + count line', () => {
  it('emits every pending block and an explicit count line', () => {
    const blocks = [
      '### [child-complete] #11 — W1\n- status: done',
      '### [child-complete] #12 — W2\n- status: done',
      '### [child-complete] #13 — W3\n- status: done',
    ]
    const msg = buildWakeMessage(false, 0, { blocks, completeCount: 3, totalInNotes: 3 })
    expect(msg).toContain('3 children complete since your last wake, 3 summarized below (3 total in NOTES.md).')
    for (const b of blocks) expect(msg).toContain(b)
    // The instruction header is preserved ahead of the payload.
    expect(msg.startsWith('[child-complete] One or more of your worker objectives has finished.')).toBe(true)
  })

  it('flags a SHORTFALL when more children completed than are inlined', () => {
    const blocks = Array.from({ length: 25 }, (_, i) => `### [child-complete] #${i} — W${i}`)
    const msg = buildWakeMessage(false, 0, { blocks, completeCount: 25, totalInNotes: 25 })
    expect(msg).toContain('25 children complete since your last wake, 20 summarized below')
    expect(msg).toContain('SHORTFALL: 5 completed children are NOT inlined here')
  })

  it('is byte-identical to the pre-P0-1 text when nothing is pending', () => {
    expect(buildWakeMessage(false, 0, { blocks: [], completeCount: 0 })).toBe(buildWakeMessage(false))
    expect(buildWakeMessage(true, 0, { blocks: [], completeCount: 0 })).toBe(buildWakeMessage(true))
  })

  it('a strategy node also carries its pending blocks', () => {
    const msg = buildWakeMessage(true, 0, {
      blocks: ['### [child-complete] #91 — P1'],
      completeCount: 1,
      totalInNotes: 1,
    })
    expect(msg.startsWith('[project-complete]')).toBe(true)
    expect(msg).toContain('1 child complete since your last wake, 1 summarized below')
    expect(msg).toContain('#91 — P1')
  })
})

describe('parseChildCompleteBlocks — the read half', () => {
  it('splits NOTES.md into one block per [child-complete] heading', () => {
    const notes = [
      '# NOTES for delegator',
      '## CHILD REGISTRY',
      '- #1 W1',
      '',
      '### [child-complete] #1 — W1',
      '- status: done',
      '- summary: alpha',
      '',
      '### [child-complete] #2 — W2',
      '- status: done',
      '- summary: beta',
      '',
    ].join('\n')
    const blocks = parseChildCompleteBlocks(notes)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toContain('#1 — W1')
    expect(blocks[0]).toContain('summary: alpha')
    expect(blocks[1]).toContain('#2 — W2')
    // Registry prose above the first block is not swallowed into a block.
    expect(blocks[0]).not.toContain('CHILD REGISTRY')
  })

  it('ends a block at the next non-child-complete heading', () => {
    const blocks = parseChildCompleteBlocks(
      '### [child-complete] #5 — W5\n- status: done\n\n## Synthesis\nunrelated prose\n',
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).not.toContain('unrelated prose')
  })
})

describe('debounce drops nothing — 3 children inside one 4s window', () => {
  it('all 3 [child-complete] blocks appear in the single resulting wake', async () => {
    vi.useFakeTimers()
    const parent = seed({ title: 'delegator burst', delegate_mode: 1, status: 'working' })

    // Three workers finish 1s apart — all inside the 4s debounce window armed by
    // the first one. Pre-fix this produced ONE wake carrying ONE child's block.
    wakeDelegator(parent, child(101, 'W1'))
    vi.advanceTimersByTime(1000)
    wakeDelegator(parent, child(102, 'W2'))
    vi.advanceTimersByTime(1000)
    wakeDelegator(parent, child(103, 'W3'))

    expect(sendFollowUp).not.toHaveBeenCalled() // still coalescing
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS)

    expect(sendFollowUp).toHaveBeenCalledTimes(1) // exactly ONE wake — coalescing preserved
    const msg = wakeText()
    expect(msg).toContain('3 children complete since your last wake, 3 summarized below')
    expect(msg).toContain('### [child-complete] #101 — W1')
    expect(msg).toContain('### [child-complete] #102 — W2')
    expect(msg).toContain('### [child-complete] #103 — W3')

    // Delivered blocks are drained: a subsequent bare nudge carries no stale repeats.
    sendFollowUp.mockClear()
    nudgeDelegator(parent)
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS)
    const second = wakeText()
    expect(second).not.toContain('#101 — W1')
    expect(second).toBe(buildWakeMessage(false))
    vi.useRealTimers()
  })
})

describe('fireWake reads NOTES.md back from disk', () => {
  it('carries a [child-complete] block written by another writer (never in the pending set)', async () => {
    const parent = seed({ title: 'delegator readback', delegate_mode: 1, status: 'working' })
    const notes = notesPathFor(parent)
    fs.mkdirSync(path.dirname(notes), { recursive: true })
    // Written directly to the file — appendChildResult was never called, so the
    // ONLY way this can reach the wake is a genuine read of NOTES.md.
    fs.writeFileSync(
      notes,
      '## CHILD REGISTRY\n\n### [child-complete] #777 — offline worker\n- status: done\n- summary: written straight to disk\n',
    )

    await fireWake(parent)

    expect(sendFollowUp).toHaveBeenCalledTimes(1)
    const msg = wakeText()
    expect(msg).toContain('1 child complete since your last wake, 1 summarized below (1 total in NOTES.md).')
    expect(msg).toContain('#777 — offline worker')
    expect(msg).toContain('written straight to disk')
  })

  it('only reports blocks appended SINCE the previous wake', async () => {
    const parent = seed({ title: 'delegator since', delegate_mode: 1, status: 'working' })
    appendChildResult(parent, child(201, 'first'))
    await fireWake(parent)
    expect(wakeText()).toContain('#201 — first')

    sendFollowUp.mockClear()
    appendChildResult(parent, child(202, 'second'))
    await fireWake(parent)
    const msg = wakeText()
    expect(msg).toContain('1 child complete since your last wake, 1 summarized below (2 total in NOTES.md).')
    expect(msg).toContain('#202 — second')
    expect(msg).not.toContain('#201 — first')
  })

  it('keeps a child whose NOTES.md append is unavailable (memory fallback)', () => {
    const parent = seed({ title: 'delegator fallback', delegate_mode: 1, status: 'working' })
    const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => { throw new Error('EACCES') })
    appendChildResult(parent, child(301, 'unwritable'))
    spy.mockRestore()
    const pending = collectPendingForWake(parent)
    expect(pending.completeCount).toBe(1)
    expect(pending.blocks[0]).toContain('#301 — unwritable')
  })
})

describe('skip conditions preserved', () => {
  it('a child in ai_review early-returns: no NOTES.md append, no wake', async () => {
    vi.useFakeTimers()
    const parent = seed({ title: 'delegator ai_review', delegate_mode: 1, status: 'working' })
    wakeDelegator(parent, child(401, 'mid-review', 'ai_review'))
    await vi.advanceTimersByTimeAsync(WAKE_DEBOUNCE_MS)
    expect(sendFollowUp).not.toHaveBeenCalled()
    expect(fs.existsSync(notesPathFor(parent))).toBe(false)
    vi.useRealTimers()
  })

  it('a parent parked in review is NOT woken, and keeps its pending children', async () => {
    const parent = seed({ title: 'delegator parked', delegate_mode: 1, status: 'review' })
    appendChildResult(parent, child(501, 'W1'))
    await fireWake(parent)
    expect(sendFollowUp).not.toHaveBeenCalled()

    // Not drained — once the human un-parks it, the result is still carried.
    getDb().prepare("UPDATE objectives SET status = 'working' WHERE id = ?").run(parent)
    await fireWake(parent)
    expect(sendFollowUp).toHaveBeenCalledTimes(1)
    expect(wakeText()).toContain('#501 — W1')
  })

  it('a parent already done is NOT woken', async () => {
    const parent = seed({ title: 'delegator done', delegate_mode: 1, status: 'done' })
    appendChildResult(parent, child(601, 'W1'))
    await fireWake(parent)
    expect(sendFollowUp).not.toHaveBeenCalled()
  })

  it('a non-delegator parent is ignored', async () => {
    const parent = seed({ title: 'plain objective', delegate_mode: 0, status: 'working' })
    wakeDelegator(parent, child(701, 'W1'))
    await fireWake(parent)
    expect(sendFollowUp).not.toHaveBeenCalled()
  })
})
