import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { RoutineSummary } from '../hooks/useRoutines'
import type { FlowRunDetailResponse, FlowRunSummary } from '../../../shared/flow/api'
import type { JobExecutionDetailResponse, JobExecutionSummary, JobExecutionsResponse } from '../../../shared/job-executions'

/**
 * obj 900676 — every recorded routine / workflow run can be opened from the Jobs
 * board into an n8n-style Executions view: the run list, and the log of the run
 * you click. Hooks are mocked; the executions API is served by a stubbed fetch.
 */

function routine(over: Partial<RoutineSummary>): RoutineSummary {
  return {
    id: 1, name: 'r', cron_expr: '3 6 * * *', cadence: 'Daily at 06:03', enabled: true, max_queue_depth: 1,
    last_run_at: null, next_run_at: null, created_at: '2026-11-01T00:00:00Z', title: 'Routine', workspace: 'acme',
    agent_context: 'general', project: null, category: 'general', pending: 0, strategy_objective_id: null,
    strategy_title: null, ...over,
  }
}

function exec(over: Partial<JobExecutionSummary>): JobExecutionSummary {
  return {
    key: 'rr-1', routine_id: 5, routine_run_id: 1, kind: 'ai', source: 'cron', status: 'succeeded',
    started_at: '2026-11-12T06:03:00Z', ended_at: '2026-11-12T06:09:30Z', duration_ms: 390_000, reason: null,
    objective_id: 300, objective_title: 'Nightly agent job', flow_id: null, flow_run_id: null, exit_code: null, cost_usd: 0.42,
    ...over,
  }
}

const ROUTINE_INFO = { id: 5, name: 'nightly', title: 'Nightly agent job', kind: 'ai' as const, cadence: 'Daily at 06:03', flow_id: null }
const AI_LIST: JobExecutionsResponse = {
  routine: ROUTINE_INFO,
  executions: [
    exec({}),
    exec({ key: 'rr-0', routine_run_id: 0, status: 'skipped', reason: 'queue depth guard: 1 in-flight objective(s) >= max_queue_depth 1', objective_id: null, started_at: '2026-11-11T06:03:00Z', ended_at: '2026-11-11T06:03:00Z', duration_ms: 0 }),
    exec({ key: 'obj-250', routine_run_id: null, source: 'unknown', objective_id: 250, started_at: '2026-11-10T06:03:00Z' }),
  ],
}
const AI_DETAIL: JobExecutionDetailResponse = {
  routine: ROUTINE_INFO,
  execution: AI_LIST.executions[0],
  log: [
    { at: '2026-11-12T06:03:00Z', level: 'info', label: 'Fired by the schedule' },
    { at: '2026-11-12T06:03:01Z', level: 'info', label: 'Card #300 filed', detail: 'Nightly agent job' },
    { at: '2026-11-12T06:08:00Z', level: 'success', label: 'Report sent' },
    { at: '2026-11-12T06:09:30Z', level: 'success', label: 'Finished: succeeded' },
  ],
  output: null, output_truncated: false, command: null,
  objective: { id: 300, title: 'Nightly agent job', status: 'done', job_disposition: null, job_review_note: null, last_session_summary: 'ok', total_cost_usd: 0.42 },
}

const SCRIPT_INFO = { id: 6, name: 'disk', title: 'Disk check', kind: 'script' as const, cadence: 'Hourly at :03', flow_id: null }
const SCRIPT_EXEC = exec({ key: 'rr-7', routine_id: 6, routine_run_id: 7, kind: 'script', status: 'alert', exit_code: 0, objective_id: null, duration_ms: 1200, reason: 'alert line: ALERT: disk 91%' })
const SCRIPT_DETAIL: JobExecutionDetailResponse = {
  routine: SCRIPT_INFO, execution: SCRIPT_EXEC,
  log: [{ at: SCRIPT_EXEC.started_at, level: 'info', label: 'Fired by the schedule' }, { at: SCRIPT_EXEC.ended_at, level: 'warn', label: 'Script exited with code 0' }],
  output: 'checked 12 hosts\nALERT: disk 91%\n', output_truncated: false, command: 'check-disk.sh', objective: null,
}

