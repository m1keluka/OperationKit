import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'
import type { SessionMessage } from '@operationkit/shared'
import {
  isAuxSession,
  listObjectiveThreadSessionIds,
  resolveFollowUpSessionId,
  sessionHasHumanFollowUp,
  clearFollowUpMemo,
} from './objective-sessions.js'

// A real (temp-file) sqlite DB, per the DB_PATH discipline in db/*.test.ts — the
// db module refuses to open the prod DB under a test runner, and these helpers
// only need the `session_intel` shape anyway, so we build it standalone.
const TMP_DB = path.join(os.tmpdir(), `cc-objsess-${process.pid}-${Date.now()}.db`)
let db: Database.Database

function seedIntel(objectiveId: number, rows: { id: string; started: string; ended: string | null }[]) {
  db.prepare('DELETE FROM session_intel').run()
  const ins = db.prepare('INSERT INTO session_intel (session_id, objective_id, started_at, ended_at) VALUES (?, ?, ?, ?)')
  for (const r of rows) ins.run(r.id, objectiveId, r.started, r.ended)
}

// Injected message loader: session id -> parsed messages. Keeps the test off the
// filesystem while exercising the exact predicate production uses.
const transcripts = new Map<string, SessionMessage[]>()
const load = (id: string): SessionMessage[] => transcripts.get(id) ?? []
const followup = (text: string): SessionMessage =>
  ({ type: 'followup', text, timestamp: '2026-09-22T21:40:00Z' } as SessionMessage)
const assistant = (text: string): SessionMessage =>
  ({ type: 'assistant', text, timestamp: '2026-09-22T21:40:00Z' } as SessionMessage)

beforeEach(() => {
  if (!db) {
    db = new Database(TMP_DB)
    db.exec(`CREATE TABLE session_intel (
      session_id TEXT PRIMARY KEY,
      objective_id INTEGER,
      started_at TEXT,
      ended_at TEXT
    )`)
  }
  transcripts.clear()
  clearFollowUpMemo()
})

afterAll(() => {
  try { db?.close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix) } catch { /* ignore */ }
  }
})

describe('isAuxSession', () => {
  it('matches only the reviewer/planner prefixes', () => {
    expect(isAuxSession('cc-review-712444-1790112938018')).toBe(true)
    expect(isAuxSession('cc-plan-712444-1')).toBe(true)
    expect(isAuxSession('cc-712444-1790112595143')).toBe(false)
  })
})

describe('sessionHasHumanFollowUp', () => {
  it('is true only when a followup message is present', () => {
    transcripts.set('cc-review-1-a', [assistant('reviewing'), followup('hey')])
    transcripts.set('cc-review-1-b', [assistant('reviewing')])
    expect(sessionHasHumanFollowUp('cc-review-1-a', load)).toBe(true)
    expect(sessionHasHumanFollowUp('cc-review-1-b', load)).toBe(false)
  })

  it("does NOT count the parser's synthetic opener (every aux run has one)", () => {
    // stream-parser renders a session's own `prompt` event as a followup at
    // index 0. Counting it would re-admit every reviewer transcript.
    transcripts.set('cc-review-3-opener', [followup('Review: some objective'), assistant('reviewing')])
    expect(sessionHasHumanFollowUp('cc-review-3-opener', load)).toBe(false)
    transcripts.set('cc-review-3-real', [followup('Review: some objective'), assistant('reviewing'), followup('hey')])
    expect(sessionHasHumanFollowUp('cc-review-3-real', load)).toBe(true)
  })

  it('re-scans when the transcript grows (memo is count-keyed)', () => {
    transcripts.set('cc-review-2-a', [assistant('reviewing')])
    expect(sessionHasHumanFollowUp('cc-review-2-a', load)).toBe(false)
    transcripts.set('cc-review-2-a', [assistant('reviewing'), followup('hey')])
    expect(sessionHasHumanFollowUp('cc-review-2-a', load)).toBe(true)
  })
})

