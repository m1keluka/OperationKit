import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { extractDeterministic } from './session-intel-parse.js'

// Regression coverage for the 08-13 429-truncation extraction artifact (obj
// 705919). Root cause: a session killed mid-run by a Claude API 429 (account
// "session limit" / monthly spend limit / transient server rate-limit) hands
// the summarizer a TRUNCATED transcript, and the LLM fabricates a plausible
// "deliverable missing / produced no output" content reason that appears
// nowhere in it. 62 sessions in one 24h window hit this; four reviewer
// objectives were stamped blocked "no deliverable" while the file was on disk
// and the transcript showed the reviewer reading it seconds before the 429.
//
// The fix: extractDeterministic sets `truncatedByUsageLimit` from the TERMINAL
// `result` event so processExtraction can short-circuit to a truthful record
// instead of summarizing an incomplete transcript. These tests pin the
// detector (both directions) and the persistence SQL (the flag lands on the
// dedicated column, extraction_status keeps its CHECK-constrained value).

let tmpDir: string
let n = 0

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-trunc-'))
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Write JSONL events to a temp file and return its path. */
function writeJsonl(events: Record<string, unknown>[]): string {
  const p = path.join(tmpDir, `session-${n++}.jsonl`)
  fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join('\n'))
  return p
}

// A real Read tool_use turn — mirrors what a reviewer emits before a 429.
const readToolTurn = {
  type: 'assistant',
  timestamp: '2026-08-13T01:07:50Z',
  message: {
    content: [
      { type: 'tool_use', name: 'Read', input: { file_path: '/home/operator/ai-workspace/objective-memory/705750/W8-rulings-exec-report.md' } },
    ],
  },
}

describe('extractDeterministic — 429 usage-limit truncation detection', () => {
  it('flags an account "session limit" 429 as the terminal result (mid-run, after tool calls)', async () => {
    // The 705863 shape: reviewer Read the deliverable, then the 429 killed it.
    const p = writeJsonl([
      { type: 'system', timestamp: '2026-08-13T01:07:46Z' },
      readToolTurn,
      {
        type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
        result: "You've hit your session limit · resets 2:20am (UTC)",
        duration_ms: 12000, usage: { input_tokens: 10, output_tokens: 5 },
      },
    ])
    const intel = await extractDeterministic(p)
    expect(intel.truncatedByUsageLimit).toBe(true)
    // The tool call is still counted — this is NOT a "produced no output" case.
    expect(intel.toolCalls).toBe(1)
  })

  it('flags a turn-1 429 with zero tool calls (the "produced no output" artifact)', async () => {
    // The 705859 shape: sub-second session spawned into an exhausted account.
    const p = writeJsonl([
      { type: 'system', timestamp: '2026-08-13T03:19:00Z' },
      {
        type: 'result', subtype: 'error', is_error: true, api_error_status: 429,
        result: "You've hit your session limit · resets 3:20am (UTC)",
        duration_ms: 472,
      },
    ])
    const intel = await extractDeterministic(p)
    expect(intel.truncatedByUsageLimit).toBe(true)
    expect(intel.toolCalls).toBe(0)
  })

  it('flags a monthly spend-limit 429 too', async () => {
    const p = writeJsonl([
      { type: 'system', timestamp: '2026-08-13T01:00:00Z' },
      {
        type: 'result', subtype: 'error', is_error: true, api_error_status: 429,
        result: "You've hit your org's monthly spend limit · ask your admin to raise it at claude.ai/admin-settings/usage",
      },
    ])
    expect((await extractDeterministic(p)).truncatedByUsageLimit).toBe(true)
  })

  it('detects via result text even if api_error_status is absent', async () => {
    const p = writeJsonl([
      { type: 'system', timestamp: '2026-08-13T01:00:00Z' },
      { type: 'result', subtype: 'success', is_error: true, result: 'hit your usage limit · resets 5:00pm (UTC)' },
    ])
    expect((await extractDeterministic(p)).truncatedByUsageLimit).toBe(true)
  })

  it('does NOT flag a clean, successful session', async () => {
    const p = writeJsonl([
      { type: 'system', timestamp: '2026-08-13T01:00:00Z' },
      readToolTurn,
      { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'Done. Report written.' },
    ])
    const intel = await extractDeterministic(p)
    expect(intel.truncatedByUsageLimit).toBe(false)
    expect(intel.toolCalls).toBe(1)
  })

  it('does NOT flag a session that hit a transient 429 mid-run then RECOVERED to a clean terminal result', async () => {
    // Last-result semantics: only the terminal turn's status counts. A blip
    // that later succeeds is not a truncation.
    const p = writeJsonl([
      { type: 'system', timestamp: '2026-08-13T01:00:00Z' },
      { type: 'result', subtype: 'error', is_error: true, api_error_status: 429, result: 'API Error: Server is temporarily limiting requests · Rate limited' },
      readToolTurn,
      { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'Recovered and finished.' },
    ])
    expect((await extractDeterministic(p)).truncatedByUsageLimit).toBe(false)
  })

  it('does NOT flag a genuinely empty/idle session (0 tool calls, no 429)', async () => {
    const p = writeJsonl([
      { type: 'system', timestamp: '2026-08-13T01:00:00Z' },
      { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: '' },
    ])
    const intel = await extractDeterministic(p)
    expect(intel.truncatedByUsageLimit).toBe(false)
    expect(intel.toolCalls).toBe(0)
  })

  it('returns false on an unreadable transcript (read-failure path)', async () => {
    const intel = await extractDeterministic(path.join(tmpDir, 'does-not-exist.jsonl'))
    expect(intel.truncatedByUsageLimit).toBe(false)
  })
})

