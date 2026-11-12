// @vitest-environment jsdom
//
// obj 720115 moved GitHub and Google Workspace into Settings → Integrations.
// obj 900681 (Operator's Operation Kit Feedback) then removed the leftover
// "GitHub and Google Workspace" pointer card from Settings → API & MCP and moved
// My Secrets to Settings → Secrets → Mine. This pins all of that, and that the
// copy-paste coding-agent setup prompt is on the page.
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

const { apiMock } = vi.hoisted(() => ({
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
}))

vi.mock('../lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin', username: 'owner' } }) }))
vi.mock('../context/nav', () => ({ useNavigate: () => vi.fn() }))
vi.mock('./ui', () => ({
  Modal: () => null,
  useConfirm: () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmDialog: null }),
}))

import { AccountSettings } from './AccountSettings'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  apiMock.get.mockClear()
  apiMock.post.mockClear()
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

describe('Settings → API & MCP after the obj 900681 cleanup', () => {
  it('has no GitHub / Google Workspace card and no Google connect button', async () => {
    await render()
    expect(container.textContent).not.toContain('GitHub and Google Workspace')
    expect(container.textContent).not.toContain('Open Integrations')
    const buttons = Array.from(container.querySelectorAll('button')).map(b => b.textContent ?? '')
    expect(buttons.some(b => /connect (google|github)/i.test(b))).toBe(false)
  })

  it('no longer loads or starts the Google connection from this page', async () => {
    await render()
    expect(calledUrls().some(u => u.startsWith('/user/google'))).toBe(false)
    expect(apiMock.post).not.toHaveBeenCalledWith('/user/google/connect')
  })

  it('no longer shows My Secrets or loads personal secrets (moved to Settings → Secrets → Mine)', async () => {
    await render()
    expect(container.textContent).not.toMatch(/My secrets/i)
    expect(calledUrls().some(u => u.startsWith('/secrets?scopeType=user'))).toBe(false)
  })

  it('leads with the copy-paste coding-agent setup prompt', async () => {
    await render()
    const card = container.querySelector('[data-testid="coding-agent-setup"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Connect a coding agent')
    expect(container.querySelector('[data-testid="coding-agent-prompt"]')?.textContent).toContain('claude mcp add')
    const copy = Array.from(card!.querySelectorAll('button')).find(b => b.textContent === 'Copy prompt')
    expect(copy).toBeTruthy()
  })
})
