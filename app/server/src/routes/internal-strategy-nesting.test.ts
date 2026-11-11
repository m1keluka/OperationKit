// Strategy Layer P0-P2 (obj 2286). Proves three things over the REAL internal
// bulk-create route (POST /api/internal/objectives) and the db migration block:
//
//   1. depth-on-insert: a top-level row persists depth 0; a child of a depth-0
//      parent persists depth 1 (depth is derived, never client-supplied).
//   2. flag-off equivalence: with CC_STRATEGY_TIER unset the nesting guard
//      rejects EXACTLY what the pre-change code did — a delegate_mode child and
//      any grandchild (parent already has a parent).
//   3. flag-on bounded relaxation: with CC_STRATEGY_TIER=1 a delegate_mode child
//      under a depth-0 delegator parent is accepted and stored with depth 1,
//      while a node at childDepth >= MAX_DELEGATION_DEPTH (3) is rejected.
//   4. idempotent backfill: the db migration normalizes buggy depth-0 children
//      to depth 1 and is a no-op on re-run.
//
// The internal route is localhost-only; fetching 127.0.0.1 satisfies isLocalhost.

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-strategy-nesting-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')

let server: http.Server
let baseUrl: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  return app
}

// POST the bulk-create payload (the route body IS the items array).
async function createObjectives(items: unknown[]) {
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

// Seed an objective row directly (bypassing the route guard) so we can construct
// arbitrary parent topologies and legacy depth states.
function seedObjective(opts: {
  title: string
  parent_id?: number | null
  depth?: number
  delegate_mode?: 0 | 1
  status?: string
}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, parent_id, depth, delegate_mode)
       VALUES (?, 'cto', 'example', ?, ?, ?, ?)`
    )
    .run(
      opts.title,
      opts.status ?? 'queue',
      opts.parent_id ?? null,
      opts.depth ?? 0,
      opts.delegate_mode ?? 0,
    )
  return r.lastInsertRowid as number
}

function depthOf(id: number): number {
  return (getDb().prepare('SELECT depth FROM objectives WHERE id = ?').get(id) as { depth: number }).depth
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = makeApp()
  await new Promise<void>(resolve => {
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
  // Never leak the flag across tests.
  delete process.env.CC_STRATEGY_TIER
})

describe('depth-on-insert (P1)', () => {
  it('persists depth 0 for a top-level row', async () => {
    const { status, json } = await createObjectives([{ title: 'top-level A' }])
    expect(status).toBe(201)
    const id = (json.objectives as Array<{ id: number }>)[0].id
    expect(depthOf(id)).toBe(0)
  })

  it('persists depth 1 for a child of a depth-0 parent', async () => {
    const parentId = seedObjective({ title: 'depth-0 parent', depth: 0 })
    const { status, json } = await createObjectives([{ title: 'child of parent', parent_id: parentId }])
    expect(status).toBe(201)
    const childId = (json.objectives as Array<{ id: number }>)[0].id
    expect(depthOf(childId)).toBe(1)
  })
})

describe('flag-off equivalence (P2) — CC_STRATEGY_TIER unset', () => {
  it('rejects a delegate_mode child (no nested delegation)', async () => {
    const parentId = seedObjective({ title: 'flag-off delegator parent', depth: 0, delegate_mode: 1 })
    const { status, json } = await createObjectives([
      { title: 'nested delegator', parent_id: parentId, delegate_mode: true },
    ])
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/no nested delegation/i)
  })

  it('rejects a grandchild (parent already has a parent)', async () => {
    const root = seedObjective({ title: 'root', depth: 0 })
    // A normal one-level worker — depth 1, parent_id set.
    const worker = seedObjective({ title: 'worker', parent_id: root, depth: 1 })
    const { status, json } = await createObjectives([
      { title: 'grandchild', parent_id: worker },
    ])
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/more than one level deep/i)
  })
})

describe('flag-on bounded relaxation (P2) — CC_STRATEGY_TIER=1', () => {
  it('accepts a delegate_mode child under a depth-0 delegator and stores depth 1', async () => {
    process.env.CC_STRATEGY_TIER = '1'
    const strategy = seedObjective({ title: 'strategy root', depth: 0, delegate_mode: 1 })
    const { status, json } = await createObjectives([
      { title: 'project under strategy', parent_id: strategy, delegate_mode: true },
    ])
    expect(status).toBe(201)
    const projectId = (json.objectives as Array<{ id: number }>)[0].id
    expect(depthOf(projectId)).toBe(1)
  })

  it('accepts a task child under a depth-1 project (childDepth 2 < 3)', async () => {
    process.env.CC_STRATEGY_TIER = '1'
    const project = seedObjective({ title: 'project', depth: 1, delegate_mode: 1, parent_id: seedObjective({ title: 's', depth: 0, delegate_mode: 1 }) })
    const { status, json } = await createObjectives([
      { title: 'task under project', parent_id: project },
    ])
    expect(status).toBe(201)
    const taskId = (json.objectives as Array<{ id: number }>)[0].id
    expect(depthOf(taskId)).toBe(2)
  })

  it('rejects a node at childDepth >= MAX_DELEGATION_DEPTH (3)', async () => {
    process.env.CC_STRATEGY_TIER = '1'
    // A depth-2 parent → a child would be depth 3 → rejected by the ceiling.
    const leaf = seedObjective({ title: 'depth-2 node', depth: 2, parent_id: seedObjective({ title: 'p1', depth: 1 }) })
    const { status, json } = await createObjectives([
      { title: 'too deep', parent_id: leaf },
    ])
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/beyond depth/i)
  })

  it('still rejects a delegate_mode child whose parent is NOT a delegator', async () => {
    process.env.CC_STRATEGY_TIER = '1'
    const plainParent = seedObjective({ title: 'non-delegator parent', depth: 0, delegate_mode: 0 })
    const { status, json } = await createObjectives([
      { title: 'orphan project', parent_id: plainParent, delegate_mode: true },
    ])
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/delegator parent/i)
  })
})

describe('idempotent depth backfill (P0)', () => {
  it('normalizes a buggy depth-0 child to depth 1 and is a no-op on re-run', () => {
    const root = seedObjective({ title: 'backfill root', depth: 0 })
    // Simulate a pre-fix child that inherited the column DEFAULT 0.
    const buggyChild = seedObjective({ title: 'buggy child', parent_id: root, depth: 0 })
    const topLevel = seedObjective({ title: 'top stays 0', parent_id: null, depth: 0 })

    expect(depthOf(buggyChild)).toBe(0)

    // Re-run the migration block (initDb is idempotent).
    initDb()
    expect(depthOf(buggyChild)).toBe(1) // normalized
    expect(depthOf(topLevel)).toBe(0)   // top-level untouched

    // Second run changes nothing — the WHERE clause no longer matches.
    const before = getDb().prepare('SELECT id, depth FROM objectives ORDER BY id').all()
    initDb()
    const after = getDb().prepare('SELECT id, depth FROM objectives ORDER BY id').all()
    expect(after).toEqual(before)
  })
})
