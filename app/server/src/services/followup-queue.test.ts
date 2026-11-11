import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import type { MessageSender, Objective } from '@operationkit/shared'
import {
  initFollowUpQueueSchema,
  decideFollowUpQueue,
  resolveFollowUpQueueConfig,
  enqueueFollowUp,
  listPendingFollowUps,
  takePendingFollowUps,
  releaseFollowUps,
  dropPendingFollowUps,
  combineQueuedFollowUps,
  batchSender,
  deliverQueuedFollowUps,
  transcriptMtimeMs,
  FOLLOWUP_DELIVERY_EVENT_TYPE,
  DEFAULT_STALE_MINUTES,
  type DeliverFn,
  type QueueDecisionInput,
} from './followup-queue.js'

const casey: MessageSender = { kind: 'member', verified: true, label: 'Casey', username: 'casey' }
const bot: MessageSender = { kind: 'agent', verified: false, label: 'Ops bot', username: null }
const SID = 'cc-900408-1794247226000'
const NOW = Date.parse('2026-11-09T18:57:00Z')

let db: Database.Database
let tmp: string

beforeEach(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  initFollowUpQueueSchema(db)
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fq-test-'))
})
afterEach(() => {
  db.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function input(over: Partial<QueueDecisionInput> = {}): QueueDecisionInput {
  return {
    config: { enabled: true, staleMs: DEFAULT_STALE_MINUTES * 60_000 },
    status: 'working',
    sessionId: SID,
    currentSessionId: SID,
    sessionState: 'working',
    transcriptMtimeMs: NOW - 20_000,
    nowMs: NOW,
    ...over,
  }
}

describe('decideFollowUpQueue', () => {
  it('queues a message for a live worker that is mid-turn and recently active', () => {
    expect(decideFollowUpQueue(input())).toEqual({ queue: true })
  })

  it('restarts as before when the turn already ended (last event is a result)', () => {
    expect(decideFollowUpQueue(input({ sessionState: 'review' }))).toEqual({ queue: false, reason: 'not_mid_turn' })
    expect(decideFollowUpQueue(input({ sessionState: 'dead' }))).toEqual({ queue: false, reason: 'not_mid_turn' })
  })

  it('treats a worker silent past the stale window as hung, so the message can restart it', () => {
    const staleMs = DEFAULT_STALE_MINUTES * 60_000
    expect(decideFollowUpQueue(input({ transcriptMtimeMs: NOW - staleMs - 1 }))).toEqual({ queue: false, reason: 'stale' })
    expect(decideFollowUpQueue(input({ transcriptMtimeMs: NOW - staleMs + 1000 }))).toEqual({ queue: true })
    expect(decideFollowUpQueue(input({ transcriptMtimeMs: null }))).toEqual({ queue: false, reason: 'no_transcript' })
  })

  it('only applies to the card\'s current worker session while the card is working', () => {
    expect(decideFollowUpQueue(input({ status: 'review' }))).toEqual({ queue: false, reason: 'not_working' })
    expect(decideFollowUpQueue(input({ currentSessionId: 'cc-900408-1' }))).toEqual({ queue: false, reason: 'not_current' })
    expect(decideFollowUpQueue(input({ sessionId: 'cc-review-900408-1', currentSessionId: 'cc-review-900408-1' }))).toEqual({ queue: false, reason: 'not_worker' })
    expect(decideFollowUpQueue(input({ sessionId: 'cc-plan-900408-1', currentSessionId: 'cc-plan-900408-1' }))).toEqual({ queue: false, reason: 'not_worker' })
  })

  it('kill switch restores the old restart-on-every-message behaviour', () => {
    expect(decideFollowUpQueue(input({ config: { enabled: false, staleMs: 1e9 } }))).toEqual({ queue: false, reason: 'disabled' })
  })
})

describe('resolveFollowUpQueueConfig', () => {
  it('defaults to enabled with a 5-minute stale window', () => {
    expect(resolveFollowUpQueueConfig(db)).toEqual({ enabled: true, staleMs: 5 * 60_000 })
  })
  it('reads the kill switch and stale window from settings', () => {
    db.prepare("INSERT INTO settings VALUES ('followup_queue_enabled', '0'), ('followup_queue_stale_minutes', '12')").run()
    expect(resolveFollowUpQueueConfig(db)).toEqual({ enabled: false, staleMs: 12 * 60_000 })
  })
  it('ignores a nonsense stale window', () => {
    db.prepare("INSERT INTO settings VALUES ('followup_queue_stale_minutes', 'abc')").run()
    expect(resolveFollowUpQueueConfig(db).staleMs).toBe(5 * 60_000)
  })
})

describe('queue storage', () => {
  it('takes pending messages once, oldest first; release puts them back; drop clears them', () => {
    enqueueFollowUp(db, 900408, SID, 'first', casey)
    enqueueFollowUp(db, 900408, SID, 'second', casey)
    enqueueFollowUp(db, 1, 'cc-1-1', 'other card', casey)

    const taken = takePendingFollowUps(db, 900408)
    expect(taken.map(t => t.message)).toEqual(['first', 'second'])
    expect(taken[0].sender).toEqual(casey)
    expect(takePendingFollowUps(db, 900408)).toEqual([])

    releaseFollowUps(db, taken.map(t => t.id))
    expect(listPendingFollowUps(db, 900408).map(t => t.message)).toEqual(['first', 'second'])

    expect(dropPendingFollowUps(db, 900408, 'stopped')).toBe(2)
    expect(listPendingFollowUps(db, 900408)).toEqual([])
    expect(listPendingFollowUps(db, 1).map(t => t.message)).toEqual(['other card'])
  })

  it('reads as empty (never throws) when the table does not exist', () => {
    const bare = new Database(':memory:')
    expect(listPendingFollowUps(bare, 1)).toEqual([])
    expect(dropPendingFollowUps(bare, 1, 'x')).toBe(0)
    bare.close()
  })
})

describe('combineQueuedFollowUps / batchSender', () => {
  const stamp = (m: string, s?: MessageSender) => `[${s?.label ?? 'SYSTEM'}] ${m}`

  it('passes a single message through with its own stamp', () => {
    expect(combineQueuedFollowUps([{ message: 'hi', sender: casey }], stamp)).toBe('[Casey] hi')
  })

  it('numbers several messages in order, each keeping its own stamp', () => {
    const text = combineQueuedFollowUps(
      [{ message: 'does the site match what Operator said?', sender: casey }, { message: '????????', sender: casey }, { message: 'fyi', sender: bot }],
      stamp,
    )
    expect(text).toContain('3 messages arrived')
    expect(text.indexOf('Message 1 of 3')).toBeLessThan(text.indexOf('Message 2 of 3'))
    expect(text).toContain('[Casey] does the site match what Operator said?')
    expect(text).toContain('[Ops bot] fyi')
  })

  it('records the least-trusted sender for a mixed batch', () => {
    expect(batchSender([{ sender: casey }, { sender: bot }])).toEqual(bot)
    expect(batchSender([{ sender: casey }, { sender: casey }])).toEqual(casey)
    expect(batchSender([{ sender: null }])).toBeUndefined()
  })
})

describe('deliverQueuedFollowUps', () => {
  const objective = { id: 900408, session_id: SID } as Objective

  function setup(deliver: DeliverFn) {
    const jsonl = path.join(tmp, `${SID}.jsonl`)
    const started: Array<[number, string | null]> = []
    const deps = {
      db,
      deliver,
      stamp: (m: string) => m,
      jsonlPathFor: () => jsonl,
      noteStart: (id: number, actor: string | null) => { started.push([id, actor]) },
    }
    return { jsonl, started, deps }
  }

  it('does nothing when nothing was queued, so the card parks as before', () => {
    let calls = 0
    const { deps } = setup(() => { calls++; return SID })
    expect(deliverQueuedFollowUps(objective, deps)).toBe(false)
    expect(calls).toBe(0)
  })

  it('#900408 replay: four messages sent mid-turn reach the SAME session in ONE resume', () => {
    // Before obj 900412 each of these restarted the worker (four `resume` starts in 39s).
    for (const m of ['can you check the deploy', '????????', 'answer?', 'hello ???']) enqueueFollowUp(db, 900408, SID, m, casey)
    const calls: Array<{ sid: string; text: string; skipJsonl: boolean }> = []
    const { deps, jsonl, started } = setup((sid, _msg, _obj, opts) => { calls.push({ sid, text: opts.sessionTextOverride, skipJsonl: opts.skipJsonl }); return sid })
    fs.writeFileSync(jsonl, JSON.stringify({ type: 'result', text: 'done with the turn' }) + '\n')

    expect(deliverQueuedFollowUps(objective, deps)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].sid).toBe(SID)
    expect(calls[0].skipJsonl).toBe(true) // bubbles were already written at enqueue time
    for (const m of ['can you check the deploy', '????????', 'answer?', 'hello ???']) expect(calls[0].text).toContain(m)
    expect(started).toEqual([[900408, 'casey']])
    expect(listPendingFollowUps(db, 900408)).toEqual([])

    // The last transcript event is no longer the old `result`, so the poller
    // reads the resumed session as working, not finished.
    const last = JSON.parse(fs.readFileSync(jsonl, 'utf8').trim().split('\n').pop()!)
    expect(last).toMatchObject({ type: FOLLOWUP_DELIVERY_EVENT_TYPE, count: 4 })
  })

  it('a failed delivery keeps the messages for the next send and lets the card park', () => {
    enqueueFollowUp(db, 900408, SID, 'hello?', casey)
    const { deps } = setup(() => { throw new Error('no seat') })
    expect(deliverQueuedFollowUps(objective, deps)).toBe(false)
    expect(listPendingFollowUps(db, 900408).map(m => m.message)).toEqual(['hello?'])
  })

  it('transcriptMtimeMs reads a real file and returns null for a missing one', () => {
    const f = path.join(tmp, 'x.jsonl')
    fs.writeFileSync(f, '{}\n')
    expect(typeof transcriptMtimeMs(f)).toBe('number')
    expect(transcriptMtimeMs(path.join(tmp, 'missing.jsonl'))).toBeNull()
  })
})
