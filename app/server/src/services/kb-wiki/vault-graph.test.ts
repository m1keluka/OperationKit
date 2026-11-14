import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import {
  clearGraphCache, deriveGraph, kbWorkspaceGraph, loadVaultPages, makeResolver, parseRelatedTargets,
  readEdges, readNodes, readUnresolved, reindexGraphFile, syncGraph,
} from './graph.js'
import {
  DEFAULT_GRAPH_EXCLUDES, graphKindFor, isExcluded, isNeverIndexed, listVaultMarkdown, normaliseExcludes,
  parseExcludeSetting, singularKind,
} from './vault-scan.js'
import type { WikiPage } from './wiki.js'

// Whole-vault link graph (obj 900815): every markdown folder is indexed, links
// resolve across folders in every form a real vault writes them, and writes
// reindex one file at a time.

const page = (rel: string, title = path.posix.basename(rel, '.md'), aliases: string[] = []): WikiPage =>
  ({ rel, title, kind: graphKindFor(rel), summary: '', aliases, links: [] })

describe('link resolution', () => {
  const pages: WikiPage[] = [
    page('decisions/2026-01-05-use-sqlite.md', 'Use SQLite for the graph'),
    page('architecture/graph-store.md', 'Graph store', ['Link store']),
    page('projects/command-center.md', 'Command Center', ['CC']),
    page('operationkit/idea-log/index.md', 'Idea log'),
    page('operationkit/idea-log/00-strategy-brief.md', 'Strategy brief'),
    page('strategy/pricing.md', 'Pricing'),
  ]
  const resolve = makeResolver(pages, { rootName: 'acme' })
  const from = 'decisions/2026-01-05-use-sqlite.md'

  it('[[wikilinks]] by file stem, title and alias, with #heading and |label', () => {
    expect(resolve('graph-store', from)).toBe('architecture/graph-store.md')
    expect(resolve('Graph store', from)).toBe('architecture/graph-store.md')
    expect(resolve('Link store', from)).toBe('architecture/graph-store.md')
    expect(resolve('CC', from)).toBe('projects/command-center.md')
    expect(resolve('command-center#Rollout plan', from)).toBe('projects/command-center.md')
    expect(resolve('projects/command-center', from)).toBe('projects/command-center.md')
  })

  it('relative and KB-relative .md paths across folders', () => {
    expect(resolve('../architecture/graph-store.md', from)).toBe('architecture/graph-store.md')
    expect(resolve('./00-strategy-brief.md', 'operationkit/idea-log/index.md')).toBe('operationkit/idea-log/00-strategy-brief.md')
    expect(resolve('strategy/pricing.md', from)).toBe('strategy/pricing.md')
    expect(resolve('/strategy/pricing.md', from)).toBe('strategy/pricing.md')
  })

  it('an absolute path written on another machine resolves by its tail', () => {
    expect(resolve('/home/someone/notes/workspaces/acme/strategy/pricing.md', from)).toBe('strategy/pricing.md')
    expect(resolve('/srv/vault/acme/operationkit/idea-log/00-strategy-brief.md', from)).toBe('operationkit/idea-log/00-strategy-brief.md')
    expect(resolve('~/vault/strategy/pricing.md', from)).toBe('strategy/pricing.md')
  })

  it('a path into ANOTHER workspace, a missing page and a lone file name with no folder stay unresolved', () => {
    expect(resolve('/home/someone/notes/workspaces/other-co/strategy/pricing.md', from)).toBeNull()
    expect(resolve('/home/someone/elsewhere/missing.md', from)).toBeNull()
    expect(resolve('nothing-by-this-name', from)).toBeNull()
    expect(resolve('docs/wiki/Some-Repo-Page.md', from)).toBeNull()
  })

  it('reads every target on a Related line, with a "— label" or a "Label:" prefix', () => {
    expect(parseRelatedTargets('- [[graph-store]] — stores the edges')).toEqual([{ target: 'graph-store', label: 'stores the edges' }])
    expect(parseRelatedTargets('- Project: [[command-center]], [[OperationKit]]')).toEqual([
      { target: 'command-center', label: 'project' }, { target: 'OperationKit', label: null },
    ])
    expect(parseRelatedTargets('- Decision: `decisions/2026-01-05-use-sqlite.md`')).toEqual([{ target: 'decisions/2026-01-05-use-sqlite.md', label: 'decision' }])
    expect(parseRelatedTargets('- /home/someone/notes/workspaces/acme/strategy/pricing.md')).toEqual([{ target: '/home/someone/notes/workspaces/acme/strategy/pricing.md', label: null }])
    expect(parseRelatedTargets('- [Idea-log index](../operationkit/idea-log/index.md)')).toEqual([{ target: '../operationkit/idea-log/index.md', label: null }])
    expect(parseRelatedTargets('- Copy brief: /srv/acme/strategy/pricing.md (W2).')).toEqual([{ target: '/srv/acme/strategy/pricing.md', label: 'copy brief' }])
    expect(parseRelatedTargets('- https://example.com/readme.md is the vendor page')).toEqual([])
    expect(parseRelatedTargets('- just words, no link')).toEqual([])
  })
})

