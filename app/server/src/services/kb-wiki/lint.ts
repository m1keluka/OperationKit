import fs from 'fs'
import path from 'path'
import { relLink, sameOrganization, slugify } from '../doc-ingest/notes.js'
import type { LlmCall } from '../doc-ingest/llm.js'
import { GENERATED_BY, LINT_REPORT_PAGE, STATE_DIR, isProtectedPath } from './paths.js'
import {
  appendLog, compileWiki, generatedPagePath, loadWiki, nameKey, pagesNamed, resolveLinkTarget, topicFolder, wikilink, yamlValue,
  type LoadedPage, type RawLink, type WikiPage,
} from './wiki.js'
import { deriveGraph, isolatedPages } from './graph.js'

/**
 * The wiki's cleanup pass (obj 720117). Safe, mechanical fixes are applied
 * (a broken link with exactly one obvious target, a topic several pages
 * mention but nobody wrote up); anything that needs judgement — orphans,
 * possible duplicates, stale pages, facts that disagree — is listed for a
 * person and never edited. Raw sources and machine state are never touched.
 */

export type LintKind = 'broken_link' | 'broken_edge' | 'orphan' | 'isolated' | 'duplicate' | 'stale' | 'missing_topic' | 'contradiction'

export interface LintItem {
  kind: LintKind
  page?: string
  /** One plain sentence. */
  detail: string
  pages?: string[]
}

export interface LintReport {
  ran_at: string
  fixed: LintItem[]
  needs_human: LintItem[]
  stats: Record<string, number>
  /** Things the run could not do (e.g. the AI check was skipped), in plain words. */
  notes: string[]
}

export interface LintOptions {
  llm?: LlmCall | null
  now?: Date
  staleDays: number
  /** How many pages the AI reads for contradictions (0 = skip). */
  aiPages: number
}

export const LINT_LAST = `${STATE_DIR}/lint-last.json`
const MAX_LISTED = 50
const MAX_STALE = 20

/** When the last cleanup ran (ISO), or null. */
export function lastLintRun(kbRoot: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(kbRoot, LINT_LAST), 'utf8')) as { ran_at?: unknown }
    return typeof v.ran_at === 'string' ? v.ran_at : null
  } catch { return null }
}

