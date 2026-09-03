// Strategy-linked recurring Jobs (obj 2384).
//
// Proves the end-to-end contract: a Strategy node (a delegate_mode objective)
// owns a recurring routine; firing it spawns a run-objective that is a CHILD of
// the strategy, and on the run's completion its summary is appended to the
// strategy's rolling NOTES.md context — WITHOUT the autonomy flag, since the
// strategy_objective_id link is itself the opt-in. Standalone routines (no link)
// are unchanged.
//
// CC_OBJ_MEMORY_BASE is redirected to a temp dir so appendChildResult writes to
// scratch instead of the real objective-memory tree. DB_PATH → a temp sqlite db.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective, ObjectiveStatus } from '@operationkit/shared'
import type { RoutineRow } from './routine-scheduler.js'

const TMP_DB = path.join(os.tmpdir(), `cc-strategy-jobs-test-${process.pid}-${Date.now()}.db`)
const TMP_MEM = path.join(os.tmpdir(), `cc-strategy-jobs-mem-${process.pid}-${Date.now()}`)
process.env.DB_PATH = TMP_DB
process.env.CC_OBJ_MEMORY_BASE = TMP_MEM // read at delegation.ts module load
// CRITICAL: fireRoutine PATCHes http://127.0.0.1:${PORT}/...status to spawn the
// run's session. PORT is read at routine-scheduler module load. Point it at a dead
// port so the test NEVER reaches a live Command Center on :3002 (which would mutate
// the live board + spawn real sessions). The ECONNREFUSED is caught by fireRoutine;
// the run-objective is still created with its strategy linkage — all we assert.
process.env.PORT = '59947'
delete process.env.CC_STRATEGY_TIER // autonomy flag OFF — feedback must still work

const { initDb, getDb } = await import('../db/index.js')
const { fireRoutine } = await import('./routine-scheduler.js')
const { continueDelegationOnCommit } = await import('./state-poller.js')

const row = (id: number): Objective => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective

function seedStrategy(title: string): number {
  return getDb()
    .prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, depth, delegate_mode)
       VALUES (?, 'cto', 'operator', 'queue', 0, 1)`
    )
    .run(title)
    .lastInsertRowid as number
}

function seedRoutine(name: string, strategyId: number | null): RoutineRow {
  const template = JSON.stringify({ title: 'Weekly competitor research', description: 'scan rivals', workspace: 'operator' })
  const id = getDb()
    .prepare(
      `INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth, strategy_objective_id)
       VALUES (?, '7 9 * * 1', ?, 1, 1, ?)`
    )
    .run(name, template, strategyId)
    .lastInsertRowid as number
  return getDb().prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow
}

beforeAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  fs.rmSync(TMP_MEM, { recursive: true, force: true })
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  fs.rmSync(TMP_MEM, { recursive: true, force: true })
})

describe('schema — routines gains strategy_objective_id', () => {
  it('the column exists and is nullable', () => {
    const cols = getDb().prepare('PRAGMA table_info(routines)').all() as { name: string; notnull: number }[]
    const col = cols.find(c => c.name === 'strategy_objective_id')
    expect(col).toBeTruthy()
    expect(col!.notnull).toBe(0)
  })
})

describe('strategy-owned routine — run is a child of the strategy and feeds back', () => {
  it('produces a strategy-linked run-objective whose summary lands on the parent within one tick', async () => {
    const strategyId = seedStrategy('GEO/SEO positioning')
    const routine = seedRoutine('strategy-geo-weekly-competitor-research', strategyId)

    // One scheduler tick (fireRoutine). The localhost PATCH→working will fail in
    // the test harness (no server) and is caught — the run-objective is still
    // created with its strategy parent linkage, which is what we assert.
    const result = await fireRoutine(routine, 'run-now')
    expect(result.objective_id).toBeTruthy()

    // [job-child] the run is a CHILD of the owning strategy (parent_id), not an orphan.
    const runId = result.objective_id!
    const runObj = row(runId)
    expect(runObj.parent_id).toBe(strategyId)
    expect(runObj.depth).toBe(1)
    expect(runObj.routine_id).toBe(routine.id)

    // Simulate the run completing with a summary (what session-intel extracts).
    getDb()
      .prepare("UPDATE objectives SET status = 'done', last_session_summary = ? WHERE id = ?")
      .run('Found 3 competitor moves this week', runId)
    const done = row(runId)

    // [job-feedback] flag OFF, but the strategy link drives the append.
    const woke = continueDelegationOnCommit(done, done, 'done' as ObjectiveStatus)
    expect(woke).toBe(strategyId)

    const notes = path.join(TMP_MEM, String(strategyId), 'NOTES.md')
    expect(fs.existsSync(notes)).toBe(true)
    const body = fs.readFileSync(notes, 'utf8')
    expect(body).toContain('Found 3 competitor moves this week')
    expect(body).toContain('[child-complete]')
  })
})

describe('back-compat — a standalone routine is unchanged', () => {
  it('spawns an orphan-free standalone run and does NOT feed any parent', async () => {
    const routine = seedRoutine('standalone-morning-briefing', null)
    const result = await fireRoutine(routine, 'run-now')
    const runObj = row(result.objective_id!)

    // No strategy link ⇒ no parent, exactly the pre-2384 behavior.
    expect(runObj.parent_id).toBeNull()

    getDb()
      .prepare("UPDATE objectives SET status = 'done', last_session_summary = 'ok' WHERE id = ?")
      .run(runObj.id)
    const done = row(runObj.id)

    // delegatorParentOf returns null ⇒ no append, no wake.
    expect(continueDelegationOnCommit(done, done, 'done' as ObjectiveStatus)).toBeNull()
  })
})
