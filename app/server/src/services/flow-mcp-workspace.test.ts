// Card B3 acceptance 3 (obj 900639, docs/design/WORKFLOWS.md §7.4–7.5) against the REAL
// host resolver: workspace MCP connections (Sprint 7.8) in a real DB, credentials in the
// real secrets store, calls to the local stub MCP server (src/__fixtures__/stub-mcp-server.ts).
//
// An mcp node in workspace A cannot resolve a connector credential that is only
// connected/enabled in workspace B: the run fails with the 403-equivalent `forbidden`
// problem and the MCP server never sees a call.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import os from 'os'
import path from 'path'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in flow tests') } }))

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 23).toString('base64')
process.env.DB_PATH = path.join(os.tmpdir(), `cc-flow-mcp-test-${process.pid}-${Date.now()}.db`)
process.env.JWT_SECRET = 'test-secret-flow-mcp'
process.env.APP_BASE_URL = 'https://cc.example.test'

const { initDb, getDb } = await import('../db/index.js')
const svc = await import('./workspace-mcp-servers.js')
const { FlowEngine, saveFlowVersion } = await import('./flow-engine.js')
const { createWorkspaceMcpResolver } = await import('./flow-mcp.js')
const { startStubMcpServer, STUB_API_KEY } = await import('../__fixtures__/stub-mcp-server.js')
type FlowDefinition = import('../../../shared/flow/types.js').FlowDefinition

let stub: Awaited<ReturnType<typeof startStubMcpServer>>
let now = Date.parse('2026-11-12T00:00:00.000Z')

beforeAll(async () => {
  initDb()
  stub = await startStubMcpServer()
})
afterAll(async () => {
  await stub.close()
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM flow_step_runs; DELETE FROM flow_runs; DELETE FROM flow_versions; DELETE FROM flow_definitions;')
  db.exec('DELETE FROM workspace_mcp_servers; DELETE FROM secret_versions; DELETE FROM secrets;')
  db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'admin', 'x', 'admin')").run()
  for (const ws of ['ws-a', 'ws-b']) db.prepare('INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)').run(ws, ws.toUpperCase())
  db.prepare("INSERT INTO settings (key, value) VALUES ('flows_enabled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'").run()
  stub.state.toolCalls.length = 0
})

/** A connected API-key MCP connection that exists ONLY in workspace B. */
async function connectInWorkspaceB(extra: { catalog_id?: string } = {}) {
  const row = svc.createServer({ workspace: 'ws-b', name: 'Beta CRM', url: `${stub.baseUrl}/bearer/mcp`, auth_type: 'api_key', api_key: STUB_API_KEY, ...extra }, 1)
  const t = await svc.testServer(row.id)
  expect(t?.ok).toBe(true)
  return svc.getServerRow(row.id)!
}

function echoFlow(connector: string, workspace: string): FlowDefinition {
  return {
    apiVersion: 'okflow/1',
    id: 'crm-echo',
    name: 'CRM echo',
    workspace,
    version: 1,
    goal: { statement: 'echo', end_condition: { assert: [{ expr: 'steps.call.output != null' }] } },
    nodes: [
      { id: 'start', kind: 'trigger', on: 'manual', next: 'call' },
      { id: 'call', kind: 'mcp', connector, tool: 'echo', effect: 'read', arguments: { text: '{{ trigger.payload.text }}' }, next: 'done' },
      { id: 'done', kind: 'end', output: '{{ steps.call.output }}' },
    ],
  }
}

async function runFlow(def: FlowDefinition, workspace: string) {
  const db = getDb()
  const engine = new FlowEngine({ db, tools: { get: () => null }, mcp: createWorkspaceMcpResolver(), clock: () => now, owner: 'flow-mcp-test' })
  const saved = saveFlowVersion(db, { workspace, definition: def, author: 'user:1' })
  if (!saved.ok) throw new Error(`save failed: ${saved.reason} ${JSON.stringify(saved.errors)}`)
  const started = engine.startRun({ flowId: saved.flowId, version: 1, trigger: { source: 'manual', payload: { text: 'hello' } } })
  if (!started.ok) throw new Error(`start failed: ${started.reason}`)
  for (let i = 0; i < 10; i++) {
    await engine.tick()
    const row = db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(started.runId) as Record<string, any>
    if (['succeeded', 'failed', 'waiting'].includes(row.status)) return row
    if (row.next_attempt_at) now = Math.max(now, Date.parse(row.next_attempt_at))
  }
  throw new Error('run did not settle')
}

