import path from 'path'
import { mergeTags, type Entity, type EntityType } from '../doc-ingest/notes.js'

/**
 * Knowledge Base Setup taxonomy (obj 900556).
 *
 * There is ONE knowledge-base structure on an install, defined by document
 * ingest (#596) and the wiki layer (#720117): five note types, each with its
 * own folder — `people/`, `organizations/`, `projects/`, `products/`,
 * `topics/` — plus `sources/` (readable copies) and `answers/` (filed answers).
 * Search, `kb_related` and `kb_who_knows` all read that structure.
 *
 * The setup agent is asked to sort a business's files into eight sections a
 * person recognises (people, companies & clients, projects, decisions,
 * processes & SOPs, products, glossary, other topics). Rather than inventing a
 * parallel folder tree, each section is a (type, tag) pair on the EXISTING
 * structure: a decision is a `topic` note tagged `decision`, an SOP is a
 * `topic` tagged `process`, a client is an `organization` tagged `client`.
 * The tag lives in the note's frontmatter `tags:` list, next to the type tag
 * the note already carried.
 *
 * Everything here is pure — no I/O — so the rules are unit-tested directly.
 */

export type SectionKey = 'people' | 'companies' | 'projects' | 'decisions' | 'processes' | 'products' | 'glossary' | 'topics'

export interface Section {
  key: SectionKey
  label: string
  type: EntityType
  /** The tag that puts a note of `type` in this section (none = the type's default section). */
  tag?: string
}

export const SECTIONS: readonly Section[] = [
  { key: 'people', label: 'People', type: 'person' },
  { key: 'companies', label: 'Companies & clients', type: 'organization' },
  { key: 'projects', label: 'Projects', type: 'project' },
  { key: 'decisions', label: 'Decisions', type: 'topic', tag: 'decision' },
  { key: 'processes', label: 'Processes & SOPs', type: 'topic', tag: 'process' },
  { key: 'products', label: 'Products & services', type: 'product' },
  { key: 'glossary', label: 'Glossary', type: 'topic', tag: 'glossary' },
  { key: 'topics', label: 'Other topics', type: 'topic' },
]

/**
 * The tags the agent may put on a note, per type. Anything else the AI
 * suggests is mapped through SYNONYMS or dropped — a controlled vocabulary is
 * what keeps tag search useful after a few hundred files.
 */
export const TAG_VOCABULARY: Record<EntityType, readonly string[]> = {
  person: ['team', 'contact', 'owner', 'advisor'],
  organization: ['client', 'prospect', 'supplier', 'partner', 'competitor', 'investor'],
  project: ['active', 'completed', 'proposed'],
  product: ['service', 'product', 'add-on', 'retired'],
  topic: ['decision', 'process', 'policy', 'glossary', 'lesson', 'meeting'],
}

const SYNONYMS: Record<string, string> = {
  customer: 'client', customers: 'client', clients: 'client', account: 'client',
  lead: 'prospect', prospects: 'prospect',
  vendor: 'supplier', vendors: 'supplier', suppliers: 'supplier', contractor: 'supplier', subcontractor: 'supplier',
  partners: 'partner', agency: 'partner', reseller: 'partner',
  competitors: 'competitor', rival: 'competitor',
  employee: 'team', staff: 'team', 'team-member': 'team', internal: 'team',
  'client-contact': 'contact', 'supplier-contact': 'contact', 'external-contact': 'contact',
  founder: 'owner', ceo: 'owner',
  sop: 'process', sops: 'process', procedure: 'process', checklist: 'process', 'how-to': 'process', howto: 'process',
  playbook: 'process', runbook: 'process', workflow: 'process', processes: 'process',
  decisions: 'decision', 'decision-log': 'decision', adr: 'decision',
  policies: 'policy', rule: 'policy', rules: 'policy', terms: 'policy',
  term: 'glossary', definition: 'glossary', jargon: 'glossary', acronym: 'glossary',
  lessons: 'lesson', 'lesson-learned': 'lesson', retro: 'lesson', postmortem: 'lesson',
  services: 'service', products: 'product', addon: 'add-on',
  done: 'completed', finished: 'completed', ongoing: 'active', 'in-progress': 'active', planned: 'proposed', idea: 'proposed',
}

