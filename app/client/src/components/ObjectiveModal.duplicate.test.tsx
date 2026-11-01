// @vitest-environment jsdom
// obj 64 Part C — the create form on a 409 duplicate_24h response shows the existing
// card (id + link) and a "Create anyway" button that resubmits with force: true.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { Objective } from '@operationkit/shared'
import { parseDuplicateError } from '../lib/duplicateGuard'

async function flush() {
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  flushSync(() => {})
  await Promise.resolve()
}

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin', username: 'mike' } }) }))
vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ slugs: ['example'], labelOf: (s: string) => s, agentPoolOf: () => [] }),
}))
vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn((url: string) => {
      if (url === '/models') return Promise.resolve({ models: [], default: '' })
      if (url === '/workspaces-config') return Promise.resolve({ workspaces: {} })
      return Promise.resolve([])
    }),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve()),
  },
}))
vi.mock('./ui', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  useConfirm: () => ({ confirm: vi.fn(), confirmDialog: null }),
}))

import { ObjectiveModal } from './ObjectiveModal'

/** Shaped like the real ApiError thrown by lib/api on a 409. */
function duplicateError(existingId: number) {
  return Object.assign(new Error('Duplicate of open card'), {
    status: 409,
    body: { reason: 'duplicate_24h', duplicate: true, existing_id: existingId, existing: { id: existingId, title: 'Fix login', status: 'working' } },
  })
}

function setNativeValue(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, value)
}

describe('parseDuplicateError', () => {
  it('recognises only a 409 duplicate_24h body', () => {
    expect(parseDuplicateError(duplicateError(7))).toEqual({ id: 7, title: 'Fix login', status: 'working' })
    expect(parseDuplicateError(Object.assign(new Error('cap'), { status: 409, body: { error: 'cap' } }))).toBeNull()
    expect(parseDuplicateError(new Error('plain'))).toBeNull()
    expect(parseDuplicateError(null)).toBeNull()
  })
})

describe('ObjectiveModal — duplicate refusal + Create anyway', () => {
  let container: HTMLElement
  let root: Root
  const onClose = vi.fn()
  const onCreate = vi.fn()
  const onUpdate = vi.fn(() => Promise.resolve({} as Objective))
  const onDelete = vi.fn(() => Promise.resolve())

  beforeEach(() => {
    onClose.mockClear()
    onCreate.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  it('shows the existing card and resubmits with force:true', async () => {
    onCreate
      .mockImplementationOnce(() => Promise.reject(duplicateError(4242)))
      .mockImplementationOnce(() => Promise.resolve({ id: 5000 } as Objective))

    flushSync(() =>
      root.render(
        <ObjectiveModal objective={null} workspace="example" onClose={onClose} onCreate={onCreate} onUpdate={onUpdate} onDelete={onDelete} />,
      ),
    )
    await flush()
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    const title = dialog.querySelector('textarea') as HTMLTextAreaElement
    setNativeValue(title, 'Fix login')
    flushSync(() => title.dispatchEvent(new Event('input', { bubbles: true })))

    const form = dialog.querySelector('form') as HTMLFormElement
    flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect((onCreate.mock.calls[0][0] as Record<string, unknown>).force).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()
    const notice = dialog.querySelector('[data-testid="duplicate-notice"]') as HTMLElement
    expect(notice).toBeTruthy()
    expect(notice.textContent).toContain('#4242')
    expect((dialog.querySelector('[data-testid="duplicate-link"]') as HTMLAnchorElement).getAttribute('href')).toBe('/o/4242')

    const anyway = dialog.querySelector('[data-testid="create-anyway"]') as HTMLButtonElement
    expect(anyway.textContent).toContain('Create anyway')
    flushSync(() => anyway.click())
    await flush()

    expect(onCreate).toHaveBeenCalledTimes(2)
    const second = onCreate.mock.calls[1][0] as Record<string, unknown>
    expect(second.force).toBe(true)
    expect(second.title).toBe('Fix login')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a non-duplicate error still renders as the plain error banner', async () => {
    onCreate.mockImplementationOnce(() => Promise.reject(Object.assign(new Error('Maximum sessions'), { status: 409, body: { error: 'Maximum sessions' } })))
    flushSync(() =>
      root.render(
        <ObjectiveModal objective={null} workspace="example" onClose={onClose} onCreate={onCreate} onUpdate={onUpdate} onDelete={onDelete} />,
      ),
    )
    await flush()
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement
    const title = dialog.querySelector('textarea') as HTMLTextAreaElement
    setNativeValue(title, 'Other')
    flushSync(() => title.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() => (dialog.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(dialog.querySelector('[data-testid="duplicate-notice"]')).toBeNull()
    expect(dialog.textContent).toContain('Maximum sessions')
  })
})
