// @vitest-environment jsdom
//
// obj 720115 — Settings → Connectors renders every connector from the server's
// list, connects with a token or a sign-in redirect, saves access rules, and —
// the load-bearing one — NEVER renders credential material, even when an
// (over-sharing) API response carries it. Carries forward the guarantee the old
// Google Workspace card test made (obj-706070).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ConnectorSummary } from '@operationkit/shared'
import { SettingsConnectors, signInReturnCopy } from './SettingsConnectors'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

const LEAKS = {
  token: 'ghp_LEAKEDTOKEN1234567890',
  access_token: 'ya29.LEAKED-ACCESS-TOKEN',
  refresh_token: '1//LEAKED-REFRESH-TOKEN',
  client_secret: 'GOCSPX-LEAKED-CLIENT-SECRET',
}

function github(over: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return {
    id: 'github',
    name: 'GitHub',
    description: 'Lets agents open pull requests as you.',
    products: [{ id: 'repos', name: 'Repositories', description: '' }],
    connect: { kind: 'token', fields: [{ key: 'token', label: 'Personal access token', secret: true }] },
    available: true,
    unavailable_reason: null,
    can_check: true,
    status: { state: 'not_connected', account: null, details: [], connected_at: null, checked_at: null, error: null },
    access: { agents: null, workspaces: null },
    ...over,
  }
}

function google(over: Partial<ConnectorSummary> = {}): ConnectorSummary {
  return {
    id: 'google-workspace',
    name: 'Google Workspace',
    description: 'Gmail, Calendar and Drive.',
    products: [
      { id: 'gmail', name: 'Gmail', description: '' },
      { id: 'calendar', name: 'Calendar', description: '' },
      { id: 'drive', name: 'Drive', description: '' },
    ],
    connect: { kind: 'oauth', button_label: 'Sign in with Google' },
    available: true,
    unavailable_reason: null,
    can_check: false,
    status: { state: 'not_connected', account: null, details: [], connected_at: null, checked_at: null, error: null },
    access: { agents: null, workspaces: null },
    ...over,
  }
}

const { store, apiMock } = vi.hoisted(() => {
  const store = { list: [] as unknown[] }
  const apiMock = {
    get: vi.fn((url: string) => (url === '/connectors' ? Promise.resolve(structuredClone(store.list)) : Promise.resolve(null))),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  }
  return { store, apiMock }
})

vi.mock('../../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message)
    }
  },
}))
vi.mock('../../hooks/useAgents', () => ({
  useAgents: () => ({
    agents: [
      { slug: 'operator', label: 'Operator', archived: false },
      { slug: 'librarian', label: 'Librarian', archived: false },
    ],
  }),
}))
vi.mock('../../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ slugs: ['main', 'second'], labelOf: (s: string) => s.toUpperCase() }),
}))
vi.mock('../ui', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../ui')
  return { ...actual, useConfirm: () => ({ confirm: vi.fn(async () => true), confirmDialog: null }) }
})

describe('Settings → Connectors', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    apiMock.post.mockReset()
    apiMock.put.mockReset()
    apiMock.del.mockReset()
    store.list = [github(), google()]
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  async function render() {
    flushSync(() => root.render(<SettingsConnectors />))
    await flush()
  }
  const button = (text: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined

  it('lists GitHub and Google Workspace with Gmail, Calendar and Drive', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('GitHub')
    expect(text).toContain('Google Workspace')
    for (const p of ['Gmail', 'Calendar', 'Drive']) expect(text).toContain(p)
    expect(text.match(/Not connected/g)?.length).toBe(2)
  })

  it('never renders credential material, even if the server over-shares', async () => {
    store.list = [
      { ...github({ status: { state: 'connected', account: 'octo', details: [{ label: 'Token', value: 'ends in ••••7890' }], connected_at: null, checked_at: null, error: null } }), ...LEAKS },
      { ...google({ status: { state: 'connected', account: 'owner@example.com', details: [], connected_at: null, checked_at: null, error: null } }), ...LEAKS },
    ]
    await render()
    const html = container.innerHTML
    for (const v of Object.values(LEAKS)) expect(html).not.toContain(v)
    expect(container.textContent).toContain('octo')
    expect(container.textContent).toContain('owner@example.com')
  })

  it('connects with a token, then clears the field', async () => {
    apiMock.post.mockResolvedValue({
      status: { state: 'connected', account: 'octo', details: [], connected_at: null, checked_at: null, error: null },
    })
    await render()
    const input = container.querySelector('#github-token') as HTMLInputElement
    expect(input.type).toBe('password')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'ghp_typed_by_person')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    button('Connect GitHub')!.click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/connectors/github/connect', { fields: { token: 'ghp_typed_by_person' } })
    expect(container.textContent).toContain('Connected as octo')
    expect(container.innerHTML).not.toContain('ghp_typed_by_person')
  })

  it('sends the browser to Google for sign-in connectors', async () => {
    apiMock.post.mockResolvedValue({ redirect_url: 'https://accounts.example/consent' })
    const assign = vi.fn()
    const orig = window.location
    Object.defineProperty(window, 'location', { configurable: true, value: { ...orig, assign, search: '' } })
    try {
      await render()
      button('Sign in with Google')!.click()
      await flush()
      expect(apiMock.post).toHaveBeenCalledWith('/connectors/google-workspace/connect', { fields: {} })
      expect(assign).toHaveBeenCalledWith('https://accounts.example/consent')
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: orig })
    }
  })

  it('shows why a connector is not set up instead of a connect button', async () => {
    store.list = [google({ available: false, unavailable_reason: 'Google sign-in is not set up on this server yet.' })]
    await render()
    expect(container.textContent).toContain('Not set up')
    expect(container.textContent).toContain('Google sign-in is not set up on this server yet.')
    expect(button('Sign in with Google')).toBeUndefined()
  })

  it('limits a connector to chosen agents and saves it', async () => {
    apiMock.put.mockResolvedValue({ access: { agents: ['operator'], workspaces: null } })
    store.list = [github()]
    await render()
    expect(container.textContent).toContain('Used by all agents in every workspace')
    Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Who can use it'))!.click()
    await flush()
    button('Operator')!.click()
    await flush()
    button('Save access')!.click()
    await flush()
    expect(apiMock.put).toHaveBeenCalledWith('/connectors/github/access', { agents: ['operator'], workspaces: null })
    expect(container.textContent).toContain('Used by 1 agent in every workspace')
  })

  it('disconnects after confirming', async () => {
    store.list = [github({ status: { state: 'connected', account: 'octo', details: [], connected_at: null, checked_at: null, error: null } })]
    apiMock.del.mockResolvedValue({ status: github().status })
    await render()
    button('Disconnect')!.click()
    await flush()
    expect(apiMock.del).toHaveBeenCalledWith('/connectors/github')
    expect(container.textContent).toContain('GitHub disconnected.')
  })

  it('turns the sign-in return params into plain copy', () => {
    expect(signInReturnCopy(new URLSearchParams('google=connected'))).toEqual({ ok: true, text: 'Google Workspace connected.' })
    expect(signInReturnCopy(new URLSearchParams('google=error&google_error=access_denied'))?.ok).toBe(false)
    expect(signInReturnCopy(new URLSearchParams(''))).toBeNull()
  })
})