describe('acceptance 3: an mcp node in workspace A cannot resolve a connector credential only enabled in workspace B', () => {
  it('flow in ws-a naming ws-b\'s connection (by slug) → failed, error.type=forbidden, status 403; the MCP server is never called', async () => {
    const b = await connectInWorkspaceB()
    expect(b.slug).toBe('beta-crm')
    const run = await runFlow(echoFlow('beta-crm', 'ws-a'), 'ws-a')
    expect(run.status).toBe('failed')
    const error = JSON.parse(run.error_json)
    expect(error).toMatchObject({ type: 'forbidden', status: 403, node_id: 'call', retryable: false })
    expect(error.title).toBe('connector "beta-crm" is not enabled for workspace "ws-a"')
    // Not retried, and no request reached the server with B's credential.
    expect((getDb().prepare("SELECT COUNT(*) n FROM flow_step_runs WHERE run_id = ? AND node_id = 'call'").get(run.id) as { n: number }).n).toBe(1)
    expect(stub.state.toolCalls).toHaveLength(0)
    // The stored step/run rows never carry B's credential.
    const stored = JSON.stringify(getDb().prepare('SELECT * FROM flow_step_runs WHERE run_id = ?').all(run.id)) + JSON.stringify(run)
    expect(stored).not.toContain(STUB_API_KEY)
  })

  it('the same is true when the node names the registry connector id (catalog_id) of ws-b\'s connection', async () => {
    await connectInWorkspaceB({ catalog_id: 'linear' })
    const run = await runFlow(echoFlow('linear', 'ws-a'), 'ws-a')
    expect(JSON.parse(run.error_json)).toMatchObject({ type: 'forbidden', status: 403 })
    expect(stub.state.toolCalls).toHaveLength(0)
  })

  it('control: the same flow in ws-b resolves the connection, calls the tool with its credential and records the output', async () => {
    await connectInWorkspaceB({ catalog_id: 'linear' })
    for (const connector of ['beta-crm', 'linear']) {
      stub.state.toolCalls.length = 0
      const run = await runFlow({ ...echoFlow(connector, 'ws-b'), id: `crm-echo-${connector}` }, 'ws-b')
      expect(run.status).toBe('succeeded')
      expect(JSON.parse(run.output_json)).toEqual({ text: 'hello' })
      expect(stub.state.toolCalls).toEqual([{ name: 'echo', args: { text: 'hello' } }])
    }
  })

  it('a ws-b connection that is disabled does not resolve in ws-b either', async () => {
    const b = await connectInWorkspaceB()
    getDb().prepare('UPDATE workspace_mcp_servers SET enabled = 0 WHERE id = ?').run(b.id)
    const run = await runFlow(echoFlow('beta-crm', 'ws-b'), 'ws-b')
    expect(JSON.parse(run.error_json)).toMatchObject({ type: 'forbidden', status: 403 })
  })

  it('the resolver itself answers 403 for ws-a and a connection for ws-b — it never hands out a credential', async () => {
    await connectInWorkspaceB()
    const r = createWorkspaceMcpResolver()
    const a = await r.resolve({ workspace: 'ws-a', connector: 'beta-crm', tool: 'echo' })
    expect(a).toMatchObject({ ok: false, problem: { type: 'forbidden', status: 403 } })
    const bOk = await r.resolve({ workspace: 'ws-b', connector: 'beta-crm', tool: 'echo' })
    expect(bOk.ok).toBe(true)
    expect(JSON.stringify(bOk)).not.toContain(STUB_API_KEY)
    // A tool switched off for the connection is refused too.
    const off = await r.resolve({ workspace: 'ws-b', connector: 'beta-crm', tool: 'not_a_tool' })
    expect(off).toMatchObject({ ok: false, problem: { type: 'forbidden', status: 403 } })
  })
})
