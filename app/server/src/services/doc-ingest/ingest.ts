import fs from 'fs'
import path from 'path'
import { extractDocument, kindForFile, type Extracted } from './extract.js'
import { KB_FOLDERS, slugify, writeOrganized, loadEntityIndex, type OrganizedDocument, type SourceInfo } from './notes.js'
import type { LlmCall } from './llm.js'

/**
 * Document ingest pipeline (obj 719936).
 *
 *   sources/inbox/<file>  →  sources/files/<date>-<file>   (original kept)
 *                         →  extract text on this server   (extract.ts)
 *                         →  AI organizes it into entities (the "librarian")
 *                         →  linked notes in the KB        (notes.ts)
 *
 * The only thing that leaves the server is the extracted text sent to the AI
 * provider the client configured (their own Claude account). The original file
 * never leaves; nothing is uploaded anywhere else.
 *
 * Runs server-side on purpose: client installs jail worker sessions
 * (SESSION_ISOLATION=docker) and a jailed session cannot see the knowledge
 * base, so a board-card worker could not write these notes there.
 *
 * Status lives in sources/_manifest.json so the UI (and a restart) can see
 * what happened to every file.
 */

export type IngestStatus = 'queued' | 'reading' | 'organizing' | 'done' | 'failed'

export interface ManifestEntry {
  id: string
  file_name: string
  stored: string
  kind: string
  status: IngestStatus
  uploaded_at: string
  finished_at?: string
  notes?: string[]
  source_note?: string
  warnings?: string[]
  error?: string
  uploaded_by?: string
}

const MANIFEST = 'sources/_manifest.json'
/** Keep each AI request comfortably inside one context window. */
export const MAX_PROMPT_CHARS = 180_000

export function ensureKbFolders(kbRoot: string): void {
  for (const f of KB_FOLDERS) fs.mkdirSync(path.join(kbRoot, f), { recursive: true })
}

export function readManifest(kbRoot: string): ManifestEntry[] {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(kbRoot, MANIFEST), 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function writeManifest(kbRoot: string, entries: ManifestEntry[]): void {
  const file = path.join(kbRoot, MANIFEST)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2))
  fs.renameSync(tmp, file)
}

function updateEntry(kbRoot: string, id: string, patch: Partial<ManifestEntry>): ManifestEntry | undefined {
  const entries = readManifest(kbRoot)
  const e = entries.find(x => x.id === id)
  if (!e) return undefined
  Object.assign(e, patch)
  writeManifest(kbRoot, entries)
  return e
}

/** Make an upload's name safe for the filesystem while keeping it recognisable. */
export function safeFileName(name: string): string {
  // Keep letters in any language and ordinary punctuation (–, &, accents);
  // drop only what is unsafe in a file name.
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, ' ').trim()
  return base.replace(/^\.+/, '') || 'file'
}

/**
 * Move every supported file in sources/inbox into sources/files and register
 * it as queued. Unsupported files are left in the inbox with a failed entry so
 * the user sees why. Returns the new entries.
 */
export function claimInbox(kbRoot: string, now = new Date(), uploadedBy?: string): ManifestEntry[] {
  ensureKbFolders(kbRoot)
  const inbox = path.join(kbRoot, 'sources/inbox')
  const entries = readManifest(kbRoot)
  const added: ManifestEntry[] = []
  const day = now.toISOString().slice(0, 10)
  for (const name of fs.readdirSync(inbox).sort()) {
    const from = path.join(inbox, name)
    if (name.startsWith('.') || !fs.statSync(from).isFile()) continue
    const safe = safeFileName(name)
    const ext = path.extname(safe)
    const stem = slugify(path.basename(safe, ext))
    let id = `${day}-${stem}`
    for (let i = 2; entries.some(e => e.id === id); i++) id = `${day}-${stem}-${i}`
    const kind = kindForFile(safe)
    if (!kind) {
      if (!entries.some(e => e.status === 'failed' && e.file_name === name && e.stored === `sources/inbox/${name}`)) {
        const e: ManifestEntry = { id, file_name: name, stored: `sources/inbox/${name}`, kind: 'unsupported', status: 'failed', uploaded_at: now.toISOString(), error: `Can't read ${ext || 'this kind of'} files yet — save it as .xlsx, .csv, .pdf, .docx or .txt and upload again.`, uploaded_by: uploadedBy }
        entries.push(e); added.push(e)
      }
      continue
    }
    const stored = `sources/files/${id}${ext.toLowerCase()}`
    fs.renameSync(from, path.join(kbRoot, stored))
    const e: ManifestEntry = { id, file_name: name, stored, kind, status: 'queued', uploaded_at: now.toISOString(), uploaded_by: uploadedBy }
    entries.push(e)
    added.push(e)
  }
  writeManifest(kbRoot, entries)
  return added
}

