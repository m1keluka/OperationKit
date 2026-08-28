import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Temp-file DB so initDb's real schema (incl. the gate_false_pass table) runs.
// Must set DB_PATH before importing the db module (mirrors model-registry.test).
const TMP_DB = path.join(os.tmpdir(), `cc-falsepass-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { recordReopenFalsePass, getFalsePassRate } = await import('./false-pass.js')

let nextObjId = 1
function makeObjective(workspace: string, agent_context = 'cto'): number {
  const db = getDb()
  const id = nextObjId++
  db.prepare(
    "INSERT INTO objectives (id, title, agent_context, workspace, status) VALUES (?, ?, ?, ?, 'done')"
  ).run(id, `obj-${id}`, agent_context, workspace)
  return id
}

// Insert a review row. `ageDays` lets a row land inside or outside the window.
function addReview(
  objectiveId: number,
  iteration: number,
  verdict: 'pass' | 'fail' | 'blocked',
  ageDays = 0
): number {
  const db = getDb()
  const r = db
    .prepare(
      `INSERT INTO objective_reviews
         (objective_id, iteration, reviewer_session_id, mode, verdict, created_at)
       VALUES (?, ?, ?, 'api', ?, datetime('now', ?))`
    )
    .run(objectiveId, iteration, `rev-${objectiveId}-${iteration}`, verdict, `-${ageDays} days`)
  return Number(r.lastInsertRowid)
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM gate_false_pass')
  db.exec('DELETE FROM objective_reviews')
  db.exec('DELETE FROM objectives')
  nextObjId = 1
})

afterAll(() => { try { fs.unlinkSync(TMP_DB) } catch {} })

describe('recordReopenFalsePass', () => {
  it('inserts a gate_false_pass row linking the reopen to the prior passing review', () => {
    const objId = makeObjective('personal')
    const reviewId = addReview(objId, 1, 'pass')

    const rowId = recordReopenFalsePass({ id: objId, workspace: 'personal', agent_context: 'cto' })
    expect(rowId).not.toBeNull()

    const row = getDb()
      .prepare('SELECT * FROM gate_false_pass WHERE id = ?')
      .get(rowId) as Record<string, unknown>
    expect(row.objective_id).toBe(objId)
    expect(row.review_id).toBe(reviewId) // links back to the passing review
    expect(row.workspace).toBe('personal')
    expect(row.agent_context).toBe('cto')
    expect(row.prior_verdict_at).toBeTruthy()
  })

  it('does NOT fire when the most-recent verdict was fail', () => {
    const objId = makeObjective('personal')
    addReview(objId, 1, 'pass')
    addReview(objId, 2, 'fail') // latest verdict is fail → not pass-gated

    expect(recordReopenFalsePass({ id: objId, workspace: 'personal' })).toBeNull()
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM gate_false_pass').get() as { n: number }
    expect(n.n).toBe(0)
  })

  it('does NOT fire when the objective has no reviews', () => {
    const objId = makeObjective('personal')
    expect(recordReopenFalsePass({ id: objId, workspace: 'personal' })).toBeNull()
  })

  it('is idempotent: a second reopen of the same passing review does not double-insert', () => {
    const objId = makeObjective('personal')
    addReview(objId, 1, 'pass')

    expect(recordReopenFalsePass({ id: objId, workspace: 'personal' })).not.toBeNull()
    expect(recordReopenFalsePass({ id: objId, workspace: 'personal' })).toBeNull() // guarded

    const n = getDb().prepare('SELECT COUNT(*) AS n FROM gate_false_pass').get() as { n: number }
    expect(n.n).toBe(1)
  })

  it('fires again once a NEW passing review is issued after the prior reopen', () => {
    const objId = makeObjective('personal')
    addReview(objId, 1, 'pass')
    expect(recordReopenFalsePass({ id: objId, workspace: 'personal' })).not.toBeNull()

    // Re-reviewed and passed again, then reopened again → a new false pass.
    addReview(objId, 2, 'pass')
    expect(recordReopenFalsePass({ id: objId, workspace: 'personal' })).not.toBeNull()

    const n = getDb().prepare('SELECT COUNT(*) AS n FROM gate_false_pass').get() as { n: number }
    expect(n.n).toBe(2)
  })
})

describe('getFalsePassRate', () => {
  it('computes false_passes / pass_gated_reviews per workspace', () => {
    // personal: 2 pass-gated reviews, 1 reopened (false pass) → 0.5
    const a = makeObjective('personal')
    addReview(a, 1, 'pass')
    recordReopenFalsePass({ id: a, workspace: 'personal' })
    const b = makeObjective('personal')
    addReview(b, 1, 'pass') // passed and stayed done → not a false pass

    // example: 1 pass-gated review, 0 reopened → 0.0
    const c = makeObjective('example')
    addReview(c, 1, 'pass')

    const rates = getFalsePassRate(30)
    const luka = rates.find(r => r.workspace === 'personal')!
    const example = rates.find(r => r.workspace === 'example')!

    expect(luka.pass_gated_reviews).toBe(2)
    expect(luka.false_passes).toBe(1)
    expect(luka.rate).toBeCloseTo(0.5, 6)

    expect(example.pass_gated_reviews).toBe(1)
    expect(example.false_passes).toBe(0)
    expect(example.rate).toBe(0)
  })

  it('excludes reviews outside the rolling window', () => {
    const a = makeObjective('personal')
    addReview(a, 1, 'pass', 90) // 90 days old → outside a 30-day window

    const rates = getFalsePassRate(30)
    expect(rates.find(r => r.workspace === 'personal')).toBeUndefined()
  })
})
