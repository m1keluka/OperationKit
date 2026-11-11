import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ENTITY_TYPES, FOLDER_FOR, cleanRelationLabel, loadEntityIndex, notePathFor, relLink, slugify, upsertEntityNote, type Entity, type EntityType, type SourceRef } from '../doc-ingest/notes.js'
import { safeFileName } from '../doc-ingest/ingest.js'
import type { LlmCall } from '../doc-ingest/llm.js'
import {
  conversationChars, detectImportKind, parseChatGptExport, parseClaudeExport, parseTranscript, renderConversationMarkdown,
  type ConversationOrigin, type ParsedConversation,
} from './conversations.js'
import { CONVERSATION_SOURCES_DIR, GENERATED_BY, IMPORTS_STATE_DIR, RAW_CALLS_DIR, RAW_CHATS_DIR, ensureKbGitignore } from './paths.js'
import { appendLog, compileWiki, wikilink } from './wiki.js'
import { wikiLlm } from './llm.js'

/**
 * Chat-export and call-transcript imports (obj 720117).
 *
 *   upload  →  raw/chat-exports/<job>-<file> or raw/calls/<job>-<file>   (kept byte-for-byte, never edited)
 *           →  .kb-wiki/imports/<job>/                                     (job state; one JSON file per chat)
 *           →  person picks which chats to import                          ('review')
 *           →  background worker, a few chats per AI call                  ('running', pausable, resumable)
 *           →  sources/conversations/<job>/<key>-<title>.md + entity pages + log entry
 *
 * State on disk, so a restart resumes where it stopped:
 *   job.json        metadata + counts only (small, rewritten often)
 *   items.json      one short row per chat (title, date, status, selected …)
 *   items/<key>.json the parsed chat itself, written once at upload
 * Memory stays flat for a huge export: the worker loads only the chats in the
 * batch it is working on.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type ImportJobKind = 'claude-export' | 'chatgpt-export' | 'transcripts'
export type ImportJobStatus = 'review' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
export type ImportItemStatus = 'pending' | 'queued' | 'working' | 'done' | 'skipped' | 'failed'

export interface ImportItem {
  key: string
  title: string
  started_at?: string
  participants: string[]
  message_count: number
  chars: number
  /** First ~200 characters, so a person can recognise the chat. */
  preview: string
  selected: boolean
  status: ImportItemStatus
  /** KB-relative path of the readable copy, once imported. */
  source_note?: string
  /** Entity pages this chat wrote to. */
  pages?: string[]
  skip_reason?: string
  error?: string
}

export interface ImportCounts {
  total: number
  selected: number
  pending: number
  queued: number
  working: number
  done: number
  skipped: number
  failed: number
}

export interface ImportJob {
  id: string
  kind: ImportJobKind
  label: string
  /** KB-relative paths of the untouched originals. */
  raw_files: string[]
  created_at: string
  created_by?: string
  status: ImportJobStatus
  error?: string
  items: ImportItem[]
  counts: ImportCounts
  started_at?: string
  finished_at?: string
}

/** What job.json holds (and what listImports returns): everything but the item rows. */
export type ImportJobSummary = Omit<ImportJob, 'items'>

export interface ImportDeps {
  llm: LlmCall
  now?: () => Date
}

export interface ItemFilter {
  /** Case-insensitive text match on title, participants and preview. */
  q?: string
  /** Inclusive dates (YYYY-MM-DD or ISO), compared with the chat's start date. */
  from?: string
  to?: string
  status?: ImportItemStatus
  min_messages?: number
}

interface StoredConversation {
  raw_file: string
  conversation: ParsedConversation
}

export class ImportNotFoundError extends Error {}

// ── Limits ───────────────────────────────────────────────────────────────────

/** Most chats sent to the AI in one call. */
export const MAX_BATCH_CONVERSATIONS = 8
/** Most characters of chat text sent in one call (a single bigger chat goes alone). */
export const MAX_BATCH_CHARS = 40_000
/** A chat longer than this is cut into parts, read one part per call, and merged. */
export const MAX_CONVERSATION_CHARS = 120_000
/** Size of each part when a chat is cut up. */
export const PART_CHARS = 100_000
/** The readable copy keeps this much of the chat text. */
export const MAX_SOURCE_NOTE_CHARS = 200_000
/** Rebuild index + backlinks after this many batches, so pages appear while a long import runs. */
export const COMPILE_EVERY_BATCHES = 10
/** Stop a job (status 'failed') after this many batches in a row fail outright — e.g. the AI is unreachable. */
const MAX_CONSECUTIVE_FAILED_BATCHES = 3

const ORIGIN_LABEL: Record<ConversationOrigin, string> = { claude: 'Claude chat', chatgpt: 'ChatGPT chat', call: 'Call' }

// ── Disk helpers ─────────────────────────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const KEY_RE = /^c\d{4,}$/

function importsRoot(kb: string): string {
  return path.join(kb, IMPORTS_STATE_DIR)
}

function jobDir(kb: string, id: string): string {
  if (!ID_RE.test(id)) throw new ImportNotFoundError('That import was not found.')
  return path.join(importsRoot(kb), id)
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return null }
}

function readMeta(kb: string, id: string): ImportJobSummary {
  const meta = readJson<ImportJobSummary>(path.join(jobDir(kb, id), 'job.json'))
  if (!meta) throw new ImportNotFoundError('That import was not found.')
  return meta
}

function readItems(kb: string, id: string): ImportItem[] {
  return readJson<ImportItem[]>(path.join(jobDir(kb, id), 'items.json')) ?? []
}

function countItems(items: ImportItem[]): ImportCounts {
  const c: ImportCounts = { total: items.length, selected: 0, pending: 0, queued: 0, working: 0, done: 0, skipped: 0, failed: 0 }
  for (const i of items) {
    if (i.selected) c.selected++
    c[i.status]++
  }
  return c
}

