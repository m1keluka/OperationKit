import fs from 'fs'
import path from 'path'
import { FOLDER_FOR, parseNote } from './notes.js'
import type { LlmCall } from './llm.js'
import { extraNoteDirs } from '../kb-wiki/hooks.js'

/**
 * "Ask the files" (obj 719936): find the notes that matter for a question and
 * have the AI answer from them alone, citing note paths.
 *
 * Retrieval is a plain keyword score over this workspace's notes — no index,
 * no embeddings, nothing extra to install. A business's knowledge base is
 * hundreds of notes, not millions, and organized notes are short, so this
 * finds the right handful reliably.
 */

const STOP = new Set('a an and are as at be by did do does for from had has have how i in is it its me my of on or our than that the their them they this to was we were what when where which who why will with you your about any can tell give list show'.split(' '))

export function terms(q: string): string[] {
  return [...new Set(q.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9$.%]+/).map(t => t.replace(/^[.]+|[.]+$/g, '')).filter(t => t.length > 1 && !STOP.has(t)))]
}

export interface NoteDoc { rel: string; title: string; text: string }

export function listNotes(kbRoot: string): NoteDoc[] {
  const out: NoteDoc[] = []
  const dirs = [...Object.values(FOLDER_FOR), 'sources', ...extraNoteDirs(kbRoot)]
  for (const d of dirs) {
    let names: string[] = []
    try { names = fs.readdirSync(path.join(kbRoot, d)).filter(n => n.endsWith('.md')) } catch { continue }
    for (const n of names) {
      const rel = `${d}/${n}`
      try {
        const text = fs.readFileSync(path.join(kbRoot, rel), 'utf8')
        out.push({ rel, title: parseNote(text).fm?.title || n.replace(/\.md$/, ''), text })
      } catch { /* skip unreadable */ }
    }
  }
  return out
}

/** Rank notes for a question. Title hits count most; organized notes beat raw source copies. */
export function rankNotes(notes: NoteDoc[], question: string, limit = 12): NoteDoc[] {
  const ts = terms(question)
  if (!ts.length) return []
  const scored = notes.map(n => {
    const title = n.title.toLowerCase()
    const body = n.text.toLowerCase()
    let score = 0
    for (const t of ts) {
      if (title.includes(t)) score += 8
      let i = 0, c = 0
      while ((i = body.indexOf(t, i)) !== -1 && c < 20) { c++; i += t.length }
      score += c
    }
    if (n.rel.startsWith('sources/')) score *= 0.5
    return { n, score }
  }).filter(x => x.score > 0)
  scored.sort((a, b) => b.score - a.score || a.n.rel.localeCompare(b.n.rel))
  return scored.slice(0, limit).map(x => x.n)
}

export const MAX_CONTEXT_CHARS = 120_000

export function buildAskPrompt(question: string, notes: NoteDoc[]): string {
  const parts: string[] = [`QUESTION: ${question}`, '', 'NOTES:']
  let used = 0
  for (const n of notes) {
    const room = MAX_CONTEXT_CHARS - used
    if (room < 500) break
    const body = n.text.length > room ? `${n.text.slice(0, room)}\n…(note cut short)` : n.text
    used += body.length
    parts.push(`\n===== NOTE: ${n.rel} =====`, body)
  }
  return parts.join('\n')
}

export interface AskResult {
  answer: string
  sources: Array<{ rel: string; title: string }>
}

export async function askKnowledgeBase(kbRoot: string, question: string, llm: LlmCall, systemPrompt: string): Promise<AskResult> {
  const hits = rankNotes(listNotes(kbRoot), question)
  if (!hits.length) {
    return { answer: 'Nothing in the uploaded files matches that question yet. Try different words, or upload the file that covers it.', sources: [] }
  }
  const answer = (await llm(systemPrompt, buildAskPrompt(question, hits))).trim()
  const cited = new Set([...answer.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]))
  const sources = hits.filter(h => cited.has(h.rel)).map(h => ({ rel: h.rel, title: h.title }))
  return { answer, sources: sources.length ? sources : hits.slice(0, 5).map(h => ({ rel: h.rel, title: h.title })) }
}
