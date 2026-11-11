// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { AgentKeysSection } from './AgentKeysSection'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

const { apiMock, ApiErrorStub } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
  // Hoisted so a test can THROW the same class the component narrows against
  // when it turns a failed load into a sentence (obj 900303).
  ApiErrorStub: class ApiError extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message)
    }
  },
}))

vi.mock('../../lib/api', () => ({ api: apiMock, ApiError: ApiErrorStub }))

vi.mock('../../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({
    workspaces: [{ slug: 'example' }, { slug: 'example2' }],
    labelOf: (s: string) => s,
  }),
}))

vi.mock('../ui', async () => {
  const actual = await vi.importActual<typeof import('../ui')>('../ui')
  return { ...actual, useConfirm: () => ({ confirm: vi.fn(async () => true), confirmDialog: null }) }
})

const EXISTING = {
  id: 7,
  label: 'Grok: Example',
  last4: 'AbCd',
  scopes: ['board:read', 'board:write'],
  workspaces: ['example'],
  // A key that has not been granted any connected account yet.
  connectors: [],
  created_at: '2026-10-01 10:00:00',
  last_used_at: '2026-10-04 09:30:00',
  revoked_at: null,
}

/**
 * The connector catalogue the picker offers — names only, never credentials.
 *
 * obj 900303: this used to be `{ connectors: [...] }`, an envelope the server
 * has never sent. GET /api/connectors answers with a BARE ARRAY, the component
 * read `res.connectors` off it, and this mock agreed with the component instead
 * of with the server — so a picker that was permanently blank in production had
 * a green suite. The mock now matches routes/connectors.ts, which has its own
 * test pinning the array shape.
 */
