// @vitest-environment jsdom
//
// obj 706458 — the Secrets create modal scopes ONE secret to MANY organizations.
//
// What this pins down:
//   1. At Organization scope the create modal offers a CHECKBOX LIST of the
//      caller's organizations, not a single-select <select>. (Edit keeps the
//      single-select — a row IS one scope.)
//   2. Submitting with N ticked organizations fires N independent
//      `POST /secrets`, one per organization, each carrying that organization's
//      slug. No schema change, no batch endpoint.
//   3. A PARTIAL failure is reported honestly: the modal stays open and names
//      which organizations got the secret and which did not.
//   4. The scope explanation is rendered INLINE under the Scope selector, not
//      only as a hover `title=` tooltip.
//   5. A member only ever sees the organizations `/secrets/principals` returned
//      for them (the endpoint scopes by membership), so the multi-select cannot
//      widen a member's reach.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

// Production React build in the container omits `act`; drive commits with flushSync.
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

function setSelectValue(node: HTMLSelectElement, value: string) {
  const tracker = (node as any)._valueTracker
  node.value = value
  if (tracker) tracker.setValue('')
  node.dispatchEvent(new Event('change', { bubbles: true }))
}

const { state, apiMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    status: number
    constructor(message: string, status = 500) { super(message); this.status = status }
  }
  const state = {
    principals: {
      organizations: [
        { slug: 'example', name: 'Example Org' },
        { slug: 'example2', name: 'Example Shop' },
        { slug: 'personal', name: 'Personal' },
      ],
      users: [{ id: 1, username: 'admin' }],
      canUseGlobal: true,
    },
    /** Slugs whose POST /secrets should reject (simulated partial failure). */
    failOrgs: [] as string[],
    posts: [] as any[],
  }
  const apiMock = {
    get: vi.fn((url: string) => {
      if (url === '/secrets/principals') return Promise.resolve(structuredClone(state.principals))
      if (url.startsWith('/secrets')) return Promise.resolve([])
      return Promise.resolve(null)
    }),
    post: vi.fn((url: string, body: any) => {
      if (url === '/secrets') {
        state.posts.push(body)
        if (state.failOrgs.includes(body.workspace)) {
          return Promise.reject(new ApiErrorMock('forbidden', 403))
        }
        return Promise.resolve({ id: state.posts.length })
      }
      return Promise.resolve({})
    }),
    put: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve()),
  }
  return { state, apiMock, ApiErrorMock }
})

vi.mock('../lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin', username: 'admin' } }) }))
vi.mock('./ui', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  Skeleton: () => <div />,
  useConfirm: () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmDialog: null }),
}))

import { SecretsPage } from './SecretsPage'

