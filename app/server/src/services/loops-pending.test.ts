import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Point the loops engine at a throwaway vault BEFORE importing it (VAULT_PATH is read
// at import time). The loops route needs admin auth, so also isolate the DB + JWT.
process.env.JWT_SECRET = 'test-secret-loops-pending'
const TMP_DB = path.join(os.tmpdir(), `cc-loops-pending-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const VAULT = fs.mkdtempSync(path.join(os.tmpdir(), 'loops-pending-vault-'))
process.env.VAULT_PATH = VAULT
process.env.GRANOLA_WORKSPACE = 'operator'
const LOOPS_DIR = path.join(VAULT, 'workspaces', 'operator', 'loops')

const loops = await import('./loops.js')
const { initDb, getDb } = await import('../db/index.js')
const { default: loopsRouter } = await import('../routes/loops.js')

let server: http.Server
let baseUrl: string
const adminCookie = () => `token=${jwt.sign({ id: 1, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function call(method: string, p: string) {
  const res = await fetch(`${baseUrl}/api/loops${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie() },
  })
  const text = await res.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: res.status, json }
}

// Write a raw loop file with an arbitrary stored status (mirrors what loops-add.mjs
// or a legacy file looks like on disk) so we can assert how normalizeStatus reads it.
function writeRawLoop(slug: string, status: string) {
  fs.mkdirSync(LOOPS_DIR, { recursive: true })
  const fm = [
    '---',
    `title: ${JSON.stringify(slug)}`,
    `status: ${status}`,
    'party: ""',
    'tags: []',
    'opened: 2026-07-11',
    '---',
    '',
    'body',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(LOOPS_DIR, `${slug}.md`), fm, 'utf8')
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')`).run()

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/loops', loopsRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

describe('loops — pending review lane', () => {
  it('pending is a valid loop status', () => {
    expect((loops.LOOP_STATUSES as readonly string[])).toContain('pending')
  })

  it('a file stamped status: pending reads as pending', () => {
    writeRawLoop('auto-detected-thing', 'pending')
    const l = loops.listLoops().find(x => x.slug === 'auto-detected-thing')
    expect(l).toBeTruthy()
    expect(l!.status).toBe('pending')
  })

  it('EXISTING-LOOPS-SAFE: legacy status: open still reads as queued, not pending', () => {
    writeRawLoop('legacy-open-loop', 'open')
    writeRawLoop('already-queued-loop', 'queued')
    const all = loops.listLoops()
    expect(all.find(x => x.slug === 'legacy-open-loop')!.status).toBe('queued')
    expect(all.find(x => x.slug === 'already-queued-loop')!.status).toBe('queued')
    // None of the non-pending files flipped into the review lane.
    expect(all.filter(x => x.status === 'pending').map(x => x.slug)).toEqual(['auto-detected-thing'])
  })

  it('patchLoopStatus accepts pending as a valid target (service level)', () => {
    const r = loops.createLoop({ party: '', title: 'move me to pending' })
    const moved = loops.patchLoopStatus(r.loop!.slug, 'pending')
    expect(moved.ok).toBe(true)
    expect(moved.loop!.status).toBe('pending')
  })

  it('APPROVE route moves a pending loop -> queued', async () => {
    writeRawLoop('approve-me', 'pending')
    const r = await call('POST', '/approve-me/approve')
    expect(r.status).toBe(200)
    expect(r.json.loop.status).toBe('queued')
    // reread from disk confirms it persisted
    expect(loops.listLoops().find(x => x.slug === 'approve-me')!.status).toBe('queued')
  })

  it('DENY route archives a pending loop (off the board, recoverable)', async () => {
    writeRawLoop('deny-me', 'pending')
    const r = await call('POST', '/deny-me/deny')
    expect(r.status).toBe(200)
    expect(r.json.ok).toBe(true)
    expect(loops.listLoops().some(x => x.slug === 'deny-me')).toBe(false)
    expect(fs.existsSync(path.join(VAULT, 'workspaces', 'operator', 'loops-archive', 'deny-me.md'))).toBe(true)
  })

  it('approve on a missing slug 404s', async () => {
    const r = await call('POST', '/nope/approve')
    expect(r.status).toBe(404)
  })
})
