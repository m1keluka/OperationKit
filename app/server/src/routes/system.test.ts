import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-system-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-system'

const { initDb, getDb } = await import('../db/index.js')
const { createSystemRouter, toSystemDiskResponse, toSystemPreviewHealthResponse } = await import('./system.js')
type State = import('../services/disk-watchdog.js').DiskWatchdogState
type PreviewState = import('../services/preview-health-watchdog.js').PreviewHealthState

const GiB = 1024 * 1024 * 1024
let current: State
let currentPreview: PreviewState | null
let server: http.Server
let baseUrl: string

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = express()
  app.use(cookieParser())
  app.use('/api/system', createSystemRouter(() => current, () => currentPreview))
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
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

const cookie = () => `token=${jwt.sign({ id: 1, username: 'tester', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

describe('GET /api/system/disk', () => {
  it('requires auth', async () => {
    current = { disk: null, action: 'ok', low: false, checkedAt: 'x' }
    const res = await fetch(`${baseUrl}/api/system/disk`)
    expect(res.status).toBe(401)
  })

  it('returns the disk shape with free percentage and low flag', async () => {
    current = {
      disk: { usedPct: 88, availBytes: 10 * GiB, totalBytes: 100 * GiB },
      action: 'warn',
      low: true,
      checkedAt: '2026-10-23T00:00:00.000Z',
    }
    const res = await fetch(`${baseUrl}/api/system/disk`, { headers: { Cookie: cookie() } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      usedPct: 88,
      freePct: 10,
      availBytes: 10 * GiB,
      totalBytes: 100 * GiB,
      low: true,
      action: 'warn',
      checkedAt: '2026-10-23T00:00:00.000Z',
    })
  })
})

describe('GET /api/system/preview-health', () => {
  it('requires auth', async () => {
    currentPreview = null
    const res = await fetch(`${baseUrl}/api/system/preview-health`)
    expect(res.status).toBe(401)
  })

  it('reports unknown when the watchdog has not ticked / no PR is open', async () => {
    currentPreview = null
    const res = await fetch(`${baseUrl}/api/system/preview-health`, { headers: { Cookie: cookie() } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'unknown', prNumber: null, previewUrl: null, httpCode: null, error: null, checkedAt: null,
    })
  })

  it('reports down with the preview URL and error on an outage', async () => {
    currentPreview = {
      status: 'down',
      canary: { objectiveId: 42, prNumber: 586, title: 'preview infra fallback', updatedAt: 't' },
      probe: { ok: false, httpCode: null, ms: null, error: 'tlsv1 alert internal error' },
      checkedAt: '2026-10-28T13:00:00.000Z',
    }
    const res = await fetch(`${baseUrl}/api/system/preview-health`, { headers: { Cookie: cookie() } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'down',
      prNumber: 586,
      previewUrl: 'https://pr-586.cc.example.com',
      httpCode: null,
      error: 'tlsv1 alert internal error',
      checkedAt: '2026-10-28T13:00:00.000Z',
    })
  })

  it('reports up when the probe succeeds', async () => {
    currentPreview = {
      status: 'up',
      canary: { objectiveId: 42, prNumber: 586, title: 'preview infra fallback', updatedAt: 't' },
      probe: { ok: true, httpCode: 200, ms: 120, error: null },
      checkedAt: '2026-10-28T13:10:00.000Z',
    }
    const res = await fetch(`${baseUrl}/api/system/preview-health`, { headers: { Cookie: cookie() } })
    const body = await res.json()
    expect(body.status).toBe('up')
    expect(body.httpCode).toBe(200)
  })
})

describe('toSystemPreviewHealthResponse', () => {
  it('nulls everything with no state', () => {
    expect(toSystemPreviewHealthResponse(null)).toEqual({
      status: 'unknown', prNumber: null, previewUrl: null, httpCode: null, error: null, checkedAt: null,
    })
  })
})

describe('toSystemDiskResponse', () => {
  it('nulls the numbers when df failed', () => {
    expect(toSystemDiskResponse({ disk: null, action: 'ok', low: false, checkedAt: 't' })).toEqual({
      usedPct: null, freePct: null, availBytes: null, totalBytes: null, low: false, action: 'ok', checkedAt: 't',
    })
  })
  it('rounds freePct to one decimal', () => {
    const r = toSystemDiskResponse({ disk: { usedPct: 65, availBytes: 276 * GiB, totalBytes: 774 * GiB }, action: 'ok', low: false, checkedAt: 't' })
    expect(r.freePct).toBe(35.7)
  })
})