/** Persist item rows and the job's counts together (sync — nothing interleaves in between). */
function saveJob(kb: string, meta: ImportJobSummary, items?: ImportItem[]): ImportJobSummary {
  const dir = jobDir(kb, meta.id)
  if (items) {
    writeJsonAtomic(path.join(dir, 'items.json'), items)
    meta.counts = countItems(items)
  }
  writeJsonAtomic(path.join(dir, 'job.json'), meta)
  return meta
}

function readStored(kb: string, id: string, key: string): StoredConversation {
  if (!KEY_RE.test(key)) throw new Error(`bad chat key ${key}`)
  const s = readJson<StoredConversation>(path.join(jobDir(kb, id), 'items', `${key}.json`))
  if (!s) throw new Error('The saved copy of this chat is missing. Upload the export again.')
  return s
}

// ── Creating an import ───────────────────────────────────────────────────────

export interface ImportFile {
  /** Original upload name. */
  name: string
  path?: string
  buffer?: Buffer
}

function previewOf(c: ParsedConversation): string {
  const text = c.messages.length ? c.messages.slice(0, 3).map(m => `${m.speaker}: ${m.text}`).join(' · ') : (c.notes ?? '')
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat
}

function itemFor(c: ParsedConversation): ImportItem {
  return {
    key: c.key,
    title: c.title,
    started_at: c.started_at,
    participants: c.participants,
    message_count: c.messages.length,
    chars: conversationChars(c),
    preview: previewOf(c),
    selected: true,
    status: 'pending',
  }
}

function newJobId(kb: string, day: string, tag: string): string {
  let id = `${day}-${tag}`
  for (let i = 2; fs.existsSync(path.join(importsRoot(kb), id)); i++) id = `${day}-${tag}-${i}`
  return id
}

const UNKNOWN_FILE = 'is not a chat export or call transcript we can read. Upload a Claude or ChatGPT export (.zip), or a call transcript (.vtt, .srt, .txt, .docx, .md or .json).'

/**
 * Register uploaded files as imports in 'review' (nothing is sent to the AI
 * yet). Each export .zip becomes its own job; all transcript files in one call
 * become one 'transcripts' job. Every file is checked before anything is
 * written, so one bad file fails the whole upload cleanly.
 */
export function createImport(kb: string, files: ImportFile[], opts: { by?: string; now?: Date } = {}): ImportJob[] {
  if (!files.length) throw new Error('No files were uploaded.')
  const now = opts.now ?? new Date()
  type Group = { kind: ImportJobKind; files: Array<{ name: string; buf: Buffer; convs: ParsedConversation[] }> }
  const groups: Group[] = []
  let calls: Group | null = null
  for (const f of files) {
    const buf = f.buffer ?? (f.path ? fs.readFileSync(f.path) : null)
    if (!buf) throw new Error(`${f.name}: no file content was received.`)
    const kind = detectImportKind(f.name, buf)
    if (!kind) throw new Error(`${f.name} ${UNKNOWN_FILE}`)
    if (kind === 'transcript') {
      const convs = parseTranscript(f.name, buf)
      if (!calls) { calls = { kind: 'transcripts', files: [] }; groups.push(calls) }
      calls.files.push({ name: f.name, buf, convs })
    } else {
      const convs = kind === 'claude-export' ? parseClaudeExport(buf) : parseChatGptExport(buf)
      if (!convs.length) throw new Error(`${f.name} has no chats with any text in them.`)
      groups.push({ kind, files: [{ name: f.name, buf, convs }] })
    }
  }

  const day = now.toISOString().slice(0, 10)
  const jobs: ImportJob[] = []
  for (const g of groups) {
    const tag = g.kind === 'claude-export' ? 'claude' : g.kind === 'chatgpt-export' ? 'chatgpt' : 'calls'
    const id = newJobId(kb, day, tag)
    const dir = jobDir(kb, id)
    fs.mkdirSync(path.join(dir, 'items'), { recursive: true })
    ensureKbGitignore(kb)
    const rawDir = g.kind === 'transcripts' ? RAW_CALLS_DIR : RAW_CHATS_DIR
    fs.mkdirSync(path.join(kb, rawDir), { recursive: true })

    const items: ImportItem[] = []
    const rawFiles: string[] = []
    let n = 0
    for (const file of g.files) {
      let rawRel = `${rawDir}/${id}-${safeFileName(file.name)}`
      for (let i = 2; rawFiles.includes(rawRel) || fs.existsSync(path.join(kb, rawRel)); i++) rawRel = `${rawDir}/${id}-${i}-${safeFileName(file.name)}`
      fs.writeFileSync(path.join(kb, rawRel), file.buf, { flag: 'wx' })
      rawFiles.push(rawRel)
      for (const c0 of file.convs) {
        const c: ParsedConversation = { ...c0, key: `c${String(++n).padStart(4, '0')}` }
        writeJsonAtomic(path.join(dir, 'items', `${c.key}.json`), { raw_file: rawRel, conversation: c } satisfies StoredConversation)
        items.push(itemFor(c))
      }
    }
    const label = g.kind === 'claude-export' ? `Claude chats (${g.files[0].name})`
      : g.kind === 'chatgpt-export' ? `ChatGPT chats (${g.files[0].name})`
        : g.files.length === 1 ? `Call: ${g.files[0].name}` : `${g.files.length} call transcripts`
    const meta: ImportJobSummary = {
      id,
      kind: g.kind,
      label,
      raw_files: rawFiles,
      created_at: now.toISOString(),
      created_by: opts.by,
      status: 'review',
      counts: countItems(items),
    }
    saveJob(kb, meta, items)
    jobs.push({ ...meta, items })
  }
  return jobs
}

// ── Reading + selecting ──────────────────────────────────────────────────────

