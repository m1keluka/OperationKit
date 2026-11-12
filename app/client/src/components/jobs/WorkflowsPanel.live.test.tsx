import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { FlowDetailResponse, FlowNodeInspectResponse, FlowRunDetailResponse, FlowRunSummary, FlowSummary } from '../../../../shared/flow/api'
import type { FlowDefinition } from '../../../../shared/flow/types'
import { THIRTY_NODE_FLOW } from '../../../../shared/flow/__tests__/thirty-nodes'

/**
 * Card B7 (obj 900643), wired end to end in the Workflows detail view with the
 * REAL hooks (useFlowDetail, fetchFlowRun, useFlowLiveEvents, the WebSocket
 * listener bus) over a mocked fetch:
 *   - "Overlays update within 2 s of a step change": a `flow_step` message for
 *     the shown run refetches it and the node's status changes on the canvas,
 *     measured, well before the 4 s fallback poll could have done it;
 *   - the side panel shows only what the redacted inspect route returned — a
 *     token seeded into the DEFINITION never reaches it;
 *   - changed-node tags + the version caption.
 * React Flow is replaced by a pass-through that renders each node's data.
 */

vi.mock('@xyflow/react', async importOriginal => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  const ReactFlow = (props: { nodes: { id: string; data: { status?: string; change?: string } }[]; onNodeClick?: (e: unknown, n: unknown) => void }) => (
    <div>
      {props.nodes.map(n => (
        <button key={n.id} data-testid={`rf-node-${n.id}`} data-status={n.data.status ?? ''} data-change={n.data.change ?? ''}
          onClick={() => props.onNodeClick?.({}, n)} />
      ))}
    </div>
  )
  return { ...actual, ReactFlow }
})
vi.mock('../../lib/mermaid', () => ({ renderMermaidIn: async () => {} }))

const { WorkflowsPanel } = await import('./WorkflowsPanel')
const { dispatchServerMessage } = await import('../../hooks/useWebSocket')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

const SEEDED = `ghp_${'Z9y8X7w6V5'.repeat(4)}`
const DEF: FlowDefinition = JSON.parse(JSON.stringify(THIRTY_NODE_FLOW))
// A literal secret typed into a definition: the canvas has it, the panel must never show it.
;(DEF.nodes.find(n => n.id === 'accounts') as unknown as { input: unknown }).input = { api_token: SEEDED }

const RUN: FlowRunSummary = {
  id: 41, flow_id: 12, flow_slug: 'weekly-account-review', flow_name: 'Weekly account review', workspace: 'acme', version: 2,
  mode: 'live', status: 'running', goal_met: null, spent_usd: 0, trigger_source: 'manual', objective_id: 500,
  created_at: new Date().toISOString(), started_at: new Date().toISOString(), ended_at: null, error: null, goal: null, self_test_id: null,
}
const FLOW: FlowSummary = {
  id: 12, slug: 'weekly-account-review', name: 'Weekly account review', workspace: 'acme', status: 'active',
  published_version: 2, latest_version: 2, objective_id: 500, created_by: 'user:1', created_at: RUN.created_at, updated_at: RUN.created_at,
  trigger: { on: 'schedule', cron: '0 7 * * 1' }, node_count: 30, kinds: {}, routine: null, last_run: RUN,
}
const DETAIL: FlowDetailResponse = {
  flows_enabled: true, flow: FLOW, version: 2, definition: DEF,
  versions: [
    { version: 2, author: 'repair:run-123', sha256: 'b', parent_version: 1, created_at: RUN.created_at, published: true },
    { version: 1, author: 'user:1', sha256: 'a', parent_version: null, created_at: RUN.created_at, published: false },
  ],
  mermaid: 'flowchart TD\n', node_status: { start: 'succeeded', accounts: 'running' }, status_run_id: 41, runs: [RUN],
  publish: { version: 2, nodes_requiring_approval: [], nodes_missing_mocks: [], self_test: null, approvals: null },
  changes: { base_version: 1, author: 'repair:run-123', added: [], changed: ['score'], removed: ['old_step'] },
}

/** What the server "has" for run 41; a step change mutates it. */
let serverStatus: Record<string, string> = {}
let runFetches = 0
const INSPECT: FlowNodeInspectResponse = {
  run_id: 41, version: 2, node_id: 'accounts', kind: 'tool',
  config: '{\n  "id": "accounts",\n  "input": { "api_token": "[REDACTED:GITHUB_TOKEN]" }\n}',
  status: 'succeeded',
  attempts: [{
    iteration: 0, attempt: 1, status: 'succeeded', effect: 'read', simulated: null, cost_usd: 0,
    started_at: RUN.created_at, ended_at: RUN.created_at, input: '{ "api_token": "[REDACTED:GITHUB_TOKEN]" }',
    output: '{ "items": [ { "id": "a1" } ] }', error: null, truncated: false,
  }],
  attempt_count: 1, last_good: null,
}

function runDetail(): FlowRunDetailResponse {
  return { run: RUN, steps: [], node_status: serverStatus as FlowRunDetailResponse['node_status'], mermaid: '', waits: [] }
}

