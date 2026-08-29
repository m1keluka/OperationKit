// @vitest-environment jsdom
//
// obj-706070 — proves the "Google Workspace" card in Settings > Account renders
// an accurate per-user connection state, starts the consent flow via
// POST /api/user/google/connect, and — the load-bearing one — NEVER renders any
// token material even when a (hostile / over-sharing) API response carries it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

// Production React build in the container omits `act`; drive commits with flushSync.
async function flush() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

// Token-ish values the server contract does NOT include. If any of these ever
// reach the DOM, the card is leaking credentials.
const TOKENS = {
  access_token: 'ya29.LEAKED-ACCESS-TOKEN',
  refresh_token: '1//LEAKED-REFRESH-TOKEN',
  client_secret: 'GOCSPX-LEAKED-CLIENT-SECRET',
  id_token: 'eyJLEAKEDIDTOKEN.payload.sig',
}

const CONNECTED = {
  google_email: 'dev@example.com',
  scopes: [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar',
  ].join(' '),
  client_id: '281080251349-abc.apps.googleusercontent.com',
  connected_at: '2026-08-01 12:00:00',
  last_refreshed_at: '2026-08-13 09:30:00',
  last_error: null as string | null,
}

const { store, apiMock } = vi.hoisted(() => {
  const store = {
    google: { connection: null as Record<string, unknown> | null, configured: true },
  }
  const apiMock = {
    get: vi.fn((url: string) => {
      if (url === '/user/google') return Promise.resolve(structuredClone(store.google))
      if (url === '/user/github-token') return Promise.resolve(null)
      if (url === '/assistant/config') return Promise.resolve(null)
      if (url.startsWith('/secrets')) return Promise.resolve([])
      return Promise.resolve(null)
    }),
    post: vi.fn((url: string) => {
      if (url === '/user/google/connect') {
        return Promise.resolve({ auth_url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' })
      }
      return Promise.resolve({})
    }),
    put: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve({ removed: true, revoked: true })),
  }
  return { store, apiMock }
})

vi.mock('../lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin', username: 'admin' } }) }))
vi.mock('../hooks/useAssistantConfig', () => ({ useAssistantConfig: () => ({ config: null, loading: false, error: '', save: vi.fn() }) }))
vi.mock('./ui', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  useConfirm: () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmDialog: null }),
}))

import { AccountSettings } from './AccountSettings'

function googleCard(container: HTMLElement): HTMLElement {
  const h2 = Array.from(container.querySelectorAll('h2')).find(h => h.textContent === 'Google Workspace')
  expect(h2, 'Google Workspace heading present').toBeTruthy()
  return h2!.closest('section') as HTMLElement
}

function buttonWith(card: HTMLElement, text: string): HTMLButtonElement {
  const btn = Array.from(card.querySelectorAll('button')).find(b => (b.textContent || '').includes(text))
  expect(btn, `button containing "${text}"`).toBeTruthy()
  return btn as HTMLButtonElement
}

