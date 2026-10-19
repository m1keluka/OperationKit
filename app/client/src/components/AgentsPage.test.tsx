import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { AGENTS_FIXTURE, AGENTS_FIXTURE_ALL, fixtureLoadFile } from './AgentsPage.fixture'
import { AgentsPage } from './AgentsPage'

/**
 * Agents tab (obj 712126). Mounted with the createRoot + act idiom used by
 * SettingsPage.test.tsx — @testing-library is not a dependency of this client.
 *
 * Everything here runs against the typed fixture in AgentsPage.fixture.ts, so
 * these tests pass with no server (W6 / obj 712124 owns the API).
 */

// useProjects hits /api/projects; the scope selector only needs the rows.
vi.mock('../hooks/useProjects', () => ({
  useProjects: () => ({
    projects: [
      { id: 16, name: 'Acquisition Sites' },
      { id: 14, name: 'Platform' },
    ],
    loading: false,
    error: null,
    refresh: async () => {},
  }),
}))

const boardLayerCalls: Array<{ workspace: string; projectId: number | null }> = []

vi.mock('../lib/board-layer', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/board-layer')>()
  return {
    ...actual,
    fetchBoardLayer: (workspace: string, projectId: number | null) => {
      boardLayerCalls.push({ workspace, projectId })
      return Promise.resolve(projectId === null ? AGENTS_FIXTURE_ALL : AGENTS_FIXTURE)
    },
  }
})

// We drive React ourselves rather than through @testing-library (not a
// dependency here) — same choice as ui/Modal.test.tsx. Tell React we are
// deliberately outside an act() environment so it does not warn.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

/** Lets React's scheduler and any resolved data promises settle. */
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
}

let container: HTMLElement
let root: Root

beforeEach(() => {
  boardLayerCalls.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => { root.unmount() })
  container.remove()
})

/** Mounts the tab at `url` and flushes the pending data promises. */
async function mount(url: string, props: Partial<Parameters<typeof AgentsPage>[0]> = {}) {
  flushSync(() => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route
            path="/agents"
            element={<AgentsPage workspace="example" loadFile={fixtureLoadFile} {...props} />}
          />
        </Routes>
      </MemoryRouter>,
    )
  })
  await settle()
}

function buttonWithText(text: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll('button'))
    .find(b => (b.textContent ?? '').includes(text))
  if (!match) throw new Error(`no button containing "${text}"`)
  return match as HTMLButtonElement
}

describe('AgentsPage — project scoping', () => {
  it('reads the scope from the URL and fetches that project', async () => {
    await mount('/agents?project=16')
    expect(boardLayerCalls).toEqual([{ workspace: 'example', projectId: 16 }])
    // Scoped payload: the workspace-wide CMO agent is NOT in this scope.
    expect(container.textContent).toContain('Acquisition Sites')
    expect(container.textContent).not.toContain('CMO')
  })

  it('defaults to the all-of-workspace scope when the URL carries no project', async () => {
    await mount('/agents')
    expect(boardLayerCalls).toEqual([{ workspace: 'example', projectId: null }])
    expect(container.textContent).toContain('CMO')
  })

  it('changing scope refetches and encodes the new scope in the URL', async () => {
    await mount('/agents')
    expect(boardLayerCalls).toEqual([{ workspace: 'example', projectId: null }])

    const select = container.querySelector('select[aria-label="Project scope"]') as HTMLSelectElement
    expect(select).toBeTruthy()
    expect(select.value).toBe('all')

    select.value = '16'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()

    // Refetched for the new scope…
    expect(boardLayerCalls).toEqual([
      { workspace: 'example', projectId: null },
      { workspace: 'example', projectId: 16 },
    ])
    // …and the scope is in the URL, so a reload lands back here.
    expect(select.value).toBe('16')
    expect(container.textContent).not.toContain('CMO')
  })

  it('renders the objective count per agent so you can see who does the work', async () => {
    await mount('/agents?project=16')
    expect(container.textContent).toContain('129 objectives')
  })
})