/** Every import in this KB, newest first (no item rows — use listItems for those). */
export function listImports(kb: string): ImportJobSummary[] {
  let ids: string[] = []
  try { ids = fs.readdirSync(importsRoot(kb)).filter(n => ID_RE.test(n)) } catch { return [] }
  const out: ImportJobSummary[] = []
  for (const id of ids) {
    const meta = readJson<ImportJobSummary>(path.join(importsRoot(kb), id, 'job.json'))
    if (meta) out.push(meta)
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
}

export function getImport(kb: string, id: string): ImportJob {
  const meta = readMeta(kb, id)
  return { ...meta, items: readItems(kb, id) }
}

function dayOf(s: string): string {
  return s.slice(0, 10)
}

export function itemMatches(item: ImportItem, f: ItemFilter): boolean {
  if (f.status && item.status !== f.status) return false
  if (f.min_messages !== undefined && item.message_count < f.min_messages) return false
  if (f.from || f.to) {
    if (!item.started_at) return false
    const d = dayOf(item.started_at)
    if (f.from && d < dayOf(f.from)) return false
    if (f.to && d > dayOf(f.to)) return false
  }
  if (f.q?.trim()) {
    const hay = `${item.title}\n${item.participants.join(' ')}\n${item.preview}`.toLowerCase()
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t))) return false
  }
  return true
}

/** One page of a job's chats matching the filter. */
export function listItems(kb: string, id: string, f: ItemFilter & { offset?: number; limit?: number } = {}): { items: ImportItem[]; total: number } {
  readMeta(kb, id)
  const all = readItems(kb, id).filter(i => itemMatches(i, f))
  const offset = Math.max(0, Math.floor(f.offset ?? 0))
  const limit = Math.min(1000, Math.max(1, Math.floor(f.limit ?? 100)))
  return { items: all.slice(offset, offset + limit), total: all.length }
}

/**
 * Tick or untick chats, by key or by "everything matching this filter". While
 * the job runs, ticking a waiting chat queues it and unticking a queued one
 * takes it out of the queue.
 */
export function selectItems(kb: string, id: string, sel: { keys?: string[]; all_matching?: ItemFilter; selected: boolean }): { changed: number; counts: ImportCounts } {
  const meta = readMeta(kb, id)
  const items = readItems(kb, id)
  const keys = sel.keys ? new Set(sel.keys) : null
  let changed = 0
  for (const it of items) {
    const hit = keys ? keys.has(it.key) : sel.all_matching ? itemMatches(it, sel.all_matching) : false
    if (!hit || it.status === 'working') continue
    if (it.selected !== sel.selected) { it.selected = sel.selected; changed++ }
    if (meta.status === 'running') {
      if (sel.selected && it.status === 'pending') it.status = 'queued'
      if (!sel.selected && it.status === 'queued') it.status = 'pending'
    }
  }
  saveJob(kb, meta, items)
  return { changed, counts: meta.counts }
}

// ── Job control ──────────────────────────────────────────────────────────────

function defaultDeps(deps?: Partial<ImportDeps>): ImportDeps {
  return { llm: deps?.llm ?? wikiLlm(), now: deps?.now }
}

/** Queue every ticked chat that has not been imported yet (or failed) and start the background worker. */
export function startImport(kb: string, id: string, deps?: Partial<ImportDeps>): ImportJobSummary {
  const meta = readMeta(kb, id)
  const items = readItems(kb, id)
  for (const it of items) {
    if (it.selected && (it.status === 'pending' || it.status === 'failed')) { it.status = 'queued'; it.error = undefined }
  }
  // An unticked chat is never work, whatever its status says.
  for (const it of items) if (!it.selected && it.status === 'queued') it.status = 'pending'
  if (meta.status !== 'running' && !items.some(i => i.status === 'queued' && i.selected)) {
    throw new Error(items.some(i => i.selected) ? 'Every ticked chat has already been imported.' : 'Tick at least one chat to import.')
  }
  const now = (deps?.now ?? (() => new Date()))()
  meta.status = 'running'
  meta.started_at = meta.started_at ?? now.toISOString()
  meta.finished_at = undefined
  meta.error = undefined
  saveJob(kb, meta, items)
  void runImportWorker(kb, defaultDeps(deps)).catch(() => undefined)
  return meta
}

/** Stop after the batch in flight. Chats still waiting stay queued; start again to continue. */
export function pauseImport(kb: string, id: string): ImportJobSummary {
  const meta = readMeta(kb, id)
  if (meta.status !== 'running') return meta
  meta.status = 'paused'
  return saveJob(kb, meta)
}

/** Stop and un-queue the rest. Pages already written stay; the raw upload is never deleted. */
export function cancelImport(kb: string, id: string): ImportJobSummary {
  const meta = readMeta(kb, id)
  const items = readItems(kb, id)
  for (const it of items) if (it.status === 'queued') it.status = 'pending'
  if (meta.status !== 'done') meta.status = 'cancelled'
  return saveJob(kb, meta, items)
}

/** Boot: a chat left 'working' was interrupted mid-call — queue it again, and restart running jobs. */
export function resumeImports(kb: string, deps?: Partial<ImportDeps>): number {
  let running = 0
  for (const meta of listImports(kb)) {
    const items = readItems(kb, meta.id)
    let touched = false
    for (const it of items) if (it.status === 'working') { it.status = 'queued'; touched = true }
    if (touched) saveJob(kb, meta, items)
    if (meta.status === 'running') running++
  }
  if (running) void runImportWorker(kb, defaultDeps(deps)).catch(() => undefined)
  return running
}

/**
 * Wiki rebuild: every imported chat is read again. Finished jobs go back to
 * running; paused/cancelled ones keep their state until someone restarts them.
 * Returns how many chats were queued. The caller starts the worker.
 */
export function requeueAllImports(kb: string): number {
  let n = 0
  for (const meta of listImports(kb)) {
    const items = readItems(kb, meta.id)
    let touched = 0
    for (const it of items) if (it.status === 'done') { it.status = 'queued'; it.source_note = undefined; it.pages = undefined; touched++ }
    if (!touched) continue
    if (meta.status === 'done') { meta.status = 'running'; meta.finished_at = undefined }
    saveJob(kb, meta, items)
    n += touched
  }
  return n
}