/** Spreadsheets with 2+ tabs and real size are split into up to this many parallel AI calls. */
export const MAX_PARALLEL_PARTS = 4
const SPLIT_MIN_CHARS = 4000

/**
 * Split a multi-tab spreadsheet into groups of whole tabs of roughly equal
 * size. Every other file (and small workbooks) is one part.
 */
export function splitForOrganize(ex: Extracted): Extracted[] {
  if (ex.kind !== 'spreadsheet' || (ex.sheets?.length ?? 0) < 2 || ex.markdown.length < SPLIT_MIN_CHARS) return [ex]
  const sections = ex.markdown.split(/(?=^## Sheet: )/m).filter(s => s.trim())
  if (sections.length < 2) return [ex]
  const groups = Math.min(MAX_PARALLEL_PARTS, sections.length)
  const target = ex.markdown.length / groups
  const out: string[][] = [[]]
  let size = 0
  for (const sec of sections) {
    if (size > 0 && size + sec.length > target && out.length < groups) { out.push([]); size = 0 }
    out[out.length - 1].push(sec)
    size += sec.length
  }
  return out.map(g => ({
    ...ex,
    markdown: g.join('\n\n').trim(),
    sheets: g.map(sec => sec.match(/^## Sheet: (.*)$/m)?.[1] ?? '').filter(Boolean),
  }))
}

/** Combine the parts of one file back into a single organized document. */
export function mergeOrganized(docs: OrganizedDocument[]): OrganizedDocument {
  if (docs.length === 1) return docs[0]
  return {
    title: docs.find(d => d.title)?.title,
    summary: docs.map(d => d.summary?.trim()).filter(Boolean).join(' '),
    entities: docs.flatMap(d => d.entities ?? []),
  }
}

const RECONCILE_SYSTEM = [
  'You match names. You get a list of organizations, people, projects, products and topics that were pulled from different tabs of ONE spreadsheet, plus names already in the knowledge base.',
  'Group names that clearly refer to the SAME thing (spelling variants, abbreviations, legal suffixes, a short form of a longer name, a code name used for the same project). Only group within the same type. When unsure, do not group.',
  'Reply with ONE JSON object and nothing else: {"same": [{"type": "organization", "names": ["Name A", "Name B"]}]}. An empty list is fine.',
].join('\n')

/**
 * After a spreadsheet was read in parallel parts, one short AI call groups the
 * names the parts spelled differently ("Cobalt Creek HVAC" on one tab, "Cobalt
 * Creek Heating & Air Inc." on another), so they become ONE note. A failure
 * here is not fatal: the parts are still written, just less merged.
 */
export async function reconcileNames(doc: OrganizedDocument, existing: string[], llm: LlmCall): Promise<OrganizedDocument> {
  const listed = [...new Set(doc.entities.map(e => `${e.type}: ${e.name}`))]
  if (listed.length < 2) return doc
  let groups: Array<{ type: string; names: string[] }> = []
  try {
    const reply = await llm(RECONCILE_SYSTEM, [
      'NAMES FROM THIS FILE:', ...listed.map(n => `- ${n}`), '',
      existing.length ? `ALREADY IN THE KNOWLEDGE BASE:\n${existing.slice(0, 400).map(n => `- ${n}`).join('\n')}` : '',
    ].join('\n'))
    const start = reply.indexOf('{')
    const end = reply.lastIndexOf('}')
    const parsed = JSON.parse(reply.slice(start, end + 1)) as { same?: unknown }
    if (Array.isArray(parsed.same)) groups = parsed.same.filter((g): g is { type: string; names: string[] } => !!g && typeof g.type === 'string' && Array.isArray(g.names))
  } catch {
    return doc
  }
  return applyNameGroups(doc, groups, existing)
}

/** Rename every member of a group to one canonical name (an existing KB name if any, else the longest). */
export function applyNameGroups(doc: OrganizedDocument, groups: Array<{ type: string; names: string[] }>, existing: string[]): OrganizedDocument {
  const rename = new Map<string, string>()
  const known = new Set(existing)
  for (const g of groups) {
    const names = g.names.filter(n => typeof n === 'string' && n.trim())
    if (names.length < 2) continue
    const canonical = names.find(n => known.has(`${g.type}: ${n}`)) ?? [...names].sort((a, b) => b.length - a.length)[0]
    for (const n of names) if (n !== canonical) rename.set(`${g.type}:${n}`, canonical)
  }
  if (!rename.size) return doc
  const to = (type: string, name: string) => rename.get(`${type}:${name}`) ?? name
  return {
    ...doc,
    entities: doc.entities.map(e => {
      const name = to(e.type, e.name)
      return {
        ...e,
        name,
        aliases: name !== e.name ? [...(e.aliases ?? []), e.name] : e.aliases,
        related: e.related?.map(r => ({ ...r, name: to(r.type, r.name) })),
      }
    }),
  }
}

export function buildOrganizePrompt(fileName: string, ex: Extracted, existingNames: string[], part?: { index: number; of: number }): { prompt: string; truncated: boolean } {
  let content = ex.markdown
  const truncated = content.length > MAX_PROMPT_CHARS
  if (truncated) content = content.slice(0, MAX_PROMPT_CHARS)
  const known = existingNames.slice(0, 400)
  const prompt = [
    `FILE: ${fileName}`,
    `TYPE: ${ex.kind}${ex.sheets ? ` (tabs: ${ex.sheets.join(', ')})` : ''}${ex.pages ? ` (${ex.pages} pages)` : ''}`,
    part ? `PART ${part.index} of ${part.of}: only the tabs listed above are included. Other parts of this file are read separately; file every row you see here, and describe only these tabs in "summary".` : '',
    '',
    known.length
      ? `NOTES THAT ALREADY EXIST in this knowledge base (reuse these exact names when the file talks about the same thing):\n${known.map(n => `- ${n}`).join('\n')}`
      : 'The knowledge base is empty so far.',
    '',
    truncated ? `NOTE: the file is long; only the first ${MAX_PROMPT_CHARS} characters are included below.\n` : '',
    '<<<FILE CONTENT',
    content,
    'FILE CONTENT>>>',
    '',
    'Return ONLY the JSON object described in your instructions.',
  ].join('\n')
  return { prompt, truncated }
}

/** Find the JSON object in a model reply that carries an "entities" list (tolerates ``` fences, chatter, stray braces). */
export function parseOrganizeReply(text: string): OrganizedDocument {
  let sawJson = false
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = balancedEnd(text, start)
    if (end < 0) continue
    let doc: OrganizedDocument
    try { doc = JSON.parse(text.slice(start, end + 1)) as OrganizedDocument } catch { continue }
    sawJson = true
    if (doc && Array.isArray(doc.entities)) return doc
  }
  throw new Error(sawJson ? 'the AI reply had no "entities" list' : 'the AI reply contained no JSON')
}

function balancedEnd(text: string, start: number): number {
  let depth = 0
  let inStr = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
  }
  return -1
}

/** One organize call, retried once with a reminder when the reply is not the JSON we asked for. */
async function organizePart(llm: LlmCall, system: string, prompt: string): Promise<OrganizedDocument> {
  const reply = await llm(system, prompt)
  try {
    return parseOrganizeReply(reply)
  } catch {
    return parseOrganizeReply(await llm(system, `${prompt}\n\nIMPORTANT: your previous reply was not usable. Reply with ONLY the JSON object {"title": …, "summary": …, "entities": [ … ]} — no other text.`))
  }
}

export interface IngestDeps {
  llm: LlmCall
  /** Librarian instructions (the pack's agent persona). */
  systemPrompt: string
  now?: () => Date
}

/** Read, organize and write one queued file. Never throws; failures land in the manifest. */
export async function ingestOne(kbRoot: string, id: string, deps: IngestDeps): Promise<ManifestEntry | undefined> {
  const now = deps.now ?? (() => new Date())
  const entry = readManifest(kbRoot).find(e => e.id === id)
  if (!entry) return undefined
  try {
    updateEntry(kbRoot, id, { status: 'reading', error: undefined })
    const buf = fs.readFileSync(path.join(kbRoot, entry.stored))
    const ex = extractDocument(entry.stored, buf)
    const warnings = [...ex.warnings]
    if (!ex.markdown.trim()) {
      return updateEntry(kbRoot, id, { status: 'failed', finished_at: now().toISOString(), warnings, error: warnings[0] ?? 'No text could be read from this file.' })
    }

    updateEntry(kbRoot, id, { status: 'organizing', warnings })
    const existing = loadEntityIndex(kbRoot).all.map(e => `${e.type}: ${e.name}`)
    // Multi-tab spreadsheets are organized one group of tabs per AI call, in
    // parallel: the time goes into WRITING one note per row, so splitting the
    // output is what makes a 5-tab tracker take ~1 minute instead of ~5.
    const parts = splitForOrganize(ex)
    const docs = await Promise.all(parts.map(async (part, i) => {
      const { prompt, truncated } = buildOrganizePrompt(entry.file_name, part, existing, parts.length > 1 ? { index: i + 1, of: parts.length } : undefined)
      if (truncated) warnings.push(`File is very long — only the first ${MAX_PROMPT_CHARS.toLocaleString('en-US')} characters were organized. The full text is still in the source note.`)
      return organizePart(deps.llm, deps.systemPrompt, prompt)
    }))
    let doc = mergeOrganized(docs)
    if (docs.length > 1) doc = await reconcileNames(doc, existing, deps.llm)

    const src: SourceInfo = { id, fileName: entry.file_name, storedRel: entry.stored, kind: ex.kind, ingestedAt: now().toISOString() }
    const res = writeOrganized(kbRoot, src, doc, ex.markdown, warnings)
    return updateEntry(kbRoot, id, {
      status: 'done',
      finished_at: now().toISOString(),
      notes: [...new Set(res.notes.map(n => n.rel))],
      source_note: res.sourceNoteRel,
      warnings,
    })
  } catch (err) {
    return updateEntry(kbRoot, id, { status: 'failed', finished_at: now().toISOString(), error: err instanceof Error ? err.message : String(err) })
  }
}

/** Put a finished or failed file back in the queue so it is read again. */
export function requeue(kbRoot: string, id: string): ManifestEntry | undefined {
  const e = readManifest(kbRoot).find(x => x.id === id)
  if (!e || e.kind === 'unsupported' || e.status === 'reading' || e.status === 'organizing') return undefined
  return updateEntry(kbRoot, id, { status: 'queued', error: undefined, finished_at: undefined })
}

// ── Per-knowledge-base serial queue ──────────────────────────────────────────
// One file at a time per KB: the merge step reads the notes the previous file
// wrote, so parallel runs would race on the same organization/person notes.

const chains = new Map<string, Promise<void>>()

export function drainQueue(kbRoot: string, deps: IngestDeps): Promise<void> {
  const prev = chains.get(kbRoot) ?? Promise.resolve()
  const next = prev.then(async () => {
    for (;;) {
      const queued = readManifest(kbRoot).find(e => e.status === 'queued')
      if (!queued) return
      await ingestOne(kbRoot, queued.id, deps)
    }
  })
  const settled = next.catch(() => undefined)
  chains.set(kbRoot, settled)
  void settled.then(() => { if (chains.get(kbRoot) === settled) chains.delete(kbRoot) })
  return next
}

/** True while this process is working through a KB's queue. */
export function isDraining(kbRoot: string): boolean {
  return chains.has(kbRoot)
}

/**
 * After a restart, anything left mid-flight ('reading'/'organizing') was
 * interrupted. Put it back in the queue so the next drain picks it up.
 */
export function recoverInterrupted(kbRoot: string): number {
  const entries = readManifest(kbRoot)
  let n = 0
  for (const e of entries) if (e.status === 'reading' || e.status === 'organizing') { e.status = 'queued'; n++ }
  if (n) writeManifest(kbRoot, entries)
  return n
}
