import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'
import { parseNote } from '../doc-ingest/notes.js'
import { INDEX_PAGE, LINT_REPORT_PAGE, LOG_PAGE } from './paths.js'
import { fmField, loadPageFile, nameKey, parseLinks, resolveLinkTarget, type LoadedPage, type WikiPage } from './wiki.js'
import { DEFAULT_GRAPH_EXCLUDES, graphKindFor, listVaultMarkdown, parseExcludeSetting, vaultSignature, type VaultFile, type VaultScanOptions } from './vault-scan.js'

/**
 * The knowledge base's small typed link graph (obj 720162).
 *
 * Two SQLite tables, both DERIVED from the markdown files and rebuilt whenever
 * the wiki compiles (and on read when the files changed since — a content
 * signature, the way services/vault-index.ts does it):
 *
 *   kb_edges  workspace, from_rel, to_rel, kind, label, source_rel, updated
 *   kb_nodes  workspace, rel, title, kind, aliases, summary, updated   (names for the edges)
 *
 * Edge kinds, all read from the page scan in wiki.ts:
 *   related      an entity page's "## Related" list (label = "works for", "supplier of", … when the AI gave one)
 *   mentions     a [[wikilink]] in a page body
 *   cited_by     a page's frontmatter `sources:` — "this page is cited by that source"
 *   answer_used  a saved answer page → each page it used
 *
 * `source_rel` is the file the edge was read from; delete that file and the
 * edge goes with it. The files stay the source of truth: dropping both tables
 * loses nothing, the next read rebuilds them. No graph database, no embeddings.
 */

export const EDGE_KINDS = ['related', 'mentions', 'cited_by', 'answer_used'] as const
export type EdgeKind = typeof EDGE_KINDS[number]

export interface KbEdge {
  from_rel: string
  to_rel: string
  kind: EdgeKind
  label: string | null
  /** The file this edge was read from. */
  source_rel: string
  /** Date of that file (frontmatter `date`, else `updated`), or null. */
  updated: string | null
}

export interface KbNode {
  rel: string
  title: string
  kind: string
  aliases: string[]
  summary: string
  updated: string | null
}

/** A declared connection whose target file is missing (frontmatter only — body links are lint's broken-link check). */
export interface BrokenEdge {
  from_rel: string
  target: string
  kind: EdgeKind
}

/**
 * A link written on a page (body [[wikilink]] or [md](link.md), or an entry in its
 * "## Related" section) that matches no indexed page (obj 900815). Reported, never
 * silently dropped: GET /api/kb-wiki/graph/unresolved lists them.
 */
export interface UnresolvedLink {
  from_rel: string
  /** The target as written (without #heading). */
  target: string
  kind: EdgeKind
}

export interface KbGraph { nodes: KbNode[]; edges: KbEdge[]; broken: BrokenEdge[]; unresolved: UnresolvedLink[] }

// ── Derive (pure over the page scan) ─────────────────────────────────────────

function bodyOf(text: string): string {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/)
  return m ? text.slice(m[0].length) : text
}

/**
 * The lines of a page's "## Related" (or "## See also") section, and the body
 * without it. Nested list items count too.
 */