// ── The AI step ──────────────────────────────────────────────────────────────

function typeHint(re: RegExp): string | undefined {
  return (ENTITY_TYPES as readonly string[]).find(t => re.test(t))
}

/** Instructions for the extraction call. Generic: any kind of business or team. */
export function extractionSystemPrompt(): string {
  const types = ENTITY_TYPES.map(t => `"${t}" (filed under ${FOLDER_FOR[t]}/)`).join(', ')
  const person = typeHint(/person|people/) ?? ENTITY_TYPES[0]
  const general = typeHint(/topic/) ?? ENTITY_TYPES[ENTITY_TYPES.length - 1]
  return [
    'You are the librarian of a knowledge base for a business or team. You read exported AI chats and call transcripts and pull out the business knowledge in them, so it can be filed as linked wiki pages. Do not assume any particular industry.',
    '',
    'For EACH conversation you are given, first decide: does it contain real knowledge about this business — a decision, a plan, a fact about the organisation, its people, customers, suppliers, products, prices, places or dates, or a to-do?',
    '- If NOT — small talk, jokes, trivia, personal chit-chat, a one-off creative task, or general coding / how-to help with no fact about the business — reply with "skip": true and a short plain "skip_reason" such as "small talk" or "general coding help, no business facts". Never invent facts to avoid a skip.',
    '- Otherwise extract:',
    '  * decisions: what was decided (and by whom, if said);',
    '  * todos: what someone agreed to do, with "owner" and "due" when they are stated;',
    `  * entities: the people, organisations and subjects the knowledge is about. Allowed types: ${types}. Use "${person}" for people; use "${general}" when nothing else fits. Each entity gets a one-sentence "summary" and short "facts".`,
    '',
    'Citations: every fact, decision and to-do needs a "where" that points into the conversation — the message number and speaker for chats ("message 4, You"), the time and speaker for calls ("~12:30, Dana Ruiz"). Use the numbers and times shown in [brackets].',
    '',
    'Rules:',
    '- Use only what the conversation says. No outside knowledge, no guesses.',
    '- In a chat with an AI assistant, facts come from what the person ("You") states or confirms. An assistant suggestion counts only if the person accepted it.',
    '- Keep each fact short and self-contained (name its subject). One fact per item.',
    '- Never make an entity for the AI assistant ("Claude", "ChatGPT") or for "You". When the person says "I" and their name is not given, attach the fact to the organisation or subject instead.',
    '- Reuse the exact names listed under NAMES ALREADY IN THE KNOWLEDGE BASE when they mean the same thing.',
    '- "about" on a decision or to-do lists the entities it concerns ({"type", "name"}).',
    '- "related" links an entity to others the conversation connects it to. Add a short "label" only when the conversation states the relationship, read as "<this entity> <label> <related entity>" — e.g. "works for", "supplier of", "customer of", "owns", "manages". Leave "label" out when unsure.',
    '',
    'Reply with ONE JSON object and nothing else, including every conversation key you were given exactly once:',
    '{"conversations": [{"key": "c0001", "skip": false, "skip_reason": "", "title": "short descriptive title", "summary": "two or three plain sentences",',
    ' "decisions": [{"decision": "…", "where": "message 4, You", "about": [{"type": "…", "name": "…"}]}],',
    ' "todos": [{"todo": "…", "owner": "…", "due": "…", "where": "…", "about": [{"type": "…", "name": "…"}]}],',
    ' "entities": [{"type": "…", "name": "…", "aliases": [], "summary": "…", "facts": [{"fact": "…", "where": "…"}], "related": [{"type": "…", "name": "…", "label": "works for"}]}]}]}',
  ].join('\n')
}

interface EntityRefIn { type: string; name: string }

export interface ExtractedConversation {
  key: string
  skip: boolean
  skip_reason?: string
  title?: string
  summary?: string
  decisions: Array<{ decision: string; where?: string; about?: EntityRefIn[] }>
  todos: Array<{ todo: string; owner?: string; due?: string; where?: string; about?: EntityRefIn[] }>
  entities: Entity[]
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function refs(v: unknown): EntityRefIn[] {
  return Array.isArray(v) ? v.filter(r => r && typeof r.type === 'string' && typeof r.name === 'string' && r.name.trim()) : []
}

function cleanExtracted(raw: unknown): ExtractedConversation | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const key = str(o.key)
  if (!key) return null
  return {
    key,
    skip: o.skip === true,
    skip_reason: str(o.skip_reason),
    title: str(o.title),
    summary: str(o.summary),
    decisions: Array.isArray(o.decisions) ? o.decisions.flatMap(d => (d && str(d.decision) ? [{ decision: str(d.decision)!, where: str(d.where), about: refs(d.about) }] : [])) : [],
    todos: Array.isArray(o.todos) ? o.todos.flatMap(t => (t && str(t.todo) ? [{ todo: str(t.todo)!, owner: str(t.owner), due: str(t.due), where: str(t.where), about: refs(t.about) }] : [])) : [],
    entities: Array.isArray(o.entities) ? (o.entities as Entity[]) : [],
  }
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

/** Find the JSON object with a "conversations" list in a model reply (tolerates fences and chatter). */
export function parseExtractReply(text: string): ExtractedConversation[] {
  let sawJson = false
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = balancedEnd(text, start)
    if (end < 0) continue
    let v: { conversations?: unknown }
    try { v = JSON.parse(text.slice(start, end + 1)) as { conversations?: unknown } } catch { continue }
    sawJson = true
    if (v && Array.isArray(v.conversations)) return v.conversations.map(cleanExtracted).filter((x): x is ExtractedConversation => !!x)
  }
  throw new Error(sawJson ? 'the AI reply had no "conversations" list' : 'the AI reply contained no JSON')
}

