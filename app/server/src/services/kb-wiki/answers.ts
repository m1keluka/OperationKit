import fs from 'fs'
import path from 'path'
import { slugify } from '../doc-ingest/notes.js'
import { ANSWERS_DIR, GENERATED_BY } from './paths.js'
import { appendLog, compileWiki, fmField, isWikiPageRel, wikilink, yamlArray, yamlValue } from './wiki.js'

/**
 * Filing an Ask answer back into the wiki (obj 720117) — the step that makes
 * the knowledge base compound: a good answer becomes a page, linked from the
 * pages it used, so the next question can build on it.
 */

export interface FileAnswerInput {
  question: string
  answer: string
  /** KB-relative paths of the pages the answer used. Unknown ones are dropped. */
  sources: string[]
  filedBy?: string
  now?: Date
}

function titleAt(kbRoot: string, rel: string): string {
  try {
    const text = fs.readFileSync(path.join(kbRoot, rel), 'utf8')
    return fmField(text, 'title') || text.match(/^# (.+)$/m)?.[1]?.trim() || path.posix.basename(rel, '.md')
  } catch { return path.posix.basename(rel, '.md') }
}

function cleanRel(rel: string): string {
  const r = rel.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  return /\.md$/i.test(r) ? r : `${r}.md`
}

/** Rewrite the Ask citation form `[[organizations/x.md]]` to `[[organizations/x|Title]]`. Pure apart from `titleFor`. */
export function rewriteCitations(answer: string, known: (rel: string) => string | undefined): string {
  return answer.replace(/\[\[([^[\]\n|#]+)(#[^[\]\n|]*)?(?:\|([^[\]\n]*))?\]\]/g, (m, target: string, _h: string | undefined, label: string | undefined) => {
    const rel = cleanRel(target)
    const title = known(rel)
    return title === undefined ? m : wikilink(rel, label?.trim() || title)
  })
}

/** Pure renderer for an answer page. */
export function renderAnswerPage(o: { question: string; answer: string; sources: Array<{ rel: string; title: string }>; filedBy?: string; updated: string }): string {
  const fm = [
    '---',
    `title: ${yamlValue(o.question)}`,
    'type: answer',
    `sources: ${yamlArray(o.sources.map(s => s.rel))}`,
    ...(o.filedBy ? [`filed_by: ${yamlValue(o.filedBy)}`] : []),
    `updated: ${o.updated}`,
    `generated_by: ${GENERATED_BY}`,
    '---',
  ]
  const parts = [...fm, '', `# ${o.question}`, '', o.answer.trim(), '']
  if (o.sources.length) parts.push('## Pages this answer used', '', ...o.sources.map(s => `- ${wikilink(s.rel, s.title)}`), '')
  return parts.join('\n')
}

/** Save an answer as `answers/<date>-<slug>.md`, recompile so its sources link back to it, and log it. */
export function fileAnswer(kbRoot: string, input: FileAnswerInput): { rel: string; title: string } {
  const question = input.question.replace(/\s+/g, ' ').trim()
  if (!question) throw new Error('An answer needs the question it answers.')
  if (!input.answer.trim()) throw new Error('The answer is empty.')
  const now = input.now ?? new Date()
  const date = now.toISOString().slice(0, 10)

  const sources: Array<{ rel: string; title: string }> = []
  for (const raw of input.sources ?? []) {
    const rel = cleanRel(raw)
    if (!isWikiPageRel(rel) || !fs.existsSync(path.join(kbRoot, rel)) || sources.some(s => s.rel === rel)) continue
    sources.push({ rel, title: titleAt(kbRoot, rel) })
  }
  const titles = new Map<string, string>()
  const known = (rel: string) => {
    if (!titles.has(rel)) titles.set(rel, isWikiPageRel(rel) && fs.existsSync(path.join(kbRoot, rel)) ? titleAt(kbRoot, rel) : '\0')
    const t = titles.get(rel)!
    return t === '\0' ? undefined : t
  }

  const base = `${date}-${slugify(question).slice(0, 60).replace(/-+$/, '')}`
  fs.mkdirSync(path.join(kbRoot, ANSWERS_DIR), { recursive: true })
  let rel = `${ANSWERS_DIR}/${base}.md`
  for (let i = 2; fs.existsSync(path.join(kbRoot, rel)); i++) rel = `${ANSWERS_DIR}/${base}-${i}.md`

  fs.writeFileSync(path.join(kbRoot, rel), renderAnswerPage({
    question,
    answer: rewriteCitations(input.answer, known),
    sources,
    filedBy: input.filedBy,
    updated: date,
  }), { flag: 'wx' })
  compileWiki(kbRoot, { now })
  appendLog(kbRoot, { kind: 'answer', title: `Saved an answer: ${question}`, pages: [rel, ...sources.map(s => s.rel)], when: now })
  return { rel, title: question }
}
