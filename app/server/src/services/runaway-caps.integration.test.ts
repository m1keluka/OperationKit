import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

// Integration test for the two cap-out side-effect primitives (ST3):
//   - escalateCapOut: a cumulative-ceiling cap-out ESCALATES (status→review,
//     verdict fail, needs-human warning event) instead of respawning.
//   - forceRouteStuckWorker: a hung/idle worker is force-routed to `review` and
//     the delegator PARENT is re-nudged (wakeDelegator).
// Heavy deps are mocked; the DB is a purpose-built in-memory better-sqlite3 with
// exactly the columns these functions touch (the live schema is migration-built).

let db: Database.Database
const wakeDelegatorMock = vi.fn()
const stopSessionMock = vi.fn().mockResolvedValue(undefined)
const broadcastMock = vi.fn()
const sendTelegramMock = vi.fn().mockResolvedValue(undefined)

vi.mock('../db/index.js', () => ({ getDb: () => db }))
vi.mock('../ws/index.js', () => ({ broadcast: (...a: unknown[]) => broadcastMock(...a) }))
// Preserve the real config exports (main now pulls PROJECTS_DIR and friends in
// transitively via design-arena/design-context) and override only the values
// this test pins.
vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  TRANSCRIPT_DIR: '/tmp/cc-test-transcripts-556',
  WATCHDOG_IDLE_FORCE_MS: 5400000,
  WATCHDOG_WALLCLOCK_MS: 28800000,
}))
vi.mock('./account-router.js', () => ({ getRouterStatus: vi.fn() }))
// insertAlert is used by the CI-green completion gate (obj 704785), which
// escalateCapOut now invokes in record-only mode. Record-only never escalates, so
// this is a no-op stub — but the module-level import must resolve.
vi.mock('./notifier.js', () => ({
  sendTelegram: (...a: unknown[]) => sendTelegramMock(...a),
  insertAlert: vi.fn(),
}))
vi.mock('./session-intel-pipeline.js', () => ({ queueExtraction: vi.fn() }))
vi.mock('./delegation.js', () => ({
  wakeDelegator: (...a: unknown[]) => wakeDelegatorMock(...a),
  nudgeDelegator: vi.fn(),
  recentlyNudged: vi.fn(),
  reconcileDecision: vi.fn(),
}))
vi.mock('./session-manager.js', () => ({
  getSessionState: vi.fn(),
  handleSessionDeath: vi.fn(),
  autoResumeOnLimit: vi.fn(),
  getSessionOutput: vi.fn(),
  spawnReviewerSession: vi.fn(),
  sendFollowUp: vi.fn(),
  computeObjectiveSpend: vi.fn(),
  extractFinalUsage: vi.fn(),
  stopSession: (...a: unknown[]) => stopSessionMock(...a),
}))

const { escalateCapOut, forceRouteStuckWorker } = await import('./state-poller.js')