async function callExtract(llm: LlmCall, prompt: string): Promise<ExtractedConversation[]> {
  const system = extractionSystemPrompt()
  const reply = await llm(system, prompt)
  try {
    return parseExtractReply(reply)
  } catch {
    return parseExtractReply(await llm(system, `${prompt}\n\nIMPORTANT: your previous reply was not usable. Reply with ONLY the JSON object {"conversations": [ … ]} — no other text.`))
  }
}

interface PromptPart {
  c: ParsedConversation
  /** Message index range [from, to) and which part this is, for a chat that was cut up. */
  from: number
  to: number
  part?: { index: number; of: number }
}

/** Cut a long chat at message boundaries (a single giant message is sliced). */
export function splitConversation(c: ParsedConversation, maxChars = PART_CHARS): PromptPart[] {
  const msgs: ParsedConversation['messages'] = []
  for (const m of c.messages) {
    if (m.text.length <= maxChars) { msgs.push(m); continue }
    for (let i = 0; i < m.text.length; i += maxChars) msgs.push({ ...m, text: m.text.slice(i, i + maxChars) })
  }
  const cut: ParsedConversation = { ...c, messages: msgs }
  const ranges: Array<[number, number]> = []
  let start = 0
  let size = c.notes?.length ?? 0
  msgs.forEach((m, i) => {
    const len = m.text.length + m.speaker.length + 12
    if (i > start && size + len > maxChars) { ranges.push([start, i]); start = i; size = 0 }
    size += len
  })
  ranges.push([start, msgs.length])
  return ranges.map(([from, to], i) => ({ c: cut, from, to, part: ranges.length > 1 ? { index: i + 1, of: ranges.length } : undefined }))
}

function renderForPrompt(p: PromptPart): string {
  const { c } = p
  const lines = [
    `=== CONVERSATION ${c.key} ===`,
    `Kind: ${ORIGIN_LABEL[c.origin]}`,
    `Title: ${c.title}`,
  ]
  if (c.started_at) lines.push(`Date: ${c.started_at.slice(0, 10)}`)
  if (c.participants.length) lines.push(`Participants: ${c.participants.join(', ')}`)
  if (p.part) lines.push(`PART ${p.part.index} of ${p.part.of} (messages ${p.from + 1}-${p.to}). The other parts are read separately; extract only from this part and use the same key.`)
  if (c.notes && (!p.part || p.part.index === 1)) lines.push('Notes:', c.notes)
  for (let i = p.from; i < p.to; i++) {
    const m = c.messages[i]
    const when = c.origin === 'call' && m.at ? `~${m.at}, ` : ''
    lines.push(`[${when}${c.origin === 'call' ? '' : `message ${i + 1}, `}${m.speaker}] ${m.text}`)
  }
  lines.push(`=== END ${c.key} ===`)
  return lines.join('\n')
}

function buildPrompt(parts: PromptPart[], knownNames: string[]): string {
  return [
    knownNames.length
      ? `NAMES ALREADY IN THE KNOWLEDGE BASE (reuse these exact names when a conversation means the same thing):\n${knownNames.map(n => `- ${n}`).join('\n')}`
      : 'No existing knowledge-base names are mentioned in these conversations.',
    '',
    `CONVERSATIONS (${parts.length}):`,
    '',
    parts.map(renderForPrompt).join('\n\n'),
    '',
    'Return ONLY the JSON object described in your instructions.',
  ].join('\n')
}

/** Merge the results for the parts of one long chat. */
function mergeParts(key: string, rs: ExtractedConversation[]): ExtractedConversation {
  return {
    key,
    skip: rs.every(r => r.skip),
    skip_reason: rs.find(r => r.skip_reason)?.skip_reason,
    title: rs.find(r => r.title)?.title,
    summary: rs.map(r => r.summary).filter(Boolean).join(' ') || undefined,
    decisions: rs.flatMap(r => r.decisions),
    todos: rs.flatMap(r => r.todos),
    entities: rs.flatMap(r => r.entities),
  }
}

// ── Writing pages ────────────────────────────────────────────────────────────

type EntityIndex = ReturnType<typeof loadEntityIndex>

const ASSISTANT_NAMES = new Set(['you', 'me', 'claude', 'chatgpt', 'chat gpt', 'assistant', 'the assistant', 'ai', 'gpt', 'gpt-4', 'openai assistant'])

function yamlStr(s: string): string {
  return /^[\w .,'()&/-]+$/.test(s) && !/^[-?:]/.test(s) && !/:\s/.test(s) ? s : JSON.stringify(s)
}

function yamlList(items: string[]): string {
  return `[${items.map(i => (/[,[\]{}]/.test(i) ? JSON.stringify(i) : yamlStr(i))).join(', ')}]`
}

function cleanEntity(raw: Entity): Entity | null {
  if (!raw || typeof raw !== 'object' || !(ENTITY_TYPES as readonly string[]).includes(raw.type) || typeof raw.name !== 'string' || !raw.name.trim()) return null
  const name = raw.name.trim().slice(0, 120)
  if (ASSISTANT_NAMES.has(name.toLowerCase())) return null
  return {
    type: raw.type,
    name,
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim()) : [],
    summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : undefined,
    facts: Array.isArray(raw.facts) ? raw.facts.filter(f => f && typeof f.fact === 'string' && f.fact.trim()).map(f => ({ fact: f.fact.trim(), where: typeof f.where === 'string' && f.where.trim() ? f.where.trim() : undefined })) : [],
    related: Array.isArray(raw.related)
      ? raw.related
        .filter(r => r && (ENTITY_TYPES as readonly string[]).includes(r.type) && typeof r.name === 'string' && r.name.trim() && !ASSISTANT_NAMES.has(r.name.trim().toLowerCase()))
        .map(r => ({ type: r.type, name: r.name, label: cleanRelationLabel(r.label) }))
      : [],
  }
}

