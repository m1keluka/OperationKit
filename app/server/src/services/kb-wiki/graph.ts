import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'
import { parseNote } from '../doc-ingest/notes.js'
import { isProtectedPath } from './paths.js'
import { fmField, loadWiki, nameKey, pageRoots, parseLinks, resolveLinkTarget, type LoadedPage } from './wiki.js'

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

export interface KbGraph { nodes: KbNode[]; edges: KbEdge[]; broken: BrokenEdge[] }

// ── Derive (pure over the page scan) ─────────────────────────────────────────

function bodyOf(text: string): string {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/)
  return m ? text.slice(m[0].length) : text
}

/** The lines of a page's "## Related" section, and the body without it. */
function splitRelated(body: string): { related: string[]; rest: string } {
  const m = body.match(/^## Related[ \t]*\n([\s\S]*?)(?=^## |^<!-- kb-wiki:backlinks -->|(?![\s\S]))/m)
  if (!m) return { related: [], rest: body }
  return { related: m[1].split('\n').filter(l => /^[-*] /.test(l)), rest: body.replace(m[0], '') }
}

/** "- [Tom Whitfield](../people/tom-whitfield.md) (person) — works for" → target + label. Also accepts a [[wikilink]]. */
export function parseRelatedLine(line: string): { target: string; label: string | null } | null {
  const link = parseLinks(line)[0]
  if (!link) return null
  const after = line.slice(line.indexOf(link.match) + link.match.length)
  const label = after.match(/\s[—–]\s+(.+?)\s*$/)?.[1]?.trim().toLowerCase() || null
  return { target: link.target, label: label ? label.slice(0, 40) : null }
}

function dateOf(text: string): string | null {
  const v = (fmField(text, 'date') || fmField(text, 'updated') || '').trim()
  return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null
}

/** Nodes, edges and broken connections for every page. Deterministic: same files → same rows, same order. */
export function deriveGraph(loaded: LoadedPage[]): KbGraph {
  const pages = loaded.map(l => l.page)
  const edges = new Map<string, KbEdge>()
  const broken: BrokenEdge[] = []
  const add = (e: KbEdge) => {
    if (e.from_rel === e.to_rel) return
    const key = `${e.from_rel}\0${e.to_rel}\0${e.kind}`
    const prev = edges.get(key)
    if (!prev) edges.set(key, e)
    else if (!prev.label && e.label) prev.label = e.label
  }

  for (const l of loaded) {
    const from = l.page.rel
    const isAnswer = l.page.kind === 'answer'
    const updated = dateOf(l.text)
    const edge = (to: string, kind: EdgeKind, label: string | null = null) => add({ from_rel: from, to_rel: to, kind, label, source_rel: from, updated })

    const { related, rest } = splitRelated(bodyOf(l.text))
    for (const line of related) {
      const r = parseRelatedLine(line)
      const to = r && resolveLinkTarget(pages, r.target, from)
      if (to) edge(to, isAnswer ? 'answer_used' : 'related', r!.label)
    }
    for (const link of parseLinks(rest)) {
      // Plain markdown links on a generated page are citations ("*Source: …*"), already covered by `sources:`.
      if (!isAnswer && link.form !== 'wiki') continue
      const to = resolveLinkTarget(pages, link.target, from)
      if (to) edge(to, isAnswer ? 'answer_used' : 'mentions')
    }
    for (const s of parseNote(l.text).fm?.sources ?? []) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(s)) continue // a URL, not a page
      const kind: EdgeKind = isAnswer ? 'answer_used' : 'cited_by'
      const to = resolveLinkTarget(pages, s, from)
      if (to) edge(to, kind)
      else broken.push({ from_rel: from, target: s, kind })
    }
  }

  const nodes = loaded.map(l => ({
    rel: l.page.rel,
    title: l.page.title,
    kind: l.page.kind,
    aliases: [...l.page.aliases],
    summary: l.page.summary,
    updated: dateOf(l.text),
  }))
  const sorted = [...edges.values()].sort((a, b) =>
    a.from_rel.localeCompare(b.from_rel) || a.to_rel.localeCompare(b.to_rel) || a.kind.localeCompare(b.kind))
  return { nodes, edges: sorted, broken }
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
    CREATE TABLE IF NOT EXISTS kb_graph_state (
      workspace TEXT PRIMARY KEY,
      kb_root TEXT NOT NULL,
      signature TEXT NOT NULL,
      built_at TEXT NOT NULL
    );
  `)
}

/** Cheap content signature: every page's path, size and modified time. No file is read. */
export function graphSignature(kbRoot: string): string {
  const h = crypto.createHash('sha1')
  const walk = (rel: string) => {
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(path.join(kbRoot, rel), { withFileTypes: true }) } catch { return }
    ents.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of ents) {
      if (e.name.startsWith('.')) continue
      const r = `${rel}/${e.name}`
      if (isProtectedPath(r)) continue
      if (e.isDirectory()) walk(r)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        try { const st = fs.statSync(path.join(kbRoot, r)); h.update(`${r}\0${st.size}\0${st.mtimeMs}\n`) } catch { /* vanished */ }
      }
    }
  }
  for (const root of pageRoots()) walk(root)
  return h.digest('hex')
}

/** Replace one workspace's rows with `graph`, in one transaction. */
export function writeGraph(db: Database.Database, workspace: string, kbRoot: string, graph: KbGraph, signature: string, now = new Date()): void {
  ensureGraphSchema(db)
  const insEdge = db.prepare('INSERT INTO kb_edges (workspace, from_rel, to_rel, kind, label, source_rel, updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const insNode = db.prepare('INSERT INTO kb_nodes (workspace, rel, title, kind, aliases, summary, updated) VALUES (?, ?, ?, ?, ?, ?, ?)')
  db.transaction(() => {
    db.prepare('DELETE FROM kb_edges WHERE workspace = ?').run(workspace)
    db.prepare('DELETE FROM kb_nodes WHERE workspace = ?').run(workspace)
    for (const e of graph.edges) insEdge.run(workspace, e.from_rel, e.to_rel, e.kind, e.label, e.source_rel, e.updated)
    for (const n of graph.nodes) insNode.run(workspace, n.rel, n.title, n.kind, JSON.stringify(n.aliases), n.summary, n.updated)
    db.prepare(`INSERT INTO kb_graph_state (workspace, kb_root, signature, built_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace) DO UPDATE SET kb_root = excluded.kb_root, signature = excluded.signature, built_at = excluded.built_at`)
      .run(workspace, path.resolve(kbRoot), signature, now.toISOString())
  })()
}

/**
 * Bring the tables up to date with the files. Re-derives only when the
 * signature changed (or `force`). The signature is taken BEFORE the scan, so a
 * file written mid-scan changes it again and the next call catches up.
 */
export function syncGraph(db: Database.Database, workspace: string, kbRoot: string, opts: { force?: boolean; now?: Date } = {}): { rebuilt: boolean; edges: number; nodes: number } {
  ensureGraphSchema(db)
  const signature = graphSignature(kbRoot)
  const state = db.prepare('SELECT signature, kb_root FROM kb_graph_state WHERE workspace = ?').get(workspace) as { signature: string; kb_root: string } | undefined
  if (!opts.force && state && state.signature === signature && state.kb_root === path.resolve(kbRoot)) {
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE workspace = ?`).get(workspace) as { n: number }).n
    return { rebuilt: false, edges: count('kb_edges'), nodes: count('kb_nodes') }
  }
  const graph = deriveGraph(loadWiki(kbRoot))
  writeGraph(db, workspace, kbRoot, graph, signature, opts.now)
  return { rebuilt: true, edges: graph.edges.length, nodes: graph.nodes.length }
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
