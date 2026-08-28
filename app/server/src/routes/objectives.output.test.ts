import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// Exercise GET /api/objectives/:id/output payload-bounding: the default open is
// capped to a recent window, ?view=timeline collapses + short-circuits on
// ?known, and ?from&to slices are span-capped. Real SQLite + real router + a
// transcript file written to a temp TRANSCRIPT_DIR.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-output-test-'))
const TMP_DB = path.join(TMP, 'db.sqlite')
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-output'
process.env.TRANSCRIPT_DIR = TMP

const { getDb, initDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')

let server: http.Server
let baseUrl: string
let cookie: string
let objId: number
const SESSION_ID = 'cc-output-test-1'
const TOTAL_MSGS = 1000 // "large" session

function authToken(): string {
  return jwt.sign({ id: 1, username: 'tester', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function getOutput(query: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/objectives/${objId}/output${query}`, {
    headers: { Cookie: cookie },
  })
  return { status: res.status, json: await res.json() }
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'tester', 'x', 'admin')`).run()
  // Write a transcript: alternating assistant-text + tool_use lines, with a
  // couple of result anchors, so both the raw array and the timeline are large.
  const lines: string[] = []
  for (let i = 0; i < TOTAL_MSGS; i++) {
    if (i % 250 === 249) {
      lines.push(JSON.stringify({ type: 'result', result: `checkpoint ${i}`, total_cost_usd: 0.1, duration_ms: 100 }))
    } else if (i % 2 === 0) {
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `thinking ${i}` }] } }))
    } else {
      lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${i}` } }] } }))
    }
  }
  fs.writeFileSync(path.join(TMP, `${SESSION_ID}.jsonl`), lines.join('\n') + '\n')

  const r = db.prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id)
     VALUES ('big', 'cto', 'ws', 1, 'working', ?)`
  ).run(SESSION_ID)
  objId = Number(r.lastInsertRowid)

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  cookie = `token=${authToken()}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('GET /:id/output — payload bounding', () => {
  it('default first open is bounded to the most recent window, not the full array', async () => {
    const { status, json } = await getOutput('')
    expect(status).toBe(200)
    // The transcript parses to just under TOTAL_MSGS messages (results collapse
    // tool/text lines 1:1). The default must NOT return them all.
    expect(json.total).toBeGreaterThan(500)
    expect(json.messages.length).toBeLessThanOrEqual(200)
    expect(json.truncated).toBe(true)
    expect(json.from).toBe(json.total - json.messages.length)
    // The returned window is the TAIL (most recent), so it ends at the last msg.
    expect(json.messages.length).toBeGreaterThan(0)
  })

  it('?limit overrides the window; ?limit=0 returns the full array', async () => {
    const bounded = await getOutput('?limit=10')
    expect(bounded.json.messages.length).toBe(10)
    expect(bounded.json.truncated).toBe(true)

    const full = await getOutput('?limit=0')
    expect(full.json.messages.length).toBe(full.json.total)
    expect(full.json.truncated).toBe(false)
  })

  it('?view=timeline returns a collapsed segment list far smaller than the message array', async () => {
    const { status, json } = await getOutput('?view=timeline')
    expect(status).toBe(200)
    expect(Array.isArray(json.segments)).toBe(true)
    expect(json.segments.length).toBeGreaterThan(0)
    // Collapsed timeline is dramatically smaller than the raw message count.
    expect(json.segments.length).toBeLessThan(json.total / 5)
    expect(json.total).toBeGreaterThan(500)
  })

  it('?view=timeline&known=<total> short-circuits to {unchanged:true} when the session has not grown', async () => {
    const first = await getOutput('?view=timeline')
    const total = first.json.total
    const second = await getOutput(`?view=timeline&known=${total}`)
    expect(second.json.unchanged).toBe(true)
    expect(second.json.total).toBe(total)
    expect(second.json.segments).toBeUndefined()
    // A stale/lower known count still returns the full timeline.
    const stale = await getOutput('?view=timeline&known=1')
    expect(stale.json.unchanged).toBeUndefined()
    expect(Array.isArray(stale.json.segments)).toBe(true)
  })

  it('?from&to returns the requested slice; the span is capped so one fetch cannot ship the whole array', async () => {
    const small = await getOutput('?from=5&to=15')
    expect(small.json.messages.length).toBe(10)
    expect(small.json.from).toBe(5)
    expect(small.json.to).toBe(15)
    expect(small.json.truncated).toBe(false)

    // Request the entire array in one shot — must be span-capped.
    const huge = await getOutput('?from=0&to=100000')
    expect(huge.json.messages.length).toBeLessThanOrEqual(500)
    expect(huge.json.truncated).toBe(true)
    expect(huge.json.to).toBe(500)
  })
})

// ── Multi-session objectives: the thread spans ALL sessions ──
// An objective accumulates session ids over its life (respawns, wake
// continuations). The thread must concatenate every session's transcript
// chronologically — the old latest-session-only behaviour hid every earlier
// session's result summaries and user follow-ups.
describe('GET /:id/output — multi-session concatenation', () => {
  let multiId: number
  const S1 = 'cc-multi-1' // earliest (in session_intel)
  const S2 = 'cc-multi-2' // middle (in session_intel)
  const S3 = 'cc-multi-3' // current (objective.session_id, not yet in intel)
  const REVIEW = 'cc-review-multi-1' // reviewer transcript — must be excluded

  function writeTranscript(sessionId: string, marker: string) {
    const lines = [
      JSON.stringify({ type: 'prompt', title: `start ${marker}` }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${marker}` } }] } }),
      JSON.stringify({ type: 'followup', text: `user says ${marker}`, timestamp: new Date().toISOString() }),
      JSON.stringify({ type: 'result', result: `summary ${marker}`, total_cost_usd: 0.01, duration_ms: 10 }),
    ]
    fs.writeFileSync(path.join(TMP, `${sessionId}.jsonl`), lines.join('\n') + '\n')
  }

  beforeAll(() => {
    const db = getDb()
    writeTranscript(S1, 'one')
    writeTranscript(S2, 'two')
    writeTranscript(S3, 'three')
    writeTranscript(REVIEW, 'review')
    const r = db.prepare(
      `INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id)
       VALUES ('multi', 'cto', 'ws', 1, 'working', ?)`
    ).run(S3)
    multiId = Number(r.lastInsertRowid)
    const intel = db.prepare(
      `INSERT INTO session_intel (objective_id, session_id, started_at, ended_at) VALUES (?, ?, ?, ?)`
    )
    intel.run(multiId, S1, '2026-07-18T10:00:00Z', '2026-07-18T10:05:00Z')
    intel.run(multiId, S2, '2026-07-18T11:00:00Z', '2026-07-18T11:05:00Z')
    intel.run(multiId, REVIEW, '2026-07-18T11:10:00Z', '2026-07-18T11:12:00Z')
  })

  async function getMulti(query: string): Promise<any> {
    const res = await fetch(`${baseUrl}/api/objectives/${multiId}/output${query}`, {
      headers: { Cookie: cookie },
    })
    return res.json()
  }

  it('timeline covers every session chronologically and excludes the reviewer transcript', async () => {
    const json = await getMulti('?view=timeline')
    const summaries = json.segments.filter((s: any) => s.type === 'summary').map((s: any) => s.text)
    const dividers = json.segments.filter((s: any) => s.type === 'divider').map((s: any) => s.text)
    expect(summaries).toEqual(['summary one', 'summary two', 'summary three'])
    expect(dividers).toEqual(
      expect.arrayContaining(['user says one', 'user says two', 'user says three'])
    )
    expect(JSON.stringify(json.segments)).not.toContain('review')
    // 4 parsed messages per session × 3 sessions (prompt→followup, tool, followup, result)
    expect(json.total).toBe(12)
    // Reported session id stays the newest (live) session.
    expect(json.session_id).toBe(S3)
  })

  it('?from&to slices index into the concatenated array', async () => {
    // Messages 4..8 are session two's slice.
    const json = await getMulti('?from=4&to=8')
    const texts = JSON.stringify(json.messages)
    expect(texts).toContain('two')
    expect(texts).not.toContain('one"')
    expect(json.total).toBe(12)
  })

  it('?known short-circuits on the combined total', async () => {
    const json = await getMulti('?view=timeline&known=12')
    expect(json.unchanged).toBe(true)
    expect(json.total).toBe(12)
  })

  it('falls back to the newest transcript set when only aux sessions exist', async () => {
    const db = getDb()
    const r = db.prepare(
      `INSERT INTO objectives (title, agent_context, workspace, created_by, status, session_id)
       VALUES ('aux-only', 'cto', 'ws', 1, 'done', NULL)`
    ).run()
    const auxId = Number(r.lastInsertRowid)
    db.prepare(
      `INSERT INTO session_intel (objective_id, session_id, started_at, ended_at) VALUES (?, ?, ?, ?)`
    ).run(auxId, REVIEW + '-aux', '2026-07-18T12:00:00Z', '2026-07-18T12:02:00Z')
    writeTranscript(REVIEW + '-aux', 'auxreview')
    const res = await fetch(`${baseUrl}/api/objectives/${auxId}/output?view=timeline`, {
      headers: { Cookie: cookie },
    })
    const json: any = await res.json()
    const summaries = json.segments.filter((s: any) => s.type === 'summary').map((s: any) => s.text)
    expect(summaries).toEqual(['summary auxreview'])
  })
})
