// @vitest-environment jsdom
//
// obj 720115 removed the built-in assistant. Settings → Account used to carry a
// "Your Assistant" card backed by /api/assistant/config; this proves it is gone.
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

describe('Settings → Account without the assistant', () => {
  it('renders no assistant card', async () => {
    await render()
    const headings = Array.from(container.querySelectorAll('h1, h2, h3')).map(h => h.textContent ?? '')
    expect(headings.some(h => /assistant/i.test(h))).toBe(false)
    expect(container.textContent ?? '').not.toMatch(/Your Assistant|Assistant/i)
  })

  it('never calls the removed assistant config API', async () => {
    await render()
    expect(calledUrls().some(u => u.startsWith('/assistant'))).toBe(false)
    expect(apiMock.put).not.toHaveBeenCalled()
  })
})
