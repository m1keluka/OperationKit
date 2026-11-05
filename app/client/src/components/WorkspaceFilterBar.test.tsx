// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

import { WorkspaceFilterBar, slugifyOrg } from './WorkspaceFilterBar'

// Same harness idiom as ProjectFilterBar.test.tsx: the container ships a
// PRODUCTION React build (no `act`), so commits are driven with flushSync.
async function flush() {
  await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
  flushSync(() => {})
  await Promise.resolve()
}

// Deliberately fictional: the OSS publish pipeline rewrites real org names,
// and it maps a slug and its display name through different rules — a fixture
// built from a real identity desynchronises in the public tree.
const ORGS = [
  { slug: 'acme', label: 'Acme' },
  { slug: 'northwind', label: 'Northwind' },
  { slug: 'blue-harbor', label: 'Blue Harbor' },
]

const onChange = vi.fn()
const onCreate = vi.fn(() => Promise.resolve())

function chipsOf(el: HTMLElement) {
  return [...el.querySelectorAll('[role="group"] button')].map(b => (b.textContent || '').trim())
}
function click(el: Element | null | undefined) {
  flushSync(() => el?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

describe('WorkspaceFilterBar — the board org filter (obj 900197)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    onChange.mockClear(); onCreate.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  async function mount(selected: string[] = [], props: Record<string, unknown> = {}) {
    flushSync(() => root.render(
      <WorkspaceFilterBar
        organizations={ORGS}
        selected={selected}
        onChange={onChange}
        canCreate
        onCreate={onCreate}
        {...props}
      />
    ))
    await flush()
    return container.querySelector('[data-testid="workspace-filter-bar"]') as HTMLElement
  }

  it('renders All plus one chip per organization', async () => {
    const bar = await mount()
    expect(chipsOf(bar)).toEqual(['All orgs', 'Acme', 'Northwind', 'Blue Harbor'])
  })

  it('All orgs is pressed when nothing is selected', async () => {
    const bar = await mount([])
    const all = bar.querySelector('[role="group"] button') as HTMLElement
    expect(all.getAttribute('aria-pressed')).toBe('true')
  })

  it('clicking an org chip selects that org', async () => {
    const bar = await mount([])
    click(bar.querySelector('[data-workspace="northwind"]'))
    expect(onChange).toHaveBeenCalledWith(['northwind'])
  })

  it('selection is multi-select — a second chip adds, it does not replace', async () => {
    const bar = await mount(['acme'])
    click(bar.querySelector('[data-workspace="blue-harbor"]'))
    expect(onChange).toHaveBeenCalledWith(['acme', 'blue-harbor'])
  })

  it('clicking a selected chip deselects it', async () => {
    const bar = await mount(['acme', 'blue-harbor'])
    click(bar.querySelector('[data-workspace="acme"]'))
    expect(onChange).toHaveBeenCalledWith(['blue-harbor'])
  })

  it('All orgs clears the selection', async () => {
    const bar = await mount(['acme'])
    click(bar.querySelector('[role="group"] button'))
    expect(onChange).toHaveBeenCalledWith([])
  })

  it('creates an organization inline and opens it', async () => {
    const bar = await mount()
    click([...bar.querySelectorAll('button')].find(b => b.textContent?.includes('New organization')))
    await flush()
    const input = bar.querySelector('input[aria-label="New organization name"]') as HTMLInputElement
    expect(input).toBeTruthy()
    const proto = Object.getPrototypeOf(input)
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, 'Blue Harbor')
    flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() => (bar.querySelector('form') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(onCreate).toHaveBeenCalledWith('Blue Harbor', 'blue-harbor')
    expect(onChange).toHaveBeenCalledWith(['blue-harbor'])
  })

  it('surfaces a create failure instead of silently doing nothing', async () => {
    const failing = vi.fn(() => Promise.reject(new Error("Workspace 'acme' already exists")))
    const bar = await mount([], { onCreate: failing })
    click([...bar.querySelectorAll('button')].find(b => b.textContent?.includes('New organization')))
    await flush()
    const input = bar.querySelector('input[aria-label="New organization name"]') as HTMLInputElement
    const proto = Object.getPrototypeOf(input)
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, 'Acme')
    flushSync(() => input.dispatchEvent(new Event('input', { bubbles: true })))
    flushSync(() => (bar.querySelector('form') as HTMLFormElement)
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    await flush()
    expect(bar.textContent).toContain('already exists')
  })

  it('hides the create affordance for non-admins', async () => {
    const bar = await mount([], { canCreate: false })
    expect([...bar.querySelectorAll('button')].some(b => b.textContent?.includes('New organization'))).toBe(false)
  })

  it('says so when there are no organizations rather than rendering an empty row', async () => {
    const bar = await mount([], { organizations: [] })
    expect(bar.textContent).toContain('No organizations yet')
  })
})

describe('slugifyOrg', () => {
  it('matches the server slug rule', () => {
    expect(slugifyOrg('Blue Harbor')).toBe('blue-harbor')
    expect(slugifyOrg('  Acme & Co.  ')).toBe('acme-co')
    expect(slugifyOrg('Northwind')).toBe('northwind')
    expect(slugifyOrg('x'.repeat(60)).length).toBe(41)
  })
})
