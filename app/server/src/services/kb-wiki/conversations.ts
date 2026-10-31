import path from 'path'
import { ExportReadError, jsonArrayElements, readZipEntry } from './export-reader.js'
import { extractDocx } from '../doc-ingest/extract.js'

/**
 * Readers for chat exports and call transcripts (obj 720117).
 *
 * Pure functions: a file's bytes in, a list of conversations out. Nothing here
 * touches disk or the AI, so every format rule is unit-tested directly.
 *
 *   Claude export   .zip with conversations.json (items carry `chat_messages`)
 *   ChatGPT export  .zip with conversations.json (items carry a `mapping` tree)
 *   Call transcript .vtt · .srt · .txt · .docx · .md · .json (generic format, see sample-data/README.md)
 *
 * A bad file throws an Error whose message can be shown to a person as-is.
 */

export type ConversationOrigin = 'claude' | 'chatgpt' | 'call'

export interface ConversationMessage {
  speaker: string
  text: string
  /** ISO time for chats, `mm:ss` / `h:mm:ss` offset for calls. */
  at?: string
}

export interface ParsedConversation {
  /** Stable within one import: 'c0001', 'c0002', … */
  key: string
  external_id?: string
  title: string
  origin: ConversationOrigin
  started_at?: string
  participants: string[]
  messages: ConversationMessage[]
  /** Free text that is not a spoken line (meeting notes, a summary, a body with no speakers). */
  notes?: string
}

export type ImportKind = 'claude-export' | 'chatgpt-export' | 'transcript'

export const TRANSCRIPT_EXTENSIONS = ['.vtt', '.srt', '.txt', '.docx', '.md', '.json'] as const

/** Text kept per attached file inside a Claude chat. */
const MAX_ATTACHMENT_CHARS = 20_000

// ── helpers ──────────────────────────────────────────────────────────────────

function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  const s = buf.toString('utf8')
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

function isZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04
}

function keyFor(i: number): string {
  return `c${String(i + 1).padStart(4, '0')}`
}

function toIso(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    // Epoch seconds (ChatGPT) or milliseconds.
    const d = new Date(v < 1e12 ? v * 1000 : v)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v.trim())
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  return undefined
}

/** `75` → `1:15`, `3725` → `1:02:05`. */
export function formatOffset(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

/** `00:12:30.000` / `00:12:30,000` / `12:30` → `12:30`. */
function normalizeClock(t: string): string {
  const parts = t.trim().replace(/[.,]\d+$/, '').split(':').map(Number)
  if (parts.some(n => Number.isNaN(n))) return t.trim()
  const secs = parts.reduce((acc, n) => acc * 60 + n, 0)
  return formatOffset(secs)
}

function offsetFrom(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return formatOffset(v)
  if (typeof v === 'string' && /^\d{1,2}(:\d{2}){1,2}([.,]\d+)?$/.test(v.trim())) return normalizeClock(v)
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return formatOffset(Number(v))
  return undefined
}

function dateFromFileName(name: string): string | undefined {
  const m = path.basename(name).match(/(\d{4})-(\d{2})-(\d{2})/)
  return m ? toIso(`${m[1]}-${m[2]}-${m[3]}`) : undefined
}

function titleFromFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'))
  const ext = path.extname(base)
  return (ext ? base.slice(0, -ext.length) : base).trim() || 'Untitled'
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs.map(x => x.trim()).filter(Boolean))]
}

/** Join consecutive lines from the same speaker into one message (calls split sentences across cues). */
function mergeRuns(msgs: ConversationMessage[]): ConversationMessage[] {
  const out: ConversationMessage[] = []
  for (const m of msgs) {
    const text = m.text.trim()
    if (!text) continue
    const last = out[out.length - 1]
    if (last && last.speaker === m.speaker) last.text = `${last.text} ${text}`
    else out.push({ ...m, text })
  }
  return out
}

function nameOf(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['name', 'display_name', 'speaker', 'email']) if (typeof o[k] === 'string' && (o[k] as string).trim()) return (o[k] as string).trim()
  }
  return ''
}

