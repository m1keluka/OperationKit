import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 900652 — regression: the FIRST start of a planning-column project card must
// launch a real worker session. #900639 / #900640 (2026-11-12) were type=project
// cards in `planning`; start_objective (PATCH status=working) answered `working`,
// but the route only flipped the status — `planning` was missing from its start
// list, so startSession never ran and session_id stayed NULL. Five minutes later the
// orphan sweep parked the card in review and the zero-token sweep marked it blocked
// (session_count 0, 0 tokens, $0). Driven end to end over the real routers and DB;
// only the tmux spawn layer is mocked.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-planning-start-')))
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'test-secret-planning-start-900652'
delete process.env.CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL
delete process.env.INTERNAL_TRUSTED_PEER_CIDRS

const startSessionMock = vi.fn(async (o: { id: number }) => `cc-${o.id}-worker`)
const reopenObjectiveMock = vi.fn(async (o: { id: number }) => `cc-${o.id}-reopened`)
const stopPlannerSessionMock = vi.fn(async (_sid: string) => {})
vi.mock('../services/session-manager.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    startSession: (o: { id: number }) => startSessionMock(o),
    reopenObjective: (o: { id: number }) => reopenObjectiveMock(o),
    stopPlannerSession: (sid: string) => stopPlannerSessionMock(sid),
  }
})

const { initDb, getDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { registerInternalHermesRoutes } = await import('./internal-hermes.js')
const { internalApiGate } = await import('../middleware/internal-api-gate.js')
const { sweepOrphanedWorkingSessions, __resetOrphanSweepThrottle } = await import('../services/poller-delegator.js')

const ADMIN_ID = 1
const WS = 'planning-start-ws'

let server: http.Server
let baseUrl: string

function cookie(): string {
  return `token=${jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
}

async function call(method: string, url: string, body?: unknown, internal = false) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(internal ? {} : { Cookie: cookie() }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) as Record<string, any> }
}

function row(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Record<string, any>
}

/** A type=project card created through the real create route — it lands in `planning`. */
async function createPlanningProjectCard(title: string): Promise<number> {
  const created = await call('POST', '/api/objectives', { title, workspace: WS, type: 'project', agent_context: 'general' })
  expect(created.status).toBe(201)
  const id = Number(created.json.id)
  expect(row(id).status).toBe('planning')
  expect(row(id).type).toBe('project')
  expect(row(id).session_id).toBeNull()
  return id
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(WS, WS)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/internal', internalApiGate)
  const internal = express.Router()
  registerInternalHermesRoutes(internal)
  app.use('/api/internal', internal)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  startSessionMock.mockClear()
  reopenObjectiveMock.mockClear()
  stopPlannerSessionMock.mockClear()
})

describe('starting a planning-column project card (obj 900652)', () => {
  it('ONE start (PATCH status=working, what start_objective sends) launches a real worker session', async () => {
    const id = await createPlanningProjectCard('B4 — planning-column project card')

    const started = await call('PATCH', `/api/objectives/${id}/status`, { status: 'working' })
    expect(started.status).toBe(200)
    expect(started.json.status).toBe('working')

    // The bug: startSession was never called and session_id stayed NULL.
    expect(startSessionMock).toHaveBeenCalledTimes(1)
    expect(startSessionMock.mock.calls[0][0].id).toBe(id)
    const after = row(id)
    expect(after.status).toBe('working')
    expect(after.session_id).toBe(`cc-${id}-worker`)
    expect(started.json.session_id).toBe(`cc-${id}-worker`)
  })

  it('a started card is NOT orphaned to review five minutes later (the 0-token death)', async () => {
    const id = await createPlanningProjectCard('B3 — planning-column project card')
    expect((await call('PATCH', `/api/objectives/${id}/status`, { status: 'working' })).status).toBe(200)

    // Age the card past the orphan sweep's 5-minute guard and run the sweep.
    getDb().prepare("UPDATE objectives SET updated_at = datetime('now', '-10 minutes') WHERE id = ?").run(id)
    __resetOrphanSweepThrottle()
    const runnerFailure = vi.fn(async () => 'not_runner_failure' as const)
    await sweepOrphanedWorkingSessions({ handleRunnerFailure: runnerFailure })

    expect(runnerFailure).not.toHaveBeenCalled() // it has a session — not an orphan at all
    const after = row(id)
    expect(after.status).toBe('working')
    expect(after.ai_review_verdict).toBeNull()
  })

  it('tears down a live planner sub-session and clears planning_session_id', async () => {
    const id = await createPlanningProjectCard('project card with a planner running')
    getDb().prepare("UPDATE objectives SET planning_session_id = 'cc-plan-live' WHERE id = ?").run(id)

    const started = await call('PATCH', `/api/objectives/${id}/status`, { status: 'working' })
    expect(started.status).toBe(200)
    expect(startSessionMock).toHaveBeenCalledTimes(1)
    expect(stopPlannerSessionMock).toHaveBeenCalledWith('cc-plan-live')
    expect(row(id).planning_session_id).toBeNull()
    expect(row(id).session_id).toBe(`cc-${id}-worker`)
  })

  it('a failed spawn leaves the card in planning, not a session-less working card', async () => {
    const id = await createPlanningProjectCard('project card whose spawn fails')
    startSessionMock.mockRejectedValueOnce(new Error('tmux spawn failed'))

    const res = await call('PATCH', `/api/objectives/${id}/status`, { status: 'working' })
    expect(res.status).toBe(500)
    expect(row(id).status).toBe('planning')
    expect(row(id).session_id).toBeNull()
  })

  it('the localhost internal PATCH route starts it too', async () => {
    const id = await createPlanningProjectCard('project card started via the internal API')

    const res = await call('PATCH', `/api/internal/objectives/${id}/status`, { status: 'working' }, true)
    expect(res.status).toBe(200)
    expect(startSessionMock).toHaveBeenCalledTimes(1)
    expect(row(id).status).toBe('working')
    expect(row(id).session_id).toBe(`cc-${id}-worker`)
  })
})

describe('cancelled → working (same bare-else hole, every type)', () => {
  it('reopens the card with a session instead of only flipping its status', async () => {
    const created = await call('POST', '/api/objectives', { title: 'cancelled task', workspace: WS, type: 'task', agent_context: 'general' })
    const id = Number(created.json.id)
    getDb().prepare("UPDATE objectives SET status = 'cancelled' WHERE id = ?").run(id)

    const res = await call('PATCH', `/api/objectives/${id}/status`, { status: 'working' })
    expect(res.status).toBe(200)
    expect(reopenObjectiveMock).toHaveBeenCalledTimes(1)
    expect(row(id).status).toBe('working')
    expect(row(id).session_id).toBe(`cc-${id}-reopened`)
  })
})