function splitRelated(body: string): { related: string[]; rest: string } {
  const m = body.match(/^#{2,3} (?:Related|See also)\b[^\n]*\n([\s\S]*?)(?=^#{1,3} |^<!-- kb-wiki:backlinks -->|(?![\s\S]))/im)
  if (!m) return { related: [], rest: body }
  return { related: m[1].split('\n').filter(l => /^\s*[-*+] /.test(l)), rest: body.replace(m[0], '') }
}

/** "- [Tom Whitfield](../people/tom-whitfield.md) (person) — works for" → target + label. Also accepts a [[wikilink]]. */
export function parseRelatedLine(line: string): { target: string; label: string | null } | null {
  const link = parseLinks(line)[0]
  if (!link) return null
  const after = line.slice(line.indexOf(link.match) + link.match.length)
  const label = after.match(/\s[—–]\s+(.+?)\s*$/)?.[1]?.trim().toLowerCase() || null
  return { target: link.target, label: label ? label.slice(0, 40) : null }
}

/** A path to a .md file written WITHOUT link syntax: in backticks, or bare (`decisions/x.md`, `/abs/…/x.md`, `../x.md`). */
const CODE_PATH_RE = /`([^`\s]+?\.md)(?:#[^`\s]*)?`/gi
const BARE_PATH_RE = /(?:^|[\s(:])((?:~\/|\/|\.{1,2}\/)?[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)*\.md)(?=$|[\s),;:]|\.(?:\s|$))/gi

/**
 * Every target on one "## Related" line, in order (obj 900815). Real vaults
 * write these lines many ways, and all of them are connections:
 *
 *   - [[page]] / [[page|label]] / [[page#heading]]       wikilinks (several per line)
 *   - [Title](../folder/page.md)                         markdown links
 *   - Decision: `decisions/2026-01-01-x.md`              a path in backticks
 *   - /abs/path/to/workspaces/acme/decisions/x.md        a bare path (absolute or relative)
 *
 * The label is the "— label" after the first link when there is one,
 * otherwise a short "Label:" prefix ("Project: [[x]]" → "project").
 */
export function parseRelatedTargets(line: string): Array<{ target: string; label: string | null }> {
  const out: Array<{ target: string; label: string | null }> = []
  const dash = parseRelatedLine(line)?.label ?? null
  const prefix = line.match(/^\s*[-*+]\s+([A-Za-z][\w ()/'-]{0,38}?):\s/)?.[1]?.trim().toLowerCase() ?? null
  const label = dash ?? prefix
  let rest = line
  for (const l of parseLinks(line)) {
    out.push({ target: l.target, label: out.length ? null : label })
    rest = rest.replace(l.match, ' ')
  }
  // Inline code is dropped by parseLinks, so a backticked path is read here.
  for (const m of rest.matchAll(CODE_PATH_RE)) out.push({ target: m[1], label: out.length ? null : label })
  rest = rest.replace(CODE_PATH_RE, ' ')
  for (const m of rest.matchAll(BARE_PATH_RE)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue
    out.push({ target: m[1], label: out.length ? null : label })
  }
  return out
}

function dateOf(text: string): string | null {
  const v = (fmField(text, 'date') || fmField(text, 'updated') || '').trim()
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
}

interface Resolver { (target: string, fromRel: string): string | null }

/**
 * Link resolution over the indexed pages (obj 900815). On top of the wiki's
 * own rules (`resolveLinkTarget`: KB-relative, page-relative, then a bare name
 * against every page's file stem, title and aliases, with #heading stripped),
 * an ABSOLUTE path is matched by its tail, because vault notes are often
 * written on another machine or before the vault moved
 * (`/home/someone/notes/workspaces/acme/decisions/x.md` → `decisions/x.md`).
 * The longest tail that is exactly an indexed page wins, and at least the
 * folder + file name must match. A path that runs through another
 * workspace's folder (`…/workspaces/<other>/…` when this one is `rootName`)
 * is not this workspace's page and stays unresolved.
 */
export function makeResolver(pages: WikiPage[], opts: { rootName?: string } = {}): Resolver {
  const byRel = new Map(pages.map(p => [p.rel.toLowerCase(), p.rel]))
  return (target, fromRel) => {
    const hit = resolveLinkTarget(pages, target, fromRel)
    if (hit) return hit
    const t = target.split('#')[0].trim()
    if (!/^(?:~\/|\/)/.test(t)) return null
    const segs = t.replace(/^~\//, '').split('/').filter(Boolean)
    if (!segs.length) return null
    if (!/\.md$/i.test(segs[segs.length - 1])) segs[segs.length - 1] += '.md'
    const ws = segs.lastIndexOf('workspaces')
    if (opts.rootName && ws >= 0 && ws + 1 < segs.length - 1 && segs[ws + 1] !== opts.rootName) return null
    for (let k = segs.length - 1; k >= 2; k--) {
      const r = byRel.get(segs.slice(-k).join('/').toLowerCase())
      if (r) return r
    }
    return null
  }
}

/** Root pages the wiki generates (index, log, cleanup report): they link to everything, so they are not graph nodes. */
const GENERATED_ROOT_PAGES = new Set([INDEX_PAGE, LOG_PAGE, LINT_REPORT_PAGE].flatMap(n => [n, `wiki-${n}`]))

export function isGeneratedRootPage(l: LoadedPage): boolean {
  return l.generated && GENERATED_ROOT_PAGES.has(l.page.rel)
}

/** One page's outgoing edges, frontmatter connections to missing pages, and links that resolve nowhere. */
export function derivePageEdges(l: LoadedPage, resolve: Resolver): { edges: KbEdge[]; broken: BrokenEdge[]; unresolved: UnresolvedLink[] } {
  const from = l.page.rel
  const isAnswer = l.page.kind === 'answer'
  const updated = dateOf(l.text)
  const edges = new Map<string, KbEdge>()
  const broken: BrokenEdge[] = []
  const unresolved = new Map<string, UnresolvedLink>()
  const edge = (to: string, kind: EdgeKind, label: string | null = null) => {
    if (to === from) return
    const key = `${to}\0${kind}`
    const prev = edges.get(key)
    if (!prev) edges.set(key, { from_rel: from, to_rel: to, kind, label, source_rel: from, updated })
    else if (!prev.label && label) prev.label = label
  }
  const miss = (target: string, kind: EdgeKind) => {
    const t = target.split('#')[0].trim()
    if (t && !unresolved.has(`${t}\0${kind}`)) unresolved.set(`${t}\0${kind}`, { from_rel: from, target: t, kind })
  }

  // Frontmatter sources first, so a "*Source: [file](…)*" body link to the same page is not counted twice.
  const cited = new Set<string>()
  for (const s of parseNote(l.text).fm?.sources ?? []) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) continue // a URL, not a page
    const kind: EdgeKind = isAnswer ? 'answer_used' : 'cited_by'
    const to = resolve(s, from)
    if (to) { edge(to, kind); cited.add(to) } else broken.push({ from_rel: from, target: s, kind })
  }

  const { related, rest } = splitRelated(bodyOf(l.text))
  for (const line of related) {
    for (const r of parseRelatedTargets(line)) {
      const to = resolve(r.target, from)
      if (to) edge(to, isAnswer ? 'answer_used' : 'related', r.label)
      else miss(r.target, isAnswer ? 'answer_used' : 'related')
    }
  }
  // A page that a pipeline wrote (doc-ingest, an import) cites its sources with plain markdown links;
  // those are `sources:` already. On a hand-written page a markdown link is a real mention.
  const pipelineMd = !isAnswer && !!fmField(l.text, 'generated_by')
  for (const link of parseLinks(rest)) {
    if (link.form === 'md' && pipelineMd) continue
    const to = resolve(link.target, from)
    if (to) { if (!(link.form === 'md' && cited.has(to))) edge(to, isAnswer ? 'answer_used' : 'mentions') }
    else miss(link.target, isAnswer ? 'answer_used' : 'mentions')
  }
  return { edges: [...edges.values()], broken, unresolved: [...unresolved.values()] }
}

function byEdge(a: KbEdge, b: KbEdge): number {
  return a.from_rel.localeCompare(b.from_rel) || a.to_rel.localeCompare(b.to_rel) || a.kind.localeCompare(b.kind)
}

function nodeOf(l: LoadedPage): KbNode {
  return { rel: l.page.rel, title: l.page.title, kind: l.page.kind, aliases: [...l.page.aliases], summary: l.page.summary, updated: dateOf(l.text) }
}

/** Nodes, edges, broken connections and unresolved links for every page. Deterministic: same files → same rows, same order. */
export function deriveGraph(loaded: LoadedPage[], opts: { rootName?: string } = {}): KbGraph {
  const resolve = makeResolver(loaded.map(l => l.page), opts)
  const edges: KbEdge[] = []
  const broken: BrokenEdge[] = []
  const unresolved: UnresolvedLink[] = []
  for (const l of loaded) {
    const d = derivePageEdges(l, resolve)
    edges.push(...d.edges)
    broken.push(...d.broken)
    unresolved.push(...d.unresolved)
  }
  return { nodes: loaded.map(nodeOf), edges: edges.sort(byEdge), broken, unresolved }
}

/** Pages with no connection in either direction (lint's "isolated" check). */
export function isolatedPages(graph: KbGraph): KbNode[] {
  const touched = new Set<string>()
  for (const e of graph.edges) { touched.add(e.from_rel); touched.add(e.to_rel) }
  return graph.nodes.filter(n => !touched.has(n.rel))
}

// ── Store ────────────────────────────────────────────────────────────────────

export function ensureGraphSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_edges (
      workspace TEXT NOT NULL,
      from_rel TEXT NOT NULL,
      to_rel TEXT NOT NULL,
      kind TEXT NOT NULL,
      label TEXT,
      source_rel TEXT NOT NULL,
      updated TEXT,
      PRIMARY KEY (workspace, from_rel, to_rel, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_kb_edges_to ON kb_edges(workspace, to_rel);
    CREATE TABLE IF NOT EXISTS kb_nodes (
      workspace TEXT NOT NULL,
      rel TEXT NOT NULL,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      aliases TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      updated TEXT,
      PRIMARY KEY (workspace, rel)
    );
    CREATE TABLE IF NOT EXISTS kb_unresolved (
      workspace TEXT NOT NULL,
      from_rel TEXT NOT NULL,
      target TEXT NOT NULL,
      kind TEXT NOT NULL,
      PRIMARY KEY (workspace, from_rel, target, kind)
    );
    CREATE TABLE IF NOT EXISTS kb_graph_state (
      workspace TEXT PRIMARY KEY,
      kb_root TEXT NOT NULL,
      signature TEXT NOT NULL,
      built_at TEXT NOT NULL
    );
  `)
}

/** The exclude list stored in `settings.kb_graph_exclude` (newline/comma list), else the defaults. */
export function graphExcludes(db: Database.Database): string[] {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'kb_graph_exclude'").get() as { value: string } | undefined
    return parseExcludeSetting(row?.value)
  } catch { return [...DEFAULT_GRAPH_EXCLUDES] }
}

export interface GraphSyncOptions extends VaultScanOptions { force?: boolean; now?: Date }

function scanOpts(db: Database.Database, opts: VaultScanOptions): VaultScanOptions {
  return { ...opts, excludes: opts.excludes ?? graphExcludes(db) }
}

/** Cheap content signature: every indexed file's path, size and modified time. No file is read. */
export function graphSignature(kbRoot: string, opts: VaultScanOptions = {}): string {
  return vaultSignature(listVaultMarkdown(kbRoot, opts), opts)
}

// ── Incremental parse cache (obj 900815) ─────────────────────────────────────
//
// Each indexed file is parsed once and kept, keyed by size + modified time.
// A rebuild re-reads only the files that changed; link resolution then runs
// over the cached pages (in memory, milliseconds). After a server restart the
// first sync re-reads everything once.

interface CachedFile { size: number; mtimeMs: number; loaded: LoadedPage | null }
const parseCache = new Map<string, Map<string, CachedFile>>()

function cacheFor(kbRoot: string): Map<string, CachedFile> {
  const key = path.resolve(kbRoot)
  let c = parseCache.get(key)
  if (!c) { c = new Map(); parseCache.set(key, c) }
  return c
}

/** Forget every cached parse (tests; or after a bulk change made behind the server's back). */
export function clearGraphCache(kbRoot?: string): void {
  if (kbRoot) parseCache.delete(path.resolve(kbRoot))
  else parseCache.clear()
}

/** Parse one file through the cache. Null for an unreadable file or a generated root page. */
function loadCached(kbRoot: string, f: VaultFile, stats?: { reread: number }): LoadedPage | null {
  const cache = cacheFor(kbRoot)
  const hit = cache.get(f.rel)
  if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit.loaded
  let loaded = loadPageFile(kbRoot, f.rel, graphKindFor(f.rel))
  if (loaded && isGeneratedRootPage(loaded)) loaded = null
  cache.set(f.rel, { size: f.size, mtimeMs: f.mtimeMs, loaded })
  if (stats) stats.reread++
  return loaded
}

/** Every indexed page of the vault, re-reading only files that changed since the last call. */
export function loadVaultPages(kbRoot: string, files: VaultFile[], stats?: { reread: number }): LoadedPage[] {
  const cache = cacheFor(kbRoot)
  const live = new Set(files.map(f => f.rel))
  for (const rel of [...cache.keys()]) if (!live.has(rel)) cache.delete(rel)
  const out: LoadedPage[] = []
  for (const f of files) {
    const l = loadCached(kbRoot, f, stats)
    if (l) out.push(l)
  }
  return out
}

/** The whole-vault graph for `kbRoot`, straight from the files (no DB). */
export function buildVaultGraph(kbRoot: string, opts: VaultScanOptions = {}): KbGraph {
  const files = listVaultMarkdown(kbRoot, opts)
  return deriveGraph(loadVaultPages(kbRoot, files), { rootName: path.basename(path.resolve(kbRoot)) })
}

// ── Write ────────────────────────────────────────────────────────────────────

function insertRows(db: Database.Database, workspace: string, graph: Pick<KbGraph, 'nodes' | 'edges' | 'unresolved'>): void {
  const insEdge = db.prepare('INSERT OR REPLACE INTO kb_edges (workspace, from_rel, to_rel, kind, label, source_rel, updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insNode = db.prepare('INSERT OR REPLACE INTO kb_nodes (workspace, rel, title, kind, aliases, summary, updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insMiss = db.prepare('INSERT OR IGNORE INTO kb_unresolved (workspace, from_rel, target, kind) VALUES (?, ?, ?, ?)')
  for (const e of graph.edges) insEdge.run(workspace, e.from_rel, e.to_rel, e.kind, e.label, e.source_rel, e.updated)
  for (const n of graph.nodes) insNode.run(workspace, n.rel, n.title, n.kind, JSON.stringify(n.aliases), n.summary, n.updated)
  for (const u of graph.unresolved) insMiss.run(workspace, u.from_rel, u.target, u.kind)
}

function saveState(db: Database.Database, workspace: string, kbRoot: string, signature: string, now: Date): void {
  db.prepare(`INSERT INTO kb_graph_state (workspace, kb_root, signature, built_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace) DO UPDATE SET kb_root = excluded.kb_root, signature = excluded.signature, built_at = excluded.built_at`)
    .run(workspace, path.resolve(kbRoot), signature, now.toISOString())
}

/** Replace one workspace's rows with `graph`, in one transaction. */
export function writeGraph(db: Database.Database, workspace: string, kbRoot: string, graph: KbGraph, signature: string, now = new Date()): void {
  ensureGraphSchema(db)
  db.transaction(() => {
    for (const t of ['kb_edges', 'kb_nodes', 'kb_unresolved']) db.prepare(`DELETE FROM ${t} WHERE workspace = ?`).run(workspace)
    insertRows(db, workspace, { ...graph, unresolved: graph.unresolved ?? [] })
    saveState(db, workspace, kbRoot, signature, now)
  })()
}

export interface GraphSyncResult { rebuilt: boolean; edges: number; nodes: number; unresolved: number; reread: number }

function counts(db: Database.Database, workspace: string): { edges: number; nodes: number; unresolved: number } {
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE workspace = ?`).get(workspace) as { n: number }).n
  return { edges: count('kb_edges'), nodes: count('kb_nodes'), unresolved: count('kb_unresolved') }
}

/**
 * Bring the tables up to date with the files: every markdown file of the
 * workspace's knowledge folder (see vault-scan.ts). Re-derives only when the
 * signature changed (or `force`), and then re-reads only the files that
 * changed. The signature is taken BEFORE the scan, so a file written mid-scan
 * changes it again and the next call catches up.
 */
export function syncGraph(db: Database.Database, workspace: string, kbRoot: string, opts: GraphSyncOptions = {}): GraphSyncResult {
  ensureGraphSchema(db)
  const so = scanOpts(db, opts)
  const files = listVaultMarkdown(kbRoot, so)
  const signature = vaultSignature(files, so)
  const state = db.prepare('SELECT signature, kb_root FROM kb_graph_state WHERE workspace = ?').get(workspace) as { signature: string; kb_root: string } | undefined
  if (!opts.force && state && state.signature === signature && state.kb_root === path.resolve(kbRoot)) {
    return { rebuilt: false, ...counts(db, workspace), reread: 0 }
  }
  const stats = { reread: 0 }
  const graph = deriveGraph(loadVaultPages(kbRoot, files, stats), { rootName: path.basename(path.resolve(kbRoot)) })
  writeGraph(db, workspace, kbRoot, graph, signature, opts.now)
  return { rebuilt: true, edges: graph.edges.length, nodes: graph.nodes.length, unresolved: graph.unresolved.length, reread: stats.reread }
}

export interface FileReindexResult extends GraphSyncResult {
  /** 'file': only that page's rows were replaced. 'full': a page appeared, vanished or was renamed, so every link was re-resolved (from the cache). 'skipped': not an indexed file. */
  mode: 'file' | 'full' | 'skipped'
}

/** Names a link can resolve by. When these change, other pages' links may change too. */
function nameSig(l: LoadedPage | null | undefined): string {
  return l ? JSON.stringify([l.page.title, [...l.page.aliases].sort()]) : '∅'
}

/**
 * Incremental reindex after ONE file was written or deleted (obj 900815) —
 * called by every write path (the Knowledge base editor, MCP write_doc and
 * session writes through PUT /api/docs/file, imports, the KB setup agent and
 * saved answers through the wiki compile). Only that file is re-read. When its
 * title/aliases are unchanged and it already existed, only its own rows are
 * replaced; otherwise links are re-resolved across the vault from the parse
 * cache (no other file is re-read). The stored signature is refreshed, so the
 * next graph read does not rebuild again.
 */
export function reindexGraphFile(db: Database.Database, workspace: string, kbRoot: string, rel: string, opts: GraphSyncOptions = {}): FileReindexResult {
  ensureGraphSchema(db)
  const so = scanOpts(db, opts)
  const now = opts.now ?? new Date()
  const r = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  const state = db.prepare('SELECT kb_root FROM kb_graph_state WHERE workspace = ?').get(workspace) as { kb_root: string } | undefined
  // Never built (or built for another folder): a full sync is the incremental step.
  if (!state || state.kb_root !== path.resolve(kbRoot)) return { ...syncGraph(db, workspace, kbRoot, { ...so, now }), mode: 'full' }

  const files = listVaultMarkdown(kbRoot, so)
  const signature = vaultSignature(files, so)
  const f = files.find(x => x.rel === r)
  const cache = cacheFor(kbRoot)
  const hadNode = !!db.prepare('SELECT 1 FROM kb_nodes WHERE workspace = ? AND rel = ?').get(workspace, r)
  if (!f && !hadNode && !cache.has(r)) {
    // Not an indexed file (excluded, not markdown, outside) — nothing of ours changed.
    return { rebuilt: false, ...counts(db, workspace), reread: 0, mode: 'skipped' }
  }
  const before = cache.get(r)?.loaded
  if (!cache.has(r) || cache.size === 0) {
    // Cold cache (server restart): a full derive re-reads each file once.
    return { ...syncGraph(db, workspace, kbRoot, { ...so, force: true, now }), mode: 'full' }
  }
  cache.delete(r)
  const after = f ? loadCached(kbRoot, f) : null
  const sameNames = !!before && !!after && hadNode && nameSig(before) === nameSig(after)
  if (!sameNames) {
    const stats = { reread: 1 }
    const graph = deriveGraph(loadVaultPages(kbRoot, files, stats), { rootName: path.basename(path.resolve(kbRoot)) })
    writeGraph(db, workspace, kbRoot, graph, signature, now)
    return { rebuilt: true, edges: graph.edges.length, nodes: graph.nodes.length, unresolved: graph.unresolved.length, reread: stats.reread, mode: 'full' }
  }
  const pages = loadVaultPages(kbRoot, files)
  const d = derivePageEdges(after!, makeResolver(pages.map(p => p.page), { rootName: path.basename(path.resolve(kbRoot)) }))
  db.transaction(() => {
    db.prepare('DELETE FROM kb_edges WHERE workspace = ? AND source_rel = ?').run(workspace, r)
    db.prepare('DELETE FROM kb_unresolved WHERE workspace = ? AND from_rel = ?').run(workspace, r)
    insertRows(db, workspace, { nodes: [nodeOf(after!)], edges: d.edges, unresolved: d.unresolved })
    saveState(db, workspace, kbRoot, signature, now)
  })()
  return { rebuilt: true, ...counts(db, workspace), reread: 1, mode: 'file' }
}

/** Links that resolve nowhere, grouped by target (most-written first). */
export function readUnresolved(db: Database.Database, workspace: string, opts: { limit?: number } = {}): { total: number; targets: Array<{ target: string; count: number; from: string[] }> } {
  ensureGraphSchema(db)
  const rows = db.prepare('SELECT from_rel, target FROM kb_unresolved WHERE workspace = ? ORDER BY target, from_rel').all(workspace) as Array<{ from_rel: string; target: string }>
  const by = new Map<string, string[]>()
  for (const r of rows) { const l = by.get(r.target); if (l) { if (!l.includes(r.from_rel)) l.push(r.from_rel) } else by.set(r.target, [r.from_rel]) }
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 200)))
  const targets = [...by].map(([target, from]) => ({ target, count: from.length, from: from.slice(0, 10) }))
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
  return { total: rows.length, targets: targets.slice(0, limit) }
}

