// @vitest-environment jsdom
//
// obj 701701 — proves the "Your Assistant" card in Settings > Account renders
// its four fields, loads the caller's config via GET /api/assistant/config, and
// persists edits via PUT (name survives a reload). Exercises the REAL
// useAssistantConfig hook against a stateful mock of the frozen contract.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

// Production React build in the container omits `act`; drive commits with flushSync.
// Settle multiple chained async state updates: mount effect → GET resolves →
// setConfig commits → child seed-effect → setDisplayName commits.
async function flush() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

// Change a React-controlled input without the flaky jsdom native-setter path:
// bump React's value tracker so it detects the change, then dispatch `input`.
function setInputValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const tracker = (node as any)._valueTracker
  node.value = value
  if (tracker) tracker.setValue('')
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

// A stateful in-memory stand-in for the frozen /api/assistant/config endpoint.
const { store, apiMock } = vi.hoisted(() => {
  const store = {
    config: {
      userId: 1,
      workspace: 'example',
      persona: { displayName: 'Assistant', tagline: null, systemPrompt: 'Be concise.', manualSource: null },
      model: null,
      autonomy: { level: 'confirm_external', overrides: null },
      enabledCapabilities: [],
      enabledConnectors: [],
      enabled: true,
      createdAt: '2026-07-11T00:00:00Z',
      updatedAt: '2026-07-11T00:00:00Z',
    } as Record<string, unknown>,
  }
  const apiMock = {
    get: vi.fn((url: string) => {
      if (url === '/assistant/config') return Promise.resolve(structuredClone(store.config))
      if (url === '/user/github-token') return Promise.resolve(null)
      if (url.startsWith('/secrets')) return Promise.resolve([])
      return Promise.resolve(null)
    }),
    put: vi.fn((url: string, body: Record<string, any>) => {
      if (url === '/assistant/config') {
        // Merge partial like the server would (shallow-merge nested objects).
        const c: any = store.config
        if (body.persona) c.persona = { ...c.persona, ...body.persona }
        if (body.autonomy) c.autonomy = { ...c.autonomy, ...body.autonomy }
        if (typeof body.enabled === 'boolean') c.enabled = body.enabled
        return Promise.resolve(structuredClone(store.config))
      }
      return Promise.resolve({})
    }),
    post: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve()),
  }
  return { store, apiMock }
})

vi.mock('../lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin', username: 'mike' } }) }))
vi.mock('./ui', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  useConfirm: () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmDialog: null }),
}))

import { AccountSettings } from './AccountSettings'

function cardRoot(container: HTMLElement): HTMLElement {
  // The "Your Assistant" <h2> — walk up to its <section>.
  const h2 = Array.from(container.querySelectorAll('h2')).find(h => h.textContent === 'Your Assistant')
  expect(h2, 'Your Assistant heading present').toBeTruthy()
  return h2!.closest('section') as HTMLElement
}

describe('Your Assistant card (obj 701701)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    // Reset the persisted config between tests.
    store.config = {
      userId: 1, workspace: 'example',
      persona: { displayName: 'Assistant', tagline: null, systemPrompt: 'Be concise.', manualSource: null },
      model: null, autonomy: { level: 'confirm_external', overrides: null },
      enabledCapabilities: [], enabledConnectors: [], enabled: true,
      createdAt: '2026-07-11T00:00:00Z', updatedAt: '2026-07-11T00:00:00Z',
    }
    apiMock.put.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  it('renders name, instructions, autonomy, and enabled fields seeded from GET', async () => {
    flushSync(() => root.render(<AccountSettings />))
    await flush()

    const card = cardRoot(container)
    const name = card.querySelector('#assistant-name') as HTMLInputElement
    const prompt = card.querySelector('#assistant-prompt') as HTMLTextAreaElement
    const autonomy = card.querySelector('#assistant-autonomy') as HTMLSelectElement
    const enabled = card.querySelector('input[type="checkbox"]') as HTMLInputElement

    expect(name).toBeTruthy()
    expect(prompt).toBeTruthy()
    expect(autonomy).toBeTruthy()
    expect(enabled).toBeTruthy()
    // Seeded from GET.
    expect(name.value).toBe('Assistant')
    expect(prompt.value).toBe('Be concise.')
    expect(autonomy.value).toBe('confirm_external')
    expect(enabled.checked).toBe(true)
  })

  it('persists an edited name via PUT and the value survives a reload', async () => {
    flushSync(() => root.render(<AccountSettings />))
    await flush()

    let card = cardRoot(container)
    const name = card.querySelector('#assistant-name') as HTMLInputElement

    // Edit the name.
    flushSync(() => setInputValue(name, 'Ada'))
    await flush()

    // Submit the form.
    const form = card.querySelector('form') as HTMLFormElement
    flushSync(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    await flush()

    // PUT was sent with the new name, and the server-side store now holds it.
    expect(apiMock.put).toHaveBeenCalledWith('/assistant/config', expect.objectContaining({
      persona: expect.objectContaining({ displayName: 'Ada' }),
    }))
    expect((store.config.persona as any).displayName).toBe('Ada')

    // Simulate a reload: fresh mount reads from GET and shows the persisted name.
    root.unmount()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    flushSync(() => root.render(<AccountSettings />))
    await flush()
    card = cardRoot(container)
    expect((card.querySelector('#assistant-name') as HTMLInputElement).value).toBe('Ada')
  })
})
