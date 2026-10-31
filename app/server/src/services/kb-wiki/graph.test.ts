import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { FOLDER_FOR, upsertEntityNote, type SourceRef } from '../doc-ingest/notes.js'
import { compileWiki, loadWiki, onWikiCompiled } from './wiki.js'
import { deriveGraph, kbRelated, kbWhoKnows, parseRelatedLine, readEdges, readNodes, syncGraph } from './graph.js'
import { runLint } from './lint.js'
import { fileAnswer } from './answers.js'

// The link graph is derived from the files: these tests build a small made-up
// knowledge base on disk and check what the tables say about it.
const PEOPLE = FOLDER_FOR.person
const ORGS = FOLDER_FOR.organization
const WS = 'demo'

let kb: string
let db: Database.Database

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(kb, rel)), { recursive: true })
  fs.writeFileSync(path.join(kb, rel), text)
}

const src = (id: string): SourceRef => ({ notePath: `sources/${id}.md`, filePath: `sources/files/${id}.txt`, fileName: `${id}.txt` })

/** A KB the way document ingest writes one: two sources, entity notes with Related lists. */
function buildKb(): void {
  const today = '2026-10-01'
  const a = src('2026-09-01-supplier-call')
  const b = src('2026-10-01-price-list')
  for (const s of [a, b]) {
    write(s.notePath, `---\ntitle: ${s.fileName}\ntype: source\nupdated: ${s.notePath.slice(8, 18)}\ngenerated_by: document-ingest\n---\n# ${s.fileName}\n\nWhat was said.\n`)
  }
  let tom = upsertEntityNote(null, { type: 'person', name: 'Tom Whitfield', facts: [{ fact: 'Account rep at Greenway Growers' }], related: [{ type: 'organization', name: 'Greenway Growers' }] }, a, today)
  // The same relation again from a later source, now with a label: the labelled line replaces the plain one.
  tom = upsertEntityNote(tom, { type: 'person', name: 'Tom Whitfield', facts: [{ fact: 'Sent the autumn price list' }], related: [{ type: 'organization', name: 'Greenway Growers', label: 'Works for' }] }, b, today)
  write(`${PEOPLE}/tom-whitfield.md`, tom)
  write(`${ORGS}/greenway-growers.md`, upsertEntityNote(null, { type: 'organization', name: 'Greenway Growers', summary: 'Main plant supplier.', facts: [{ fact: 'Delivers on Tuesdays' }], related: [{ type: 'organization', name: 'Fernleaf Garden Supply', label: 'supplier of' }] }, a, today))
  write(`${ORGS}/fernleaf-garden-supply.md`, upsertEntityNote(null, { type: 'organization', name: 'Fernleaf Garden Supply', facts: [{ fact: 'Independent garden centre' }] }, a, today))
  write(`${PEOPLE}/rosa-delgado.md`, upsertEntityNote(null, { type: 'person', name: 'Rosa Delgado', facts: [{ fact: 'Owner' }], related: [{ type: 'organization', name: 'Fernleaf Garden Supply', label: 'owns' }] }, a, today))
  write(`${PEOPLE}/sam-okafor.md`, upsertEntityNote(null, { type: 'person', name: 'Sam Okafor', facts: [{ fact: 'Store manager, mentions [[Greenway Growers]] often' }] }, b, today))
  // Hand-written page: a wikilink in the body, a source that is gone, and one with no connections.
  write(`${PEOPLE}/jo-fairweather.md`, '---\ntitle: Jo Fairweather\ntype: person\nsources: [sources/deleted-notes.md]\nupdated: 2026-08-01\n---\n# Jo Fairweather\n\nCrew lead. Works with [[Sam Okafor]].\n')
  write(`${ORGS}/riverbend-nursery.md`, '---\ntitle: Riverbend Nursery\ntype: organization\n---\n# Riverbend Nursery\n\nA possible second supplier.\n')
}

beforeEach(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwiki-graph-'))
  db = new Database(':memory:')
  buildKb()
})
afterEach(() => {
  db.close()
  fs.rmSync(kb, { recursive: true, force: true })
})

