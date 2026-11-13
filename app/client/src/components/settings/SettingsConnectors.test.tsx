// @vitest-environment jsdom
//
// obj 720115 — Settings → Connectors renders every connector from the server's
// list, connects with a token or a sign-in redirect, saves access rules, and —
// obj 900682 — the main view lists ONLY connected integrations; connecting a new
// one goes through New Integration → Browse (setup guides) or Make my own (the
// Integrations bot card). And —
// the load-bearing one — NEVER renders credential material, even when an
// (over-sharing) API response carries it. Carries forward the guarantee the old
// Google Workspace card test made (obj-706070).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ConnectorSummary } from '@operationkit/shared'
import { SettingsConnectors, signInReturnCopy } from './SettingsConnectors'
import { NavContext } from '../../context/nav'

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
    auth_path: 'api_key',
    oauth_setup: null,
    setup_guide: null,
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
    auth_path: 'oauth_guided',
    oauth_setup: { redirect_uri: 'https://example.test/api/user/connector-oauth/google-workspace/callback', scopes: ['gmail'] },
    setup_guide: 'docs/connectors/guides/google-workspace.md',
    ...over,
  }
}

const CONNECTED = { state: 'connected' as const, account: 'octo', details: [], connected_at: null, checked_at: null, error: null }

const { store, apiMock } = vi.hoisted(() => {
  const store = { list: [] as unknown[], mcp: [] as unknown[], catalog: [] as unknown[], builds: [] as unknown[] }
  const apiMock = {
    get: vi.fn((url: string) => {
      if (url === '/connectors') return Promise.resolve(structuredClone(store.list))
      if (url.startsWith('/mcp-servers/catalog')) return Promise.resolve(structuredClone(store.catalog))
      if (url.startsWith('/mcp-servers?')) return Promise.resolve(structuredClone(store.mcp))
      if (url.startsWith('/integrations/builds?')) return Promise.resolve(structuredClone(store.builds))
      return Promise.resolve(null)
    }),
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
// Sprint 7.7: the page reads the role to decide who may edit the opt-in shared-app panel.
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: 'member' } }),
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
// obj 900620 — the page now also renders the MCP servers section, which reads
// the signed-in user's role to gate add/remove.
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'admin', role: 'admin', workspaces: [] } }),
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
    store.mcp = []
    store.catalog = []
    store.builds = []
    window.history.replaceState({}, '', '/settings/integrations')
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  const nav = vi.fn()
  async function render(search = '') {
    window.history.replaceState({}, '', `/settings/integrations${search}`)
    nav.mockReset()
    flushSync(() => root.render(<NavContext.Provider value={nav}><SettingsConnectors /></NavContext.Provider>))
    await flush()
  }
  /** Open New Integration → Browse and expand one row's setup card. */
  async function openSetup(name: string) {
    await render('?new=browse')
    const row = container.querySelector(`[data-testid="browse-${name}"]`) as HTMLElement
    expect(row).toBeTruthy()
    Array.from(row.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Set up')!.click()
    await flush()
  }
  const button = (text: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text) as HTMLButtonElement | undefined

  it('main view lists only connected integrations', async () => {
    store.list = [github({ status: CONNECTED }), google()]
    await render()
    const text = container.textContent ?? ''
    expect(text).toContain('GitHub')
    expect(text).toContain('Connected as')
    expect(text).not.toContain('Google Workspace')
    expect(text).not.toContain('Not connected')
    expect(button('New Integration')).toBeTruthy()
  })

  it('with nothing connected, says so and offers New Integration', async () => {
    await render()
    expect(container.textContent).toContain('No integrations connected yet')
    expect(container.textContent).not.toContain('GitHub')
  })

  it('New Integration offers Browse (setup guides) and Make my own', async () => {
    await render()
    button('New Integration')!.click()
    await flush()
    expect(window.location.search).toBe('?new=1')
    expect(container.querySelector('[data-testid="choose-browse"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="choose-make"]')).toBeTruthy()
    ;(container.querySelector('[data-testid="choose-browse"]') as HTMLButtonElement).click()
    await flush()
    // Every not-connected integration with its guide; MCP catalog entries get the 900620 route.
    const text = container.textContent ?? ''
    expect(text).toContain('Google Workspace')
    expect(text).toContain('GitHub')
    expect(text).toContain('Setup guide')
    expect(text).toContain('docs/connectors/guides/google-workspace.md')
    expect(text).toContain('Any remote MCP server')
  })

  it('New Integration has a first-class Add an MCP card that opens the custom-URL dialog (obj 900745)', async () => {
    await render('?new=1')
    const cards = Array.from(container.querySelectorAll('[data-testid^="choose-"]')).map(el => el.getAttribute('data-testid'))
    expect(cards).toEqual(['choose-browse', 'choose-mcp', 'choose-make'])
    const mcp = container.querySelector('[data-testid="choose-mcp"]') as HTMLButtonElement
    expect(mcp.textContent).toContain('Add an MCP')
    expect(mcp.disabled).toBe(false)
    expect(document.body.textContent).not.toContain('Connect an MCP server')
    mcp.click()
    await flush()
    // The existing connect-any-MCP dialog (#900620 / #900649), on its Paste a URL tab.
    expect(document.body.textContent).toContain('Connect an MCP server')
    const urlTab = Array.from(document.body.querySelectorAll('[role="tab"]')).find(t => t.textContent === 'Paste a URL')
    expect(urlTab?.getAttribute('aria-selected')).toBe('true')
  })

  it('Browse offers catalog MCP servers as a workspace MCP server (admin)', async () => {
    store.catalog = [{ id: 'linear', name: 'Linear', description: 'Issues and projects.', mcp_url: 'https://mcp.linear.app/mcp' }]
    await render('?new=browse')
    const row = container.querySelector('[data-testid="browse-linear"]') as HTMLElement
    expect(row.textContent).toContain('MCP server')
    expect(Array.from(row.querySelectorAll('button')).some(b => b.textContent?.includes('Add as workspace MCP server'))).toBe(true)
  })

  it('Make my own starts the Integrations bot and opens its chat', async () => {
    apiMock.post.mockResolvedValue({ ok: true, objective_id: 4242, workspace: 'main', started: true, start_detail: null, secret_form_enabled: true })
    await render('?new=make')
    const target = container.querySelector('input[id$="-target"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(target, 'Acme CRM')
    target.dispatchEvent(new Event('input', { bubbles: true }))
    await flush()
    button('Start the Integrations bot')!.click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/integrations/builder', { workspace: 'main', target: 'Acme CRM' })
    expect(nav).toHaveBeenCalledWith('/o/4242')
  })

  it('lists Tools an Integrations bot built as connected', async () => {
    store.list = []
    store.builds = [
      { id: 1, objective_id: 77, workspace: 'main', kind: 'tool', ref: 'acme', name: 'Acme', description: 'Acme CRM.', secret_names: ['ACME_API_KEY'], created_at: '' },
      { id: 2, objective_id: 77, workspace: 'main', kind: 'mcp_server', ref: '9', name: 'Acme MCP', description: null, secret_names: [], created_at: '' },
    ]
    await render()
    const built = container.querySelector('[data-testid="built-integrations"]') as HTMLElement
    expect(built.textContent).toContain('Acme')
    expect(built.textContent).toContain('ACME_API_KEY')
    expect(built.textContent).not.toContain('Acme MCP') // MCP builds already show in the MCP list
    expect(container.textContent).not.toContain('No integrations connected yet')
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

  it('connects with a token from Browse, then clears the field and shows it as connected', async () => {
    apiMock.post.mockResolvedValue({
      status: { state: 'connected', account: 'octo', details: [], connected_at: null, checked_at: null, error: null },
    })
    await openSetup('github')
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
    // Back on the connected list.
    expect(container.querySelector('[data-testid="new-integration"]')).toBeNull()
    expect(window.location.search).toBe('')
  })

  it('sends the browser to Google for sign-in connectors', async () => {
    apiMock.post.mockResolvedValue({ redirect_url: 'https://accounts.example/consent' })
    const assign = vi.fn()
    const orig = window.location
    await openSetup('google-workspace')
    Object.defineProperty(window, 'location', { configurable: true, value: { ...orig, assign, search: '' } })
    try {
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
    await openSetup('google-workspace')
    expect(container.textContent).toContain('Not set up')
    expect(container.textContent).toContain('Google sign-in is not set up on this server yet.')
    expect(button('Sign in with Google')).toBeUndefined()
  })

  it('limits a connector to chosen agents and saves it', async () => {
    apiMock.put.mockResolvedValue({ access: { agents: ['operator'], workspaces: null } })
    store.list = [github({ status: CONNECTED })]
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
    // No longer connected → gone from the main view (it is back under New Integration → Browse).
    expect(container.textContent).not.toContain('Connected as')
  })

  it('turns the sign-in return params into plain copy', () => {
    expect(signInReturnCopy(new URLSearchParams('google=connected'))).toEqual({ ok: true, text: 'Google Workspace connected.' })
    expect(signInReturnCopy(new URLSearchParams('google=error&google_error=access_denied'))?.ok).toBe(false)
    expect(signInReturnCopy(new URLSearchParams(''))).toBeNull()
  })
})