function seed() {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY, title TEXT, type TEXT, status TEXT, effort TEXT,
      session_id TEXT, ai_review_session_id TEXT, ai_review_verdict TEXT,
      ai_review_findings TEXT, project TEXT, workspace TEXT, parent_id INTEGER,
      routine_id TEXT, delegate_mode INTEGER DEFAULT 0, updated_at TEXT
    );
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, objective_id INTEGER,
      event_type TEXT, description TEXT, metadata TEXT, created_at TEXT
    );
    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT, workspace TEXT,
      objective_id INTEGER, session_id TEXT, event_type TEXT, title TEXT, detail TEXT
    );
  `)
}

beforeEach(() => {
  seed()
  vi.clearAllMocks()
})

describe('escalateCapOut — cumulative ceiling cap-out escalates (ST3 verifier #1)', () => {
  it('a project that breaches the ceiling is parked in review with a needs-human warning (not respawned)', () => {
    db.prepare(`INSERT INTO objectives (id, title, type, status, effort, session_id, workspace, project)
                VALUES (1, 'low-ceiling test obj', 'project', 'ai_review', 'normal', 'cc-1-aaa', 'ws', 'proj')`).run()
    const obj = db.prepare('SELECT * FROM objectives WHERE id = 1').get() as any

    escalateCapOut(obj, 'budget', { iteration: 1, spend: 80, ceiling: 1, findings: 'still broken' })

    const after = db.prepare('SELECT * FROM objectives WHERE id = 1').get() as any
    expect(after.status).toBe('review')          // escalated, NOT bounced back to working
    expect(after.ai_review_verdict).toBe('fail')
    expect(after.ai_review_findings).toContain('NEEDS HUMAN REVIEW')
    const warn = db.prepare("SELECT * FROM session_events WHERE objective_id = 1 AND event_type = 'warning'").get() as any
    expect(warn).toBeTruthy()
    expect(JSON.parse(warn.metadata).kind).toBe('ai_review_cap_out')
    expect(JSON.parse(warn.metadata).reason).toBe('budget')
  })

  it('a delegator worker (task w/ delegator parent) escalates to review (re-nudges parent), not silent done', () => {
    db.prepare(`INSERT INTO objectives (id, title, type, status, delegate_mode) VALUES (10, 'delegator', 'project', 'working', 1)`).run()
    db.prepare(`INSERT INTO objectives (id, title, type, status, effort, parent_id, workspace, project)
                VALUES (11, 'child task', 'task', 'ai_review', 'normal', 10, 'ws', 'proj')`).run()
    const child = db.prepare('SELECT * FROM objectives WHERE id = 11').get() as any

    escalateCapOut(child, 'budget', { iteration: 1, spend: 50, ceiling: 1, findings: 'nope' })

    const after = db.prepare('SELECT * FROM objectives WHERE id = 11').get() as any
    expect(after.status).toBe('review')  // delegator-aware: NOT 'done'
  })

  it('a standalone human-tracked task (no parent, no routine) caps out to review (obj-1074), not silent done', () => {
    // Post-merge policy collision: the rec originally capped a standalone task to
    // `done`, but main's obj-1074 (mustRouteToHumanReview) now forbids ANY automated
    // path from auto-completing a human-tracked objective (parent_id==null &&
    // routine_id==null) — it must land in `review` for admin sign-off. The rec's
    // runaway-cap INTENT (escalate/pause instead of spin) is fully preserved by
    // `review`; only the terminal label is governed by main's newer policy.
    db.prepare(`INSERT INTO objectives (id, title, type, status, effort, workspace, project)
                VALUES (20, 'standalone', 'task', 'ai_review', 'normal', 'ws', 'proj')`).run()
    const obj = db.prepare('SELECT * FROM objectives WHERE id = 20').get() as any
    escalateCapOut(obj, 'iteration-cap', { iteration: 3, spend: 5, ceiling: 75, findings: 'x' })
    const after = db.prepare('SELECT * FROM objectives WHERE id = 20').get() as any
    expect(after.status).toBe('review')
  })

  it('a routine-spawned task (routine_id set) still caps out to done — carve-out preserved', () => {
    // obj-1074 carve-out D1: routine-spawned objectives auto-complete so recurring
    // jobs don't flood the review queue. A standalone task spawned by a routine must
    // therefore still cap out to `done`, confirming the human-tracked guard is scoped.
    db.prepare(`INSERT INTO objectives (id, title, type, status, effort, routine_id, workspace, project)
                VALUES (21, 'routine task', 'task', 'ai_review', 'normal', 'cron-1', 'ws', 'proj')`).run()
    const obj = db.prepare('SELECT * FROM objectives WHERE id = 21').get() as any
    escalateCapOut(obj, 'iteration-cap', { iteration: 3, spend: 5, ceiling: 75, findings: 'x' })
    const after = db.prepare('SELECT * FROM objectives WHERE id = 21').get() as any
    expect(after.status).toBe('done')
  })
})

describe('forceRouteStuckWorker — watchdog force-route (ST3 verifier #2)', () => {
  it('force-routes a hung worker to review, kills the session, and re-nudges the delegator parent', () => {
    db.prepare(`INSERT INTO objectives (id, title, type, status, delegate_mode) VALUES (30, 'delegator', 'project', 'working', 1)`).run()
    db.prepare(`INSERT INTO objectives (id, title, type, status, session_id, parent_id, workspace, project)
                VALUES (31, 'hung child', 'task', 'working', 'cc-31-bbb', 30, 'ws', 'proj')`).run()
    const child = db.prepare('SELECT * FROM objectives WHERE id = 31').get() as any

    forceRouteStuckWorker(child, 'idle', 'idle 120 min (threshold 90 min)')

    const after = db.prepare('SELECT * FROM objectives WHERE id = 31').get() as any
    expect(after.status).toBe('review')                 // force-routed off working
    expect(stopSessionMock).toHaveBeenCalledWith('cc-31-bbb')  // session killed
    expect(wakeDelegatorMock).toHaveBeenCalledTimes(1)  // parent re-nudged
    expect(wakeDelegatorMock.mock.calls[0][0]).toBe(30) // ...with the delegator parent id
    const warn = db.prepare("SELECT * FROM session_events WHERE objective_id = 31 AND event_type = 'warning'").get() as any
    expect(JSON.parse(warn.metadata).kind).toBe('watchdog_force_route')
    expect(JSON.parse(warn.metadata).reason).toBe('idle')
  })

  it('a non-delegated worker is still force-routed to review (no parent to wake)', () => {
    db.prepare(`INSERT INTO objectives (id, title, type, status, session_id, workspace, project)
                VALUES (40, 'solo', 'project', 'working', 'cc-40-ccc', 'ws', 'proj')`).run()
    const obj = db.prepare('SELECT * FROM objectives WHERE id = 40').get() as any
    forceRouteStuckWorker(obj, 'wall-clock', 'running 540 min (budget 480 min)')
    const after = db.prepare('SELECT * FROM objectives WHERE id = 40').get() as any
    expect(after.status).toBe('review')
    expect(wakeDelegatorMock).not.toHaveBeenCalled()
  })
})
