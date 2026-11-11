// Objective DAG queryability on GET /api/internal/objectives (obj 707003, P0-2).
//
// Before this change `?parent_id=706936` was not in the supported filter list, so
// it was silently DROPPED and the endpoint answered with all 8,362 rows and HTTP
// 200 — a full-board false positive that a caller could not distinguish from a
// correct answer. This suite pins the two halves of the fix:
//
//   1. parent-id-filter   : ?parent_id= returns DIRECT children only (not the
//                           subtree, not the board), ?parent_id=null the top tier
//   2. ancestor-id-filter : ?ancestor_id= returns the whole subtree below a node,
//                           and terminates on a parent cycle instead of hanging
//   3. strict-params      : an unsupported param is a 400 carrying the supported
//                           list — NOT a 200 over the unfiltered board
//   4. back-compat        : every param that worked before still works
//   5. depth-transitive   : a 3-level chain reports depths {0,1,2} through the API

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-obj-dag-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')
const { SUPPORTED_LIST_PARAMS } = await import('../lib/objectives-projection.js')

let server: http.Server
let baseUrl: string

// A deliberately 3-DEEP tree — the shape the old one-shot `depth = 1` backfill
// could not express, and the shape the acceptance criterion names.
let rootId: number      // depth 0
let childA: number      // depth 1
let childB: number      // depth 1
let grandchild: number  // depth 2
let otherRoot: number   // depth 0, unrelated — proves the filter excludes it

interface Listed { status: number; headers: Headers; body: unknown }

async function list(qs = ''): Promise<Listed> {
  const res = await fetch(`${baseUrl}/api/internal/objectives${qs}`)
  return { status: res.status, headers: res.headers, body: await res.json() }
}

async function rows(qs = ''): Promise<Record<string, unknown>[]> {
  const { body } = await list(qs)
  return body as Record<string, unknown>[]
}