interface EdgeRow { from_rel: string; to_rel: string; kind: EdgeKind; label: string | null; source_rel: string; updated: string | null }
interface NodeRow { rel: string; title: string; kind: string; aliases: string; summary: string; updated: string | null }

export function readEdges(db: Database.Database, workspace: string): KbEdge[] {
  ensureGraphSchema(db)
  return db.prepare('SELECT from_rel, to_rel, kind, label, source_rel, updated FROM kb_edges WHERE workspace = ? ORDER BY from_rel, to_rel, kind').all(workspace) as EdgeRow[]
}

export function readNodes(db: Database.Database, workspace: string): KbNode[] {
  ensureGraphSchema(db)
  return (db.prepare('SELECT rel, title, kind, aliases, summary, updated FROM kb_nodes WHERE workspace = ? ORDER BY rel').all(workspace) as NodeRow[])
    .map(n => ({ ...n, aliases: safeList(n.aliases) }))
}

function safeList(s: string): string[] {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [] } catch { return [] }
}

// ── Queries ──────────────────────────────────────────────────────────────────

export interface EdgeView { from: string; to: string; kind: EdgeKind; label: string | null }
export interface NodeRef { rel: string; title: string; kind: string }

function view(e: KbEdge): EdgeView {
  return { from: e.from_rel, to: e.to_rel, kind: e.kind, label: e.label }
}