/** Every page write in lint goes through here: raw sources and machine state are refused outright. */
function writePage(kbRoot: string, rel: string, text: string): void {
  if (isProtectedPath(rel)) throw new Error(`refusing to write protected path ${rel}`)
  const abs = path.join(kbRoot, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
}

function stem(target: string): string {
  return path.posix.basename(target.split('#')[0]).replace(/\.md$/i, '')
}

/** Replacement text for a link pointed at `to`, keeping its form, label and heading. */
export function relinked(link: RawLink, fromRel: string, to: string): string {
  const h = link.heading ? `#${link.heading}` : ''
  if (link.form === 'md') return `[${link.label ?? stem(to)}](${relLink(fromRel, to)}${h})`
  return `[[${to.replace(/\.md$/, '')}${h}|${link.label ?? link.target}]]`
}

export function renderStub(name: string, mentionedIn: WikiPage[], today: string): string {
  return [
    '---',
    `title: ${yamlValue(name)}`,
    'type: topic',
    'stub: true',
    `updated: ${today}`,
    `generated_by: ${GENERATED_BY}`,
    '---',
    '',
    `# ${name}`,
    '',
    `This page was started automatically because ${mentionedIn.length} pages mention "${name}" but nothing has been written about it yet.`,
    '',
    '## Mentioned in',
    '',
    ...[...mentionedIn].sort((a, b) => a.title.localeCompare(b.title)).map(p => `- ${wikilink(p.rel, p.title)}`),
    '',
  ].join('\n')
}

// ── Checks (pure over loaded pages) ──────────────────────────────────────────

const ANALYSED_KINDS_SKIP = new Set(['source', 'answer', 'generated'])

export function findOrphans(loaded: LoadedPage[]): WikiPage[] {
  const linked = new Set<string>()
  for (const l of loaded) if (!l.stub) for (const to of l.page.links) linked.add(to)
  return loaded.filter(l => !l.stub && !ANALYSED_KINDS_SKIP.has(l.page.kind) && !linked.has(l.page.rel)).map(l => l.page)
}

// Mirrors the legal-word list sameOrganization ignores, only to bucket candidates (sameOrganization decides).
const LEGAL = new Set(['the', 'and', 'llc', 'l-l-c', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'limited', 'lp', 'llp', 'plc', 'pllc'])
function firstToken(name: string): string {
  return slugify(name).split('-').find(t => t && !LEGAL.has(t)) ?? ''
}

/** Groups of same-kind pages that look like one thing under two names. */
/**
 * A short name people write for a longer one ("[[Greenway]]" for Greenway
 * Growers): topic/person/company pages whose title or alias starts with the
 * link's whole words. Only a single match is ever used to fix a link.
 */
export function pagesStartingWith(pages: WikiPage[], name: string): string[] {
  const k = nameKey(name)
  if (k.length < 3) return []
  return pages
    .filter(p => !ANALYSED_KINDS_SKIP.has(p.kind) && [p.title, ...p.aliases].some(n => { const nk = nameKey(n); return nk !== k && nk.startsWith(`${k}-`) }))
    .map(p => p.rel)
}

export function findDuplicates(pages: WikiPage[]): WikiPage[][] {
  const candidates = pages.filter(p => !ANALYSED_KINDS_SKIP.has(p.kind))
  const parent = new Map<string, string>(candidates.map(p => [p.rel, p.rel]))
  const find = (r: string): string => { let x = r; while (parent.get(x) !== x) x = parent.get(x)!; return x }
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra) }
  const names = (p: WikiPage) => [p.title, stem(p.rel), ...p.aliases].filter(Boolean)

  const byKey = new Map<string, string>()
  const buckets = new Map<string, WikiPage[]>()
  for (const p of candidates) {
    for (const n of names(p)) {
      const k = `${p.kind}\0${nameKey(n)}`
      const other = byKey.get(k)
      if (other) union(other, p.rel)
      else byKey.set(k, p.rel)
    }
    const b = `${p.kind}\0${firstToken(p.title)}`
    const list = buckets.get(b)
    if (list) list.push(p)
    else buckets.set(b, [p])
  }
  for (const list of buckets.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (find(list[i].rel) === find(list[j].rel)) continue
        if (names(list[i]).some(a => names(list[j]).some(b => sameOrganization(a, b)))) union(list[i].rel, list[j].rel)
      }
    }
  }
  const groups = new Map<string, WikiPage[]>()
  for (const p of candidates) {
    const r = find(p.rel)
    const g = groups.get(r)
    if (g) g.push(p)
    else groups.set(r, [p])
  }
  return [...groups.values()].filter(g => g.length > 1)
}

export function findStale(pages: WikiPage[], staleDays: number, now: Date): WikiPage[] {
  const cutoff = now.getTime() - staleDays * 86_400_000
  return pages
    .filter(p => p.kind !== 'source' && p.updated && Number.isFinite(Date.parse(p.updated)) && Date.parse(p.updated) < cutoff)
    .sort((a, b) => Date.parse(a.updated!) - Date.parse(b.updated!))
}

// ── AI contradiction check ───────────────────────────────────────────────────

const CONTRADICTION_SYSTEM = [
  'You check a team\'s knowledge base for facts that disagree with each other.',
  'Each page collects what several sources said about one thing, in sections headed "## From: <source>".',
  'Report only real conflicts between sources (different numbers, dates, owners, decisions or statuses for the same thing).',
  'Ignore differences in wording, extra detail, and changes that are clearly explained as updates over time.',
  'Reply with JSON only: {"contradictions":[{"page":"<page path exactly as given>","detail":"<one plain sentence naming both sources and what they disagree on>"}]}.',
  'Reply {"contradictions":[]} when nothing conflicts.',
].join('\n')

const AI_BATCH_PAGES = 5
const AI_BATCH_CHARS = 40_000
const AI_PAGE_CHARS = 12_000

