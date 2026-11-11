// @vitest-environment jsdom
/**
 * The board's two filter rows: ORG (WorkspaceFilterBar) and PROJECT
 * (ProjectFilterBar).
 *
 * obj 708893 — the PROJECT row has to render for a non-admin member of exactly
 * one org even while `workspaces` is still `[]` (the window after auth resolves
 * but before App.tsx's clamp effect fires). `effectiveOrg` covers that.
 *
 * obj 900197 — the PROJECT row must ALSO render in the All / multi-org view,
 * which is where this file previously asserted the opposite. Hiding it there
 * was the reported bug: the default admin board spans every org, so the filter
 * was absent almost all the time. It now renders with org-prefixed chips. The
 * ORG row is new and renders unconditionally.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { User, Workspace } from '@operationkit/shared'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

// ── Mocks ────────────────────────────────────────────────────────────────────

// Control which user is returned from useAuth.
let mockUser: User = {
  id: 2,
  username: 'casey',
  role: 'member',
  workspaces: [{ workspace: 'example', role: 'member' }],
  created_at: '2026-01-01T00:00:00Z',
}

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, loading: false }),
}))

vi.mock('../context/nav', () => ({
  useNavigate: () => vi.fn(),
  NavContext: { Provider: ({ children }: { children: React.ReactNode }) => children },
}))

vi.mock('../hooks/useObjectives', () => ({
  useObjectives: () => ({
    objectives: [], loading: false, error: null, connectionState: 'connected',
    changeStatus: vi.fn(), createObjective: vi.fn(), updateObjective: vi.fn(),
    deleteObjective: vi.fn(), doneObjectives: [], doneLoading: false,
    doneLoaded: true, doneHasMore: false, loadMoreDone: vi.fn(),
  }),
}))

vi.mock('../hooks/useProjects', () => ({
  ALL_ORGS: '*',
  useProjects: () => ({
    projects: [], loading: false, refresh: vi.fn(),
    createProject: vi.fn(), renameProject: vi.fn(), deleteProject: vi.fn(),
  }),
}))

vi.mock('../hooks/useWorkspaces', () => ({
  invalidateWorkspacesCache: vi.fn(),
  useWorkspaces: () => ({
    workspaces: [
      { slug: 'example', name: 'Example', short_label: 'Example' },
      { slug: 'example2', name: 'Example3', short_label: 'GF' },
    ],
    slugs: ['example', 'example2'],
    loading: false,
    refresh: vi.fn(),
    labelOf: (s: string) => s,
    shortOf: (s: string) => s,
    badgeOf: () => null,
    agentPoolOf: () => [],
  }),
}))

vi.mock('../hooks/useSlashSearch', () => ({
  useSlashSearch: () => [false, vi.fn()] as [boolean, (v: boolean) => void],
}))

vi.mock('../hooks/useMediaQuery', () => ({
  useIsBoardMobile: () => false,
}))

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(() => Promise.resolve([])), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}))

vi.mock('../components/SessionViewer', () => ({
  SessionViewer: () => null,
}))

vi.mock('../components/ObjectiveModal', () => ({
  ObjectiveModal: () => null,
}))

vi.mock('../components/ObjectiveSearchPanel', () => ({
  ObjectiveSearchPanel: () => null,
}))

vi.mock('./PreviewCard', () => ({
  PreviewCard: () => null,
}))

vi.mock('../components/design/primitives', () => ({
  STATUS_META: {
    planning:  { label: 'Plan',      tw: '', tone: '' },
    queue:     { label: 'Queue',     tw: '', tone: '' },
    working:   { label: 'Working',   tw: '', tone: '' },
    ai_review: { label: 'AI Rev',    tw: '', tone: '' },
    review:    { label: 'Needs You', tw: '', tone: '' },
    done:      { label: 'Done',      tw: '', tone: '' },
    cancelled: { label: 'Retired',   tw: '', tone: '' },
  },
  StatusDot: () => null,
  AgentMonogram: () => null,
}))

vi.mock('../components/ui', () => ({
  useConfirm: () => ({ confirm: () => Promise.resolve(true), confirmDialog: null }),
}))

import { PreviewBoard } from './PreviewBoard'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PreviewBoard — filter row visibility (obj 708893, obj 900197)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  function hasProjectBar(): boolean {
    return !!container.querySelector('[data-testid="project-filter-bar"]')
  }

  function hasOrgBar(): boolean {
    return !!container.querySelector('[data-testid="workspace-filter-bar"]')
  }

  it('PROJECT row renders for a single-org member even when workspaces=[]', async () => {
    // workspaces=[] simulates the brief window after auth resolves but before
    // the App.tsx clamp effect fires (user has one org 'example').
    mockUser = {
      id: 2, username: 'casey', role: 'member',
      workspaces: [{ workspace: 'example', role: 'member' }],
      created_at: '2026-01-01T00:00:00Z',
    }
    flushSync(() => root.render(<PreviewBoard workspaces={[]} />))
    await flush()
    expect(hasProjectBar()).toBe(true)
  })

  it('PROJECT row renders when workspaces has the one org (normal path after clamp fires)', async () => {
    mockUser = {
      id: 2, username: 'casey', role: 'member',
      workspaces: [{ workspace: 'example', role: 'member' }],
      created_at: '2026-01-01T00:00:00Z',
    }
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} />))
    await flush()
    expect(hasProjectBar()).toBe(true)
  })

  // obj 900197: this is the reported bug. The admin's default board is the
  // All-orgs view, and the project filter used to be omitted there entirely.
  it('PROJECT row ALSO renders for admin in the All-orgs view (workspaces=[])', async () => {
    mockUser = {
      id: 1, username: 'operator', role: 'admin',
      workspaces: [],
      created_at: '2026-01-01T00:00:00Z',
    }
    flushSync(() => root.render(<PreviewBoard workspaces={[]} />))
    await flush()
    expect(hasProjectBar()).toBe(true)
  })

  it('PROJECT row renders in a genuine multi-org view (workspaces has 2)', async () => {
    mockUser = {
      id: 1, username: 'operator', role: 'admin',
      workspaces: [],
      created_at: '2026-01-01T00:00:00Z',
    }
    flushSync(() => root.render(
      <PreviewBoard workspaces={['example' as Workspace, 'example2' as Workspace]} />
    ))
    await flush()
    expect(hasProjectBar()).toBe(true)
  })

  it('ORG row renders on the board in every view', async () => {
    mockUser = {
      id: 1, username: 'operator', role: 'admin',
      workspaces: [],
      created_at: '2026-01-01T00:00:00Z',
    }
    flushSync(() => root.render(<PreviewBoard workspaces={[]} onWorkspacesChange={vi.fn()} />))
    await flush()
    expect(hasOrgBar()).toBe(true)
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} onWorkspacesChange={vi.fn()} />))
    await flush()
    expect(hasOrgBar()).toBe(true)
  })

  it('an admin can pick an org straight from the board row', async () => {
    mockUser = {
      id: 1, username: 'operator', role: 'admin',
      workspaces: [],
      created_at: '2026-01-01T00:00:00Z',
    }
    const onWorkspacesChange = vi.fn()
    flushSync(() => root.render(
      <PreviewBoard workspaces={[]} onWorkspacesChange={onWorkspacesChange} />
    ))
    await flush()
    const chip = container.querySelector('[data-workspace="example2"]')
    expect(chip).toBeTruthy()
    flushSync(() => chip?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(onWorkspacesChange).toHaveBeenCalledWith(['example2'])
  })

  it('a member only sees the orgs they belong to in the ORG row', async () => {
    mockUser = {
      id: 2, username: 'casey', role: 'member',
      workspaces: [{ workspace: 'example', role: 'member' }],
      created_at: '2026-01-01T00:00:00Z',
    }
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} onWorkspacesChange={vi.fn()} />))
    await flush()
    expect(container.querySelector('[data-workspace="example"]')).toBeTruthy()
    expect(container.querySelector('[data-workspace="example2"]')).toBeNull()
  })
})