export class GraphView {
  readonly nodes: Map<string, KbNode>
  readonly adj = new Map<string, KbEdge[]>()
  constructor(nodes: KbNode[], readonly edges: KbEdge[]) {
    this.nodes = new Map(nodes.map(n => [n.rel, n]))
    for (const e of edges) {
      for (const end of [e.from_rel, e.to_rel]) {
        const list = this.adj.get(end)
        if (list) list.push(e)
        else this.adj.set(end, [e])
      }
    }
  }
  static load(db: Database.Database, workspace: string): GraphView {
    return new GraphView(readNodes(db, workspace), readEdges(db, workspace))
  }
  ref(rel: string): NodeRef {
    const n = this.nodes.get(rel)
    return { rel, title: n?.title ?? path.posix.basename(rel, '.md'), kind: n?.kind ?? 'generated' }
  }
  degree(rel: string): number { return this.adj.get(rel)?.length ?? 0 }
  /** Exact match on a path (with or without .md), file name, title or alias. */
  find(page: string): KbNode[] {
    const p = page.trim().replace(/^\.?\//, '')
    const byRel = this.nodes.get(p) ?? this.nodes.get(`${p}.md`)
    if (byRel) return [byRel]
    const k = nameKey(path.posix.basename(p))
    return [...this.nodes.values()].filter(n => [path.posix.basename(n.rel, '.md'), n.title, ...n.aliases].some(x => nameKey(x) === k))
  }
}

export interface RelatedHit extends NodeRef {
  /** 1 = directly connected, 2 = connected through one page in between. */
  depth: number
  /** How it connects to the page one step closer (≤ 5 shown). */
  via: EdgeView[]
}

export interface RelatedResult { page: NodeRef; related: RelatedHit[]; truncated: boolean }

export const MAX_RELATED_DEPTH = 2

/**
 * Pages connected to `page` (a path, title or alias) within `depth` steps,
 * either direction. Closest and best-connected first. null when no page matches.
 */
export function kbRelated(db: Database.Database, workspace: string, page: string, opts: { depth?: number; limit?: number } = {}): RelatedResult | null {
  const g = GraphView.load(db, workspace)
  const start = g.find(page).sort((a, b) => g.degree(b.rel) - g.degree(a.rel) || a.rel.localeCompare(b.rel))[0]
  if (!start) return null
  const depth = Math.max(1, Math.min(MAX_RELATED_DEPTH, Math.floor(opts.depth ?? 1)))
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)))
  const seen = new Map<string, RelatedHit>()
  let frontier = [start.rel]
  const visited = new Set(frontier)
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: string[] = []
    for (const at of frontier) {
      for (const e of g.adj.get(at) ?? []) {
        const other = e.from_rel === at ? e.to_rel : e.from_rel
        if (visited.has(other) && !seen.has(other)) continue
        let hit = seen.get(other)
        if (!hit) {
          hit = { ...g.ref(other), depth: d, via: [] }
          seen.set(other, hit)
          visited.add(other)
          next.push(other)
        }
        if (hit.depth === d && hit.via.length < 5 && !hit.via.some(v => v.from === e.from_rel && v.to === e.to_rel && v.kind === e.kind)) hit.via.push(view(e))
      }
    }
    frontier = next
  }
  const all = [...seen.values()].sort((a, b) =>
    a.depth - b.depth || Number(b.via.some(v => v.label)) - Number(a.via.some(v => v.label)) || g.degree(b.rel) - g.degree(a.rel) || a.title.localeCompare(b.title))
  return { page: g.ref(start.rel), related: all.slice(0, limit), truncated: all.length > limit }
}