describe('what gets indexed', () => {
  it('never indexes hidden files, raw sources, machine state or credential stores', () => {
    for (const rel of ['.git/HEAD.md', '.obsidian/workspace.md', 'notes/.env.md', 'raw/chat-exports/a.md', 'sources/files/x.md',
      '.kb-wiki/imports/x.md', 'secrets/aws.md', 'ops/credentials/db.md', 'credentials.md', 'secrets.md', 'ops/api-keys.md', 'prod.env.md']) {
      expect(isNeverIndexed(rel), rel).toBe(true)
    }
    // Knowledge ABOUT secrets is knowledge.
    for (const rel of ['decisions/2026-06-24-secrets-management-tool-evaluation.md', 'architecture/credential-access-inventory.md', 'index.md', 'people/dana.md']) {
      expect(isNeverIndexed(rel), rel).toBe(false)
    }
  })

  it('exclude list: a bare name matches a folder at any depth, a path matches that prefix only', () => {
    const ex = normaliseExcludes(['archive', '/decisions/2024/', ' TMP '])
    expect(ex).toEqual(['archive', 'decisions/2024', 'tmp'])
    expect(isExcluded('archive/old.md', ex)).toBe(true)
    expect(isExcluded('decisions/archive/old.md', ex)).toBe(true)
    expect(isExcluded('decisions/2024/a.md', ex)).toBe(true)
    expect(isExcluded('decisions/2025/a.md', ex)).toBe(false)
    expect(isExcluded('archive.md', ex)).toBe(false) // a FILE called archive is not the folder
    expect(parseExcludeSetting(null)).toEqual([...DEFAULT_GRAPH_EXCLUDES])
    expect(parseExcludeSetting('\n')).toEqual([])
    expect(parseExcludeSetting('drafts, old/2023')).toEqual(['drafts', 'old/2023'])
  })

  it('node kind comes from the folder', () => {
    expect(['decisions', 'architecture', 'audits', 'strategy', 'prds', 'runbooks', 'bots', 'policies', 'processes', 'analysis', 'Meeting Notes'].map(singularKind))
      .toEqual(['decision', 'architecture', 'audit', 'strategy', 'prd', 'runbook', 'bot', 'policy', 'process', 'analysis', 'meeting-note'])
    expect(graphKindFor('people/dana.md')).toBe('person') // the wiki's own folders keep their kinds
    expect(graphKindFor('projects/x.md')).toBe('project')
    expect(graphKindFor('sources/conversations/j/x.md')).toBe('source')
    expect(graphKindFor('decisions/sub/x.md')).toBe('decision')
    expect(graphKindFor('README.md')).toBe('note')
  })
})

// ── Fixture vault ────────────────────────────────────────────────────────────

let kb: string
let db: Database.Database
const WS = 'acme'

function write(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(kb, rel)), { recursive: true })
  fs.writeFileSync(path.join(kb, rel), text)
}

/** Bump a file's mtime so the cache sees the change even within the same millisecond. */
function touch(rel: string): void {
  const t = new Date(Date.now() + 5000)
  fs.utimesSync(path.join(kb, rel), t, t)
}

