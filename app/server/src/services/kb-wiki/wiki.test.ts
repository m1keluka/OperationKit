import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { upsertEntityNote, type Entity, type SourceRef } from '../doc-ingest/notes.js'
import { listNotes } from '../doc-ingest/ask.js'
import {
  appendLog, compileWiki, parseLinks, readPage, renderIndexBody, resolveLinkTarget, scanWiki, wikilink, wikilinksToMarkdown, MAX_LOG_ENTRIES,
} from './wiki.js'
import { afterDocIngest, extraNoteDirs } from './hooks.js'

let kb: string
beforeEach(() => { kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwiki-')) })
afterEach(() => { fs.rmSync(kb, { recursive: true, force: true }) })

function put(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(kb, rel)), { recursive: true })
  fs.writeFileSync(path.join(kb, rel), text)
}
const read = (rel: string) => fs.readFileSync(path.join(kb, rel), 'utf8')

const SRC: SourceRef = { notePath: 'sources/2026-10-01-supplier-list.md', filePath: 'sources/files/2026-10-01-supplier-list.xlsx', fileName: 'Supplier List.xlsx' }

function seed(): void {
  const greenway: Entity = { type: 'organization', name: 'Greenway Growers', aliases: ['Greenway'], summary: 'Wholesale plant supplier.', facts: [{ fact: 'Delivers on Tuesdays' }], related: [{ type: 'person', name: 'Rosa Delgado' }] }
  put('organizations/greenway-growers.md', upsertEntityNote(null, greenway, SRC, '2026-10-01'))
  put('people/rosa-delgado.md', [
    '---', 'title: Rosa Delgado', 'type: person', 'aliases: [Rosa]', 'updated: 2026-10-02', '---', '',
    '# Rosa Delgado', '', 'Owner of the garden centre. Works with [[Greenway]] and [[organizations/greenway-growers#Facts|the supplier]].', '',
    'Also see [[Spring Sale]] and `[[not a link]]`.', '',
  ].join('\n'))
  put('sources/2026-10-01-supplier-list.md', '---\ntitle: Supplier list\ntype: source\n---\n# Supplier list\n\nA list of suppliers.\n')
  put('sources/conversations/job1/c0001-pricing.md', '---\ntitle: Pricing chat\ntype: source\ngenerated_by: kb-wiki\n---\n# Pricing chat\n\nTalked about [[people/rosa-delgado|Rosa]].\n')
  put('answers/2026-10-03-who-supplies-us.md', '---\ntitle: Who supplies us?\ntype: answer\ngenerated_by: kb-wiki\n---\n# Who supplies us?\n\n[[Greenway Growers]] does.\n')
  // Never part of the wiki:
  put('raw/chat-exports/notes.md', '# raw\n\n[[Rosa Delgado]]\n')
  put('sources/files/readme.md', 'original upload [[Rosa Delgado]]')
  put('sources/inbox/new.md', '[[Rosa Delgado]]')
  put('.kb-wiki/state.md', '[[Rosa Delgado]]')
}

describe('links', () => {
  it('parses wikilink forms and markdown .md links, ignoring code', () => {
    const links = parseLinks('---\ntitle: x\n---\n[[a]] [[b|B]] [[c#h]] [[d#h|D]] ![[e]] [x](../people/f.md) [y](https://x.com/g.md) `[[nope]]`\n```\n[[nope2]]\n```')
    expect(links.map(l => [l.form, l.target, l.label, l.heading])).toEqual([
      ['wiki', 'a', undefined, undefined], ['wiki', 'b', 'B', undefined], ['wiki', 'c', undefined, 'h'], ['wiki', 'd', 'D', 'h'], ['wiki', 'e', undefined, undefined],
      ['md', '../people/f.md', 'x', undefined],
    ])
  })

  it('resolves paths, relative paths, stems, titles and aliases case-insensitively', () => {
    seed()
    const pages = scanWiki(kb)
    const r = (t: string, from = 'people/rosa-delgado.md') => resolveLinkTarget(pages, t, from)
    expect(r('organizations/greenway-growers')).toBe('organizations/greenway-growers.md')
    expect(r('organizations/greenway-growers.md#Facts')).toBe('organizations/greenway-growers.md')
    expect(r('../organizations/greenway-growers.md')).toBe('organizations/greenway-growers.md')
    expect(r('GREENWAY')).toBe('organizations/greenway-growers.md')
    expect(r('greenway growers')).toBe('organizations/greenway-growers.md')
    expect(r('Rosa')).toBe('people/rosa-delgado.md')
    expect(r('who-supplies-us')).toBe('answers/2026-10-03-who-supplies-us.md')
    expect(r('nobody here')).toBe(null)
    expect(r('people/nobody')).toBe(null)
  })

  it('wikilink + wikilinksToMarkdown', () => {
    seed()
    const pages = scanWiki(kb)
    expect(wikilink('people/x.md', 'X')).toBe('[[people/x|X]]')
    expect(wikilinksToMarkdown('See [[Greenway]] and [[Missing Thing]].', 'people/rosa-delgado.md', pages))
      .toBe('See [Greenway Growers](../organizations/greenway-growers.md) and Missing Thing.')
  })
})

