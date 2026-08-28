import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Real SQLite + the real objectives router. We only exercise the additive
// /goal/draft endpoint, whose handler touches no DB — it just validates input,
// calls the Anthropic API (mocked via global.fetch), and shapes the response.
const TMP_DB = path.join(os.tmpdir(), `cc-goal-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-goal'
process.env.ANTHROPIC_API_KEY = 'test-key'

const { initDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')

let server: http.Server
let baseUrl: string
let cookie: string

function makeApp(): express.Express {
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  return app
}

function authToken(): string {
  return jwt.sign({ id: 1, username: 'tester', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

// Real fetch — used by the test client itself and for any non-Anthropic call.
const realFetch = globalThis.fetch.bind(globalThis)

// Install a global.fetch that intercepts ONLY the Anthropic Messages API
// (what the route calls) and passes everything else through to real HTTP so the
// test client's own request to our express server still works.
function mockAnthropic(text: string, ok = true) {
  global.fetch = vi.fn(async (url: any, init?: any) => {
    if (String(url).includes('api.anthropic.com')) {
      return {
        ok,
        json: async () => ({ content: [{ type: 'text', text }] }),
      } as any
    }
    return realFetch(url, init)
  }) as unknown as typeof fetch
}

async function post(body: unknown) {
  const res = await fetch(`${baseUrl}/api/objectives/goal/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const app = makeApp()
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('server has no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  cookie = `token=${authToken()}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
})

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('POST /api/objectives/goal/draft', () => {
  it('returns 400 when title is missing', async () => {
    mockAnthropic('{"mode":"goal","goal":"x"}')
    const { status } = await post({})
    expect(status).toBe(400)
  })

  it('returns 400 when title is empty/whitespace', async () => {
    mockAnthropic('{"mode":"goal","goal":"x"}')
    const { status } = await post({ title: '   ' })
    expect(status).toBe(400)
  })

  it('skipQuestions forces mode:goal even if the model asks questions', async () => {
    mockAnthropic('{"mode":"goal","goal":"Ship the feature and verify it live."}')
    const { status, json } = await post({ title: 'Build X', skipQuestions: true })
    expect(status).toBe(200)
    expect(json.mode).toBe('goal')
    expect(typeof json.goal).toBe('string')
    expect(json.goal.length).toBeGreaterThan(0)
  })

  it('answers[] yields mode:goal', async () => {
    mockAnthropic('{"mode":"goal","goal":"Concrete measurable goal."}')
    const { status, json } = await post({
      title: 'Build X',
      answers: [{ question: 'Scope?', answer: 'MVP' }],
    })
    expect(status).toBe(200)
    expect(json.mode).toBe('goal')
    expect(json.goal).toBe('Concrete measurable goal.')
  })

  it('returns the questions branch shape on the first call', async () => {
    mockAnthropic(
      '{"mode":"questions","questions":[{"id":"q1","question":"Scope?","options":["MVP","Full"]}]}'
    )
    const { status, json } = await post({ title: 'Build X' })
    expect(status).toBe(200)
    expect(json.mode).toBe('questions')
    expect(Array.isArray(json.questions)).toBe(true)
    expect(json.questions[0]).toMatchObject({
      id: 'q1',
      question: 'Scope?',
    })
    expect(Array.isArray(json.questions[0].options)).toBe(true)
  })

  it('returns 502 when the LLM request fails (non-ok)', async () => {
    mockAnthropic('whatever', false)
    const { status } = await post({ title: 'Build X' })
    expect(status).toBe(502)
  })

  it('returns 502 (not a 500 crash) on unparseable model output', async () => {
    mockAnthropic('this is not json at all')
    const { status } = await post({ title: 'Build X' })
    expect(status).toBe(502)
  })
})
