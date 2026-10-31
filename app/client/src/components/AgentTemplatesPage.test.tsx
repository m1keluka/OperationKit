import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AgentTemplatesPage } from './AgentTemplatesPage'

/**
 * Agent templates gallery (obj 719986). createRoot idiom, as in
 * AgentsPage.test.tsx (@testing-library is not a dependency here). fetch is
 * stubbed with fake data only.
 */
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
}

const GALLERY = {
  templates: [
    {
      slug: 'personal-assistant', name: 'Personal assistant', description: 'Drafts only.', avatar: 'PA', colour: 'green',
      version: '1.0.0', author: 'Operation Kit', tools: ['email', 'calendar'], knowledge_folders: ['personal/notes'],
      schedules: 1, source: 'starter', installed: false, installed_version: null, update_available: false,
    },
    {
      slug: 'operator', name: 'Operator', description: 'Makes cards.', avatar: 'OP', colour: 'amber',
      version: '1.1.0', author: 'Operation Kit', tools: ['create_objective'], knowledge_folders: [],
      schedules: 0, source: 'starter', installed: true, installed_version: '1.0.0', update_available: true,
    },
  ],
  installed: [
    { slug: 'operator', name: 'Operator', description: '', version: '1.0.0', author: 'Operation Kit', origin: 'template', template_slug: 'operator', has_file: true, archived: false },
    { slug: 'general', name: 'General', description: '', version: null, author: null, origin: null, template_slug: null, has_file: false, archived: false },
  ],
  problems: [],
  import_roots: ['/srv/ai-workspace/agent-imports'],
}

let container: HTMLDivElement
let root: Root
const calls: Array<{ url: string; method: string; body: unknown }> = []

beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
    if (url === '/api/agent-templates' && method === 'GET') return json(GALLERY)
    if (url === '/api/agents') return json([])
    if (url.endsWith('/install')) return json({ slug: 'personal-assistant', action: 'created', routines: [], warnings: [] }, 201)
    if (url === '/api/agent-templates/validate') {
      return json({ ok: false, errors: [{ field: 'system_prompt', message: 'is required' }], warnings: [] })
    }
    return json({ error: 'unexpected' }, 500)
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
  vi.unstubAllGlobals()
})

function render() {
  root.render(<MemoryRouter><AgentTemplatesPage /></MemoryRouter>)
}

function button(label: string): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll('button')).find(x => x.textContent?.trim() === label)
  if (!b) throw new Error(`no button "${label}"; have: ${Array.from(container.querySelectorAll('button')).map(x => x.textContent).join(' | ')}`)
  return b as HTMLButtonElement
}

describe('AgentTemplatesPage', () => {
  it('lists available templates and installed agents with the right actions', async () => {
    render()
    await settle()
    const text = container.textContent ?? ''
    expect(text).toContain('Personal assistant')
    expect(text).toContain('Agents on this install')
    expect(text).toContain('No file yet') // legacy agent, still exportable
    expect(button('Add agent')).toBeTruthy()
    expect(button('Update to v1.1.0')).toBeTruthy()
    const exports = Array.from(container.querySelectorAll('a')).filter(a => a.textContent === 'Export')
    expect(exports.map(a => a.getAttribute('href'))).toEqual([
      '/api/agent-templates/agents/operator/export',
      '/api/agent-templates/agents/general/export',
    ])
  })

  it('installs a template and reports success', async () => {
    render()
    await settle()
    button('Add agent').click()
    await settle()
    expect(calls.some(c => c.url === '/api/agent-templates/templates/personal-assistant/install' && c.method === 'POST')).toBe(true)
    expect(container.textContent).toContain('Personal assistant added')
  })

  it('shows field-level problems for an invalid uploaded file and offers no import', async () => {
    render()
    await settle()
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['name: Broken\nslug: broken\n'], 'broken.yaml', { type: 'text/yaml' })
    Object.defineProperty(input, 'files', { value: [file] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await settle()
    expect(container.textContent).toContain("This file can't be imported yet")
    expect(container.textContent).toContain('system_prompt')
    expect(Array.from(container.querySelectorAll('button')).some(b => b.textContent === 'Replace agent')).toBe(false)
  })
})