describe('scan + compile', () => {
  it('scans only wiki pages, with kinds, titles, summaries and resolved links', () => {
    seed()
    const pages = scanWiki(kb)
    expect(pages.map(p => p.rel).sort()).toEqual([
      'answers/2026-10-03-who-supplies-us.md', 'organizations/greenway-growers.md', 'people/rosa-delgado.md',
      'sources/2026-10-01-supplier-list.md', 'sources/conversations/job1/c0001-pricing.md',
    ])
    const rosa = pages.find(p => p.rel === 'people/rosa-delgado.md')!
    expect(rosa.kind).toBe('person')
    expect(rosa.summary).toBe('Owner of the garden centre. Works with Greenway and the supplier.')
    expect(rosa.links).toEqual(['organizations/greenway-growers.md'])
    const gw = pages.find(p => p.rel === 'organizations/greenway-growers.md')!
    expect(gw.summary).toBe('Wholesale plant supplier.')
    expect(gw.links.sort()).toEqual(['people/rosa-delgado.md', 'sources/2026-10-01-supplier-list.md'])
  })

  it('writes sorted backlinks blocks and the index; a second compile writes nothing', () => {
    seed()
    const first = compileWiki(kb, { now: new Date('2026-10-31T10:00:00Z') })
    expect(first.pages).toBe(5)
    expect(first.indexWritten).toBe(true)
    const gw = read('organizations/greenway-growers.md')
    expect(gw).toContain('<!-- kb-wiki:backlinks -->\n## Backlinks\n\n')
    expect(gw.trimEnd().endsWith('<!-- /kb-wiki:backlinks -->')).toBe(true)
    const block = gw.slice(gw.indexOf('## Backlinks'))
    expect(block.indexOf('Rosa Delgado')).toBeLessThan(block.indexOf('Who supplies us?'))
    // The source note has a backlink from the entity page that cites it.
    expect(read('sources/2026-10-01-supplier-list.md')).toContain('[[organizations/greenway-growers|Greenway Growers]]')
    // Raw files are never touched.
    expect(read('raw/chat-exports/notes.md')).toBe('# raw\n\n[[Rosa Delgado]]\n')
    expect(read('sources/files/readme.md')).toBe('original upload [[Rosa Delgado]]')
    // Backlinks themselves are not links: Rosa's links did not grow.
    expect(scanWiki(kb).find(p => p.rel === 'people/rosa-delgado.md')!.links).toEqual(['organizations/greenway-growers.md'])

    const mtimes = fs.readdirSync(path.join(kb, 'people')).map(n => fs.statSync(path.join(kb, 'people', n)).mtimeMs)
    const second = compileWiki(kb, { now: new Date('2026-11-01T10:00:00Z') })
    expect(second).toEqual({ pages: 5, backlinksUpdated: 0, indexWritten: false })
    expect(fs.readdirSync(path.join(kb, 'people')).map(n => fs.statSync(path.join(kb, 'people', n)).mtimeMs)).toEqual(mtimes)
  })

  it('removes a backlinks block when the last link to a page goes away', () => {
    seed()
    compileWiki(kb)
    expect(read('people/rosa-delgado.md')).toContain('## Backlinks')
    for (const rel of ['organizations/greenway-growers.md', 'sources/conversations/job1/c0001-pricing.md']) fs.rmSync(path.join(kb, rel))
    compileWiki(kb)
    expect(read('people/rosa-delgado.md')).not.toContain('kb-wiki:backlinks')
  })

  it('renders the index in FOLDER_FOR order, then answers, then sources with conversations grouped', () => {
    seed()
    compileWiki(kb, { now: new Date('2026-10-31T10:00:00Z') })
    const idx = read('index.md')
    expect(idx).toMatch(/^---\ntitle: Wiki index\ntype: index\ngenerated_by: kb-wiki\nupdated: 2026-10-31\n---\n/)
    const order = ['## Organizations (1)', '## People (1)', '## Answers (1)', '## Sources (2)', '### Conversations (1)', '#### Import job1'].map(h => idx.indexOf(h))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(idx).toContain('- [[organizations/greenway-growers|Greenway Growers]] — Wholesale plant supplier.')
    expect(renderIndexBody([])).toContain('Nothing here yet')
  })

  it('leaves a hand-written index.md / log.md alone and uses wiki-*.md instead', () => {
    seed()
    put('index.md', '# My own index\n')
    put('log.md', '# My diary\n')
    compileWiki(kb)
    appendLog(kb, { kind: 'edit', title: 'x' })
    expect(read('index.md')).toBe('# My own index\n')
    expect(read('log.md')).toBe('# My diary\n')
    expect(read('wiki-index.md')).toContain('generated_by: kb-wiki')
    expect(read('wiki-log.md')).toContain('] edit | x')
  })
})