const TOPIC_STOP = new Set(['the', 'a', 'an', 'about', 'our', 'my', 'of', 'for', 'and', 'who', 'knows', 'know', 'on', 'in'])

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2 && !TOPIC_STOP.has(t)).map(t => (t.length > 3 ? t.replace(/s$/, '') : t))
}

function hasAll(hay: string, toks: string[]): boolean {
  const h = hay.toLowerCase()
  return toks.length > 0 && toks.every(t => h.includes(t))
}

/**
 * Pages a topic phrase names. An exact name wins. Otherwise each page scores
 * on the words: in its title or an alias (strongest), in the label of a link
 * it makes ("supplier of"), in its one-line summary — and only the
 * best-scoring tier is kept, so "the supplier" finds the main supplier rather
 * than every page that once supplied something.
 */
export function resolveTopic(g: GraphView, topic: string, max = 5): KbNode[] {
  const exact = g.find(topic)
  if (exact.length) return exact.slice(0, max)
  const toks = tokens(topic)
  if (!toks.length) return []
  const scored: Array<{ n: KbNode; score: number }> = []
  for (const n of g.nodes.values()) {
    if (n.kind === 'source' || n.kind === 'answer') continue
    let score = 0
    if ([n.title, ...n.aliases].some(x => hasAll(x, toks))) score += 4
    if ((g.adj.get(n.rel) ?? []).some(e => e.from_rel === n.rel && e.label && hasAll(e.label, toks))) score += 2
    if (hasAll(n.summary, toks)) score += 1
    if (score) scored.push({ n, score })
  }
  if (!scored.length) return []
  const best = Math.max(...scored.map(s => s.score))
  return scored
    .filter(s => s.score === best)
    .sort((a, b) => g.degree(b.n.rel) - g.degree(a.n.rel) || a.n.rel.localeCompare(b.n.rel))
    .slice(0, max)
    .map(s => s.n)
}

