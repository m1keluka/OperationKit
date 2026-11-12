// Workflows card B6 (obj 900642, docs/design/WORKFLOWS.md §5.1 / §7.6) — acceptance:
//   1. route-map   : each workflow MCP tool maps to exactly one REST route — the route
//                    is registered on the flows router, sits on the agent surface with
//                    the tool's scope, is documented in OpenAPI, and is the ONLY call the
//                    tool makes (the internal-objectives-dag style: the declared list
//                    and the real router must agree).
//   2. no-publish  : publish is not reachable via MCP — no tool, off the agent surface,
//                    and a direct REST call with a full-scope agent key is 403.
//   3. mcp-e2e     : from an MCP client with a cc_live_ key: create → draft → validate →
//                    test returns a GREEN self-test for a sample goal.
//   4. builder     : the builder card (its session token) iterates on a deliberately
//                    broken draft, fixing it from the validator's errors, until valid
//                    within builder.max_iterations; the cap is enforced server-side.
//   5. brief       : "New workflow" files a builder card whose brief carries the goal,
//                    end condition, Tool registry and the workspace's enabled connectors.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// db/index.ts's import graph reaches node-pty; nothing here opens a terminal.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in this test') } }))

const TMP_DB = path.join(os.tmpdir(), `cc-flows-b6-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-flows-b6'
process.env.ALERTS_ENABLED = 'false'
process.env.CC_SESSION_KB_ACCESS = '1'
// Never reach for a real okit CLI from a test.
process.env.OKIT_BIN = path.join(os.tmpdir(), `no-okit-${process.pid}`)

const { initDb, getDb } = await import('../db/index.js')
const { default: flowsRouter } = await import('./flows.js')
const { default: workspacesRouter } = await import('./workspaces.js')
const { default: agentMcpRouter, MCP_TOOLS, WORKFLOW_TOOL_ROUTES } = await import('./agent-mcp.js')
const { agentKeyGuard, requiredScope } = await import('../middleware/agent-key-guard.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { registerFlowTool } = await import('../services/flow-engine.js')
const { AGENT_OPENAPI } = await import('../api/agent-openapi.js')
const { invalidateWorkspacesCache } = await import('../services/workspaces.js')

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = { id: 701, username: 'owner', role: 'admin' as const }
const WS = 'ws-a'
const OTHER_WS = 'ws-b'

let server: http.Server
let baseUrl = ''
let botKey = ''

const cookie = () => `token=${jwt.sign(ADMIN, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function call(
  method: string,
  p: string,
  opts: { bearer?: string; session?: string; owner?: boolean; body?: unknown } = {},
): Promise<{ status: number; json: Loose }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.session) headers['X-CC-Session-Token'] = opts.session
  else if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  else if (opts.owner) headers.Cookie = cookie()
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: unknown = text
  try { json = JSON.parse(text) } catch { /* text */ }
  return { status: res.status, json }
}

let rpcId = 0
async function rpc(method: string, params: unknown, token: string): Promise<Loose> {
  const r = await call('POST', '/api/mcp', { bearer: token, body: { jsonrpc: '2.0', id: ++rpcId, method, params } })
  expect(r.status).toBe(200)
  return r.json
}

/** tools/call → the tool's parsed JSON result, or `{ isError, text }`. */
async function tool(name: string, args: Record<string, unknown>, token = botKey): Promise<Loose> {
  const r = await rpc('tools/call', { name, arguments: args }, token)
  if (r.error) return { rpcError: r.error }
  const text = r.result.content[0].text as string
  if (r.result.isError) return { isError: true, text, structured: r.result.structuredContent }
  return JSON.parse(text)
}

const setFlowsEnabled = (on: boolean) =>
  getDb().prepare("INSERT INTO settings (key, value) VALUES ('flows_enabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? '1' : '0')

/** The sample goal used end to end: welcome yesterday's signups, one message each. */
const SAMPLE_GOAL = "Every person who signed up yesterday gets exactly one welcome message, and nobody is skipped."
const SAMPLE_END_CONDITION = {
  assert: [{ expr: 'steps.welcome.output.sent == len(steps.fetch.output.signups)', why: 'one welcome per signup' }],
}

function sampleDefinition(slug: string, workspace = WS): Record<string, unknown> {
  return {
    apiVersion: 'okflow/1',
    id: slug,
    name: 'Welcome new signups',
    workspace,
    goal: { statement: SAMPLE_GOAL, end_condition: SAMPLE_END_CONDITION },
    nodes: [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
      {
        id: 'fetch', kind: 'tool', tool: 'signups-list', effect: 'read', input: { since: "{{ date_add(now(), -1, 'day') }}" },
        mock: { output: { signups: [{ email: 'a@example.test' }, { email: 'b@example.test' }] } }, next: 'welcome',
      },
      {
        id: 'welcome', kind: 'mcp', connector: 'mailer', tool: 'send_welcome', effect: 'send',
        arguments: { recipients: '{{ steps.fetch.output.signups }}' }, mock: { output: { sent: 2 } }, next: 'verify',
      },
      { id: 'verify', kind: 'check', assert: [{ expr: 'steps.welcome.output.sent > 0', why: 'something went out' }], next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.welcome.output }}' },
    ],
  }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare("INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)").run(ADMIN.id, ADMIN.username, ADMIN.role)
  for (const ws of [WS, OTHER_WS]) db.prepare("INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)").run(ws, ws.toUpperCase())
  invalidateWorkspacesCache()
  // A connected + enabled MCP connection in ws-a (one tool turned off), and one in ws-b.
  const ins = db.prepare(
    `INSERT INTO workspace_mcp_servers (workspace, slug, name, url, status, tools_json, disabled_tools_json, enabled)
     VALUES (?, ?, ?, 'https://mcp.example.test', ?, ?, ?, ?)`,
  )
  ins.run(WS, 'mailer', 'Mailer', 'connected', JSON.stringify([{ name: 'send_welcome' }, { name: 'delete_list' }]), JSON.stringify(['delete_list']), 1)
  ins.run(WS, 'old-crm', 'Old CRM', 'connected', JSON.stringify([{ name: 'upsert' }]), '[]', 0)
  ins.run(OTHER_WS, 'b-secret-crm', 'B CRM', 'connected', JSON.stringify([{ name: 'export_all' }]), '[]', 1)
  registerFlowTool('signups-list', { effect: 'read', run: async () => ({ signups: [] }) })

  const minted = createAgentKey(ADMIN, { label: 'workflow-bot', scopes: ['board:read', 'board:write', 'board:start'], workspaces: [WS] })
  if (!minted.ok) throw new Error(minted.error)
  botKey = minted.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/flows', flowsRouter)
  app.use('/api/workspaces', workspacesRouter)
  app.use('/api', agentMcpRouter)
  server = http.createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  process.env.CC_MCP_LOOPBACK_BASE = baseUrl
})