describe('log', () => {
  it('is newest first, caps links at 20 and entries at 500', () => {
    seed()
    appendLog(kb, { kind: 'ingest', title: 'First', pages: ['people/rosa-delgado.md'], when: new Date('2026-10-01T08:05:00Z') })
    appendLog(kb, { kind: 'answer', title: 'Second\nline', pages: Array.from({ length: 25 }, (_, i) => `people/p${i}.md`), when: new Date('2026-10-02T09:30:00Z') })
    const log = read('log.md')
    expect(log.indexOf('## [2026-10-02 09:30] answer | Second line')).toBeLessThan(log.indexOf('## [2026-10-01 08:05] ingest | First'))
    expect(log).toContain('- [[people/rosa-delgado|Rosa Delgado]]')
    expect(log).toContain('- …and 5 more')
    expect((log.match(/\[\[people\/p\d+\]\]/g) ?? []).length).toBe(20)
    for (let i = 0; i < MAX_LOG_ENTRIES + 5; i++) appendLog(kb, { kind: 'edit', title: `e${i}` })
    const big = read('log.md')
    expect((big.match(/^## \[/gm) ?? []).length).toBe(MAX_LOG_ENTRIES)
    expect(big).toContain(`edit | e${MAX_LOG_ENTRIES + 4}`)
    expect(big).not.toContain('ingest | First')
  })
})

describe('readPage', () => {
  it('returns content + backlinks and refuses non-pages', () => {
    seed()
    compileWiki(kb)
    const p = readPage(kb, 'organizations/greenway-growers.md')
    expect(p.title).toBe('Greenway Growers')
    expect(p.backlinks).toContainEqual({ rel: 'people/rosa-delgado.md', title: 'Rosa Delgado' })
    expect(readPage(kb, 'index.md').title).toBe('Wiki index')
    for (const bad of ['raw/chat-exports/notes.md', 'sources/files/readme.md', '../etc/passwd', '/etc/hosts', '.kb-wiki/state.md', 'people/nobody.md']) {
      expect(() => readPage(kb, bad)).toThrow()
    }
  })
})

describe('doc-ingest hooks', () => {
  it('afterDocIngest logs each finished file once and compiles', () => {
    seed()
    put('sources/_manifest.json', JSON.stringify([
      { id: 'a', file_name: 'Supplier List.xlsx', stored: 'x', kind: 'spreadsheet', status: 'done', uploaded_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-01T00:01:00Z', source_note: 'sources/2026-10-01-supplier-list.md', notes: ['organizations/greenway-growers.md'] },
      { id: 'b', file_name: 'Bad.pdf', stored: 'y', kind: 'pdf', status: 'failed', uploaded_at: '2026-10-01T00:00:00Z', finished_at: '2026-10-01T00:02:00Z', error: 'no text' },
      { id: 'c', file_name: 'Later.pdf', stored: 'z', kind: 'pdf', status: 'queued', uploaded_at: '2026-10-01T00:00:00Z' },
    ]))
    expect(afterDocIngest(kb).logged).toBe(2)
    expect(afterDocIngest(kb).logged).toBe(0)
    const log = read('log.md')
    expect(log).toContain('ingest | Read "Supplier List.xlsx" (2 pages)')
    expect(log).toContain('ingest | Could not read "Bad.pdf": no text')
    expect(fs.existsSync(path.join(kb, 'index.md'))).toBe(true)
  })

  it('Ask also reads saved answers and imported conversations', () => {
    seed()
    expect(extraNoteDirs(kb)).toEqual(['answers', 'sources/conversations', 'sources/conversations/job1'])
    const rels = listNotes(kb).map(n => n.rel)
    expect(rels).toContain('answers/2026-10-03-who-supplies-us.md')
    expect(rels).toContain('sources/conversations/job1/c0001-pricing.md')
  })
})