function ids(rs: Record<string, unknown>[]): number[] {
  return rs.map(r => Number(r.id)).sort((a, b) => a - b)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  const insert = db.prepare(
    `INSERT INTO objectives (title, status, agent_context, workspace, parent_id, depth)
     VALUES (?, ?, 'cto', ?, ?, ?)`,
  )
  const add = (title: string, parent: number | null, depth: number, ws = 'example', status = 'queue') =>
    Number(insert.run(title, status, ws, parent, depth).lastInsertRowid)

  rootId = add('root', null, 0)
  childA = add('child-a', rootId, 1)
  childB = add('child-b', rootId, 1, 'example2', 'done')
  grandchild = add('grandchild', childA, 2)
  otherRoot = add('other-root', null, 0)
  add('other-child', otherRoot, 1)

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

describe('?parent_id= — direct children only (obj 707003)', () => {
  it('returns exactly the direct children, not the subtree and not the board', async () => {
    const rs = await rows(`?parent_id=${rootId}`)
    expect(ids(rs)).toEqual([childA, childB].sort((a, b) => a - b))
    // The regression this closes: the grandchild is NOT a direct child, and the
    // unrelated tree is not in the answer at all.
    expect(ids(rs)).not.toContain(grandchild)
    expect(ids(rs)).not.toContain(otherRoot)
  })

  it('no longer returns the unfiltered board — the silent-ignore false positive', async () => {
    const all = await rows()
    const filtered = await rows(`?parent_id=${rootId}`)
    expect(all.length).toBe(6)
    expect(filtered.length).toBe(2)
  })

  it('reports the filtered total in X-Total-Count, not the board total', async () => {
    const { headers } = await list(`?parent_id=${rootId}`)
    expect(headers.get('X-Total-Count')).toBe('2')
  })

  it('a leaf has no children — an empty array, not a fallback to everything', async () => {
    expect(await rows(`?parent_id=${grandchild}`)).toEqual([])
  })

  it('?parent_id=null returns the TOP tier (parent_id IS NULL)', async () => {
    expect(ids(await rows('?parent_id=null'))).toEqual([rootId, otherRoot].sort((a, b) => a - b))
  })

  it('composes with the existing filters instead of overriding them', async () => {
    expect(ids(await rows(`?parent_id=${rootId}&workspace=example2`))).toEqual([childB])
    expect(ids(await rows(`?parent_id=${rootId}&include_terminal=0`))).toEqual([childA])
  })
})

describe('?ancestor_id= — the whole subtree (obj 707003)', () => {
  it('returns every strict descendant, at any depth', async () => {
    expect(ids(await rows(`?ancestor_id=${rootId}`)))
      .toEqual([childA, childB, grandchild].sort((a, b) => a - b))
  })

  it('excludes the node itself (children-only semantics, same as parent_id)', async () => {
    expect(ids(await rows(`?ancestor_id=${rootId}`))).not.toContain(rootId)
  })

  it('terminates on a parent cycle rather than walking forever', async () => {
    const db = getDb()
    // Make the grandchild the parent of its own grandparent: root -> a -> gc -> root.
    db.prepare('UPDATE objectives SET parent_id = ? WHERE id = ?').run(grandchild, rootId)
    try {
      const rs = await rows(`?ancestor_id=${childA}`)
      expect(ids(rs)).toEqual([rootId, childA, childB, grandchild].sort((a, b) => a - b))
    } finally {
      db.prepare('UPDATE objectives SET parent_id = NULL WHERE id = ?').run(rootId)
    }
  })
})

describe('strict unknown-param rejection (obj 707003)', () => {
  it('400s an unsupported param instead of returning the whole board', async () => {
    const { status, body } = await list('?bogus=1')
    expect(status).toBe(400)
    const err = body as { error: string; unknown_params: string[]; supported_params: string[] }
    expect(err.unknown_params).toEqual(['bogus'])
    expect(err.error).toContain('bogus')
    // Not an array of rows — the caller cannot mistake the error for an answer.
    expect(Array.isArray(body)).toBe(false)
  })

  it('names every unsupported param, so one round-trip fixes the call', async () => {
    const { status, body } = await list('?bogus=1&alsoBogus=2&workspace=example')
    expect(status).toBe(400)
    expect((body as { unknown_params: string[] }).unknown_params.sort())
      .toEqual(['alsoBogus', 'bogus'])
  })

  it('advertises the supported set in the error body', async () => {
    const { body } = await list('?bogus=1')
    expect((body as { supported_params: string[] }).supported_params)
      .toEqual([...SUPPORTED_LIST_PARAMS])
  })

  it('catches the near-miss spellings a caller actually makes', async () => {
    for (const qs of ['?parentId=1', '?parent=1', '?ancestor=1', '?field=minimal']) {
      expect((await list(qs)).status).toBe(400)
    }
  })

  it('still accepts every previously-supported param (no caller breakage)', async () => {
    for (const qs of [
      '', '?fields=minimal', '?fields=summary', '?fields=full', '?workspace=example',
      '?status=queue', '?since=2026-01-01', '?include_terminal=0', '?limit=5&offset=1',
      '?fields=minimal&include_terminal=0',
    ]) {
      expect((await list(qs)).status).toBe(200)
    }
  })

  it('stays lenient about VALUES — only unknown NAMES are rejected', async () => {
    // ?fields=bogus has always fallen back to `summary`; that back-compat is
    // deliberate and unchanged. The contract being enforced is the param SET.
    const { status, headers } = await list('?fields=bogus')
    expect(status).toBe(200)
    expect(headers.get('X-Fields-Mode')).toBe('summary')
  })

  it('every supported param name is actually accepted by the route', async () => {
    for (const p of SUPPORTED_LIST_PARAMS) {
      expect((await list(`?${p}=1`)).status).toBe(200)
    }
  })
})

describe('depth is transitively correct over the API (obj 707003)', () => {
  it('a 3-level chain reports depths {0,1,2}', async () => {
    const byId = new Map((await rows('?fields=minimal')).map(r => [Number(r.id), Number(r.depth)]))
    expect(byId.get(rootId)).toBe(0)
    expect(byId.get(childA)).toBe(1)
    expect(byId.get(grandchild)).toBe(2)
  })
})
