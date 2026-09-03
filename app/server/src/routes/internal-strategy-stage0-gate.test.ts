// Strategy Layer — HARD stage-0 human gate (obj 700030, Part B). Proves, over the
// REAL internal bulk-create route (POST /api/internal/objectives), that:
//
//   1. flag-off equivalence: with the tier OFF (env unset AND setting absent), an
//      ordinary spawn under a strategy proceeds (201) — no gate, byte-identical.
//   2. stage-0 refusal: with the tier ON, a strategy at trust_stage<=0 that tries
//      to spawn a project with NO approved Decision Request is REFUSED (409) with
//      an error instructing it to park a Decision Request.
//   3. one approval = one spawn: an owner-APPROVED Decision Request authorizes
//      exactly ONE project spawn for that strategy, then is consumed (a second
//      spawn is refused again — no replay).
//   4. non-strategy unaffected: an ordinary (is_strategy=0) top-level delegator
//      and a plain worker are NEVER gated, tier on or off.
//
// The internal route is localhost-only; fetching 127.0.0.1 satisfies isLocalhost.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-stage0-gate-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')
const gov = await import('../services/strategy-governance.js')

let server: http.Server
let baseUrl: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  return app
}

async function createObjectives(items: unknown[]) {
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

function seedObjective(opts: {
  title: string
  parent_id?: number | null
  depth?: number
  delegate_mode?: 0 | 1
  is_strategy?: 0 | 1
  trust_stage?: number
  status?: string
}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, depth, delegate_mode, is_strategy, trust_stage)
       VALUES (?, 'cto', 'operator', ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.title,
      opts.status ?? 'working',
      opts.parent_id ?? null,
      opts.depth ?? 0,
      opts.delegate_mode ?? 0,
      opts.is_strategy ?? 0,
      opts.trust_stage ?? 0,
    )
  return r.lastInsertRowid as number
}

// Seed a strategy (the canonical is_strategy=1 top-level delegator at stage 0).
function seedStrategy(trust_stage = 0): number {
  return seedObjective({ title: `strategy-${Date.now()}`, delegate_mode: 1, is_strategy: 1, trust_stage })
}

// Park + APPROVE a Decision Request for a strategy directly (mirrors the board's
// approve action, which calls resolveDecision). Returns the review id.
function approveDecisionFor(strategyId: number): number {
  const db = getDb()
  const created = gov.createDecisionRequest(
    db,
    strategyId,
    { kind: 'spawn-next', decision: 'Spawn the next project', evidence: ['it is time'], options: [{ id: 'a', label: 'go' }], recommendation: 'a' },
    `sess-${strategyId}`,
  )
  gov.resolveDecision(db, created.id, { choice: 'approve', option_id: 'a' })
  return created.id
}

const projectItem = (parentId: number, extra: Record<string, unknown> = {}) => ({
  title: 'Project: ship a thing',
  parent_id: parentId,
  delegate_mode: true,
  type: 'project',
  ...extra,
})

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = makeApp()
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address()
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      resolve()
    })
  })
})

afterAll(() => {
  try { server?.close() } catch { /* ignore */ }
  try { getDb().close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

afterEach(() => {
  delete process.env.CC_STRATEGY_TIER
  try { getDb().prepare("DELETE FROM settings WHERE key = 'strategy_tier_enabled'").run() } catch {}
})

describe('flag-off equivalence — tier OFF (no gate)', () => {
  it('an ordinary spawn under a strategy proceeds (201) with no gate', () => {
    // tier off + setting absent: a plain (non-delegate) child under the strategy
    // is the legacy one-level worker — it must be created exactly as before.
    const strat = seedStrategy(0)
    return createObjectives([{ title: 'plain worker', parent_id: strat }]).then(({ status }) => {
      expect(status).toBe(201)
    })
  })
})

describe('stage-0 refusal — tier ON, no approved decision', () => {
  it('REFUSES a strategy@stage0 project spawn and tells it to park a Decision Request', async () => {
    process.env.CC_STRATEGY_TIER = '1'
    const strat = seedStrategy(0)
    const { status, json } = await createObjectives([projectItem(strat)])
    expect(status).toBe(409)
    expect(String(json.error)).toMatch(/Decision Request/i)
    expect(String(json.error)).toMatch(/trust stage 0/i)
    // nothing was created
    const n = (getDb().prepare('SELECT COUNT(*) AS n FROM objectives WHERE parent_id = ?').get(strat) as { n: number }).n
    expect(n).toBe(0)
  })

  it('refuses via the runtime SETTING toggle too (env unset, setting=1)', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('strategy_tier_enabled', '1')").run()
    const strat = seedStrategy(0)
    const { status } = await createObjectives([projectItem(strat)])
    expect(status).toBe(409)
  })
})

describe('one approval authorizes exactly ONE spawn (consumed, no replay)', () => {
  it('approved → first spawn 201, second spawn 409 (approval consumed)', async () => {
    process.env.CC_STRATEGY_TIER = '1'
    const strat = seedStrategy(0)
    approveDecisionFor(strat)

    const first = await createObjectives([projectItem(strat, { title: 'Project: first' })])
    expect(first.status).toBe(201)
    expect((first.json.objectives as Array<unknown>).length).toBe(1)

    // approval is now consumed → a second spawn with no fresh approval is refused
    const second = await createObjectives([projectItem(strat, { title: 'Project: second' })])
    expect(second.status).toBe(409)

    // and a NEW approval re-enables exactly one more
    approveDecisionFor(strat)
    const third = await createObjectives([projectItem(strat, { title: 'Project: third' })])
    expect(third.status).toBe(201)
  })

  it('a single approval cannot cover TWO projects in one batch', async () => {
    process.env.CC_STRATEGY_TIER = '1'
    const strat = seedStrategy(0)
    approveDecisionFor(strat)
    const { status } = await createObjectives([
      projectItem(strat, { title: 'Project: A' }),
      projectItem(strat, { title: 'Project: B' }),
    ])
    expect(status).toBe(409)
    // the rejected batch did not consume the approval (nothing committed)
    expect(gov.listApprovedUnconsumedDecisions(getDb(), strat)).toHaveLength(1)
  })
})

describe('non-strategy delegators + workers are never gated (tier ON)', () => {
  it('an ordinary (is_strategy=0) top-level delegator spawns a project unimpeded', async () => {
    process.env.CC_STRATEGY_TIER = '1'
    const delegator = seedObjective({ title: 'ordinary delegator', delegate_mode: 1, is_strategy: 0 })
    const { status } = await createObjectives([projectItem(delegator)])
    expect(status).toBe(201)
  })

  it('a plain worker (non-delegate child of an ordinary delegator) is never gated', async () => {
    process.env.CC_STRATEGY_TIER = '1'
    const delegator = seedObjective({ title: 'ordinary delegator 2', delegate_mode: 1, is_strategy: 0 })
    const { status } = await createObjectives([{ title: 'worker', parent_id: delegator }])
    expect(status).toBe(201)
  })
})
