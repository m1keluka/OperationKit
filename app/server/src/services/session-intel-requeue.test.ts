/**
 * obj 713406 — session_intel enrichment stalled ~2026-09-23: Ollama refusing
 * connections (since ~09-18) plus an invalid ANTHROPIC_API_KEY fallback left
 * generateSummary() returning null for every session, and extraction_status
 * stays 'parsed' by design so a later re-extract can upgrade it. The bug was
 * that nothing ever re-queued those sessions except a one-shot, 24h-window
 * sweep at server boot — a long-lived process that outlives 24h never
 * retries a backlog caused by a sustained LLM outage.
 *
 * This locks in the fix: selectStuckParsedSessions takes an explicit
 * windowHours/limit instead of hardcoding 24h/10, so the periodic sweep
 * (index.ts) can use a much wider window to actually drain an old backlog.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-session-intel-requeue-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

import { initDb, getDb } from '../db/index.js'
import { selectStuckParsedSessions } from './session-intel-pipeline.js'

beforeAll(() => {
  initDb()
})

function seedObjective(id: number, title: string): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO objectives (id, title, description, agent_context, workspace, status, create_pr)
     VALUES (?, ?, '', 'cto', 'example', 'done', 0)`
  ).run(id, title)
}

function seedIntel(sessionId: string, objectiveId: number, endedAgo: string, toolCalls: number, status = 'parsed'): void {
  const db = getDb()
  db.prepare(
    `INSERT INTO session_intel
       (objective_id, session_id, started_at, ended_at, tool_calls, extraction_status)
     VALUES (?, ?, datetime('now', ?), datetime('now', ?), ?, ?)`
  ).run(objectiveId, sessionId, endedAgo, endedAgo, toolCalls, status)
}

describe('selectStuckParsedSessions — backlog drain window (obj 713406)', () => {
  it('a 24h window misses a session stuck for 9 days (the actual 2026-09-23 stall shape)', () => {
    seedObjective(900001, 'old stuck session')
    seedIntel('cc-900001-old', 900001, '-9 days', 5)

    const within24h = selectStuckParsedSessions(24, 10)
    expect(within24h.find(r => r.session_id === 'cc-900001-old')).toBeUndefined()

    const within30d = selectStuckParsedSessions(24 * 30, 10)
    expect(within30d.find(r => r.session_id === 'cc-900001-old')).toBeDefined()
  })

  it('excludes sessions already summarized and sessions with zero tool calls', () => {
    seedObjective(900002, 'already summarized')
    seedIntel('cc-900002-done', 900002, '-1 hours', 3, 'summarized')
    seedObjective(900003, 'empty session')
    seedIntel('cc-900003-empty', 900003, '-1 hours', 0, 'parsed')

    const rows = selectStuckParsedSessions(24 * 30, 50)
    expect(rows.find(r => r.session_id === 'cc-900002-done')).toBeUndefined()
    expect(rows.find(r => r.session_id === 'cc-900003-empty')).toBeUndefined()
  })

  it('respects the limit cap so a large backlog cannot spike API cost in one sweep', () => {
    for (let i = 0; i < 5; i++) {
      seedObjective(900100 + i, `backlog ${i}`)
      seedIntel(`cc-${900100 + i}-backlog`, 900100 + i, '-2 days', 2)
    }
    const rows = selectStuckParsedSessions(24 * 30, 2)
    expect(rows.length).toBe(2)
  })
})