afterAll(async () => {
  delete process.env.CC_MCP_LOOPBACK_BASE
  await new Promise<void>((r) => server.close(() => r()))
  try { fs.unlinkSync(TMP_DB) } catch { /* gone */ }
})

beforeEach(() => setFlowsEnabled(true))

// ── 1. route map ────────────────────────────────────────────────────────────

const EXPECTED_WORKFLOW_TOOLS = [
  'create_workflow', 'draft_workflow_version', 'get_workflow', 'get_workflow_run',
  'list_workflows', 'run_workflow', 'test_workflow', 'validate_workflow',
]

/** Every (method, path) the real flows router registers, as `/api/flows…` templates. */
function registeredFlowRoutes(): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = []
  for (const layer of (flowsRouter as Loose).stack as Loose[]) {
    if (!layer.route) continue
    for (const m of Object.keys(layer.route.methods)) {
      out.push({ method: m.toUpperCase(), path: `/api/flows${layer.route.path === '/' ? '' : layer.route.path}` })
    }
  }
  return out
}

const sample = (template: string) => template.replace(/:[a-zA-Z]+/g, '7')
const openApiPath = (template: string) => template.replace(/:([a-zA-Z]+)/g, '{$1}')

describe('route-map: each workflow MCP tool maps to one REST route', () => {
  const workflowTools = () => MCP_TOOLS.filter((t) => t.name in WORKFLOW_TOOL_ROUTES)

  it('the declared map lists exactly the eight B6 tools, and every one is a registered MCP tool', () => {
    expect(Object.keys(WORKFLOW_TOOL_ROUTES).sort()).toEqual(EXPECTED_WORKFLOW_TOOLS)
    expect(workflowTools().map((t) => t.name).sort()).toEqual(EXPECTED_WORKFLOW_TOOLS)
    // and no other MCP tool talks about workflows without a map entry
    expect(MCP_TOOLS.filter((t) => /workflow/.test(t.name)).map((t) => t.name).sort()).toEqual(EXPECTED_WORKFLOW_TOOLS)
  })

  it('every mapped route is registered on the real flows router (method + path)', () => {
    const routes = registeredFlowRoutes()
    for (const [name, r] of Object.entries(WORKFLOW_TOOL_ROUTES)) {
      expect(routes, `${name} → ${r.method} ${r.path}`).toContainEqual({ method: r.method, path: r.path })
    }
  })

  it("every mapped route is on the agent surface with exactly the tool's scope", () => {
    for (const t of workflowTools()) {
      const r = WORKFLOW_TOOL_ROUTES[t.name as keyof typeof WORKFLOW_TOOL_ROUTES]
      expect(requiredScope(r.method, sample(r.path), {}), `${t.name} → ${r.method} ${r.path}`).toEqual({ kind: 'scope', scope: t.scope })
    }
  })

  it('every mapped route is documented in the OpenAPI spec', () => {
    const paths = AGENT_OPENAPI.paths as Record<string, Record<string, unknown>>
    for (const [name, r] of Object.entries(WORKFLOW_TOOL_ROUTES)) {
      expect(paths[openApiPath(r.path)]?.[r.method.toLowerCase()], `${name} → ${openApiPath(r.path)}`).toBeTruthy()
    }
  })

  it('each tool makes exactly one REST call, and it is its mapped route', async () => {
    const args: Record<string, Record<string, unknown>> = {
      list_workflows: { workspace: WS },
      get_workflow: { id: 7 },
      create_workflow: { workspace: WS, goal: 'g' },
      draft_workflow_version: { id: 7, definition: { nodes: [] } },
      validate_workflow: { definition: { nodes: [] } },
      test_workflow: { id: 7 },
      run_workflow: { id: 7 },
      get_workflow_run: { id: 7, run_id: 7 },
    }
    for (const t of workflowTools()) {
      const calls: { method: string; path: string }[] = []
      await t.run(args[t.name], async (method, p) => {
        calls.push({ method, path: p.split('?')[0] })
        return {}
      })
      const r = WORKFLOW_TOOL_ROUTES[t.name as keyof typeof WORKFLOW_TOOL_ROUTES]
      expect(calls, t.name).toEqual([{ method: r.method, path: sample(r.path) }])
    }
  })

  it('tools/list shows all eight to a key with read/write/start, and only the reads to a read-only key', async () => {
    const all = (await rpc('tools/list', {}, botKey)).result.tools.map((t: Loose) => t.name)
    for (const n of EXPECTED_WORKFLOW_TOOLS) expect(all).toContain(n)
    const ro = createAgentKey(ADMIN, { label: 'reader', scopes: ['board:read'], workspaces: [WS] })
    if (!ro.ok) throw new Error(ro.error)
    const seen = (await rpc('tools/list', {}, ro.key.token)).result.tools.map((t: Loose) => t.name).filter((n: string) => /workflow/.test(n))
    expect(seen.sort()).toEqual(['get_workflow', 'get_workflow_run', 'list_workflows'])
  })
})

