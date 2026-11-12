// Workflows card B7 (obj 900643, docs/design/WORKFLOWS.md §6.2 / §8) — the
// server half of the React Flow viewer v2:
//   - click-to-inspect never returns a value live-redaction would redact, even
//     for a step row written BEFORE the secret was known (seeded raw token), and
//     even when the token straddles the preview cap
//   - changed-node tags: GET /api/flows/:id carries the diff vs the parent version
//   - live overlay: every engine step event maps to a workspace-scoped
//     `flow_step` WebSocket message, carrying ids + status only (no step I/O)
//   - the new routes keep the hard workspace filter (403 cross-workspace)
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { FlowDefinition } from '../../../shared/flow/types.js'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in flows tests') } }))

const TMP_DB = path.join(os.tmpdir(), `cc-flows-b7-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-flows-b7'
process.env.PORT = '59953'
process.env.ALERTS_ENABLED = 'false'

const { initDb, getDb } = await import('../db/index.js')
const { default: flowsRouter } = await import('./flows.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { FlowEngine, flowEventToLiveMessage } = await import('../services/flow-engine.js')
const { redactLive } = await import('../services/live-redaction.js')

const ADMIN = { id: 701, username: 'owner-b7', role: 'admin' as const }
const MEMBER_B = { id: 703, username: 'member-b7', role: 'member' as const }
type Who = typeof ADMIN | typeof MEMBER_B
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl = ''
const cookieFor = (u: Who) => `token=${jwt.sign(u, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function call(method: string, p: string, opts: { as?: Who; body?: unknown } = {}): Promise<{ status: number; json: Loose; text: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.as) headers.Cookie = cookieFor(opts.as)
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: unknown = text
  try { json = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, json, text }
}

function def(version: number, extra: { label?: string; addNode?: boolean } = {}): FlowDefinition {
  const nodes: Loose[] = [
    { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
    {
      id: 'fetch', kind: 'tool', tool: 'rows-list', effect: 'read', retry: { max: 1, backoff: 'fixed', delay_ms: 1 },
      mock: { output: { rows: [{ id: 'fixture' }] } }, next: extra.addNode ? 'shape' : 'verify',
      ...(extra.label ? { label: extra.label } : {}),
    },
    ...(extra.addNode ? [{ id: 'shape', kind: 'check', assert: [{ expr: 'len(steps.fetch.output.rows) >= 0' }], next: 'verify' }] : []),
    { id: 'verify', kind: 'check', assert: [{ expr: 'len(steps.fetch.output.rows) > 0', why: 'rows fetched' }], next: 'done' },
    { id: 'done', kind: 'end', output: '{{ steps.fetch.output.rows }}' },
  ]
  return {
    apiVersion: 'okflow/1', id: 'viewer-b7', name: 'Viewer B7', workspace: 'ws-a', version,
    goal: { statement: 'rows are fetched', end_condition: { assert: [{ expr: 'len(steps.fetch.output.rows) > 0' }] } },
    nodes,
  } as FlowDefinition
}

// Seeded secrets. The env-backed one is unknown when the row is "written" and
// only becomes a known secret afterwards — exactly the case read-time redaction
// exists for. The GitHub-shaped one is caught by pattern.
const ENV_SECRET_NAME = 'B7_SEEDED_API_KEY'
const ENV_SECRET = 'b7-seeded-secret-value-7f3a9c2e5d'
const GH_TOKEN_SEEDED = `ghp_${'A1b2C3d4E5'.repeat(4)}`

let flowId = 0
let runId = 0

/** Every string anywhere in a JSON body. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out))
  return out
}

function expectNothingRedactable(body: unknown, raw: string): void {
  expect(raw).not.toContain(ENV_SECRET)
  expect(raw).not.toContain(GH_TOKEN_SEEDED)
  // No prefix long enough to be useful survives either (the cap is applied after redaction).
  expect(raw).not.toContain(GH_TOKEN_SEEDED.slice(0, 12))
  expect(raw).not.toContain(ENV_SECRET.slice(0, 12))
  for (const s of strings(body)) expect(redactLive(s).count, s.slice(0, 120)).toBe(0)
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  for (const u of [ADMIN, MEMBER_B]) db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)").run(u.id, u.username, u.role)
  db.prepare("INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, 'ws-b')").run(MEMBER_B.id)

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/flows', flowsRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const c1 = await call('POST', '/api/flows', { as: ADMIN, body: { definition: def(1) } })
  expect(c1.status, JSON.stringify(c1.json)).toBe(201)
  flowId = c1.json.flow_id
  const c2 = await call('POST', '/api/flows', { as: ADMIN, body: { definition: def(2, { label: 'Fetch rows (v2)', addNode: true }) } })
  expect(c2.status, JSON.stringify(c2.json)).toBe(201)

  // A finished live run whose step rows hold RAW secrets — as if written before
  // the secret was in the store (write-time redaction could not have known it).
  const now = new Date().toISOString()
  runId = Number(db.prepare(
    "INSERT INTO flow_runs (flow_id, version, workspace, mode, status, created_at, updated_at, started_at, ended_at) VALUES (?, 1, 'ws-a', 'live', 'failed', ?, ?, ?, ?)",
  ).run(flowId, now, now, now, now).lastInsertRowid)
  const step = db.prepare(
    `INSERT INTO flow_step_runs (run_id, node_id, iteration, attempt, status, effect, input_json, output_json, error_json, started_at, ended_at)
     VALUES (?, ?, 0, ?, ?, 'read', ?, ?, ?, ?, ?)`,
  )
  step.run(runId, 'start', 1, 'succeeded', null, JSON.stringify({ payload: {} }), null, now, now)
  step.run(runId, 'fetch', 1, 'failed',
    JSON.stringify({ auth: `Bearer ${ENV_SECRET}`, token: GH_TOKEN_SEEDED }),
    // token placed so a naive "truncate then redact" at the 2000-char run preview would leak its prefix
    JSON.stringify({ pad: 'x'.repeat(1985), token: GH_TOKEN_SEEDED, key: ENV_SECRET }),
    JSON.stringify({ type: 'http_401', title: 'unauthorized', detail: `server echoed ${GH_TOKEN_SEEDED} and ${ENV_SECRET}` }),
    now, now)
  step.run(runId, 'fetch', 2, 'failed', null,
    // and the same at the 8000-char inspect cap (pretty JSON adds the key + quotes)
    JSON.stringify({ pad: 'y'.repeat(7980), token: GH_TOKEN_SEEDED }), null, now, now)
  // An earlier good run of the same node, also holding a raw secret.
  const goodRun = Number(db.prepare(
    "INSERT INTO flow_runs (flow_id, version, workspace, mode, status, created_at, updated_at, started_at, ended_at) VALUES (?, 1, 'ws-a', 'live', 'succeeded', ?, ?, ?, ?)",
  ).run(flowId, now, now, now, now).lastInsertRowid)
  step.run(goodRun, 'fetch', 1, 'succeeded', null, JSON.stringify({ rows: [{ id: 'a', api_key: ENV_SECRET }] }), null, now, now)

  // The secret becomes known only now (e.g. added to Settings → Secrets later).
  process.env[ENV_SECRET_NAME] = ENV_SECRET
})

afterAll(async () => {
  delete process.env[ENV_SECRET_NAME]
  await new Promise<void>((r) => server.close(() => r()))
  try { fs.unlinkSync(TMP_DB) } catch { /* gone */ }
})