describe('listObjectiveThreadSessionIds', () => {
  it('INCLUDES an aux session that contains human followups (the obj 712444 case)', () => {
    seedIntel(712444, [
      { id: 'cc-712444-1790112595143', started: '2026-09-22T21:29:55Z', ended: '2026-09-22T21:35:00Z' },
      { id: 'cc-review-712444-1790112938018', started: '2026-09-22T21:35:38Z', ended: '2026-09-22T22:10:00Z' },
    ])
    transcripts.set('cc-712444-1790112595143', [followup('Verify Stripe payment links'), assistant('working')])
    transcripts.set('cc-review-712444-1790112938018', [
      followup('Review: Verify Stripe payment links'), // synthetic opener — not a human turn
      assistant('review'),
      followup('All right, so it is all good'),        // a human actually spoke
    ])

    expect(listObjectiveThreadSessionIds(db, { id: 712444, session_id: null }, load)).toEqual([
      'cc-712444-1790112595143',
      'cc-review-712444-1790112938018',
    ])
  })

  it('EXCLUDES an aux session with no human followups (a clean reviewer run)', () => {
    seedIntel(500, [
      { id: 'cc-500-1', started: '2026-09-22T10:00:00Z', ended: '2026-09-22T10:30:00Z' },
      { id: 'cc-review-500-2', started: '2026-09-22T10:31:00Z', ended: '2026-09-22T10:45:00Z' },
    ])
    transcripts.set('cc-500-1', [assistant('working')])
    transcripts.set('cc-review-500-2', [assistant('review'), assistant('verdict: PASS')])

    expect(listObjectiveThreadSessionIds(db, { id: 500, session_id: null }, load)).toEqual(['cc-500-1'])
  })

  it('preserves non-aux ordering by started_at ASC regardless of insertion order', () => {
    seedIntel(501, [
      { id: 'cc-501-third', started: '2026-09-22T12:00:00Z', ended: '2026-09-22T12:30:00Z' },
      { id: 'cc-501-first', started: '2026-09-22T08:00:00Z', ended: '2026-09-22T08:30:00Z' },
      { id: 'cc-501-second', started: '2026-09-22T10:00:00Z', ended: '2026-09-22T10:30:00Z' },
    ])
    expect(listObjectiveThreadSessionIds(db, { id: 501, session_id: null }, load)).toEqual([
      'cc-501-first',
      'cc-501-second',
      'cc-501-third',
    ])
  })

  it('appends objective.session_id last and never duplicates an id already listed', () => {
    seedIntel(502, [
      { id: 'cc-502-a', started: '2026-09-22T08:00:00Z', ended: '2026-09-22T08:30:00Z' },
      { id: 'cc-502-b', started: '2026-09-22T09:00:00Z', ended: null },
    ])
    // already present -> appended nowhere, no duplicate
    expect(listObjectiveThreadSessionIds(db, { id: 502, session_id: 'cc-502-a' }, load)).toEqual([
      'cc-502-a',
      'cc-502-b',
    ])
    // not present (live session with no intel row yet) -> appended last
    expect(listObjectiveThreadSessionIds(db, { id: 502, session_id: 'cc-502-live' }, load)).toEqual([
      'cc-502-a',
      'cc-502-b',
      'cc-502-live',
    ])
  })

  it('always includes the objective CURRENT session even when it is aux and silent', () => {
    seedIntel(503, [{ id: 'cc-review-503-1', started: '2026-09-22T08:00:00Z', ended: null }])
    transcripts.set('cc-review-503-1', [assistant('reviewing, nobody spoke')])
    expect(listObjectiveThreadSessionIds(db, { id: 503, session_id: 'cc-review-503-1' }, load)).toEqual([
      'cc-review-503-1',
    ])
  })

  it("falls back to aux-only sessions rather than a blank thread, without double-adding", () => {
    seedIntel(504, [
      { id: 'cc-review-504-1', started: '2026-09-22T08:00:00Z', ended: '2026-09-22T08:30:00Z' },
      { id: 'cc-plan-504-2', started: '2026-09-22T09:00:00Z', ended: '2026-09-22T09:30:00Z' },
    ])
    transcripts.set('cc-review-504-1', [assistant('silent')])
    transcripts.set('cc-plan-504-2', [assistant('silent')])
    const ids = listObjectiveThreadSessionIds(db, { id: 504, session_id: null }, load)
    expect(ids).toEqual(['cc-review-504-1', 'cc-plan-504-2'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('returns an empty list when the objective has no sessions at all', () => {
    seedIntel(505, [])
    expect(listObjectiveThreadSessionIds(db, { id: 505, session_id: null }, load)).toEqual([])
  })
})

describe('resolveFollowUpSessionId', () => {
  it('returns objective.session_id when it is set', () => {
    seedIntel(600, [{ id: 'cc-600-a', started: '2026-09-22T08:00:00Z', ended: '2026-09-22T08:30:00Z' }])
    expect(resolveFollowUpSessionId(db, { id: 600, session_id: 'cc-600-live' })).toBe('cc-600-live')
  })

  it('SKIPS the newest aux row and picks the newest NON-aux session (the routing bug)', () => {
    seedIntel(712444, [
      { id: 'cc-712444-1790112595143', started: '2026-09-22T21:29:55Z', ended: '2026-09-22T21:35:00Z' },
      { id: 'cc-review-712444-1790112938018', started: '2026-09-22T21:35:38Z', ended: '2026-09-22T22:10:00Z' },
    ])
    expect(resolveFollowUpSessionId(db, { id: 712444, session_id: null })).toBe('cc-712444-1790112595143')
  })

  it('picks the most recent non-aux row by ended_at when several exist', () => {
    seedIntel(601, [
      { id: 'cc-601-old', started: '2026-09-22T08:00:00Z', ended: '2026-09-22T08:30:00Z' },
      { id: 'cc-601-new', started: '2026-09-22T09:00:00Z', ended: '2026-09-22T09:30:00Z' },
      { id: 'cc-plan-601-x', started: '2026-09-22T10:00:00Z', ended: '2026-09-22T10:30:00Z' },
    ])
    expect(resolveFollowUpSessionId(db, { id: 601, session_id: null })).toBe('cc-601-new')
  })

  it('mints a fresh cc-<id>-<timestamp> when only aux sessions exist', () => {
    seedIntel(602, [
      { id: 'cc-review-602-1', started: '2026-09-22T08:00:00Z', ended: '2026-09-22T08:30:00Z' },
      { id: 'cc-plan-602-2', started: '2026-09-22T09:00:00Z', ended: '2026-09-22T09:30:00Z' },
    ])
    const id = resolveFollowUpSessionId(db, { id: 602, session_id: null })
    expect(id).toMatch(/^cc-602-\d{10,}$/)
    expect(isAuxSession(id)).toBe(false)
  })

  it('mints a fresh id when the objective has no sessions at all', () => {
    seedIntel(603, [])
    expect(resolveFollowUpSessionId(db, { id: 603, session_id: null })).toMatch(/^cc-603-\d{10,}$/)
  })
})
