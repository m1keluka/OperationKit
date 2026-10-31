import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { vi } from 'vitest'
import {
  noteStartReason,
  takeStartReason,
  logSessionStart,
  listSessionStarts,
  __resetPendingStartReasons,
} from './session-start-reasons.js'

// Restart reasons (obj 715699): a wake source notes WHY, the spawn chokepoint
// consumes it; anything unnoted is recorded as `unattributed`.
let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  __resetPendingStartReasons()
})
afterEach(() => {
  vi.useRealTimers()
  db.close()
})

describe('session start reasons', () => {
  it('a noted reason is recorded on spawn with its actor/detail and consumed', () => {
    noteStartReason(1, 'board', 'mike', 'clicked Start')
    const row = logSessionStart(db, { objectiveId: 1, sessionId: 'cc-1-a', kind: 'spawn' })!
    expect(row).toMatchObject({ objective_id: 1, session_id: 'cc-1-a', kind: 'spawn', reason: 'board', actor: 'mike', detail: 'clicked Start' })
    const next = logSessionStart(db, { objectiveId: 1, sessionId: 'cc-1-b', kind: 'spawn' })!
    expect(next.reason).toBe('unattributed')
    expect(next.actor).toBeNull()
  })

  it('a resume also consumes the note', () => {
    noteStartReason(2, 'resume_after_limit', 'auto-resume')
    expect(logSessionStart(db, { objectiveId: 2, sessionId: 's', kind: 'resume' })!.reason).toBe('resume_after_limit')
    expect(takeStartReason(2).reason).toBe('unattributed')
  })

  it('attach and rejected starts record the reason but do NOT consume it', () => {
    noteStartReason(3, 'ci_failure_followup', 'ci-bridge')
    expect(logSessionStart(db, { objectiveId: 3, sessionId: 'live', kind: 'attach' })!.reason).toBe('ci_failure_followup')
    expect(logSessionStart(db, { objectiveId: 3, sessionId: null, kind: 'rejected' })!.reason).toBe('ci_failure_followup')
    const spawn = logSessionStart(db, { objectiveId: 3, sessionId: 'new', kind: 'spawn' })!
    expect(spawn.reason).toBe('ci_failure_followup')
    expect(spawn.actor).toBe('ci-bridge')
    expect(takeStartReason(3).reason).toBe('unattributed')
  })

  it('an explicit reason wins and leaves the pending note untouched', () => {
    noteStartReason(4, 'agent', 'bot')
    expect(logSessionStart(db, { objectiveId: 4, sessionId: 'x', kind: 'spawn', reason: { reason: 'routine', actor: 'cron' } })!.reason).toBe('routine')
    expect(takeStartReason(4, false).reason).toBe('agent')
  })

  it('later notes overwrite earlier ones; notes are per objective', () => {
    noteStartReason(5, 'board')
    noteStartReason(5, 'merge_lane', 'merger')
    noteStartReason(6, 'fanout')
    expect(takeStartReason(5)).toEqual({ reason: 'merge_lane', actor: 'merger', detail: null })
    expect(takeStartReason(6).reason).toBe('fanout')
  })

  it('a note older than the TTL expires to unattributed', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'))
    noteStartReason(7, 'board', 'mike')
    vi.setSystemTime(new Date('2026-10-12T10:01:59Z'))
    expect(takeStartReason(7, false).reason).toBe('board') // still inside 2 minutes
    vi.setSystemTime(new Date('2026-10-12T10:02:01Z'))
    const row = logSessionStart(db, { objectiveId: 7, sessionId: 's', kind: 'spawn' })!
    expect(row.reason).toBe('unattributed')
    expect(row.actor).toBeNull()
  })

  it('caps detail at 500 chars', () => {
    noteStartReason(8, 'agent', 'bot', 'd'.repeat(2000))
    expect(logSessionStart(db, { objectiveId: 8, sessionId: 's', kind: 'spawn' })!.detail!.length).toBe(500)
  })

  it('listSessionStarts is newest-first, scoped to the objective, and limited', () => {
    for (const r of ['board', 'agent', 'follow_up']) {
      noteStartReason(9, r)
      logSessionStart(db, { objectiveId: 9, sessionId: `s-${r}`, kind: 'spawn' })
    }
    logSessionStart(db, { objectiveId: 10, sessionId: 'other', kind: 'spawn' })
    const rows = listSessionStarts(db, 9)
    expect(rows.map(r => r.reason)).toEqual(['follow_up', 'agent', 'board'])
    expect(listSessionStarts(db, 9, 1)).toHaveLength(1)
    expect(listSessionStarts(db, 10).map(r => r.session_id)).toEqual(['other'])
  })

  it('logSessionStart never throws — a broken DB returns null', () => {
    const broken = new Database(':memory:')
    broken.close()
    expect(logSessionStart(broken, { objectiveId: 11, sessionId: 's', kind: 'spawn' })).toBeNull()
  })
})
