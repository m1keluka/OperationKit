// Workflows card B8 (obj 900644, docs/design/WORKFLOWS.md §5.3 + §8) — auto-debug watcher.
//
// Card acceptance, each asserted below:
//   A1. A seeded failure (a Tool's response field renamed) is repaired by a mapping
//       patch, replayed green and auto-applied with author = repair:<run>.
//   A2. A patch that edits `goal` or a send node is never auto-applied (the pure
//       classifier cases live in shared/flow/__tests__/repair.test.ts; here the
//       same rule is exercised end to end through the watcher).
//   A3. Repair spend over `repair_usd` stops and routes to Needs Review.
//   A4. The third same-signature failure in 7 days goes to Needs Review.
// plus: 127/ENOENT = definition rot (repair opened, neutral for the K auto-pause),
// repairs_per_day pauses the workflow, what is never triaged, who may draft /
// approve / reject, the drafts cap, and the replay seeding itself.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { FlowDefinition, FlowNode } from '../../../shared/flow/types.js'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in flows tests') } }))

const TMP_DB = path.join(os.tmpdir(), `cc-flows-b8-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-flows-b8'
process.env.PORT = '59954'
process.env.ALERTS_ENABLED = 'false'
process.env.CC_SESSION_KB_ACCESS = '1'

const { initDb, getDb } = await import('../db/index.js')
const { default: flowsRouter } = await import('./flows.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { FlowEngine, saveFlowVersion, recordedFlowApprovals } = await import('../services/flow-engine.js')
const { recordFlowApprovals } = await import('../services/flow-self-test.js')
const { ensureFlowHomeCard, publishFlowVersion, classifyFlowRun } = await import('../services/flow-routines.js')
const { FlowRepairWatcher, setHostRepairWatcher, createRepairCard } = await import('../services/flow-repair.js')
const { recordSpend } = await import('../services/job-accounting.js')

const ADMIN = { id: 701, username: 'owner', role: 'admin' as const }
const MEMBER = { id: 702, username: 'member', role: 'member' as const }
type Who = typeof ADMIN | typeof MEMBER
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl = ''
const cookieFor = (u: Who) => `token=${jwt.sign(u, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
const bearerFor = (u: Who) => jwt.sign(u, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(method: string, p: string, opts: { as?: Who; bearer?: string; session?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.session) headers['X-CC-Session-Token'] = opts.session
  else if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else if (opts.as) headers.Cookie = cookieFor(opts.as)
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = text
  try { json = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, json }
}

// ── The workflow under test ─────────────────────────────────────────────────
//
//   start → fetch (read Tool `bookings-list`) → tally (read Tool `tally`, input
//   {list: steps.fetch.output.bookings}) → notify (SEND Tool `mailer`) → done
//
// Seeded failure: the bookings API renamed its response field `bookings` → `records`.

const T0 = Date.parse('2026-11-12T08:00:00.000Z')
let now = T0
const tools = {
  shape: 'bookings' as 'bookings' | 'records',
  fetchCalls: 0,
  tallyCalls: 0,
  mailerCalls: [] as unknown[],
  failWith: null as Error | null,
}
let eng: InstanceType<typeof FlowEngine>
let watcher: InstanceType<typeof FlowRepairWatcher>
const started: number[] = []

function buildEngine() {
  return new FlowEngine({
    db: getDb(),
    owner: 'b8-test',
    clock: () => now,
    tools: {
      get: (slug) => {
        if (slug === 'bookings-list') {
          return {
            effect: 'read',
            run: async () => {
              tools.fetchCalls++
              if (tools.failWith) throw tools.failWith
              const rows = [{ id: 'b1' }, { id: 'b2' }]
              return tools.shape === 'bookings' ? { bookings: rows } : { records: rows }
            },
          }
        }
        if (slug === 'tally') {
          return {
            effect: 'read',
            run: async (input) => {
              tools.tallyCalls++
              const list = (input as { list?: unknown }).list
              if (!Array.isArray(list)) throw new Error(`tally: "list" must be an array, got ${JSON.stringify(list)}`)
              return { count: list.length }
            },
          }
        }
        if (slug === 'mailer') return { effect: 'send', run: async (input) => { tools.mailerCalls.push(input); return { ok: true } } }
        return null
      },
    },
  })
}

function definition(slug: string, extra: Partial<FlowDefinition> = {}, nodes?: FlowNode[]): FlowDefinition {
  return {
    apiVersion: 'okflow/1',
    id: slug,
    name: `Booking tally ${slug}`,
    workspace: 'ws-a',
    version: 1,
    goal: {
      statement: 'Both bookings are counted and the summary goes out.',
      end_condition: { assert: [{ expr: 'steps.tally.output.count == 2', why: 'nothing dropped' }, { expr: 'steps.notify.output.ok == true', why: 'summary sent' }] },
    },
    budget: { run_usd: 1, repair_usd: 2, repairs_per_day: 3 },
    nodes: nodes ?? [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 'bookings-list', effect: 'read', input: {}, mock: { output: { bookings: [] } }, retry: { max: 1, backoff: 'fixed', delay_ms: 1000 }, next: 'tally' },
      { id: 'tally', kind: 'tool', tool: 'tally', effect: 'read', input: { list: '{{ steps.fetch.output.bookings }}' }, retry: { max: 1, backoff: 'fixed', delay_ms: 1000 }, next: 'notify' },
      { id: 'notify', kind: 'tool', tool: 'mailer', effect: 'send', input: { text: 'Counted {{ steps.tally.output.count }} bookings' }, mock: { output: { ok: true } }, next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.tally.output }}' },
    ],
    ...extra,
  }
}

/** Save v1, record the owner's approval of `notify`, publish. Returns flow id + home card. */
function publishV1(slug: string, extra: Partial<FlowDefinition> = {}, nodes?: FlowNode[]): { flowId: number; home: number } {
  const db = getDb()
  const def = definition(slug, extra, nodes)
  const saved = saveFlowVersion(db, { workspace: 'ws-a', definition: def, author: `user:${ADMIN.id}` })
  if (!saved.ok) throw new Error(`save failed: ${saved.reason} ${JSON.stringify(saved.errors)}`)
  const home = ensureFlowHomeCard(db, saved.flowId, ADMIN.id)!
  const need = def.nodes.some((n) => n.id === 'notify') ? ['notify'] : []
  if (need.length) recordFlowApprovals(db, saved.flowId, { version: 1, nodes: need, by: `user:${ADMIN.id}`, at: new Date(now).toISOString() })
  const p = publishFlowVersion(db, { flowId: saved.flowId, version: 1 })
  if (!p.ok) throw new Error(`publish failed: ${p.reason} ${JSON.stringify(p.detail)}`)
  return { flowId: saved.flowId, home }
}

async function failedRun(flowId: number, home: number): Promise<number> {
  const r = eng.startRun({ flowId, trigger: { source: 'manual', payload: {} }, objectiveId: home })
  if (!r.ok) throw new Error(`start failed: ${r.reason}`)
  await eng.runNow(r.runId)
  return r.runId
}

const runRow = (id: number) => getDb().prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as Loose
const repairOf = (runId: number) => getDb().prepare('SELECT * FROM flow_repairs WHERE run_id = ?').get(runId) as Loose
const card = (id: number) => getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Loose
const flowRow = (id: number) => getDb().prepare('SELECT * FROM flow_definitions WHERE id = ?').get(id) as Loose
const sessionFor = (objectiveId: number) => mintSessionToken({ objectiveId, workspace: 'ws-a', actingUserId: ADMIN.id })
const MAPPING_FIX = [{ op: 'replace', path: '/nodes/2/input/list', value: '{{ steps.fetch.output.records }}' }]

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare("UPDATE settings SET value = '1' WHERE key = 'flows_enabled'").run()
  for (const u of [ADMIN, MEMBER]) {
    db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)").run(u.id, u.username, u.role)
  }
  db.prepare("INSERT OR IGNORE INTO user_workspaces (user_id, workspace) VALUES (?, 'ws-a')").run(MEMBER.id)
  eng = buildEngine()
  watcher = new FlowRepairWatcher({ engine: eng, host: { createCard: createRepairCard, startCard: (id) => { started.push(id) } } })
  setHostRepairWatcher(watcher) // the routes drive the same watcher (and so the same test engine)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/flows', flowsRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  setHostRepairWatcher(null)
  await new Promise<void>((r) => server.close(() => r()))
  try { fs.unlinkSync(TMP_DB) } catch { /* gone */ }
})

