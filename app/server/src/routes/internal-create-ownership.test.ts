/**
 * obj 900208 — children created through POST /api/internal/objectives act for
 * the parent's owner, so a fan-out / delegated coding child gets the same
 * GitHub connection instead of spawning ownerless (connector guard `no_owner`)
 * and asking for a GH_TOKEN secret.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-create-owner-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')
const { inheritedOwnership, NO_OWNERSHIP } = await import('../lib/objective-ownership.js')

let server: http.Server
let baseUrl: string

const MIKE = 501
const AVA = 502

async function create(items: unknown[]): Promise<number[]> {
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  })
  const json = (await res.json()) as { objectives?: Array<{ id: number }>; error?: string }
  expect(res.status, json.error).toBe(201)
  return json.objectives!.map(o => o.id)
}

type OwnerRow = { created_by: number | null; assigned_user_id: number | null; agent_key_id: number | null; agent_key_label: string | null }
function ownerOf(id: number): OwnerRow {
  return getDb()
    .prepare('SELECT created_by, assigned_user_id, agent_key_id, agent_key_label FROM objectives WHERE id = ?')
    .get(id) as OwnerRow
}

function insertParent(over: Partial<OwnerRow> & { workspace?: string }): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, agent_context, workspace, status, created_by, assigned_user_id, agent_key_id, agent_key_label)
       VALUES (?, 'cto', ?, 'working', ?, ?, ?, ?)`,
    )
    .run(
      `parent ${Math.random()}`,
      over.workspace ?? 'ws-a',
      over.created_by ?? null,
      over.assigned_user_id ?? null,
      over.agent_key_id ?? null,
      over.agent_key_label ?? null,
    )
  return Number(r.lastInsertRowid)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'mike', 'x', 'admin')`).run(MIKE)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'ava', 'x', 'member')`).run(AVA)
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

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { fs.unlinkSync(TMP_DB) } catch { /* ignore */ }
})

describe('POST /api/internal/objectives — child ownership (obj 900208)', () => {
  it('a child inherits the parent owner, so it spawns with that person\'s connectors', async () => {
    const parent = insertParent({ created_by: MIKE })
    const [child] = await create([{ title: 'child of mike', workspace: 'ws-a', parent_id: parent }])
    expect(ownerOf(child)).toEqual({ created_by: MIKE, assigned_user_id: null, agent_key_id: null, agent_key_label: null })
  })

  it('keeps a delegated parent delegated (assigned ≠ creator is copied as-is)', async () => {
    const parent = insertParent({ created_by: MIKE, assigned_user_id: AVA })
    const [child] = await create([{ title: 'delegated child', workspace: 'ws-a', parent_id: parent }])
    expect(ownerOf(child)).toMatchObject({ created_by: MIKE, assigned_user_id: AVA })
  })

  it('carries the parent\'s agent key so a key cannot widen its connector reach by filing a child', async () => {
    const parent = insertParent({ created_by: MIKE, agent_key_id: 77, agent_key_label: 'cos-bot' })
    const [child] = await create([{ title: 'key child', workspace: 'ws-a', parent_id: parent }])
    expect(ownerOf(child)).toMatchObject({ created_by: MIKE, agent_key_id: 77, agent_key_label: 'cos-bot' })
  })

  it('a child filed into a DIFFERENT workspace stays ownerless (no token crosses workspaces)', async () => {
    const parent = insertParent({ created_by: MIKE, workspace: 'ws-a' })
    const [child] = await create([{ title: 'cross-ws child', workspace: 'ws-b', parent_id: parent }])
    expect(ownerOf(child)).toEqual(NO_OWNERSHIP)
  })

  it('top-level internal creates are unchanged (no caller identity to attribute)', async () => {
    const [top] = await create([{ title: 'top level', workspace: 'ws-a' }])
    expect(ownerOf(top)).toEqual(NO_OWNERSHIP)
  })

  it('an ownerless parent yields an ownerless child (no owner is invented)', async () => {
    const parent = insertParent({})
    const [child] = await create([{ title: 'orphan child', workspace: 'ws-a', parent_id: parent }])
    expect(ownerOf(child)).toEqual(NO_OWNERSHIP)
  })
})

describe('inheritedOwnership', () => {
  it('returns no ownership for a missing or invalid parent', () => {
    expect(inheritedOwnership(getDb(), null, 'ws-a')).toEqual(NO_OWNERSHIP)
    expect(inheritedOwnership(getDb(), 0, 'ws-a')).toEqual(NO_OWNERSHIP)
    expect(inheritedOwnership(getDb(), 99999999, 'ws-a')).toEqual(NO_OWNERSHIP)
  })
})