describe('relation labels on Related lines', () => {
  it('writes "— label" after the link and keeps one line per related page', () => {
    const tom = fs.readFileSync(path.join(kb, `${PEOPLE}/tom-whitfield.md`), 'utf8')
    const lines = tom.split('\n').filter(l => l.includes('greenway-growers.md'))
    expect(lines).toEqual(['- [Greenway Growers](../organizations/greenway-growers.md) (organization) — works for'])
  })

  it('a later source without a label keeps the label already there', () => {
    const tom = fs.readFileSync(path.join(kb, `${PEOPLE}/tom-whitfield.md`), 'utf8')
    const again = upsertEntityNote(tom, { type: 'person', name: 'Tom Whitfield', facts: [{ fact: 'x' }], related: [{ type: 'organization', name: 'Greenway Growers' }] }, src('later'), '2026-10-05')
    expect(again).toContain('(organization) — works for')
    expect(again.match(/greenway-growers\.md/g)!.length).toBe(1)
  })

  it('parses a Related line with or without a label, in markdown or wikilink form', () => {
    expect(parseRelatedLine('- [Greenway Growers](../organizations/greenway-growers.md) (organization) — supplier of'))
      .toEqual({ target: '../organizations/greenway-growers.md', label: 'supplier of' })
    expect(parseRelatedLine('- [A](../people/a.md) (person)')).toEqual({ target: '../people/a.md', label: null })
    expect(parseRelatedLine('- [[Tom Whitfield]] — works for')).toEqual({ target: 'Tom Whitfield', label: 'works for' })
    expect(parseRelatedLine('- no link here')).toBeNull()
  })
})

describe('deriveGraph', () => {
  it('reads related (with labels), mentions and cited_by edges from the page scan', () => {
    const g = deriveGraph(loadWiki(kb))
    const has = (from: string, to: string, kind: string, label: string | null = null) =>
      g.edges.some(e => e.from_rel === from && e.to_rel === to && e.kind === kind && e.label === label)
    expect(has(`${PEOPLE}/tom-whitfield.md`, `${ORGS}/greenway-growers.md`, 'related', 'works for')).toBe(true)
    expect(has(`${ORGS}/greenway-growers.md`, `${ORGS}/fernleaf-garden-supply.md`, 'related', 'supplier of')).toBe(true)
    expect(has(`${PEOPLE}/tom-whitfield.md`, 'sources/2026-09-01-supplier-call.md', 'cited_by')).toBe(true)
    expect(has(`${PEOPLE}/tom-whitfield.md`, 'sources/2026-10-01-price-list.md', 'cited_by')).toBe(true)
    expect(has(`${PEOPLE}/sam-okafor.md`, `${ORGS}/greenway-growers.md`, 'mentions')).toBe(true)
    expect(has(`${PEOPLE}/jo-fairweather.md`, `${PEOPLE}/sam-okafor.md`, 'mentions')).toBe(true)
    // "*Source: [file](…)*" citation links are not counted as mentions — `sources:` already covers them.
    expect(g.edges.filter(e => e.kind === 'mentions' && e.to_rel.startsWith('sources/'))).toEqual([])
    // Every edge records the file it was read from.
    expect(g.edges.every(e => e.source_rel === e.from_rel)).toBe(true)
    expect(g.broken).toEqual([{ from_rel: `${PEOPLE}/jo-fairweather.md`, target: 'sources/deleted-notes.md', kind: 'cited_by' }])
  })

  it('a saved answer links to the pages it used as answer_used', () => {
    const { rel } = fileAnswer(kb, { question: 'Who is our rep at the supplier?', answer: 'Tom Whitfield [[people/tom-whitfield.md]].', sources: [`${PEOPLE}/tom-whitfield.md`, `${ORGS}/greenway-growers.md`], now: new Date('2026-10-20T10:00:00Z') })
    const g = deriveGraph(loadWiki(kb))
    const used = g.edges.filter(e => e.from_rel === rel).map(e => `${e.kind}:${e.to_rel}`).sort()
    expect(used).toEqual([`answer_used:${ORGS}/greenway-growers.md`, `answer_used:${PEOPLE}/tom-whitfield.md`])
  })
})