function flowRun(over: Partial<FlowRunSummary>): FlowRunSummary {
  return {
    id: 9, flow_id: 12, flow_slug: 'triage', flow_name: 'Daily booking triage', workspace: 'acme', version: 3, mode: 'live',
    status: 'failed', goal_met: null, spent_usd: 0.01, trigger_source: 'schedule', objective_id: null,
    created_at: '2026-11-12T06:03:00Z', started_at: '2026-11-12T06:03:01Z', ended_at: '2026-11-12T06:03:05Z',
    error: { type: 'check_failed', title: 'check "upsert" failed', node_id: 'upsert' }, goal: null, self_test_id: null, ...over,
  }
}
const FLOW_RUN_DETAIL: FlowRunDetailResponse = {
  run: flowRun({}),
  steps: [
    { node_id: 'fetch', iteration: 0, attempt: 1, status: 'succeeded', effect: 'read', error: null, cost_usd: 0, started_at: '2026-11-12T06:03:01Z', ended_at: '2026-11-12T06:03:02Z', output_preview: '{"rows":3}', simulated: null, input_preview: '{"since":"yesterday"}' },
    { node_id: 'upsert', iteration: 0, attempt: 1, status: 'failed', effect: 'write', error: { type: 'check_failed', title: 'row 2 rejected' }, cost_usd: 0, started_at: '2026-11-12T06:03:02Z', ended_at: '2026-11-12T06:03:05Z', output_preview: null, simulated: null, input_preview: null },
  ],
  node_status: {}, mermaid: '', waits: [],
}

let routinesFixture: RoutineSummary[] = []
vi.mock('../hooks/useRoutines', async importOriginal => {
  const actual = await importOriginal<typeof import('../hooks/useRoutines')>()
  return {
    ...actual,
    useRoutines: () => ({
      routines: routinesFixture, routinesEnabled: true, strategies: [], loading: false, error: null,
      refresh: async () => {}, runNow: async () => ({ ok: true }), createStrategyJob: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
    }),
  }
})
vi.mock('../hooks/useObjectives', () => ({
  useObjectives: () => ({
    objectives: [{ id: 300, title: 'Nightly agent job', status: 'done', routine_id: 5, workspace: 'acme', created_at: '2026-11-12T06:03:01Z' }],
    loading: false, error: null, changeStatus: async () => {}, connectionState: 'open',
  }),
}))
vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ labelOf: (s: string) => s, workspaces: [{ slug: 'acme', name: 'Acme' }] }),
}))
const sessionOpened = vi.fn()
vi.mock('./SessionViewer', () => ({ SessionViewer: ({ objective }: { objective: { id: number } }) => { sessionOpened(objective.id); return null } }))
vi.mock('./jobs/HostCronJobs', () => ({ HostCronJobs: () => null }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, username: 'operator', role: 'admin' } }) }))
vi.mock('./settings/QueueAutostartPanel', () => ({ QueueAutostartPanel: () => null }))
vi.mock('../hooks/useFlows', () => ({
  useFlows: () => ({ flows: [], runs: [flowRun({})], flowsEnabled: true, loading: false, error: null, refresh: async () => {}, runNow: async () => ({ ok: true }) }),
  useFlowDetail: () => ({ detail: null, error: null, loading: false, reload: async () => {} }),
  fetchFlowRun: async (flowId: number, runId: number) => {
    if (flowId !== 12 || runId !== 9) throw new Error('unexpected run')
    return FLOW_RUN_DETAIL
  },
}))

const { JobsBoard } = await import('./JobsBoard')
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

const ROUTES: Record<string, unknown> = {
  '/api/admin/routines/5/executions?limit=200': AI_LIST,
  '/api/admin/routines/5/executions/rr-1': AI_DETAIL,
  '/api/admin/routines/5/executions/rr-0': { ...AI_DETAIL, execution: AI_LIST.executions[1], log: [{ at: null, level: 'warn', label: 'Skipped — nothing ran' }], objective: null },
  '/api/admin/routines/6/executions?limit=200': { routine: SCRIPT_INFO, executions: [SCRIPT_EXEC] },
  '/api/admin/routines/6/executions/rr-7': SCRIPT_DETAIL,
  '/api/flows/12/runs?limit=200': { runs: [flowRun({}), flowRun({ id: 8, status: 'succeeded', error: null, created_at: '2026-11-11T06:03:00Z' })] },
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
}
const panel = () => document.body.querySelector('[aria-labelledby="executions-title"]') as HTMLElement | null
const buttons = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll('button:not([role="tab"])')).filter(b => b.textContent?.trim() === text) as HTMLButtonElement[]

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  sessionOpened.mockClear()
  // The lanes live on the Runs tab since obj 900675 (bare /jobs opens the flow charts).
  window.history.replaceState(null, '', '/jobs?view=runs')
  routinesFixture = [routine({ id: 5, title: 'Nightly agent job', kind: 'ai' }), routine({ id: 6, title: 'Disk check', kind: 'script' })]
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url in ROUTES) return new Response(JSON.stringify(ROUTES[url]), { status: 200 })
    return new Response('{"error":"not found"}', { status: 404 })
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function mount() {
  flushSync(() => root.render(<JobsBoard workspace={'acme' as never} />))
  await settle()
}

