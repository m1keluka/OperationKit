// Field projection + bounded paging on GET /api/internal/objectives (obj 705914).
//
// The endpoint used to SELECT * over the whole table: 7.5k rows = ~44 MB / 10.6s,
// which intermittently blew the daily verify sweep's 30s fetch cap and
// false-reported the API as DOWN. The fix is a COLUMN projection (the prose
// columns are ~97% of the bytes), not a row cut. This proves:
//
//   1. default-projection : default omits the heavy prose columns but keeps the
//                           lean ones — and returns EVERY row (no silent card loss)
//   2. default-shape      : response is still a bare JSON array (no envelope),
//                           newest-first, with count/mode headers
//   3. fields-full        : ?fields=full restores prose AND is bounded to one page
//                           (the 44 MB body is unreachable) with X-Truncated=true
//   4. include-terminal   : ?include_terminal=0 drops done/cancelled
//   5. filters            : ?status=, ?workspace=, ?since= still narrow correctly
//   6. paging             : ?limit=/&offset= page deterministically
//   7. payload-shrink     : the default body is an order of magnitude smaller than
//                           ?fields=full over the same rows (the actual bug)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-obj-pagination-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')
const { HEAVY_COLUMNS, MINIMAL_COLUMNS, FULL_PAGE_MAX } = await import('../lib/objectives-projection.js')

let server: http.Server
let baseUrl: string

const TOTAL = 260 // > FULL_PAGE_MAX, so the full-fat page provably truncates
const PROSE = 'x'.repeat(2000)

interface Listed { status: number; headers: Headers; rows: Record<string, unknown>[] }

