/**
 * obj 900372 — a session's END must always be accounted, even when the control
 * plane did not observe it the "normal" way.
 *
 * Evidence: #900371 opened a real PR (operationkit#670) and then sat in
 * review with session_count 0, $0, 0 tokens, ai_review_iteration 0 and an empty
 * timeline. Two paths lost the accounting:
 *
 *  A. handleSessionDeath returned early for any session missing from the
 *     in-memory `activeSessions` map — which every backend restart / self-deploy
 *     wipes while the tmux/jail session keeps running.
 *  B. The poller skips `review` cards, and its per-tick review sweep NULLed
 *     session_id without accounting — so a card moved to review by anything other
 *     than the poller (the worker or a bot PATCHing status, a gate, a stop) lost
 *     its run, and with session_id gone `/output` had nothing to show.
 *  (+) The orphan jail-home sweep deleted the transcript the canonical symlink
 *     pointed at, for exactly those unobserved deaths.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-900372-acct-'))
process.env.CC_ACCOUNT_ROUTER_STATE_FILE = path.join(TMP, 'state.json')
process.env.CC_RATE_LIMIT_LOG = path.join(TMP, 'rate-limit.jsonl')
process.env.CC_JAIL_HOME_ROOT = path.join(TMP, 'jail-homes')

let db: Database.Database
const queueExtractionMock = vi.fn()

vi.mock('../db/index.js', () => ({ getDb: () => db }))
vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }))
vi.mock('./notifier.js', () => ({ insertAlert: vi.fn(), sendTelegram: vi.fn() }))
vi.mock('./session-intel-pipeline.js', () => ({ queueExtraction: (...a: unknown[]) => queueExtractionMock(...a) }))
vi.mock('./session-telemetry.js', () => ({ scanStreamTelemetry: vi.fn() }))
vi.mock('./session-worktree.js', () => ({ computeIsolation: () => null }))
vi.mock('./session-usage.js', () => ({ extractFinalUsage: () => ({ tokens: 0, cost: 0 }) }))

const { handleSessionDeath, rehydrateEndedSession } = await import('./session-death.js')
const { activeSessions } = await import('./session-registry.js')
const { planReviewSessionSweep } = await import('./poller-decisions.js')
const { sweepOrphanJailHomes } = await import('./jail-home.js')

function freshDb(): void {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY, title TEXT, status TEXT, session_id TEXT, project TEXT, workspace TEXT,
      branch_name TEXT, create_pr INTEGER DEFAULT 0, delegate_mode INTEGER DEFAULT 0, model TEXT,
      last_start_at TEXT, updated_at TEXT
    );
    CREATE TABLE session_intel (session_id TEXT PRIMARY KEY);
    CREATE TABLE session_runtime (session_id TEXT PRIMARY KEY, claude_session_id TEXT, account_id TEXT, updated_at TEXT);
    CREATE TABLE session_spawns (session_id TEXT PRIMARY KEY, started_at TEXT);
    CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, workspace TEXT, objective_id INTEGER, session_id TEXT, event_type TEXT, title TEXT, detail TEXT);
  `)
}

beforeEach(() => {
  freshDb()
  queueExtractionMock.mockClear()
  activeSessions.clear()
})

describe('A. a session that ends after a server restart is still accounted', () => {
  it('rehydrates from the DB row and queues extraction (session_count / tokens / last_activity_at)', () => {
    db.prepare(`INSERT INTO objectives (id, title, status, session_id, project, workspace, last_start_at)
                VALUES (900371, 'Trial Bots roster', 'review', 'cc-900371-a', 'operationkit', 'operationkit', '2026-11-09T15:07:47.236Z')`).run()
    db.prepare(`INSERT INTO session_runtime (session_id, account_id) VALUES ('cc-900371-a', 'seat-7')`).run()
    expect(activeSessions.has('cc-900371-a')).toBe(false) // the restart wiped the map

    handleSessionDeath('cc-900371-a')

    expect(queueExtractionMock).toHaveBeenCalledTimes(1)
    const [objectiveId, sessionId, jsonlPath, accountId] = queueExtractionMock.mock.calls[0]
    expect(objectiveId).toBe(900371)
    expect(sessionId).toBe('cc-900371-a')
    expect(String(jsonlPath)).toMatch(/cc-900371-a\.jsonl$/)
    expect(accountId).toBe('seat-7')
  })

  it('never double-accounts: a second call (same process) and an already-extracted session are no-ops', () => {
    db.prepare(`INSERT INTO objectives (id, title, status, session_id) VALUES (1, 't', 'review', 'cc-1-a')`).run()
    handleSessionDeath('cc-1-a')
    handleSessionDeath('cc-1-a')
    expect(queueExtractionMock).toHaveBeenCalledTimes(1)

    db.prepare(`INSERT INTO objectives (id, title, status, session_id) VALUES (2, 't', 'review', 'cc-2-a')`).run()
    db.prepare(`INSERT INTO session_intel (session_id) VALUES ('cc-2-a')`).run()
    expect(rehydrateEndedSession('cc-2-a')).toBeNull()
  })

  it('does not invent a session the board no longer points at', () => {
    expect(rehydrateEndedSession('cc-unknown')).toBeNull()
    handleSessionDeath('cc-unknown')
    expect(queueExtractionMock).not.toHaveBeenCalled()
  })
})

describe('B. the review sweep accounts a session before it drops session_id', () => {
  const NOW = Date.parse('2026-11-09T15:30:00Z')
  const base = { nowMs: NOW, graceMs: 15 * 60_000, hasPendingWork: () => false }

  it('dead session on a review card → account it, then clear', () => {
    const plan = planReviewSessionSweep(
      [{ id: 900371, session_id: 'cc-900371-a', updated_at: '2026-11-09 15:24:27' }],
      { ...base, isAlive: () => false },
    )
    expect(plan).toEqual({ clear: [900371], account: ['cc-900371-a'] })
  })

  it('live session moved to review moments ago → keep session_id (it is finishing its turn)', () => {
    const plan = planReviewSessionSweep(
      [{ id: 5, session_id: 'cc-5', updated_at: '2026-11-09 15:28:00' }],
      { ...base, isAlive: () => true },
    )
    expect(plan).toEqual({ clear: [], account: [] })
  })

  it('live session past the grace window → clear as before, without accounting a running session', () => {
    const plan = planReviewSessionSweep(
      [{ id: 6, session_id: 'cc-6', updated_at: '2026-11-09 14:00:00' }],
      { ...base, isAlive: () => true },
    )
    expect(plan).toEqual({ clear: [6], account: [] })
  })

  it('live with pending background work → keep (obj 712954 unchanged)', () => {
    const plan = planReviewSessionSweep(
      [{ id: 7, session_id: 'cc-7', updated_at: '2026-11-09 10:00:00' }],
      { ...base, isAlive: () => true, hasPendingWork: () => true },
    )
    expect(plan).toEqual({ clear: [], account: [] })
  })
})

describe('(+) the orphan jail-home sweep keeps the transcript', () => {
  it('materialises the canonical transcript symlink before removing the home', () => {
    const root = path.join(TMP, 'homes')
    const transcriptDir = path.join(TMP, 'transcripts')
    const sid = 'cc-900371-b'
    const home = path.join(root, sid)
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(path.join(home, `${sid}.jsonl`), '{"type":"result"}\n')
    fs.symlinkSync(path.join(home, `${sid}.jsonl`), path.join(transcriptDir, `${sid}.jsonl`))
    const old = new Date(Date.now() - 3 * 3_600_000)
    fs.utimesSync(home, old, old)

    const r = sweepOrphanJailHomes({ liveSessionIds: [], maxAgeMin: 120, root, transcriptDir })

    expect(r.removed).toEqual([sid])
    expect(fs.existsSync(home)).toBe(false)
    const canonical = path.join(transcriptDir, `${sid}.jsonl`)
    expect(fs.lstatSync(canonical).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(canonical, 'utf-8')).toContain('"result"')
  })
})