// ── 2. publish is not reachable via MCP ─────────────────────────────────────

describe('no-publish: publish is not reachable via MCP', () => {
  it('no MCP tool publishes or approves, and none maps to the publish route', () => {
    expect(MCP_TOOLS.map((t) => t.name).filter((n) => /publish|approv/.test(n))).toEqual([])
    expect(Object.values(WORKFLOW_TOOL_ROUTES).filter((r) => /publish/.test(r.path))).toEqual([])
    expect((AGENT_OPENAPI.paths as Record<string, unknown>)['/api/flows/{id}/publish']).toBeUndefined()
  })

  it('publish is off the agent surface, and a full-scope key gets 403 on the REST route', async () => {
    expect(requiredScope('POST', '/api/flows/7/publish', {})).toEqual({ kind: 'off_surface' })
    const full = createAgentKey(ADMIN, {
      label: 'all-scopes', scopes: ['board:read', 'board:write', 'board:start', 'board:cancel', 'board:done', 'board:delete'], workspaces: null,
    })
    if (!full.ok) throw new Error(full.error)
    const made = await tool('create_workflow', { workspace: WS, goal: SAMPLE_GOAL, name: 'Publish probe' })
    const r = await call('POST', `/api/flows/${made.flow_id}/publish`, { bearer: full.key.token, body: { version: 1, approve: ['welcome'] } })
    expect(r.status).toBe(403)
    expect(r.json.missing_scope).toBeNull() // not a scope a key could ever be granted
  })

  it("B9's per-run approval and unknown-outcome routes are owner decisions too: off the agent surface, 403 for a full-scope key", async () => {
    for (const p of ['/api/flows/7/runs/3/approval', '/api/flows/7/runs/3/outcome', '/api/flows/7/events']) {
      expect(requiredScope('POST', p, {}), p).toEqual({ kind: 'off_surface' })
    }
    expect(Object.values(WORKFLOW_TOOL_ROUTES).filter((r) => /approval|outcome|events/.test(r.path))).toEqual([])
    const full = createAgentKey(ADMIN, {
      label: 'all-scopes-b9', scopes: ['board:read', 'board:write', 'board:start', 'board:cancel', 'board:done', 'board:delete'], workspaces: null,
    })
    if (!full.ok) throw new Error(full.error)
    const made = await tool('create_workflow', { workspace: WS, goal: SAMPLE_GOAL, name: 'Approval probe' })
    for (const [p, body] of [
      [`/api/flows/${made.flow_id}/runs/1/approval`, { decision: 'approve' }],
      [`/api/flows/${made.flow_id}/runs/1/outcome`, { node_id: 'welcome', outcome: 'sent' }],
    ] as const) {
      const r = await call('POST', p, { bearer: full.key.token, body })
      expect(r.status, p).toBe(403)
      expect(r.json.missing_scope, p).toBeNull()
    }
  })

  it('calling a publish tool over MCP is an unknown tool', async () => {
    for (const name of ['publish_workflow', 'approve_workflow']) {
      const r = await tool(name, { id: 1, version: 1 })
      expect(r.rpcError?.code, name).toBe(-32602)
    }
  })
})