describe('persistence SQL — truncated rows land on the flag column, not a new enum value', () => {
  // Prove the fix's UPDATEs are accepted by the REAL CHECK constraint: a
  // truncated row keeps extraction_status='summarized' and sets the dedicated
  // truncated_usage_limit=1 flag. A new extraction_status enum value would
  // throw here — which is exactly why the fix uses a separate column.
  function setup() {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE session_intel (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        summary TEXT,
        outcome TEXT CHECK(outcome IN ('success','partial','failed','blocked')),
        extraction_status TEXT NOT NULL DEFAULT 'pending'
          CHECK(extraction_status IN ('pending','parsed','summarized','failed')),
        truncated_usage_limit INTEGER NOT NULL DEFAULT 0
      );
    `)
    return db
  }

  it('mid-run truncation UPDATE is accepted and sets outcome=blocked + flag=1', async () => {
    const db = setup()
    db.prepare("INSERT INTO session_intel (session_id, extraction_status) VALUES ('s1','parsed')").run()
    db.prepare(`
      UPDATE session_intel SET
        summary = ?, outcome = 'blocked',
        truncated_usage_limit = 1, extraction_status = 'summarized'
      WHERE session_id = ?
    `).run('truncated', 's1')
    const row = db.prepare("SELECT outcome, extraction_status, truncated_usage_limit FROM session_intel WHERE session_id='s1'").get() as Record<string, unknown>
    expect(row.outcome).toBe('blocked')
    expect(row.extraction_status).toBe('summarized')
    expect(row.truncated_usage_limit).toBe(1)
    db.close()
  })

  it('the CHECK constraint would REJECT a "truncated_usage_limit" extraction_status — proving the column was the right call', async () => {
    const db = setup()
    db.prepare("INSERT INTO session_intel (session_id, extraction_status) VALUES ('s2','parsed')").run()
    expect(() =>
      db.prepare("UPDATE session_intel SET extraction_status = 'truncated_usage_limit' WHERE session_id='s2'").run()
    ).toThrow(/CHECK constraint/)
    db.close()
  })

  it('non-truncated idle sessions keep outcome=failed + flag stays 0', async () => {
    const db = setup()
    db.prepare("INSERT INTO session_intel (session_id, extraction_status) VALUES ('s3','parsed')").run()
    db.prepare("UPDATE session_intel SET extraction_status='summarized', outcome='failed', summary='Session produced no output (0 tool calls)' WHERE session_id='s3'").run()
    const row = db.prepare("SELECT outcome, truncated_usage_limit FROM session_intel WHERE session_id='s3'").get() as Record<string, unknown>
    expect(row.outcome).toBe('failed')
    expect(row.truncated_usage_limit).toBe(0)
    db.close()
  })
})