export interface WhoKnowsHit extends NodeRef {
  /** Distinct sources (documents, chats, calls, saved answers) that connect this person to the topic. */
  sources: number
  /** Newest date among those sources (the linking page's date when no source connects them), or null. */
  latest: string | null
  /** Direct links between the person and the topic page, e.g. {kind: 'related', label: 'works for'}. */
  links: EdgeView[]
  /** Up to 5 of the sources, newest first. */
  cited_in: Array<NodeRef & { date: string | null }>
}

export interface WhoKnowsResult { topic: string; matched: NodeRef[]; people: WhoKnowsHit[] }

const EVIDENCE_KINDS = new Set(['source', 'answer'])

/**
 * Person pages connected to a topic, ranked by how many sources connect them
 * (a chat, call or document that cites both the person and the topic, or a
 * saved answer that used both), then by how recent the newest one is.
 */
export function kbWhoKnows(db: Database.Database, workspace: string, topic: string, opts: { limit?: number } = {}): WhoKnowsResult {
  const g = GraphView.load(db, workspace)
  const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 10)))
  const matched = resolveTopic(g, topic)
  const topicRels = new Set(matched.map(n => n.rel))
  const evidenceOf = (rel: string) => {
    const out = new Set<string>()
    for (const e of g.adj.get(rel) ?? []) {
      const other = e.from_rel === rel ? e.to_rel : e.from_rel
      if (EVIDENCE_KINDS.has(g.nodes.get(other)?.kind ?? '')) out.add(other)
    }
    return out
  }
  const topicEvidence = new Set<string>()
  for (const t of topicRels) for (const s of evidenceOf(t)) topicEvidence.add(s)

  const people: WhoKnowsHit[] = []
  for (const n of g.nodes.values()) {
    if (n.kind !== 'person' || topicRels.has(n.rel)) continue
    const shared = [...evidenceOf(n.rel)].filter(s => topicEvidence.has(s))
    const links = (g.adj.get(n.rel) ?? []).filter(e => topicRels.has(e.from_rel === n.rel ? e.to_rel : e.from_rel)).map(view)
    if (!shared.length && !links.length) continue
    const cited = shared
      .map(s => ({ ...g.ref(s), date: g.nodes.get(s)?.updated ?? null }))
      .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.title.localeCompare(b.title))
    const linkDates = (g.adj.get(n.rel) ?? []).filter(e => links.some(l => l.from === e.from_rel && l.to === e.to_rel && l.kind === e.kind)).map(e => e.updated)
    // When the sources last said something; a page's own edit date only when no source connects them.
    const latest = (cited.length ? cited.map(c => c.date) : linkDates).filter((d): d is string => !!d).sort().pop() ?? null
    people.push({ ...g.ref(n.rel), sources: shared.length, latest, links, cited_in: cited.slice(0, 5) })
  }
  people.sort((a, b) =>
    b.sources - a.sources || (b.latest ?? '').localeCompare(a.latest ?? '') || b.links.length - a.links.length || a.title.localeCompare(b.title))
  return { topic, matched: matched.map(n => g.ref(n.rel)), people: people.slice(0, limit) }
}