/** A vault the way people actually keep one: many folders, every link style, and things that must stay out. */
function buildVault(): void {
  write('decisions/2026-01-05-use-sqlite.md', [
    '---', 'title: Use SQLite for the graph', 'date: 2026-01-05', '---', '# Use SQLite for the graph', '',
    'We store edges next to the board. See [[graph-store]] and the [pricing model](../strategy/pricing.md).',
    'Supersedes [[2025-12-01-graph-db#Why not]].', 'Also [[Nobody Wrote This Yet]].', '',
    '## Related', '', '- Project: [[command-center]]', '- PRD: `prds/graph-view.md`',
    `- Audit: /home/someone/notes/workspaces/${WS}/audits/2026-01-graph-audit.md`, '- Elsewhere: /home/someone/notes/workspaces/other-co/decisions/x.md', '',
  ].join('\n'))
  write('decisions/2025-12-01-graph-db.md', '# Use a graph database?\n\nRejected.\n')
  write('architecture/graph-store.md', '---\ntitle: Graph store\naliases: [Link store]\n---\n# Graph store\n\nThree tables. Decided in [[2026-01-05-use-sqlite]].\n')
  write('audits/2026-01-graph-audit.md', '# Graph audit\n\nFound the graph empty. Runbook: [fix](../runbooks/reindex.md).\n')
  write('runbooks/reindex.md', '# Reindex the graph\n\nOwned by [[Graph store]].\n')
  write('prds/graph-view.md', '# PRD: graph view\n\n## See also\n\n- [[Link store]] — data\n')
  write('strategy/pricing.md', '# Pricing\n\nStandalone.\n')
  write('bots/librarian.md', '# Librarian bot\n\nKeeps [[command-center]] tidy.\n')
  write('projects/command-center.md', '---\ntitle: Command Center\n---\n# Command Center\n\nThe board.\n')
  write('people/dana-ruiz.md', '---\ntitle: Dana Ruiz\ntype: person\n---\n# Dana Ruiz\n\nWrote [[Use SQLite for the graph]].\n')
  write('README.md', '# Acme vault\n\nStart at [[command-center]].\n')
  // Must never be indexed:
  write('archive/old-plan.md', '# Old plan\n\n[[command-center]]\n')
  write('decisions/tmp/scratch.md', '# Scratch\n\n[[command-center]]\n')
  write('secrets/vendor-keys.md', '# Keys\n\nAPI_KEY=nope\n')
  write('credentials.md', '# creds\n')
  write('.git/notes.md', '# git internals\n')
  write('.obsidian/workspace.md', '# editor state\n')
  write('raw/chat-exports/export.md', '# raw export\n\n[[command-center]]\n')
  write('notes.txt', 'not markdown')
}

beforeEach(() => {
  kb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-vault-graph-')), WS)
  fs.mkdirSync(kb)
  db = new Database(':memory:')
  clearGraphCache()
  buildVault()
})
afterEach(() => {
  db.close()
  fs.rmSync(path.dirname(kb), { recursive: true, force: true })
})

const edge = (from: string, to: string) => readEdges(db, WS).find(e => e.from_rel === from && e.to_rel === to)

