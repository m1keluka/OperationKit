import { describe, it, expect } from 'vitest'
import {
  compactFilter, edgeSentence, groupPages, importProgress, itemQuery, kindLabel, radialLayout, relativePath, resolveFrom, shortTitle,
  wikilinksToLinks, type WikiPageSummary,
} from './kbWiki'

const pages: WikiPageSummary[] = [
  { rel: 'people/rosa-delgado.md', title: 'Rosa Delgado', kind: 'person', summary: 'Owner.', aliases: ['Rosa'] },
  { rel: 'companies/greenway-growers.md', title: 'Greenway Growers', kind: 'company', summary: 'Supplier of plants.' },
  { rel: 'answers/2026-10-01-who-supplies-us.md', title: 'Who supplies us?', kind: 'answer', summary: 'Greenway.' },
  { rel: 'sources/conversations/j1/c0001-spring-order.md', title: 'Spring order', kind: 'source', summary: 'Chat.' },
  { rel: 'index.md', title: 'Index', kind: 'generated', summary: '' },
]

describe('relativePath / resolveFrom (obj 720117)', () => {
  it('round-trips between folders', () => {
    const from = 'answers/2026-10-01-who-supplies-us.md'
    const rel = relativePath(from, 'companies/greenway-growers.md')
    expect(rel).toBe('../companies/greenway-growers.md')
    expect(resolveFrom(from, rel)).toBe('companies/greenway-growers.md')
  })
  it('same folder and KB root', () => {
    expect(relativePath('people/a.md', 'people/b.md')).toBe('b.md')
    expect(relativePath('', 'people/b.md')).toBe('people/b.md')
    expect(relativePath('index.md', 'people/b.md')).toBe('people/b.md')
    expect(resolveFrom('sources/conversations/j1/x.md', relativePath('sources/conversations/j1/x.md', 'people/b.md'))).toBe('people/b.md')
  })
})

describe('wikilinksToLinks (obj 720117)', () => {
  it('converts path links with and without .md, labels and headings', () => {
    const md = 'See [[companies/greenway-growers|Greenway]] and [[people/rosa-delgado]] and [[people/rosa-delgado.md#Facts]].'
    expect(wikilinksToLinks(md, 'answers/x.md', pages)).toBe(
      'See [Greenway](../companies/greenway-growers.md) and [Rosa Delgado](../people/rosa-delgado.md) and [Rosa Delgado](../people/rosa-delgado.md).',
    )
  })
  it('resolves bare names by file name, title or alias; unknown names stay plain text', () => {
    expect(wikilinksToLinks('[[Greenway Growers]]', '', pages)).toBe('[Greenway Growers](companies/greenway-growers.md)')
    expect(wikilinksToLinks('[[rosa-delgado]]', '', pages)).toBe('[Rosa Delgado](people/rosa-delgado.md)')
    expect(wikilinksToLinks('[[rosa|the owner]]', '', pages)).toBe('[the owner](people/rosa-delgado.md)')
    expect(wikilinksToLinks('[[Nobody Here]] ok', '', pages)).toBe('Nobody Here ok')
  })
  it('still links paths when the page list is not loaded', () => {
    expect(wikilinksToLinks('[[people/sam-okafor]]', 'people/rosa-delgado.md')).toBe('[sam okafor](sam-okafor.md)')
    expect(wikilinksToLinks('[[Sam]]', '')).toBe('Sam')
  })
  it('strips the hidden backlinks markers', () => {
    const md = 'Body\n<!-- kb-wiki:backlinks -->\n## Backlinks\n- [[answers/2026-10-01-who-supplies-us|Who supplies us?]]\n<!-- /kb-wiki:backlinks -->\n'
    const out = wikilinksToLinks(md, 'companies/greenway-growers.md', pages)
    expect(out).not.toContain('kb-wiki')
    expect(out).toContain('[Who supplies us?](../answers/2026-10-01-who-supplies-us.md)')
  })
})