describe('click-to-inspect side panel never shows a value live-redaction would redact', () => {
  it('GET /:id/runs/:runId/nodes/:nodeId redacts seeded tokens in input, output, error and the last good run', async () => {
    const r = await call('GET', `/api/flows/${flowId}/runs/${runId}/nodes/fetch`, { as: ADMIN })
    expect(r.status, r.text).toBe(200)
    expect(r.json.node_id).toBe('fetch')
    expect(r.json.kind).toBe('tool')
    expect(r.json.status).toBe('failed')
    expect(r.json.attempt_count).toBe(2)
    expect(r.json.attempts.map((a: Loose) => a.attempt)).toEqual([1, 2])
    expect(r.json.config).toContain('"tool": "rows-list"')
    // the redaction happened (markers present), and nothing redactable is left anywhere
    expect(r.text).toContain(`[REDACTED:${ENV_SECRET_NAME}]`)
    expect(r.text).toContain('[REDACTED:GITHUB_TOKEN]')
    expect(r.json.attempts[1].truncated).toBe(true)
    expect(r.json.last_good?.attempt.output).toContain(`[REDACTED:${ENV_SECRET_NAME}]`)
    expectNothingRedactable(r.json, r.text)
  })

  it('the version-scoped panel (no run selected) is redacted too', async () => {
    const r = await call('GET', `/api/flows/${flowId}/nodes/fetch?version=1`, { as: ADMIN })
    expect(r.status, r.text).toBe(200)
    expect(r.json.run_id).toBeNull()
    expect(r.json.attempts).toEqual([])
    expect(r.json.last_good?.run_id).toBeGreaterThan(0)
    expectNothingRedactable(r.json, r.text)
  })

  it('the run detail step previews are redacted BEFORE they are capped', async () => {
    const r = await call('GET', `/api/flows/${flowId}/runs/${runId}`, { as: ADMIN })
    expect(r.status, r.text).toBe(200)
    const fetchStep = r.json.steps.find((s: Loose) => s.node_id === 'fetch' && s.attempt === 1)
    expect(fetchStep.output_preview.length).toBeLessThanOrEqual(2000)
    expectNothingRedactable(r.json, r.text)
  })

  it('rejects a malformed node id and 404s an unknown node', async () => {
    expect((await call('GET', `/api/flows/${flowId}/runs/${runId}/nodes/..%2Fx`, { as: ADMIN })).status).toBe(400)
    expect((await call('GET', `/api/flows/${flowId}/runs/${runId}/nodes/nope`, { as: ADMIN })).status).toBe(404)
  })

  it('keeps the workspace filter: a member of another workspace gets 403 on both inspect routes', async () => {
    expect((await call('GET', `/api/flows/${flowId}/runs/${runId}/nodes/fetch`, { as: MEMBER_B })).status).toBe(403)
    expect((await call('GET', `/api/flows/${flowId}/nodes/fetch`, { as: MEMBER_B })).status).toBe(403)
  })
})

