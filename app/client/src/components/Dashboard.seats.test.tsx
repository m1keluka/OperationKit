// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { Dashboard } from './Dashboard'

// obj 720368 — the Dashboard's subscription panel is the SAME seat list as
// Settings → Seats (one place to manage seats), not the old accounts flow:
// seats come from /admin/seats, every card names its engine, a "Manage seats"
// link goes to Settings → Seats, and the old "New account" / CLI-login Connect
// (which created Claude seats that sandboxed sessions cannot use) is gone.

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}))

vi.mock('../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message)
    }
  },
}))
vi.mock('./ModelsModule', () => ({ ModelsModule: () => null }))
vi.mock('./CostModule', () => ({ CostModule: () => null }))

const cred = (over: Record<string, unknown> = {}) => ({ kind: 'cli_login', last4: null, addedAt: null, expiresAt: null, expiry: null, usable: true, needsClaudeSignIn: false, ...over })
const seat = (id: string, kind: string, label: string, over: Record<string, unknown> = {}) => ({
  id, label, kind, priority: 0, enabled: true, health: 'healthy', available: true, cooldownUntil: null, consecutiveFailures: 0,
  credential: cred(), sessions: { active: 0, today: 0 }, usageToday: { tokens: 0, cost: 0 }, ...over,
})

describe('Dashboard — subscription seats panel', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/admin/seats') {
        return Promise.resolve({ seats: [
          seat('s1', 'claude', 'Mike@ biz', { available: false, credential: cred({ usable: false, needsClaudeSignIn: true }) }),
          seat('codex', 'codex', 'Codex'),
          seat('grok', 'grok', 'Grok'),
        ] })
      }
      if (url === '/admin/accounts') return Promise.resolve({ accounts: [], queue: [], earliestReset: null })
      return Promise.resolve(null)
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('shows the Settings → Seats list with engine labels and a Manage seats link', async () => {
    flushSync(() => root.render(<MemoryRouter><Dashboard /></MemoryRouter>))
    await flush()
    expect(apiMock.get).toHaveBeenCalledWith('/admin/seats')
    const panel = container.querySelector('section[aria-labelledby="dashboard-seats"]') as HTMLElement
    expect(panel.textContent).toContain('Subscription seats')
    const manage = Array.from(panel.querySelectorAll('a')).find(a => a.textContent === 'Manage seats') as HTMLAnchorElement
    expect(manage.getAttribute('href')).toBe('/settings/seats')
    for (const [id, engine] of [['s1', 'Claude'], ['codex', 'Codex'], ['grok', 'Grok']]) {
      expect(panel.querySelector(`[data-testid="seat-${id}"] span.uppercase`)?.textContent).toBe(engine)
    }
    // The broken CLI-login Claude seat offers the link flow, not a dead Connect.
    expect(panel.textContent).toContain('Reconnect with Sign in with Claude')
    // Same actions as Settings → Seats: Remove on every card; Add for every engine.
    const buttons = Array.from(panel.querySelectorAll('button')).map(b => b.textContent?.trim())
    expect(buttons.filter(t => t === 'Remove')).toHaveLength(3)
    for (const e of ['Claude', 'Codex', 'Grok']) expect(buttons).toContain(`Add ${e} seat`)
    // The old accounts flow is gone.
    expect(buttons).not.toContain('New account')
    expect(buttons).not.toContain('Connect')
    expect(apiMock.post).not.toHaveBeenCalledWith('/admin/accounts', expect.anything())
  })
})
