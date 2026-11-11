import { describe, it, expect } from 'vitest'
import {
  classifyAccountability,
  formatWaitingOn,
  isValidTerminalReason,
  needsTerminalReasonItem,
  parseWaitingOn,
} from './accountability.js'

// The §3.3 truth table, as tests (design acceptance A14). The classifier is pure
// and takes `now` as an argument precisely so every row below is deterministic.

const NOW = new Date('2026-11-09T12:00:00.000Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

describe('parseWaitingOn', () => {
  it('parses every typed party', () => {
    expect(parseWaitingOn('human:operator')).toMatchObject({ party: 'human', name: 'operator' })
    expect(parseWaitingOn('agent:operation-kit')).toMatchObject({ party: 'agent', name: 'operation-kit' })
    expect(parseWaitingOn('external:stripe')).toMatchObject({ party: 'external', name: 'stripe' })
    expect(parseWaitingOn('secret:APIFY_API_TOKEN')).toMatchObject({ party: 'secret', name: 'APIFY_API_TOKEN' })
    expect(parseWaitingOn('ci:601')).toMatchObject({ party: 'ci', name: '601' })
  })

  it('treats empty / nobody as waiting on nobody', () => {
    expect(parseWaitingOn(null).party).toBe('nobody')
    expect(parseWaitingOn('').party).toBe('nobody')
    expect(parseWaitingOn('  ').party).toBe('nobody')
    expect(parseWaitingOn('nobody').party).toBe('nobody')
    expect(parseWaitingOn('NOBODY').party).toBe('nobody')
  })

  it('degrades an unknown prefix to external rather than to nobody', () => {
    // The direction matters: mis-parsing a declared wait into "nobody" would let
    // the classifier call a genuinely waiting card `stalled` and page a human.
    const w = parseWaitingOn('martian:zorp')
    expect(w.party).toBe('external')
    expect(w.name).toBe('martian:zorp')
  })

  it('round-trips through formatWaitingOn', () => {
    for (const raw of ['nobody', 'human:operator', 'secret:FOO', 'ci:12']) {
      expect(formatWaitingOn(parseWaitingOn(raw))).toBe(raw)
    }
  })
})

describe('classifyAccountability — the truth table', () => {
  it('blocked: a raised blocker, declared, queued immediately', () => {
    const v = classifyAccountability({ status: 'working', has_blockers: 1, blocked_reason: 'needs a key' }, NOW)
    expect(v.state).toBe('blocked')
    expect(v.needs_human).toBe(true)
    expect(v.why).toContain('needs a key')
  })

  it('blocked: a reviewer verdict of blocked', () => {
    expect(classifyAccountability({ status: 'review', ai_review_verdict: 'blocked' }, NOW).state).toBe('blocked')
  })

  it('blocked: an outstanding secret request', () => {
    const v = classifyAccountability({ status: 'working', needs_secret: '[{"name":"FOO"},{"name":"BAR"}]' }, NOW)
    expect(v.state).toBe('blocked')
    expect(v.why).toContain('2 secrets')
  })

  it('blocked outranks waiting: a declared impediment wins over a named wait', () => {
    const v = classifyAccountability({ status: 'working', has_blockers: 1, waiting_on: 'agent:ops' }, NOW)
    expect(v.state).toBe('blocked')
  })

  it('waiting: a machine wait with a FUTURE check time is not queued and is not stalled', () => {
    const v = classifyAccountability(
      {
        status: 'working',
        waiting_on: 'ci:601',
        next_check_at: new Date(NOW.getTime() + 30 * 60_000).toISOString(),
        last_meaningful_progress_at: minutesAgo(10_000),
      },
      NOW,
      { stalledAfterMinutes: 60 },
    )
    expect(v.state).toBe('waiting')
    expect(v.needs_human).toBe(false)
  })

  it('waiting: a HUMAN waitee always surfaces, even with a future check time', () => {
    const v = classifyAccountability(
      { status: 'review', waiting_on: 'human:operator', next_check_at: new Date(NOW.getTime() + 60 * 60_000).toISOString() },
      NOW,
    )
    expect(v.state).toBe('waiting')
    expect(v.needs_human).toBe(true)
  })

  it('waiting: an overdue machine wait surfaces', () => {
    const v = classifyAccountability({ status: 'working', waiting_on: 'external:vendor', next_check_at: minutesAgo(5) }, NOW)
    expect(v.state).toBe('waiting')
    expect(v.needs_human).toBe(true)
    expect(v.why).toContain('check time has passed')
  })

  it('waiting: a wait with NO next_check_at surfaces — nothing would re-examine it', () => {
    const v = classifyAccountability({ status: 'working', waiting_on: 'external:vendor' }, NOW)
    expect(v.needs_human).toBe(true)
    expect(v.why).toContain('no next_check_at')
  })

  it('a waiting card is NEVER stalled, however long the wait', () => {
    // The n8n invariant: a paused thing is not a crashed thing.
    const v = classifyAccountability(
      { status: 'working', waiting_on: 'agent:ops', next_check_at: minutesAgo(10_000), last_meaningful_progress_at: minutesAgo(10_000) },
      NOW,
      { stalledAfterMinutes: 1 },
    )
    expect(v.state).toBe('waiting')
    expect(v.state).not.toBe('stalled')
  })

  it('on_track: a live session is progress by definition', () => {
    const v = classifyAccountability(
      { status: 'working', session_id: 'sess-1', last_meaningful_progress_at: minutesAgo(9999) },
      NOW,
      { stalledAfterMinutes: 10 },
    )
    expect(v.state).toBe('on_track')
    expect(v.needs_human).toBe(false)
  })

  it('on_track: progress inside the window', () => {
    const v = classifyAccountability({ status: 'working', last_meaningful_progress_at: minutesAgo(5) }, NOW, { stalledAfterMinutes: 60 })
    expect(v.state).toBe('on_track')
    expect(v.idle_minutes).toBe(5)
    expect(v.basis).toBe('last_meaningful_progress_at')
  })

  it('stalled: nobody declared anything and the window has passed', () => {
    const v = classifyAccountability({ status: 'working', last_meaningful_progress_at: minutesAgo(120) }, NOW, { stalledAfterMinutes: 60 })
    expect(v.state).toBe('stalled')
    expect(v.needs_human).toBe(true)
    expect(v.idle_minutes).toBe(120)
  })

  it('stalled inference is OFF until a human sets the window (design §10 M3)', () => {
    const card = { status: 'working', last_meaningful_progress_at: minutesAgo(100_000) }
    expect(classifyAccountability(card, NOW).state).toBe('on_track')
    expect(classifyAccountability(card, NOW, { stalledAfterMinutes: null }).state).toBe('on_track')
    expect(classifyAccountability(card, NOW, { stalledAfterMinutes: 0 }).state).toBe('on_track')
  })

  it('never calls a card stalled with no timestamp to measure from', () => {
    const v = classifyAccountability({ status: 'working' }, NOW, { stalledAfterMinutes: 1 })
    expect(v.state).toBe('on_track')
    expect(v.basis).toBe('none')
    expect(v.idle_minutes).toBeNull()
  })

  it('falls back to updated_at and LABELS that it did', () => {
    const v = classifyAccountability({ status: 'working', updated_at: minutesAgo(200) }, NOW, { stalledAfterMinutes: 60 })
    expect(v.state).toBe('stalled')
    expect(v.basis).toBe('updated_at')
    expect(v.why).toContain('predates meaningful-progress tracking')
  })

  it('reads SQLite space-separated timestamps as UTC, not local time', () => {
    // datetime('now') writes "YYYY-MM-DD HH:MM:SS" with no zone. Parsed as local
    // time it would be off by the host offset — invisible on a UTC box, wrong in
    // production.
    const v = classifyAccountability({ status: 'working', last_meaningful_progress_at: '2026-11-09 11:00:00' }, NOW, { stalledAfterMinutes: 1000 })
    expect(v.idle_minutes).toBe(60)
  })

  it('every card resolves to exactly one state', () => {
    const cards = [
      { status: 'working', has_blockers: 1 },
      { status: 'working', waiting_on: 'human:operator' },
      { status: 'working', session_id: 's' },
      { status: 'working', last_meaningful_progress_at: minutesAgo(999) },
    ]
    const states = cards.map((c) => classifyAccountability(c, NOW, { stalledAfterMinutes: 60 }).state)
    expect(states).toEqual(['blocked', 'waiting', 'on_track', 'stalled'])
  })
})

describe('terminal reasons', () => {
  it('accepts the typed set', () => {
    for (const r of ['delivered_merged', 'delivered_no_pr', 'cancelled_by_human', 'abandoned_no_output', 'superseded_by:900332', 'failed:gate red', 'expired_waiting_on:human:operator']) {
      expect(isValidTerminalReason(r)).toBe(true)
    }
  })

  it('rejects anything else, including a bare prefix', () => {
    for (const r of [null, '', '  ', 'done', 'merged', 'superseded_by', 'failed', 'failed:']) {
      expect(isValidTerminalReason(r)).toBe(false)
    }
  })

  it('a stopped card with no typed reason is itself a queue item', () => {
    expect(needsTerminalReasonItem({ status: 'done', terminal_reason: null })).toBe(true)
    expect(needsTerminalReasonItem({ status: 'cancelled', terminal_reason: 'nope' })).toBe(true)
    expect(needsTerminalReasonItem({ status: 'done', terminal_reason: 'delivered_merged' })).toBe(false)
    expect(needsTerminalReasonItem({ status: 'working', terminal_reason: null })).toBe(false)
  })
})