// ── Whole-workspace graph (obj 900674) ───────────────────────────────────────

/** One page in the workspace graph. `degree` = how many other pages it links with. */
export interface WorkspaceGraphNode extends NodeRef { degree: number }

/**
 * One line in the workspace graph: every kb_edges row between the same two
 * pages folded together (either direction), so the drawing shows one line per
 * pair. `kinds` lists how they connect; `label` is the first relation label.
 */
export interface WorkspaceGraphLink { a: string; b: string; kinds: EdgeKind[]; label: string | null; weight: number }

export interface WorkspaceGraphResult {
  nodes: WorkspaceGraphNode[]
  links: WorkspaceGraphLink[]
  /** `unresolved`: links written on a page that point at no indexed page (obj 900815; listed by GET /graph/unresolved). */
  counts: { pages: number; links: number; isolated: number; unresolved: number; by_kind: Record<string, number> }
  /** True when the page count was over `limit` and the least-connected pages were left out. */
  truncated: boolean
}

export const MAX_WORKSPACE_GRAPH_NODES = 2000

/**
 * The whole knowledge base as one graph — every page and every connection
 * from kb_edges — for the Obsidian-style overview. Self-links are dropped and
 * edges are folded to one link per pair of pages. Over `limit` pages, the
 * best-connected are kept (isolated pages go first).
 */