describe('version picker: changed-node tags', () => {
  it('GET /:id?version=2 lists nodes added and changed vs v1, with the author', async () => {
    const r = await call('GET', `/api/flows/${flowId}?version=2`, { as: ADMIN })
    expect(r.status, r.text).toBe(200)
    expect(r.json.changes).toEqual({
      base_version: 1, author: `user:${ADMIN.id}`, added: ['shape'], changed: ['fetch'], removed: [],
    })
    const v1 = await call('GET', `/api/flows/${flowId}?version=1`, { as: ADMIN })
    expect(v1.json.changes).toBeNull()
  })
})

describe('live overlay: engine step events become workspace-scoped flow_step messages', () => {
  it('maps step / run_started / run_finished to ids + status only, emitted synchronously with the row write', async () => {
    const db = getDb()
    db.prepare("INSERT INTO settings (key, value) VALUES ('flows_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run()
    const events: { at: number; msg: Loose }[] = []
    const rowsWritten: { at: number; node: string; status: string }[] = []
    const engine = new FlowEngine({
      db,
      owner: 'b7-live-test',
      tools: { get: (slug) => (slug === 'rows-list' ? { run: async () => ({ rows: [{ id: 'a', secret: GH_TOKEN_SEEDED }] }) } : null) },
      onEvent: (e) => {
        const msg = flowEventToLiveMessage(e)
        if (msg) events.push({ at: Date.now(), msg })
        if (e.type === 'step') {
          const row = db.prepare('SELECT status FROM flow_step_runs WHERE run_id = ? AND node_id = ? AND attempt = ? ORDER BY id DESC LIMIT 1')
            .get(e.runId, e.nodeId, e.attempt) as { status: string } | undefined
          rowsWritten.push({ at: Date.now(), node: e.nodeId, status: row?.status ?? 'missing' })
        }
      },
    })
    const started = engine.startRun({ flowId, version: 1, trigger: { source: 'manual', payload: {} } }) as Loose
    expect(started.ok, JSON.stringify(started)).toBe(true)
    for (let i = 0; i < 10; i++) if ((await engine.tick()).claimed.length === 0) break

    const kinds = events.map((e) => `${e.msg.payload.event}:${e.msg.payload.node_id ?? ''}:${e.msg.payload.status ?? ''}`)
    expect(kinds[0]).toBe('run_started::')
    expect(kinds).toContain('step:fetch:running')
    expect(kinds).toContain('step:fetch:succeeded')
    expect(kinds[kinds.length - 1]).toBe('run_finished::succeeded')
    for (const { msg } of events) {
      expect(msg.type).toBe('flow_step')
      expect(msg.payload).toMatchObject({ workspace: 'ws-a', flow_id: flowId, run_id: started.runId })
      // ids + status only: the tool's output (with its token) never rides the socket
      expect(JSON.stringify(msg)).not.toContain(GH_TOKEN_SEEDED)
      expect(Object.keys(msg.payload).sort()).toEqual(
        expect.arrayContaining(['workspace', 'flow_id', 'run_id', 'event', 'at']),
      )
      expect(msg.payload).not.toHaveProperty('output')
      expect(msg.payload).not.toHaveProperty('input')
    }
    // The event fires when the row is already committed (the client's refetch sees it).
    for (const r of rowsWritten) expect(r.status).not.toBe('missing')
  })

  it('budget events are not pushed to the viewer', () => {
    expect(flowEventToLiveMessage({ type: 'budget_observed', runId: 1, flowId: 1, workspace: 'w', nodeId: 'n', detail: 'x' })).toBeNull()
  })

  it('B9 wait events reach the viewer as ids + status only (parked, then released)', () => {
    const parked = flowEventToLiveMessage({ type: 'wait', runId: 3, flowId: 2, workspace: 'acme', nodeId: 'owner_ok', reason: 'approval' }, 'T')
    expect(parked).toEqual({ type: 'flow_step', payload: { workspace: 'acme', flow_id: 2, run_id: 3, event: 'wait', node_id: 'owner_ok', status: 'waiting', at: 'T' } })
    const released = flowEventToLiveMessage({ type: 'wait', runId: 3, flowId: 2, workspace: 'acme', nodeId: 'owner_ok', reason: 'approval', resolution: 'approved', by: 'user:1' }, 'T')
    expect(released?.type === 'flow_step' && released.payload.status).toBe('approved')
    // who answered is not pushed to every workspace member's socket
    expect(JSON.stringify(released)).not.toContain('user:1')
  })
})