async function list(qs = ''): Promise<Listed> {
  const res = await fetch(`${baseUrl}/api/internal/objectives${qs}`)
  const rows = (await res.json()) as Record<string, unknown>[]
  return { status: res.status, headers: res.headers, rows }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO objectives (title, description, status, agent_context, workspace, last_session_summary, acceptance_criteria, updated_at)
     VALUES (?, ?, ?, 'cto', ?, ?, ?, ?)`,
  )
  for (let i = 0; i < TOTAL; i++) {
    // Deterministic mix: 3/4 terminal (mirrors the real board's done-heavy tail).
    const status = i % 4 === 0 ? 'queue' : i % 4 === 1 ? 'done' : i % 4 === 2 ? 'cancelled' : 'done'
    const day = String(10 + (i % 20)).padStart(2, '0')
    insert.run(`obj-${i}`, PROSE, status, i % 2 === 0 ? 'example' : 'example2', PROSE, PROSE, `2026-08-${day} 00:00:00`)
  }

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

describe('GET /api/internal/objectives — default field projection (obj 705914)', () => {
  it('omits every heavy prose column by default', async () => {
    const { status, rows } = await list()
    expect(status).toBe(200)
    for (const col of HEAVY_COLUMNS) {
      expect(rows[0]).not.toHaveProperty(col)
    }
  })

  it('keeps the lean columns callers actually read', async () => {
    const { rows } = await list()
    for (const col of ['id', 'title', 'status', 'workspace', 'agent_context', 'session_id', 'updated_at', 'created_at']) {
      expect(rows[0]).toHaveProperty(col)
    }
  })

  it('still returns EVERY row — projection must not silently drop cards', async () => {
    const { rows, headers } = await list()
    expect(rows).toHaveLength(TOTAL)
    expect(headers.get('x-total-count')).toBe(String(TOTAL))
    expect(headers.get('x-returned-count')).toBe(String(TOTAL))
    expect(headers.get('x-fields-mode')).toBe('summary')
    expect(headers.get('x-truncated')).toBe('false')
  })

  it('is still a bare JSON array ordered newest-first (no envelope, no shape break)', async () => {
    const { rows } = await list()
    expect(Array.isArray(rows)).toBe(true)
    const updated = rows.map(r => String(r.updated_at))
    expect([...updated].sort().reverse()).toEqual(updated)
  })

  it('shrinks the payload several-fold vs the full-fat projection over the same rows', async () => {
    const summary = await fetch(`${baseUrl}/api/internal/objectives?limit=${FULL_PAGE_MAX}`).then(r => r.text())
    const full = await fetch(`${baseUrl}/api/internal/objectives?fields=full&limit=${FULL_PAGE_MAX}`).then(r => r.text())
    // 3 prose columns × 2 KB here; on the real board the ratio is ~30× (44 MB → 1.3 MB).
    expect(full.length).toBeGreaterThan(summary.length * 5)
  })
})

describe('GET /api/internal/objectives — ?fields=minimal (what probes read)', () => {
  it('returns exactly the minimal allowlist, and all rows', async () => {
    const { rows, headers } = await list('?fields=minimal')
    expect(rows).toHaveLength(TOTAL)
    expect(Object.keys(rows[0]).sort()).toEqual([...MINIMAL_COLUMNS].sort())
    expect(headers.get('x-fields-mode')).toBe('minimal')
  })

  it('still carries every field the daily verify sweep asserts on', async () => {
    const { rows } = await list('?fields=minimal')
    // board-sane checks: numeric unique id, non-empty title, valid status,
    // and "working implies session_id".
    for (const col of ['id', 'title', 'status', 'session_id']) expect(rows[0]).toHaveProperty(col)
  })

  it('is materially smaller than the default summary projection', async () => {
    const summary = await fetch(`${baseUrl}/api/internal/objectives`).then(r => r.text())
    const minimal = await fetch(`${baseUrl}/api/internal/objectives?fields=minimal`).then(r => r.text())
    expect(minimal.length).toBeLessThan(summary.length / 2)
  })

  it('an unknown ?fields= value falls back to the default projection', async () => {
    const { headers, rows } = await list('?fields=bogus')
    expect(headers.get('x-fields-mode')).toBe('summary')
    expect(rows).toHaveLength(TOTAL)
  })
})

describe('GET /api/internal/objectives — ?fields=full is bounded', () => {
  it('restores the prose columns', async () => {
    const { rows } = await list('?fields=full')
    expect(rows[0]).toHaveProperty('description')
    expect(rows[0].description).toBe(PROSE)
  })

  it('caps an unbounded full request to one page and says so', async () => {
    const { rows, headers } = await list('?fields=full')
    expect(rows).toHaveLength(FULL_PAGE_MAX)
    expect(headers.get('x-total-count')).toBe(String(TOTAL))
    expect(headers.get('x-truncated')).toBe('true')
    expect(headers.get('x-fields-mode')).toBe('full')
  })

  it('caps an over-large explicit limit too', async () => {
    const { rows } = await list('?fields=full&limit=100000')
    expect(rows).toHaveLength(FULL_PAGE_MAX)
  })
})

describe('GET /api/internal/objectives — filters', () => {
  it('?include_terminal=0 drops done + cancelled', async () => {
    const { rows, headers } = await list('?include_terminal=0')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.status !== 'done' && r.status !== 'cancelled')).toBe(true)
    expect(headers.get('x-total-count')).toBe(String(rows.length))
  })

  it('an explicit ?status= wins over include_terminal (done stays reachable)', async () => {
    const { rows } = await list('?status=done&include_terminal=0')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.status === 'done')).toBe(true)
  })

  it('?workspace= narrows to that workspace', async () => {
    const { rows } = await list('?workspace=example2')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.workspace === 'example2')).toBe(true)
  })

  it('?since= narrows by updated_at', async () => {
    const { rows } = await list('?since=2026-08-25')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => String(r.updated_at) >= '2026-08-25')).toBe(true)
    expect(rows.length).toBeLessThan(TOTAL)
  })

  it('combines filters (workspace + status)', async () => {
    const { rows } = await list('?workspace=example&status=queue')
    expect(rows.every(r => r.workspace === 'example' && r.status === 'queue')).toBe(true)
  })
})

describe('GET /api/internal/objectives — paging', () => {
  it('limit/offset page deterministically without overlap', async () => {
    const page1 = await list('?limit=50')
    const page2 = await list('?limit=50&offset=50')
    expect(page1.rows).toHaveLength(50)
    expect(page2.rows).toHaveLength(50)
    const ids1 = new Set(page1.rows.map(r => r.id))
    expect(page2.rows.some(r => ids1.has(r.id))).toBe(false)
    expect(page1.headers.get('x-truncated')).toBe('true')
  })

  it('a summary request with no limit stays unbounded (the cheap full-board read)', async () => {
    const { rows } = await list('')
    expect(rows).toHaveLength(TOTAL)
  })
})
