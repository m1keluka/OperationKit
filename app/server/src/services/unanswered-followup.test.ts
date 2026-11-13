import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import type { MessageSender, Objective } from '@operationkit/shared'
import {
  findUnansweredFollowUps,
  decideUnanswered,
  handleUnansweredFollowUp,
  giveUpText,
  __resetUnansweredState,
  MAX_RETRIES,
  MIN_AGE_MS,
  RETRY_GAP_MS,
  type UnansweredDeps,
} from './unanswered-followup.js'
import { initFollowUpQueueSchema, enqueueFollowUp, listPendingFollowUps, workerActivityMs } from './followup-queue.js'
import { acquireSessionLeasesForSpawn, ensureSessionLeaseTable } from './session-lease.js'

const casey: MessageSender = { kind: 'member', verified: true, label: 'Casey', username: 'casey' }
const SID = 'cc-900412-1794591995913'
const T0 = Date.parse('2026-11-13T17:46:36Z')
const iso = (ms: number) => new Date(ms).toISOString()
const line = (o: unknown) => JSON.stringify(o)

let tmp: string
beforeEach(() => {
  __resetUnansweredState()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unanswered-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function obj(over: Partial<Objective> = {}): Objective {
  return { id: 900412, status: 'working', session_id: SID, delegate_mode: 0, title: 't' , ...over } as unknown as Objective
}

describe('findUnansweredFollowUps', () => {
  it('finds the owner message that has no reply after it (the "????" shape)', () => {
    const lines = [
      line({ type: 'assistant', message: { content: [] } }),
      line({ type: 'result', result: 'PostHog is live' }),
      line({ type: 'followup', text: 'does the language match what Operator said?', sender: casey, timestamp: iso(T0) }),
      line({ type: 'system', subtype: 'init' }), // a resume that died right after init is still unanswered
    ]
    const got = findUnansweredFollowUps(lines)
    expect(got).toHaveLength(1)
    expect(got[0].text).toMatch(/language match/)
    expect(got[0].sender).toEqual(casey)
  })

  it('collects every trailing message, oldest first', () => {
    const lines = [
      line({ type: 'result', result: 'done' }),
      line({ type: 'followup', text: 'first', timestamp: iso(T0) }),
      line({ type: 'followup_delivery', count: 1, timestamp: iso(T0 + 1000) }),
      line({ type: 'followup', text: '????', timestamp: iso(T0 + 2000) }),
    ]
    expect(findUnansweredFollowUps(lines).map(m => m.text)).toEqual(['first', '????'])
  })

  it('returns nothing once the agent has replied', () => {
    const lines = [
      line({ type: 'followup', text: 'q', timestamp: iso(T0) }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] } }),
    ]
    expect(findUnansweredFollowUps(lines)).toEqual([])
  })

  it('stops at a visible error we already wrote, so a given-up message is not retried forever', () => {
    const lines = [
      line({ type: 'followup', text: 'q', timestamp: iso(T0) }),
      line({ type: 'error', text: giveUpText(2, null), timestamp: iso(T0 + 60_000) }),
    ]
    expect(findUnansweredFollowUps(lines)).toEqual([])
  })

  it('ignores the initial prompt event and garbage lines', () => {
    expect(findUnansweredFollowUps([line({ type: 'prompt', text: 'p' }), 'not json', ''])).toEqual([])
  })
})

describe('decideUnanswered', () => {
  const msgs = [{ text: 'q', sender: casey, timestamp: iso(T0) }]

  it('waits while the message is young (its own spawn may still be starting)', () => {
    expect(decideUnanswered(1, msgs, T0 + MIN_AGE_MS - 1).action).toBe('wait')
  })

  it('retries up to MAX_RETRIES, spaced by RETRY_GAP_MS, then gives up', () => {
    let now = T0 + MIN_AGE_MS
    const actions: string[] = []
    for (let i = 0; i < 8; i++) {
      actions.push(decideUnanswered(1, msgs, now).action)
      now += RETRY_GAP_MS / 2
    }
    expect(actions.filter(a => a === 'retry')).toHaveLength(MAX_RETRIES)
    expect(actions).toContain('give_up')
    expect(actions.indexOf('give_up')).toBeGreaterThan(actions.lastIndexOf('retry'))
  })

  it('a NEW message resets the budget', () => {
    let now = T0 + MIN_AGE_MS
    for (let i = 0; i < MAX_RETRIES; i++) { decideUnanswered(1, msgs, now); now += RETRY_GAP_MS }
    expect(decideUnanswered(1, msgs, now).action).toBe('give_up')
    const newer = [...msgs, { text: '????', sender: casey, timestamp: iso(now) }]
    expect(decideUnanswered(1, newer, now + MIN_AGE_MS).action).toBe('retry')
  })
})

