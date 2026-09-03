// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { AccountSettings } from './AccountSettings'

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

vi.mock('../hooks/useAssistantConfig', () => ({
  useAssistantConfig: () => ({ config: null, loading: false, error: '', save: vi.fn() }),
}))

vi.mock('./ui', () => ({
  useConfirm: () => ({
    confirm: vi.fn(async () => true),
    confirmDialog: null,
  }),
  Modal: () => null,
}))

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'mike', role: 'admin' } }),
}))

describe('AccountSettings API key card', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    apiMock.get.mockReset()
    apiMock.post.mockReset()
    apiMock.del.mockReset()
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/auth/api-key') {
        return Promise.resolve({ configured: false, last4: null, created_at: null })
      }
      if (url === '/user/github-token') return Promise.resolve(null)
      if (url === '/user/google') return Promise.resolve({ connection: null, configured: true })
      if (url === '/assistant/config') {
        return Promise.resolve({
          userId: 1,
          workspace: 'example',
          persona: { displayName: 'Assistant', tagline: null, systemPrompt: '', manualSource: null },
          model: null,
          autonomy: { level: 'confirm_external', overrides: null },
          enabledCapabilities: [],
          enabledConnectors: [],
          enabled: true,
          createdAt: '2026-07-11T00:00:00Z',
          updatedAt: '2026-07-11T00:00:00Z',
        })
      }
      if (url.startsWith('/secrets')) return Promise.resolve([])
      return Promise.resolve(null)
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  it('shows Generate API key and reveals the secret once after minting', async () => {
    apiMock.post.mockResolvedValue({
      token: 'cc_live_TESTKEYVALUE0001',
      last4: '0001',
      created_at: '2026-08-24 20:00:00',
    })
    flushSync(() => root.render(<AccountSettings />))
    await flush()
    const generate = Array.from(container.querySelectorAll('button')).find(
      b => b.textContent === 'Generate API key',
    )
    expect(generate).toBeTruthy()
    generate!.click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/auth/api-key')
    const shown = container.querySelector('input[readonly]') as HTMLInputElement | null
    expect(shown?.value).toBe('cc_live_TESTKEYVALUE0001')
    expect(container.textContent).toMatch(/Copy this now/)
  })
})