function slugTag(t: string): string {
  return t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Map one AI-suggested tag onto the vocabulary for `type`, or null when it has no place there. */
export function normalizeTag(type: EntityType, raw: string): string | null {
  const s = slugTag(raw)
  if (!s) return null
  const t = SYNONYMS[s] ?? s
  return TAG_VOCABULARY[type].includes(t) ? t : null
}

const PROCESS_NAME = /^(sop\b|how to\b|how we\b|checklist\b|process\b|procedure\b|playbook\b|runbook\b|onboarding\b)|\b(sop|process|procedure|checklist|playbook|runbook|workflow)$/i
const DECISION_NAME = /^decision\b|^decided\b|\bdecision$/i
const POLICY_NAME = /\b(policy|policies|terms|guarantee|refunds?)\b/i

/**
 * The tags a note should carry beyond its type tag: the AI's suggestions,
 * normalised, plus what the name alone makes obvious ("SOP - Client
 * onboarding" is a process even when the AI forgot to say so).
 */
export function tagsFor(e: Pick<Entity, 'type' | 'name'> & { tags?: string[] }): string[] {
  const out: string[] = []
  for (const raw of e.tags ?? []) {
    const t = normalizeTag(e.type, raw)
    if (t && !out.includes(t)) out.push(t)
  }
  // Infer only when the AI gave no topic kind at all: an explicit kind always wins.
  if (e.type === 'topic' && !out.some(t => ['decision', 'process', 'policy', 'glossary'].includes(t))) {
    const name = e.name.trim()
    if (/^glossary$/i.test(name)) out.push('glossary')
    else if (DECISION_NAME.test(name)) out.push('decision')
    else if (PROCESS_NAME.test(name)) out.push('process')
    else if (POLICY_NAME.test(name)) out.push('policy')
  }
  return out
}

/** Which of the eight sections a note belongs to, from its type + tags. */
export function sectionFor(type: EntityType | string, tags: string[]): SectionKey {
  switch (type) {
    case 'person': return 'people'
    case 'organization': return 'companies'
    case 'project': return 'projects'
    case 'product': return 'products'
    case 'topic':
      if (tags.includes('decision')) return 'decisions'
      if (tags.includes('glossary')) return 'glossary'
      if (tags.includes('process') || tags.includes('policy')) return 'processes'
      return 'topics'
    default: return 'topics'
  }
}

export const GLOSSARY_PAGE_NAME = 'Glossary'

/**
 * Glossary terms are collected on ONE `topics/glossary.md` page — one fact
 * per term — instead of a page per acronym. A topic the AI tagged `glossary`
 * under its own name ("NPS") becomes a "**NPS** — definition" fact there.
 */
export function foldGlossary(entities: Entity[]): Entity[] {
  const out: Entity[] = []
  let glossary: Entity | null = null
  const ensure = (): Entity => {
    if (!glossary) {
      glossary = { type: 'topic', name: GLOSSARY_PAGE_NAME, summary: 'Words, acronyms and internal names this business uses, and what they mean.', facts: [], related: [], tags: ['glossary'] }
      out.push(glossary)
    }
    return glossary
  }
  for (const e of entities) {
    const tags = tagsFor(e)
    if (e.type !== 'topic' || !tags.includes('glossary')) { out.push({ ...e, tags }); continue }
    const g = ensure()
    if (e.name.trim().toLowerCase() === GLOSSARY_PAGE_NAME.toLowerCase()) {
      g.facts.push(...e.facts)
      g.related!.push(...(e.related ?? []))
      continue
    }
    const def = (e.summary ?? e.facts[0]?.fact ?? '').trim()
    g.facts.push({ fact: `**${e.name.trim()}**${def ? ` — ${def}` : ''}`, where: e.facts[0]?.where })
    for (const f of e.facts.slice(def === e.facts[0]?.fact?.trim() ? 1 : 0)) g.facts.push({ fact: `${e.name.trim()}: ${f.fact}`, where: f.where })
    g.related!.push(...(e.related ?? []))
  }
  for (const e of out) e.tags = mergeTags([], e.tags)
  return out
}

// ── File-level classification ────────────────────────────────────────────────

export type FileCategory =
  | 'meeting-notes' | 'process' | 'decision-log' | 'contract' | 'price-list' | 'contact-list'
  | 'org-chart' | 'glossary' | 'proposal' | 'report' | 'chat-export' | 'correspondence' | 'notes'

/** Words in a file or folder name that give its category away, most specific first. */
const NAME_WORDS: Array<{ cat: FileCategory; re: RegExp }> = [
  { cat: 'chat-export', re: /(chat|conversation|slack|whatsapp|messages)/i },
  { cat: 'correspondence', re: /(e-?mail|thread|inbox|correspondence|letter)/i },
  { cat: 'meeting-notes', re: /(meeting|call|standup|stand-up|minutes|transcript|1-1|one-on-one|kickoff|retro)/i },
  { cat: 'glossary', re: /(glossary|acronyms|terminology|jargon|definitions)/i },
  { cat: 'decision-log', re: /(decision|\badr\b|resolutions?)/i },
  { cat: 'process', re: /(\bsops?\b|procedure|process|checklist|playbook|runbook|how[-_ ]to|onboarding|handbook|guide)/i },
  { cat: 'contract', re: /(contract|agreement|statement of work|\bmsa\b|\bsow\b|\bnda\b)/i },
  { cat: 'price-list', re: /(price|pricing|rate[-_ ]?card|quote|catalog|catalogue|packages|brochure|services)/i },
  { cat: 'contact-list', re: /(contacts|crm|client[-_ ]?list|customer[-_ ]?list|clients|customers|leads|vendors|suppliers)/i },
  { cat: 'org-chart', re: /(org[-_ ]?chart|\bteam\b|staff|roster|directory)/i },
  { cat: 'proposal', re: /(proposal|pitch|deck|slides)/i },
  { cat: 'report', re: /(report|kpi|metrics|quarterly|monthly update)/i },
]

/** Content fallbacks when no name says anything. */
const TEXT_RULES: Array<{ cat: FileCategory; re: RegExp }> = [
  { cat: 'meeting-notes', re: /^(attendees|participants|agenda)\s*:/im },
  { cat: 'decision-log', re: /^\s*(#+\s*)?decisions?\b/im },
  { cat: 'process', re: /^\s*(#+\s*)?(steps?|procedure)\b|^\s*step 1\b/im },
  { cat: 'glossary', re: /^\s*(#+\s*)?glossary\b/im },
]

function byName(name: string): FileCategory | null {
  for (const r of NAME_WORDS) if (r.re.test(name)) return r.cat
  return null
}

/**
 * What kind of file this is: its own name first, then its folders from the
 * innermost out (a file in `SOPs/` is a process), then its first few KB of
 * text. Captions (.vtt/.srt) are always meetings and slide decks proposals
 * unless their name says otherwise. The category is a HINT for the AI and a
 * tag on the source note; it never decides on its own what notes get written.
 */
export function classifyFile(relPath: string, text = ''): FileCategory {
  const p = relPath.replace(/\\/g, '/')
  const base = path.posix.basename(p)
  const ext = path.posix.extname(base).toLowerCase()
  const own = byName(path.posix.basename(base, ext))
  if (own) return own
  if (ext === '.vtt' || ext === '.srt') return 'meeting-notes'
  const dirs = path.posix.dirname(p).split('/').filter(d => d && d !== '.').reverse()
  // A folder called "Clients" says what the files are ABOUT, not that each one is a contact list.
  for (const d of dirs) { const c = byName(d); if (c && c !== 'contact-list') return c }
  if (ext === '.pptx') return 'proposal'
  const head = text.slice(0, 4000)
  for (const r of TEXT_RULES) if (r.re.test(head)) return r.cat
  return 'notes'
}

/** One line telling the AI what to expect from a file of this category. */
export const CATEGORY_HINT: Record<FileCategory, string> = {
  'meeting-notes': 'A meeting or call. Look for decisions (tag "decision"), action items, who attended and what was agreed.',
  process: 'A process / SOP / how-to. File it as a topic tagged "process" named after what it does; keep the steps as facts in order.',
  'decision-log': 'A record of decisions. Each decision is its own topic tagged "decision" with what, who, when and why.',
  contract: 'A contract or agreement. The other party is an organization; record term, value, dates, renewal and obligations.',
  'price-list': 'A price list or quote. Each product or service is a product note with its price and terms.',
  'contact-list': 'A list of contacts, clients or suppliers. Each row is a person or organization; tag organizations client / supplier / partner as the file says.',
  'org-chart': 'A team list or org chart. Each person is a person note tagged "team" with their role and who they report to.',
  glossary: 'A glossary. Each term is a topic tagged "glossary" with its definition.',
  proposal: 'A proposal, pitch or slide deck. Record who it is for, what is offered, prices and dates.',
  report: 'A report or update. Record the figures, the period they cover and any decisions or next steps.',
  'chat-export': 'A chat export. Skip small talk; keep decisions, facts about people, clients and projects, and to-dos.',
  correspondence: 'Emails or letters. Record who wrote to whom, what was asked, agreed or quoted, and dates; skip greetings and signatures.',
  notes: 'General notes. File what a teammate would want to look up later.',
}