describe('Secrets create modal — multi-organization scoping (obj 706458)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    state.failOrgs = []
    state.posts = []
    state.principals = {
      organizations: [
        { slug: 'example', name: 'Example Org' },
        { slug: 'example2', name: 'Example Shop' },
        { slug: 'personal', name: 'Personal' },
      ],
      users: [{ id: 1, username: 'admin' }],
      canUseGlobal: true,
    }
    apiMock.post.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  /** Mount, open "New", switch the modal to Organization scope. */
  async function openCreateAtOrgScope() {
    flushSync(() => root.render(<SecretsPage />))
    await flush()
    const newBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === '+ New')!
    flushSync(() => newBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    const scopeSelect = container.querySelector('[data-testid="modal-scope-type"]') as HTMLSelectElement
    flushSync(() => setSelectValue(scopeSelect, 'workspace'))
    await flush()
  }

  function tick(slug: string) {
    const box = container.querySelector(`[data-testid="modal-org-checkbox-${slug}"]`) as HTMLInputElement
    expect(box, `checkbox for ${slug} present`).toBeTruthy()
    flushSync(() => box.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  async function fillAndSubmit(key: string, value: string) {
    const keyInput = container.querySelector('input[type="text"]') as HTMLInputElement
    const valueInput = container.querySelector('input[type="password"]') as HTMLInputElement
    flushSync(() => setInputValue(keyInput, key))
    flushSync(() => setInputValue(valueInput, value))
    await flush()
    const form = container.querySelector('form') as HTMLFormElement
    flushSync(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
  }

  it('offers a checkbox multi-select of organizations (no single-select) at Organization scope', async () => {
    await openCreateAtOrgScope()

    // The old single-select is GONE at create time…
    expect(container.querySelector('[data-testid="modal-scope-organization"]')).toBeNull()
    // …replaced by one checkbox per organization the principals endpoint returned.
    const list = container.querySelector('[data-testid="modal-scope-organizations"]')!
    expect(list).toBeTruthy()
    const boxes = list.querySelectorAll('input[type="checkbox"]')
    expect(boxes.length).toBe(3)
  })

  it('creates one secret row per selected organization', async () => {
    await openCreateAtOrgScope()
    tick('example')
    tick('example2')
    await flush()
    await fillAndSubmit('OPENAI_API_KEY', 'sk-test')

    const creates = state.posts.filter(p => p.key === 'OPENAI_API_KEY')
    expect(creates.length).toBe(2)
    expect(creates.map(c => c.workspace).sort()).toEqual(['example', 'example2'])
    // Every row is the SAME key/value at the SAME scope type — one row per org.
    expect(creates.every(c => c.scopeType === 'workspace' && c.value === 'sk-test')).toBe(true)
    // No batch endpoint was invented.
    expect(apiMock.post.mock.calls.every(([url]) => url === '/secrets')).toBe(true)
  })

  it('reports exactly which organizations succeeded and which failed on a partial failure', async () => {
    state.failOrgs = ['example2']
    await openCreateAtOrgScope()
    tick('example')
    tick('example2')
    await flush()
    await fillAndSubmit('STRIPE_KEY', 'sk-live')

    // Both were attempted.
    expect(state.posts.filter(p => p.key === 'STRIPE_KEY').length).toBe(2)

    const report = container.querySelector('[data-testid="modal-fanout-results"]')
    expect(report, 'partial-failure report is rendered').toBeTruthy()
    // Named per organization — not an all-or-nothing claim.
    expect(container.querySelector('[data-testid="fanout-ok-example"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="fanout-fail-example2"]')).toBeTruthy()
    expect(report!.textContent).toContain('Created in 1 of 2 organizations')
    expect(report!.textContent).toContain('Example Org')
    expect(report!.textContent).toContain('Example Shop')

    // The modal stays OPEN and only the failed organization stays ticked, so
    // resubmitting retries just that one.
    expect(container.querySelector('[role="dialog"]')).toBeTruthy()
    const exampleBox = container.querySelector('[data-testid="modal-org-checkbox-example"]') as HTMLInputElement
    const example2Box = container.querySelector('[data-testid="modal-org-checkbox-example2"]') as HTMLInputElement
    expect(exampleBox.checked).toBe(false)
    expect(example2Box.checked).toBe(true)
  })

  it('refuses to submit with no organization ticked', async () => {
    await openCreateAtOrgScope()
    // Nothing ticked (admin default scope is global, so no org is preselected).
    await fillAndSubmit('SOME_KEY', 'v')
    expect(state.posts.length).toBe(0)
    expect(container.textContent).toContain('Pick at least one organization')
  })

  it('shows the scope explanation inline under the Scope selector, not only as a tooltip', async () => {
    await openCreateAtOrgScope()
    const hint = container.querySelector('[data-testid="modal-scope-hint"]')!
    expect(hint).toBeTruthy()
    // Rendered text (visible), not a title= attribute.
    expect(hint.textContent).toContain('selected organization(s)')
    expect(hint.textContent).not.toBe('')

    // And Command Center reads as "everywhere".
    const scopeSelect = container.querySelector('[data-testid="modal-scope-type"]') as HTMLSelectElement
    flushSync(() => setSelectValue(scopeSelect, 'global'))
    await flush()
    expect(container.querySelector('[data-testid="modal-scope-hint"]')!.textContent).toContain('everywhere')
  })

  it('only offers the organizations the principals endpoint scoped to the caller', async () => {
    // A member: /secrets/principals returns only their memberships.
    state.principals = {
      organizations: [{ slug: 'example', name: 'Example Org' }],
      users: [{ id: 2, username: 'member' }],
      canUseGlobal: false,
    }
    await openCreateAtOrgScope()

    const boxes = container.querySelectorAll('[data-testid="modal-scope-organizations"] input[type="checkbox"]')
    expect(boxes.length).toBe(1)
    expect(container.querySelector('[data-testid="modal-org-checkbox-example"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="modal-org-checkbox-example2"]')).toBeNull()
    // Command Center is not even an option for a member.
    const scopeSelect = container.querySelector('[data-testid="modal-scope-type"]') as HTMLSelectElement
    expect(Array.from(scopeSelect.options).map(o => o.value)).not.toContain('global')
  })

  it('keeps EDIT single-scope — the row-level modal still uses the single-select', async () => {
    // One existing row to edit. `as any` because the shared get() mock is typed
    // off its first (principals/empty-list) shape, and this override adds a row.
    const listed = [{
      id: 7, key: 'EXISTING', scopeType: 'workspace', workspace: 'example', userId: null,
      version: 1, updatedAt: '2026-08-16T00:00:00Z',
    }]
    apiMock.get.mockImplementation(((url: string) => {
      if (url === '/secrets/principals') return Promise.resolve(structuredClone(state.principals))
      if (url.startsWith('/secrets')) return Promise.resolve(structuredClone(listed))
      return Promise.resolve(null)
    }) as any)

    flushSync(() => root.render(<SecretsPage />))
    await flush()
    const editBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Edit')!
    flushSync(() => editBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()

    // Single-select present, checkbox list absent — a row IS one scope.
    const single = container.querySelector('[data-testid="modal-scope-organization"]') as HTMLSelectElement
    expect(single).toBeTruthy()
    expect(single.value).toBe('example')
    expect(container.querySelector('[data-testid="modal-scope-organizations"]')).toBeNull()

    apiMock.get.mockImplementation(((url: string) => {
      if (url === '/secrets/principals') return Promise.resolve(structuredClone(state.principals))
      if (url.startsWith('/secrets')) return Promise.resolve([])
      return Promise.resolve(null)
    }) as any)
  })
})
