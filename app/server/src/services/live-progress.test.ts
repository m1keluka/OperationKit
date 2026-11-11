import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

// Unit tests for the live-progress service (obj 715699): input normalization,
// write/read redaction, cursor paging and the transcript fallback. Uses a private
// in-memory DB — recordProgress lazily creates its own table, no initDb needed.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-progress-'))
process.env.TRANSCRIPT_DIR = TMP

const {
  normalizeProgressInput,
  recordProgress,
  listProgress,
  latestProgress,
  deriveProgressFromJsonl,
  deriveTranscriptProgress,
  ProgressValidationError,
  MAX_NOTE,
} = await import('./objective-progress.js')

const SECRET = 'abcd1234efgh5678ijkl'
const GHP = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'

let db: Database.Database

beforeAll(() => {
  process.env.TEST_FAKE_API_KEY = SECRET
})
beforeEach(() => {
  db = new Database(':memory:')
})
afterAll(() => {
  delete process.env.TEST_FAKE_API_KEY
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('normalizeProgressInput', () => {
  it('rejects step > total_steps', () => {
    expect(() => normalizeProgressInput({ step: 5, total_steps: 3 })).toThrow(ProgressValidationError)
    expect(() => normalizeProgressInput({ step: 5, total_steps: 3 })).toThrow(/exceed/)
  })

  it('accepts step == total_steps', () => {
    expect(normalizeProgressInput({ step: 3, total_steps: 3 }).step).toBe(3)
  })

  it('rejects an empty payload', () => {
    expect(() => normalizeProgressInput({})).toThrow(/at least one/)
    expect(() => normalizeProgressInput({ note: '   ', label: '' })).toThrow(ProgressValidationError)
  })

  it('rejects non-object bodies and negative/non-integer steps', () => {
    expect(() => normalizeProgressInput(null as never)).toThrow(/object/)
    expect(() => normalizeProgressInput([] as never)).toThrow(/object/)
    expect(() => normalizeProgressInput({ step: -1 })).toThrow(/non-negative/)
    expect(() => normalizeProgressInput({ step: 1.5 })).toThrow(/non-negative/)
  })

  it('rejects non-array artifacts and blank artifact entries', () => {
    expect(() => normalizeProgressInput({ note: 'x', artifacts: 'live/a.csv' })).toThrow(/array/)
    expect(() => normalizeProgressInput({ note: 'x', artifacts: ['ok', ''] })).toThrow(/artifacts\[1\]/)
  })

  it('truncates a long note to MAX_NOTE with an ellipsis', () => {
    const n = normalizeProgressInput({ note: 'x'.repeat(MAX_NOTE + 1000) })
    expect(n.note!.length).toBe(MAX_NOTE)
    expect(n.note!.endsWith('…')).toBe(true)
  })

  it('serializes a structured result as JSON text', () => {
    const n = normalizeProgressInput({ result: { rows: 3 } })
    expect(n.result).toBe('{"rows":3}')
  })
})

describe('recordProgress — redaction', () => {
  it('redacts a known secret env value and a ghp_ token on write and in the returned event', () => {
    const ev = recordProgress(db, 1, { step: 1, total_steps: 2, note: `using key ${SECRET} and ${GHP}`, artifacts: ['live/a.csv'] })
    expect(ev.note).toContain('[REDACTED:TEST_FAKE_API_KEY]')
    expect(ev.note).toContain('[REDACTED:GITHUB_TOKEN]')
    expect(ev.note).not.toContain(SECRET)
    expect(ev.note).not.toContain(GHP)
    expect(ev.artifacts).toEqual(['live/a.csv'])
    expect(ev.source).toBe('worker')

    const raw = db.prepare('SELECT note FROM objective_progress WHERE id = ?').get(ev.id) as { note: string }
    expect(raw.note).not.toContain(SECRET)
    expect(raw.note).not.toContain(GHP)
    expect(raw.note).toContain('[REDACTED:TEST_FAKE_API_KEY]')
  })

  it('latestProgress returns the newest event', () => {
    recordProgress(db, 7, { step: 1 })
    recordProgress(db, 7, { step: 2 })
    expect(latestProgress(db, 7)!.step).toBe(2)
    expect(latestProgress(db, 8)).toBeNull()
  })
})

describe('listProgress — cursor paging', () => {
  it('pages 25 events by 10 via the before cursor with no overlap', () => {
    for (let i = 1; i <= 25; i++) recordProgress(db, 42, { step: i, total_steps: 25 })
    recordProgress(db, 43, { note: 'other card' })

    const p1 = listProgress(db, 42, { limit: 10 })
    expect(p1.total).toBe(25)
    expect(p1.events).toHaveLength(10)
    expect(p1.events[0].step).toBe(25) // newest first
    expect(p1.next_before).toBe(p1.events[9].id)

    const p2 = listProgress(db, 42, { limit: 10, before: p1.next_before })
    expect(p2.events).toHaveLength(10)
    expect(p2.total).toBe(25)
    const ids1 = new Set(p1.events.map(e => e.id))
    expect(p2.events.some(e => ids1.has(e.id))).toBe(false)
    expect(Math.max(...p2.events.map(e => e.id))).toBeLessThan(Math.min(...p1.events.map(e => e.id)))

    const p3 = listProgress(db, 42, { limit: 10, before: p2.next_before })
    expect(p3.events).toHaveLength(5)
    expect(p3.next_before).toBeNull()
    const all = [...p1.events, ...p2.events, ...p3.events].map(e => e.step)
    expect(new Set(all).size).toBe(25)
  })
})

const TRANSCRIPT = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Starting the scan.' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x/a.ts' } }] } }),
  'not json at all',
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Now running tests.' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm   test\n --run' } }] } }),
  // Sub-agent sidechain: must be ignored entirely.
  JSON.stringify({ type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }, { type: 'text', text: 'sidechain text' }] } }),
  JSON.stringify({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', name: 'Glob', input: { pattern: '*' } }] } }),
  JSON.stringify({ type: 'result', num_turns: 7, result: 'done' }),
].join('\n')

describe('deriveProgressFromJsonl', () => {
  it('extracts last tool, last assistant text and counts, ignoring sidechains', () => {
    const d = deriveProgressFromJsonl(TRANSCRIPT)
    expect(d.last_tool).toEqual({ name: 'Bash', summary: 'npm test --run' })
    expect(d.last_assistant_message).toBe('Now running tests.')
    expect(d.assistant_turns).toBe(3)
    expect(d.tool_calls).toBe(2)
    expect(d.num_turns).toBe(7)
  })

  it('redacts secrets in tool summaries and assistant text', () => {
    const t = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `key=${SECRET}` }, { type: 'tool_use', name: 'Bash', input: { command: `curl -H ${GHP}` } }] } })
    const d = deriveProgressFromJsonl(t)
    expect(d.last_assistant_message).toBe('key=[REDACTED:TEST_FAKE_API_KEY]')
    expect(d.last_tool!.summary).toContain('[REDACTED:GITHUB_TOKEN]')
  })

  it('returns empty counts on an empty transcript', () => {
    expect(deriveProgressFromJsonl('')).toEqual({ last_tool: null, last_assistant_message: null, assistant_turns: 0, tool_calls: 0, num_turns: null })
  })
})