describe('kb_edges table', () => {
  type Row = Record<string, unknown>
  const dump = (d: Database.Database) => ({
    edges: d.prepare('SELECT workspace, from_rel, to_rel, kind, label, source_rel, updated FROM kb_edges ORDER BY from_rel, to_rel, kind').all() as Row[],
    nodes: d.prepare('SELECT * FROM kb_nodes ORDER BY rel').all() as Row[],
  })

  it('rebuilds identically from the files: dropping the tables loses nothing', () => {
    compileWiki(kb)
    const first = syncGraph(db, WS, kb)
    expect(first.rebuilt).toBe(true)
    expect(first.edges).toBeGreaterThan(8)
    const before = dump(db)

    db.exec('DROP TABLE kb_edges; DROP TABLE kb_nodes; DROP TABLE kb_graph_state;')
    expect(syncGraph(db, WS, kb).rebuilt).toBe(true)
    expect(dump(db)).toEqual(before)

    // A brand-new database gets the very same rows.
    const fresh = new Database(':memory:')
    syncGraph(fresh, WS, kb)
    expect(dump(fresh)).toEqual(before)
    fresh.close()
  })

  it('skips the rebuild when nothing changed and catches up when a file changes or goes away', () => {
    syncGraph(db, WS, kb)
    expect(syncGraph(db, WS, kb).rebuilt).toBe(false)
    fs.rmSync(path.join(kb, `${PEOPLE}/sam-okafor.md`))
    expect(syncGraph(db, WS, kb).rebuilt).toBe(true)
    expect(readEdges(db, WS).some(e => e.from_rel.endsWith('sam-okafor.md') || e.to_rel.endsWith('sam-okafor.md'))).toBe(false)
    expect(readNodes(db, WS).some(n => n.rel.endsWith('sam-okafor.md'))).toBe(false)
  })

  it('keeps workspaces apart', () => {
    syncGraph(db, WS, kb)
    syncGraph(db, 'other', fs.mkdtempSync(path.join(os.tmpdir(), 'kbwiki-graph-empty-')))
    expect(readEdges(db, 'other')).toEqual([])
    expect(readEdges(db, WS).length).toBeGreaterThan(0)
  })

  it('every wiki compile refreshes the table through onWikiCompiled', () => {
    const off = onWikiCompiled(root => { syncGraph(db, WS, root) })
    try {
      compileWiki(kb)
      expect(readEdges(db, WS).length).toBeGreaterThan(0)
      write(`${PEOPLE}/priya-nair.md`, '---\ntitle: Priya Nair\ntype: person\n---\n# Priya Nair\n\nBookkeeper; pays [[Greenway Growers]].\n')
      compileWiki(kb)
      expect(readEdges(db, WS).some(e => e.from_rel === `${PEOPLE}/priya-nair.md` && e.kind === 'mentions')).toBe(true)
    } finally { off() }
  })
})