describe('groupPages (obj 720117)', () => {
  it('groups by kind with answers then sources last and hides generated pages', () => {
    const g = groupPages(pages)
    expect(g.map(x => x.kind)).toEqual(['company', 'person', 'answer', 'source'])
    expect(g[0].label).toBe('Companies')
    expect(g[1].label).toBe('People')
  })
  it('filters on title, summary and alias', () => {
    expect(groupPages(pages, 'supplier').flatMap(x => x.pages.map(p => p.rel))).toEqual(['companies/greenway-growers.md'])
    expect(groupPages(pages, 'rosa').flatMap(x => x.pages.map(p => p.rel))).toEqual(['people/rosa-delgado.md'])
    expect(groupPages(pages, 'zzz')).toEqual([])
  })
  it('pluralises unknown kinds plainly', () => {
    expect(kindLabel('topic')).toBe('Topics')
    expect(kindLabel('property')).toBe('Properties')
    expect(kindLabel('process')).toBe('Processes')
  })
})

describe('import helpers (obj 720117)', () => {
  it('progress counts finished chats against ticked chats', () => {
    const c = { total: 100, selected: 40, pending: 60, queued: 10, working: 2, done: 20, skipped: 6, failed: 2 }
    expect(importProgress(c)).toEqual({ finished: 28, of: 40, pct: 70 })
    expect(importProgress({ ...c, selected: 0, done: 0, skipped: 0, failed: 0 }).pct).toBe(0)
  })
  it('builds the item query and compacts filters', () => {
    expect(itemQuery({ q: ' supplier ', min_messages: 5, status: undefined }, 50, 50)).toBe('q=supplier&min_messages=5&offset=50&limit=50')
    expect(compactFilter({ q: '  ', from: '2026-01-01', min_messages: 0 })).toEqual({ from: '2026-01-01' })
  })
})

describe('rendering untrusted wiki text', () => {
  it('cannot break out of href or run javascript: links', async () => {
    const { renderMarkdown } = await import('./markdown')
    const evil = renderMarkdown('[a](b" onmouseover="alert(1)" x=") and [b](javascript:alert(1)) and [c](data:text/html,x)')
    expect(evil).not.toMatch(/onmouseover="/)
    expect(evil).not.toContain('href="javascript:')
    expect(evil).not.toContain('href="data:')
    const ok = renderMarkdown('[site](https://example.com) [page](../people/x.md)')
    expect(ok).toContain('href="https://example.com"')
    expect(ok).toContain('href="../people/x.md"')
  })
})

describe('link graph helpers (obj 720162)', () => {
  const titles: Record<string, string> = { 'people/tom.md': 'Tom Whitfield', 'organizations/greenway.md': 'Greenway Growers', 'sources/call.md': 'Supplier call', 'answers/a.md': 'Who is our rep?' }
  const t = (r: string) => titles[r] ?? r

  it('edgeSentence says each kind of connection in plain words', () => {
    expect(edgeSentence({ from: 'people/tom.md', to: 'organizations/greenway.md', kind: 'related', label: 'works for' }, t)).toBe('Tom Whitfield works for Greenway Growers')
    expect(edgeSentence({ from: 'people/tom.md', to: 'organizations/greenway.md', kind: 'related', label: null }, t)).toBe('Tom Whitfield is related to Greenway Growers')
    expect(edgeSentence({ from: 'sources/call.md', to: 'people/tom.md', kind: 'mentions', label: null }, t)).toBe('Supplier call mentions Tom Whitfield')
    expect(edgeSentence({ from: 'people/tom.md', to: 'sources/call.md', kind: 'cited_by', label: null }, t)).toBe('Supplier call is a source for Tom Whitfield')
    expect(edgeSentence({ from: 'answers/a.md', to: 'people/tom.md', kind: 'answer_used', label: null }, t)).toBe('The answer “Who is our rep?” used Tom Whitfield')
  })

  it('radialLayout spreads neighbours evenly, first one straight above the centre', () => {
    const { centre, points } = radialLayout(4, 480, 260)
    expect(centre).toEqual({ x: 240, y: 130 })
    expect(points[0].x).toBe(240)
    expect(points[0].y).toBeLessThan(centre.y)
    expect(points[2].y).toBeGreaterThan(centre.y)
    expect(points.every(p => p.x >= 0 && p.x <= 480 && p.y >= 0 && p.y <= 260)).toBe(true)
    expect(radialLayout(0, 480, 260).points).toEqual([])
  })

  it('shortTitle cuts long titles with an ellipsis', () => {
    expect(shortTitle('Tom Whitfield')).toBe('Tom Whitfield')
    expect(shortTitle('Hillcrest Property Management')).toBe('Hillcrest Propert…')
  })
})
