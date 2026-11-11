// Explicit objective provenance (obj 2386). Proves the origin + strategy_id
// promotion: provenance is no longer INFERRED from parent_id — it is two stored
// columns written at INSERT. Covered here over the REAL objectives + internal
// routers and the db migration block:
//
//   1. prov-column     : a manually-created objective is stamped origin='manual'
//                        at insert (not inferred); a delegator-spawned child via
//                        the internal batch route is origin='strategy'.
//   2. prov-backfill   : legacy rows are backfilled idempotently — routine_id =>
//                        routine, source_job_id => job_reply, delegator-parent =>
//                        strategy, else manual; a second run changes nothing.
//   3. prov-manual-link: a manual objective with parent_id IS NULL can be linked
//                        to a Strategy (strategy_id) and reads it back.
//   4. prov-query      : "all objectives a given strategy invoked" = one indexed
//                        predicate (strategy_id = ?), including deep + linked rows.
//   5. prov-backcompat : absence of provenance defaults to origin='manual',
//                        strategy_id=NULL — no existing behavior changes.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-provenance-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-provenance'

const { initDb, getDb, resolveStrategyId } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: internalRouter } = await import('./internal.js')

const USER_ID = 1
const WS = 'test-ws'

let server: http.Server
let baseUrl: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/internal', internalRouter)
  return app
}

