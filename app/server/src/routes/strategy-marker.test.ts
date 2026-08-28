// Explicit Strategy marker (obj 2383, corrected obj 2835). A "Strategy" is the
// canonical top tier of the hierarchy, stored on `objectives.is_strategy`. obj
// 2383 originally INFERRED the marker (`delegate_mode=1 AND parent_id IS NULL`)
// both at create/update time and via a backfill, which wrongly stamped nearly
// every objective Mike runs (almost all are top-level delegators) → every card
// showed the STRATEGY badge. obj 2835 makes the marker PURELY EXPLICIT: it is set
// only when the create/update request opts in, NEVER derived from
// delegate_mode/parent_id. This suite proves:
//
//   1. no-inference (insert): a top-level delegator created WITHOUT is_strategy is
//      NOT a strategy; one created WITH is_strategy:true IS.
//   2. no-restamp (update): toggling delegate_mode or re-parenting does NOT change
//      the marker; only an explicit is_strategy in the update request does.
//   3. one-query selection: `WHERE is_strategy = 1` returns exactly the strategies.
//   4. guarded reset migration: the corrective reset clears historical is_strategy=1
//      rows exactly once, is idempotent on re-run, and preserves an
//      explicitly-created strategy row.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-strategy-marker-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-strategy-marker'

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')

const USER_ID = 1
const WS = 'test-ws'
const RESET_KEY = 'is_strategy_explicit_reset_2835'

let server: http.Server
let baseUrl: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
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

