// @vitest-environment jsdom
//
// Seat management reliability in the UI (obj 720330): one request per Connect
// (double-click / double Enter), a lost reply is retried on the SAME sign-in,
// dead links say so, the Add form sends one idempotency key, a re-pasted token
// says it is already there, Remove on a busy seat explains the drain, and a
// pasted-token seat is offered "Reconnect with Sign in with Claude". Fake data only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { SeatPool, offersClaudeSignIn, type SeatSummary } from './SettingsSeats'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
  }
}

function seat(over: Partial<SeatSummary> = {}): SeatSummary {
  return {
    id: 's1', label: 'Old pasted seat', kind: 'claude', priority: 1, enabled: true, health: 'healthy', available: true,
    cooldownUntil: null, consecutiveFailures: 0,
    credential: { kind: 'setup_token', source: 'pasted', last4: 'ab12', addedAt: null, expiresAt: null, expiry: null, usable: true, needsClaudeSignIn: false },
    sessions: { active: 0, today: 0 }, usageToday: { tokens: 0, cost: 0 },
    ...over,
  }
}

const { store, apiMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    constructor(public status: number, public body: unknown, message: string) { super(message) }
  }
  const store = { seats: [] as unknown[] }
  const apiMock = {
    get: vi.fn((url: string) => url === '/admin/seats' ? Promise.resolve({ seats: structuredClone(store.seats) }) : Promise.resolve(null)),
    post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(),
  }
  return { store, apiMock, ApiErrorMock }
})
vi.mock('../../lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }))
vi.mock('../../components/ui', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../components/ui')
  return { ...actual, useConfirm: () => ({ confirm: vi.fn(async () => true), confirmDialog: null }) }
})