describe('fixture vault', () => {
  it('indexes every markdown folder and nothing it must not', () => {
    const r = syncGraph(db, WS, kb)
    const rels = readNodes(db, WS).map(n => n.rel)
    expect(rels).toEqual([
      'README.md', 'architecture/graph-store.md', 'audits/2026-01-graph-audit.md', 'bots/librarian.md',
      'decisions/2025-12-01-graph-db.md', 'decisions/2026-01-05-use-sqlite.md', 'people/dana-ruiz.md', 'prds/graph-view.md',
      'projects/command-center.md', 'runbooks/reindex.md', 'strategy/pricing.md',
    ])
    expect(r.nodes).toBe(11)
    const kinds = Object.fromEntries(readNodes(db, WS).map(n => [n.rel, n.kind]))
    expect(kinds).toMatchObject({
      'decisions/2026-01-05-use-sqlite.md': 'decision', 'architecture/graph-store.md': 'architecture', 'audits/2026-01-graph-audit.md': 'audit',
      'runbooks/reindex.md': 'runbook', 'prds/graph-view.md': 'prd', 'strategy/pricing.md': 'strategy', 'bots/librarian.md': 'bot',
      'projects/command-center.md': 'project', 'people/dana-ruiz.md': 'person', 'README.md': 'note',
    })
  })

  it('resolves edges across folders from every link form', () => {
    syncGraph(db, WS, kb)
    const D = 'decisions/2026-01-05-use-sqlite.md'
    expect(edge(D, 'architecture/graph-store.md')?.kind).toBe('mentions') // [[stem]]
    expect(edge(D, 'strategy/pricing.md')?.kind).toBe('mentions') // [md](../path.md)
    expect(edge(D, 'decisions/2025-12-01-graph-db.md')?.kind).toBe('mentions') // [[stem#heading]]
    expect(edge(D, 'projects/command-center.md')).toMatchObject({ kind: 'related', label: 'project' }) // Related: [[x]]
    expect(edge(D, 'prds/graph-view.md')).toMatchObject({ kind: 'related', label: 'prd' }) // Related: `path`
    expect(edge(D, 'audits/2026-01-graph-audit.md')?.kind).toBe('related') // Related: absolute path from another machine
    expect(edge('prds/graph-view.md', 'architecture/graph-store.md')).toMatchObject({ kind: 'related', label: 'data' }) // ## See also, alias
    expect(edge('runbooks/reindex.md', 'architecture/graph-store.md')?.kind).toBe('mentions') // [[Title]]
    expect(edge('people/dana-ruiz.md', D)?.kind).toBe('mentions') // a wiki page linking into decisions/
    expect(edge('audits/2026-01-graph-audit.md', 'runbooks/reindex.md')?.kind).toBe('mentions')

    const g = kbWorkspaceGraph(db, WS)
    expect(g.counts.pages).toBe(11)
    expect(g.counts.links).toBeGreaterThanOrEqual(12)
    expect(g.nodes.find(n => n.rel === 'strategy/pricing.md')!.degree).toBe(1)
    expect(Object.keys(g.counts.by_kind).sort()).toEqual(['architecture', 'audit', 'bot', 'decision', 'note', 'person', 'prd', 'project', 'runbook', 'strategy'])
  })

  it('reports unresolved targets instead of dropping them', () => {
    syncGraph(db, WS, kb)
    const u = readUnresolved(db, WS)
    expect(u.targets.map(t => t.target).sort()).toEqual(['/home/someone/notes/workspaces/other-co/decisions/x.md', 'Nobody Wrote This Yet'])
    expect(u.total).toBe(2)
    expect(kbWorkspaceGraph(db, WS).counts.unresolved).toBe(2)
  })

  it('the exclude list is configurable through the settings table', () => {
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
    db.prepare("INSERT INTO settings (key, value) VALUES ('kb_graph_exclude', 'strategy\nbots')").run()
    syncGraph(db, WS, kb)
    const rels = readNodes(db, WS).map(n => n.rel)
    expect(rels).not.toContain('strategy/pricing.md')
    expect(rels).not.toContain('bots/librarian.md')
    expect(rels).toContain('archive/old-plan.md') // the defaults no longer apply…
    expect(rels).not.toContain('secrets/vendor-keys.md') // …but credential stores stay out regardless
  })

  it('a nested folder that belongs to another workspace is skipped', () => {
    write('clients/other-co/notes.md', '# Their notes\n')
    syncGraph(db, WS, kb, { skipAbs: [path.join(kb, 'clients/other-co')] })
    expect(readNodes(db, WS).some(n => n.rel.startsWith('clients/other-co'))).toBe(false)
  })

  it('never follows a symlink out of the knowledge folder', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-outside-'))
    fs.writeFileSync(path.join(outside, 'private.md'), '# Not ours\n')
    try {
      fs.symlinkSync(outside, path.join(kb, 'linked'))
      expect(listVaultMarkdown(kb).some(f => f.rel.startsWith('linked/'))).toBe(false)
    } finally { fs.rmSync(outside, { recursive: true, force: true }) }
  })

  it('a hand-written title that is not valid JSON does not stop the scan', () => {
    write('decisions/quoted.md', '---\ntitle: "Re-Open" replaces "Re-queue"\n---\nBody.\n')
    syncGraph(db, WS, kb)
    expect(readNodes(db, WS).find(n => n.rel === 'decisions/quoted.md')!.title).toBe('"Re-Open" replaces "Re-queue"')
  })
})

