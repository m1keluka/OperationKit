// @vitest-environment jsdom
//
// obj 720115 moved GitHub and Google Workspace into Settings → Integrations.
// obj 900681 (Operator's Operation Kit Feedback) then removed the leftover
// "GitHub and Google Workspace" pointer card from Settings → API & MCP and moved
// My Secrets to Settings → Secrets → Mine. This pins all of that, and that the
// copy-paste coding-agent setup prompt is on the page.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

// Production React build in the container omits `act`; drive commits with flushSync.
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
    get: vi.fn((url: string) => {
      if (url === '/auth/api-key') return Promise.resolve({ configured: false, last4: null, created_at: null })
      if (url.startsWith('/secrets')) return Promise.resolve([])
      return Promise.resolve(null)
    }),
    post: vi.fn(() => Promise.resolve({})),
    put: vi.fn(() => Promise.resolve({})),
    patch: vi.fn(() => Promise.resolve({})),
    del: vi.fn(() => Promise.resolve({})),
  },
}))

vi.mock('../lib/api', () => ({ api: apiMock, ApiError: class ApiError extends Error {} }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin', username: 'owner' } }) }))
vi.mock('../context/nav', () => ({ useNavigate: () => vi.fn() }))
vi.mock('./ui', () => ({
  Modal: () => null,
  useConfirm: () => ({ confirm: vi.fn(() => Promise.resolve(true)), confirmDialog: null }),
}))

import { AccountSettings } from './AccountSettings'
import { PUBLIC_DOCS_BASE } from '../hooks/useBranding'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  apiMock.get.mockClear()
  apiMock.post.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

async function render() {
  flushSync(() => root.render(<AccountSettings />))
  await flush()
}

const calledUrls = () => apiMock.get.mock.calls.map(c => String(c[0]))

describe('Settings → API & MCP after the obj 900681 cleanup', () => {
  it('has no GitHub / Google Workspace card and no Google connect button', async () => {
    await render()
    expect(container.textContent).not.toContain('GitHub and Google Workspace')
    expect(container.textContent).not.toContain('Open Integrations')
    const buttons = Array.from(container.querySelectorAll('button')).map(b => b.textContent ?? '')
    expect(buttons.some(b => /connect (google|github)/i.test(b))).toBe(false)
  })

  it('no longer loads or starts the Google connection from this page', async () => {
    await render()
    expect(calledUrls().some(u => u.startsWith('/user/google'))).toBe(false)
    expect(apiMock.post).not.toHaveBeenCalledWith('/user/google/connect')
  })

  it('no longer shows My Secrets or loads personal secrets (moved to Settings → Secrets → Mine)', async () => {
    await render()
    expect(container.textContent).not.toMatch(/My secrets/i)
    expect(calledUrls().some(u => u.startsWith('/secrets?scopeType=user'))).toBe(false)
  })

  it('has the copy-paste coding-agent setup prompt', async () => {
    await render()
    const card = container.querySelector('[data-testid="coding-agent-setup"]')
    expect(card).not.toBeNull()
    expect(card!.textContent).toContain('Connect a coding agent')
    expect(container.querySelector('[data-testid="coding-agent-prompt"]')?.textContent).toContain('claude mcp add')
    const copy = Array.from(card!.querySelectorAll('button')).find(b => b.textContent === 'Copy prompt')
    expect(copy).toBeTruthy()
  })
})

// obj 900745 (Operator's 2026-11-12 walkthrough): keys first, webhooks next to them,
// agent key vs API key labelled, no duplicate MCP JSON snippet, links that resolve
// on this install, and no "an agent key never needs Secrets" copy.
describe('Settings → API & MCP IA (obj 900745)', () => {
  const headingOrder = () => {
    const marks: [string, Element | null][] = [
      ['legend', container.querySelector('[data-testid="key-kinds"]')],
      ['agent-keys', container.querySelector('#agent-keys-heading')],
      ['webhooks', container.querySelector('#agent-webhooks-heading')],
      ['api-key', Array.from(container.querySelectorAll('h2')).find(h => h.textContent === 'API key') ?? null],
      ['coding-agent', container.querySelector('[data-testid="coding-agent-setup"]')],
      ['docs', container.querySelector('[data-testid="api-mcp-docs"]')],
    ]
    for (const [name, el] of marks) expect(el, name).not.toBeNull()
    return marks
      .slice()
      .sort(([, x], [, y]) => (x!.compareDocumentPosition(y!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map(([name]) => name)
  }

  it('puts Agent keys above Connect a coding agent, with webhooks right after the keys', async () => {
    await render()
    expect(headingOrder()).toEqual(['legend', 'agent-keys', 'webhooks', 'api-key', 'coding-agent', 'docs'])
  })

  it('labels the two kinds of key apart', async () => {
    await render()
    const legend = container.querySelector('[data-testid="key-kinds"]')!.textContent ?? ''
    expect(legend).toMatch(/Agent key — for a bot \(MCP\)/)
    expect(legend).toMatch(/scoped tool connection/i)
    expect(legend).toMatch(/API key — for your scripts \(REST\)/)
    expect(legend).toMatch(/Full REST access that acts as you/)
  })

  it('drops the duplicate MCP JSON snippet but keeps the REST example', async () => {
    await render()
    const docs = container.querySelector('[data-testid="api-mcp-docs"]')!
    expect(docs.textContent).not.toContain('MCP config')
    expect(docs.textContent).not.toContain('mcpServers')
    expect(Array.from(docs.querySelectorAll('button')).some(b => b.textContent === 'Copy JSON')).toBe(false)
    expect(docs.textContent).toContain('REST — copy-paste curl example')
  })

  // Assert by allow-list, not by deny-listing repo names: scripts/oss-genericize.sh
  // rewrites repo slugs in this file too, so a "never X" regex breaks on the mirror.
  it('every link resolves on this install or the public docs repo', async () => {
    await render()
    const hrefs = Array.from(container.querySelectorAll('a')).map(a => a.getAttribute('href') ?? '')
    expect(PUBLIC_DOCS_BASE).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/main$/)
    expect(hrefs).toContain(`${window.location.origin}/api/openapi.json`)
    expect(hrefs).toContain(`${window.location.origin}/api/agent`)
    expect(hrefs).toContain(`${PUBLIC_DOCS_BASE}/docs/api/README.md`)
    expect(hrefs).toContain(`${PUBLIC_DOCS_BASE}/docs/api/AGENT-PROMPT.md`)
    for (const h of hrefs) {
      expect(h.startsWith(`${window.location.origin}/`) || h.startsWith(`${PUBLIC_DOCS_BASE}/`), h).toBe(true)
    }
  })

  it('describes agent keys as using named secrets via the broker, never "no Secrets needed"', async () => {
    await render()
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/never reads Settings\s*→\s*Secrets/)
    expect(text).not.toMatch(/never needs? Settings\s*→\s*Secrets/)
    const secrets = container.querySelector('[data-testid="agent-key-secrets-copy"]')!.textContent ?? ''
    expect(secrets).toMatch(/named secret through the secrets broker/)
    expect(secrets).toContain('{{secret:NAME}}')
  })
})