const setValue = (el: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const LINK = { ok: true, loginId: 'login-1', url: 'https://claude.com/cai/oauth/authorize?code=true&state=st8', expiresAt: '2026-11-01T12:10:00Z' }
const finishCalls = () => apiMock.post.mock.calls.filter(c => c[0] === '/admin/seats/claude-oauth/finish')

describe('seat management reliability (UI)', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    for (const fn of [apiMock.post, apiMock.put, apiMock.patch, apiMock.del]) fn.mockReset()
    store.seats = [seat()]
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { flushSync(() => root.unmount()); container.remove() })

  const render = async () => { flushSync(() => root.render(<SeatPool />)); await flush() }
  const button = (text: string, scope: ParentNode = container) =>
    Array.from(scope.querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined
  const card = () => container.querySelector('[data-testid="seat-s1"]') as HTMLElement

  async function openReconnect() {
    await render()
    button('Reconnect with Sign in with Claude', card())!.click()
    await flush()
    const input = card().querySelector('#claude-code-s1') as HTMLInputElement
    setValue(input, 'auth-code#st8')
    await flush()
    return input.closest('form') as HTMLFormElement
  }

  it('a pasted-token seat is offered Reconnect with Sign in with Claude; an OAuth seat just Reconnect', async () => {
    expect(offersClaudeSignIn(seat())).toBe(true)
    expect(offersClaudeSignIn(seat({ credential: { ...seat().credential, source: 'oauth' } }))).toBe(false)
    expect(offersClaudeSignIn(seat({ kind: 'codex' }))).toBe(false)
    await render()
    expect(card().textContent).toContain('pasted token')
    expect(button('Reconnect with Sign in with Claude', card())).toBeDefined()
  })

  it('double submit sends ONE finish request', async () => {
    let resolveFinish: (v: unknown) => void = () => {}
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats/claude-oauth/start') return Promise.resolve(LINK)
      if (url === '/admin/seats/claude-oauth/finish') return new Promise(r => { resolveFinish = r })
      return Promise.resolve({ ok: true })
    })
    const form = await openReconnect()
    form.requestSubmit()
    form.requestSubmit()
    await flush()
    expect(finishCalls()).toHaveLength(1)
    resolveFinish({ ok: true, outcome: 'healthy', seat: seat({ credential: { ...seat().credential, source: 'oauth', last4: 'zz99' } }) })
    await flush()
    expect(card().textContent).toContain('via Sign in with Claude')
    expect(container.querySelectorAll('[data-testid^="seat-"]')).toHaveLength(1)
  })

  it('a lost reply offers Try again, which resends the same code on the same link', async () => {
    let n = 0
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats/claude-oauth/start') return Promise.resolve(LINK)
      if (url === '/admin/seats/claude-oauth/finish') {
        n++
        return n === 1
          ? Promise.reject(new ApiErrorMock(0, null, 'Request timed out — message not sent'))
          : Promise.resolve({ ok: true, outcome: 'healthy', replayed: true, seat: seat({ credential: { ...seat().credential, source: 'oauth' } }) })
      }
      return Promise.resolve({ ok: true })
    })
    const form = await openReconnect()
    form.requestSubmit()
    await flush()
    expect(card().textContent).toContain('will not add a second seat')
    expect(card().innerHTML).not.toContain('auth-code#st8')
    button('Try again', card())!.click()
    await flush()
    expect(finishCalls()).toHaveLength(2)
    expect(finishCalls()[1][1]).toMatchObject({ loginId: 'login-1', code: 'auth-code#st8', seatId: 's1' })
    expect(container.textContent).toContain('is signed in and answered its test turn')
  })

  it('a link bound to another seat is dead: only "Get a new link" is offered', async () => {
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats/claude-oauth/start') return Promise.resolve(LINK)
      if (url === '/admin/seats/claude-oauth/finish') {
        return Promise.reject(new ApiErrorMock(409, { error: 'This sign-in link was started for a different seat.', code: 'wrong_seat' }, 'x'))
      }
      return Promise.resolve({ ok: true })
    })
    const form = await openReconnect()
    form.requestSubmit()
    await flush()
    expect(card().textContent).toContain('started for a different seat')
    expect(button('Get a new link', card())).toBeDefined()
    expect(button('Try again', card())).toBeUndefined()
  })

  it('Add form: one idempotency key per form, reused on resubmit; a re-pasted token says it already exists', async () => {
    store.seats = []
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats/claude-oauth/start') return Promise.resolve(LINK)
      return Promise.resolve({ ok: true, duplicate: true, seat: seat() })
    })
    await render()
    button('Add Claude seat')!.click()
    await flush()
    button('Have a setup token already? Paste it instead')!.click()
    await flush()
    const token = container.querySelector('#seat-claude-token') as HTMLInputElement
    setValue(token, 'fake-setup-token-value-1234567890')
    await flush()
    const form = token.closest('form') as HTMLFormElement
    form.requestSubmit()
    form.requestSubmit()
    await flush()
    const adds = apiMock.post.mock.calls.filter(c => c[0] === '/admin/seats')
    expect(adds).toHaveLength(1)
    expect(adds[0][1].idempotencyKey).toEqual(expect.any(String))
    expect(container.textContent).toContain('That token is already on Old pasted seat. Nothing new was added.')
    expect(container.querySelectorAll('[data-testid^="seat-"]')).toHaveLength(1)
  })

  it('Remove on a busy seat: the confirm offers a drain, and the server\'s explanation + disabled state show', async () => {
    store.seats = [seat({ sessions: { active: 2, today: 2 } })]
    const drained = seat({ enabled: false, health: 'disabled', sessions: { active: 2, today: 2 } })
    apiMock.del.mockRejectedValue(new ApiErrorMock(409, {
      error: 'This seat is running 2 sessions. It is now disabled, so no new work starts on it, and the running work keeps going. Remove it again when they finish.',
      code: 'seat_in_use', drained: true, seat: drained,
    }, 'x'))
    await render()
    button('Remove', card())!.click()
    await flush()
    expect(card().textContent).toContain('It is now disabled, so no new work starts on it, and the running work keeps going.')
    expect(card().textContent).toContain('Disabled')
    expect(card()).not.toBeNull()
  })
})
