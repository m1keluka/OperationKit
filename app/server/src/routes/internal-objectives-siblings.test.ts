// Sibling read edge + /message relationship check (obj 707038, P1-3).
//
// Two gaps this pins closed:
//
//   G6a — there was NO sibling primitive. A session curious about what its peers
//         delivered had to read `/output` (the raw session log) or pull the board
//         with `?fields=full`, both of which expose mid-flight scratch. P2.3 says
//         siblings read each other's FINAL deliverable and nothing else, so the
//         endpoint returns a fixed final-value allowlist and the suite asserts the
//         scratch columns are ABSENT — an allowlist that isn't tested for absence
//         is just a default.
//
//   G6b — POST /objectives/:id/message is localhost-only and unauthed with NO
//         relationship check, so any session could message any objective. The
//         check is one graph hop (self/parent/child/sibling) on a self-declared
//         `from_objective_id`. The back-compat half matters as much as the deny
//         half: the delegator→child wake omits the param and MUST still work, so
//         both are asserted here.
//
// session-manager.sendFollowUp is mocked — no Claude subprocess is spawned.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-obj-siblings-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const sendFollowUpMock = vi.fn()

vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, sendFollowUp: (...args: unknown[]) => sendFollowUpMock(...args) }
})

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')
const { SIBLING_FIELDS, SUPPORTED_SIBLINGS_PARAMS } = await import('../lib/objective-relations.js')

let server: http.Server
let baseUrl: string

// Mirrors the real fixture named by the objective: delegator 706936 with eight
// W-children (707003/707004/707005/707006/707007/707010/707012/707030). Same
// SHAPE — one delegator, eight direct children, a grandchild, an unrelated tree.
let delegator: number
let workers: number[] = []
let grandchild: number // child OF a worker — a niece, not a sibling
let strangerRoot: number
let strangerChild: number
let orphan: number

interface Resp {
  status: number
  headers: Headers
  body: any
}

async function get(p: string): Promise<Resp> {
  const res = await fetch(`${baseUrl}${p}`)
  return { status: res.status, headers: res.headers, body: await res.json() }
}

