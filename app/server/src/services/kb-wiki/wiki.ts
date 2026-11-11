import fs from 'fs'
import path from 'path'
import { ENTITY_TYPES, FOLDER_FOR, parseNote, relLink, slugify } from '../doc-ingest/notes.js'
import { ANSWERS_DIR, CONVERSATION_SOURCES_DIR, GENERATED_BY, INDEX_PAGE, LINT_REPORT_PAGE, LOG_PAGE, isProtectedPath } from './paths.js'

/**
 * Compiled wiki (obj 720117): page scan, [[wikilinks]] + automatic backlinks,
 * the index page and the recent-changes log.
 *
 * CONTRACT — other modules depend on these exact signatures.
 */

export interface WikiPage {
  /** KB-relative path, e.g. `people/dana-ruiz.md`. */
  rel: string
  title: string
  /** Folder-derived kind: an entity type ('person', 'organization', …), 'source', 'answer', 'generated'. */
  kind: string
  /** First sentence/paragraph of the body, ≤ 200 chars. */
  summary: string
  updated?: string
  aliases: string[]
  /** KB-relative paths this page links to (resolved; broken links excluded). */
  links: string[]
}

export interface LogEntry {
  /** 'ingest' | 'import' | 'answer' | 'lint' | 'rebuild' | 'edit' */
  kind: string
  /** One line, plain language. */
  title: string
  /** KB-relative paths of pages created or changed (rendered as wikilinks, capped). */
  pages?: string[]
  when?: Date
}

export interface CompileResult { pages: number; backlinksUpdated: number; indexWritten: boolean }

// ── Layout ───────────────────────────────────────────────────────────────────

/** Folder lint uses for pages it starts for a missing topic: the entity 'topic' folder when that type exists. */
export function topicFolder(): string {
  return (FOLDER_FOR as Record<string, string>).topic ?? 'topics'
}

/** Top-level folders that hold wiki pages, entity folders first in FOLDER_FOR order. */
export function pageRoots(): string[] {
  return [...new Set([...ENTITY_TYPES.map(t => FOLDER_FOR[t]), topicFolder(), 'sources', ANSWERS_DIR])]
}

/** Folder-derived page kind for a KB-relative path (see WikiPage.kind). */
export function kindFor(rel: string): string {
  const top = rel.split('/')[0]
  if (top === 'sources') return 'source'
  if (top === ANSWERS_DIR) return 'answer'
  const type = ENTITY_TYPES.find(t => FOLDER_FOR[t] === top)
  return type ?? (top === topicFolder() ? 'topic' : 'generated')
}