const fetchMock = vi.fn(async (url: string) => {
  const u = String(url)
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
  if (u === '/api/flows/12' || u.startsWith('/api/flows/12?')) return json(DETAIL)
  if (u === '/api/flows/12/runs/41') { runFetches++; return json(runDetail()) }
  if (u === '/api/flows/12/runs/41/nodes/accounts') return json(INSPECT)
  return new Response('{}', { status: 404 })
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  serverStatus = { start: 'succeeded', accounts: 'running' }
  runFetches = 0
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function until(cond: () => boolean, ms = 3000): Promise<number> {
  const t0 = performance.now()
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error('condition not met in time')
    await new Promise(r => setTimeout(r, 10))
  }
  return performance.now() - t0
}

const status = (id: string) => container.querySelector(`[data-testid="rf-node-${id}"]`)?.getAttribute('data-status')

async function mount(onRunLifecycle?: () => void) {
  flushSync(() => root.render(
    <WorkflowsPanel flows={[FLOW]} flowsEnabled loading={false} labelOf={s => s} selectedId={12} onSelect={() => {}} onRunNow={async () => ({ ok: true })}
      onRunLifecycle={onRunLifecycle} />,
  ))
  await until(() => status('accounts') === 'running')
  // the overlay first draws the detail's node_status, then the run it fetched
  await until(() => runFetches >= 1)
  await new Promise(r => setTimeout(r, 50))
}

describe('Workflows viewer v2 — live overlay over WebSocket', () => {
  it('a flow_step message updates the node overlay within 2 s (no polling involved)', async () => {
    await mount()
    const before = runFetches
    // The engine wrote the step row; the server pushes ids + status.
    serverStatus = { start: 'succeeded', accounts: 'succeeded', usage: 'running' }
    const t0 = performance.now()
    dispatchServerMessage({
      type: 'flow_step',
      payload: { workspace: 'acme', flow_id: 12, run_id: 41, event: 'step', node_id: 'accounts', iteration: 0, attempt: 1, status: 'succeeded', at: new Date().toISOString() },
    })
    await until(() => status('accounts') === 'succeeded' && status('usage') === 'running')
    const elapsed = performance.now() - t0
    expect(elapsed).toBeLessThan(2000)
    expect(runFetches).toBe(before + 1)
  })

  it('a burst of step messages becomes one refetch, and other flows are ignored', async () => {
    await mount()
    const before = runFetches
    dispatchServerMessage({ type: 'flow_step', payload: { workspace: 'acme', flow_id: 99, run_id: 7, event: 'step', at: '' } })
    await new Promise(r => setTimeout(r, 400))
    expect(runFetches).toBe(before)
    for (let i = 0; i < 25; i++) {
      dispatchServerMessage({ type: 'flow_step', payload: { workspace: 'acme', flow_id: 12, run_id: 41, event: 'step', node_id: 'score', iteration: i, attempt: 1, status: 'succeeded', at: '' } })
    }
    await until(() => runFetches > before)
    await new Promise(r => setTimeout(r, 400))
    expect(runFetches).toBe(before + 1)
  })

  it('run_started / run_finished also refresh the workflows table (Last run); plain step events do not', async () => {
    const lifecycle = vi.fn()
    await mount(lifecycle)
    dispatchServerMessage({ type: 'flow_step', payload: { workspace: 'acme', flow_id: 12, run_id: 41, event: 'step', node_id: 'accounts', iteration: 0, attempt: 1, status: 'succeeded', at: '' } })
    await new Promise(r => setTimeout(r, 400))
    expect(lifecycle).not.toHaveBeenCalled()
    dispatchServerMessage({ type: 'flow_step', payload: { workspace: 'acme', flow_id: 12, run_id: 41, event: 'run_finished', status: 'succeeded', at: '' } })
    await until(() => lifecycle.mock.calls.length > 0)
    expect(lifecycle).toHaveBeenCalledTimes(1)
  })
})

describe('Workflows viewer v2 — side panel + version tags', () => {
  it('click-to-inspect shows the redacted server view; a token seeded into the definition never reaches the panel', async () => {
    await mount()
    ;(container.querySelector('[data-testid="rf-node-accounts"]') as HTMLButtonElement).click()
    await until(() => !!container.querySelector('[data-testid="flow-inspector-config"]'))
    const panel = container.querySelector('[data-testid="flow-node-inspector"]')!
    expect(fetchMock).toHaveBeenCalledWith('/api/flows/12/runs/41/nodes/accounts', expect.anything())
    expect(panel.textContent).toContain('[REDACTED:GITHUB_TOKEN]')
    expect(panel.textContent).toContain('"items"')
    expect(panel.textContent).not.toContain(SEEDED)
    expect(panel.textContent).not.toContain(SEEDED.slice(0, 12))
  })

  it('tags nodes changed vs the parent version and names the author in the caption', async () => {
    await mount()
    expect(container.querySelector('[data-testid="rf-node-score"]')?.getAttribute('data-change')).toBe('changed')
    expect(container.querySelector('[data-testid="rf-node-accounts"]')?.getAttribute('data-change')).toBe('')
    const caption = container.querySelector('[data-testid="flow-version-changes"]')?.textContent ?? ''
    expect(caption).toContain('v2 vs v1')
    expect(caption).toContain('repair:run-123')
    expect(caption).toContain('1 changed')
    expect(caption).toContain('1 removed (old_step)')
    // the version picker is there (2 versions)
    expect(container.querySelector('select[aria-label="Version"]')).not.toBeNull()
  })
})
