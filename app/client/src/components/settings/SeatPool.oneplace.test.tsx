// @vitest-environment jsdom
//
// One place to manage seats (obj 720368): the shared SeatPool list that both
// Settings → Seats and the Dashboard render. Engine label on every card, an
// Add button for every engine (Codex included), Remove for every engine, the
// "Reconnect with Sign in with Claude" path for a CLI-login Claude seat, and
// visible feedback from every Connect / Reconnect click. Fake data only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { SeatPool, seatBadge, type SeatSummary } from './SettingsSeats'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

function seat(over: Partial<SeatSummary> = {}): SeatSummary {
  return {
    id: 'seat-1',
    label: 'Seat 1',
    kind: 'claude',
    priority: 1,
    enabled: true,
    health: 'healthy',
    available: true,
    cooldownUntil: null,
    consecutiveFailures: 0,
    credential: { kind: 'setup_token', last4: 'ab12', addedAt: '2026-01-02T00:00:00Z', expiresAt: '2027-01-02T00:00:00Z', expiry: null },
    sessions: { active: 2, today: 7 },
    usageToday: { tokens: 12500, cost: 1.5 },
    ...over,
  }
}

const { store, apiMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message)
    }
  }
  const store = { seats: [] as unknown[] }
  const apiMock = {
    get: vi.fn((url: string) => {
      if (url === '/admin/seats') return Promise.resolve({ seats: structuredClone(store.seats), kinds: ['claude', 'codex', 'grok'] })
      if (url.startsWith('/admin/seats/failover/')) return Promise.resolve({ workspace: 'main', enabled: false, order: ['claude', 'codex', 'grok'] })
      return Promise.resolve(null)
    }),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  }
  return { store, apiMock, ApiErrorMock }
})

vi.mock('../../lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }))
vi.mock('../../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ slugs: ['main'], labelOf: (s: string) => s.toUpperCase() }),
}))
vi.mock('../../components/ui', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../components/ui')
  return { ...actual, useConfirm: () => ({ confirm: vi.fn(async () => true), confirmDialog: null }) }
})

const setValue = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

const CLI_CLAUDE = { kind: 'cli_login' as const, last4: null, addedAt: null, expiresAt: null, expiry: null, usable: false, needsClaudeSignIn: true }
const LINK = { ok: true, loginId: 'login-1', url: 'https://claude.com/cai/oauth/authorize?code=true&state=st8', expiresAt: '2026-11-01T12:10:00Z' }

