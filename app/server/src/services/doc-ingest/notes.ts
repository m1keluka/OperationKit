import fs from 'fs'
import path from 'path'
import crypto from 'crypto'

/**
 * Knowledge-base note rendering + merging for document ingest (obj 719936).
 *
 * One note per organization / person / project / product / topic. A note is built up from many
 * source files: each source owns exactly ONE "## From: <source>" section, so
 * re-ingesting a file replaces its own section and never duplicates or
 * clobbers what other files contributed. Pure functions — no I/O — so the
 * merge rules are unit-tested directly.
 */

export const ENTITY_TYPES = ['organization', 'person', 'project', 'product', 'topic'] as const
export type EntityType = typeof ENTITY_TYPES[number]

export const FOLDER_FOR: Record<EntityType, string> = {
  organization: 'organizations',
  person: 'people',
  project: 'projects',
  product: 'products',
  topic: 'topics',
}

export interface EntityFact {
  fact: string
  /** Where in the source, e.g. `tab "Cleaning", row 7` or `page 2`. */
  where?: string
}

export interface Entity {
  type: EntityType
  name: string
  aliases?: string[]
  summary?: string
  facts: EntityFact[]
  related?: RelatedRef[]
}

/**
 * A link from one note to another. `label` is an optional short relation read
 * as "<this> <label> <related>" — "works for", "supplier of", "owns" — written
 * by the same AI call that found the entity (obj 720162). No label = a plain link.
 */
export interface RelatedRef {
  type: EntityType
  name: string
  label?: string
}

/** A relation label as stored: lower-case words, ≤ 40 chars, or undefined. */
export function cleanRelationLabel(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.replace(/[^\p{L}\p{N} '&/-]+/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40).trim()
  return s || undefined
}

export interface SourceRef {
  /** KB-relative path of the source note, e.g. `sources/2026-10-30-price-list.md`. */
  notePath: string
  /** KB-relative path of the original file, e.g. `sources/files/2026-10-30-price-list.xlsx`. */
  filePath: string
  /** Original upload name, shown to people. */
  fileName: string
}

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return s || 'untitled'
}

export function notePathFor(type: EntityType, name: string): string {
  return `${FOLDER_FOR[type]}/${slugify(name)}.md`
}

/** Relative link from one KB-relative path to another (both use `/`). */
export function relLink(from: string, to: string): string {
  const a = from.split('/').slice(0, -1)
  const b = to.split('/')
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/') || to
}

function yamlStr(s: string): string {
  return /^[\w .,'()&/-]+$/.test(s) && !/^[-?:]/.test(s) && !/:\s/.test(s) ? s : JSON.stringify(s)
}

function yamlList(items: string[]): string {
  // Inside [a, b] a comma separates items, so any item with one is quoted.
  return `[${items.map(i => (/[,[\]{}]/.test(i) ? JSON.stringify(i) : yamlStr(i))).join(', ')}]`
}

export interface Frontmatter {
  title: string
  type: string
  aliases: string[]
  sources: string[]
  tags: string[]
  updated: string
  [k: string]: unknown
}

export function renderFrontmatter(fm: Frontmatter): string {
  const lines = ['---', `title: ${yamlStr(fm.title)}`, `type: ${fm.type}`]
  if (fm.aliases.length) lines.push(`aliases: ${yamlList(fm.aliases)}`)
  lines.push(`tags: ${yamlList(fm.tags)}`)
  lines.push(`sources: ${yamlList(fm.sources)}`)
  lines.push(`updated: ${fm.updated}`)
  lines.push('generated_by: document-ingest')
  lines.push('---')
  return lines.join('\n')
}

function parseYamlList(v: string): string[] {
  const inner = v.trim().replace(/^\[|\]$/g, '')
  if (!inner.trim()) return []
  const out: string[] = []
  for (const m of inner.matchAll(/"((?:\\.|[^"\\])*)"|([^,]+)/g)) {
    const val = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) as string : m[2].trim()
    if (val) out.push(val)
  }
  return out
}

export function parseNote(text: string): { fm: Frontmatter | null; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { fm: null, body: text }
  const get = (k: string) => m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] ?? ''
  const unq = (s: string) => (s.startsWith('"') ? JSON.parse(s) as string : s)
  return {
    fm: {
      title: unq(get('title')),
      type: get('type'),
      aliases: parseYamlList(get('aliases')),
      sources: parseYamlList(get('sources')),
      tags: parseYamlList(get('tags')),
      updated: get('updated'),
    },
    body: text.slice(m[0].length),
  }
}

