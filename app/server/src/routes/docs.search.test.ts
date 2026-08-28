import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcrypt'

const TMP_DB = path.join(os.tmpdir(), `cc-docs-search-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-docs-search-xx'

const { initDb, getDb } = await import('../db/index.js')
const { default: docsRouter } = await import('./docs.js')

let server: http.Server
let baseUrl: string
let cookie: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const hash = bcrypt.hashSync('pw', 4)
  getDb().prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('mike', hash, 'admin')
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/docs', docsRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  cookie = `token=${jwt.sign({ id: 1, username: 'mike', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('GET /api/docs/search', () => {
  it('requires auth', async () => {
    const res = await fetch(`${baseUrl}/api/docs/search?q=example`)
    expect(res.status).toBe(401)
  })

  it('requires q', async () => {
    const res = await fetch(`${baseUrl}/api/docs/search`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(400)
  })

  it('returns results array even if the vault is empty on this host', async () => {
    const res = await fetch(`${baseUrl}/api/docs/search?q=uptimerobot`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json() as { results: unknown[] }
    expect(Array.isArray(body.results)).toBe(true)
  })
})