async function message(id: number, body: Record<string, unknown>): Promise<Resp> {
  const res = await fetch(`${baseUrl}/api/internal/objectives/${id}/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, headers: res.headers, body: await res.json() }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO objectives (title, status, agent_context, workspace, project, parent_id, depth,
                             description, last_session_summary, ai_review_verdict, ai_review_findings,
                             acceptance_criteria, completion_goal, approved_plan, session_id)
     VALUES (?, ?, 'cto', 'operator', 'command-center-infra', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const add = (title: string, parent: number | null, depth: number, status = 'done') =>
    Number(
      insert.run(
        title,
        status,
        parent,
        depth,
        `SCRATCH-DESCRIPTION for ${title}`,
        `FINAL summary for ${title}`,
        'pass',
        `SCRATCH-FINDINGS for ${title}`,
        `SCRATCH-CRITERIA for ${title}`,
        `SCRATCH-GOAL for ${title}`,
        `SCRATCH-PLAN for ${title}`,
        `sess-${title}`,
      ).lastInsertRowid,
    )

  delegator = add('delegator', null, 0, 'working')
  workers = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'].map(t => add(t, delegator, 1))
  grandchild = add('grandchild', workers[0], 2)
  strangerRoot = add('stranger-root', null, 0, 'working')
  strangerChild = add('stranger-child', strangerRoot, 1)
  orphan = add('orphan', null, 0, 'working')

  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
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

beforeEach(() => {
  sendFollowUpMock.mockReset()
  sendFollowUpMock.mockImplementation((sessionId: string) => sessionId || 'cc-new-session')
  getDb().prepare("DELETE FROM settings WHERE key = 'message_require_from_objective'").run()
})

describe('GET /objectives/:id/siblings — the direct-sibling set', () => {
  it('returns exactly the other direct children of the same parent', async () => {
    const { status, body } = await get(`/api/internal/objectives/${workers[0]}/siblings`)
    expect(status).toBe(200)
    expect(body.siblings.map((s: any) => s.id).sort((a: number, b: number) => a - b))
      .toEqual(workers.slice(1).sort((a, b) => a - b))
    expect(body.siblings).toHaveLength(7)
  })

  it('excludes SELF', async () => {
    const { body } = await get(`/api/internal/objectives/${workers[3]}/siblings`)
    expect(body.siblings.map((s: any) => s.id)).not.toContain(workers[3])
  })

  it('excludes the parent, the niece, and every unrelated tree', async () => {
    const { body } = await get(`/api/internal/objectives/${workers[0]}/siblings`)
    const ids = body.siblings.map((s: any) => s.id)
    expect(ids).not.toContain(delegator)
    expect(ids).not.toContain(grandchild)
    expect(ids).not.toContain(strangerChild)
    expect(ids).not.toContain(strangerRoot)
  })

  it('is symmetric — every worker sees the other seven', async () => {
    for (const w of workers) {
      const { body } = await get(`/api/internal/objectives/${w}/siblings`)
      expect(body.siblings).toHaveLength(7)
      expect(body.siblings.map((s: any) => s.id)).not.toContain(w)
    }
  })

  it('404s for an objective that does not exist', async () => {
    expect((await get('/api/internal/objectives/99999999/siblings')).status).toBe(404)
  })
})

describe('GET /objectives/:id/siblings — FINAL fields only, no scratch (P2.3)', () => {
  it('returns exactly the final-value allowlist and nothing more', async () => {
    const { body } = await get(`/api/internal/objectives/${workers[0]}/siblings`)
    for (const s of body.siblings) {
      expect(Object.keys(s).sort()).toEqual([...SIBLING_FIELDS].sort())
    }
    expect(body.fields).toEqual([...SIBLING_FIELDS])
  })

  it('carries the final deliverable: title, status, verdict, last_session_summary', async () => {
    const { body } = await get(`/api/internal/objectives/${workers[0]}/siblings`)
    const w2 = body.siblings.find((s: any) => s.id === workers[1])
    expect(w2.title).toBe('w2')
    expect(w2.status).toBe('done')
    expect(w2.ai_review_verdict).toBe('pass')
    expect(w2.last_session_summary).toBe('FINAL summary for w2')
    expect(typeof w2.updated_at).toBe('string')
  })

  it('leaks NO scratch column — description, findings, criteria, plan, session_id', async () => {
    const { body } = await get(`/api/internal/objectives/${workers[0]}/siblings`)
    const raw = JSON.stringify(body)
    for (const marker of ['SCRATCH-DESCRIPTION', 'SCRATCH-FINDINGS', 'SCRATCH-CRITERIA', 'SCRATCH-GOAL', 'SCRATCH-PLAN']) {
      expect(raw).not.toContain(marker)
    }
    for (const s of body.siblings) {
      for (const banned of ['description', 'ai_review_findings', 'acceptance_criteria', 'completion_goal', 'approved_plan', 'session_id']) {
        expect(s).not.toHaveProperty(banned)
      }
    }
  })
})

describe('GET /objectives/:id/siblings — orphans and the indexed path', () => {
  it('an orphan (parent_id NULL) gets an EMPTY list, not the top tier', async () => {
    const { status, body } = await get(`/api/internal/objectives/${orphan}/siblings`)
    expect(status).toBe(200)
    expect(body.siblings).toEqual([])
    // The regression this guards: "same parent_id" naively applied to NULL would
    // make every unparented card a sibling of every other one.
    expect(body.siblings.map((s: any) => s.id)).not.toContain(delegator)
    expect(body.siblings.map((s: any) => s.id)).not.toContain(strangerRoot)
  })

  it('a lone child has no siblings', async () => {
    expect((await get(`/api/internal/objectives/${strangerChild}/siblings`)).body.siblings).toEqual([])
  })

  it('uses the parent_id index — no full-board scan (EXPLAIN QUERY PLAN)', async () => {
    const db = getDb()
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM objectives WHERE parent_id = ? AND id != ?')
      .all(delegator, workers[0]) as { detail: string }[]
    const detail = plan.map(p => p.detail).join(' ')
    expect(detail).toContain('idx_objectives_parent')
    expect(detail).not.toMatch(/SCAN objectives(?! USING)/)
  })
})

describe('GET /objectives/:id/siblings — strict params (obj 707003 discipline)', () => {
  it('400s on an unknown query param, carrying the supported list', async () => {
    const { status, body } = await get(`/api/internal/objectives/${workers[0]}/siblings?fields=full`)
    expect(status).toBe(400)
    expect(body.unknown_params).toEqual(['fields'])
    expect(body.supported_params).toEqual([...SUPPORTED_SIBLINGS_PARAMS])
  })

  it('400s on a near-miss typo rather than silently ignoring it', async () => {
    expect((await get(`/api/internal/objectives/${workers[0]}/siblings?includeTerminal=0`)).status).toBe(400)
  })

  it('accepts the one supported param', async () => {
    const { status, body } = await get(`/api/internal/objectives/${workers[0]}/siblings?include_terminal=0`)
    expect(status).toBe(200)
    // Every sibling in the fixture is `done`, so dropping the terminal tail empties it.
    expect(body.siblings).toEqual([])
  })
})

describe('POST /objectives/:id/message — relationship check (G6b)', () => {
  it('REJECTS an unrelated caller with 403 and a clear error', async () => {
    const { status, body } = await message(workers[0], { message: 'hi', from_objective_id: strangerChild })
    expect(status).toBe(403)
    expect(body.error).toMatch(/no parent\/child\/sibling relationship/)
    expect(body.from_objective_id).toBe(strangerChild)
    expect(body.to_objective_id).toBe(workers[0])
    expect(sendFollowUpMock).not.toHaveBeenCalled()
  })

  it('REJECTS a grandparent — one hop only, not transitive reach', async () => {
    const { status } = await message(grandchild, { message: 'hi', from_objective_id: delegator })
    expect(status).toBe(403)
    expect(sendFollowUpMock).not.toHaveBeenCalled()
  })

  it('REJECTS orphan → orphan (sharing "no parent" is not a relationship)', async () => {
    expect((await message(delegator, { message: 'hi', from_objective_id: orphan })).status).toBe(403)
  })

  it('ACCEPTS parent → child', async () => {
    getDb().prepare("UPDATE objectives SET status = 'working' WHERE id = ?").run(workers[0])
    const { status } = await message(workers[0], { message: 'corrections', from_objective_id: delegator })
    expect(status).toBe(200)
    expect(sendFollowUpMock).toHaveBeenCalledTimes(1)
  })

  it('ACCEPTS child → parent', async () => {
    expect((await message(delegator, { message: 'done', from_objective_id: workers[0] })).status).toBe(200)
    expect(sendFollowUpMock).toHaveBeenCalledTimes(1)
  })

  it('ACCEPTS sibling → sibling', async () => {
    getDb().prepare("UPDATE objectives SET status = 'working' WHERE id IN (?, ?)").run(workers[1], workers[2])
    expect((await message(workers[1], { message: 'heads up', from_objective_id: workers[2] })).status).toBe(200)
    expect(sendFollowUpMock).toHaveBeenCalledTimes(1)
  })

  it('does not flip a done child back to working', async () => {
    const { status, body } = await message(workers[4], { message: 'corrections', from_objective_id: delegator })
    expect(status).toBe(200)
    expect(body.skipped).toBe(true)
    expect(body.reason).toBe('locked_status')
    expect(sendFollowUpMock).not.toHaveBeenCalled()
    expect(
      (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(workers[4]) as { status: string }).status,
    ).toBe('done')
  })

  it('ACCEPTS self → self (the daemon/self-nudge path)', async () => {
    expect((await message(workers[3], { message: 'wake', from_objective_id: workers[3] })).status).toBe(200)
  })

  it('400s on a malformed from_objective_id, 404s on one that does not exist', async () => {
    expect((await message(workers[0], { message: 'x', from_objective_id: 'abc' })).status).toBe(400)
    expect((await message(workers[0], { message: 'x', from_objective_id: 99999999 })).status).toBe(404)
  })
})

describe('POST /objectives/:id/message — existing flows unbroken', () => {
  it('the delegator→child wake still works with NO from_objective_id (live shape)', async () => {
    // This is byte-for-byte the body prompt-builder tells a delegator to send and
    // the shape ci-feedback-bridge posts. If this test ever fails, every delegator
    // on the board has stopped being able to iterate its workers. Target must be
    // live — a done child is locked and must not be resurrected by a wake.
    getDb().prepare("UPDATE objectives SET status = 'review' WHERE id = ?").run(workers[0])
    const { status, body } = await message(workers[0], { message: '[child-complete] worker 707003 finished' })
    expect(status).toBe(200)
    expect(body.status).toBe('working')
    expect(sendFollowUpMock).toHaveBeenCalledTimes(1)
  })

  it('an unattributed message to an UNRELATED objective still works (back-compat)', async () => {
    // Deliberate: the param is optional, so nothing that worked before breaks.
    // The tradeoff is documented on the route — this is advisory-but-recorded.
    expect((await message(strangerChild, { message: 'daemon nudge' })).status).toBe(200)
  })

  it('still 400s on an empty message and 404s on a missing objective', async () => {
    expect((await message(workers[0], { message: '   ' })).status).toBe(400)
    expect((await message(99999999, { message: 'hi' })).status).toBe(404)
  })

  it('records attribution in the activity log for both attributed and unattributed sends', async () => {
    await message(workers[0], { message: 'attributed', from_objective_id: delegator })
    await message(workers[0], { message: 'unattributed' })
    const rows = getDb()
      .prepare("SELECT detail FROM activity_log WHERE title LIKE 'internal message →%' ORDER BY id DESC LIMIT 2")
      .all() as { detail: string }[]
    expect(rows.map(r => r.detail).join('|')).toContain('relation=unattributed')
    expect(rows.map(r => r.detail).join('|')).toContain(`from_objective_id=${delegator} relation=parent`)
  })

  it('opt-in strict mode requires from_objective_id once callers are migrated', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('message_require_from_objective', '1')").run()
    const { status, body } = await message(workers[0], { message: 'no attribution' })
    expect(status).toBe(400)
    expect(body.error).toMatch(/from_objective_id is required/)
    // …and an attributed, related caller still gets through under strict mode.
    expect((await message(workers[0], { message: 'ok', from_objective_id: delegator })).status).toBe(200)
  })
})