function token(): string {
  return jwt.sign({ id: USER_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function post(body: unknown) {
  const res = await fetch(`${baseUrl}/api/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token()}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

async function put(id: number, body: unknown) {
  const res = await fetch(`${baseUrl}/api/objectives/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token()}` },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

// The internal batch-create route (delegator spawn path). Localhost-only; the
// test server binds 127.0.0.1 so isLocalhost passes.
async function batchCreate(objectives: unknown[]) {
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(objectives),
  })
  return { status: res.status, json: await res.json() as Record<string, unknown> }
}

function row(id: number): { origin: string; strategy_id: number | null } {
  return getDb().prepare('SELECT origin, strategy_id FROM objectives WHERE id = ?').get(id) as { origin: string; strategy_id: number | null }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(USER_ID)
  const app = makeApp()
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
})

describe('prov-column — origin written at insert, not inferred', () => {
  it('stamps origin=manual on a hand-created objective', async () => {
    const { status, json } = await post({ title: 'manual obj', workspace: WS, agent_context: 'cto' })
    expect(status).toBe(201)
    expect(json.origin).toBe('manual')
    expect(row(json.id as number).origin).toBe('manual')
  })

  it('stamps origin=strategy on a delegator-spawned child (internal batch)', async () => {
    const parent = await post({ title: 'root strategy', workspace: WS, agent_context: 'cto', delegate_mode: true, is_strategy: true })
    const { status, json } = await batchCreate([
      { title: 'spawned child', workspace: WS, agent_context: 'cto', parent_id: parent.json.id },
    ])
    expect(status).toBe(201)
    const created = getDb().prepare("SELECT id, origin, strategy_id FROM objectives WHERE title = 'spawned child'").get() as { id: number; origin: string; strategy_id: number }
    expect(created.origin).toBe('strategy')
    // strategy_id inherits the delegator parent (which IS a Strategy).
    expect(created.strategy_id).toBe(parent.json.id)
  })

  it('stamps origin=job_reply when the batch row carries source_job_id', async () => {
    const job = await post({ title: 'a job', workspace: WS, agent_context: 'cto' })
    await batchCreate([
      { title: 'reply spawn', workspace: WS, agent_context: 'cto', source_job_id: job.json.id },
    ])
    const created = getDb().prepare("SELECT origin FROM objectives WHERE title = 'reply spawn'").get() as { origin: string }
    expect(created.origin).toBe('job_reply')
  })
})

describe('prov-manual-link — manual objective links a Strategy even with no parent', () => {
  it('associates a parent-less manual objective with a Strategy at create', async () => {
    const strat = await post({ title: 'GEO strategy', workspace: WS, agent_context: 'cto', delegate_mode: true, is_strategy: true })
    const { json } = await post({ title: 'manual linked', workspace: WS, agent_context: 'cto', strategy_id: strat.json.id })
    expect(json.parent_id == null).toBe(true)
    expect(json.origin).toBe('manual')
    expect(json.strategy_id).toBe(strat.json.id)
  })

  it('associates via update (PUT) and detaches with null', async () => {
    const strat = await post({ title: 'SEO strategy', workspace: WS, agent_context: 'cto', delegate_mode: true, is_strategy: true })
    const obj = await post({ title: 'later linked', workspace: WS, agent_context: 'cto' })
    expect(row(obj.json.id as number).strategy_id).toBe(null)
    const linked = await put(obj.json.id as number, { strategy_id: strat.json.id })
    expect(linked.json.strategy_id).toBe(strat.json.id)
    const detached = await put(obj.json.id as number, { strategy_id: null })
    expect(detached.json.strategy_id).toBe(null)
  })

  it('rejects a non-strategy id by degrading to null (not throwing)', async () => {
    const notStrat = await post({ title: 'plain', workspace: WS, agent_context: 'cto' })
    const { json } = await post({ title: 'bad link', workspace: WS, agent_context: 'cto', strategy_id: notStrat.json.id })
    expect(json.strategy_id).toBe(null)
  })

  it('detail endpoint embeds the associated strategy inline', async () => {
    const strat = await post({ title: 'embed strategy', workspace: WS, agent_context: 'cto', delegate_mode: true, is_strategy: true })
    const obj = await post({ title: 'shows strategy', workspace: WS, agent_context: 'cto', strategy_id: strat.json.id })
    const res = await fetch(`${baseUrl}/api/internal/objectives/${obj.json.id}`)
    const detail = await res.json() as { strategy: { id: number; title: string } | null }
    expect(detail.strategy?.id).toBe(strat.json.id)
    expect(detail.strategy?.title).toBe('embed strategy')
  })
})

describe('prov-query — all objectives a strategy invoked in one query', () => {
  it('returns the full set (delegator-spawned + manually-linked) via strategy_id alone', async () => {
    const strat = await post({ title: 'owning strategy', workspace: WS, agent_context: 'cto', delegate_mode: true, is_strategy: true })
    // Delegator-spawned child (origin strategy, strategy_id inherited).
    await batchCreate([{ title: 'child A', workspace: WS, agent_context: 'cto', parent_id: strat.json.id }])
    // Manually-linked, parent-less objective.
    await post({ title: 'manual member', workspace: WS, agent_context: 'cto', strategy_id: strat.json.id })
    // Unrelated control.
    await post({ title: 'unrelated', workspace: WS, agent_context: 'cto' })

    const res = await fetch(`${baseUrl}/api/internal/strategies/${strat.json.id}/objectives`)
    const rows = await res.json() as { title: string }[]
    expect(rows.map(r => r.title).sort()).toEqual(['child A', 'manual member'])
  })

  it('resolveStrategyId inherits down a multi-level chain (grandchild → strategy)', async () => {
    // Flag-off nesting guards block creating a grandchild via the batch route,
    // so prove chain inheritance at the helper level: a grandchild whose parent
    // carries strategy_id resolves to the same Strategy.
    const strat = await post({ title: 'chain strategy', workspace: WS, agent_context: 'cto', delegate_mode: true, is_strategy: true })
    await batchCreate([{ title: 'mid', workspace: WS, agent_context: 'cto', parent_id: strat.json.id }])
    const mid = getDb().prepare("SELECT id, strategy_id FROM objectives WHERE title = 'mid'").get() as { id: number; strategy_id: number }
    expect(mid.strategy_id).toBe(strat.json.id)
    // A would-be grandchild parented under mid inherits mid's strategy_id.
    expect(resolveStrategyId(getDb(), null, mid.id)).toBe(strat.json.id)
  })
})

describe('prov-backcompat — defaults preserve prior behavior', () => {
  it('a plain objective defaults to origin=manual, strategy_id=null', async () => {
    const { json } = await post({ title: 'plain', workspace: WS, agent_context: 'cto' })
    expect(json.origin).toBe('manual')
    expect(json.strategy_id == null).toBe(true)
  })

  it('resolveStrategyId returns null for no parent and no explicit id', () => {
    expect(resolveStrategyId(getDb(), null, null)).toBe(null)
    expect(resolveStrategyId(getDb(), undefined, undefined)).toBe(null)
  })
})

describe('prov-backfill — idempotent classification of legacy rows', () => {
  it('classifies routine/job_reply/strategy/manual and is a no-op on re-run', () => {
    // Pre-2386 rows: origin defaults to 'manual' for all; backfill reclassifies.
    // A legacy delegator parent (top-level) that IS an explicit Strategy. Under
    // the obj 2835 model is_strategy is explicit (no longer inferred from
    // delegate_mode), so we stamp it directly to exercise strategy_id inheritance.
    const delegator = getDb().prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, delegate_mode, is_strategy)
       VALUES ('legacy delegator', 'cto', ?, 'queue', NULL, 1, 1)`
    ).run(WS)
    const delegatorId = Number(delegator.lastInsertRowid)
    // A child of the delegator → should backfill to 'strategy'.
    const child = getDb().prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, delegate_mode)
       VALUES ('legacy child', 'cto', ?, 'queue', ?, 0)`
    ).run(WS, delegatorId)
    const childId = Number(child.lastInsertRowid)
    // A routine-spawned row → 'routine'.
    const routine = getDb().prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, routine_id)
       VALUES ('legacy routine', 'cto', ?, 'queue', 99)`
    ).run(WS)
    const routineId = Number(routine.lastInsertRowid)
    // A job-reply row → 'job_reply'.
    const reply = getDb().prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, source_job_id)
       VALUES ('legacy reply', 'cto', ?, 'queue', 99)`
    ).run(WS)
    const replyId = Number(reply.lastInsertRowid)
    // A plain manual row → stays 'manual'.
    const manual = getDb().prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status)
       VALUES ('legacy manual', 'cto', ?, 'queue')`
    ).run(WS)
    const manualId = Number(manual.lastInsertRowid)

    // Force all to the un-backfilled baseline to simulate pre-migration state.
    getDb().prepare("UPDATE objectives SET origin = 'manual', strategy_id = NULL").run()

    initDb() // re-run migration → backfill

    expect(row(routineId).origin).toBe('routine')   // routine_id wins
    expect(row(replyId).origin).toBe('job_reply')   // source_job_id
    expect(row(childId).origin).toBe('strategy')    // delegator parent
    expect(row(manualId).origin).toBe('manual')     // default
    // strategy_id backfill walks to the nearest is_strategy=1 ancestor. The legacy
    // delegator was stamped is_strategy=1 above (explicit marker), so the child
    // resolves to it.
    expect(row(childId).strategy_id).toBe(delegatorId)

    // Second run changes nothing.
    const before = getDb().prepare('SELECT id, origin, strategy_id FROM objectives ORDER BY id').all()
    initDb()
    const after = getDb().prepare('SELECT id, origin, strategy_id FROM objectives ORDER BY id').all()
    expect(after).toEqual(before)
  })
})
