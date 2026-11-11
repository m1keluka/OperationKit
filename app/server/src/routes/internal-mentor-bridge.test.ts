// The old assistant bridge (/api/internal/mentor/*) lived in routes/internal.ts.
// obj 720115 removed the assistant feature but kept its data. This file now
// proves both halves of that:
//   - the bridge routes are gone (404), with or without the old service token
//   - the assistant's tables and rows survive a fresh boot (initDb is additive)

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-bridge-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.MENTOR_SERVICE_TOKEN = 'test-service-token'

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')

let server: http.Server
let baseUrl: string

async function call(method: string, pathname: string, token?: string): Promise<number> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['x-service-token'] = token
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : JSON.stringify({ content: 'hi' }),
  })
  await res.text()
  return res.status
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
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

describe('assistant bridge routes are removed', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/api/internal/mentor/threads'],
    ['POST', '/api/internal/mentor/threads'],
    ['POST', '/api/internal/mentor/threads/1/messages'],
  ]
  for (const [method, route] of routes) {
    it(`${method} ${route} → 404 even with the old service token`, async () => {
      expect(await call(method, route, 'test-service-token')).toBe(404)
      expect(await call(method, route)).toBe(404)
    })
  }
})

describe('assistant data is kept', () => {
  it('the thread, summary and config tables still exist after boot', () => {
    const names = (getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>).map(r => r.name)
    expect(names).toEqual(expect.arrayContaining(['mentor_threads', 'mentor_summaries', 'assistant_configs']))
  })

  it('existing thread rows survive a second initDb()', () => {
    const db = getDb()
    const id = db.prepare("INSERT INTO mentor_threads (title) VALUES ('kept')").run().lastInsertRowid
    initDb()
    const row = getDb().prepare('SELECT title FROM mentor_threads WHERE id = ?').get(id) as { title: string } | undefined
    expect(row?.title).toBe('kept')
  })
})