// ── 3. MCP end to end ───────────────────────────────────────────────────────

describe('mcp-e2e: create → draft → validate → test is green for a sample goal', () => {
  it('runs the whole loop through /api/mcp with a cc_live_ key', async () => {
    expect(botKey.startsWith('cc_live_')).toBe(true)

    const created = await tool('create_workflow', {
      workspace: WS, goal: SAMPLE_GOAL, name: 'Welcome new signups', end_condition: SAMPLE_END_CONDITION,
    })
    expect(created.confirmation).toMatch(/Created workflow #\d+/)
    expect(created).toMatchObject({ workspace: WS, slug: 'welcome-new-signups', max_iterations: 6 })
    const flowId = created.flow_id as number

    const card = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(created.objective_id) as Loose
    expect(card).toMatchObject({ workspace: WS, origin: 'workflow', status: 'queue', type: 'task' })
    expect(card.description).toContain(SAMPLE_GOAL)

    const def = sampleDefinition(created.slug)
    const valid = await tool('validate_workflow', { definition: def })
    expect(valid.ok, JSON.stringify(valid.errors)).toBe(true)
    // the unapproved send node is a warning (the owner approves at publish), not an error
    expect(valid.warnings.map((w: Loose) => w.code)).toContain('UNAPPROVED_EFFECT')

    const drafted = await tool('draft_workflow_version', { id: flowId, definition: def })
    expect(drafted).toMatchObject({ flow_id: flowId, version: 1, created: true })
    expect(drafted.builder).toMatchObject({ used: 1, max: 6, remaining: 5 })

    const tested = await tool('test_workflow', { id: flowId, version: 1, mode: 'dry' })
    expect(tested.confirmation).toMatch(/PASSED/)
    expect(tested.self_test).toMatchObject({ status: 'passed', passed: true, version: 1, mode: 'dry' })

    // what the owner sees before publishing: green self-test + the send node to approve
    const shown = await tool('get_workflow', { id: flowId })
    expect(shown.publish).toMatchObject({ version: 1, nodes_requiring_approval: ['welcome'], published: false })
    expect(shown.publish.self_test).toMatchObject({ status: 'passed' })
    expect(shown.mermaid).toContain('flowchart')

    // the self-test's run: nothing was sent, the send node was recorded as "would send"
    const run = await tool('get_workflow_run', { id: flowId, run_id: tested.self_test.run_ids[0] })
    expect(run.run).toMatchObject({ mode: 'dry', status: 'succeeded', goal_met: 1 })
    expect(run.steps.find((s: Loose) => s.node_id === 'welcome')).toMatchObject({ simulated: 'would_send', effect: 'send' })

    // list_workflows sees it; nothing is published, so a live run is refused
    const listed = await tool('list_workflows', {})
    expect(listed.flows.map((f: Loose) => f.id)).toContain(flowId)
    const live = await tool('run_workflow', { id: flowId })
    expect(live.isError).toBe(true)
    expect(live.text).toMatch(/409: no_published_version/) // the route's reason, not a bare "HTTP 409"
  })

  it('right after create, get_workflow answers 200 with no version and the builder state (not a 404)', async () => {
    const created = await tool('create_workflow', { workspace: WS, goal: 'Versionless probe', max_iterations: 3 })
    const rest = await call('GET', `/api/flows/${created.flow_id}`, { bearer: botKey })
    expect(rest.status).toBe(200)
    expect(rest.json).toMatchObject({ version: null, definition: null, versions: [], publish: null })
    expect(rest.json.builder).toEqual({ goal: 'Versionless probe', objective_id: created.objective_id, used: 0, max: 3, remaining: 3, exhausted: false })
    const shown = await tool('get_workflow', { id: created.flow_id })
    expect(shown.version).toBeNull()
    expect(shown.publish.published).toBe(false)
    expect(shown.note).toMatch(/No version yet/)
    expect(shown.builder).toMatchObject({ used: 0, max: 3 })
  })

  it('a refused draft returns every validator issue in the tool text', async () => {
    const created = await tool('create_workflow', { workspace: WS, goal: 'Broken draft probe' })
    const def = sampleDefinition(created.slug)
    ;(def.nodes as Loose[]).push({ id: 'fetch', kind: 'end' })
    ;(def.nodes as Loose[])[2].arguments = { key: '{{ secrets.MAILER_KEY }}' }
    const r = await tool('draft_workflow_version', { id: created.flow_id, definition: def })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/invalid_definition: \d+ issue\(s\)/)
    expect(r.text).toContain('[DUPLICATE_NODE_ID]')
    expect(r.text).toContain('[SECRET_REFERENCE]')
    expect(r.text).toMatch(/Builder iterations used 1\/6/)
  })

  it('a key pinned to ws-a cannot create, read or draft in ws-b over MCP', async () => {
    const r = await tool('create_workflow', { workspace: OTHER_WS, goal: 'exfiltrate' })
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/Error 403/)
    const bFlow = await call('POST', '/api/flows', { owner: true, body: { workspace: OTHER_WS, goal: 'B private' } })
    expect(bFlow.status).toBe(201)
    for (const [name, args] of [
      ['get_workflow', { id: bFlow.json.flow_id }],
      ['draft_workflow_version', { id: bFlow.json.flow_id, definition: sampleDefinition(bFlow.json.slug, OTHER_WS) }],
      ['test_workflow', { id: bFlow.json.flow_id }],
    ] as [string, Record<string, unknown>][]) {
      const out = await tool(name, args)
      expect(out.isError, name).toBe(true)
      expect(out.text, name).toMatch(/Error 403/)
    }
    expect((await tool('list_workflows', {})).flows.some((f: Loose) => f.workspace === OTHER_WS)).toBe(false)
  })
})