export function kbWorkspaceGraph(db: Database.Database, workspace: string, opts: { limit?: number } = {}): WorkspaceGraphResult {
  const g = GraphView.load(db, workspace)
  const limit = Math.max(1, Math.min(MAX_WORKSPACE_GRAPH_NODES, Math.floor(opts.limit ?? MAX_WORKSPACE_GRAPH_NODES)))

  const pairs = new Map<string, WorkspaceGraphLink>()
  for (const e of g.edges) {
    if (e.from_rel === e.to_rel) continue
    const [a, b] = e.from_rel < e.to_rel ? [e.from_rel, e.to_rel] : [e.to_rel, e.from_rel]
    const key = `${a}\0${b}`
    let link = pairs.get(key)
    if (!link) { link = { a, b, kinds: [], label: null, weight: 0 }; pairs.set(key, link) }
    link.weight++
    if (!link.kinds.includes(e.kind)) link.kinds.push(e.kind)
    if (!link.label && e.label) link.label = e.label
  }

  const degree = new Map<string, number>()
  for (const l of pairs.values()) for (const end of [l.a, l.b]) degree.set(end, (degree.get(end) ?? 0) + 1)
  // Every page, plus any link end that has no node row (a generated page, say).
  const rels = new Set<string>([...g.nodes.keys(), ...degree.keys()])
  const all: WorkspaceGraphNode[] = [...rels].map(rel => ({ ...g.ref(rel), degree: degree.get(rel) ?? 0 }))
  all.sort((x, y) => y.degree - x.degree || x.rel.localeCompare(y.rel))
  const nodes = all.slice(0, limit)
  const kept = new Set(nodes.map(n => n.rel))
  const links = [...pairs.values()]
    .filter(l => kept.has(l.a) && kept.has(l.b))
    .map(l => ({ ...l, kinds: [...l.kinds].sort() }))
    .sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b))

  const by_kind: Record<string, number> = {}
  for (const n of all) by_kind[n.kind] = (by_kind[n.kind] ?? 0) + 1
  return {
    nodes,
    links,
    counts: {
      pages: all.length,
      links: pairs.size,
      isolated: all.filter(n => n.degree === 0).length,
      unresolved: (db.prepare('SELECT COUNT(*) AS n FROM kb_unresolved WHERE workspace = ?').get(workspace) as { n: number }).n,
      by_kind,
    },
    truncated: all.length > nodes.length,
  }
}