function nameList(v: unknown): string[] {
  if (Array.isArray(v)) return uniq(v.map(nameOf))
  if (typeof v === 'string') return uniq(v.replace(/^\[|\]$/g, '').split(/[,;]/).map(s => s.replace(/^["']|["']$/g, '')))
  return []
}

// ── Chat exports ─────────────────────────────────────────────────────────────

/**
 * The chats in conversations.json from an export .zip — or in the file itself,
 * when someone uploads the unzipped JSON. Yields one parsed chat at a time
 * (export-reader.ts), so an export with thousands of chats never becomes one
 * giant string.
 */
function conversationsJsonBuffer(buf: Buffer, what: string): Buffer {
  if (!isZip(buf)) return buf
  let hit: { name: string; data: Buffer } | null
  try { hit = readZipEntry(buf, n => /(^|\/)conversations\.json$/i.test(n)) } catch (err) {
    throw new Error(`This ${what} file could not be opened as a zip (${(err as Error).message}). Download the export again and upload the .zip as it came.`)
  }
  if (!hit) throw new Error(`This zip has no conversations.json, so it does not look like a ${what}. Upload the .zip the export email linked to.`)
  return hit.data
}

function* loadConversationsJson(buf: Buffer, what: string): Generator<unknown> {
  const data = conversationsJsonBuffer(buf, what)
  try {
    yield* jsonArrayElements(data)
  } catch (err) {
    if (!(err instanceof ExportReadError)) throw err
    throw new Error(err.message === 'not a JSON list'
      ? `The conversations.json in this ${what} is not a list of chats.`
      : `The conversations.json in this ${what} is damaged and could not be read (${err.message}).`)
  }
}

function classify(items: Iterable<unknown>): 'claude-export' | 'chatgpt-export' | null {
  let n = 0
  for (const it of items) {
    if (++n > 20) break
    if (!it || typeof it !== 'object') continue
    if ('mapping' in it) return 'chatgpt-export'
    if ('chat_messages' in it) return 'claude-export'
  }
  return null
}

/** Which reader a file needs, or null when it is none of the supported kinds. */
export function detectImportKind(fileName: string, buf: Buffer): ImportKind | null {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === '.docx') return 'transcript'
  if (ext === '.zip' || (isZip(buf) && ext !== '.docx')) {
    try { return classify(loadConversationsJson(buf, 'export')) } catch { return null }
  }
  if (ext === '.json') {
    // A list could be an unzipped conversations.json (maybe huge — peek, don't parse it all) or a list of calls.
    try {
      if (/^\s*\[/.test(buf.subarray(0, 64).toString('utf8').replace(/^\ufeff/, ''))) {
        const k = classify(jsonArrayElements(buf))
        if (k) return k
      } else JSON.parse(decodeText(buf))
    } catch { return null }
    return 'transcript'
  }
  return (TRANSCRIPT_EXTENSIONS as readonly string[]).includes(ext) ? 'transcript' : null
}

interface ClaudeMessage {
  sender?: string
  text?: string
  content?: Array<{ type?: string; text?: string }>
  created_at?: string
  attachments?: Array<{ file_name?: string; extracted_content?: string }>
}

/** Claude.ai export (Settings → Privacy → Export data). Speakers are 'You' and 'Claude'. */
export function parseClaudeExport(zipBuf: Buffer): ParsedConversation[] {
  const items = loadConversationsJson(zipBuf, 'Claude export')
  const out: ParsedConversation[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as { uuid?: string; name?: string; created_at?: string; chat_messages?: ClaudeMessage[] }
    const messages: ConversationMessage[] = []
    for (const m of Array.isArray(c.chat_messages) ? c.chat_messages : []) {
      if (!m || typeof m !== 'object') continue
      let text = typeof m.text === 'string' ? m.text.trim() : ''
      if (!text && Array.isArray(m.content)) {
        text = m.content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text!.trim()).filter(Boolean).join('\n\n')
      }
      for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
        const body = typeof a?.extracted_content === 'string' ? a.extracted_content.trim() : ''
        if (!body) continue
        const clipped = body.length > MAX_ATTACHMENT_CHARS ? `${body.slice(0, MAX_ATTACHMENT_CHARS)}\n…(rest of the file left out)` : body
        text += `${text ? '\n\n' : ''}[Attached file: ${a.file_name || 'file'}]\n${clipped}`
      }
      if (!text) continue
      const speaker = m.sender === 'human' ? 'You' : m.sender === 'assistant' ? 'Claude' : (m.sender || 'Unknown')
      messages.push({ speaker, text, at: toIso(m.created_at) })
    }
    if (!messages.length) continue
    out.push({
      key: keyFor(out.length),
      external_id: typeof c.uuid === 'string' ? c.uuid : undefined,
      title: (typeof c.name === 'string' && c.name.trim()) || 'Untitled chat',
      origin: 'claude',
      started_at: toIso(c.created_at) ?? messages[0].at,
      participants: uniq(messages.map(m => m.speaker)),
      messages,
    })
  }
  return out
}

interface GptNode {
  id?: string
  parent?: string | null
  children?: string[]
  message?: {
    author?: { role?: string }
    recipient?: string
    create_time?: number | null
    content?: { content_type?: string; parts?: unknown[]; text?: string }
    metadata?: Record<string, unknown>
  } | null
}

const GPT_TEXT_TYPES = new Set(['text', 'multimodal_text'])

function gptText(node: GptNode): string {
  const msg = node.message
  if (!msg) return ''
  const role = msg.author?.role
  if (role !== 'user' && role !== 'assistant') return ''
  if (msg.recipient && msg.recipient !== 'all') return '' // a call into a tool, not a reply
  const md = msg.metadata ?? {}
  if (md.is_visually_hidden_from_conversation || md.is_user_system_message) return ''
  const ct = msg.content?.content_type ?? 'text'
  if (!GPT_TEXT_TYPES.has(ct)) return ''
  const parts = Array.isArray(msg.content?.parts) ? msg.content!.parts! : []
  return parts
    .map(p => (typeof p === 'string' ? p : p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
    .map(s => s.trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The branch a person last saw. ChatGPT keeps every edit/regenerate as a
 * branch; `current_node` is the leaf that was on screen. Walk it up to the
 * root and reverse. Without a current_node, take the newest leaf.
 */
function gptPath(mapping: Record<string, GptNode>, current?: string | null): GptNode[] {
  let leaf = current && mapping[current] ? current : undefined
  if (!leaf) {
    const leaves = Object.entries(mapping).filter(([, n]) => !n.children?.length)
    leaves.sort((a, b) => (b[1].message?.create_time ?? 0) - (a[1].message?.create_time ?? 0))
    leaf = leaves[0]?.[0]
  }
  const out: GptNode[] = []
  const seen = new Set<string>()
  for (let id: string | undefined = leaf; id && mapping[id] && !seen.has(id); id = mapping[id].parent ?? undefined) {
    seen.add(id)
    out.push(mapping[id])
  }
  return out.reverse()
}

/** ChatGPT export (Settings → Data controls → Export). Speakers are 'You' and 'ChatGPT'. */
export function parseChatGptExport(zipBuf: Buffer): ParsedConversation[] {
  const items = loadConversationsJson(zipBuf, 'ChatGPT export')
  const out: ParsedConversation[] = []
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as { id?: string; conversation_id?: string; title?: string; create_time?: number; mapping?: Record<string, GptNode>; current_node?: string }
    if (!c.mapping || typeof c.mapping !== 'object') continue
    const messages: ConversationMessage[] = []
    for (const node of gptPath(c.mapping, c.current_node)) {
      const text = gptText(node)
      if (!text) continue
      messages.push({ speaker: node.message!.author!.role === 'user' ? 'You' : 'ChatGPT', text, at: toIso(node.message!.create_time ?? undefined) })
    }
    if (!messages.length) continue
    out.push({
      key: keyFor(out.length),
      external_id: c.conversation_id || c.id,
      title: (typeof c.title === 'string' && c.title.trim()) || 'Untitled chat',
      origin: 'chatgpt',
      started_at: toIso(c.create_time) ?? messages[0].at,
      participants: uniq(messages.map(m => m.speaker)),
      messages,
    })
  }
  return out
}

// ── Call transcripts ─────────────────────────────────────────────────────────

/** A speaker name: 1-4 capitalised words or a number ("Rosa Delgado", "Speaker 2", "Dr. Lee"). */
const NAME = String.raw`(?:[\p{Lu}][\p{L}\p{M}'’.\-]*|\d+)(?: (?:[\p{Lu}][\p{L}\p{M}'’.\-]*|\d+|de|van|von|da|del|la|le|bin)){0,4}`
const CLOCK = String.raw`\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?`
const SPEAKER_LINE = new RegExp(String.raw`^(?:[\[(]?(${CLOCK})[\])]?\s*[-–]?\s*)?(?:\*\*|__)?(${NAME})(?:\s*[\[(](${CLOCK})[\])])?(?::\s*(?:\*\*|__)|(?:\*\*|__)?\s*:)\s*(.*)$`, 'u')
const OTTER_HEADER = new RegExp(String.raw`^(${NAME})\s+(${CLOCK})\s*$`, 'u')
/** Words that look like a "Name:" prefix but label a line instead. */
const NOT_SPEAKERS = new Set(['note', 'notes', 'action', 'action items', 'actions', 'decision', 'decisions', 'todo', 'to-do', 'summary', 'agenda', 're', 'subject', 'next steps', 'update', 'http', 'https', 'warning', 'tip', 'example', 'q', 'a'])
const META_KEYS = new Set(['title', 'date', 'participants', 'attendees', 'meeting', 'source', 'subject', 'when'])

interface LineParse {
  messages: ConversationMessage[]
  notes: string[]
  meta: Record<string, string>
  heading?: string
}

function stripMd(line: string): string {
  return line.replace(/^>\s?/, '').replace(/\s+$/, '')
}

/** `Name: text`, `[00:01:02] Name: text`, `**Name:** text`, and Otter-style `Name  0:03` + text lines. */
export function parseSpeakerLines(text: string): LineParse {
  const res: LineParse = { messages: [], notes: [], meta: {} }
  let cur: ConversationMessage | null = null
  let otter: { speaker: string; at: string } | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripMd(rawLine)
    const t = line.trim()
    if (!t) { cur = otter ? null : cur; continue }
    if (!res.messages.length && !otter) {
      const meta = t.match(/^(?:\*\*)?([A-Za-z]+)(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/)
      if (meta && META_KEYS.has(meta[1].toLowerCase())) { res.meta[meta[1].toLowerCase()] = meta[2].trim(); continue }
      const h = t.match(/^#{1,3}\s+(.+)$/)
      if (h && !res.heading) { res.heading = h[1].trim(); continue }
    }
    const oh = t.match(OTTER_HEADER)
    if (oh && !NOT_SPEAKERS.has(oh[1].toLowerCase())) {
      otter = { speaker: oh[1], at: normalizeClock(oh[2]) }
      cur = null
      continue
    }
    const sm = t.match(SPEAKER_LINE)
    if (sm && !NOT_SPEAKERS.has(sm[2].toLowerCase()) && sm[4].trim()) {
      const clock = sm[1] ?? sm[3]
      cur = { speaker: sm[2].trim(), text: sm[4].trim(), at: clock ? normalizeClock(clock) : undefined }
      res.messages.push(cur)
      otter = null
      continue
    }
    if (otter && !cur) {
      cur = { speaker: otter.speaker, text: t, at: otter.at }
      res.messages.push(cur)
      continue
    }
    if (cur) cur.text += `\n${t}`
    else res.notes.push(t)
  }
  return res
}

/** WEBVTT and SRT: timed cues; speakers from `<v Name>` voice tags or a `Name:` prefix. */
function parseCues(text: string): ConversationMessage[] {
  const out: ConversationMessage[] = []
  const lines = text.split(/\r?\n/)
  let at: string | undefined
  let inCue = false
  let skipBlock = false
  let last = 'Speaker'
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) { inCue = false; skipBlock = false; continue }
    if (skipBlock) continue
    if (/^WEBVTT/.test(t) && i === 0) { skipBlock = true; continue }
    if (!inCue && /^(NOTE|STYLE|REGION)\b/.test(t)) { skipBlock = true; continue }
    const arrow = t.match(/^(\d{1,2}:\d{2}(?::\d{2})?[.,]\d+)\s*-->/)
    if (arrow) { at = normalizeClock(arrow[1]); inCue = true; continue }
    if (!inCue) continue // cue number or identifier line
    let speaker: string | undefined
    let body = t
    const v = body.match(/<v(?:\.[^\s>]+)?\s+([^>]+)>/)
    if (v) speaker = v[1].trim()
    body = body.replace(/<[^>]+>/g, '').trim()
    if (!speaker) {
      const sm = body.match(new RegExp(String.raw`^(${NAME})\s*:\s+(.*)$`, 'u'))
      if (sm && !NOT_SPEAKERS.has(sm[1].toLowerCase())) { speaker = sm[1]; body = sm[2] }
    }
    if (speaker) last = speaker
    if (body) out.push({ speaker: speaker ?? last, text: body, at })
  }
  return mergeRuns(out)
}

function frontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  let listKey: string | null = null
  for (const line of m[1].split(/\r?\n/)) {
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && listKey) { meta[listKey] = meta[listKey] ? `${meta[listKey]}, ${item[1].trim()}` : item[1].trim(); continue }
    const kv = line.match(/^([A-Za-z_]+)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    let val = kv[2].trim()
    if (/^".*"$/.test(val)) { try { val = JSON.parse(val) as string } catch { /* keep as is */ } }
    else val = val.replace(/^'(.*)'$/, '$1')
    meta[key] = val
    listKey = val ? null : key
  }
  return { meta, body: text.slice(m[0].length) }
}

function fromLines(fileName: string, text: string, extraMeta: Record<string, string> = {}): ParsedConversation {
  const p = parseSpeakerLines(text)
  const meta = { ...p.meta, ...extraMeta }
  const messages = mergeRuns(p.messages)
  const named = nameList(meta.participants ?? meta.attendees)
  const noteText = p.notes.join('\n').trim()
  if (!messages.length && !noteText) throw new Error(`${path.basename(fileName)} has no text we could read.`)
  return {
    key: 'c0001',
    title: meta.title || p.heading || titleFromFileName(fileName),
    origin: 'call',
    started_at: toIso(meta.date ?? meta.when) ?? dateFromFileName(fileName),
    participants: named.length ? named : uniq(messages.map(m => m.speaker)),
    messages,
    notes: noteText || undefined,
  }
}

const SEGMENT_KEYS = ['segments', 'transcript', 'sentences', 'utterances', 'messages'] as const

function fromGenericJson(fileName: string, obj: Record<string, unknown>, index: number): ParsedConversation {
  const segsRaw = SEGMENT_KEYS.map(k => obj[k]).find(v => v !== undefined)
  const notes = typeof obj.notes === 'string' ? obj.notes : typeof obj.summary === 'string' ? obj.summary : undefined
  let messages: ConversationMessage[] = []
  if (typeof segsRaw === 'string') {
    messages = mergeRuns(parseSpeakerLines(segsRaw).messages)
  } else if (Array.isArray(segsRaw)) {
    messages = mergeRuns(segsRaw.flatMap((s): ConversationMessage[] => {
      if (!s || typeof s !== 'object') return []
      const o = s as Record<string, unknown>
      const text = typeof o.text === 'string' ? o.text : typeof o.raw_text === 'string' ? o.raw_text : typeof o.content === 'string' ? o.content : ''
      if (!text.trim()) return []
      const speaker = nameOf(o.speaker) || nameOf(o.speaker_name) || nameOf(o.author) || 'Speaker'
      return [{ speaker, text, at: offsetFrom(o.start ?? o.start_time ?? o.timestamp) }]
    }))
  }
  if (!messages.length && !notes?.trim()) {
    throw new Error(`${path.basename(fileName)}${index ? ` (item ${index + 1})` : ''} has no transcript lines. Each call needs a "segments" list of {"speaker", "text"} — see the sample-data README for the format.`)
  }
  const named = nameList(obj.participants ?? obj.attendees)
  return {
    key: keyFor(index),
    external_id: typeof obj.id === 'string' ? obj.id : undefined,
    title: (typeof obj.title === 'string' && obj.title.trim()) || titleFromFileName(fileName),
    origin: 'call',
    started_at: toIso(obj.date ?? obj.started_at ?? obj.start_time) ?? dateFromFileName(fileName),
    participants: named.length ? named : uniq(messages.map(m => m.speaker)),
    messages,
    notes: notes?.trim() || undefined,
  }
}

/**
 * One transcript file → its conversations (a generic .json array → many).
 * Keys are numbered from c0001; the import re-keys them across files.
 */
export function parseTranscript(fileName: string, buf: Buffer): ParsedConversation[] {
  const ext = path.extname(fileName).toLowerCase()
  const base = path.basename(fileName)
  switch (ext) {
    case '.vtt':
    case '.srt': {
      const messages = parseCues(decodeText(buf))
      if (!messages.length) throw new Error(`${base} has no caption lines we could read.`)
      return [{
        key: 'c0001',
        title: titleFromFileName(fileName),
        origin: 'call',
        started_at: dateFromFileName(fileName),
        participants: uniq(messages.map(m => m.speaker)),
        messages,
      }]
    }
    case '.txt':
      return [fromLines(fileName, decodeText(buf))]
    case '.docx': {
      let md: string
      try { md = extractDocx(buf).markdown } catch (err) {
        throw new Error(`${base} could not be opened as a Word document (${(err as Error).message}).`)
      }
      return [fromLines(fileName, md.replace(/\n\n/g, '\n'))]
    }
    case '.md': {
      const { meta, body } = frontmatter(decodeText(buf))
      return [fromLines(fileName, body, Object.fromEntries(Object.entries(meta).filter(([, v]) => v)))]
    }
    case '.json': {
      let v: unknown
      try { v = JSON.parse(decodeText(buf)) } catch {
        throw new Error(`${base} is not valid JSON.`)
      }
      const list = Array.isArray(v) ? v : [v]
      if (!list.length || list.some(x => !x || typeof x !== 'object' || Array.isArray(x))) {
        throw new Error(`${base} is not in the transcript format: expected one call object, or a list of them.`)
      }
      return list.map((o, i) => fromGenericJson(fileName, o as Record<string, unknown>, i))
    }
    default:
      throw new Error(`${base}: transcripts can be .vtt, .srt, .txt, .docx, .md or .json.`)
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Characters of real content (messages + notes) — what the AI would read. */
export function conversationChars(c: ParsedConversation): number {
  return c.messages.reduce((n, m) => n + m.text.length + m.speaker.length + 4, 0) + (c.notes?.length ?? 0)
}

function shortTime(at?: string): string {
  if (!at) return ''
  if (/^\d{4}-\d{2}-\d{2}T/.test(at)) return at.slice(0, 16).replace('T', ' ')
  return at
}

/** Readable transcript. Messages are numbered so a fact can cite "message 4, You". */
export function renderConversationMarkdown(c: ParsedConversation): string {
  const parts: string[] = []
  if (c.notes) parts.push('### Notes', '', c.notes.trim(), '')
  c.messages.forEach((m, i) => {
    const when = shortTime(m.at)
    parts.push(`**${i + 1}. ${m.speaker}**${when ? ` · ${when}` : ''}`, '', m.text.trim(), '')
  })
  return parts.join('\n').trim()
}
