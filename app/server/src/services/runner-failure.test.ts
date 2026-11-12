import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// obj 900652 — a card set to `working` that never got a worker (no session id,
// 0 sessions, 0 tokens, $0, no summary) is a RUNNER failure: retried once with a
// fresh start on the stall watchdog's shared budget, then flagged visibly — never
// parked as a silent pending-human-review card.

const TMP_DB = path.join(os.tmpdir(), `cc-runner-failure-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const rf = await import('./runner-failure.js')
const reasons = await import('./session-start-reasons.js')
const { sweepOrphanedWorkingSessions, __resetOrphanSweepThrottle } = await import('./poller-delegator.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
afterAll(() => {
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})
beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM objectives').run()
  db.prepare("DELETE FROM settings WHERE key LIKE 'stall_watchdog%'").run()
})

/** #900640's shape after the bad start: working, no session, nothing ever ran. */
function seedNeverRan(extra: Record<string, unknown> = {}): number {
  const db = getDb()
  const r = db.prepare(
    `INSERT INTO objectives (title, agent_context, workspace, project, type, status, session_id, updated_at)
     VALUES ('B4 — Routine kind=flow', 'general', 'operationkit', 'operationkit', 'project', 'working', NULL,
             datetime('now', '-6 minutes'))`,
  ).run()
  const id = Number(r.lastInsertRowid)
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE objectives SET ${k} = ? WHERE id = ?`).run(v, id)
  return id
}

function row(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Record<string, any>
}

function harness(opts: { startThrows?: boolean } = {}) {
  const calls = { starts: [] as number[], notes: [] as string[], alerts: [] as string[], broadcasts: 0 }
  const deps = {
    db: getDb(),
    now: () => Date.now(),
    start: async (o: Objective) => {
      if (opts.startThrows) throw new Error('tmux spawn failed')
      calls.starts.push(o.id)
      return `cc-${o.id}-retry`
    },
    noteStartReason: (_id: number, d: string) => { calls.notes.push(d) },
    notify: (_row: unknown, reason: string) => { calls.alerts.push(reason) },
    broadcast: () => { calls.broadcasts++ },
  }
  return { deps, calls }
}

describe('isRunnerFailure', () => {
  const base = { status: 'working', session_id: null, delegate_mode: 0, total_tokens: 0, total_cost_usd: 0, session_count: 0, last_session_summary: null }
  it('matches only a working card with no session that never ran', () => {
    expect(rf.isRunnerFailure(base)).toBe(true)
    expect(rf.isRunnerFailure({ ...base, session_id: 'cc-1' })).toBe(false)
    expect(rf.isRunnerFailure({ ...base, total_tokens: 10 })).toBe(false)
    expect(rf.isRunnerFailure({ ...base, total_cost_usd: 0.01 })).toBe(false)
    expect(rf.isRunnerFailure({ ...base, session_count: 1 })).toBe(false)
    expect(rf.isRunnerFailure({ ...base, last_session_summary: 'did things' })).toBe(false)
    expect(rf.isRunnerFailure({ ...base, delegate_mode: 1 })).toBe(false)
    expect(rf.isRunnerFailure({ ...base, status: 'review' })).toBe(false)
  })
})

describe('handleRunnerFailure', () => {
  it('first failure → ONE automatic fresh start; the card stays working with a session', async () => {
    const id = seedNeverRan()
    const { deps, calls } = harness()
    expect(await rf.handleRunnerFailure(id, deps)).toBe('retried')
    expect(calls.starts).toEqual([id])
    expect(calls.notes[0]).toMatch(/runner failure/)
    const r = row(id)
    expect(r.status).toBe('working')
    expect(r.session_id).toBe(`cc-${id}-retry`)
    expect(r.stall_restarts).toBe(1)
    expect(r.ai_review_verdict).toBeNull()
    expect(calls.alerts).toEqual([])
  })

  it('second failure → flagged as a runner failure and parked review/blocked, not retried again', async () => {
    const id = seedNeverRan({ stall_restarts: 1 })
    const { deps, calls } = harness()
    expect(await rf.handleRunnerFailure(id, deps)).toBe('flagged')
    expect(calls.starts).toEqual([])
    expect(calls.alerts).toHaveLength(1)
    const r = row(id)
    expect(r.status).toBe('review')
    expect(r.ai_review_verdict).toBe('blocked')
    expect(r.ai_review_findings).toMatch(/^Runner failure/)
    expect(r.ai_review_findings).toMatch(/already spent/)
    const logged = getDb().prepare("SELECT title FROM activity_log WHERE objective_id = ? ORDER BY id").all(id).map((x: any) => x.title)
    expect(logged).toContain('runner_failure_flagged')
    expect(logged).toContain('session_stalled')
  })

  it('a retry whose spawn throws is flagged in the same pass', async () => {
    const id = seedNeverRan()
    const { deps, calls } = harness({ startThrows: true })
    expect(await rf.handleRunnerFailure(id, deps)).toBe('flagged')
    expect(calls.alerts.length).toBeGreaterThanOrEqual(1)
    const r = row(id)
    expect(r.status).toBe('review')
    expect(r.ai_review_verdict).toBe('blocked')
    expect(r.ai_review_findings).toMatch(/automatic retry did not launch a worker/)
  })

  it('retries are off (stall_watchdog_max_restarts=0) → flagged straight away', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('stall_watchdog_max_restarts', '0')").run()
    const id = seedNeverRan()
    const { deps, calls } = harness()
    expect(await rf.handleRunnerFailure(id, deps)).toBe('flagged')
    expect(calls.starts).toEqual([])
    expect(row(id).ai_review_verdict).toBe('blocked')
  })

  it('a card that ever ran is not a runner failure (left to the normal orphan path)', async () => {
    const id = seedNeverRan({ total_tokens: 5000, session_count: 1 })
    const { deps, calls } = harness()
    expect(await rf.handleRunnerFailure(id, deps)).toBe('not_runner_failure')
    expect(calls.starts).toEqual([])
    expect(row(id).status).toBe('working')
  })

  it('the retry start reason does not re-arm the shared one-retry budget', () => {
    const id = seedNeverRan({ stall_restarts: 1 })
    reasons.noteStartReason(id, rf.RUNNER_FAILURE_START_REASON, 'orphan-sweep')
    reasons.logSessionStart(getDb() as never, { objectiveId: id, sessionId: `cc-${id}-retry`, kind: 'spawn' })
    expect(row(id).stall_restarts).toBe(1)
    expect(row(id).last_start_reason).toBe('runner_failure_retry')
    // A human/bot start DOES open a fresh episode.
    reasons.noteStartReason(id, 'board', 'admin')
    reasons.logSessionStart(getDb() as never, { objectiveId: id, sessionId: `cc-${id}-human`, kind: 'spawn' })
    expect(row(id).stall_restarts).toBe(0)
  })
})

describe('sweepOrphanedWorkingSessions routes runner failures', () => {
  it('a never-ran card goes to the runner-failure handler; a card that ran is parked in review as before', async () => {
    const neverRan = seedNeverRan()
    const ran = seedNeverRan({ total_tokens: 1234, session_count: 1 })
    __resetOrphanSweepThrottle()
    const handled: number[] = []
    await sweepOrphanedWorkingSessions({
      handleRunnerFailure: async (oid) => {
        handled.push(oid)
        return oid === neverRan ? 'retried' : 'not_runner_failure'
      },
    })
    expect(handled.sort()).toEqual([neverRan, ran].sort())
    expect(row(neverRan).status).toBe('working') // handler owned it
    expect(row(ran).status).toBe('review') // unchanged legacy behavior
  })
})
