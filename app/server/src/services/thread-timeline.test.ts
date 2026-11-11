import { describe, it, expect } from 'vitest'
import type { SessionMessage } from '@operationkit/shared'
import { buildThreadTimeline, buildThreadTimelineCached, evictTimelineCache } from './thread-timeline.js'

// Builds a SessionMessage of a given kind with minimal fields. Timestamps are
// derived from the index so assertions can pin them deterministically.
function msg(type: SessionMessage['type'], extra: Partial<SessionMessage> = {}): SessionMessage {
  return { type, timestamp: `t${extra.text ?? ''}`, ...extra }
}
const tool = () => msg('tool', { toolName: 'Bash', toolInput: 'echo hi' })
const asst = (text: string) => msg('assistant', { text, timestamp: `ts-${text}` })

describe('buildThreadTimeline', () => {
  it('returns [] for empty input', () => {
    expect(buildThreadTimeline([])).toEqual([])
  })

  it('single result only → one summary segment, no actions', () => {
    const result: SessionMessage = { type: 'result', text: 'done', cost: 1.5, duration: 1200, timestamp: 'tr' }
    const segs = buildThreadTimeline([result])
    expect(segs).toEqual([
      { type: 'summary', index: 0, text: 'done', cost: 1.5, duration: 1200, timestamp: 'tr' },
    ])
  })

  it('leading gap then result: [tool, tool, assistant, result] → actions{count:3,toolCount:2} then summary', () => {
    const messages: SessionMessage[] = [
      tool(),
      tool(),
      asst('thinking'),
      { type: 'result', text: 'finished', cost: 2, duration: 500, timestamp: 'tr' },
    ]
    const segs = buildThreadTimeline(messages)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ type: 'actions', startIndex: 0, endIndex: 3, count: 3, toolCount: 2 })
    expect(segs[1]).toEqual({ type: 'summary', index: 3, text: 'finished', cost: 2, duration: 500, timestamp: 'tr' })
  })

  it('two wakes: [tool×3, result, followup, tool×2, result] → actions, summary, divider, actions, summary', () => {
    const messages: SessionMessage[] = [
      tool(), tool(), tool(),
      { type: 'result', text: 'wake1 done', cost: 1, duration: 100, timestamp: 'tr1' },
      { type: 'followup', text: 'child complete', timestamp: 'tf' },
      tool(), tool(),
      { type: 'result', text: 'wake2 done', cost: 3, duration: 300, timestamp: 'tr2' },
    ]
    const segs = buildThreadTimeline(messages)
    expect(segs).toHaveLength(5)
    expect(segs[0]).toEqual({ type: 'actions', startIndex: 0, endIndex: 3, count: 3, toolCount: 3 })
    expect(segs[1]).toEqual({ type: 'summary', index: 3, text: 'wake1 done', cost: 1, duration: 100, timestamp: 'tr1' })
    // divider sits between the two wakes
    expect(segs[2]).toEqual({ type: 'divider', index: 4, text: 'child complete', timestamp: 'tf' })
    expect(segs[3]).toEqual({ type: 'actions', startIndex: 5, endIndex: 7, count: 2, toolCount: 2 })
    expect(segs[4]).toEqual({ type: 'summary', index: 7, text: 'wake2 done', cost: 3, duration: 300, timestamp: 'tr2' })
  })

  it('collapses a stack of [child-complete] wakes into one divider and the latest summary', () => {
    // Parent does work, then four identical worker-finished pings each spawn a
    // session (obj 707801 had 28 of these). Keep the original summary; fold the
    // ping stack.
    const child = (n: number): SessionMessage => ({
      type: 'followup',
      text: '[child-complete] One or more of your worker objectives has finished.',
      timestamp: `tf${n}`,
    })
    const result = (n: number, text: string): SessionMessage => ({
      type: 'result', text, cost: 1, duration: 10, timestamp: `tr${n}`,
    })
    const messages: SessionMessage[] = [
      tool(), tool(), result(0, 'spawned workers'),
      child(1), tool(), result(1, 'wake1'),
      child(2), tool(), result(2, 'wake2'),
      child(3), tool(), result(3, 'wake3'),
      child(4), tool(), result(4, 'latest synthesis'),
    ]
    const segs = buildThreadTimeline(messages)
    expect(segs.map(s => s.type)).toEqual(['actions', 'summary', 'actions', 'divider', 'summary'])
    expect(segs[1]).toMatchObject({ type: 'summary', text: 'spawned workers' })
    expect(segs[2]).toMatchObject({ type: 'actions', startIndex: 4, endIndex: 14, count: 4, toolCount: 4 })
    expect(segs[3]).toMatchObject({ type: 'divider', text: '[child-complete] ×4' })
    expect(segs[4]).toMatchObject({ type: 'summary', text: 'latest synthesis' })
    expect(segs.filter(s => s.type === 'summary')).toHaveLength(2)
  })

  it('does not collapse a human follow-up sitting between machine wakes', () => {
    const messages: SessionMessage[] = [
      tool(),
      { type: 'result', text: 'first', cost: 1, duration: 1, timestamp: 'tr1' },
      { type: 'followup', text: 'Operator: keep going on the spreadsheet', timestamp: 'tf-human' },
      tool(),
      { type: 'result', text: 'second', cost: 1, duration: 1, timestamp: 'tr2' },
      { type: 'followup', text: '[child-complete] One or more of your worker objectives has finished.', timestamp: 'tf-child' },
      tool(),
      { type: 'result', text: 'after child', cost: 1, duration: 1, timestamp: 'tr3' },
    ]
    const segs = buildThreadTimeline(messages)
    expect(segs.some(s => s.type === 'divider' && s.text.includes('keep going'))).toBe(true)
    expect(segs.some(s => s.type === 'summary' && s.text === 'first')).toBe(true)
    expect(segs.some(s => s.type === 'summary' && s.text === 'second')).toBe(true)
    expect(segs.some(s => s.type === 'summary' && s.text === 'after child')).toBe(true)
    expect(segs.filter(s => s.type === 'divider' && s.text.startsWith('[child-complete]'))).toHaveLength(1)
  })

  it('trailing in-progress: [tool, result, followup, tool, tool, assistant] → trailing actions then question (assistant surfaced, not folded)', () => {
    const messages: SessionMessage[] = [
      tool(),
      { type: 'result', text: 'r1', cost: 1, duration: 10, timestamp: 'tr1' },
      { type: 'followup', text: 'go again', timestamp: 'tf' },
      tool(), tool(),
      asst('what should I do next?'),
    ]
    const segs = buildThreadTimeline(messages)
    expect(segs).toHaveLength(5)
    expect(segs[0]).toEqual({ type: 'actions', startIndex: 0, endIndex: 1, count: 1, toolCount: 1 })
    expect(segs[1]).toEqual({ type: 'summary', index: 1, text: 'r1', cost: 1, duration: 10, timestamp: 'tr1' })
    expect(segs[2]).toEqual({ type: 'divider', index: 2, text: 'go again', timestamp: 'tf' })
    // trailing region [3,6): tools at 3,4 collapse; assistant at 5 promoted to question
    expect(segs[3]).toEqual({ type: 'actions', startIndex: 3, endIndex: 5, count: 2, toolCount: 2 })
    expect(segs[4]).toEqual({ type: 'question', index: 5, text: 'what should I do next?', timestamp: 'ts-what should I do next?' })
  })

  it('error mid-thread emits an error segment and flushes its preceding gap', () => {
    const messages: SessionMessage[] = [
      tool(), tool(),
      { type: 'error', text: 'boom', timestamp: 'te' },
      { type: 'result', text: 'recovered', cost: 0, duration: 5, timestamp: 'tr' },
    ]
    const segs = buildThreadTimeline(messages)
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ type: 'actions', startIndex: 0, endIndex: 2, count: 2, toolCount: 2 })
    expect(segs[1]).toEqual({ type: 'error', index: 2, text: 'boom', timestamp: 'te' })
    expect(segs[2]).toEqual({ type: 'summary', index: 3, text: 'recovered', cost: 0, duration: 5, timestamp: 'tr' })
  })

  it('assistant-before-result is folded (not promoted): [tool, assistant, result] → actions{count:2,toolCount:1} then summary', () => {
    const messages: SessionMessage[] = [
      tool(),
      asst('about to finish'),
      { type: 'result', text: 'done', cost: 1, duration: 9, timestamp: 'tr' },
    ]
    const segs = buildThreadTimeline(messages)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toEqual({ type: 'actions', startIndex: 0, endIndex: 2, count: 2, toolCount: 1 })
    expect(segs[1]).toEqual({ type: 'summary', index: 2, text: 'done', cost: 1, duration: 9, timestamp: 'tr' })
    // No question segment exists anywhere.
    expect(segs.some(s => s.type === 'question')).toBe(false)
  })

  // Extra coverage: trailing assistant with no trailing tools, and trailing
  // tools with no assistant.
  it('trailing assistant immediately after result (no trailing tools) → no empty actions, just question', () => {
    const messages: SessionMessage[] = [
      { type: 'result', text: 'r', cost: 1, duration: 1, timestamp: 'tr' },
      asst('still working'),
    ]
    const segs = buildThreadTimeline(messages)
    expect(segs).toHaveLength(2)
    expect(segs[0].type).toBe('summary')
    expect(segs[1]).toEqual({ type: 'question', index: 1, text: 'still working', timestamp: 'ts-still working' })
  })

  it('trailing tools with no assistant → single trailing actions, never a count:0 segment', () => {
    const messages: SessionMessage[] = [
      { type: 'result', text: 'r', cost: 1, duration: 1, timestamp: 'tr' },
      tool(), tool(),
    ]
    const segs = buildThreadTimeline(messages)
    expect(segs).toHaveLength(2)
    expect(segs[0].type).toBe('summary')
    expect(segs[1]).toEqual({ type: 'actions', startIndex: 1, endIndex: 3, count: 2, toolCount: 2 })
    expect(segs.every(s => s.type !== 'actions' || s.count > 0)).toBe(true)
  })

  it('long trailing tail (no assistant) splits into an earlier collapsed gap + a bounded live tail of the last 40', () => {
    // result, then 100 tools with no trailing assistant. The live tail (last
    // segment) must be exactly the most-recent 40; the rest collapses above it.
    const messages: SessionMessage[] = [
      { type: 'result', text: 'r', cost: 1, duration: 1, timestamp: 'tr' },
      ...Array.from({ length: 100 }, () => tool()),
    ]
    const segs = buildThreadTimeline(messages)
    expect(segs).toHaveLength(3)
    expect(segs[0].type).toBe('summary')
    // earlier collapsed gap: [1, 61) — the older 60 messages
    expect(segs[1]).toEqual({ type: 'actions', startIndex: 1, endIndex: 61, count: 60, toolCount: 60 })
    // bounded live tail (last segment): the most-recent 40 messages
    expect(segs[2]).toEqual({ type: 'actions', startIndex: 61, endIndex: 101, count: 40, toolCount: 40 })
  })

  it('long trailing tail after the promoted question is capped to the last 40', () => {
    // result, followup, one assistant (promoted to question), then 100 tools.
    // Everything after the question is the live tail → capped to 40.
    const messages: SessionMessage[] = [
      { type: 'result', text: 'r', cost: 1, duration: 1, timestamp: 'tr' },
      { type: 'followup', text: 'go', timestamp: 'tf' },
      asst('on it'),
      ...Array.from({ length: 100 }, () => tool()),
    ]
    const segs = buildThreadTimeline(messages)
    // summary, divider, question, earlier gap, bounded tail
    expect(segs).toHaveLength(5)
    expect(segs[2]).toEqual({ type: 'question', index: 2, text: 'on it', timestamp: 'ts-on it' })
    // trailing region is [3, 103): earlier [3, 63) collapses, tail [63, 103) = last 40
    expect(segs[3]).toEqual({ type: 'actions', startIndex: 3, endIndex: 63, count: 60, toolCount: 60 })
    expect(segs[4]).toEqual({ type: 'actions', startIndex: 63, endIndex: 103, count: 40, toolCount: 40 })
  })
})

