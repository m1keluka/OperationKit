// @vitest-environment jsdom
//
// obj 900749 — Settings → Secrets, clean + clearly secure:
//   1. One security strip states write-only / encrypted + scoped / bots use by name.
//   2. A Bot access column shows Off (default-deny), the allowed host, or Never
//      (seat/server-only, not clickable).
//   3. The Bot access dialog PUTs only names + hosts to /secrets/bot-access/:name
//      — never a value, never /secrets itself — and "Turn off" DELETEs it.
//   4. Search narrows the table by name and the count says "x of N".
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

function setValue(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const tracker = (node as any)._valueTracker
  node.value = value
  if (tracker) tracker.setValue('')
  node.dispatchEvent(new Event('input', { bubbles: true }))
}

const { apiMock, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    status: number
    constructor(message: string, status = 500) { super(message); this.status = status }
  }
  const row = (id: number, key: string, scopeType: string, workspace: string | null) => ({
    id, key, scopeType, workspace, userId: null, serviceOnly: false,
    version: 1, createdBy: 1, updatedBy: 1, createdAt: '2026-11-01 10:00:00', updatedAt: '2026-11-02 10:00:00',
    description: null, lastUsedAt: null,
  })
  const listed = [
    row(1, 'STRIPE_KEY', 'global', null),
    row(2, 'APIFY_API_TOKEN', 'workspace', 'operationkit'),
    row(3, 'CC_MCP_SERVER_4_TOKEN', 'workspace', 'operationkit'),
  ]
  const apiMock = {
    get: vi.fn((url: string) => {
      if (url === '/secrets/principals') {
        return Promise.resolve({ organizations: [{ slug: 'operationkit', name: 'OperationKit' }, { slug: 'your-org', name: 'Example Growth' }], users: [{ id: 1, username: 'operator' }], canUseGlobal: true })
      }
      if (url === '/secrets/bot-access') {
        return Promise.resolve({ source: 'settings', policy: { APIFY_API_TOKEN: { hosts: ['api.apify.com'], methods: ['GET', 'POST'] } }, blocked_keys: ['CC_MCP_SERVER_4_TOKEN'] })
      }
      if (url.startsWith('/secrets/audit')) return Promise.resolve({ entries: [], nextBeforeId: null })
      if (url.startsWith('/secrets/rotation-flags')) return Promise.resolve([])
      if (url.startsWith('/secrets')) return Promise.resolve(structuredClone(listed))
      return Promise.resolve(null)
    }),
    post: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    put: vi.fn((_url: string, _body: any) => Promise.resolve({})),
    del: vi.fn((_url: string) => Promise.resolve({})),
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

describe('Secrets — security strip, bot access, search (obj 900749)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(async () => {
    apiMock.put.mockClear()
    apiMock.del.mockClear()
    apiMock.post.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    flushSync(() => root.render(<SecretsPage embedded />))
    await flush()
  })

  const rowFor = (key: string) =>
    Array.from(container.querySelectorAll('[data-testid="secret-row"]')).find(r => r.textContent?.includes(key)) as HTMLElement
  const button = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined

  it('states the three promises once', () => {
    const strip = container.querySelector('[data-testid="secrets-security-strip"]')!
    expect(strip.textContent).toContain('Write-only')
    expect(strip.textContent).toContain('Encrypted and scoped')
    expect(strip.textContent).toContain('Bots use it by name')
  })

  it('shows Off / host / Never per row; Never is not clickable', () => {
    expect(rowFor('STRIPE_KEY').querySelector('[data-bot-access]')!.getAttribute('data-bot-access')).toBe('off')
    const apify = rowFor('APIFY_API_TOKEN').querySelector('[data-bot-access]')!
    expect(apify.getAttribute('data-bot-access')).toBe('on')
    expect(apify.textContent).toBe('api.apify.com')
    const mcp = rowFor('CC_MCP_SERVER_4_TOKEN')
    expect(mcp.querySelector('[data-bot-access]')!.getAttribute('data-bot-access')).toBe('never')
    expect(mcp.querySelector('[data-testid="secret-bot-access"]')).toBeNull()
    // Values stay masked and read as write-only.
    expect(rowFor('STRIPE_KEY').querySelector('[aria-label="value hidden, write-only"]')!.textContent).toContain('••••••')
  })

  it('turning bot access on PUTs names + hosts only, with the organizations for an Everywhere secret', async () => {
    flushSync(() => rowFor('STRIPE_KEY').querySelector<HTMLButtonElement>('[data-testid="secret-bot-access"]')!.click())
    await flush()
    const modal = container.querySelector('[data-testid="bot-access-modal"]') as HTMLFormElement
    expect(modal.textContent).toContain('{{secret:STRIPE_KEY}}')
    flushSync(() => setValue(container.querySelector('[data-testid="bot-access-hosts"]') as HTMLTextAreaElement, 'api.stripe.com'))
    const orgBox = Array.from(container.querySelectorAll('[data-testid="bot-access-orgs"] label')).find(l => l.textContent?.includes('OperationKit'))!.querySelector('input')!
    flushSync(() => orgBox.click())
    flushSync(() => modal.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(apiMock.put).toHaveBeenCalledTimes(1)
    const [url, body] = apiMock.put.mock.calls[0]!
    expect(url).toBe('/secrets/bot-access/STRIPE_KEY')
    expect(body).toEqual({ hosts: ['api.stripe.com'], workspaces: ['operationkit'] })
    // The secret store itself is never written by this flow.
    expect(apiMock.post).not.toHaveBeenCalled()
  })

  it('"Turn off" DELETEs the entry', async () => {
    flushSync(() => rowFor('APIFY_API_TOKEN').querySelector<HTMLButtonElement>('[data-testid="secret-bot-access"]')!.click())
    await flush()
    expect((container.querySelector('[data-testid="bot-access-hosts"]') as HTMLTextAreaElement).value).toBe('api.apify.com')
    flushSync(() => button('Turn off')!.click())
    await flush()
    expect(apiMock.del).toHaveBeenCalledWith('/secrets/bot-access/APIFY_API_TOKEN')
  })

  it('search narrows by name and says "x of N"', async () => {
    flushSync(() => setValue(container.querySelector('[data-testid="secret-search"]') as HTMLInputElement, 'apify'))
    await flush()
    expect(container.querySelectorAll('[data-testid="secret-row"]').length).toBe(1)
    expect(container.querySelector('[data-testid="secret-count"]')!.textContent).toContain('1 of 3 secrets')
    flushSync(() => setValue(container.querySelector('[data-testid="secret-search"]') as HTMLInputElement, 'nomatch'))
    await flush()
    expect(container.textContent).toContain('No secret matches "nomatch".')
  })
})
