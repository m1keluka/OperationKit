// @vitest-environment jsdom
/**
 * Tests that the PROJECT chip row (ProjectFilterBar) renders for a non-admin
 * member of exactly one org, and does NOT render for a genuine multi-org/All
 * view (obj 708893).
 *
 * The bug: projectWorkspace was `workspaces.length === 1 ? workspaces[0] : null`
 * — null when workspaces=[] (the All / brief-init window), which made the
 * PROJECT row invisible for single-org members.
 *
 * The fix: effectiveOrg checks user.workspaces when workspaces=[] for non-admins,
 * so the row appears immediately once user is known.
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
  username: 'ava',
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
  useProjects: () => ({
    projects: [], loading: false, refresh: vi.fn(),
    createProject: vi.fn(), renameProject: vi.fn(), deleteProject: vi.fn(),
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

describe('PreviewBoard — PROJECT row visibility (obj 708893)', () => {
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

  it('PROJECT row renders for a single-org member even when workspaces=[]', async () => {
    // workspaces=[] simulates the brief window after auth resolves but before
    // the App.tsx clamp effect fires (user has one org 'example').
    mockUser = {
      id: 2, username: 'ava', role: 'member',
      workspaces: [{ workspace: 'example', role: 'member' }],
      created_at: '2026-01-01T00:00:00Z',
    }
    flushSync(() => root.render(<PreviewBoard workspaces={[]} />))
    await flush()
    expect(hasProjectBar()).toBe(true)
  })

  it('PROJECT row renders when workspaces has the one org (normal path after clamp fires)', async () => {
    mockUser = {
      id: 2, username: 'ava', role: 'member',
      workspaces: [{ workspace: 'example', role: 'member' }],
      created_at: '2026-01-01T00:00:00Z',
    }
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} />))
    await flush()
    expect(hasProjectBar()).toBe(true)
  })

  it('PROJECT row is hidden for admin in All-orgs view (workspaces=[])', async () => {
    mockUser = {
      id: 1, username: 'mike', role: 'admin',
      workspaces: [],
      created_at: '2026-01-01T00:00:00Z',
    }
    flushSync(() => root.render(<PreviewBoard workspaces={[]} />))
    await flush()
    expect(hasProjectBar()).toBe(false)
  })

  it('PROJECT row is hidden in genuine multi-org view (workspaces has 2)', async () => {
    mockUser = {
      id: 1, username: 'mike', role: 'admin',
      workspaces: [],
      created_at: '2026-01-01T00:00:00Z',
    }
    flushSync(() => root.render(
      <PreviewBoard workspaces={['example' as Workspace, 'example2' as Workspace]} />
    ))
    await flush()
    expect(hasProjectBar()).toBe(false)
  })
})