function todoText(t: ExtractedConversation['todos'][number]): string {
  const extra = [t.owner, t.due ? `due ${t.due}` : undefined].filter(Boolean).join(', ')
  return `${t.todo}${extra ? ` — ${extra}` : ''}`
}

/** Escape what would read as wiki structure inside quoted chat text. */
function quoteSafe(md: string): string {
  return md.replace(/\[\[/g, '[\\[').replace(/^(#{1,6}\s)/gm, '\\$1').replace(/^---$/gm, '\\---')
}

function renderSourceNote(opts: {
  rel: string
  c: ParsedConversation
  rawFile: string
  jobId: string
  r: ExtractedConversation
  pages: Array<{ rel: string; title: string }>
  today: string
}): string {
  const { c, r } = opts
  const date = c.started_at?.slice(0, 10)
  const fm = [
    '---',
    `title: ${yamlStr(c.title)}`,
    'type: source',
    `origin: ${c.origin}`,
    ...(date ? [`date: ${date}`] : []),
    `participants: ${yamlList(c.participants)}`,
    ...(r.summary ? [`summary: ${JSON.stringify(r.summary.replace(/\s+/g, ' ').slice(0, 200))}`] : []),
    `raw_file: ${yamlStr(opts.rawFile)}`,
    `import_job: ${opts.jobId}`,
    'tags: [source, conversation]',
    `updated: ${opts.today}`,
    `generated_by: ${GENERATED_BY}`,
    '---',
  ].join('\n')
  const fallback = c.origin === 'call' ? 'whole call' : 'whole chat'
  const where = (w?: string) => ` *(${(w ?? fallback).replace(/\*/g, '')})*`
  const parts = [
    fm, '', `# ${c.title}`, '',
    `${ORIGIN_LABEL[c.origin]}${date ? ` · ${date}` : ''}${c.participants.length ? ` · ${c.participants.join(', ')}` : ''} · original: [${path.basename(opts.rawFile)}](${relLink(opts.rel, opts.rawFile)})`,
    '',
  ]
  if (r.summary) parts.push('## Summary', '', r.summary, '')
  if (r.decisions.length) parts.push('## Decisions', '', ...r.decisions.map(d => `- ${d.decision}${where(d.where)}`), '')
  if (r.todos.length) parts.push('## To-dos', '', ...r.todos.map(t => `- ${todoText(t)}${where(t.where)}`), '')
  if (opts.pages.length) parts.push('## Pages made from this conversation', '', ...opts.pages.map(p => `- ${wikilink(p.rel, p.title)}`), '')
  let body = renderConversationMarkdown(c)
  if (body.length > MAX_SOURCE_NOTE_CHARS) {
    body = `${body.slice(0, MAX_SOURCE_NOTE_CHARS)}\n\n*(The rest of this conversation is in the original file.)*`
  }
  parts.push('## Conversation', '', quoteSafe(body), '')
  return parts.join('\n')
}

/** "call-2026-09-21-weekly-ops" or "Untitled chat" says nothing; a title the AI wrote from the content does. */
export function displayTitle(parsed: string, fromAi?: string): string {
  const looksLikeFileName = !/\s/.test(parsed.trim()) && /[-_.]/.test(parsed)
  return (looksLikeFileName || /^untitled\b/i.test(parsed.trim())) && fromAi?.trim() ? fromAi.trim().slice(0, 120) : parsed
}

/**
 * Write the readable copy of one chat and fold what it says into entity pages.
 * Each chat owns one "## From: …" section per page, so importing it again
 * replaces its own section instead of duplicating it. `index` is the worker's
 * in-memory entity index — updated here, never rebuilt from disk per chat.
 */
export function writeConversation(kb: string, jobId: string, stored: StoredConversation, r: ExtractedConversation, index: EntityIndex, today: string): { source_note: string; pages: string[] } {
  // The page path keys on the parsed title so a re-import lands on the same page;
  // the shown title prefers the AI's when the parsed one is just a file name.
  const c = { ...stored.conversation, title: displayTitle(stored.conversation.title, r.title) }
  const noteRel = `${CONVERSATION_SOURCES_DIR}/${jobId}/${c.key}-${slugify(stored.conversation.title).slice(0, 60)}.md`
  const date = c.started_at?.slice(0, 10)
  const ref: SourceRef = { notePath: noteRel, filePath: stored.raw_file, fileName: `${ORIGIN_LABEL[c.origin]}: ${c.title}${date ? ` (${date})` : ''}` }
  const fallbackWhere = c.origin === 'call' ? 'whole call' : 'whole chat'

  const canonical = (type: EntityType, name: string) => index.find(type, name)?.name ?? name
  const byRel = new Map<string, Entity>()
  const add = (e0: Entity): Entity => {
    const name = canonical(e0.type, e0.name)
    const e: Entity = { ...e0, name, aliases: name !== e0.name ? [...(e0.aliases ?? []), e0.name] : e0.aliases, facts: [...e0.facts] }
    const rel = notePathFor(e.type, e.name)
    const prev = byRel.get(rel)
    if (prev) {
      const seen = new Set(prev.facts.map(f => f.fact))
      prev.facts.push(...e.facts.filter(f => !seen.has(f.fact)))
      prev.aliases = [...new Set([...(prev.aliases ?? []), ...(e.aliases ?? [])])].filter(a => a !== prev.name)
      prev.related = [...(prev.related ?? []), ...(e.related ?? [])]
      prev.summary = prev.summary || e.summary
      return prev
    }
    byRel.set(rel, e)
    return e
  }
  for (const raw of r.entities) {
    const e = cleanEntity(raw)
    if (e) add(e)
  }

  // Decisions and to-dos become facts on the entities they are about — or, when
  // the AI named none, on the first person/organisation the chat is about.
  const anchor = () => [...byRel.values()].find(e => /person|people|compan|organi[sz]ation|^org/.test(e.type)) ?? [...byRel.values()][0]
  const attach = (fact: string, where: string | undefined, about: EntityRefIn[] | undefined) => {
    const targets = (about ?? [])
      .filter(a => (ENTITY_TYPES as readonly string[]).includes(a.type) && !ASSISTANT_NAMES.has(a.name.trim().toLowerCase()))
      .map(a => byRel.get(notePathFor(a.type as EntityType, canonical(a.type as EntityType, a.name.trim())))
        ?? add({ type: a.type as EntityType, name: a.name.trim(), facts: [] }))
    const list = targets.length ? targets : [anchor()].filter((e): e is Entity => !!e)
    for (const e of list) if (!e.facts.some(f => f.fact === fact)) e.facts.push({ fact, where })
  }
  for (const d of r.decisions) attach(`Decision: ${d.decision}`, d.where, d.about)
  for (const t of r.todos) attach(`To-do: ${todoText(t)}`, t.where, t.about)

  // Every fact on a page carries a citation back into this chat.
  const pages: Array<{ rel: string; title: string }> = []
  for (const [rel, e] of byRel) {
    if (!e.facts.length && !e.summary) continue
    e.facts = e.facts.map(f => ({ fact: f.fact, where: f.where || fallbackWhere }))
    e.related = (e.related ?? []).map(x => ({ type: x.type, name: canonical(x.type, x.name), label: x.label }))
    const abs = path.join(kb, rel)
    const existing = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, upsertEntityNote(existing, e, ref, today))
    if (!index.all.some(x => x.rel === rel)) index.all.push({ type: e.type, name: e.name, aliases: e.aliases ?? [], rel })
    pages.push({ rel, title: e.name })
  }

  const abs = path.join(kb, noteRel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, renderSourceNote({ rel: noteRel, c, rawFile: stored.raw_file, jobId, r, pages, today }))
  return { source_note: noteRel, pages: pages.map(p => p.rel) }
}

// ── The worker ───────────────────────────────────────────────────────────────

interface Outcome {
  status: 'done' | 'skipped' | 'failed'
  source_note?: string
  pages?: string[]
  skip_reason?: string
  error?: string
}

/** Next batch, in queue order: ≤ 8 chats and ≤ 40k characters; a big chat goes alone. */
export function pickBatch(queued: ImportItem[]): ImportItem[] {
  const out: ImportItem[] = []
  let chars = 0
  for (const it of queued) {
    if (out.length >= MAX_BATCH_CONVERSATIONS) break
    if (out.length && chars + it.chars > MAX_BATCH_CHARS) break
    out.push(it)
    chars += it.chars
    if (chars > MAX_BATCH_CHARS) break
  }
  return out
}

function knownNamesFor(index: EntityIndex, parts: PromptPart[]): string[] {
  const hay = parts.map(p => `${p.c.title}\n${p.c.notes ?? ''}\n${p.c.messages.slice(p.from, p.to).map(m => m.text).join('\n')}`).join('\n').toLowerCase()
  const out: string[] = []
  for (const e of index.all) {
    if (out.length >= 200) break
    if ([e.name, ...e.aliases].some(n => n.length > 2 && hay.includes(n.toLowerCase()))) out.push(`${e.type}: ${e.name}`)
  }
  return out
}

async function processBatch(kb: string, jobId: string, batch: ImportItem[], index: EntityIndex, deps: ImportDeps): Promise<{ outcomes: Map<string, Outcome>; aiFailed: boolean }> {
  const outcomes = new Map<string, Outcome>()
  const stored = new Map<string, StoredConversation>()
  for (const it of batch) {
    try { stored.set(it.key, readStored(kb, jobId, it.key)) } catch (err) {
      outcomes.set(it.key, { status: 'failed', error: (err as Error).message })
    }
  }
  if (!stored.size) return { outcomes, aiFailed: false }

  let results: Map<string, ExtractedConversation>
  try {
    const convs = [...stored.values()].map(s => s.conversation)
    if (convs.length === 1 && conversationChars(convs[0]) > MAX_CONVERSATION_CHARS) {
      const parts = splitConversation(convs[0])
      const got: ExtractedConversation[] = []
      for (const p of parts) got.push(...(await callExtract(deps.llm, buildPrompt([p], knownNamesFor(index, [p])))).filter(r => r.key === convs[0].key))
      results = new Map(got.length ? [[convs[0].key, mergeParts(convs[0].key, got)]] : [])
    } else {
      const parts = convs.map(c => ({ c, from: 0, to: c.messages.length }))
      results = new Map((await callExtract(deps.llm, buildPrompt(parts, knownNamesFor(index, parts)))).map(r => [r.key, r]))
    }
  } catch (err) {
    const msg = `The AI could not read this chat: ${(err as Error).message}`
    for (const key of stored.keys()) outcomes.set(key, { status: 'failed', error: msg })
    return { outcomes, aiFailed: true }
  }

  const today = (deps.now ?? (() => new Date()))().toISOString().slice(0, 10)
  for (const [key, s] of stored) {
    const r = results.get(key)
    if (!r) { outcomes.set(key, { status: 'failed', error: 'The AI did not return this chat. Start the import again to retry it.' }); continue }
    if (r.skip) { outcomes.set(key, { status: 'skipped', skip_reason: r.skip_reason ?? 'no business facts' }); continue }
    try {
      const w = writeConversation(kb, jobId, s, r, index, today)
      outcomes.set(key, { status: 'done', source_note: w.source_note, pages: w.pages })
    } catch (err) {
      outcomes.set(key, { status: 'failed', error: `Could not write the pages for this chat: ${(err as Error).message}` })
    }
  }
  return { outcomes, aiFailed: false }
}

function safeCompile(kb: string, now: Date): void {
  try { compileWiki(kb, { now }) } catch (err) { console.warn(`[kb-wiki] compile after import: ${(err as Error).message}`) }
}

function logRun(kb: string, meta: ImportJobSummary, pages: Set<string>, now: Date, suffix = ''): void {
  const c = meta.counts
  const noun = meta.kind === 'transcripts' ? 'calls' : 'chats'
  try {
    appendLog(kb, {
      kind: 'import',
      title: `Imported ${c.done} of ${c.selected} ${noun} from ${meta.label} (${c.skipped} skipped as small talk)${suffix}`,
      pages: [...pages],
      when: now,
    })
  } catch (err) {
    console.warn(`[kb-wiki] import log: ${(err as Error).message}`)
  }
}

async function workLoop(kb: string, deps: ImportDeps): Promise<void> {
  const now = deps.now ?? (() => new Date())
  // A chat still 'working' when a worker starts was interrupted (the chain runs one worker per KB).
  for (const meta of listImports(kb)) {
    if (meta.status !== 'running') continue
    const items = readItems(kb, meta.id)
    if (items.some(i => i.status === 'working')) {
      for (const i of items) if (i.status === 'working') i.status = 'queued'
      saveJob(kb, meta, items)
    }
  }

  // Loaded ONCE per run and kept current as pages are written — thousands of chats must not re-scan the KB.
  const index = loadEntityIndex(kb)
  const touched = new Map<string, Set<string>>()
  let batchesSinceCompile = 0
  let dirty = false
  let failedRuns = 0

  for (;;) {
    const running = listImports(kb).filter(j => j.status === 'running').sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    // Close every job with nothing left the moment it empties, not when its turn in the queue comes round.
    let job: ImportJobSummary | undefined
    for (const j of running) {
      const items = readItems(kb, j.id)
      if (items.some(i => i.status === 'queued' && i.selected)) { job ??= j; continue }
      const meta = readMeta(kb, j.id)
      meta.status = 'done'
      meta.finished_at = now().toISOString()
      saveJob(kb, meta, items)
      safeCompile(kb, now())
      dirty = false
      batchesSinceCompile = 0
      logRun(kb, meta, touched.get(j.id) ?? new Set<string>(), now())
      touched.delete(j.id)
      failedRuns = 0
    }
    if (!job) break
    const pages = touched.get(job.id) ?? new Set<string>()
    touched.set(job.id, pages)

    const items = readItems(kb, job.id)
    const batch = pickBatch(items.filter(i => i.status === 'queued' && i.selected))

    const keys = new Set(batch.map(b => b.key))
    for (const it of items) if (keys.has(it.key)) it.status = 'working'
    saveJob(kb, readMeta(kb, job.id), items)

    const { outcomes, aiFailed } = await processBatch(kb, job.id, batch, index, deps)

    // Re-read: a pause/cancel/selection change may have landed while the AI was working.
    const meta = readMeta(kb, job.id)
    const fresh = readItems(kb, job.id)
    for (const it of fresh) {
      const o = outcomes.get(it.key)
      if (!o || !keys.has(it.key)) continue
      it.status = o.status
      it.source_note = o.source_note
      it.pages = o.pages
      it.skip_reason = o.skip_reason
      it.error = o.error
      if (o.source_note) { pages.add(o.source_note); dirty = true }
      for (const p of o.pages ?? []) pages.add(p)
    }
    failedRuns = aiFailed ? failedRuns + 1 : 0
    if (failedRuns >= MAX_CONSECUTIVE_FAILED_BATCHES && meta.status === 'running') {
      meta.status = 'failed'
      meta.error = [...outcomes.values()].find(o => o.error)?.error ?? 'The AI could not be reached.'
      meta.finished_at = now().toISOString()
      failedRuns = 0
    }
    saveJob(kb, meta, fresh)

    if (++batchesSinceCompile >= COMPILE_EVERY_BATCHES && dirty) {
      safeCompile(kb, now())
      batchesSinceCompile = 0
      dirty = false
    }
    if (meta.status !== 'running') {
      if (dirty) { safeCompile(kb, now()); dirty = false; batchesSinceCompile = 0 }
      if (pages.size || meta.status === 'failed') {
        logRun(kb, meta, pages, now(), meta.status === 'paused' ? ' — paused' : meta.status === 'cancelled' ? ' — stopped' : ' — stopped after an error')
      }
      touched.delete(job.id)
    }
  }
  if (dirty) safeCompile(kb, now())
}

const workers = new Map<string, Promise<void>>()

/**
 * Work through every running import in this KB until none has chats queued.
 * One worker per KB: a second call waits for the first (they would race on
 * the same entity pages otherwise).
 */
export function runImportWorker(kb: string, deps: ImportDeps): Promise<void> {
  const prev = workers.get(kb) ?? Promise.resolve()
  const next = prev.then(() => workLoop(kb, deps))
  const settled = next.catch(err => { console.error(`[kb-wiki] import worker: ${(err as Error).message}`) })
  workers.set(kb, settled)
  void settled.then(() => { if (workers.get(kb) === settled) workers.delete(kb) })
  return next
}

/** True while this process is working through a KB's imports. */
export function isImporting(kb: string): boolean {
  return workers.has(kb)
}

/** Resolves when the KB's import worker (if any) has stopped. */
export function whenImportsIdle(kb: string): Promise<void> {
  return workers.get(kb) ?? Promise.resolve()
}

// ── Sample data ──────────────────────────────────────────────────────────────

/** Made-up chats and calls for a small garden centre — the "try with sample data" button. */
export const SAMPLE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample-data')

/** The sample files, ready to pass to createImport. */
export function sampleImportFiles(): Array<{ name: string; path: string }> {
  try {
    return fs.readdirSync(SAMPLE_DIR)
      .filter(n => !n.startsWith('.') && n.toLowerCase() !== 'readme.md')
      .sort()
      .map(n => ({ name: n, path: path.join(SAMPLE_DIR, n) }))
  } catch { return [] }
}