function isStrategyCol(id: number): number {
  return (getDb().prepare('SELECT is_strategy FROM objectives WHERE id = ?').get(id) as { is_strategy: number }).is_strategy
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

describe('Explicit Strategy marker — no inference at insert (obj 2835)', () => {
  it('does NOT mark a top-level delegator created without is_strategy', async () => {
    const { status, json } = await post({ title: 'top delegator', workspace: WS, agent_context: 'cto', delegate_mode: true })
    expect(status).toBe(201)
    expect(json.delegate_mode).toBe(true)
    // The bug: this used to be true. It must NOT be inferred from delegate_mode.
    expect(json.is_strategy).toBe(false)
    expect(isStrategyCol(json.id as number)).toBe(0)
  })

  it('marks an objective created explicitly with is_strategy:true', async () => {
    const { json } = await post({ title: 'GEO strategy', workspace: WS, agent_context: 'cto', delegate_mode: true, is_strategy: true })
    expect(json.is_strategy).toBe(true)
    expect(isStrategyCol(json.id as number)).toBe(1)
  })

  it('a plain (non-delegator) objective is not a strategy and defaults to 0', async () => {
    const { json } = await post({ title: 'manual task', workspace: WS, agent_context: 'cto' })
    expect(json.is_strategy).toBe(false)
    expect(isStrategyCol(json.id as number)).toBe(0)
  })
})

describe('Explicit Strategy marker — one-query selection', () => {
  it('selects all strategies via the marker alone', async () => {
    await post({ title: 's1', workspace: WS, agent_context: 'cto', delegate_mode: true, is_strategy: true })
    await post({ title: 's2', workspace: WS, agent_context: 'cmo', delegate_mode: true, is_strategy: true })
    await post({ title: 'plain delegator', workspace: WS, agent_context: 'cto', delegate_mode: true })
    await post({ title: 'plain', workspace: WS, agent_context: 'cto' })
    const rows = getDb().prepare('SELECT title FROM objectives WHERE is_strategy = 1 ORDER BY title').all() as { title: string }[]
    expect(rows.map(r => r.title)).toEqual(['s1', 's2'])
  })
})

describe('Explicit Strategy marker — update never re-stamps (obj 2835)', () => {
  it('does NOT promote when delegate_mode is turned on', async () => {
    const { json } = await post({ title: 'stays non-strategy', workspace: WS, agent_context: 'cto' })
    expect(json.is_strategy).toBe(false)
    const upd = await put(json.id as number, { delegate_mode: true })
    expect(upd.json.is_strategy).toBe(false)
    expect(isStrategyCol(json.id as number)).toBe(0)
  })

  it('does NOT demote a strategy when delegate_mode is turned off', async () => {
    const { json } = await post({ title: 'strategy', workspace: WS, agent_context: 'cto', delegate_mode: true, is_strategy: true })
    expect(json.is_strategy).toBe(true)
    const upd = await put(json.id as number, { delegate_mode: false })
    expect(upd.json.is_strategy).toBe(true)
    expect(isStrategyCol(json.id as number)).toBe(1)
  })

  it('re-parenting (parent_id change) does NOT change the marker', async () => {
    const root = await post({ title: 'a root', workspace: WS, agent_context: 'cto', delegate_mode: true, is_strategy: true })
    const child = await post({ title: 'a child', workspace: WS, agent_context: 'cto' })
    expect(child.json.is_strategy).toBe(false)
    // Re-parent the (non-strategy) child under the root: still not a strategy.
    const upd = await put(child.json.id as number, { parent_id: root.json.id })
    expect(upd.json.is_strategy).toBe(false)
    expect(isStrategyCol(child.json.id as number)).toBe(0)
  })

  it('changes the marker ONLY when is_strategy is explicitly supplied', async () => {
    const { json } = await post({ title: 'flips explicitly', workspace: WS, agent_context: 'cto' })
    expect(json.is_strategy).toBe(false)
    const up1 = await put(json.id as number, { is_strategy: true })
    expect(up1.json.is_strategy).toBe(true)
    const up2 = await put(json.id as number, { is_strategy: false })
    expect(up2.json.is_strategy).toBe(false)
  })
})

describe('Explicit Strategy marker — guarded one-time corrective reset (obj 2835)', () => {
  it('resets historical rows once, is idempotent, and preserves explicit strategies', () => {
    // Simulate the deploy that lands this fix: clear the one-time guard marker so
    // the corrective reset can fire on the next initDb (it already fired in
    // beforeAll for the fresh DB).
    getDb().prepare('DELETE FROM schema_meta WHERE key = ?').run(RESET_KEY)

    // Pre-fix historical rows wrongly stamped is_strategy=1 by the old inference
    // (a top-level delegator AND a deeper one — the old rule only matched the
    // top-level, but to prove a blanket reset we stamp both).
    const h1 = getDb().prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, delegate_mode, is_strategy)
       VALUES ('legacy top delegator', 'cto', ?, 'queue', NULL, 1, 1)`
    ).run(WS)
    const h2 = getDb().prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, delegate_mode, is_strategy)
       VALUES ('legacy nested', 'cto', ?, 'queue', NULL, 1, 1)`
    ).run(WS)
    const h1Id = Number(h1.lastInsertRowid)
    const h2Id = Number(h2.lastInsertRowid)
    expect(isStrategyCol(h1Id)).toBe(1)
    expect(isStrategyCol(h2Id)).toBe(1)

    // Re-run migration → corrective reset fires once (marker was cleared).
    initDb()
    expect(isStrategyCol(h1Id)).toBe(0)
    expect(isStrategyCol(h2Id)).toBe(0)
    // Guard marker is now recorded.
    expect(getDb().prepare('SELECT 1 FROM schema_meta WHERE key = ?').get(RESET_KEY)).toBeTruthy()

    // Now an EXPLICITLY-created strategy (post-fix) must survive future migrations.
    const explicit = getDb().prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, delegate_mode, is_strategy)
       VALUES ('explicit strategy', 'cto', ?, 'queue', NULL, 1, 1)`
    ).run(WS)
    const explicitId = Number(explicit.lastInsertRowid)

    // Re-run migration again → idempotent: reset does NOT fire (marker present),
    // so the explicit strategy is preserved and the historical rows stay 0.
    initDb()
    expect(isStrategyCol(explicitId)).toBe(1)
    expect(isStrategyCol(h1Id)).toBe(0)
    expect(isStrategyCol(h2Id)).toBe(0)
  })
})