describe('deriveTranscriptProgress', () => {
  it('reads <TRANSCRIPT_DIR>/<session>.jsonl and computes elapsed_seconds', () => {
    fs.writeFileSync(path.join(TMP, 'cc-live-1.jsonl'), TRANSCRIPT + '\n')
    const now = 1_800_000_000_000
    const d = deriveTranscriptProgress('cc-live-1', { startedAtMs: now - 90_500, now })
    expect(d).not.toBeNull()
    expect(d!.source).toBe('transcript')
    expect(d!.session_id).toBe('cc-live-1')
    expect(d!.elapsed_seconds).toBe(91)
    expect(d!.last_tool!.name).toBe('Bash')
    expect(d!.num_turns).toBe(7)
    expect(d!.truncated).toBe(false)
    expect(d!.last_event_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('elapsed_seconds is null without a start time; explicit transcriptDir works', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'alt-'))
    fs.writeFileSync(path.join(dir, 's2.jsonl'), TRANSCRIPT)
    const d = deriveTranscriptProgress('s2', { transcriptDir: dir })
    expect(d!.elapsed_seconds).toBeNull()
  })

  it('returns null for a missing file, empty id, or an unsafe session id', () => {
    expect(deriveTranscriptProgress('does-not-exist')).toBeNull()
    expect(deriveTranscriptProgress(null)).toBeNull()
    expect(deriveTranscriptProgress('')).toBeNull()
    // A file that WOULD resolve via traversal still is not read: the id is rejected first.
    const sub = path.join(TMP, 'nested')
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(TMP, 'escapee.jsonl'), TRANSCRIPT)
    expect(deriveTranscriptProgress('../escapee', { transcriptDir: sub })).toBeNull()
    expect(deriveTranscriptProgress('../x')).toBeNull()
    expect(deriveTranscriptProgress('a/b')).toBeNull()
  })
})