describe('Google Workspace card (obj-706070)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    store.google = { connection: null, configured: true }
    apiMock.post.mockClear()
    apiMock.del.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
  })

  it('renders the not-connected state with a Connect button', async () => {
    flushSync(() => root.render(<AccountSettings />))
    await flush()

    const card = googleCard(container)
    expect(card.textContent).toContain('not connected')
    const btn = buttonWith(card, 'Connect Google Workspace')
    expect(btn.disabled).toBe(false)
    expect(card.textContent).not.toContain('Disconnect')
  })

  it('disables Connect and explains when the server has no OAuth client', async () => {
    store.google = { connection: null, configured: false }
    flushSync(() => root.render(<AccountSettings />))
    await flush()

    const card = googleCard(container)
    expect(buttonWith(card, 'Connect Google Workspace').disabled).toBe(true)
    expect(card.textContent).toContain('Google OAuth is not configured on this server')
  })

  it('renders the connected state with the account email, scope summary and timestamps', async () => {
    store.google = { connection: { ...CONNECTED }, configured: true }
    flushSync(() => root.render(<AccountSettings />))
    await flush()

    const card = googleCard(container)
    expect(card.textContent).toContain('dev@example.com')
    expect(card.textContent).toContain('connected')
    // 7 granted scopes in the fixture.
    expect(card.textContent).toContain('7 scopes')
    // Surface chips: all six named, Slides present but NOT granted in the fixture.
    for (const surface of ['Gmail', 'Drive', 'Docs', 'Sheets', 'Slides', 'Calendar']) {
      expect(card.textContent).toContain(surface)
    }
    const slides = Array.from(card.querySelectorAll('span')).find(s => s.textContent === 'Slides')!
    expect(slides.className).toContain('line-through')
    const gmail = Array.from(card.querySelectorAll('span')).find(s => s.textContent === 'Gmail')!
    expect(gmail.className).not.toContain('line-through')
    // Timestamps rendered (localized, so just assert they are not "never").
    const dds = Array.from(card.querySelectorAll('dd')).map(d => d.textContent)
    expect(dds.some(t => t && t !== 'never' && /202[0-9]|\d{1,2}\/\d{1,2}\/\d{4}/.test(t))).toBe(true)
    buttonWith(card, 'Disconnect')
  })

  it('shows a warning banner when the stored credential has a last_error', async () => {
    store.google = {
      connection: { ...CONNECTED, last_error: 'invalid_grant: Token has been expired or revoked.' },
      configured: true,
    }
    flushSync(() => root.render(<AccountSettings />))
    await flush()

    const card = googleCard(container)
    expect(card.textContent).toContain('Google refresh failed.')
    expect(card.textContent).toContain('invalid_grant: Token has been expired or revoked.')
  })

  it('clicking Connect POSTs /user/google/connect and navigates to the consent URL', async () => {
    // jsdom refuses real navigation; intercept the assignment.
    const hrefs: string[] = []
    const original = Object.getOwnPropertyDescriptor(window, 'location')
    delete (window as any).location
    ;(window as any).location = {
      ...(original?.value ?? {}),
      pathname: '/settings/account',
      search: '',
      set href(v: string) { hrefs.push(v) },
      get href() { return hrefs[hrefs.length - 1] ?? 'http://localhost/settings/account' },
    }

    flushSync(() => root.render(<AccountSettings />))
    await flush()

    const card = googleCard(container)
    const btn = buttonWith(card, 'Connect Google Workspace')
    flushSync(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    expect(apiMock.post).toHaveBeenCalledWith('/user/google/connect', {})
    expect(hrefs).toEqual(['https://accounts.google.com/o/oauth2/v2/auth?client_id=x'])

    if (original) Object.defineProperty(window, 'location', original)
  })

  it('Disconnect calls DELETE /user/google and refreshes to the not-connected state', async () => {
    store.google = { connection: { ...CONNECTED }, configured: true }
    flushSync(() => root.render(<AccountSettings />))
    await flush()

    let card = googleCard(container)
    const btn = buttonWith(card, 'Disconnect')
    // The confirm mock auto-resolves true; the DELETE clears the stored row.
    apiMock.del.mockImplementationOnce(() => {
      store.google = { connection: null, configured: true }
      return Promise.resolve({ removed: true, revoked: true })
    })
    flushSync(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await flush()

    expect(apiMock.del).toHaveBeenCalledWith('/user/google')
    card = googleCard(container)
    expect(card.textContent).toContain('not connected')
  })

  it('surfaces the callback outcome from the query string and strips the params', async () => {
    window.history.replaceState({}, '', '/settings/account?google=error&google_error=access_denied&keep=1')
    flushSync(() => root.render(<AccountSettings />))
    await flush()

    const card = googleCard(container)
    expect(card.textContent).toContain('You declined the permission request at Google.')
    // Params stripped so a refresh doesn't replay the failure; unrelated ones kept.
    expect(window.location.search).toBe('?keep=1')
    window.history.replaceState({}, '', '/settings/account')
  })

  it('never renders token material, even if the API response carries it', async () => {
    // Deliberately over-share: the real contract has none of these fields.
    store.google = { connection: { ...CONNECTED, ...TOKENS }, configured: true }
    flushSync(() => root.render(<AccountSettings />))
    await flush()

    const card = googleCard(container)
    const text = card.textContent || ''
    const html = card.innerHTML
    for (const [field, value] of Object.entries(TOKENS)) {
      expect(text, `${field} value must not be rendered`).not.toContain(value)
      expect(html, `${field} value must not be in markup`).not.toContain(value)
      expect(text.toLowerCase(), `${field} label must not be rendered`).not.toContain(field.replace('_', ' '))
    }
    expect(text.toLowerCase()).not.toContain('refresh token')
    expect(text.toLowerCase()).not.toContain('access token')
    // Sanity: the safe fields DID render, so the assertions above aren't vacuous.
    expect(text).toContain('dev@example.com')
  })
})