describe('buildThreadTimelineCached', () => {
  const mkResult = (text: string): SessionMessage => ({ type: 'result', text, cost: 1, duration: 1, timestamp: `t-${text}` })

  it('returns a cached segment reference when the message count is unchanged', () => {
    const sid = 'cache-stable'
    evictTimelineCache(sid)
    const messages: SessionMessage[] = [tool(), tool(), mkResult('a')]
    const first = buildThreadTimelineCached(sid, messages)
    const second = buildThreadTimelineCached(sid, messages)
    // Same object identity => no O(n) rebuild happened on the second poll.
    expect(second).toBe(first)
    // And it equals the pure builder's output.
    expect(first).toEqual(buildThreadTimeline(messages))
  })

  it('rebuilds when the message count grows (new message arrived)', () => {
    const sid = 'cache-grow'
    evictTimelineCache(sid)
    const base: SessionMessage[] = [tool(), mkResult('a')]
    const first = buildThreadTimelineCached(sid, base)
    const grown: SessionMessage[] = [...base, tool(), mkResult('b')]
    const second = buildThreadTimelineCached(sid, grown)
    expect(second).not.toBe(first)
    expect(second).toEqual(buildThreadTimeline(grown))
    // The new result anchor is present.
    expect(second.some(s => s.type === 'summary' && s.text === 'b')).toBe(true)
  })

  it('evictTimelineCache forces a fresh build', () => {
    const sid = 'cache-evict'
    evictTimelineCache(sid)
    const messages: SessionMessage[] = [tool(), mkResult('a')]
    const first = buildThreadTimelineCached(sid, messages)
    evictTimelineCache(sid)
    const second = buildThreadTimelineCached(sid, messages)
    expect(second).not.toBe(first) // new array, cache was cleared
    expect(second).toEqual(first)  // but same content
  })

  it('keys by session id — two sessions do not collide', () => {
    evictTimelineCache('s1'); evictTimelineCache('s2')
    const a = buildThreadTimelineCached('s1', [mkResult('one')])
    const b = buildThreadTimelineCached('s2', [tool(), mkResult('two')])
    expect(a).not.toBe(b)
    expect(a[0]).toMatchObject({ type: 'summary', text: 'one' })
    expect(b.some(s => s.type === 'summary' && s.text === 'two')).toBe(true)
  })
})
