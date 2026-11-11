import crypto from 'crypto'
import type Database from 'better-sqlite3'
import { ENTITY_TYPES, slugify, sameOrganization, type EntityIndexEntry, type EntityType } from '../doc-ingest/notes.js'
import { createReviewItem, withdrawReviewItem, decideReviewItem, getReviewItem, type ReviewItemKind } from '../review-items.js'

/**
 * Open questions from Knowledge Base Setup (obj 900556).
 *
 * The agent never guesses when two names might be the same thing, or when two
 * files disagree: it files a question for the person instead. Questions come
 * from two places:
 *   - the AI, per file ("conflict": two prices for one service; "missing":
 *     "the new supplier" is never named);
 *   - a deterministic pass over the finished knowledge base that finds names
 *     the automatic merge deliberately did NOT join ("Sam" next to "Sam
 *     Okafor"; "Greenway" next to "Greenway Growers").
 *
 * Every question has a stable id (a hash of its kind + what it is about), so
 * a re-run asks the same question once — and a question the person already
 * answered or dismissed is never asked again.
 *
 * Questions land in the ONE human decision queue (`review_items`, obj
 * 900367). A review item must belong to a card, so a run with questions files
 * them under one board card per workspace — "Knowledge base setup: answer N
 * questions" — reused across runs while it is open.
 */

export type QuestionKind = 'ambiguous' | 'conflict' | 'missing' | 'secret'

export interface QuestionRef { type: EntityType; name: string }

export interface OpenQuestion {
  id: string
  kind: QuestionKind
  ask: string
  about: QuestionRef[]
  /** Files the question came from (relative paths as uploaded). */
  files: string[]
  status: 'open' | 'answered' | 'dismissed'
  answer?: string
  answered_at?: string
  answered_by?: string
  /** The decision-queue row, once filed. */
  review_item_id?: number
}

const KINDS: readonly QuestionKind[] = ['ambiguous', 'conflict', 'missing', 'secret']

function str(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
}

export function questionId(kind: QuestionKind, ask: string, about: QuestionRef[]): string {
  // About-refs identify the question when present: re-asked in different words, it is still the same question.
  const key = about.length
    ? `${kind}|${about.map(a => `${a.type}:${slugify(a.name)}`).sort().join('|')}`
    : `${kind}|${slugify(ask)}`
  return `q-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`
}

/** Validate the AI's "questions" list. Malformed entries are dropped, never thrown. */
export function cleanQuestions(raw: unknown, file: string): OpenQuestion[] {
  if (!Array.isArray(raw)) return []
  const out: OpenQuestion[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const o = q as Record<string, unknown>
    const kind = (KINDS as readonly string[]).includes(str(o.kind)) ? (str(o.kind) as QuestionKind) : 'ambiguous'
    const ask = str(o.ask).slice(0, 300)
    if (!ask) continue
    const about: QuestionRef[] = Array.isArray(o.about)
      ? o.about.flatMap(a => {
        const r = a as Record<string, unknown>
        return r && (ENTITY_TYPES as readonly string[]).includes(str(r.type)) && str(r.name) ? [{ type: str(r.type) as EntityType, name: str(r.name).slice(0, 120) }] : []
      })
      : []
    const id = questionId(kind, ask, about)
    if (!out.some(x => x.id === id)) out.push({ id, kind, ask: /\?$/.test(ask) ? ask : `${ask}?`, about, files: [file], status: 'open' })
  }
  return out
}

function tokens(name: string): string[] {
  return slugify(name).split('-').filter(Boolean)
}

/**
 * Names the automatic merge left apart on purpose because joining them would
 * be a guess:
 *   - a one-word person name that is the first name of one or more full names
 *     ("Sam" vs "Sam Okafor" / "Sam Reyes");
 *   - an organization whose name is a one-word start of another's ("Greenway"
 *     vs "Greenway Growers") — sameOrganization() only joins 2+-word prefixes.
 * Pairs already joined by an alias are not asked about.
 */
export function detectAmbiguousNames(index: EntityIndexEntry[]): OpenQuestion[] {
  const out: OpenQuestion[] = []
  const linked = (a: EntityIndexEntry, b: EntityIndexEntry) =>
    a.aliases.some(x => slugify(x) === slugify(b.name)) || b.aliases.some(x => slugify(x) === slugify(a.name))
  const people = index.filter(e => e.type === 'person')
  for (const short of people) {
    const t = tokens(short.name)
    if (t.length !== 1) continue
    const matches = people.filter(p => p !== short && tokens(p.name).length > 1 && tokens(p.name)[0] === t[0] && !linked(short, p))
    if (!matches.length) continue
    const names = matches.map(m => m.name).sort()
    const ask = matches.length === 1
      ? `Is "${short.name}" the same person as ${names[0]}?`
      : `Which person is "${short.name}": ${names.join(', ')}, or someone else?`
    const about: QuestionRef[] = [{ type: 'person', name: short.name }, ...names.map(name => ({ type: 'person' as const, name }))]
    out.push({ id: questionId('ambiguous', ask, about), kind: 'ambiguous', ask, about, files: [], status: 'open' })
  }
  const orgs = index.filter(e => e.type === 'organization')
  for (const short of orgs) {
    const t = tokens(short.name)
    if (t.length !== 1) continue
    for (const long of orgs) {
      if (long === short || linked(short, long) || sameOrganization(short.name, long.name)) continue
      const lt = tokens(long.name)
      if (lt.length > 1 && lt[0] === t[0]) {
        const ask = `Is "${short.name}" the same organization as "${long.name}"?`
        const about: QuestionRef[] = [{ type: 'organization', name: short.name }, { type: 'organization', name: long.name }]
        out.push({ id: questionId('ambiguous', ask, about), kind: 'ambiguous', ask, about, files: [], status: 'open' })
      }
    }
  }
  return out
}

