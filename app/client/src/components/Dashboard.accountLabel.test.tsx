// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { Dashboard } from './Dashboard'

// obj 718892 — subscription account nicknames were reverting to the default
// label after a periodic poll resolved out of order against a just-saved
// rename. Since obj 720368 the Dashboard panel is the shared seat list
// (SeatPool, polling /admin/seats), so the same guarantees are proven there:
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

function seatFixture(label: string) {
  return {
    id: 'b',
    label,
    kind: 'claude',
    priority: 0,
    enabled: true,
    health: 'healthy',
    available: true,
    cooldownUntil: null,
    consecutiveFailures: 0,
    credential: { kind: 'setup_token', last4: 'ab12', addedAt: null, expiresAt: null, expiry: null, usable: true, needsClaudeSignIn: false },
    sessions: { active: 0, today: 0 },
    usageToday: { tokens: 0, cost: 0 },
  }
}
const seatsFixture = (label: string) => ({ seats: [seatFixture(label)] })

describe('Dashboard — subscription seat nickname persistence', () => {
  let root: Root
  let container: HTMLDivElement
  // One pending resolver per '/admin/seats' call, in call order, so a test can
  // resolve them in whatever order it needs to simulate an out-of-order
  // network response.
  let seatsResolvers: Array<(v: ReturnType<typeof seatsFixture>) => void>

  beforeEach(() => {
    vi.useFakeTimers()
    apiMock.get.mockReset()
    apiMock.patch.mockReset()
    seatsResolvers = []
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/admin/seats') {
        return new Promise(resolve => { seatsResolvers.push(resolve) })
      }
      if (url === '/admin/accounts') return Promise.resolve({ accounts: [], queue: [], earliestReset: null })
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

  const render = () => flushSync(() => { root.render(<MemoryRouter><Dashboard /></MemoryRouter>) })
  const seatName = () => container.querySelector('[data-testid="seat-b"] h4')?.textContent ?? ''

  it('keeps a saved rename when a stale poll response resolves after the save', async () => {
    render()
    await flush()

    // Initial mount fetch (#0) resolves with the default label.
    expect(seatsResolvers).toHaveLength(1)
    seatsResolvers[0](seatsFixture('Secondary'))
    await flush()
    expect(seatName()).toBe('Secondary')

    // The poll fires and starts fetch #1 — leave it pending, simulating a slow
    // response already in flight when the user saves a rename.
    await vi.advanceTimersByTimeAsync(15_000)
    await flush()
    expect(seatsResolvers).toHaveLength(2)

    // User renames the seat; the PATCH resolves with the saved seat.
    apiMock.patch.mockResolvedValueOnce({ ok: true, seat: seatFixture('Ava Team') })
    const renameBtn = Array.from(container.querySelectorAll('[data-testid="seat-b"] button')).find(b => b.textContent?.trim() === 'Rename') as HTMLButtonElement
    flushSync(() => { renameBtn.click() })
    const input = container.querySelector('#seat-label-b') as HTMLInputElement
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Ava Team')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    flushSync(() => { (input.closest('form') as HTMLFormElement).requestSubmit() })
    await flush()

    expect(apiMock.patch).toHaveBeenCalledWith('/admin/seats/b', { label: 'Ava Team' })
    expect(seatName()).toBe('Ava Team')

    // Now the STALE poll (#1), which started before the rename, finally
    // resolves with the pre-rename payload. It must NOT clobber the display.
    seatsResolvers[1](seatsFixture('Secondary'))
    await flush()
    expect(seatName()).toBe('Ava Team')
  })

  it('keeps a saved rename across a remount (full page refresh)', async () => {
    render()
    await flush()
    seatsResolvers[0](seatsFixture('Ava Team'))
    await flush()
    expect(seatName()).toBe('Ava Team')

    // Simulate a hard refresh: unmount and remount against the same (now
    // server-persisted) data.
    flushSync(() => { root.unmount() })
    container.remove()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    seatsResolvers = []

    render()
    await flush()
    seatsResolvers[0](seatsFixture('Ava Team'))
    await flush()
    expect(seatName()).toBe('Ava Team')
  })
})