beforeEach(() => {
  now += 60_000
  tools.shape = 'records' // the field is renamed: every run of v1 fails at `tally`
  tools.fetchCalls = 0
  tools.tallyCalls = 0
  tools.mailerCalls = []
  tools.failWith = null
})

// ── A1 ──────────────────────────────────────────────────────────────────────

describe('A1: a renamed response field is repaired by a mapping patch, replayed green and auto-applied', () => {
  it('fails → repair card with the §5.3 brief → draft → replay → applied as v2 by repair:<run> → re-run green', async () => {
    const { flowId, home } = publishV1('a1-flow')
    const runId = await failedRun(flowId, home)
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(runRow(runId).error_json)).toMatchObject({ type: 'tool_error', node_id: 'tally' })
    expect(tools.mailerCalls).toHaveLength(0)

    // The watcher opens a repair: run → repairing, a repair card under the home card.
    const t = await watcher.tick()
    expect(t.opened).toBe(1)
    const rep = repairOf(runId)
    expect(rep).toMatchObject({ status: 'open', signature: 'tally:tool_error', failed_node_id: 'tally', base_version: 1, repair_usd: 2, definition_rot: 0 })
    expect(runRow(runId).status).toBe('repairing')
    const c = card(rep.objective_id)
    expect(c).toMatchObject({ origin: 'workflow', status: 'queue', parent_id: home, workspace: 'ws-a' })
    expect(started).toContain(rep.objective_id)
    // §5.3 brief: failing node input, error, attempt history, upstream outputs, last good run, the definition.
    expect(c.description).toContain('repair agent')
    expect(c.description).toContain('"list":null')
    expect(c.description).toContain('tally: "list" must be an array')
    expect(c.description).toContain('attempt 1')
    expect(c.description).toContain('`fetch`: `{"records"')
    expect(c.description).toContain('The same node in the last successful run')
    expect(c.description).toContain('"apiVersion": "okflow/1"')
    expect(c.description).toContain(`/api/flows/${flowId}/repairs/${rep.id}/draft`)
    // The card's cost ceiling is repair_usd.
    const ceiling = getDb().prepare('SELECT cost_ceiling_usd FROM objective_job_accounting WHERE objective_id = ?').get(rep.objective_id) as Loose
    expect(ceiling.cost_ceiling_usd).toBe(2)
    // A second tick never opens a second incident for the same run.
    expect((await watcher.tick()).opened).toBe(0)

    // The repair card submits the mapping patch through its own session.
    const fetchBefore = tools.fetchCalls
    const r = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/draft`, {
      session: sessionFor(rep.objective_id),
      body: { patch: MAPPING_FIX, explanation: 'The bookings API renamed `bookings` to `records`; tally now reads steps.fetch.output.records.' },
    })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json.result).toMatchObject({ status: 'applied', draft_version: 2, applied_version: 2, drafts_used: 1 })
    expect(r.json.result.classification).toMatchObject({ safe: true, blockers: [] })

    // Replay: the recorded fetch output was reused (no new fetch call), tally ran live,
    // the send node was STUBBED (no mail), and the engine judged the goal met.
    const replay = r.json.result.replay
    expect(replay).toMatchObject({ status: 'succeeded', goal_met: 1, green: true })
    expect(replay.seeded).toBeGreaterThanOrEqual(2)
    expect(replay.stubbed).toEqual([{ node_id: 'notify', effect: 'send', simulated: 'would_send' }])
    expect(tools.fetchCalls).toBe(fetchBefore)
    expect(tools.mailerCalls).toHaveLength(0)
    const replayRun = runRow(replay.run_id)
    expect(replayRun).toMatchObject({ mode: 'replay', parent_run_id: runId, version: 2, objective_id: rep.objective_id })

    // Published as v2, authored by repair:<run>, with the JSON Patch and its parent recorded.
    const v2 = getDb().prepare('SELECT author, parent_version, patch_json FROM flow_versions WHERE flow_id = ? AND version = 2').get(flowId) as Loose
    expect(v2).toEqual({ author: `repair:${runId}`, parent_version: 1, patch_json: JSON.stringify(MAPPING_FIX) })
    expect(flowRow(flowId)).toMatchObject({ published_version: 2, status: 'active' })
    // notify is byte-identical, so the owner's approval of it carried to v2 (still the owner's, never repair:*).
    const ap = recordedFlowApprovals(getDb(), flowId, 2)
    expect(ap).toMatchObject({ version: 2, nodes: ['notify'], by: `user:${ADMIN.id}` })
    expect(repairOf(runId)).toMatchObject({ status: 'applied', applied_version: 2, resolved_by: `repair:${runId}` })
    expect(runRow(runId).status).toBe('failed') // the failed run stays failed; the fix is a new version + a new run
    expect(card(rep.objective_id).job_disposition).toBe('complete')

    // The failed run never sent anything, so it is re-run from the trigger on v2 — for real this time.
    const rerunId = repairOf(runId).rerun_run_id
    expect(rerunId).toBeTypeOf('number')
    expect(runRow(rerunId)).toMatchObject({ mode: 'live', version: 2, parent_run_id: runId })
    await eng.runNow(rerunId)
    expect(runRow(rerunId)).toMatchObject({ status: 'succeeded', goal_met: 1 })
    expect(tools.mailerCalls).toEqual([{ text: 'Counted 2 bookings' }])

    // The incident is readable through the API with its diff.
    const g = await call('GET', `/api/flows/${flowId}/repairs/${rep.id}`, { as: MEMBER })
    expect(g.status).toBe(200)
    expect(g.json.repair).toMatchObject({ status: 'applied', diff: { changed: ['tally'], added: [], removed: [] } })
  })
})

// ── A2 ──────────────────────────────────────────────────────────────────────

describe('A2: a patch that edits goal or a send node is never auto-applied', () => {
  it('a green replay with a goal edit goes to Needs Review; only the cookie owner can approve it', async () => {
    const { flowId, home } = publishV1('a2-goal')
    const runId = await failedRun(flowId, home)
    await watcher.tick()
    const rep = repairOf(runId)
    const r = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/draft`, {
      session: sessionFor(rep.objective_id),
      body: {
        patch: [...MAPPING_FIX, { op: 'replace', path: '/goal/end_condition/assert/0/why', value: 'roughly nothing dropped' }],
        explanation: 'Fixes the mapping and rewords the goal.',
      },
    })
    expect(r.status, JSON.stringify(r.json)).toBe(200)
    expect(r.json.result.replay.green).toBe(true)
    expect(r.json.result).toMatchObject({ status: 'needs_review', reason: 'not_safe_class' })
    expect(r.json.result.classification.blockers.map((b: Loose) => b.code)).toEqual(['goal_changed'])
    expect(flowRow(flowId).published_version).toBe(1)
    const c = card(rep.objective_id)
    expect(c.job_disposition).toBe('needs_review')
    expect(c.description).toContain('Needs Review')
    expect(c.description).toContain('goal_changed')
    expect(runRow(runId).status).toBe('failed')

    // Not an approval: a member, the repair card's session, a bearer-token admin.
    for (const opts of [{ as: MEMBER }, { session: sessionFor(rep.objective_id) }, { bearer: bearerFor(ADMIN) }]) {
      const a = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/approve`, { ...opts, body: { approve: ['notify'] } })
      expect(a.status, JSON.stringify(opts)).toBe(403)
    }
    // The owner must name exactly the send/spend nodes.
    const bad = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/approve`, { as: ADMIN, body: {} })
    expect(bad.status).toBe(409)
    expect(bad.json.reason).toBe('approval_required')
    const ok = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/approve`, { as: ADMIN, body: { approve: ['notify'] } })
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json.repair).toMatchObject({ status: 'applied', applied_version: 2, resolved_by: `user:${ADMIN.id}` })
    expect(flowRow(flowId).published_version).toBe(2)
    expect(recordedFlowApprovals(getDb(), flowId, 2)).toMatchObject({ nodes: ['notify'], by: `user:${ADMIN.id}` })
  })

  it('a green replay that changes the send node goes to Needs Review and is never published', async () => {
    const { flowId, home } = publishV1('a2-send')
    const runId = await failedRun(flowId, home)
    await watcher.tick()
    const rep = repairOf(runId)
    const out = await watcher.submitDraft(rep.id, {
      patch: [...MAPPING_FIX, { op: 'replace', path: '/nodes/3/input/text', value: 'URGENT: {{ steps.tally.output.count }} bookings' }],
      explanation: 'Fixes the mapping and rewrites the message.',
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result).toMatchObject({ status: 'needs_review', reason: 'not_safe_class' })
    expect(out.result.classification!.blockers.map((b) => b.code)).toEqual(['send_spend_node_changed'])
    expect(flowRow(flowId).published_version).toBe(1)
    expect(recordedFlowApprovals(getDb(), flowId, 2)).toBeNull()
    expect(tools.mailerCalls).toHaveLength(0)
    // Rejected by the owner: closed for good.
    const rj = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/reject`, { as: ADMIN, body: { note: 'no' } })
    expect(rj.status).toBe(200)
    expect(repairOf(runId).status).toBe('rejected')
  })
})