describe('incremental reindex', () => {
  it('a rebuild re-reads only the files that changed', () => {
    expect(syncGraph(db, WS, kb).reread).toBe(11)
    expect(syncGraph(db, WS, kb)).toMatchObject({ rebuilt: false, reread: 0 })
    write('strategy/pricing.md', '# Pricing\n\nNow tied to [[Graph store]].\n')
    touch('strategy/pricing.md')
    const r = syncGraph(db, WS, kb)
    expect(r).toMatchObject({ rebuilt: true, reread: 1 })
    expect(edge('strategy/pricing.md', 'architecture/graph-store.md')?.kind).toBe('mentions')
  })

  it('editing one page replaces only that page\'s rows', () => {
    syncGraph(db, WS, kb)
    const before = readEdges(db, WS).filter(e => e.source_rel !== 'runbooks/reindex.md')
    write('runbooks/reindex.md', '# Reindex the graph\n\nOwned by [[Graph store]]; see [[2026-01-05-use-sqlite]] and [[Ghost page]].\n')
    touch('runbooks/reindex.md')
    const r = reindexGraphFile(db, WS, kb, 'runbooks/reindex.md')
    expect(r).toMatchObject({ mode: 'file', reread: 1 })
    expect(edge('runbooks/reindex.md', 'decisions/2026-01-05-use-sqlite.md')?.kind).toBe('mentions')
    expect(readEdges(db, WS).filter(e => e.source_rel !== 'runbooks/reindex.md')).toEqual(before)
    expect(readUnresolved(db, WS).targets.map(t => t.target)).toContain('Ghost page')
    // The stored signature moved too, so the next read has nothing to do.
    expect(syncGraph(db, WS, kb).rebuilt).toBe(false)
    // …and a full rebuild from scratch agrees with the incremental result.
    const inc = readEdges(db, WS)
    expect(syncGraph(db, WS, kb, { force: true }).rebuilt).toBe(true)
    expect(readEdges(db, WS)).toEqual(inc)
  })

  it('a NEW page re-resolves links other pages already wrote to it (no other file re-read)', () => {
    syncGraph(db, WS, kb)
    expect(readUnresolved(db, WS).targets.map(t => t.target)).toContain('Nobody Wrote This Yet')
    write('topics/nobody-wrote-this-yet.md', '# Nobody Wrote This Yet\n\nNow somebody did.\n')
    const r = reindexGraphFile(db, WS, kb, 'topics/nobody-wrote-this-yet.md')
    expect(r).toMatchObject({ mode: 'full', reread: 1 })
    expect(edge('decisions/2026-01-05-use-sqlite.md', 'topics/nobody-wrote-this-yet.md')?.kind).toBe('mentions')
    expect(readUnresolved(db, WS).targets.map(t => t.target)).not.toContain('Nobody Wrote This Yet')
  })

  it('a deleted page takes its node and edges with it', () => {
    syncGraph(db, WS, kb)
    fs.rmSync(path.join(kb, 'architecture/graph-store.md'))
    expect(reindexGraphFile(db, WS, kb, 'architecture/graph-store.md').mode).toBe('full')
    expect(readNodes(db, WS).some(n => n.rel === 'architecture/graph-store.md')).toBe(false)
    expect(readEdges(db, WS).some(e => e.to_rel === 'architecture/graph-store.md' || e.from_rel === 'architecture/graph-store.md')).toBe(false)
    expect(readUnresolved(db, WS).targets.map(t => t.target)).toContain('graph-store')
  })

  it('a write to an excluded or secret file changes nothing', () => {
    syncGraph(db, WS, kb)
    write('archive/new.md', '# x\n')
    expect(reindexGraphFile(db, WS, kb, 'archive/new.md').mode).toBe('skipped')
    write('secrets/more.md', '# x\n')
    expect(reindexGraphFile(db, WS, kb, 'secrets/more.md').mode).toBe('skipped')
    expect(readNodes(db, WS)).toHaveLength(11)
  })

  it('a cold cache (server restart) falls back to one full pass', () => {
    syncGraph(db, WS, kb)
    clearGraphCache()
    write('strategy/pricing.md', '# Pricing\n\nSee [[Graph store]].\n')
    touch('strategy/pricing.md')
    const r = reindexGraphFile(db, WS, kb, 'strategy/pricing.md')
    expect(r.mode).toBe('full')
    expect(edge('strategy/pricing.md', 'architecture/graph-store.md')).toBeTruthy()
  })

  it('deriveGraph over the cached pages is deterministic', () => {
    const files = listVaultMarkdown(kb)
    const a = deriveGraph(loadVaultPages(kb, files), { rootName: WS })
    clearGraphCache()
    const b = deriveGraph(loadVaultPages(kb, files), { rootName: WS })
    expect(b).toEqual(a)
  })
})