// ── 4. the builder card iterates within builder.max_iterations ──────────────

/** A deliberately broken draft: three independent root errors. */
function brokenDraft(slug: string): Loose {
  const def = sampleDefinition(slug) as Loose
  def.goal = { statement: SAMPLE_GOAL, end_condition: { assert: [], judge: { rubric: 'looks fine', on: 'steps.welcome.output', budget_usd: 0.01 } } }
  def.nodes[2].arguments = { recipients: '{{ steps.fetch.output.signups }}', api_key: '{{ secrets.MAILER_KEY }}' }
  def.nodes[3].id = 'fetch' // duplicate id …
  def.nodes[2].next = 'fetch' // … wired where 'verify' was
  return def
}

/**
 * The builder's repair step, driven ONLY by the validator's answer: fix the first
 * issue it knows how to fix, one per iteration — the slowest honest builder.
 */
const FIXES: Record<string, (d: Loose) => void> = {
  GOAL_NO_DETERMINISTIC_ASSERT: (d) => { d.goal.end_condition = { assert: SAMPLE_END_CONDITION.assert } },
  SECRET_REFERENCE: (d) => { delete d.nodes[2].arguments.api_key },
  DUPLICATE_NODE_ID: (d) => { d.nodes[3].id = 'verify'; d.nodes[2].next = 'verify' },
}