function normRel(rel: string): string | null {
  const r = path.posix.normalize(rel.replace(/\\/g, '/').trim()).replace(/^\.\//, '')
  if (!r || r.startsWith('/') || r === '..' || r.startsWith('../') || r.split('/').includes('..')) return null
  return r
}

/** True for a KB-relative path that is (or would be) a compiled wiki page — not raw, state, index or log. */
export function isWikiPageRel(rel: string): boolean {
  const r = normRel(rel)
  if (!r || !r.toLowerCase().endsWith('.md') || isProtectedPath(r)) return false
  return pageRoots().includes(r.split('/')[0]) && r.includes('/')
}

// ── Frontmatter + text helpers ───────────────────────────────────────────────

export function fmField(text: string, key: string): string | undefined {
  const m = text.match(/^---\n([\s\S]*?)\n---/)
  const v = m?.[1].match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim()
  if (v === undefined) return undefined
  if (v.startsWith('"')) { try { return JSON.parse(v) as string } catch { return v } }
  return v
}

export function isKbWikiGenerated(text: string): boolean {
  return fmField(text, 'generated_by') === GENERATED_BY
}

/** YAML scalar: bare when safe, else JSON-quoted (valid YAML, and what parseNote reads back). */
export function yamlValue(s: string): string {
  return /^[\w .,'()&/-]+$/.test(s) && !/^[-?:]/.test(s) && !/:\s/.test(s) ? s : JSON.stringify(s)
}

export function yamlArray(items: string[]): string {
  return `[${items.map(i => (/[,[\]{}"]/.test(i) ? JSON.stringify(i) : yamlValue(i))).join(', ')}]`
}

const BL_START = '<!-- kb-wiki:backlinks -->'
const BL_END = '<!-- /kb-wiki:backlinks -->'
const BL_RE = /\n*<!-- kb-wiki:backlinks -->[\s\S]*?<!-- \/kb-wiki:backlinks -->\n*/g

export function stripBacklinks(text: string): string {
  return text.replace(BL_RE, '\n')
}

function bodyOf(text: string): string {
  const m = text.match(/^---\n[\s\S]*?\n---\n?/)
  return m ? text.slice(m[0].length) : text
}

function titleOf(text: string, rel: string): string {
  const t = parseNote(text).fm?.title || bodyOf(text).match(/^# (.+)$/m)?.[1]?.trim()
  return t || path.posix.basename(rel, '.md')
}

/** Markdown → readable plain text for one-line summaries. */
function plain(s: string): string {
  return s
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]|#]*)[^\]]*\]\]/g, (_m, t: string) => path.posix.basename(t).replace(/\.md$/, ''))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function summaryOf(text: string): string {
  const explicit = fmField(text, 'summary')
  let s = explicit ?? ''
  if (!s) {
    const body = stripBacklinks(bodyOf(text)).replace(/```[\s\S]*?```/g, '')
    for (const para of body.split(/\n\s*\n/)) {
      const p = para.trim()
      if (!p || /^(#|<!--|[-*+] |\d+\. |\||>|\*Source:|Original file:)/.test(p)) continue
      s = p
      break
    }
  }
  s = plain(s)
  return s.length > 200 ? `${s.slice(0, 199).replace(/\s+\S*$/, '')}…` : s
}

// ── Links ────────────────────────────────────────────────────────────────────

export interface RawLink {
  /** Exact text in the page, e.g. `[[Dana Ruiz|Dana]]` or `[Dana](../people/dana.md)`. */
  match: string
  form: 'wiki' | 'md'
  /** Target as written, without `#heading` or `|label`. */
  target: string
  label?: string
  heading?: string
}

const WIKI_RE = /!?\[\[([^[\]\n|#]*)(#[^[\]\n|]*)?(?:\|([^[\]\n]*))?\]\]/g
const MD_RE = /(?<!!)\[([^\]\n]*)\]\(<?([^)\s<>]+?\.md)(#[^)\s>]*)?>?\)/gi

/** Every wikilink and markdown link to a .md file in a page body (code and the backlinks block excluded). */
export function parseLinks(text: string): RawLink[] {
  const body = stripBacklinks(bodyOf(text)).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const out: RawLink[] = []
  for (const m of body.matchAll(WIKI_RE)) {
    const target = m[1].trim()
    if (!target) continue
    out.push({ match: m[0], form: 'wiki', target, heading: m[2]?.slice(1), label: m[3]?.trim() || undefined })
  }
  for (const m of body.matchAll(MD_RE)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(m[2])) continue
    let target = m[2]
    try { target = decodeURIComponent(target) } catch { /* keep as written */ }
    out.push({ match: m[0], form: 'md', target, label: m[1], heading: m[3]?.slice(1) })
  }
  return out
}

/** Name key for case-insensitive stem/title/alias matching. */
export function nameKey(s: string): string {
  const k = slugify(s.replace(/\.md$/i, ''))
  return k === 'untitled' ? s.toLowerCase().trim() : k
}

interface Lookup { byRel: Map<string, string>; byName: Map<string, string[]> }
const lookups = new WeakMap<WikiPage[], Lookup>()

function lookupFor(pages: WikiPage[]): Lookup {
  let l = lookups.get(pages)
  if (l) return l
  l = { byRel: new Map(), byName: new Map() }
  for (const p of pages) {
    l.byRel.set(p.rel.toLowerCase(), p.rel)
    const keys = new Set([path.posix.basename(p.rel, '.md'), p.title, ...p.aliases].filter(Boolean).map(nameKey))
    for (const k of keys) {
      const list = l.byName.get(k)
      if (list) list.push(p.rel)
      else l.byName.set(k, [p.rel])
    }
  }
  lookups.set(pages, l)
  return l
}

/** Pages whose file stem, title or alias matches a bare name (case-insensitive). */
export function pagesNamed(pages: WikiPage[], name: string): string[] {
  return lookupFor(pages).byName.get(nameKey(name)) ?? []
}

/**
 * Resolve a link target written on `fromRel` to a KB-relative page path, or
 * null when it points nowhere. Paths are tried KB-relative then relative to
 * the page; a bare name matches a page's stem, title or alias.
 */
export function resolveLinkTarget(pages: WikiPage[], target: string, fromRel: string): string | null {
  const t = target.split('#')[0].trim().replace(/^\.\//, '')
  if (!t) return null
  const l = lookupFor(pages)
  const withMd = /\.md$/i.test(t) ? t : `${t}.md`
  if (t.includes('/') || /\.md$/i.test(t)) {
    const dir = path.posix.dirname(fromRel)
    const tries = t.startsWith('/') ? [withMd.slice(1)] : [withMd, path.posix.join(dir, withMd)]
    for (const c of tries) {
      const r = normRel(c)
      const hit = r && l.byRel.get(r.toLowerCase())
      if (hit) return hit
    }
    if (t.includes('/')) return null
  }
  const key = nameKey(t)
  const named = l.byName.get(key) ?? []
  if (named.length <= 1) return named[0] ?? null
  // Ambiguous: the page whose file name IS the name wins, then one in the linking page's folder.
  const top = fromRel.split('/')[0]
  const rank = (r: string) => (nameKey(path.posix.basename(r)) === key ? 0 : 2) + (r.split('/')[0] === top ? 0 : 1)
  return [...named].sort((a, b) => rank(a) - rank(b) || a.length - b.length || a.localeCompare(b))[0]
}

/** Turn `[[target|label]]` into `[label](relative/path.md)` for renderers without wikilink support. */
export function wikilinksToMarkdown(md: string, fromRel: string, pages: WikiPage[]): string {
  return md.replace(WIKI_RE, (m, target: string, heading: string | undefined, label: string | undefined) => {
    if (m.startsWith('!')) return m
    const rel = resolveLinkTarget(pages, target, fromRel)
    const text = label?.trim() || pages.find(p => p.rel === rel)?.title || target.trim()
    return rel ? `[${text}](${relLink(fromRel, rel)}${heading ?? ''})` : text
  })
}

/** `[[people/dana-ruiz|Dana Ruiz]]` — the wikilink form every generated page uses (path without .md). */
export function wikilink(rel: string, label?: string): string {
  const target = rel.replace(/\.md$/, '')
  return label && label !== target ? `[[${target}|${label}]]` : `[[${target}]]`
}

// ── Scan ─────────────────────────────────────────────────────────────────────

export interface LoadedPage {
  page: WikiPage
  text: string
  mtimeMs: number
  /** frontmatter `generated_by: kb-wiki` */
  generated: boolean
  /** a placeholder page lint started for a missing topic */
  stub: boolean
  rawLinks: RawLink[]
}

function walk(kbRoot: string, rel: string, out: string[]): void {
  let ents: fs.Dirent[]
  try { ents = fs.readdirSync(path.join(kbRoot, rel), { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue
    const r = `${rel}/${e.name}`
    if (isProtectedPath(r)) continue
    if (e.isDirectory()) walk(kbRoot, r, out)
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(r)
  }
}

/** Read every page once and resolve its links. The basis of scan, compile and lint. */
export function loadWiki(kbRoot: string): LoadedPage[] {
  const rels: string[] = []
  for (const root of pageRoots()) walk(kbRoot, root, rels)
  rels.sort()
  const loaded: LoadedPage[] = []
  for (const rel of rels) {
    let text: string
    let mtimeMs: number
    try {
      const abs = path.join(kbRoot, rel)
      mtimeMs = fs.statSync(abs).mtimeMs
      text = fs.readFileSync(abs, 'utf8')
    } catch { continue }
    const fm = parseNote(text).fm
    loaded.push({
      page: {
        rel,
        title: titleOf(text, rel),
        kind: kindFor(rel),
        summary: summaryOf(text),
        updated: fm?.updated || undefined,
        aliases: fm?.aliases ?? [],
        links: [],
      },
      text,
      mtimeMs,
      generated: isKbWikiGenerated(text),
      stub: fmField(text, 'stub') === 'true',
      rawLinks: parseLinks(text),
    })
  }
  const pages = loaded.map(l => l.page)
  for (const l of loaded) {
    const seen = new Set<string>()
    for (const link of l.rawLinks) {
      const r = resolveLinkTarget(pages, link.target, l.page.rel)
      if (r && r !== l.page.rel) seen.add(r)
    }
    l.page.links = [...seen]
  }
  return loaded
}

/** Every wiki page (entity pages, sources incl. conversations, answers). Never walks raw/ or .kb-wiki/. */
export function scanWiki(kbRoot: string): WikiPage[] {
  return loadWiki(kbRoot).map(l => l.page)
}

// ── Compile ──────────────────────────────────────────────────────────────────

/** Page text with its backlinks block replaced (or removed when there are none). */
export function withBacklinks(text: string, backlinks: Array<{ rel: string; title: string }>): string {
  const had = text.includes(BL_START)
  if (!backlinks.length && !had) return text
  const base = (had ? stripBacklinks(text) : text).replace(/\s+$/, '')
  if (!backlinks.length) return `${base}\n`
  const sorted = [...backlinks].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.rel.localeCompare(b.rel))
  return [base, '', BL_START, '## Backlinks', '', ...sorted.map(b => `- ${wikilink(b.rel, b.title)}`), BL_END, ''].join('\n')
}

/** Write only if the file has not changed since it was read (an ingest may be writing it right now). */
function writeIfUnchanged(abs: string, text: string, mtimeMs: number): boolean {
  try { if (fs.statSync(abs).mtimeMs !== mtimeMs) return false } catch { return false }
  fs.writeFileSync(abs, text)
  return true
}

/** Where a generated root page goes: its usual name unless a hand-written file already has that name. */
export function generatedPagePath(kbRoot: string, name: string): string {
  const abs = path.join(kbRoot, name)
  if (!fs.existsSync(abs)) return name
  try { if (isKbWikiGenerated(fs.readFileSync(abs, 'utf8'))) return name } catch { /* fall through */ }
  return `wiki-${name}`
}

function heading(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function entryLine(p: WikiPage): string {
  return `- ${wikilink(p.rel, p.title)}${p.summary ? ` — ${p.summary}` : ''}`
}

function byTitle(a: WikiPage, b: WikiPage): number {
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.rel.localeCompare(b.rel)
}

/** Body of the index page (everything after the frontmatter). Pure. */
export function renderIndexBody(pages: WikiPage[]): string {
  const lines = ['# Wiki index', '', 'Every page in this knowledge base, grouped by kind. This page is rebuilt automatically whenever something changes.', '']
  const groups = new Map<string, WikiPage[]>()
  for (const p of pages) {
    const top = p.rel.split('/')[0]
    const list = groups.get(top)
    if (list) list.push(p)
    else groups.set(top, [p])
  }
  const section = (title: string, list: WikiPage[] | undefined) => {
    if (!list?.length) return
    lines.push(`## ${title} (${list.length})`, '', ...[...list].sort(byTitle).map(entryLine), '')
  }
  for (const folder of pageRoots().filter(r => r !== 'sources' && r !== ANSWERS_DIR)) section(heading(folder), groups.get(folder))
  section('Answers', groups.get(ANSWERS_DIR))

  const sources = groups.get('sources') ?? []
  const convPrefix = `${CONVERSATION_SOURCES_DIR}/`
  const docs = sources.filter(p => !p.rel.startsWith(convPrefix))
  const convs = sources.filter(p => p.rel.startsWith(convPrefix))
  if (sources.length) {
    lines.push(`## Sources (${sources.length})`, '')
    if (docs.length) lines.push(...docs.sort(byTitle).map(entryLine), '')
    if (convs.length) {
      lines.push(`### Conversations (${convs.length})`, '')
      const byJob = new Map<string, WikiPage[]>()
      for (const c of convs) {
        const job = c.rel.slice(convPrefix.length).split('/').length > 1 ? c.rel.slice(convPrefix.length).split('/')[0] : ''
        const list = byJob.get(job)
        if (list) list.push(c)
        else byJob.set(job, [c])
      }
      for (const [job, list] of [...byJob].sort(([a], [b]) => a.localeCompare(b))) {
        if (job) lines.push(`#### Import ${job}`, '')
        lines.push(...list.sort(byTitle).map(entryLine), '')
      }
    }
  }
  if (!pages.length) lines.push('Nothing here yet. Upload a document or import some chats to get started.', '')
  return lines.join('\n')
}

function generatedFrontmatter(title: string, type: string, updated: string): string {
  return ['---', `title: ${title}`, `type: ${type}`, `generated_by: ${GENERATED_BY}`, `updated: ${updated}`, '---', ''].join('\n')
}

type CompileListener = (kbRoot: string) => void
const compileListeners: CompileListener[] = []

/**
 * Run `fn` after every compile (obj 720162: the link graph rebuilds here). A
 * listener that throws is logged and never fails the compile — the files are
 * the source of truth, anything derived from them can catch up later.
 */
export function onWikiCompiled(fn: CompileListener): () => void {
  compileListeners.push(fn)
  return () => { const i = compileListeners.indexOf(fn); if (i >= 0) compileListeners.splice(i, 1) }
}

/** Rewrite every page's auto backlinks block and the index page. Idempotent; only writes files whose content changed. */
export function compileWiki(kbRoot: string, opts: { now?: Date } = {}): CompileResult {
  const now = opts.now ?? new Date()
  const loaded = loadWiki(kbRoot)
  const byRel = new Map(loaded.map(l => [l.page.rel, l.page]))
  const inbound = new Map<string, Set<string>>()
  for (const l of loaded) {
    for (const to of l.page.links) {
      const set = inbound.get(to)
      if (set) set.add(l.page.rel)
      else inbound.set(to, new Set([l.page.rel]))
    }
  }

  let backlinksUpdated = 0
  for (const l of loaded) {
    const from = [...(inbound.get(l.page.rel) ?? [])].map(r => ({ rel: r, title: byRel.get(r)!.title }))
    const next = withBacklinks(l.text, from)
    if (next !== l.text && writeIfUnchanged(path.join(kbRoot, l.page.rel), next, l.mtimeMs)) backlinksUpdated++
  }

  const indexRel = generatedPagePath(kbRoot, INDEX_PAGE)
  const indexAbs = path.join(kbRoot, indexRel)
  const body = renderIndexBody(loaded.map(l => l.page))
  let current: string | null = null
  try { current = fs.readFileSync(indexAbs, 'utf8') } catch { /* first compile */ }
  // The `updated` stamp alone never forces a rewrite — only a changed page list does.
  const indexWritten = current === null || bodyOf(current) !== body
  if (indexWritten) fs.writeFileSync(indexAbs, generatedFrontmatter('Wiki index', 'index', now.toISOString().slice(0, 10)) + body)
  for (const fn of compileListeners) {
    try { fn(kbRoot) } catch (err) { console.warn(`[kb-wiki] after-compile step failed: ${(err as Error).message}`) }
  }
  return { pages: loaded.length, backlinksUpdated, indexWritten }
}

// ── Log ──────────────────────────────────────────────────────────────────────

export const MAX_LOG_ENTRIES = 500
const MAX_LOG_LINKS = 20

function stamp(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}`
}

function pageTitle(kbRoot: string, rel: string): string | undefined {
  try { return titleOf(fs.readFileSync(path.join(kbRoot, rel), 'utf8'), rel) } catch { return undefined }
}

/** One log entry as markdown. Pure apart from `titleFor`. */
export function renderLogEntry(entry: LogEntry, titleFor: (rel: string) => string | undefined = () => undefined): string {
  const when = entry.when ?? new Date()
  const title = entry.title.replace(/\s+/g, ' ').trim()
  const lines = [`## [${stamp(when)}] ${entry.kind} | ${title}`]
  const pages = [...new Set(entry.pages ?? [])]
  if (pages.length) {
    lines.push('')
    for (const rel of pages.slice(0, MAX_LOG_LINKS)) lines.push(`- ${wikilink(rel, titleFor(rel))}`)
    if (pages.length > MAX_LOG_LINKS) lines.push(`- …and ${pages.length - MAX_LOG_LINKS} more`)
  }
  return lines.join('\n')
}

/** Add one entry to the top of log.md (newest first). */
export function appendLog(kbRoot: string, entry: LogEntry): void {
  const rel = generatedPagePath(kbRoot, LOG_PAGE)
  const abs = path.join(kbRoot, rel)
  let old: string[] = []
  try {
    const parts = bodyOf(fs.readFileSync(abs, 'utf8')).split(/^(?=## \[)/m)
    old = parts.filter(p => p.startsWith('## [')).map(p => p.replace(/\s+$/, ''))
  } catch { /* new log */ }
  const when = entry.when ?? new Date()
  const fresh = renderLogEntry({ ...entry, when }, r => pageTitle(kbRoot, r))
  const entries = [fresh, ...old].slice(0, MAX_LOG_ENTRIES)
  const head = ['# Wiki log', '', 'What changed in this knowledge base, newest first.', ''].join('\n')
  fs.mkdirSync(kbRoot, { recursive: true })
  fs.writeFileSync(abs, `${generatedFrontmatter('Wiki log', 'log', when.toISOString().slice(0, 10))}${head}\n${entries.join('\n\n')}\n`)
}

// ── Reading one page (for the routes) ────────────────────────────────────────

const ROOT_PAGES = [INDEX_PAGE, LOG_PAGE, LINT_REPORT_PAGE].flatMap(n => [n, `wiki-${n}`])

export interface PageView { rel: string; title: string; content: string; backlinks: Array<{ rel: string; title: string }> }

/** One page with its backlinks (read from its compiled block — no scan). Throws on a bad or missing path. */
export function readPage(kbRoot: string, rel: string): PageView {
  const r = normRel(rel)
  if (!r || !(ROOT_PAGES.includes(r) || isWikiPageRel(r))) throw new Error('That is not a page in this knowledge base.')
  let content: string
  try { content = fs.readFileSync(path.join(kbRoot, r), 'utf8') } catch { throw new Error('That page does not exist.') }
  const backlinks: Array<{ rel: string; title: string }> = []
  const block = content.match(/<!-- kb-wiki:backlinks -->([\s\S]*?)<!-- \/kb-wiki:backlinks -->/)?.[1] ?? ''
  for (const m of block.matchAll(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) {
    const target = `${m[1]}.md`
    backlinks.push({ rel: target, title: m[2] ?? path.posix.basename(m[1]) })
  }
  return { rel: r, title: titleOf(content, r), content, backlinks }
}
