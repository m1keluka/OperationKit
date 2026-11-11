// @vitest-environment jsdom
//
// obj 900498 — Settings → Secrets: rotate / describe / audit log.
//
//   1. Editing an existing secret with a new value calls POST /secrets/rotate
//      (which refuses to create), never the create-or-update upsert.
//   2. Editing only the description calls PATCH /secrets/metadata and sends no value.
//   3. An edit with nothing changed is refused client-side with a clear message.
//   4. The table shows description + "Last used", and the value cell is masked.
//   5. The admin audit log panel loads GET /secrets/audit and renders its rows.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

async function flush() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

function setInputValue(node: HTMLInputElement, value: string) {
  const tracker = (node as any)._valueTracker
  node.value = value
  if (tracker) tracker.setValue('')
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

const FIXTURE_VALUE = 'fixture-new-value-123'

const { apiMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    status: number
    constructor(message: string, status = 500) { super(message); this.status = status }
  }
  const listed = [{
    id: 7, key: 'STRIPE_KEY', scopeType: 'workspace', workspace: 'example', userId: null,
    version: 3, createdBy: 1, updatedBy: 1, createdAt: '2026-11-01 10:00:00', updatedAt: '2026-11-02 10:00:00',
    description: 'billing worker', lastUsedAt: '2026-11-10 09:15:00',
  }]
  const audit = {
    entries: [
      { id: 2, actorUserId: 1, actorUsername: 'operator', action: 'reveal_attempt', scope: 'workspace:example', key: 'STRIPE_KEY', at: '2026-11-10 09:20:00', secretId: 7, source: 'ui', detail: 'refused:write-only' },
      { id: 1, actorUserId: 1, actorUsername: 'operator', action: 'rotate', scope: 'workspace:example', key: 'STRIPE_KEY', at: '2026-11-10 09:00:00', secretId: 7, source: 'ui', detail: null },
    ],
    nextBeforeId: null,
  }
  const apiMock = {
    get: vi.fn((url: string) => {
      if (url === '/secrets/principals') {
        return Promise.resolve({ organizations: [{ slug: 'example', name: 'Example Growth' }], users: [{ id: 1, username: 'operator' }], canUseGlobal: true })
      }
      if (url.startsWith('/secrets/audit')) return Promise.resolve(structuredClone(audit))
      if (url.startsWith('/secrets/rotation-flags')) return Promise.resolve([])
      if (url.startsWith('/secrets')) return Promise.resolve(structuredClone(listed))
      return Promise.resolve(null)
    }),
    post: vi.fn((_url: string, _body: any) => Promise.resolve({})),
    patch: vi.fn((_url: string, _body: any) => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve()),
  }
  return { apiMock, ApiErrorMock }
})

vi.mock('../lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin', username: 'operator' } }) }))
vi.mock('./ui', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  Skeleton: () => <div />,
  useConfirm: () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmDialog: null }),
}))

import { SecretsPage } from './SecretsPage'

describe('Secrets — rotate, describe, audit (obj 900498)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    apiMock.post.mockClear()
    apiMock.patch.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  const button = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent === label) as HTMLButtonElement | undefined

  async function openEdit() {
    flushSync(() => root.render(<SecretsPage />))
    await flush()
    flushSync(() => button('Edit')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
  }

  async function submit() {
    const form = container.querySelector('[data-testid="modal-submit"]')!.closest('form')!
    flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
  }

  it('renders description, last used and a masked value — never a plaintext', async () => {
    flushSync(() => root.render(<SecretsPage />))
    await flush()
    expect(container.querySelector('[data-testid="secret-description"]')?.textContent).toBe('billing worker')
    expect(container.querySelector('[data-testid="secret-last-used"]')?.textContent).toBe('2026-11-10 09:15')
    expect(container.textContent).toContain('••••••')
  })

  it('a new value in the edit modal rotates via POST /secrets/rotate', async () => {
    await openEdit()
    expect(container.querySelector('[data-testid="modal-current-value"]')?.textContent).toContain('write-only')
    const valueInput = container.querySelector('[data-testid="modal-value"]') as HTMLInputElement
    expect(valueInput.type).toBe('password')
    flushSync(() => setInputValue(valueInput, FIXTURE_VALUE))
    await flush()
    expect(container.querySelector('[data-testid="modal-submit"]')?.textContent).toBe('Rotate value')
    await submit()
    expect(apiMock.post).toHaveBeenCalledTimes(1)
    const [url, body] = apiMock.post.mock.calls[0]!
    expect(url).toBe('/secrets/rotate')
    expect(body).toMatchObject({ scopeType: 'workspace', workspace: 'example', key: 'STRIPE_KEY', value: FIXTURE_VALUE })
    expect(body).not.toHaveProperty('description')
    expect(apiMock.patch).not.toHaveBeenCalled()
  })

  it('a description-only edit PATCHes metadata and sends no value', async () => {
    await openEdit()
    const desc = container.querySelector('[data-testid="modal-description"]') as HTMLInputElement
    expect(desc.value).toBe('billing worker')
    flushSync(() => setInputValue(desc, 'billing worker (live)'))
    await flush()
    expect(container.querySelector('[data-testid="modal-submit"]')?.textContent).toBe('Save')
    await submit()
    expect(apiMock.post).not.toHaveBeenCalled()
    expect(apiMock.patch).toHaveBeenCalledTimes(1)
    const [url, body] = apiMock.patch.mock.calls[0]!
    expect(url).toBe('/secrets/metadata')
    expect(body).toEqual({ scopeType: 'workspace', workspace: 'example', userId: undefined, key: 'STRIPE_KEY', description: 'billing worker (live)' })
  })

  it('refuses an edit that changes nothing', async () => {
    await openEdit()
    await submit()
    expect(apiMock.post).not.toHaveBeenCalled()
    expect(apiMock.patch).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Nothing to save')
  })

  it('admin audit log panel loads /secrets/audit and labels actions', async () => {
    flushSync(() => root.render(<SecretsPage />))
    await flush()
    const toggle = container.querySelector('[data-testid="audit-log-toggle"]') as HTMLButtonElement
    expect(toggle).toBeTruthy()
    flushSync(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    const rows = container.querySelectorAll('[data-testid="audit-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('Reveal attempt (refused)')
    expect(rows[1]!.textContent).toContain('Rotated')
    expect(apiMock.get.mock.calls.some(([u]) => String(u).startsWith('/secrets/audit?limit=50'))).toBe(true)
  })
})