describe('JobsBoard — per-run executions (obj 900676)', () => {
  it('a routine’s Runs button lists every recorded run; clicking one opens its log', async () => {
    await mount()
    buttons(container, 'Runs')[0].click()
    await settle()
    const p = panel()
    expect(p, 'executions panel').not.toBeNull()
    expect(p!.textContent).toContain('Nightly agent job')
    // All three runs are listed: this morning's, yesterday's skipped fire, and a pre-history card.
    expect(p!.querySelector('[data-testid="execution-rr-1"]')).not.toBeNull()
    expect(p!.querySelector('[data-testid="execution-rr-0"]')).not.toBeNull()
    expect(p!.querySelector('[data-testid="execution-obj-250"]')).not.toBeNull()
    // Newest is opened by default: its log says what happened.
    const log = p!.querySelector('[data-testid="execution-log"]')
    expect(log?.textContent).toContain('Card #300 filed')
    expect(log?.textContent).toContain('Report sent')
    expect(log?.textContent).toContain('Finished: succeeded')

    // Click the skipped run → its log and the reason it did not run.
    ;(p!.querySelector('[data-testid="execution-rr-0"]') as HTMLButtonElement).click()
    await settle()
    expect(panel()!.querySelector('[data-testid="execution-detail"]')?.textContent).toContain('queue depth guard')
    expect(panel()!.querySelector('[data-testid="execution-log"]')?.textContent).toContain('Skipped — nothing ran')
  })

  it('clicking a completed job opens the executions view focused on THAT run, with a link to its session', async () => {
    await mount()
    const jobRow = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('#300')) as HTMLElement
    expect(jobRow, 'job lane row').toBeTruthy()
    buttons(jobRow, 'Log')[0].click()
    await settle()
    const p = panel()!
    expect(p.querySelector('[data-testid="execution-rr-1"]')?.getAttribute('class')).toContain('bg-surface-selected')
    const open = buttons(p, 'Open session #300')[0]
    expect(open).toBeTruthy()
    open.click()
    await settle()
    expect(sessionOpened).toHaveBeenCalledWith(300)
  })

  it('a script run shows its command and captured output', async () => {
    await mount()
    buttons(container, 'Runs')[1].click()
    await settle()
    const p = panel()!
    expect(p.textContent).toContain('check-disk.sh')
    expect(p.querySelector('[data-testid="execution-output"]')?.textContent).toBe('checked 12 hosts\nALERT: disk 91%\n')
    expect(p.querySelector('[data-testid="execution-log"]')?.textContent).toContain('Script exited with code 0')
  })

  it('clicking a workflow run opens its step log (n8n-style node list), the failed node expanded', async () => {
    await mount()
    const flowRow = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('run #9')) as HTMLElement
    expect(flowRow, 'workflow run row').toBeTruthy()
    flowRow.click()
    await settle()
    const p = panel()!
    expect(p.textContent).toContain('Daily booking triage')
    expect(p.querySelector('[data-testid="execution-flow-9"]')).not.toBeNull()
    expect(p.querySelector('[data-testid="execution-flow-8"]')).not.toBeNull()
    const steps = p.querySelector('[data-testid="execution-steps"]')
    expect(steps?.textContent).toContain('fetch')
    expect(steps?.textContent).toContain('upsert')
    expect(steps?.textContent).toContain('row 2 rejected') // failed step opens by default
    expect(p.textContent).toContain('check "upsert" failed')
  })
})
