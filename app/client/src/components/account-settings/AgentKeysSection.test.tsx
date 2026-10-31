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

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), del: vi.fn() },
}))

vi.mock('../../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message)
    }
  },
}))

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
  created_at: '2026-10-01 10:00:00',
  last_used_at: '2026-10-04 09:30:00',
  revoked_at: null,
}

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
    apiMock.get.mockReset().mockResolvedValue({ keys: [EXISTING] })
    apiMock.post.mockReset()
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
    })
    const shown = container.querySelector('input[readonly]') as HTMLInputElement
    expect(shown.value).toBe('cc_live_PLAINTEXT_ONCE_ZZ99')
    expect(container.textContent).toMatch(/will not be shown again/)

    button(container, 'Done').click()
    await flush()
    expect(container.querySelector('input[readonly]')).toBeNull()
    expect(container.textContent).not.toContain('cc_live_PLAINTEXT_ONCE_ZZ99')
  })

  it('revokes a key', async () => {
    flushSync(() => root.render(<AgentKeysSection />))
    await flush()
    button(container, 'Revoke').click()
    await flush()
    expect(apiMock.del).toHaveBeenCalledWith('/auth/agent-keys/7')
  })
})
