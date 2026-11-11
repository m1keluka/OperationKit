// @vitest-environment jsdom
//
// obj 720115 moved GitHub and Google Workspace into Settings → Connectors.
// Settings → Account now shows a pointer card instead of its own Google card;
// this proves the pointer works and the old connect flow is not left behind.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

// Production React build in the container omits `act`; drive commits with flushSync.
async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

const { apiMock, navigateMock } = vi.hoisted(() => ({
  apiMock: {
    get: vi.fn((url: string) => {
      if (url === '/auth/api-key') return Promise.resolve({ configured: false, last4: null, created_at: null })
      if (url.startsWith('/secrets')) return Promise.resolve([])
      return Promise.resolve(null)
    }),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve({})),
  },
  navigateMock: vi.fn(),
}))

vi.mock('../lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin', username: 'owner' } }) }))
vi.mock('../context/nav', () => ({ useNavigate: () => navigateMock }))
vi.mock('./ui', () => ({
  Modal: () => null,
  useConfirm: () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmDialog: null }),
}))

import { AccountSettings } from './AccountSettings'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  apiMock.get.mockClear()
  navigateMock.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

async function render() {
  flushSync(() => root.render(<AccountSettings />))
  await flush()
}

const calledUrls = () => apiMock.get.mock.calls.map(c => String(c[0]))

describe('Settings → Account points Google Workspace at Connectors', () => {
  it('shows the pointer card and no Google connect button', async () => {
    await render()
    expect(container.textContent).toContain('GitHub and Google Workspace')
    const buttons = Array.from(container.querySelectorAll('button')).map(b => b.textContent ?? '')
    expect(buttons.some(b => /connect google/i.test(b))).toBe(false)
  })

  it('no longer loads or starts the Google connection from this page', async () => {
    await render()
    expect(calledUrls().some(u => u.startsWith('/user/google'))).toBe(false)
    expect(apiMock.post).not.toHaveBeenCalledWith('/user/google/connect')
  })

  it('the Open Connectors link goes to /settings/connectors', async () => {
    await render()
    const link = Array.from(container.querySelectorAll('a')).find(a => a.textContent === 'Open Connectors')
    expect(link?.getAttribute('href')).toBe('/settings/connectors')
    link!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    expect(navigateMock).toHaveBeenCalledWith('/settings/connectors')
  })
})
