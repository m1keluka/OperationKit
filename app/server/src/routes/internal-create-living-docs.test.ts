// obj 712948 — living-docs twin guard on POST /api/internal/objectives.
//
// The docs-breathe routine re-filed "Living docs — {name}" every morning while
// yesterday's card was still queued (22 twins by Aug 27, several as "stub"
// variants). The route now refuses a twin while a card for the same normalized
// name is open in the workspace, and hands back the open card's id instead.
// Runs over the REAL express route.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-living-docs-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')
const { livingDocsName } = await import('../lib/living-docs-dedupe.js')

let server: http.Server
let baseUrl: string

async function create(items: unknown[]) {
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(items),
  })
  return { status: res.status, json: (await res.json()) as Record<string, any> }
}

const JOB = 708002
const card = (title: string, extra: Record<string, unknown> = {}) => ({
  title, workspace: 'example', agent_context: 'cto', project: 'foo', create_pr: true, source_job_id: JOB, ...extra,
})
const count = () => (getDb().prepare("SELECT COUNT(*) AS n FROM objectives WHERE title LIKE 'Living docs%'").get() as { n: number }).n

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

beforeEach(() => {
  getDb().exec("DELETE FROM objectives WHERE title LIKE 'Living docs%'")
})

describe('livingDocsName', () => {
  it('normalizes every title variant the routine produced to the same name', () => {
    expect(livingDocsName('Living docs — operationkit-site')).toBe('operationkit-site')
    expect(livingDocsName('Living docs stub — operationkit-site')).toBe('operationkit-site')
    expect(livingDocsName('Living docs — operationkit-site (stub)')).toBe('operationkit-site')
    expect(livingDocsName('Living docs - Operationkit-Site')).toBe('operationkit-site')
  })
  it('ignores non-living-docs titles', () => {
    expect(livingDocsName('Living product docs — breathe')).toBeNull()
    expect(livingDocsName('Fix living docs link')).toBeNull()
    expect(livingDocsName('')).toBeNull()
  })
})

describe('POST /api/internal/objectives — living-docs twin guard', () => {
  it('a "stub" twin of an open queued card returns the first id; row count unchanged', async () => {
    const first = await create([card('Living docs — foo')])
    expect(first.status).toBe(201)
    const firstId = first.json.objectives[0].id as number
    const row = getDb().prepare('SELECT origin, status FROM objectives WHERE id = ?').get(firstId) as { origin: string; status: string }
    expect(row).toEqual({ origin: 'job_reply', status: 'queue' })

    const twin = await create([card('Living docs stub — foo')])
    expect(twin.status).toBe(200)
    expect(twin.json.created).toBe(0)
    expect(twin.json.deduped).toBe(1)
    expect(twin.json.deduped_details[0]).toMatchObject({ id: firstId, deduped: true, status: 'queue' })
    expect(count()).toBe(1)

    // The refused twin leaves exactly one dated "still pending" line, once per day.
    await create([card('Living docs — foo (stub)')])
    const desc = (getDb().prepare('SELECT description FROM objectives WHERE id = ?').get(firstId) as { description: string }).description
    expect(desc.match(/still pending as of \d{4}-\d{2}-\d{2}/g)?.length).toBe(1)
    expect(count()).toBe(1)
  })

  it('after the open card is done, a new create inserts', async () => {
    const first = await create([card('Living docs — foo')])
    const firstId = first.json.objectives[0].id as number
    getDb().prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(firstId)
    const again = await create([card('Living docs — foo')])
    expect(again.status).toBe(201)
    expect(again.json.created).toBe(1)
    expect(again.json.objectives[0].id).not.toBe(firstId)
    expect(count()).toBe(2)
  })

  it('does not message or start a working card — just returns it', async () => {
    const first = await create([card('Living docs — foo')])
    const firstId = first.json.objectives[0].id as number
    getDb().prepare("UPDATE objectives SET status = 'working', description = 'd' WHERE id = ?").run(firstId)
    const twin = await create([card('Living docs — foo')])
    expect(twin.json.deduped_details[0]).toMatchObject({ id: firstId, status: 'working' })
    const row = getDb().prepare('SELECT status, description FROM objectives WHERE id = ?').get(firstId) as { status: string; description: string }
    expect(row).toEqual({ status: 'working', description: 'd' })
  })

  it('different repo names and different workspaces are separate cards', async () => {
    await create([card('Living docs — foo')])
    const other = await create([card('Living docs — bar')])
    expect(other.json.created).toBe(1)
    const otherWs = await create([card('Living docs — foo', { workspace: 'operator' })])
    expect(otherWs.json.created).toBe(1)
    expect(count()).toBe(3)
  })

  it('two twins in ONE batch collapse to one card; non-docs items in the batch still insert', async () => {
    const res = await create([card('Living docs — foo'), card('Living docs stub — foo'), card('Unrelated card')])
    expect(res.status).toBe(201)
    expect(res.json.created).toBe(2)
    expect(res.json.deduped).toBe(1)
    expect(count()).toBe(1)
    getDb().exec("DELETE FROM objectives WHERE title = 'Unrelated card'")
  })

  it('catches the twin even when the model drops source_job_id (origin=strategy)', async () => {
    await create([card('Living docs — foo')])
    const twin = await create([card('Living docs — foo', { source_job_id: undefined })])
    expect(twin.json.deduped).toBe(1)
    expect(count()).toBe(1)
  })
})
