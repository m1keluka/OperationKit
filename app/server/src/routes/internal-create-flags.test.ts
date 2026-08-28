// obj 706230 (W7). Regression guard for the SILENT FIELD DROP on the internal
// bulk-create route (POST /api/internal/objectives).
//
// The bug: a delegator posted `create_pr: true` and got back a 201, but the row
// stored `create_pr = 0`. Four workers in a row (706184/706186/706188/706195).
// Root cause: the INSERT column list in internal.ts omitted both `create_pr` and
// `delegate_mode`, so neither was ever bound and both fell through to the column
// DEFAULT 0. Nothing validated the field away and nothing coerced it — the value
// simply reached the handler and was never read.
//
// `delegate_mode` shared the identical root cause (same missing column, same
// missing bind) and is fixed by the same change. Note it was ALREADY read at the
// ds-gate line and ALREADY guarded by the nested-delegation CHECK 1 — the handler
// acknowledged the field, acted on it, then discarded it on write.
//
// This file proves BOTH halves of the fix:
//   A. accepted flags are PERSISTED (create_pr, delegate_mode)
//   B. a field that CANNOT be honoured is REJECTED with a clear 400, never
//      silently coerced — closing the `"agent"`-for-`"agent_context"` and
//      `"status":"queued"` traps that the original reproduction also hit.
//
// Everything runs over the REAL express route (the defect lived in the route
// layer, so a direct-to-db unit test would have proved nothing).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-create-flags-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')

let server: http.Server
let baseUrl: string

async function createObjectives(items: unknown[]) {
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

function rowOf(id: number): { create_pr: number; delegate_mode: number } {
  return getDb()
    .prepare('SELECT create_pr, delegate_mode FROM objectives WHERE id = ?')
    .get(id) as { create_pr: number; delegate_mode: number }
}

function firstId(json: Record<string, unknown>): number {
  return (json.objectives as Array<{ id: number }>)[0].id
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalRouter)
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

describe('A. posted flags are persisted (the reported bug)', () => {
  it('persists create_pr:true as 1', async () => {
    const { status, json } = await createObjectives([{ title: 'w7 create_pr true', create_pr: true }])
    expect(status).toBe(201)
    expect(rowOf(firstId(json)).create_pr).toBe(1)
  })

  it('persists delegate_mode:true as 1 on a top-level row (same root cause)', async () => {
    const { status, json } = await createObjectives([{ title: 'w7 delegate true', delegate_mode: true }])
    expect(status).toBe(201)
    expect(rowOf(firstId(json)).delegate_mode).toBe(1)
  })

  it('persists both flags together, per item, in one batch', async () => {
    const { status, json } = await createObjectives([
      { title: 'w7 batch both', create_pr: true, delegate_mode: true },
      { title: 'w7 batch neither' },
    ])
    expect(status).toBe(201)
    const ids = (json.objectives as Array<{ id: number }>).map(o => o.id)
    expect(rowOf(ids[0])).toEqual({ create_pr: 1, delegate_mode: 1 })
    // Per-item, not batch-wide: the second row must NOT inherit the first's flags.
    expect(rowOf(ids[1])).toEqual({ create_pr: 0, delegate_mode: 0 })
  })

  it('defaults both flags to 0 when omitted (no behaviour change for existing callers)', async () => {
    const { status, json } = await createObjectives([{ title: 'w7 omitted flags' }])
    expect(status).toBe(201)
    expect(rowOf(firstId(json))).toEqual({ create_pr: 0, delegate_mode: 0 })
  })

  it('coerces an explicit false to 0 rather than storing NULL', async () => {
    const { status, json } = await createObjectives([
      { title: 'w7 explicit false', create_pr: false, delegate_mode: false },
    ])
    expect(status).toBe(201)
    expect(rowOf(firstId(json))).toEqual({ create_pr: 0, delegate_mode: 0 })
  })
})

describe('B. a field that cannot be honoured is rejected, never silently dropped', () => {
  it('rejects an unknown field with a 400 naming it', async () => {
    const { status, json } = await createObjectives([{ title: 'w7 unknown', priority: 'high' }])
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/priority/)
  })

  it('rejects "agent" (the agent_context typo that produced a silent cto default)', async () => {
    const { status, json } = await createObjectives([{ title: 'w7 agent typo', agent: 'general' }])
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/agent_context/)
  })

  // Grafted from the concurrently-spawned twin's PR #280 (see the decision doc):
  // a machine-readable key list plus near-miss hints for the names ad-hoc curl
  // callers actually reach for.
  it('names the unsupported keys machine-readably and hints the near-miss', async () => {
    const { status, json } = await createObjectives([{ title: 'w7 hints', priority: 'high', goal: 'g' }])
    expect(status).toBe(400)
    expect(json.unsupported_fields).toEqual(['priority', 'goal'])
    expect(String(json.error)).toMatch(/Did you mean 'effort' for 'priority'/)
    expect(String(json.error)).toMatch(/Did you mean 'completion_goal' for 'goal'/)
  })

  it('rejects a client-supplied status instead of silently storing the default', async () => {
    const { status, json } = await createObjectives([{ title: 'w7 status', status: 'queued' }])
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/status/)
  })

  it('rejects a non-retro origin instead of silently recomputing it', async () => {
    const { status, json } = await createObjectives([{ title: 'w7 origin', origin: 'manual' }])
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/origin/)
  })

  it('rejects an invalid type instead of silently falling back to task', async () => {
    const { status, json } = await createObjectives([{ title: 'w7 type', type: 'epic' }])
    expect(status).toBe(400)
    expect(String(json.error)).toMatch(/type/)
  })

  it('rejects the whole batch when any item carries an unknown field', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) n FROM objectives').get() as { n: number }).n
    const { status } = await createObjectives([
      { title: 'w7 good item' },
      { title: 'w7 bad item', nonsense: 1 },
    ])
    expect(status).toBe(400)
    const after = (getDb().prepare('SELECT COUNT(*) n FROM objectives').get() as { n: number }).n
    expect(after).toBe(before)
  })

  it('still accepts origin:"retro" (the one whitelisted override) and every documented field', async () => {
    const { status, json } = await createObjectives([{
      title: 'w7 full accepted payload',
      description: 'd',
      agent_context: 'cto',
      workspace: 'example',
      project: null,
      category: 'general',
      completion_goal: 'g',
      workflow_hint: 'h',
      effort: 'small',
      model: 'claude-opus-5',
      type: 'bug',
      origin: 'retro',
      acceptance_criteria: [{ id: 'a', criterion: 'c' }],
      create_pr: true,
      delegate_mode: false,
    }])
    expect(status).toBe(201)
    expect(rowOf(firstId(json))).toEqual({ create_pr: 1, delegate_mode: 0 })
  })
})
