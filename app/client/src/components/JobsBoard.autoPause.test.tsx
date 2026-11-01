import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { RoutineSummary } from '../hooks/useRoutines'

/**
 * obj 64 Part B — the Jobs board surfaces auto-paused routines ("auto-paused:
 * K failures, last error …") with a one-click Resume. Mounted with createRoot
 * (no @testing-library in this client), hooks mocked so no server is needed.
 */

const resume = vi.fn(async (_id: number) => ({ ok: true }))

function routine(over: Partial<RoutineSummary>): RoutineSummary {
  return {
    id: 1,
    name: 'r',
    cron_expr: '0 * * * *',
    cadence: 'Hourly at :00',
    enabled: true,
    max_queue_depth: 1,
    last_run_at: null,
    next_run_at: null,
    created_at: '2026-10-01T00:00:00Z',
    title: 'Routine',
    workspace: 'example',
    agent_context: 'cto',
    project: null,
    category: 'general',
    pending: 0,
    strategy_objective_id: null,
    strategy_title: null,
    ...over,
  }
}

let routinesFixture: RoutineSummary[] = []

vi.mock('../hooks/useRoutines', async importOriginal => {
  const actual = await importOriginal<typeof import('../hooks/useRoutines')>()
  return {
    ...actual,
    useRoutines: () => ({
      routines: routinesFixture,
      routinesEnabled: true,
      strategies: [],
      loading: false,
      error: null,
      refresh: async () => {},
      runNow: async () => ({ ok: true }),
      createStrategyJob: async () => ({ ok: true }),
      resume,
    }),
  }
})
vi.mock('../hooks/useObjectives', () => ({
  useObjectives: () => ({
    objectives: [],
    loading: false,
    error: null,
    changeStatus: async () => {},
    connectionState: 'open',
  }),
}))
vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ labelOf: (s: string) => s, workspaces: [{ slug: 'example', name: 'Example' }] }),
}))
vi.mock('./SessionViewer', () => ({ SessionViewer: () => null }))

const { JobsBoard } = await import('./JobsBoard')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resume.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

async function mount() {
  flushSync(() => root.render(<JobsBoard workspace={'example' as never} />))
  await settle()
}

describe('JobsBoard — auto-paused routines', () => {
  it('renders the auto-pause banner with the reason and a Resume button that calls resume(id)', async () => {
    routinesFixture = [
      routine({
        id: 42,
        title: 'Hourly disk check',
        enabled: false,
        kind: 'script',
        last_run_status: 'failed',
        last_exit_code: 1,
        consecutive_failures: 5,
        auto_pause_threshold: 5,
        auto_paused_at: '2026-11-01T10:00:00Z',
        auto_pause_reason: 'auto-paused: 5 failures, last error exit 1',
      }),
      routine({ id: 7, title: 'Healthy routine' }),
    ]
    await mount()

    const banner = container.querySelector('[data-testid="auto-paused-routines"]')
    expect(banner).not.toBeNull()
    expect(banner!.textContent).toContain('Hourly disk check')
    expect(banner!.textContent).toContain('auto-paused: 5 failures, last error exit 1')
    expect(banner!.textContent).not.toContain('Healthy routine')

    const btn = container.querySelector('button[aria-label="Resume Hourly disk check"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    expect(btn.textContent).toContain('Resume')
    btn.click()
    await settle()
    expect(resume).toHaveBeenCalledWith(42)
  })

  it('renders no banner when nothing is auto-paused (a manually disabled routine is not auto-paused)', async () => {
    routinesFixture = [routine({ id: 1, title: 'Off by hand', enabled: false }), routine({ id: 2, title: 'On' })]
    await mount()
    expect(container.querySelector('[data-testid="auto-paused-routines"]')).toBeNull()
    expect(container.textContent).not.toContain('Resume')
  })
})