describe('handleUnansweredFollowUp', () => {
  function setup(lines: string[]) {
    const jsonl = path.join(tmp, `${SID}.jsonl`)
    fs.writeFileSync(jsonl, lines.join('\n') + '\n')
    const calls: Array<{ sid: string; text: string }> = []
    let fail: Error | null = null
    let now = T0 + MIN_AGE_MS
    const deps: UnansweredDeps = {
      jsonlPathFor: () => jsonl,
      deliver: (sid, _m, _o, opts) => { if (fail) throw fail; calls.push({ sid, text: opts.sessionTextOverride }); return sid },
      stamp: (m) => `[stamp] ${m}`,
      noteStart: () => {},
      now: () => now,
      log: () => {},
    }
    return { jsonl, calls, deps, setFail: (e: Error | null) => { fail = e }, advance: (ms: number) => { now += ms } }
  }

  it('re-sends the unanswered message to the SAME session and holds the card', () => {
    const s = setup([line({ type: 'result' }), line({ type: 'followup', text: 'answer?', sender: casey, timestamp: iso(T0) })])
    expect(handleUnansweredFollowUp(obj(), s.deps)).toBe(true)
    expect(s.calls).toEqual([{ sid: SID, text: '[stamp] answer?' }])
  })

  it('after the retries fail, writes a visible error into the thread and lets the card route', () => {
    const s = setup([line({ type: 'result' }), line({ type: 'followup', text: 'hello ???', sender: casey, timestamp: iso(T0) })])
    s.setFail(new Error('All Claude seats are unavailable'))
    const held: boolean[] = []
    for (let i = 0; i < 10; i++) { held.push(handleUnansweredFollowUp(obj(), s.deps)); s.advance(RETRY_GAP_MS) }
    expect(held).toContain(false)
    const tail = fs.readFileSync(s.jsonl, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    const err = tail.filter(e => e.type === 'error')
    expect(err).toHaveLength(1)
    expect(err[0].text).toMatch(/did not start for your last message/)
    expect(err[0].text).toMatch(/seats are unavailable/)
    // Once the error is written the message is no longer "unanswered": no more retries.
    expect(handleUnansweredFollowUp(obj(), s.deps)).toBe(false)
  })

  it('does nothing when the last message was answered', () => {
    const s = setup([line({ type: 'followup', text: 'q', timestamp: iso(T0) }), line({ type: 'result' })])
    expect(handleUnansweredFollowUp(obj(), s.deps)).toBe(false)
    expect(s.calls).toHaveLength(0)
  })

  it('skips delegators and non-working cards', () => {
    const s = setup([line({ type: 'followup', text: 'q', timestamp: iso(T0) })])
    expect(handleUnansweredFollowUp(obj({ delegate_mode: true }), s.deps)).toBe(false)
    expect(handleUnansweredFollowUp(obj({ status: 'review' }), s.deps)).toBe(false)
    expect(s.calls).toHaveLength(0)
  })
})

describe('workerActivityMs (queued bubbles are not worker activity)', () => {
  it('uses the oldest pending message time when the transcript ends in our queued bubbles', () => {
    const db = new Database(':memory:')
    initFollowUpQueueSchema(db)
    const jsonl = path.join(tmp, 'w.jsonl')
    fs.writeFileSync(jsonl, [line({ type: 'assistant' }), line({ type: 'followup', text: '?', queued: true, timestamp: iso(T0) })].join('\n') + '\n')
    enqueueFollowUp(db, 1, SID, '?')
    db.prepare("UPDATE followup_queue SET created_at = '2026-11-13T17:00:00.000Z'").run()
    const pending = listPendingFollowUps(db, 1)
    expect(workerActivityMs(jsonl, pending)).toBe(Date.parse('2026-11-13T17:00:00.000Z'))
  })

  it('uses the file mtime when the worker wrote after the bubble', () => {
    const db = new Database(':memory:')
    initFollowUpQueueSchema(db)
    const jsonl = path.join(tmp, 'w2.jsonl')
    fs.writeFileSync(jsonl, [line({ type: 'followup', text: '?', queued: true }), line({ type: 'assistant' })].join('\n') + '\n')
    enqueueFollowUp(db, 1, SID, '?')
    db.prepare("UPDATE followup_queue SET created_at = '2026-11-13T17:00:00.000Z'").run()
    expect(workerActivityMs(jsonl, listPendingFollowUps(db, 1))).toBe(fs.statSync(jsonl).mtimeMs)
  })

  it('no pending messages → plain mtime', () => {
    const jsonl = path.join(tmp, 'w3.jsonl')
    fs.writeFileSync(jsonl, line({ type: 'followup', text: '?', queued: true }) + '\n')
    expect(workerActivityMs(jsonl, [])).toBe(fs.statSync(jsonl).mtimeMs)
  })
})

describe('ghost identity lease (card #900412, 2026-11-13 17:46)', () => {
  it('a start that claimed the lease but never spawned leaves a row the next start "reattaches" to', () => {
    // This is the precondition the session-start fix guards: the lease layer
    // alone cannot tell a ghost from a live worker, so startSession must check
    // liveness (leaseHolderIsLive) before attaching.
    const db = new Database(':memory:')
    ensureSessionLeaseTable(db)
    const o = { id: 900412, parent_id: null, title: 'Command Center not responding right away' }
    expect(acquireSessionLeasesForSpawn(db, o, 'cc-900412-1794591995913').status).toBe('acquired')
    // …that start threw before spawnInTmux. 90 ms later a retry:
    const second = acquireSessionLeasesForSpawn(db, o, 'cc-900412-1794591996003')
    expect(second.status).toBe('reattached')
    expect(second.holder.session_id).toBe('cc-900412-1794591995913')
  })
})