describe('SeatPool (shared by Settings → Seats and the Dashboard)', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    for (const fn of [apiMock.post, apiMock.put, apiMock.patch, apiMock.del]) fn.mockReset()
    store.seats = [
      seat({ id: 's1', label: 'Mike@ biz', credential: CLI_CLAUDE, available: false }),
      seat({ id: 'codex', label: 'Codex', kind: 'codex', credential: { kind: 'cli_login', last4: null, addedAt: null, expiresAt: null, expiry: null, usable: true, needsClaudeSignIn: false } }),
      seat({ id: 'grok', label: 'Grok', kind: 'grok', credential: { kind: 'cli_login', last4: null, addedAt: null, expiresAt: null, expiry: null, usable: true, needsClaudeSignIn: false } }),
    ]
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  async function render() {
    flushSync(() => root.render(<SeatPool />))
    await flush()
  }
  const button = (text: string, scope: ParentNode = container) =>
    Array.from(scope.querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined
  const card = (id: string) => container.querySelector(`[data-testid="seat-${id}"]`) as HTMLElement
  const section = (kind: string) => container.querySelector(`section[aria-labelledby="seats-${kind}"]`) as HTMLElement

  it('every card names its engine', async () => {
    await render()
    expect(card('s1').textContent).toContain('Claude')
    expect(card('s1').textContent).toContain('Mike@ biz')
    expect(card('codex').textContent).toContain('Codex')
    expect(card('grok').textContent).toContain('Grok')
    // The engine chip is the first badge on the title row, on every card.
    for (const id of ['s1', 'codex', 'grok']) {
      const chip = card(id).querySelector('span.uppercase')
      expect(chip?.textContent).toMatch(/^(Claude|Codex|Grok)$/)
    }
  })

  it('offers Add for every engine, Codex included', async () => {
    store.seats = []
    await render()
    for (const e of ['Claude', 'Codex', 'Grok']) expect(button(`Add ${e} seat`), e).toBeTruthy()
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats') return Promise.resolve({ ok: true, seat: seat({ id: 's4', label: 'Codex seat 1', kind: 'codex', credential: { kind: 'cli_login', last4: null, addedAt: null, expiresAt: null, expiry: null, usable: false } }) })
      if (url === '/admin/seats/s4/login/start') return Promise.resolve({ ok: true, flow: 'device', url: 'https://auth.openai.com/device', userCode: 'ABCD-1234' })
      if (url === '/admin/seats/s4/login/status') return Promise.resolve({ ok: true, pending: true })
      return Promise.reject(new Error(`unexpected ${url}`))
    })
    button('Add Codex seat')!.click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/admin/seats', { kind: 'codex' })
    expect(apiMock.post.mock.calls.some(c => c[0] === '/admin/seats/s4/login/start')).toBe(true)
    expect(section('codex').textContent).toContain('ABCD-1234')
  })

  it('a CLI-login Claude seat says it needs Sign in with Claude, and converts in place', async () => {
    await render()
    expect(card('s1').textContent).toContain('Needs Sign in with Claude')
    expect(card('s1').textContent).not.toContain('Healthy')
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats/claude-oauth/start') return Promise.resolve(LINK)
      if (url === '/admin/seats/claude-oauth/finish') {
        return Promise.resolve({ ok: true, outcome: 'healthy', seat: seat({ id: 's1', label: 'Mike@ biz', credential: { kind: 'setup_token', last4: 'zz99', addedAt: null, expiresAt: null, expiry: null, usable: true, needsClaudeSignIn: false } }) })
      }
      return Promise.reject(new Error(`unexpected ${url}`))
    })
    button('Reconnect with Sign in with Claude', card('s1'))!.click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/admin/seats/claude-oauth/start', { seatId: 's1' })
    const input = card('s1').querySelector('input[autocomplete="off"][spellcheck="false"]') as HTMLInputElement
    setValue(input, 'auth-code#st8')
    await flush()
    ;(input.closest('form') as HTMLFormElement).requestSubmit()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/admin/seats/claude-oauth/finish', { loginId: 'login-1', code: 'auth-code#st8', seatId: 's1' }, expect.anything())
    expect(card('s1').textContent).toContain('Setup token ••••zz99')
    expect(card('s1').textContent).toContain('Healthy')
    expect(button('Reconnect with Sign in with Claude', card('s1'))).toBeUndefined()
    // Never a second seat: same id, converted in place.
    expect(container.querySelectorAll('[data-testid^="seat-"]').length).toBe(3)
  })

  it('a Connect / Reconnect click always shows something: the link flow, or the error', async () => {
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats/claude-oauth/start') return Promise.reject(new ApiErrorMock(500, { error: 'Sign-in service is down' }, 'HTTP 500'))
      return Promise.reject(new Error(`unexpected ${url}`))
    })
    await render()
    button('Reconnect', card('s1'))!.click()
    await flush()
    expect(card('s1').textContent).toContain('Sign-in service is down')
  })

  it('Remove works for every engine', async () => {
    apiMock.del.mockResolvedValue({ ok: true })
    await render()
    for (const id of ['s1', 'codex', 'grok']) {
      button('Remove', card(id))!.click()
      await flush()
      expect(apiMock.del).toHaveBeenCalledWith(`/admin/seats/${id}`)
      expect(card(id)).toBeNull()
    }
    expect(container.textContent).toContain('No Claude seats yet')
  })

  it('seatBadge: credential problems outrank a "healthy" pool state', () => {
    expect(seatBadge(seat({ credential: CLI_CLAUDE })).text).toBe('Needs Sign in with Claude')
    expect(seatBadge(seat({ kind: 'codex', credential: { kind: 'cli_login', last4: null, addedAt: null, expiresAt: null, expiry: null, usable: false } })).text).toBe('Not signed in')
    expect(seatBadge(seat()).text).toBe('Healthy')
  })
})