const CONNECTOR_LIST = [
  { id: 'github', name: 'GitHub' },
  { id: 'google-workspace', name: 'Google Workspace' },
]

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll('button')).find(x => x.textContent?.trim() === text)
  if (!b) throw new Error(`no button "${text}"`)
  return b as HTMLButtonElement
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('AgentKeysSection', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    apiMock.get.mockReset().mockImplementation(async (p: string) =>
      p === '/connectors' ? CONNECTOR_LIST : { keys: [EXISTING] })
    apiMock.post.mockReset()
    apiMock.patch.mockReset().mockResolvedValue({ ...EXISTING, connectors: ['github'] })
    apiMock.del.mockReset().mockResolvedValue({ ok: true })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  it('lists keys with label, last4, scopes, workspaces and last used', async () => {
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    expect(apiMock.get).toHaveBeenCalledWith('/auth/agent-keys')
    const text = container.textContent ?? ''
    expect(text).toContain('Grok: Example')
    expect(text).toContain('cc_live_••••AbCd')
    expect(text).toContain('board:write')
    expect(text).toMatch(/Last used (?!never)/)
  })

  it('creates a labeled key with chosen scopes + workspace and shows plaintext once', async () => {
    apiMock.post.mockResolvedValue({
      ...EXISTING,
      id: 8,
      label: 'Grok: Inbox',
      last4: 'ZZ99',
      scopes: ['board:read', 'board:write', 'board:start', 'board:cancel', 'board:done', 'vault:read', 'vault:write'],
      workspaces: ['example2'],
      last_used_at: null,
      token: 'cc_live_PLAINTEXT_ONCE_ZZ99',
    })
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'New agent key').click()
    await flush()

    setInput(container.querySelector('#agent-key-label') as HTMLInputElement, 'Grok: Inbox')
    const doneBox = Array.from(container.querySelectorAll('label')).find(l => l.textContent?.startsWith('board:done'))!
      .querySelector('input') as HTMLInputElement
    expect(doneBox.checked).toBe(false) // human signature off by default
    doneBox.click()
    button(container, 'Only some').click()
    await flush()
    button(container, 'example2').click()
    await flush()
    button(container, 'Create key').click()
    await flush()

    expect(apiMock.post).toHaveBeenCalledWith('/auth/agent-keys', {
      label: 'Grok: Inbox',
      scopes: ['board:read', 'board:write', 'board:start', 'board:cancel', 'board:done', 'vault:read', 'vault:write'],
      workspaces: ['example2'],
      // obj 900303: a new key follows its owner's access unless narrowed here.
      connectors: ['owner'],
    })
    const shown = container.querySelector('input[readonly]') as HTMLInputElement
    expect(shown.value).toBe('cc_live_PLAINTEXT_ONCE_ZZ99')
    expect(container.textContent).toMatch(/will not be shown again/)

    button(container, 'Done').click()
    await flush()
    expect(container.querySelector('input[readonly]')).toBeNull()
    expect(container.textContent).not.toContain('cc_live_PLAINTEXT_ONCE_ZZ99')
  })

  it('shows that a key holds no connected account until one is granted', async () => {
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    expect(container.textContent).toContain('no connectors')
  })

  it('grants one of the owner\'s own connectors to an existing key', async () => {
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'Connectors').click()
    await flush()
    button(container, 'Pick specific accounts').click()
    await flush()
    button(container, 'GitHub').click()
    await flush()
    button(container, 'Save').click()
    await flush()
    expect(apiMock.patch).toHaveBeenCalledWith('/auth/agent-keys/7', { connectors: ['github'] })
  })

  // ── obj 900303 ────────────────────────────────────────────────────────────

  it('offers the real catalogue — the bare array the server actually sends', async () => {
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'New agent key').click()
    await flush()
    button(container, 'Pick specific accounts').click()
    await flush()
    expect(container.textContent).toContain('GitHub')
    expect(container.textContent).toContain('Google Workspace')
    expect(container.textContent).not.toContain('No connectors available')
  })

  it('says you have none ONLY when the catalogue really is empty', async () => {
    apiMock.get.mockImplementation(async (p: string) => (p === '/connectors' ? [] : { keys: [EXISTING] }))
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'New agent key').click()
    await flush()
    button(container, 'Pick specific accounts').click()
    await flush()
    expect(container.textContent).toMatch(/have not connected any accounts yet/i)
  })

  it('reports a FAILED load as a failure, never as "you have none"', async () => {
    apiMock.get.mockImplementation(async (p: string) => {
      if (p === '/connectors') throw new ApiErrorStub(500, { error: 'Connector service is down.' }, 'boom')
      return { keys: [EXISTING] }
    })
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'New agent key').click()
    await flush()
    button(container, 'Pick specific accounts').click()
    await flush()
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Connector service is down.')
    expect(container.textContent).not.toMatch(/have not connected any accounts yet/i)
    expect(container.textContent).not.toContain('No connectors available')
    expect(button(container, 'Retry')).toBeTruthy()
  })

  it('a shape it cannot read is a failure too, not an empty catalogue', async () => {
    apiMock.get.mockImplementation(async (p: string) =>
      p === '/connectors' ? { error: 'Authentication required' } : { keys: [EXISTING] })
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'New agent key').click()
    await flush()
    button(container, 'Pick specific accounts').click()
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/does not understand/i)
  })

  it('retries the catalogue load on demand', async () => {
    let fail = true
    apiMock.get.mockImplementation(async (p: string) => {
      if (p !== '/connectors') return { keys: [EXISTING] }
      if (fail) { fail = false; throw new ApiErrorStub(503, { error: 'Temporarily unavailable.' }, 'boom') }
      return CONNECTOR_LIST
    })
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'New agent key').click()
    await flush()
    button(container, 'Pick specific accounts').click()
    await flush()
    button(container, 'Retry').click()
    await flush()
    expect(container.textContent).toContain('GitHub')
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('creates a key that follows the owner by default, with no ticking', async () => {
    apiMock.post.mockResolvedValue({ ...EXISTING, id: 9, label: 'Inheriting bot', connectors: ['owner'], token: 'cc_live_X' })
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'New agent key').click()
    await flush()
    setInput(container.querySelector('#agent-key-label') as HTMLInputElement, 'Inheriting bot')
    button(container, 'Create key').click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/auth/agent-keys', expect.objectContaining({ connectors: ['owner'] }))
  })

  it('lets the owner choose "None" instead of the inherit default', async () => {
    apiMock.post.mockResolvedValue({ ...EXISTING, id: 10, label: 'Locked bot', connectors: [], token: 'cc_live_Y' })
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'New agent key').click()
    await flush()
    setInput(container.querySelector('#agent-key-label') as HTMLInputElement, 'Locked bot')
    button(container, 'No connected accounts').click()
    await flush()
    button(container, 'Create key').click()
    await flush()
    expect(apiMock.post).toHaveBeenCalledWith('/auth/agent-keys', expect.objectContaining({ connectors: [] }))
  })

  it('shows an inheriting key as following the owner, not as a list of ids', async () => {
    apiMock.get.mockImplementation(async (p: string) =>
      p === '/connectors' ? CONNECTOR_LIST : { keys: [{ ...EXISTING, connectors: ['owner'] }] })
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    expect(container.textContent).toContain('connectors: follows your access')
    expect(container.textContent).not.toContain('no connectors')
  })

  it('does not widen an explicitly restricted key when its owner only opens the editor', async () => {
    apiMock.get.mockImplementation(async (p: string) =>
      p === '/connectors' ? CONNECTOR_LIST : { keys: [{ ...EXISTING, connectors: ['github'] }] })
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'Connectors').click()
    await flush()
    button(container, 'Save').click()
    await flush()
    // Saving without changing anything re-states the SAME restriction.
    expect(apiMock.patch).toHaveBeenCalledWith('/auth/agent-keys/7', { connectors: ['github'] })
  })

  it('moves an existing restricted key to inherit only on an explicit choice', async () => {
    apiMock.get.mockImplementation(async (p: string) =>
      p === '/connectors' ? CONNECTOR_LIST : { keys: [{ ...EXISTING, connectors: ['github'] }] })
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'Connectors').click()
    await flush()
    button(container, 'Whatever I can use').click()
    await flush()
    button(container, 'Save').click()
    await flush()
    expect(apiMock.patch).toHaveBeenCalledWith('/auth/agent-keys/7', { connectors: ['owner'] })
  })

  it('says plainly that connectors are not Secrets', async () => {
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'New agent key').click()
    await flush()
    expect(container.textContent).toMatch(/Secrets/)
    expect(container.textContent).toMatch(/never more than you have right now|never exceeds your own access/i)
  })

  it('labels a migrated legacy key so its reach is visible and narrowable', async () => {
    apiMock.get.mockImplementation(async (p: string) =>
      p === '/connectors' ? CONNECTOR_LIST : { keys: [{ ...EXISTING, connectors: ['*'] }] })
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    expect(container.textContent).toContain('all connectors (legacy)')
  })

  it('revokes a key', async () => {
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'Revoke').click()
    await flush()
    expect(apiMock.del).toHaveBeenCalledWith('/auth/agent-keys/7')
  })
})
