// @vitest-environment jsdom
/** obj 900674 — the workspace-wide knowledge-base graph: draws every page and connection from GET /api/kb-wiki/graph. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { WorkspaceGraph } from './WorkspaceGraph'

const GRAPH = {
  root: '/kb/garden',
  nodes: [
    { rel: 'people/tom.md', title: 'Tom Whitfield', kind: 'person', degree: 2 },
    { rel: 'organizations/greenway.md', title: 'Greenway Growers', kind: 'organization', degree: 2 },
    { rel: 'sources/call.md', title: 'Supplier call', kind: 'source', degree: 2 },
    { rel: 'organizations/riverbend.md', title: 'Riverbend Nursery', kind: 'organization', degree: 0 },
  ],
  links: [
    { a: 'organizations/greenway.md', b: 'people/tom.md', kinds: ['related'], label: 'works for', weight: 1 },
    { a: 'people/tom.md', b: 'sources/call.md', kinds: ['cited_by'], label: null, weight: 1 },
    { a: 'organizations/greenway.md', b: 'sources/call.md', kinds: ['cited_by'], label: null, weight: 1 },
  ],
  counts: { pages: 4, links: 3, isolated: 1, by_kind: { organization: 2, person: 1, source: 1 } },
  truncated: false,
}

async function flush() {
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); flushSync(() => {}) }
}

describe('WorkspaceGraph', () => {
  let host: HTMLDivElement
  let root: Root
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    fetchMock = vi.fn(async () => new Response(JSON.stringify(GRAPH), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    root.unmount()
    host.remove()
    vi.unstubAllGlobals()
  })

  const nodes = () => [...host.querySelectorAll('g[data-rel]')].map(g => g.getAttribute('data-rel'))

  it('loads the workspace graph and draws every page and connection', async () => {
    const open = vi.fn()
    flushSync(() => root.render(<WorkspaceGraph workspace="garden" onOpenNote={open} />))
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/kb-wiki/graph?workspace=garden')
    expect(nodes()).toHaveLength(4)
    expect(host.querySelectorAll('svg[aria-label^="Graph of"] line')).toHaveLength(3)
    expect(host.textContent).toContain('4 pages · 3 connections')
    // Every node has a real position.
    for (const c of host.querySelectorAll('g[data-rel] circle')) expect(Number.isFinite(Number(c.getAttribute('cx')))).toBe(true)

    // Keyboard: a dot is a button that opens its page.
    const tom = host.querySelector<SVGGElement>('g[data-rel="people/tom.md"]')!
    expect(tom.getAttribute('aria-label')).toBe('Open Tom Whitfield (Person, 2 connections)')
    tom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(open).toHaveBeenCalledWith('people/tom.md', '/kb/garden')
  })

  it('a tap on a dot opens that page (nearest dot wins)', async () => {
    const open = vi.fn()
    flushSync(() => root.render(<WorkspaceGraph workspace="garden" onOpenNote={open} />))
    await flush()
    const svg = host.querySelector<SVGSVGElement>('svg[aria-label^="Graph of"]')!
    const m = svg.querySelector('g[transform]')!.getAttribute('transform')!.match(/translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/)!
    const [tx, ty, k] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const dot = [...host.querySelectorAll('g[data-rel="organizations/greenway.md"] circle')].pop()!
    const x = Number(dot.getAttribute('cx')) * k + tx
    const y = Number(dot.getAttribute('cy')) * k + ty
    const fire = (type: string) => svg.dispatchEvent(new MouseEvent(type, { clientX: x + 1, clientY: y - 1, button: 0, bubbles: true }))
    flushSync(() => { fire('pointermove') })
    // Hover lights the page and names it in the card.
    expect(host.textContent).toContain('click to open')
    fire('pointerdown'); fire('pointerup')
    expect(open).toHaveBeenCalledWith('organizations/greenway.md', '/kb/garden')
  })

  it('hides a kind from the legend and drops unconnected pages on request', async () => {
    flushSync(() => root.render(<WorkspaceGraph workspace="garden" onOpenNote={() => {}} />))
    await flush()
    const chip = [...host.querySelectorAll('button[aria-pressed]')].find(b => b.textContent?.includes('Source'))!
    flushSync(() => (chip as HTMLButtonElement).click())
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(nodes()).not.toContain('sources/call.md')
    expect(host.querySelectorAll('svg[aria-label^="Graph of"] line')).toHaveLength(1)

    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    flushSync(() => box.click())
    expect(nodes()).not.toContain('organizations/riverbend.md')
  })

  it('shows a plain empty state for a workspace with no pages', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ nodes: [], links: [], counts: { pages: 0, links: 0, isolated: 0, by_kind: {} }, truncated: false }), { status: 200 }))
    flushSync(() => root.render(<WorkspaceGraph workspace="empty" onOpenNote={() => {}} />))
    await flush()
    expect(host.textContent).toContain('Nothing to graph yet')
  })
})
