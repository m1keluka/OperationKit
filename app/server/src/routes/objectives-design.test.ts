import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import { DESIGN_FRAME_CSP } from '../middleware/security-headers.js'
import { securityHeaders } from '../middleware/security-headers.js'

const TMP_DB = path.join(os.tmpdir(), `cc-design-frame-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-design-frame'

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')

const ADMIN_ID = 1
const WS = 'example'
const UPSTREAM_HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="/_next/static/css/app.css">
<script src="/_next/static/chunks/main.js"></script>
<title>WS</title></head><body><h1>Example Project</h1></body></html>`

const realFetch = globalThis.fetch.bind(globalThis)
let server: http.Server
let baseUrl: string
let objId: number

const token = () => jwt.sign(
  { id: ADMIN_ID, username: 'admin', role: 'admin' },
  process.env.JWT_SECRET as string,
  { expiresIn: '1h' },
)

function mockUpstream(hrefPrefix: string, html = UPSTREAM_HTML, status = 200, contentType = 'text/html') {
  globalThis.fetch = (async (url: any, init?: any) => {
    if (String(url).startsWith(hrefPrefix)) {
      return new Response(html, { status, headers: { 'content-type': contentType } })
    }
    return realFetch(url, init)
  }) as typeof fetch
}

async function getFrame(id: number, previewUrl: string, cookie = true) {
  const qs = `url=${encodeURIComponent(previewUrl)}&parent=${encodeURIComponent('https://cc.example.com')}`
  const headers: Record<string, string> = {
    Host: 'cc.example.com',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': 'cc.example.com',
  }
  if (cookie) headers.Cookie = `token=${token()}`
  return fetch(`${baseUrl}/api/objectives/${id}/design-frame?${qs}`, { headers })
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  const row = getDb().prepare(
    `INSERT INTO objectives (title, workspace, created_by, status) VALUES ('WS Landing Page', ?, ?, 'review')`,
  ).run(WS, ADMIN_ID)
  objId = Number(row.lastInsertRowid)

  const app = express()
  app.use(securityHeaders)
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(() => {
  globalThis.fetch = realFetch
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${s}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('GET /api/objectives/:id/design-frame', () => {
  it('401s without a session cookie', async () => {
    const res = await getFrame(objId, 'https://ws-landing-preview.vercel.app/', false)
    expect(res.status).toBe(401)
  })

  it('rejects private preview hosts', async () => {
    const res = await getFrame(objId, 'http://localhost:3000/')
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('Private/local hosts are blocked')
  })

  it('rewrites the preview and sets a frameable CSP so CSS can load', async () => {
    mockUpstream('https://ws-landing-preview.vercel.app/')
    const res = await getFrame(objId, 'https://ws-landing-preview.vercel.app/')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('content-security-policy')).toBe(DESIGN_FRAME_CSP)
    const html = await res.text()
    expect(html).toContain('<base href="https://ws-landing-preview.vercel.app/')
    expect(html).toContain('/_next/static/css/app.css')
    expect(html).not.toContain('/_next/static/chunks/main.js')
    expect(html).toContain('data-cc-design-bridge')
    expect(html).toContain('https://cc.example.com')
  })
})