function repair(def: Loose, errors: { code: string }[]): Loose {
  const fixable = errors.find((e) => FIXES[e.code])
  if (!fixable) throw new Error(`builder has no fix for: ${errors.map((e) => e.code).join(', ')}`)
  const next = JSON.parse(JSON.stringify(def))
  FIXES[fixable.code](next)
  return next
}

async function newBuilderFlow(goal: string, maxIterations: number): Promise<{ flowId: number; slug: string; session: string; objectiveId: number }> {
  const r = await call('POST', '/api/flows', { owner: true, body: { workspace: WS, goal, builder: { max_iterations: maxIterations } } })
  expect(r.status, JSON.stringify(r.json)).toBe(201)
  expect(r.json.builder.max_iterations).toBe(maxIterations)
  const session = mintSessionToken({ objectiveId: r.json.objective_id, workspace: WS, actingUserId: ADMIN.id })
  return { flowId: r.json.flow_id, slug: r.json.slug, session, objectiveId: r.json.objective_id }
}

describe('builder: iterates on a broken draft until valid within builder.max_iterations', () => {
  it('fixes a three-error draft one error per iteration and lands a green version inside the budget', async () => {
    const MAX = 5
    const { flowId, slug, session } = await newBuilderFlow('Welcome every new signup (builder loop)', MAX)
    let def = brokenDraft(slug)
    const transcript: { iteration: number; status: number; codes: string[]; used: number; remaining: number }[] = []
    let accepted: Loose = null
    for (let i = 1; i <= MAX; i++) {
      const r = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: def } })
      transcript.push({
        iteration: i, status: r.status, codes: (r.json.errors ?? []).map((e: Loose) => e.code),
        used: r.json.builder.used, remaining: r.json.builder.remaining,
      })
      if (r.status === 201) { accepted = r.json; break }
      expect(r.status).toBe(400)
      expect(r.json.reason).toBe('invalid_definition')
      def = repair(def, r.json.errors)
    }
    // Three refusals, each naming what was still wrong, then a valid draft on iteration 4 of 5.
    expect(transcript.map((t) => t.status)).toEqual([400, 400, 400, 201])
    expect(transcript[0].codes).toEqual(expect.arrayContaining(['DUPLICATE_NODE_ID', 'SECRET_REFERENCE', 'GOAL_NO_DETERMINISTIC_ASSERT']))
    expect(transcript.map((t) => t.used)).toEqual([1, 2, 3, 4])
    expect(accepted.builder).toMatchObject({ used: 4, max: MAX, remaining: 1, exhausted: false })
    expect(accepted.flow.created_by).toBe('user:701')
    const stored = getDb().prepare('SELECT author FROM flow_versions WHERE flow_id = ? AND version = ?').get(flowId, accepted.version) as Loose
    expect(stored.author).toMatch(/^agent:\d+$/)

    // the version it landed self-tests green, which resets the iteration budget
    const t = await call('POST', `/api/flows/${flowId}/test`, { session, body: { version: accepted.version, mode: 'dry' } })
    expect(t.json.self_test.status, JSON.stringify(t.json.self_test?.result)).toBe('passed')
    const attempts = getDb().prepare('SELECT ok FROM flow_builder_attempts WHERE flow_id = ? ORDER BY id').all(flowId) as { ok: number }[]
    expect(attempts.map((a) => a.ok)).toEqual([0, 0, 0, 1])
    const again = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: { ...def, name: 'Welcome new signups v2' } } })
    expect(again.status).toBe(201)
    expect(again.json.builder).toMatchObject({ used: 1, max: MAX })
  })

  it('refuses the draft after the budget is spent (409 builder_iterations_exhausted); a human can still draft', async () => {
    const { flowId, slug, session } = await newBuilderFlow('Exhaust the builder budget', 2)
    const broken = brokenDraft(slug)
    expect((await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: broken } })).json.builder).toMatchObject({ used: 1, remaining: 1 })
    expect((await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: broken } })).json.builder).toMatchObject({ used: 2, remaining: 0, exhausted: true })
    const third = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: sampleDefinition(slug) } })
    expect(third.status).toBe(409)
    expect(third.json).toMatchObject({ reason: 'builder_iterations_exhausted', builder: { used: 2, max: 2 } })
    // the refusal itself did not count, and an agent key is capped the same way
    expect((getDb().prepare('SELECT COUNT(*) n FROM flow_builder_attempts WHERE flow_id = ?').get(flowId) as { n: number }).n).toBe(2)
    expect((await call('POST', `/api/flows/${flowId}/versions`, { bearer: botKey, body: { definition: sampleDefinition(slug) } })).status).toBe(409)
    // the owner is never capped
    const human = await call('POST', `/api/flows/${flowId}/versions`, { owner: true, body: { definition: sampleDefinition(slug) } })
    expect(human.status).toBe(201)
    expect(human.json.builder).toBeNull()
  })

  it('validate is free: it never counts against the budget', async () => {
    const { flowId, slug, session } = await newBuilderFlow('Validate is free', 1)
    for (let i = 0; i < 3; i++) {
      const v = await call('POST', '/api/flows/validate', { session, body: { definition: brokenDraft(slug) } })
      expect(v.status).toBe(200)
      expect(v.json.ok).toBe(false)
    }
    const d = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: sampleDefinition(slug) } })
    expect(d.status).toBe(201)
    expect(d.json.builder).toMatchObject({ used: 1, max: 1 })
  })

  it('a draft for the wrong flow id or workspace is refused with a hint, and counts', async () => {
    const { flowId, slug, session } = await newBuilderFlow('Mismatch probe', 6)
    const wrongId = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: sampleDefinition('some-other-flow') } })
    expect(wrongId.status).toBe(400)
    expect(wrongId.json).toMatchObject({ reason: 'flow_id_mismatch', error: `definition.id must be '${slug}'` })
    expect(wrongId.json.builder.used).toBe(1)
    // id / workspace / version may be omitted: they default to the flow's own and the next number
    const bare = sampleDefinition(slug) as Loose
    delete bare.id; delete bare.workspace
    const ok = await call('POST', `/api/flows/${flowId}/versions`, { session, body: { definition: bare } })
    expect(ok.status, JSON.stringify(ok.json)).toBe(201)
    expect(ok.json.version).toBe(1)
  })
})