describe('queries', () => {
  beforeEach(() => { compileWiki(kb); syncGraph(db, WS, kb) })

  it('kb_related: direct neighbours with kind and label, depth 2 goes one step further', () => {
    const one = kbRelated(db, WS, 'Tom Whitfield')!
    expect(one.page.rel).toBe(`${PEOPLE}/tom-whitfield.md`)
    const greenway = one.related.find(r => r.rel === `${ORGS}/greenway-growers.md`)!
    expect(greenway.depth).toBe(1)
    expect(greenway.via).toContainEqual({ from: `${PEOPLE}/tom-whitfield.md`, to: `${ORGS}/greenway-growers.md`, kind: 'related', label: 'works for' })
    expect(one.related.some(r => r.rel === `${ORGS}/fernleaf-garden-supply.md`)).toBe(false)

    const two = kbRelated(db, WS, `${PEOPLE}/tom-whitfield.md`, { depth: 2 })!
    const fern = two.related.find(r => r.rel === `${ORGS}/fernleaf-garden-supply.md`)!
    expect(fern.depth).toBe(2)
    expect(kbRelated(db, WS, 'Nobody Here')).toBeNull()
  })

  it('kb_who_knows: "supplier" finds the supplier and ranks people by citing sources', () => {
    const r = kbWhoKnows(db, WS, 'the supplier')
    expect(r.matched.map(m => m.rel)).toEqual([`${ORGS}/greenway-growers.md`])
    const names = r.people.map(p => p.title)
    expect(names[0]).toBe('Tom Whitfield')
    expect(names).toContain('Sam Okafor')
    const tom = r.people[0]
    expect(tom.links).toContainEqual({ from: `${PEOPLE}/tom-whitfield.md`, to: `${ORGS}/greenway-growers.md`, kind: 'related', label: 'works for' })
    expect(tom.sources).toBeGreaterThanOrEqual(1)
    expect(tom.latest).toBe('2026-09-01') // the one source that cites both Tom and the supplier
    // Jo is only linked to Sam, never to the supplier.
    expect(names).not.toContain('Jo Fairweather')
  })

  it('a page that only links as "supplier of" loses to the one whose summary also says supplier', () => {
    const fern = fs.readFileSync(path.join(kb, `${ORGS}/fernleaf-garden-supply.md`), 'utf8')
    write(`${ORGS}/fernleaf-garden-supply.md`, upsertEntityNote(fern, { type: 'organization', name: 'Fernleaf Garden Supply', facts: [{ fact: 'Maintains the Hillcrest grounds' }], related: [{ type: 'organization', name: 'Hillcrest Property Management', label: 'supplier of' }] }, src('2026-10-01-price-list'), '2026-10-02'))
    write(`${ORGS}/hillcrest-property-management.md`, '---\ntitle: Hillcrest Property Management\ntype: organization\n---\n# Hillcrest Property Management\n\nA client.\n')
    syncGraph(db, WS, kb)
    expect(kbWhoKnows(db, WS, 'supplier').matched.map(m => m.title)).toEqual(['Greenway Growers'])
  })

  it('kb_who_knows by exact page name, and an unknown topic returns no one', () => {
    expect(kbWhoKnows(db, WS, 'Greenway Growers').people[0].title).toBe('Tom Whitfield')
    expect(kbWhoKnows(db, WS, 'zebra crossings')).toEqual({ topic: 'zebra crossings', matched: [], people: [] })
  })
})

describe('nightly cleanup report', () => {
  it('lists connections to missing pages and pages with no connections', async () => {
    const report = await runLint(kb, { staleDays: 10_000, aiPages: 0, now: new Date('2026-10-31T03:00:00Z') })
    const broken = report.needs_human.filter(i => i.kind === 'broken_edge')
    expect(broken).toHaveLength(1)
    expect(broken[0].page).toBe(`${PEOPLE}/jo-fairweather.md`)
    expect(broken[0].detail).toContain('sources/deleted-notes.md')
    expect(report.stats.broken_edges).toBe(1)
    expect(report.stats.graph_edges).toBeGreaterThan(8)
    // Riverbend links nowhere and nothing links to it: already listed as an orphan, so not listed twice.
    const riverbend = report.needs_human.filter(i => i.page === `${ORGS}/riverbend-nursery.md`).map(i => i.kind)
    expect(riverbend).toEqual(['orphan'])
    const md = fs.readFileSync(path.join(kb, 'lint-report.md'), 'utf8')
    expect(md).toContain('Connections to pages that no longer exist')
  })

  it('an isolated source page (not an orphan candidate) is reported once', async () => {
    write('sources/2026-07-01-loose-notes.md', '---\ntitle: Loose notes\ntype: source\ngenerated_by: document-ingest\n---\n# Loose notes\n\nNothing filed from this yet.\n')
    const report = await runLint(kb, { staleDays: 10_000, aiPages: 0, now: new Date('2026-10-31T03:00:00Z') })
    const iso = report.needs_human.filter(i => i.kind === 'isolated')
    expect(iso.map(i => i.page)).toEqual(['sources/2026-07-01-loose-notes.md'])
    expect(fs.readFileSync(path.join(kb, 'lint-report.md'), 'utf8')).toContain('Pages with no connections at all')
  })
})