/**
 * Merge freshly found questions into the stored list. A question already
 * answered or dismissed keeps its status (never re-asked); an open one gains
 * the new file references.
 */
export function mergeQuestions(have: OpenQuestion[], found: OpenQuestion[]): OpenQuestion[] {
  const byId = new Map(have.map(q => [q.id, { ...q, files: [...q.files] }]))
  for (const q of found) {
    const prev = byId.get(q.id)
    if (!prev) { byId.set(q.id, { ...q, files: [...q.files] }); continue }
    for (const f of q.files) if (!prev.files.includes(f)) prev.files.push(f)
  }
  return [...byId.values()]
}

// ── Decision queue ───────────────────────────────────────────────────────────

const REVIEW_KIND: Record<QuestionKind, ReviewItemKind> = {
  ambiguous: 'input_needed',
  missing: 'input_needed',
  conflict: 'decision',
  secret: 'input_needed',
}

interface AnchorDeps {
  db: Database.Database
  workspace: string
  /** Card id this workspace's setup questions were filed under last time, if any. */
  previousAnchor?: number | null
  setupUrl: string
}

/** Reuse the open setup card, or create one in `queue` (never auto-started). */
export function ensureAnchorCard(deps: AnchorDeps, openCount: number): number {
  const { db, workspace } = deps
  const title = `Knowledge base setup: answer ${openCount} open question${openCount === 1 ? '' : 's'}`
  const description = [
    'The Knowledge Base Setup agent found things it would not guess about — names that might be the same person or company, and files that disagree.',
    '',
    `Answer them on the knowledge base setup page: ${deps.setupUrl}`,
    '',
    'Each question is also in the decision queue for this card. No coding session is needed for this card; answering on the setup page closes the questions.',
  ].join('\n')
  if (deps.previousAnchor) {
    const row = db.prepare('SELECT id, status FROM objectives WHERE id = ? AND workspace = ?').get(deps.previousAnchor, workspace) as { id: number; status: string } | undefined
    if (row && row.status !== 'done' && row.status !== 'cancelled') {
      db.prepare("UPDATE objectives SET title = ?, updated_at = datetime('now') WHERE id = ?").run(title, row.id)
      return row.id
    }
  }
  const info = db.prepare(
    `INSERT INTO objectives (title, description, agent_context, workspace, category, status, origin)
     VALUES (?, ?, 'general', ?, 'general', 'queue', 'kb-setup')`,
  ).run(title, description, workspace)
  return Number(info.lastInsertRowid)
}

/**
 * File every OPEN question without a decision-queue row, idempotently
 * (`created_from_event_id` = `kb-setup:<workspace>:<question id>`). Returns
 * the questions with `review_item_id` filled in.
 */
export function fileQuestions(db: Database.Database, workspace: string, anchorId: number, questions: OpenQuestion[]): OpenQuestion[] {
  return questions.map(q => {
    if (q.status !== 'open' || q.review_item_id) return q
    const { item } = createReviewItem(db, {
      workspace,
      objective_id: anchorId,
      kind: REVIEW_KIND[q.kind],
      ask: q.ask,
      dedupe_key: `kb-setup:${workspace}:${q.id}`,
      created_from_event_id: `kb-setup:${workspace}:${q.id}`,
      options: q.kind === 'conflict' ? ['approve', 'changes', 'snooze'] : ['approve', 'reject', 'snooze'],
      actor: 'kb-setup',
    })
    return { ...q, review_item_id: item.id }
  })
}

/** The person answered or dismissed a question: record it in the queue too. */
export function closeQuestionItem(db: Database.Database, q: OpenQuestion, by: string): void {
  if (!q.review_item_id) return
  const item = getReviewItem(db, q.review_item_id)
  if (!item || !['open', 'snoozed', 'waiting_on_dependency'].includes(item.state)) return
  if (q.status === 'answered') {
    decideReviewItem(db, q.review_item_id, { choice: 'approve', note: (q.answer ?? '').slice(0, 1900), by, channel: 'ui', token: `kb-setup:${q.id}:answer` })
  } else {
    withdrawReviewItem(db, q.review_item_id, 'dismissed on the knowledge base setup page', by)
  }
}