/** Split a body into its preamble and `## ` sections (heading line kept). */
function splitSections(body: string): { pre: string; sections: Array<{ heading: string; text: string }> } {
  const parts = body.split(/^(?=## )/m)
  const pre = parts[0].startsWith('## ') ? '' : parts.shift() ?? ''
  return {
    pre,
    sections: parts.map(p => ({ heading: p.split('\n', 1)[0].replace(/^## /, '').trim(), text: p.replace(/\s+$/, '') })),
  }
}

export function sourceHeading(src: SourceRef): string {
  return `From: ${src.fileName}`
}

function renderSourceSection(notePath: string, e: Entity, src: SourceRef): string {
  const lines = [
    `## ${sourceHeading(src)}`,
    '',
    `*Source: [${src.fileName} (readable copy)](${relLink(notePath, src.notePath)}) · [original file](${relLink(notePath, src.filePath)})*`,
    '',
  ]
  if (e.summary) lines.push(e.summary.trim(), '')
  for (const f of e.facts) lines.push(`- ${f.fact.trim()}${f.where ? ` *(${f.where.trim().replace(/\*/g, '')})*` : ''}`)
  return lines.join('\n').replace(/\n+$/, '')
}

function relatedLine(notePath: string, r: RelatedRef): string {
  const label = cleanRelationLabel(r.label)
  return `- [${r.name}](${relLink(notePath, notePathFor(r.type, r.name))}) (${r.type})${label ? ` — ${label}` : ''}`
}

/** The link target of a "## Related" line, so a labelled line replaces the plain one for the same note. */
function relatedTarget(line: string): string {
  return line.match(/^- \[[^\]]*\]\(([^)]*)\)/)?.[1] ?? line
}

/** Merge Related lines by target: a new label wins, an old label is kept when the new line has none. */
function mergeRelatedLines(have: string[], add: string[]): string[] {
  const labelled = (line: string) => /\) \([a-z]+\) — .+$/.test(line)
  const byTarget = new Map<string, string>()
  for (const line of [...have, ...add]) {
    const prev = byTarget.get(relatedTarget(line))
    if (!prev || labelled(line) || !labelled(prev)) byTarget.set(relatedTarget(line), line)
  }
  return [...byTarget.values()]
}

const TAGS_FOR: Record<EntityType, string> = { organization: 'organization', person: 'person', project: 'project', product: 'product', topic: 'topic' }

/**
 * Create or update the note for `e` with what `src` says about it.
 * `existing` is the current file text (or null for a new note).
 */
export function upsertEntityNote(existing: string | null, e: Entity, src: SourceRef, today: string): string {
  const notePath = notePathFor(e.type, e.name)
  const related = (e.related ?? []).filter(r => ENTITY_TYPES.includes(r.type) && r.name.trim() && notePathFor(r.type, r.name) !== notePath)

  if (!existing) {
    const fm: Frontmatter = {
      title: e.name,
      type: e.type,
      aliases: [...new Set((e.aliases ?? []).filter(a => a && a !== e.name))],
      sources: [src.notePath],
      tags: [TAGS_FOR[e.type]],
      updated: today,
    }
    const parts = [renderFrontmatter(fm), '', `# ${e.name}`, '']
    if (e.summary) parts.push(e.summary.trim(), '')
    if (related.length) parts.push('## Related', '', ...mergeRelatedLines([], related.map(r => relatedLine(notePath, r))), '')
    parts.push(renderSourceSection(notePath, { ...e, summary: undefined }, src), '')
    return parts.join('\n')
  }

  const { fm: oldFm, body } = parseNote(existing)
  const fm: Frontmatter = {
    title: oldFm?.title || e.name,
    type: oldFm?.type || e.type,
    aliases: [...new Set([...(oldFm?.aliases ?? []), ...(e.aliases ?? []), ...(oldFm?.title && oldFm.title !== e.name ? [e.name] : [])])].filter(a => a !== (oldFm?.title || e.name)),
    sources: [...new Set([...(oldFm?.sources ?? []), src.notePath])],
    tags: oldFm?.tags.length ? oldFm.tags : [TAGS_FOR[e.type]],
    updated: today,
  }
  const { pre, sections } = splitSections(body)
  const heading = sourceHeading(src)
  const mine = renderSourceSection(notePath, e, src)

  const relIdx = sections.findIndex(s => s.heading === 'Related')
  if (related.length) {
    const have = relIdx >= 0 ? sections[relIdx].text.split('\n').filter(l => l.startsWith('- ')) : []
    const lines = mergeRelatedLines(have, related.map(r => relatedLine(notePath, r)))
    const relText = ['## Related', '', ...lines].join('\n')
    if (relIdx >= 0) sections[relIdx].text = relText
    else sections.unshift({ heading: 'Related', text: relText })
  }
  const srcIdx = sections.findIndex(s => s.heading === heading)
  if (srcIdx >= 0) sections[srcIdx].text = mine
  else sections.push({ heading, text: mine })

  const preText = pre.replace(/\s+$/, '') || `# ${fm.title}`
  return [renderFrontmatter(fm), '', preText.replace(/^\n+/, ''), '', sections.map(s => s.text).join('\n\n'), ''].join('\n')
}

/** Readable copy of an uploaded file: what the AI read, and what notes cite. */
export function renderSourceNote(opts: {
  title: string
  src: SourceRef
  fileType: string
  uploadedAt: string
  sha256: string
  markdown: string
  warnings: string[]
  summary?: string
  notes?: string[]
}): string {
  const fm = [
    '---',
    `title: ${yamlStr(opts.title)}`,
    'type: source',
    `file_type: ${opts.fileType}`,
    `original_file: ${yamlStr(opts.src.filePath)}`,
    `uploaded: ${opts.uploadedAt}`,
    `sha256: ${opts.sha256}`,
    'tags: [source]',
    'generated_by: document-ingest',
    '---',
  ].join('\n')
  const parts = [fm, '', `# ${opts.title}`, '', `Original file: [${opts.src.fileName}](${relLink(opts.src.notePath, opts.src.filePath)})`, '']
  if (opts.summary) parts.push('## Summary', '', opts.summary.trim(), '')
  if (opts.notes?.length) {
    parts.push('## Notes made from this file', '', ...opts.notes.map(n => `- [${n.replace(/^.*\//, '').replace(/\.md$/, '')}](${relLink(opts.src.notePath, n)})`), '')
  }
  if (opts.warnings.length) parts.push('## Reading notes', '', ...opts.warnings.map(w => `- ${w}`), '')
  parts.push('## Content (as extracted)', '', opts.markdown || '*(no text could be read from this file)*', '')
  return parts.join('\n')
}

// ── Writing to disk ──────────────────────────────────────────────────────────


/** Folders a document-ingest knowledge base uses (relative to the KB root). */
export const KB_FOLDERS = ['sources/inbox', 'sources/files', ...Object.values(FOLDER_FOR)] as const

/** What the AI librarian returns for one file. */
export interface OrganizedDocument {
  title?: string
  summary?: string
  entities: Entity[]
}

export interface SourceInfo {
  id: string
  fileName: string
  /** KB-relative path of the stored original. */
  storedRel: string
  kind: string
  ingestedAt: string
}

export interface EntityIndexEntry {
  type: EntityType
  name: string
  aliases: string[]
  rel: string
}

/** Every organization/person/project/product/topic note already in the KB, with its aliases. */
export function loadEntityIndex(kbRoot: string): { all: EntityIndexEntry[]; find: (type: EntityType, name: string) => EntityIndexEntry | undefined } {
  const all: EntityIndexEntry[] = []
  for (const type of ENTITY_TYPES) {
    const dir = path.join(kbRoot, FOLDER_FOR[type])
    let names: string[] = []
    try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md')).sort() } catch { continue }
    for (const n of names) {
      try {
        const { fm } = parseNote(fs.readFileSync(path.join(dir, n), 'utf8'))
        all.push({ type, name: fm?.title || n.replace(/\.md$/, ''), aliases: fm?.aliases ?? [], rel: `${FOLDER_FOR[type]}/${n}` })
      } catch { /* unreadable note: skip */ }
    }
  }
  const find = (type: EntityType, name: string) => {
    const s = slugify(name)
    const exact = all.find(e => e.type === type && (slugify(e.name) === s || e.aliases.some(a => slugify(a) === s)))
    if (exact || type !== 'organization') return exact
    return all.find(e => e.type === 'organization' && [e.name, ...e.aliases].some(n => sameOrganization(n, name)))
  }
  return { all, find }
}

function cleanEntity(raw: Entity): Entity | null {
  if (!raw || !ENTITY_TYPES.includes(raw.type) || typeof raw.name !== 'string' || !raw.name.trim()) return null
  return {
    type: raw.type,
    name: raw.name.trim().slice(0, 120),
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim()) : [],
    summary: typeof raw.summary === 'string' ? raw.summary : undefined,
    facts: Array.isArray(raw.facts)
      ? raw.facts.filter(f => f && typeof f.fact === 'string' && f.fact.trim()).map(f => ({ fact: f.fact, where: typeof f.where === 'string' ? f.where : undefined }))
      : [],
    related: Array.isArray(raw.related)
      ? raw.related.filter(r => r && ENTITY_TYPES.includes(r.type) && typeof r.name === 'string').map(r => ({ type: r.type, name: r.name, label: cleanRelationLabel(r.label) }))
      : [],
  }
}

/**
 * Write the source note plus one note per entity. An entity whose name (or
 * alias) matches an existing note is merged into that note instead of
 * creating a near-duplicate, so "Acme Corp" and "ACME Corporation" end up in
 * one place once either is known.
 */
const LEGAL_WORDS = new Set(['the', 'and', 'llc', 'l-l-c', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'lp', 'llp', 'plc', 'pllc'])

function orgTokens(name: string): string[] {
  return slugify(name).split('-').filter(t => t && !LEGAL_WORDS.has(t))
}

/**
 * Same organization under a different spelling? Legal suffixes, "&"/"and" and
 * case are ignored ("Acme Corp" = "ACME Corporation"), and a name of 2+ words
 * that is the start of a longer one counts as the same organization ("Maple
 * Street Dental" = "Maple Street Dental Group, LLC") — the way people shorten
 * names in a spreadsheet. One-word names never prefix-match.
 */
export function sameOrganization(a: string, b: string): boolean {
  const x = orgTokens(a)
  const y = orgTokens(b)
  if (!x.length || !y.length) return false
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  if (short.length === long.length) return short.every((t, i) => t === long[i])
  return short.length >= 2 && short.every((t, i) => t === long[i])
}

export function writeOrganized(
  kbRoot: string,
  src: SourceInfo,
  doc: OrganizedDocument,
  markdown: string,
  warnings: string[],
): { notes: Array<{ rel: string; created: boolean }>; sourceNoteRel: string } {
  const sourceNoteRel = `sources/${src.id}.md`
  const ref: SourceRef = { notePath: sourceNoteRel, filePath: src.storedRel, fileName: src.fileName }
  const today = src.ingestedAt.slice(0, 10)
  const index = loadEntityIndex(kbRoot)
  const notes: Array<{ rel: string; created: boolean }> = []

  // Pass 1: resolve every entity to its note, merging the ones that land on the
  // same note (the AI may list an organization twice, or two tabs read in parallel
  // may both mention it). A source owns ONE section per note, so they must be
  // combined before writing or the second would replace the first.
  const canonical = (type: EntityType, name: string) => index.find(type, name)?.name ?? name
  const byRel = new Map<string, Entity>()
  for (const raw of doc.entities ?? []) {
    const e0 = cleanEntity(raw)
    if (!e0) continue
    const name = canonical(e0.type, e0.name)
    const e: Entity = {
      ...e0,
      name,
      aliases: name !== e0.name ? [...(e0.aliases ?? []), e0.name] : e0.aliases,
    }
    const rel = notePathFor(e.type, e.name)
    const prev = byRel.get(rel)
    if (prev) {
      const seen = new Set(prev.facts.map(f => f.fact))
      prev.facts.push(...e.facts.filter(f => !seen.has(f.fact)))
      prev.aliases = [...new Set([...(prev.aliases ?? []), ...(e.aliases ?? [])])].filter(a => a !== prev.name)
      prev.related = [...(prev.related ?? []), ...(e.related ?? [])]
      prev.summary = prev.summary || e.summary
    } else {
      byRel.set(rel, e)
      // Later entities in this same file can now match this one by name.
      if (!index.all.some(x => x.rel === rel)) index.all.push({ type: e.type, name: e.name, aliases: e.aliases ?? [], rel })
    }
  }

  // Pass 2: write. Related links resolve now that every entity in the file is known.
  for (const [rel, e] of byRel) {
    e.related = (e.related ?? []).map(r => ({ type: r.type, name: canonical(r.type, r.name), label: r.label }))
    const abs = path.join(kbRoot, rel)
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, upsertEntityNote(existing, e, ref, today))
    notes.push({ rel, created: !existing })
  }

  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(kbRoot, src.storedRel))).digest('hex')
  fs.writeFileSync(path.join(kbRoot, sourceNoteRel), renderSourceNote({
    title: doc.title?.trim() || src.fileName,
    src: ref,
    fileType: src.kind,
    uploadedAt: src.ingestedAt,
    sha256,
    markdown,
    warnings,
    summary: doc.summary,
    notes: [...new Set(notes.map(n => n.rel))],
  }))
  return { notes, sourceNoteRel }
}
