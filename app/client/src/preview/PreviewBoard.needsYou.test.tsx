// @vitest-environment jsdom
/**
 * obj 900669 — Operator's walkthrough: "the header says two things need me, but
 * many more cards sit in the needs-you stage". The board header's "need you"
 * count and the Needs You column must be the same set, and a card an agent is
 * still running on is not in it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { Objective, User, Workspace } from '@operationkit/shared'

// Hoisted above vi.mock factories' first call (they run lazily on import).
let mockObjectives: Objective[] = []

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
  id: 1,
  username: 'operator',
  role: 'admin',
  workspaces: [],
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
    objectives: mockObjectives, loading: false, error: null, connectionState: 'connected',
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
  PreviewCard: ({ objective }: { objective: { id: number } }) => <div data-testid="card" data-id={objective.id} />,
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

function card(id: number, status: Objective['status'], session_id: string | null = null): Objective {
  return {
    id, title: `card ${id}`, status, session_id, workspace: 'example', parent_id: null,
    routine_id: null, delegate_mode: 0, has_blockers: 0, assigned_usernames: [],
    updated_at: '2026-11-12 14:00:00', created_at: '2026-11-12 14:00:00',
  } as unknown as Objective
}

describe('PreviewBoard — header need-you count vs Needs You column (obj 900669)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  const headerCount = () =>
    container.querySelector('[data-testid="board-needs-you-count"]')?.querySelector('.font-mono')?.textContent ?? null
  const columnCards = (status: string) =>
    Array.from(container.querySelectorAll(`section[data-status="${status}"] [data-testid="card"]`)).map(e => Number(e.getAttribute('data-id')))
  const columnCount = (status: string) =>
    container.querySelector(`[data-testid="column-count-${status}"]`)?.textContent ?? null

  it('header count equals the cards in Needs You; agent-occupied review cards sit in Working', async () => {
    // Live board shape on 2026-11-12: 12 cards had status=review, five of them
    // with a worker session running on them.
    mockObjectives = [
      ...[1, 2, 3, 4, 5].map(id => card(id, 'review', `cc-${id}-1794494556883`)),
      ...[6, 7, 8, 9, 10, 11, 12].map(id => card(id, 'review')),
      card(13, 'working', 'cc-13-1'),
      card(14, 'queue'),
    ]
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} />))
    await flush()

    const needsYou = columnCards('review')
    expect(needsYou.sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10, 11, 12])
    expect(headerCount()).toBe(String(needsYou.length))
    expect(columnCount('review')).toBe(String(needsYou.length))
    expect(columnCards('working').sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 13])
  })

  it('no header chip when nothing needs you', async () => {
    mockObjectives = [card(1, 'review', 'cc-1-1'), card(2, 'working', 'cc-2-1')]
    flushSync(() => root.render(<PreviewBoard workspaces={['example' as Workspace]} />))
    await flush()
    expect(container.querySelector('[data-testid="board-needs-you-count"]')).toBeNull()
    expect(columnCards('review')).toEqual([])
  })
})