// ── A3 ──────────────────────────────────────────────────────────────────────

describe('A3: repair spend over repair_usd stops and routes to Needs Review', () => {
  it('the watcher stops an open repair whose card spent repair_usd; the workflow is paused', async () => {
    const { flowId, home } = publishV1('a3-tick')
    const runId = await failedRun(flowId, home)
    await watcher.tick()
    const rep = repairOf(runId)
    recordSpend(getDb(), rep.objective_id, { usd: 2.4 })
    await watcher.tick()
    expect(repairOf(runId)).toMatchObject({ status: 'needs_review', reason: 'repair_usd', review_objective_id: rep.objective_id })
    expect(repairOf(runId).detail).toContain('$2.4000')
    expect(flowRow(flowId).status).toBe('paused')
    expect(runRow(runId).status).toBe('failed')
    expect(card(rep.objective_id)).toMatchObject({ job_disposition: 'needs_review' })
    // No more drafts once it is with the owner.
    const r = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/draft`, { session: sessionFor(rep.objective_id), body: { patch: MAPPING_FIX, explanation: 'x' } })
    expect(r.status).toBe(409)
    expect(r.json.reason).toBe('repair_needs_review')
  })

  it('a draft submitted at the cap is refused before any replay spend', async () => {
    const { flowId, home } = publishV1('a3-draft', { budget: { run_usd: 1, repair_usd: 0.5, repairs_per_day: 3 } })
    const runId = await failedRun(flowId, home)
    await watcher.tick()
    const rep = repairOf(runId)
    expect(rep.repair_usd).toBe(0.5)
    recordSpend(getDb(), rep.objective_id, { usd: 0.5 })
    const before = (getDb().prepare("SELECT COUNT(*) n FROM flow_runs WHERE mode = 'replay'").get() as Loose).n
    const out = await watcher.submitDraft(rep.id, { patch: MAPPING_FIX, explanation: 'fix' })
    expect(out).toMatchObject({ ok: false, status: 409, reason: 'repair_usd' })
    expect((getDb().prepare("SELECT COUNT(*) n FROM flow_runs WHERE mode = 'replay'").get() as Loose).n).toBe(before)
    expect(repairOf(runId)).toMatchObject({ status: 'needs_review', reason: 'repair_usd', draft_version: null })
    expect(flowRow(flowId).status).toBe('paused')
  })
})

// ── A4 ──────────────────────────────────────────────────────────────────────

describe('A4: the third same-signature failure in 7 days goes to Needs Review', () => {
  it('two repairs open; the third goes straight to a Needs Review card; one 8 days later opens again', async () => {
    const { flowId, home } = publishV1('a4-flow', { budget: { run_usd: 1, repair_usd: 2, repairs_per_day: 10 } })
    const runs: number[] = []
    for (let i = 0; i < 2; i++) {
      const id = await failedRun(flowId, home)
      runs.push(id)
      await watcher.tick()
      expect(repairOf(id)).toMatchObject({ status: 'open', signature: 'tally:tool_error' })
      watcher.reject(repairOf(id).id, { userId: ADMIN.id }) // the owner closes it (the fix did not stick)
      now += 3600_000
    }
    const third = await failedRun(flowId, home)
    const t = await watcher.tick()
    expect(t.opened).toBe(0)
    const rep = repairOf(third)
    expect(rep).toMatchObject({ status: 'needs_review', reason: 'same_signature', objective_id: null, signature: 'tally:tool_error' })
    const review = card(rep.review_objective_id)
    expect(review).toMatchObject({ status: 'review', job_disposition: 'needs_review', origin: 'workflow', parent_id: home })
    expect(review.description).toContain('same_signature')
    expect(runRow(third).status).toBe('failed')
    expect(flowRow(flowId).status).toBe('active') // same-signature does not pause; repairs_per_day / repair_usd do

    // Outside the 7-day window the signature count starts over.
    now += 8 * 86_400_000
    const later = await failedRun(flowId, home)
    await watcher.tick()
    expect(repairOf(later).status).toBe('open')
  })

  it('repairs_per_day: the next failure goes to Needs Review and the workflow is paused', async () => {
    const { flowId, home } = publishV1('a4-perday', { budget: { run_usd: 1, repair_usd: 2, repairs_per_day: 1 } })
    const first = await failedRun(flowId, home)
    await watcher.tick()
    expect(repairOf(first).status).toBe('open')
    tools.failWith = new Error('HTTP 503 from bookings API') // a different signature: fetch:tool_error
    const second = await failedRun(flowId, home)
    await watcher.tick()
    expect(repairOf(second)).toMatchObject({ status: 'needs_review', reason: 'repairs_per_day', signature: 'fetch:tool_error' })
    expect(flowRow(flowId).status).toBe('paused')
  })
})

// ── Definition rot ──────────────────────────────────────────────────────────

describe('127 / ENOENT = definition rot', () => {
  it('opens a repair flagged as definition rot and is neutral for the K auto-pause streak', async () => {
    const { flowId, home } = publishV1('rot-flow')
    tools.failWith = Object.assign(new Error('spawn /home/ops/scripts/bookings/run.sh ENOENT'), { code: 'ENOENT' })
    const runId = await failedRun(flowId, home)
    const err = JSON.parse(runRow(runId).error_json)
    expect(err).toMatchObject({ node_id: 'fetch', code: 'ENOENT' })
    expect(classifyFlowRun(runRow(runId))).toBe('neutral')
    await watcher.tick()
    const rep = repairOf(runId)
    expect(rep).toMatchObject({ status: 'open', definition_rot: 1 })
    expect(card(rep.objective_id).title).toContain('definition rot')
    expect(card(rep.objective_id).description).toContain('Definition rot')
    // An ordinary failure still counts.
    expect(classifyFlowRun({ status: 'failed', error_json: JSON.stringify({ type: 'tool_error', title: 'HTTP 503' }) })).toBe('failure')
  })
})

// ── Guards ──────────────────────────────────────────────────────────────────

describe('what is never triaged, who may draft, the drafts cap, replay seeding', () => {
  it('self-tests, dry runs, budget stops and a check with on_fail "fail" never open a repair', async () => {
    const { flowId, home } = publishV1('guard-flow')
    const dry = eng.startRun({ flowId, version: 1, mode: 'dry', trigger: { source: 'manual', payload: {} } })
    if (!dry.ok) throw new Error(dry.reason)
    getDb().prepare("UPDATE flow_runs SET status = 'failed', ended_at = ?, error_json = ? WHERE id = ?")
      .run(new Date(now).toISOString(), JSON.stringify({ type: 'tool_error', node_id: 'tally' }), dry.runId)
    const budgetRun = await failedRun(flowId, home)
    getDb().prepare('UPDATE flow_runs SET error_json = ? WHERE id = ?').run(JSON.stringify({ type: 'budget', node_id: 'tally', title: 'over' }), budgetRun)
    await watcher.tick()
    expect(repairOf(dry.runId)).toBeUndefined()
    expect(repairOf(budgetRun)).toBeUndefined()
    expect(runRow(budgetRun).repair_state).toBe('skipped')

    const chk = publishV1('guard-check', { goal: { statement: 'x', end_condition: { assert: [{ expr: 'true' }] } } }, [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 'bookings-list', effect: 'read', input: {}, next: 'enough' },
      { id: 'enough', kind: 'check', assert: [{ expr: 'len(steps.fetch.output.bookings) > 0' }], on_fail: 'fail', next: 'done' },
      { id: 'done', kind: 'end' },
    ])
    const chkRun = await failedRun(chk.flowId, chk.home)
    expect(JSON.parse(runRow(chkRun).error_json).type).toBe('check_failed')
    await watcher.tick()
    expect(repairOf(chkRun)).toBeUndefined()
    expect(runRow(chkRun).repair_state).toBe('skipped')
  })

  it('a check with on_fail "repair" opens a repair', async () => {
    const chk = publishV1('guard-repair-check', { goal: { statement: 'x', end_condition: { assert: [{ expr: 'true' }] } } }, [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      { id: 'fetch', kind: 'tool', tool: 'bookings-list', effect: 'read', input: {}, next: 'enough' },
      { id: 'enough', kind: 'check', assert: [{ expr: 'len(steps.fetch.output.bookings) > 0' }], on_fail: 'repair', next: 'done' },
      { id: 'done', kind: 'end' },
    ])
    const runId = await failedRun(chk.flowId, chk.home)
    await watcher.tick()
    expect(repairOf(runId)).toMatchObject({ status: 'open', signature: 'enough:check_failed' })
  })

  it('only the repair card\'s own session may draft; a failing replay iterates, then the drafts cap hands it over', async () => {
    const { flowId, home } = publishV1('guard-draft')
    const runId = await failedRun(flowId, home)
    await watcher.tick()
    const rep = repairOf(runId)
    const body = { patch: [{ op: 'replace', path: '/nodes/2/input/list', value: '{{ steps.fetch.output.nope }}' }], explanation: 'wrong guess' }
    for (const opts of [{ as: ADMIN }, { as: MEMBER }, { session: sessionFor(home) }, { bearer: bearerFor(ADMIN) }]) {
      const r = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/draft`, { ...opts, body })
      expect(r.status, JSON.stringify(opts)).toBe(403)
    }
    const session = sessionFor(rep.objective_id)
    const invalid = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/draft`, { session, body: { patch: [{ op: 'replace', path: '/nodes/2/tool', value: 42 }], explanation: 'bad' } })
    expect(invalid.status).toBe(400)
    const r1 = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/draft`, { session, body })
    expect(r1.status).toBe(200)
    expect(r1.json.result).toMatchObject({ status: 'open', drafts_used: 2 })
    expect(r1.json.result.replay.green).toBe(false)
    expect(r1.json.result.message).toContain('draft(s) left')
    const r2 = await call('POST', `/api/flows/${flowId}/repairs/${rep.id}/draft`, { session, body })
    expect(r2.json.result).toMatchObject({ status: 'needs_review', reason: 'replay_failed', drafts_used: 3 })
    expect(flowRow(flowId).published_version).toBe(1)
  })

  it('replay reuses recorded rows only up to the first failed / changed node', async () => {
    const { flowId, home } = publishV1('seed-flow')
    const runId = await failedRun(flowId, home)
    // A v2 that changes `fetch` (upstream of the failure): nothing after the trigger may be reused.
    const v2 = definition('seed-flow', { version: 2 })
    ;(v2.nodes[1] as Loose).timeout_ms = 5000
    ;(v2.nodes[2] as Loose).input = { list: '{{ steps.fetch.output.records }}' }
    const saved = saveFlowVersion(getDb(), { workspace: 'ws-a', definition: v2, author: 'test' })
    expect(saved.ok).toBe(true)
    const before = tools.fetchCalls
    const r = eng.startRun({ flowId, version: 2, mode: 'replay', parentRunId: runId })
    expect(r).toMatchObject({ ok: true, seeded: 1 }) // the trigger only
    if (!r.ok) return
    await eng.runNow(r.runId)
    expect(tools.fetchCalls).toBe(before + 1) // fetch re-ran live (it is a read)
    expect(runRow(r.runId)).toMatchObject({ status: 'succeeded', goal_met: 1 })
    expect(tools.mailerCalls).toHaveLength(0) // the send node is stubbed in a replay
    expect(eng.startRun({ flowId, version: 2, mode: 'replay' })).toEqual({ ok: false, reason: 'replay_parent_required' })
  })

  it('a run that succeeded with its goal NOT met opens a repair but keeps status succeeded', async () => {
    tools.shape = 'bookings'
    const { flowId, home } = publishV1('goal-flow', {
      goal: { statement: 'three bookings', end_condition: { assert: [{ expr: 'steps.tally.output.count == 3', why: 'three expected' }] } },
    })
    const runId = await failedRun(flowId, home)
    expect(runRow(runId)).toMatchObject({ status: 'succeeded', goal_met: 0 })
    await watcher.tick()
    expect(repairOf(runId)).toMatchObject({ status: 'open', signature: '-:goal_not_met', failed_node_id: null })
    expect(runRow(runId).status).toBe('succeeded')
  })

  it('an open repair with no green draft after 24 h goes to Needs Review', async () => {
    const { flowId, home } = publishV1('stale-flow')
    const runId = await failedRun(flowId, home)
    await watcher.tick()
    expect(repairOf(runId).status).toBe('open')
    getDb().prepare("UPDATE objectives SET status = 'working', session_id = 'live-session' WHERE id = ?").run(repairOf(runId).objective_id)
    now += 25 * 3_600_000
    await watcher.tick()
    expect(repairOf(runId)).toMatchObject({ status: 'needs_review', reason: 'card_closed' })
    expect(runRow(runId).status).toBe('failed')
  })

  it('review fixes: a disguised send never runs live in a replay; identity patches write nothing; failed sends block the re-run', async () => {
    const { flowId, home } = publishV1('fix-flow')
    const runId = await failedRun(flowId, home)
    await watcher.tick()
    const rep = repairOf(runId)
    // (a) adds a "read" step on the mailer Tool (only the send node uses it) before notify.
    const sneaky = await watcher.submitDraft(rep.id, {
      patch: [
        ...MAPPING_FIX,
        { op: 'add', path: '/nodes/-', value: { id: 'ping', kind: 'tool', tool: 'mailer', effect: 'read', input: { text: 'extra' }, next: 'notify' } },
        { op: 'replace', path: '/nodes/2/next', value: 'ping' },
      ],
      explanation: 'sneaky',
    })
    expect(tools.mailerCalls).toHaveLength(0) // stubbed in the replay, never sent
    expect(sneaky.ok).toBe(true)
    if (sneaky.ok) {
      expect(sneaky.result.replay!.stubbed.map((s) => s.node_id)).toContain('ping')
      expect(sneaky.result.status).toBe('needs_review')
      expect(sneaky.result.classification!.blockers.map((b) => b.code)).toContain('node_added_not_safe')
    }
    expect(flowRow(flowId).published_version).toBe(1)

    // (b) a patch that renames the workflow id is refused before any version is written.
    const run2 = await failedRun(flowId, home)
    now += 3_600_000
    await watcher.tick()
    const rep2 = repairOf(run2)
    const versions = () => (getDb().prepare('SELECT COUNT(*) n FROM flow_versions').get() as Loose).n
    const before = versions()
    const flowsBefore = (getDb().prepare('SELECT COUNT(*) n FROM flow_definitions').get() as Loose).n
    const idPatch = await watcher.submitDraft(rep2.id, { patch: [{ op: 'replace', path: '/id', value: 'a1-flow' }, ...MAPPING_FIX], explanation: 'x' })
    expect(idPatch).toMatchObject({ ok: false, status: 400, reason: 'patch_changes_identity' })
    expect(versions()).toBe(before)
    expect((getDb().prepare('SELECT COUNT(*) n FROM flow_definitions').get() as Loose).n).toBe(flowsBefore)

    // (c) the failed run had a FAILED send attempt (may have been delivered): applied, but not re-run.
    getDb().prepare(
      "INSERT INTO flow_step_runs (run_id, node_id, iteration, attempt, status, effect, started_at) VALUES (?, 'notify', 0, 1, 'failed', 'send', ?)",
    ).run(run2, new Date(now).toISOString())
    const ok = await watcher.submitDraft(rep2.id, { patch: MAPPING_FIX, explanation: 'mapping' })
    expect(ok.ok && ok.result.status).toBe('applied')
    expect(repairOf(run2)).toMatchObject({ rerun_run_id: null })
    expect(repairOf(run2).rerun_note).toContain('not re-run automatically')
  })

  it('review fixes: supervision runs with the kill switch off, and a repeated breaker reuses the open review card', async () => {
    const { flowId, home } = publishV1('fix-switch', { budget: { run_usd: 1, repair_usd: 2, repairs_per_day: 10 } })
    const runId = await failedRun(flowId, home)
    await watcher.tick()
    expect(runRow(runId).status).toBe('repairing')
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('flow_auto_repair_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run()
    try {
      getDb().prepare("UPDATE objectives SET status = 'review', session_id = NULL WHERE id = ?").run(repairOf(runId).objective_id)
      await watcher.tick()
      expect(repairOf(runId)).toMatchObject({ status: 'needs_review', reason: 'card_closed' })
      expect(runRow(runId).status).toBe('failed')
    } finally {
      getDb().prepare("UPDATE settings SET value = '1' WHERE key = 'flow_auto_repair_enabled'").run()
    }
    // Two more same-signature failures: the second is the 3rd in 7 days (breaker), the third reuses its card.
    const r2 = await failedRun(flowId, home)
    await watcher.tick()
    expect(repairOf(r2).status).toBe('open')
    const r3 = await failedRun(flowId, home)
    await watcher.tick()
    const r4 = await failedRun(flowId, home)
    await watcher.tick()
    expect(repairOf(r3)).toMatchObject({ status: 'needs_review', reason: 'same_signature' })
    expect(repairOf(r4)).toMatchObject({ status: 'needs_review', reason: 'same_signature' })
    expect(repairOf(r4).review_objective_id).toBe(repairOf(r3).review_objective_id)
    expect(card(repairOf(r3).review_objective_id).description).toContain(`run #${r4} failed the same way`)
  })

  it('the kill switch flow_auto_repair_enabled = 0 stops triage', async () => {
    const { flowId, home } = publishV1('kill-flow')
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('flow_auto_repair_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run()
    try {
      const runId = await failedRun(flowId, home)
      await watcher.tick()
      expect(repairOf(runId)).toBeUndefined()
      expect(runRow(runId).repair_state).toBeNull()
    } finally {
      getDb().prepare("UPDATE settings SET value = '1' WHERE key = 'flow_auto_repair_enabled'").run()
    }
  })
})