describe('AgentsPage — missing files and orphan edges are visibly flagged', () => {
  it('renders a defect marker for every exists:false node', async () => {
    await mount('/agents?project=16')
    const markers = container.querySelectorAll('[data-testid="missing-marker"]')
    // legacy-scout persona, the acq-brand-kit skill, the acq-deploy tool.
    expect(markers.length).toBeGreaterThanOrEqual(3)
    expect(container.textContent).toContain('file missing')
  })

  it('surfaces the orphans block in a banner rather than hiding it', async () => {
    await mount('/agents?project=16')
    const text = container.textContent ?? ''
    expect(text).toContain('declared files missing')
    expect(text).toContain('legacy-scout')     // agents_without_persona
    expect(text).toContain('acq-brand-kit')    // skills_declared_missing
    expect(text).toContain('acq-deploy')       // tools_declared_missing
  })

  it('still renders the dangling skill node itself, with its declared path', async () => {
    await mount('/agents?project=16')
    expect(container.textContent).toContain('/home/operator/ai-workspace/skills/acq-brand-kit/SKILL.md')
  })

  it('opening a missing node explains the defect instead of showing blank markdown', async () => {
    await mount('/agents?project=16')
    buttonWithText('acq-deploy').click()
    await settle()
    expect(container.textContent).toContain('File missing on disk')
  })
})

describe('AgentsPage — markdown opens in place', () => {
  it('renders an agent persona file and its resolved path on click', async () => {
    await mount('/agents?project=16')
    buttonWithText('acq-sites persona').click()
    await settle()

    const path = container.querySelector('[data-testid="viewer-path"]')
    expect(path?.textContent).toBe('/home/operator/ai-workspace/agents/acq-sites.md')
    expect(container.textContent).toContain('You own the acquisition microsite estate.')
  })

  it('exposes the workspace overlay as its own reachable file', async () => {
    await mount('/agents?project=16')
    buttonWithText('acq-sites workspace overlay').click()
    await settle()

    const path = container.querySelector('[data-testid="viewer-path"]')
    expect(path?.textContent).toBe('/home/operator/ai-workspace/workspaces/example/agent-profiles/acq-sites.md')
    expect(container.textContent).toContain('Brand rules, repo setup, deploy target.')
  })

  it('renders a skill file and then a tool file in the same panel', async () => {
    await mount('/agents?project=16')

    buttonWithText('acq-site-builder').click()
    await settle()
    expect(container.textContent).toContain('Scaffold, build, ship.')

    buttonWithText('acq-lighthouse').click()
    await settle()
    expect(container.querySelector('[data-testid="viewer-path"]')?.textContent)
      .toBe('/home/operator/ai-workspace/tools/acq-lighthouse.md')
    expect(container.textContent).toContain('Runs a Lighthouse audit.')
  })

  it('shows the pick-a-node empty state before anything is selected', async () => {
    await mount('/agents?project=16')
    expect(container.textContent).toContain('Pick a node')
  })
})

describe('AgentsPage — multi-workspace ("all") scope', () => {
  // Regression, obj 712134: the layer graph is per-workspace, so useBoardLayer
  // does not fetch for 'all' — it leaves data/error/loading all falsy. Before
  // this guard every render branch was false and the LIVE tab rendered a
  // completely blank page under the toolbar: no spinner, no error, no reason.
  it('explains that a single workspace must be picked instead of rendering blank', async () => {
    await mount('/agents?project=16', { workspace: 'all' })
    expect(boardLayerCalls).toEqual([])
    expect(container.textContent).toContain('Pick a single workspace')
  })

  it('does not render the layer list or the pick-a-node viewer in the all scope', async () => {
    await mount('/agents', { workspace: 'all' })
    expect(container.textContent).not.toContain('Pick a node')
    expect(container.querySelectorAll('[data-testid="missing-marker"]').length).toBe(0)
  })
})

describe('AgentsPage — fixture harness prop', () => {
  it('renders from a passed fixture without touching the API', async () => {
    await mount('/agents?project=16', { fixture: AGENTS_FIXTURE })
    expect(boardLayerCalls).toEqual([])
    expect(container.textContent).toContain('Acquisition Sites')
  })
})
