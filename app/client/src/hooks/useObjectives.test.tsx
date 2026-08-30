// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useRef } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import type { Objective } from '@operationkit/shared'
import { useObjectives } from './useObjectives'

// obj 700082 — filter-lapse regression. When an optimistic changeStatus() fails,
// the error-recovery refetch MUST carry the active workspace scope. An unscoped
// GET /objectives returns every workspace for admins, bleeding other orgs' cards
// into a single-workspace board. This proves the recovery GET is scoped.

// The container ships a PRODUCTION React build (no `act`), so we settle async
// state with microtask+macrotask flushes and force commits with flushSync.
async function flush() {
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  flushSync(() => {})
  await Promise.resolve()
}

const { getMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  patchMock: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  api: {
    get: (path: string) => getMock(path),
    post: vi.fn(),
    put: vi.fn(),
    patch: (path: string, body?: unknown) => patchMock(path, body),
    del: vi.fn(),
  },
}))

// Keep the hook off any real WebSocket.
vi.mock('./useWebSocket', () => ({
  useWebSocket: () => ({
    send: vi.fn(),
    connected: false,
    state: 'disconnected' as const,
    ws: { current: null },
  }),
}))

function obj(id: number, workspace: string): Objective {
  return { id, title: `o${id}`, workspace, status: 'backlog' } as unknown as Objective
}

// Test harness: surface changeStatus so the test can invoke it.
let changeStatusRef: ((id: number, status: 'review') => Promise<unknown>) | null = null
function Harness({ workspace }: { workspace: string | string[] }) {
  const { changeStatus } = useObjectives(workspace as never)
  const ref = useRef(changeStatus)
  ref.current = changeStatus
  changeStatusRef = (id, status) => ref.current(id, status as never)
  return null
}

async function mount(workspace: string | string[]) {
  const container = document.createElement('div')
  const root = createRoot(container)
  flushSync(() => root.render(<Harness workspace={workspace} />))
  await flush()
  return root
}

beforeEach(() => {
  getMock.mockReset()
  patchMock.mockReset()
  changeStatusRef = null
})

describe('useObjectives done cards stay off the live board', () => {
  it('evicts a card from the live list when marked done', async () => {
    const working = { ...obj(7, 'example'), status: 'working' } as Objective
    getMock.mockResolvedValue([working])
    patchMock.mockResolvedValue({ ...working, status: 'done' })

    const container = document.createElement('div')
    const root = createRoot(container)
    let latest: { objectives: Objective[]; changeStatus: (id: number, status: 'done') => Promise<unknown> } | null = null
    function DoneHarness() {
      const hook = useObjectives('example')
      latest = { objectives: hook.objectives, changeStatus: hook.changeStatus as never }
      return null
    }
    flushSync(() => root.render(<DoneHarness />))
    await flush()
    expect(latest!.objectives.map(o => o.id)).toEqual([7])

    await latest!.changeStatus(7, 'done')
    await flush()
    expect(latest!.objectives.map(o => o.id)).toEqual([])
    expect(patchMock).toHaveBeenCalledWith('/objectives/7/status', { status: 'done' })
    root.unmount()
  })
})

describe('useObjectives changeStatus error recovery (obj 700082)', () => {
  it('refetches scoped to the active workspace when the status PATCH fails', async () => {
    // initial load + recovery load both resolve to a (irrelevant) list
    getMock.mockResolvedValue([obj(1, 'example2')])
    patchMock.mockRejectedValue(new Error('500'))

    await mount('example2')
    getMock.mockClear() // ignore the initial fetch; focus on the recovery fetch

    await expect(changeStatusRef!(1, 'review')).rejects.toThrow('500')
    await flush()

    // The recovery GET must be workspace-scoped, NOT a bare /objectives.
    expect(getMock).toHaveBeenCalledWith('/objectives?workspace=example2')
    expect(getMock).not.toHaveBeenCalledWith('/objectives')
  })

  it("does not append a workspace param in the 'all' view", async () => {
    getMock.mockResolvedValue([])
    patchMock.mockRejectedValue(new Error('500'))

    await mount('all')
    getMock.mockClear()

    await expect(changeStatusRef!(1, 'review')).rejects.toThrow('500')
    await flush()

    expect(getMock).toHaveBeenCalledWith('/objectives')
  })

  it('refetches with workspaces= when multiple workspaces are selected', async () => {
    getMock.mockResolvedValue([])
    patchMock.mockRejectedValue(new Error('500'))

    await mount(['example2', 'example'])
    // Initial list fetch must use the multi-select query (sorted).
    expect(getMock).toHaveBeenCalledWith('/objectives?workspaces=example,example2')
    getMock.mockClear()

    await expect(changeStatusRef!(1, 'review')).rejects.toThrow('500')
    await flush()

    expect(getMock).toHaveBeenCalledWith('/objectives?workspaces=example,example2')
    expect(getMock).not.toHaveBeenCalledWith('/objectives')
  })
})
