// @vitest-environment jsdom
//
// Settings → Seats: grouped seat list, human health copy, write-only Claude
// token entry, friendly in-use error on remove, and the failover policy save.
// Fake data only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { SettingsSeats, healthBadge, type SeatSummary } from './SettingsSeats'
import { fmtLocalReset, limitBadge } from './SeatUsage'

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
  const store = { seats: [] as unknown[], provisioning: null as unknown }
  const apiMock = {
    get: vi.fn((url: string) => {
      if (url === '/admin/seats') return Promise.resolve({ seats: structuredClone(store.seats), kinds: ['claude', 'codex', 'grok'], provisioning: structuredClone(store.provisioning) })
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

describe('Settings → Seats', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    for (const fn of [apiMock.post, apiMock.put, apiMock.patch, apiMock.del]) fn.mockReset()
    store.provisioning = null
    store.seats = [
      seat(),
      seat({ id: 'seat-2', label: 'Seat 2', priority: 2, health: 'credits_exhausted', credential: { kind: 'setup_token', last4: 'cd34', addedAt: null, expiresAt: '2026-11-03T00:00:00Z', expiry: 'expiring' } }),
      seat({ id: 'seat-3', label: 'Seat 3', kind: 'codex', health: 'needs_reconnect', credential: { kind: 'cli_login', last4: null, addedAt: null, expiresAt: null, expiry: null } }),
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
    flushSync(() => root.render(<SettingsSeats />))
    await flush()
  }
  const button = (text: string, scope: ParentNode = container) =>
    Array.from(scope.querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined
  const section = (kind: string) => container.querySelector(`section[aria-labelledby="seats-${kind}"]`) as HTMLElement

  it('renders seats grouped by engine with an empty state for engines without seats', async () => {
    await render()
    const claude = section('claude').textContent ?? ''
    expect(claude).toContain('Seat 1')
    expect(claude).toContain('Seat 2')
    expect(claude).toContain('Setup token ••••ab12')
    expect(claude).toContain('2 active · 7 today')
    expect(claude).toContain('$1.50')
    const codex = section('codex').textContent ?? ''
    expect(codex).toContain('Seat 3')
    expect(codex).toContain('CLI login')
    expect(codex).not.toContain('$')
    expect(section('grok').textContent).toContain('No Grok seats')
    expect(container.textContent).toContain("Connect only subscriptions you own and follow each provider's terms.")
  })

  it('shows health in plain words', async () => {
    await render()
    expect(section('claude').textContent).toContain('Healthy')
    expect(section('claude').textContent).toContain('Credits used up')
    expect(section('codex').textContent).toContain('Needs reconnect')
    expect(healthBadge({ health: 'cooling_down', cooldownUntil: '2026-01-01T10:30:00Z' }).text).toMatch(/^Cooling down until /)
    expect(healthBadge({ health: 'needs_admin', cooldownUntil: null }).text).toBe('Needs admin')
    expect(healthBadge({ health: 'disabled', cooldownUntil: null }).text).toBe('Disabled')
  })

  const LINK = { ok: true, loginId: 'login-1', url: 'https://claude.com/cai/oauth/authorize?code=true&state=st8', expiresAt: '2026-11-01T12:10:00Z' }
  const NEW_SEAT = seat({ id: 'seat-9', label: 'Seat 9', credential: { kind: 'setup_token', last4: 'zz99', addedAt: null, expiresAt: '2027-11-01T00:00:00Z', expiry: null } })

  it('Add Claude seat opens "Sign in with Claude": link, paste code#state, seat added and tested', async () => {
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats/claude-oauth/start') return Promise.resolve(LINK)
      if (url === '/admin/seats/claude-oauth/finish') return Promise.resolve({ ok: true, outcome: 'healthy', seat: NEW_SEAT })
      return Promise.reject(new Error(`unexpected ${url}`))
    })
    await render()
    button('Add Claude seat', section('claude'))!.click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/admin/seats/claude-oauth/start', {})
    const link = Array.from(container.querySelectorAll('a')).find(a => a.textContent?.includes('Sign in with Claude')) as HTMLAnchorElement
    expect(link.href).toBe(LINK.url)
    expect(link.target).toBe('_blank')
    expect(link.rel).toContain('noopener')
    expect(container.querySelector('#seat-claude-token')).toBeNull() // paste-token is the fallback, not the default
    setValue(container.querySelector('#seat-claude-label') as HTMLInputElement, 'Seat 9')
    const code = container.querySelector('#claude-code-new') as HTMLInputElement
    setValue(code, '  fake-auth-code#st8 ')
    await flush()
    button('Connect seat')!.click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/admin/seats/claude-oauth/finish', { loginId: 'login-1', code: 'fake-auth-code#st8', label: 'Seat 9' }, { timeoutMs: 90_000 })
    expect(container.innerHTML).not.toContain('fake-auth-code')
    expect(section('claude').textContent).toContain('Seat 9')
    expect(container.textContent).toContain('Seat 9 is signed in and answered its test turn. Healthy.')
  })

  it('a state mismatch keeps the link; an expired link offers a new one', async () => {
    let finishes = 0
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats/claude-oauth/start') return Promise.resolve(LINK)
      if (url === '/admin/seats/claude-oauth/finish') {
        finishes++
        return Promise.reject(finishes === 1
          ? new ApiErrorMock(400, { error: 'That code is from a different sign-in link.', code: 'state_mismatch' }, 'bad')
          : new ApiErrorMock(410, { error: 'This sign-in link expired.', code: 'expired' }, 'gone'))
      }
      return Promise.resolve({ ok: true })
    })
    await render()
    button('Add Claude seat', section('claude'))!.click()
    await flush()
    setValue(container.querySelector('#claude-code-new') as HTMLInputElement, 'x#other')
    await flush()
    button('Connect seat')!.click()
    await flush()
    expect(container.textContent).toContain('That code is from a different sign-in link.')
    expect(button('Connect seat')).toBeDefined()
    setValue(container.querySelector('#claude-code-new') as HTMLInputElement, 'x#st8')
    await flush()
    button('Connect seat')!.click()
    await flush()
    expect(container.textContent).toContain('This sign-in link expired.')
    button('Get a new link')!.click()
    await flush()
    expect(apiMock.post.mock.calls.filter(c => c[0] === '/admin/seats/claude-oauth/start')).toHaveLength(2)
  })

  it('Reconnect on a Claude seat signs in again for that seat id', async () => {
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats/claude-oauth/start') return Promise.resolve(LINK)
      if (url === '/admin/seats/claude-oauth/finish') return Promise.resolve({ ok: true, outcome: 'unparked', seat: seat() })
      return Promise.resolve({ ok: true })
    })
    await render()
    const card = container.querySelector('[data-testid="seat-seat-1"]') as HTMLElement
    button('Reconnect', card)!.click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/admin/seats/claude-oauth/start', { seatId: 'seat-1' })
    setValue(card.querySelector('#claude-code-seat-1') as HTMLInputElement, 'c#st8')
    await flush()
    button('Reconnect seat', card)!.click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/admin/seats/claude-oauth/finish', { loginId: 'login-1', code: 'c#st8', seatId: 'seat-1' }, { timeoutMs: 90_000 })
    expect(container.textContent).toContain('Seat 1 is signed in and answered its test turn. Back in rotation.')
  })

  it('adds a Claude seat with the pasted token (fallback) and clears the input', async () => {
    apiMock.post.mockImplementation((url: string) => {
      if (url === '/admin/seats/claude-oauth/start') return Promise.resolve(LINK)
      return Promise.resolve({ ok: true, seat: NEW_SEAT })
    })
    await render()
    button('Add Claude seat', section('claude'))!.click()
    await flush()
    button('Have a setup token already? Paste it instead')!.click()
    await flush()
    const token = container.querySelector('#seat-claude-token') as HTMLInputElement
    expect(token.type).toBe('password')
    expect(token.autocomplete).toBe('off')
    setValue(container.querySelector('#seat-claude-label') as HTMLInputElement, 'Seat 9')
    setValue(token, 'fake-setup-token-value')
    await flush()
    button('Add seat')!.click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/admin/seats', { kind: 'claude', credential: 'fake-setup-token-value', label: 'Seat 9' })
    expect(container.innerHTML).not.toContain('fake-setup-token-value')
    expect(container.querySelector('#seat-claude-token')).toBeNull()
    expect(section('claude').textContent).toContain('Seat 9')
  })

  it('explains a 409 seat_in_use on remove', async () => {
    apiMock.del.mockRejectedValue(new ApiErrorMock(409, { error: 'seat_in_use' }, 'seat_in_use'))
    await render()
    const card = container.querySelector('[data-testid="seat-seat-1"]') as HTMLElement
    button('Remove', card)!.click()
    await flush()
    expect(apiMock.del).toHaveBeenCalledWith('/admin/seats/seat-1')
    expect(card.textContent).toContain('This seat is running sessions right now')
    expect(card.textContent).not.toContain('seat_in_use')
    expect(section('claude').textContent).toContain('Seat 1')
  })

  it('saves the failover toggle with { enabled, order }', async () => {
    apiMock.put.mockResolvedValue({ workspace: 'main', enabled: true, order: ['claude', 'codex', 'grok'] })
    await render()
    expect(apiMock.get).toHaveBeenCalledWith('/admin/seats/failover/main')
    const toggle = Array.from(container.querySelectorAll('[role="switch"]')).find(el =>
      el.textContent?.includes("run it on another engine"),
    ) as HTMLButtonElement
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    toggle.click()
    await flush()
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    button('Save')!.click()
    await flush()
    expect(apiMock.put).toHaveBeenCalledWith('/admin/seats/failover/main', { enabled: true, order: ['claude', 'codex', 'grok'] })
    expect(container.textContent).toContain('Cards pinned to one engine never move.')
  })
  describe('per-seat usage', () => {
    const RESET = '2026-11-03T14:00:00.000Z'
    const usage = (over: Partial<NonNullable<SeatSummary['usage']>> = {}): NonNullable<SeatSummary['usage']> => ({
      tokens_24h: 1_250_000, tokens_7d: 8_400_000, sessions_24h: 12, sessions_7d: 1, limit_state: 'healthy',
      limit_reset_at: null, limited_pct_24h: 0, ...over,
    })

    it('renders 24h / 7d tokens and sessions, the limit badge and the reset in local time with a timezone label', async () => {
      store.seats = [
        seat({ usage: usage() }),
        seat({
          id: 'seat-2', label: 'Seat 2', priority: 2, health: 'cooling_down', cooldownUntil: RESET,
          usage: usage({ tokens_24h: 900, tokens_7d: 900, sessions_24h: 1, sessions_7d: 1, limit_state: 'weekly', limit_reset_at: RESET, limited_pct_24h: 41.7 }),
        }),
        seat({ id: 'seat-3', label: 'Seat 3', kind: 'codex', usage: usage({ limit_state: '5h', limit_reset_at: RESET }) }),
      ]
      await render()
      const claude = section('claude')
      const rows24 = Array.from(claude.querySelectorAll('[data-testid="seat-usage-24h"]')).map(e => e.textContent)
      const rows7d = Array.from(claude.querySelectorAll('[data-testid="seat-usage-7d"]')).map(e => e.textContent)
      expect(rows24).toEqual(['1.3M tokens · 12 sessions', '900 tokens · 1 session'])
      expect(rows7d).toEqual(['8.4M tokens · 1 session', '900 tokens · 1 session'])
      const limits = Array.from(claude.querySelectorAll('[data-testid="seat-limit"]')).map(e => e.textContent ?? '')
      expect(limits[0]).toBe('No limit hit')
      expect(limits[1]).toContain('Weekly limit')
      expect(limits[1]).toContain('limited 41.7% of last 24h')
      // Reset in the viewer's own zone, labelled with that zone.
      const local = fmtLocalReset(RESET)
      expect(limits[1]).toContain(`resets ${local}`)
      const tz = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date(RESET)).find(p => p.type === 'timeZoneName')!.value
      expect(local).toContain(tz)
      expect(section('codex').querySelector('[data-testid="seat-limit"]')!.textContent).toContain('5-hour limit')
    })

    it('formats the reset in an explicit zone with its label', () => {
      expect(fmtLocalReset(RESET, 'America/New_York')).toMatch(/Nov 3.*9:00.*AM.*EST/)
      expect(fmtLocalReset(RESET, 'UTC')).toMatch(/Nov 3.*2:00.*PM.*UTC/)
      expect(limitBadge({ limit_state: '5h' }).text).toBe('5-hour limit')
      expect(limitBadge({ limit_state: 'weekly' }).text).toBe('Weekly limit')
    })

    it('shows the provisioning hint banner', async () => {
      store.provisioning = {
        verdict: 'mixed', limited_seats: 2, idle_seats: 1,
        thresholds: { limited_pct_24h: 25, idle_sessions_24h: 0 }, by_kind: [],
        message: '2 seats rate-limited >25% of the last 24h → under-provisioned (Claude); 1 seat idle (no sessions in 24h) → over-provisioned (Codex)',
      }
      await render()
      const banner = container.querySelector('[data-testid="seat-provisioning"]')!
      expect(banner.textContent).toContain('Seats are unevenly loaded')
      expect(banner.textContent).toContain('2 seats rate-limited >25% of the last 24h → under-provisioned (Claude)')
      expect(banner.textContent).toContain('more than 25% of the last 24h')
    })

    it('renders without usage or provisioning from an older server', async () => {
      await render()
      expect(container.querySelector('[data-testid="seat-provisioning"]')).toBeNull()
      expect(container.querySelector('[data-testid="seat-usage-24h"]')).toBeNull()
    })
  })
})