// ── 5. the builder brief ────────────────────────────────────────────────────

describe('brief: New workflow files a builder card with goal, registry and connectors', () => {
  it('carries the goal, the given end condition, the Tool registry, enabled connectors only, and the loop', async () => {
    const r = await call('POST', '/api/flows', {
      owner: true, body: { workspace: WS, goal: SAMPLE_GOAL, name: 'Brief probe', end_condition: SAMPLE_END_CONDITION },
    })
    expect(r.status).toBe(201)
    const card = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(r.json.objective_id) as Loose
    expect(card.title).toBe('Build workflow: Brief probe')
    expect(card.completion_goal).toMatch(/self-test is `passed`/)
    const brief: string = card.description
    expect(brief).toContain(SAMPLE_GOAL)
    expect(brief).toContain(SAMPLE_END_CONDITION.assert[0].expr)
    expect(brief).toContain('| `signups-list` | read | yes |')
    expect(brief).toContain('`mailer`')
    expect(brief).toContain('`send_welcome`')
    expect(brief).not.toContain('delete_list') // a tool turned off on the connection
    expect(brief).not.toContain('old-crm') // a disabled connection
    expect(brief).not.toContain('b-secret-crm') // another workspace's connection
    expect(brief).toContain(`/api/flows/${r.json.flow_id}/versions`)
    expect(brief).toContain('/api/flows/validate')
    expect(brief).toContain(`/api/flows/${r.json.flow_id}/test`)
    expect(brief).toContain('budget: 6 draft submissions')
    expect(brief).toMatch(/never publish/i)
    expect(brief).toContain(`id: "${r.json.slug}"`)
    const flow = getDb().prepare('SELECT objective_id, goal_statement, status FROM flow_definitions WHERE id = ?').get(r.json.flow_id) as Loose
    expect(flow).toEqual({ objective_id: r.json.objective_id, goal_statement: SAMPLE_GOAL, status: 'draft' })
  })

  it('with no end condition the brief asks the builder to propose one for the owner to confirm', async () => {
    const r = await call('POST', '/api/flows', { owner: true, body: { workspace: WS, goal: 'Summarise yesterday\'s support tickets' } })
    const card = getDb().prepare('SELECT title, description FROM objectives WHERE id = ?').get(r.json.objective_id) as Loose
    expect(card.title).toBe("Build workflow: Summarise yesterday's support tickets")
    expect(card.description).toMatch(/None given\. \*\*Propose one\*\*/)
    expect(r.json.slug).toBe('summarise-yesterday-s-support-tickets')
  })

  it('while the kill switch is off the builder card is held so the queue does not auto-start it', async () => {
    setFlowsEnabled(false)
    const r = await call('POST', '/api/flows', { owner: true, body: { workspace: WS, goal: 'Held builder' } })
    expect(r.status).toBe(201)
    expect(r.json.builder.queue_hold).toMatch(/^flows_disabled/)
    const card = getDb().prepare('SELECT status, queue_hold, description FROM objectives WHERE id = ?').get(r.json.objective_id) as Loose
    expect(card.status).toBe('queue')
    expect(card.queue_hold).toMatch(/^flows_disabled/)
    expect(card.description).toContain('settings.flows_enabled = 0')
  })

  it('slugs stay unique per workspace and bad input is a 400', async () => {
    const a = await call('POST', '/api/flows', { owner: true, body: { workspace: WS, goal: 'x', name: 'Same Name' } })
    const b = await call('POST', '/api/flows', { owner: true, body: { workspace: WS, goal: 'x', name: 'Same Name' } })
    expect([a.json.slug, b.json.slug]).toEqual(['same-name', 'same-name-2'])
    for (const body of [
      { workspace: WS, goal: '' },
      { workspace: WS, goal: 'x', end_condition: { judge: { rubric: 'only a judge' } } },
      { workspace: WS, goal: 'x', builder: { max_iterations: 0 } },
      { workspace: WS, goal: 'x', builder: { max_iterations: 21 } },
      { workspace: WS, goal: 'x'.repeat(4001) },
    ]) {
      expect((await call('POST', '/api/flows', { owner: true, body })).status, JSON.stringify(body).slice(0, 80)).toBe(400)
    }
  })
})