export function contradictionCandidates(loaded: LoadedPage[], limit: number): LoadedPage[] {
  if (limit <= 0) return []
  return loaded
    .filter(l => (l.text.match(/^## From: /gm) ?? []).length >= 2)
    .sort((a, b) => (b.page.updated ?? '').localeCompare(a.page.updated ?? '') || b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
}

export function parseContradictions(reply: string, allowed: Set<string>): Array<{ page: string; detail: string }> {
  const s = reply.indexOf('{')
  const e = reply.lastIndexOf('}')
  if (s < 0 || e <= s) throw new Error('no JSON in reply')
  const v = JSON.parse(reply.slice(s, e + 1)) as { contradictions?: unknown }
  if (!Array.isArray(v.contradictions)) return []
  return v.contradictions
    .filter((c): c is { page: string; detail: string } => !!c && typeof c.page === 'string' && typeof c.detail === 'string' && allowed.has(c.page) && !!c.detail.trim())
    .map(c => ({ page: c.page, detail: c.detail.replace(/\s+/g, ' ').trim() }))
}

const DUPLICATE_SYSTEM = [
  'You look for pages in a team\'s knowledge base that are about the SAME real thing under different names',
  '(e.g. "Hillcrest contract" and "Hillcrest grounds maintenance contract", "Tom" and "Tom Whitfield").',
  'You get one line per page: path | kind | title — summary. Only group pages of the same kind. When unsure, do not group.',
  'Reply with JSON only: {"duplicates":[["<path>","<path>"]]}. Reply {"duplicates":[]} when there are none.',
].join('\n')

/** Most pages listed per AI duplicate check — titles and one-line summaries only, so this stays one small call. */
export const AI_DUPLICATE_PAGES = 400

export function parseDuplicateGroups(reply: string, allowed: Map<string, string>): string[][] {
  const s = reply.indexOf('{')
  const e = reply.lastIndexOf('}')
  if (s < 0 || e <= s) throw new Error('no JSON in reply')
  const v = JSON.parse(reply.slice(s, e + 1)) as { duplicates?: unknown }
  if (!Array.isArray(v.duplicates)) return []
  return v.duplicates
    .filter((g): g is string[] => Array.isArray(g))
    .map(g => [...new Set(g.filter(r => typeof r === 'string' && allowed.has(r)))])
    // Same kind only: the model was told so, the check makes sure.
    .filter(g => g.length >= 2 && g.every(r => allowed.get(r) === allowed.get(g[0])))
}

/**
 * Names that do not look alike can still be one thing ("Hillcrest contract" /
 * "Hillcrest grounds maintenance contract"). One AI call over titles and
 * summaries catches those; groups the name rules already found are skipped.
 */
async function checkDuplicatesWithAi(pages: WikiPage[], llm: LlmCall, known: string[][], notes: string[]): Promise<string[][]> {
  const byKind = new Map<string, WikiPage[]>()
  for (const p of pages) if (!ANALYSED_KINDS_SKIP.has(p.kind)) byKind.set(p.kind, [...(byKind.get(p.kind) ?? []), p])
  const listed = [...byKind.values()].filter(l => l.length >= 2).flat().slice(0, AI_DUPLICATE_PAGES)
  if (listed.length < 2) return []
  const allowed = new Map(listed.map(p => [p.rel, p.kind]))
  let reply: string
  try {
    reply = await llm(DUPLICATE_SYSTEM, listed.map(p => `${p.rel} | ${p.kind} | ${p.title} — ${p.summary}`).join('\n'))
  } catch (err) {
    notes.push(`The AI check for duplicate pages was skipped: ${(err as Error).message}`)
    return []
  }
  let groups: string[][]
  try { groups = parseDuplicateGroups(reply, allowed) } catch {
    notes.push('The AI gave an unreadable reply to the duplicate-page check; it was skipped this time.')
    return []
  }
  const seen = new Set(known.map(g => [...g].sort().join('\0')))
  return groups.filter(g => !known.some(k => g.every(r => k.includes(r))) && !seen.has([...g].sort().join('\0')))
}

async function checkContradictions(pages: LoadedPage[], llm: LlmCall, notes: string[]): Promise<LintItem[]> {
  const batches: LoadedPage[][] = []
  let cur: LoadedPage[] = []
  let chars = 0
  for (const p of pages) {
    const n = Math.min(p.text.length, AI_PAGE_CHARS)
    if (cur.length && (cur.length >= AI_BATCH_PAGES || chars + n > AI_BATCH_CHARS)) { batches.push(cur); cur = []; chars = 0 }
    cur.push(p)
    chars += n
  }
  if (cur.length) batches.push(cur)

  const items: LintItem[] = []
  for (const batch of batches) {
    const prompt = batch.map(p => {
      const t = p.text.length > AI_PAGE_CHARS ? `${p.text.slice(0, AI_PAGE_CHARS)}\n…(page cut short)` : p.text
      return `===== PAGE: ${p.page.rel} =====\n${t}`
    }).join('\n\n')
    let reply: string
    try {
      reply = await llm(CONTRADICTION_SYSTEM, prompt)
    } catch (err) {
      notes.push(`The AI check for facts that disagree was stopped early: ${(err as Error).message}`)
      break
    }
    try {
      for (const c of parseContradictions(reply, new Set(batch.map(p => p.page.rel)))) {
        items.push({ kind: 'contradiction', page: c.page, detail: c.detail })
      }
    } catch {
      notes.push(`The AI gave an unreadable reply for ${batch.length} page(s); they were not checked this time.`)
    }
  }
  return items
}

// ── Report ───────────────────────────────────────────────────────────────────

const SECTION_FOR: Record<LintKind, string> = {
  broken_link: 'Links that point nowhere',
  missing_topic: 'Topics started automatically',
  broken_edge: 'Connections to pages that no longer exist',
  orphan: 'Pages nothing links to',
  isolated: 'Pages with no connections at all',
  duplicate: 'Pages that may be duplicates',
  stale: 'Pages not updated in a long time',
  contradiction: 'Facts that disagree',
}

function itemLine(i: LintItem, titleOf: (rel: string) => string): string {
  const refs = [...new Set([...(i.page ? [i.page] : []), ...(i.pages ?? [])])]
  return `- ${i.detail}${refs.length ? ` (${refs.slice(0, 6).map(r => wikilink(r, titleOf(r))).join(', ')})` : ''}`
}

export function renderLintReport(r: LintReport, titleOf: (rel: string) => string = r2 => stem(r2)): string {
  const lines = [
    '---', 'title: Wiki cleanup report', 'type: lint-report', `generated_by: ${GENERATED_BY}`, `updated: ${r.ran_at.slice(0, 10)}`, '---', '',
    '# Wiki cleanup report', '',
    `Last run ${r.ran_at.slice(0, 16).replace('T', ' ')} UTC. Fixed ${r.fixed.length} thing${r.fixed.length === 1 ? '' : 's'} automatically; ${r.needs_human.length} need${r.needs_human.length === 1 ? 's' : ''} a person to look. Nothing in the original files was changed.`,
    '',
  ]
  const group = (title: string, items: LintItem[]) => {
    if (!items.length) return
    lines.push(`## ${title}`, '')
    for (const kind of Object.keys(SECTION_FOR) as LintKind[]) {
      const of = items.filter(i => i.kind === kind)
      if (!of.length) continue
      lines.push(`### ${SECTION_FOR[kind]} (${of.length})`, '', ...of.map(i => itemLine(i, titleOf)), '')
    }
  }
  group('Fixed automatically', r.fixed)
  group('Needs a look', r.needs_human)
  if (!r.fixed.length && !r.needs_human.length) lines.push('Everything looks tidy.', '')
  if (r.notes.length) lines.push('## Notes', '', ...r.notes.map(n => `- ${n}`), '')
  return lines.join('\n')
}

// ── Run ──────────────────────────────────────────────────────────────────────

export async function runLint(kbRoot: string, opts: LintOptions): Promise<LintReport> {
  const now = opts.now ?? new Date()
  const today = now.toISOString().slice(0, 10)
  const fixed: LintItem[] = []
  const needs: LintItem[] = []
  const notes: string[] = []
  const stats: Record<string, number> = {}

  // 1. Broken links: fix the unambiguous ones, collect bare names for missing topics.
  let loaded = loadWiki(kbRoot)
  const pages = loaded.map(l => l.page)
  const byRel = new Map(pages.map(p => [p.rel, p]))
  const missing = new Map<string, { name: string; from: Set<string> }>()
  const unresolvable: Array<{ page: string; link: RawLink; options: string[] }> = []
  let fixedLinks = 0
  let brokenTotal = 0
  for (const l of loaded) {
    if (l.stub) continue
    const edits = new Map<string, string>()
    for (const link of l.rawLinks) {
      if (resolveLinkTarget(pages, link.target, l.page.rel)) continue
      brokenTotal++
      let options = pagesNamed(pages, stem(link.target)).filter(r => r !== l.page.rel)
      if (!options.length) {
        // A page that itself matches the short name makes it ambiguous ("[[Sam]]" written on Sam Okafor's page).
        const pre = pagesStartingWith(pages, stem(link.target))
        if (!pre.includes(l.page.rel)) options = pre
      }
      if (options.length === 1) {
        edits.set(link.match, relinked(link, l.page.rel, options[0]))
        fixed.push({ kind: 'broken_link', page: l.page.rel, pages: [options[0]], detail: `A link to "${link.target}" on ${l.page.title} pointed nowhere; it now goes to ${byRel.get(options[0])!.title}.` })
      } else if (!options.length && link.form === 'wiki' && !link.target.includes('/')) {
        const k = nameKey(link.target)
        const m = missing.get(k) ?? { name: link.target.replace(/\.md$/i, ''), from: new Set<string>() }
        m.from.add(l.page.rel)
        missing.set(k, m)
        unresolvable.push({ page: l.page.rel, link, options })
      } else {
        unresolvable.push({ page: l.page.rel, link, options })
      }
    }
    if (edits.size) {
      let text = l.text
      for (const [from, to] of edits) text = text.split(from).join(to)
      writePage(kbRoot, l.page.rel, text)
      fixedLinks += edits.size
    }
  }

  // 2. Missing topics: a name linked from ≥ 2 pages gets a stub page.
  const stubbed = new Set<string>()
  const folder = topicFolder()
  for (const [k, m] of missing) {
    if (m.from.size < 2) continue
    const rel = `${folder}/${slugify(m.name)}.md`
    if (fs.existsSync(path.join(kbRoot, rel))) continue
    writePage(kbRoot, rel, renderStub(m.name, [...m.from].map(r => byRel.get(r)!), today))
    stubbed.add(k)
    fixed.push({ kind: 'missing_topic', page: rel, pages: [...m.from], detail: `${m.from.size} pages mention "${m.name}" but it had no page, so one was started.` })
  }
  for (const u of unresolvable) {
    if (u.link.form === 'wiki' && stubbed.has(nameKey(u.link.target))) continue
    const why = u.options.length > 1
      ? `could mean any of ${u.options.length} pages`
      : 'does not match any page'
    needs.push({ kind: 'broken_link', page: u.page, pages: u.options.slice(0, 5), detail: `A link to "${u.link.target}" on ${byRel.get(u.page)!.title} ${why}.` })
  }
  stats.broken_links = brokenTotal
  stats.links_fixed = fixedLinks
  stats.topics_started = stubbed.size

  // Re-read only if something changed, so the remaining checks see the fixed wiki.
  if (fixedLinks || stubbed.size) loaded = loadWiki(kbRoot)
  stats.pages = loaded.length

  // 3. Orphans.
  const orphans = findOrphans(loaded)
  stats.orphans = orphans.length
  for (const p of orphans.slice(0, MAX_LISTED)) needs.push({ kind: 'orphan', page: p.rel, detail: `Nothing links to ${p.title} yet.` })
  if (orphans.length > MAX_LISTED) notes.push(`${orphans.length - MAX_LISTED} more pages that nothing links to are not listed.`)

  // 3b. Link graph (obj 720162): connections listed in frontmatter that point at a
  // missing file, and pages with no connection either way (not already listed above).
  const graph = deriveGraph(loaded)
  stats.graph_edges = graph.edges.length
  stats.broken_edges = graph.broken.length
  const graphTitle = new Map(loaded.map(l => [l.page.rel, l.page.title]))
  for (const b of graph.broken.slice(0, MAX_LISTED)) {
    needs.push({ kind: 'broken_edge', page: b.from_rel, detail: `${graphTitle.get(b.from_rel) ?? stem(b.from_rel)} lists ${b.kind === 'answer_used' ? 'a page it used' : 'a source'}, "${b.target}", that no longer exists.` })
  }
  if (graph.broken.length > MAX_LISTED) notes.push(`${graph.broken.length - MAX_LISTED} more connections to missing pages are not listed.`)
  const orphanRels = new Set(orphans.map(p => p.rel))
  const stubRels = new Set(loaded.filter(l => l.stub).map(l => l.page.rel))
  const isolated = isolatedPages(graph).filter(n => !orphanRels.has(n.rel) && !stubRels.has(n.rel) && n.kind !== 'generated')
  stats.isolated = isolated.length
  for (const n of isolated.slice(0, MAX_LISTED)) needs.push({ kind: 'isolated', page: n.rel, detail: `${n.title} has no connections: nothing links to it and it links to nothing.` })
  if (isolated.length > MAX_LISTED) notes.push(`${isolated.length - MAX_LISTED} more pages with no connections are not listed.`)

  // 4. Possible duplicates.
  const dups = findDuplicates(loaded.map(l => l.page))
  stats.duplicates = dups.length
  for (const g of dups.slice(0, MAX_LISTED)) {
    needs.push({ kind: 'duplicate', pages: g.map(p => p.rel), detail: `These pages may be about the same ${g[0].kind}: ${g.map(p => p.title).join(', ')}. Merge them by hand if so.` })
  }

  // 5. Stale pages.
  const stale = findStale(loaded.map(l => l.page), opts.staleDays, now)
  stats.stale = stale.length
  for (const p of stale.slice(0, MAX_STALE)) needs.push({ kind: 'stale', page: p.rel, detail: `${p.title} has not been updated since ${p.updated!.slice(0, 10)}.` })

  // 6. Facts that disagree (AI, report-only).
  const cands = contradictionCandidates(loaded, opts.aiPages)
  stats.ai_pages_checked = 0
  if (!cands.length) {
    if (opts.aiPages <= 0) notes.push('The AI check for facts that disagree is turned off.')
  } else if (!opts.llm) {
    notes.push('The AI check for facts that disagree was skipped because no AI is set up.')
  } else {
    const found = await checkContradictions(cands, opts.llm, notes)
    stats.ai_pages_checked = cands.length
    needs.push(...found)
  }
  stats.contradictions = needs.filter(i => i.kind === 'contradiction').length

  // 7. Duplicates the name rules cannot see (AI, report-only).
  if (opts.llm && opts.aiPages > 0) {
    const byRel = new Map(loaded.map(l => [l.page.rel, l.page]))
    const aiDups = await checkDuplicatesWithAi(loaded.map(l => l.page), opts.llm, dups.map(g => g.map(p => p.rel)), notes)
    for (const g of aiDups.slice(0, MAX_LISTED)) {
      const ps = g.map(r => byRel.get(r)!)
      needs.push({ kind: 'duplicate', pages: g, detail: `These pages look like the same ${ps[0].kind} under different names: ${ps.map(p => p.title).join(', ')}. Merge them by hand if so.` })
    }
    stats.duplicates += aiDups.length
  }

  compileWiki(kbRoot, { now })

  const report: LintReport = { ran_at: now.toISOString(), fixed, needs_human: needs, stats, notes }
  const titles = new Map(loaded.map(l => [l.page.rel, l.page.title]))
  const reportRel = generatedPagePath(kbRoot, LINT_REPORT_PAGE)
  fs.writeFileSync(path.join(kbRoot, reportRel), renderLintReport(report, r => titles.get(r) ?? stem(r)))
  const state = path.join(kbRoot, LINT_LAST)
  fs.mkdirSync(path.dirname(state), { recursive: true })
  fs.writeFileSync(`${state}.tmp`, JSON.stringify(report, null, 2))
  fs.renameSync(`${state}.tmp`, state)
  appendLog(kbRoot, {
    kind: 'lint',
    title: `Cleanup: fixed ${fixed.length}, ${needs.length} need${needs.length === 1 ? 's' : ''} a look`,
    pages: [reportRel, ...new Set(fixed.map(i => i.page!).filter(Boolean))],
    when: now,
  })
  return report
}
