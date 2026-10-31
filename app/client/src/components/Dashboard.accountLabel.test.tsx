// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { Dashboard } from './Dashboard'

// obj 718892 — subscription account nicknames were reverting to the default
// label after a periodic poll or a recheck's refetch resolved out of order
// against a just-saved rename. These tests prove:
//   1. a rename survives a stale, slow-to-resolve poll response that started
//      before the save but resolves after it (the actual reported bug), and
//   2. a rename survives a plain remount (full page refresh).

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    flushSync(() => {})
    await Promise.resolve()
  }
}

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  },
}))

vi.mock('../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message)
    }
  },
}))

// Neither module is under test here and both fire their own fetches on mount.
vi.mock('./ModelsModule', () => ({ ModelsModule: () => null }))
vi.mock('./CostModule', () => ({ CostModule: () => null }))
vi.mock('./ConnectModal', () => ({ ConnectModal: () => null }))

function accountFixture(label: string) {
  return {
    accounts: [
      {
        id: 'b',
        label,
        homeDir: '/home/ccuser-b',
        sessionsToday: 0,
        tokensToday: 0,
        costToday: 0,
        lastRateLimit: null,
        rateLimitResetsAt: null,
        activeSessions: [],
        available: true,
        windows: {
          sessionWindow: { tokens: 0, cost: 0, resetsAt: null },
          weeklyWindow: { tokens: 0, cost: 0, resetsAt: null },
        },
      },
    ],
    queue: [],
    earliestReset: null,
    untrackedToday: { cost: 0, tokens: 0, sessions: 0 },
  }
}

describe('Dashboard — subscription account nickname persistence', () => {
  let root: Root
  let container: HTMLDivElement
  // One pending resolver per '/admin/accounts' call, in call order, so a test
  // can resolve them in whatever order it needs to simulate an out-of-order
  // network response.
  let accountsResolvers: Array<(v: ReturnType<typeof accountFixture>) => void>

  beforeEach(() => {
    vi.useFakeTimers()
    apiMock.get.mockReset()
    apiMock.put.mockReset()
    accountsResolvers = []
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/admin/accounts') {
        return new Promise(resolve => { accountsResolvers.push(resolve) })
      }
      if (url === '/admin/system') return Promise.resolve(null)
      if (url.startsWith('/admin/rate-limits')) return Promise.resolve([])
      return Promise.resolve(null)
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  function renameButtonText() {
    return container.querySelector('button[title="Rename"]')?.textContent ?? ''
  }

  it('keeps a saved rename when a stale poll response resolves after the save', async () => {
    flushSync(() => { root.render(<Dashboard />) })
    await flush()

    // Initial mount fetch (#0) resolves with the default label.
    expect(accountsResolvers).toHaveLength(1)
    accountsResolvers[0](accountFixture('Secondary'))
    await flush()
    expect(renameButtonText()).toBe('Secondary')

    // The 5s poll fires and starts fetch #1 — leave it pending, simulating a
    // slow response already in flight when the user saves a rename.
    await vi.advanceTimersByTimeAsync(5000)
    await flush()
    expect(accountsResolvers).toHaveLength(2)

    // User renames the account; the PUT resolves, and the save's own refetch
    // is fetch #2.
    apiMock.put.mockResolvedValueOnce({ ok: true, id: 'b', label: 'Ava Team' })
    const renameBtn = container.querySelector('button[title="Rename"]') as HTMLButtonElement
    flushSync(() => { renameBtn.click() })
    const input = container.querySelector('input') as HTMLInputElement
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Ava Team')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    flushSync(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    await flush()

    expect(apiMock.put).toHaveBeenCalledWith('/admin/accounts/b/label', { label: 'Ava Team' })
    expect(accountsResolvers).toHaveLength(3)
    // Resolve fetch #2 (the save's refetch) with the new name.
    accountsResolvers[2](accountFixture('Ava Team'))
    await flush()
    expect(renameButtonText()).toBe('Ava Team')

    // Now the STALE poll (#1), which started before the rename, finally
    // resolves with the pre-rename payload. It must NOT clobber the display.
    accountsResolvers[1](accountFixture('Secondary'))
    await flush()
    expect(renameButtonText()).toBe('Ava Team')
  })

  it('keeps a saved rename across a remount (full page refresh)', async () => {
    flushSync(() => { root.render(<Dashboard />) })
    await flush()
    accountsResolvers[0](accountFixture('Ava Team'))
    await flush()
    expect(renameButtonText()).toBe('Ava Team')

    // Simulate a hard refresh: unmount and remount against the same (now
    // server-persisted) data.
    flushSync(() => { root.unmount() })
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    accountsResolvers = []

    flushSync(() => { root.render(<Dashboard />) })
    await flush()
    accountsResolvers[0](accountFixture('Ava Team'))
    await flush()
    expect(renameButtonText()).toBe('Ava Team')
  })
})
