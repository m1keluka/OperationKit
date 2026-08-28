// Granola content engine — read/drive surface for the personal content streams.
//
// This is the server-side companion to Worker A's `granola-intake` SESSION skill
// (objective 762/771). The skill writes Mike-only markdown into the second-brain
// vault across four streams; this module READS those streams for the admin UI and
// drives the engine (status round-trip on the posting queue + "Run now" / nightly
// session spawn). It deliberately never touches the `granola_processed_meetings` /
// `granola_action_items` DB tables — those belong to the separate CC-146 meeting
// pipeline. Idempotency for THIS engine lives in the vault JSON store, owned by the
// skill, not here.
//
// Source of truth for paths/schemas: ai-workspace/objective-memory/762/CONTRACT.md
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { fireRoutine, type RoutineRow, type FireResult } from './routine-scheduler.js'
import { chownToVaultUser } from './vault-fs.js'

// host path == container path (bind-mounted, verified writable per CONTRACT §1)
const VAULT_BASE = process.env.VAULT_PATH || '/home/operator/second-brain'
export const GRANOLA_WORKSPACE = process.env.GRANOLA_WORKSPACE || 'personal'
const WS_ROOT = path.join(VAULT_BASE, 'workspaces', GRANOLA_WORKSPACE)

const DRAFTS_DIR = path.join(WS_ROOT, 'content', 'drafts')
const HOOKS_DIR = path.join(WS_ROOT, 'content', 'hooks')
const IDEAS_FILE = path.join(WS_ROOT, 'inbox', 'ideas.md')

export const DRAFT_STATUSES = ['draft', 'ready', 'posted'] as const
export type DraftStatus = (typeof DRAFT_STATUSES)[number]

// The routine that IS the nightly schedule; "Run now" fires the same row.
export const GRANOLA_ROUTINE_NAME = 'granola-intake-personal'

// ── Minimal frontmatter parser ───────────────────────────────────────────────
// The CONTRACT schemas are flat `key: value` YAML (plus one array field,
// `attendees`, which these streams don't surface). No YAML dep in the server, and
// a full parser would be overkill + risk reordering on write. We only need to READ
// scalar fields here; status WRITES use a targeted line replace (see below).
interface ParsedDoc {
  data: Record<string, string>
  body: string
}

function stripQuotes(v: string): string {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1)
  }
  return t
}

export function parseFrontmatter(raw: string): ParsedDoc {
  const data: Record<string, string> = {}
  // Frontmatter must be the very first thing in the file.
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) return { data, body: raw }
  const [, fm, body] = m
  for (const line of fm.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    data[kv[1]] = stripQuotes(kv[2])
  }
  return { data, body: body.replace(/^\s+/, '') }
}

// ── Posting queue (LinkedIn drafts) ──────────────────────────────────────────
// Frontmatter `type` values the posting queue will surface. `linkedin-draft` is the
// default (single text post); `linkedin-carousel` is a multi-slide PDF/document post
// whose body holds slide-by-slide copy + a layout spec rather than a single post body.
// A draft with no `type` is treated as `linkedin-draft`.
const POSTABLE_TYPES = new Set(['linkedin-draft', 'linkedin-carousel'])

export interface DraftSummary {
  file: string // basename, the id used by PATCH
  status: string
  type: string // 'linkedin-draft' (default) | 'linkedin-carousel'
  granola_id: string
  source_note: string
  pillar: string
  topic: string
  belief: string
  hook: string
  date: string
  created_at: string
  self_check: string
  body: string
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort().reverse()
  } catch {
    return []
  }
}

export function listDrafts(statusFilter?: string): DraftSummary[] {
  const out: DraftSummary[] = []
  for (const file of safeReaddir(DRAFTS_DIR)) {
    let raw: string
    try {
      raw = fs.readFileSync(path.join(DRAFTS_DIR, file), 'utf8')
    } catch {
      continue
    }
    const { data, body } = parseFrontmatter(raw)
    if (data.type && !POSTABLE_TYPES.has(data.type)) continue
    const status = data.status || 'draft'
    if (statusFilter && statusFilter !== 'all' && status !== statusFilter) continue
    out.push({
      file,
      status,
      type: data.type || 'linkedin-draft',
      granola_id: data.granola_id || '',
      source_note: data.source_note || '',
      pillar: data.pillar || '',
      topic: data.topic || '',
      belief: data.belief || '',
      hook: data.hook || '',
      date: data.date || '',
      created_at: data.created_at || '',
      self_check: data.self_check || '',
      body,
    })
  }
  // Newest first by created_at when available, else filename order.
  out.sort((a, b) => (b.created_at || b.date).localeCompare(a.created_at || a.date))
  return out
}

// Validate a draft filename: prevents path traversal. Only a bare `*.md` basename
// that actually lives inside DRAFTS_DIR is accepted.
function resolveDraftPath(file: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(file)) return null
  const abs = path.join(DRAFTS_DIR, file)
  const rel = path.relative(DRAFTS_DIR, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  if (!fs.existsSync(abs)) return null
  return abs
}

// Build a DraftSummary from parsed frontmatter + body. Shared by the list path
// and both PATCH handlers so the response shape stays in lockstep.
function toDraftSummary(file: string, data: Record<string, string>, body: string): DraftSummary {
  return {
    file,
    status: data.status || 'draft',
    type: data.type || 'linkedin-draft',
    granola_id: data.granola_id || '',
    source_note: data.source_note || '',
    pillar: data.pillar || '',
    topic: data.topic || '',
    belief: data.belief || '',
    hook: data.hook || '',
    date: data.date || '',
    created_at: data.created_at || '',
    self_check: data.self_check || '',
    body,
  }
}

export interface PatchResult {
  ok: boolean
  error?: string
  status?: string
  draft?: DraftSummary
}

// Rewrite ONLY the `status:` value inside the frontmatter block, preserving the
// rest of the file byte-for-byte (CONTRACT §2b). Returns the re-parsed draft.
export function patchDraftStatus(file: string, newStatus: string): PatchResult {
  if (!(DRAFT_STATUSES as readonly string[]).includes(newStatus)) {
    return { ok: false, error: `invalid status '${newStatus}' (allowed: ${DRAFT_STATUSES.join(', ')})` }
  }
  const abs = resolveDraftPath(file)
  if (!abs) return { ok: false, error: 'draft not found' }

  const raw = fs.readFileSync(abs, 'utf8')
  const fmMatch = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(raw)
  if (!fmMatch) return { ok: false, error: 'draft has no frontmatter block' }
  const [, open, fmBody, close] = fmMatch
  if (!/^status:\s*.*$/m.test(fmBody)) {
    return { ok: false, error: 'draft frontmatter has no status field' }
  }
  // Replace only the first status line within the frontmatter body.
  const newFmBody = fmBody.replace(/^(status:\s*).*$/m, `$1${newStatus}`)
  const newRaw = raw.replace(fmMatch[0], `${open}${newFmBody}${close}`)
  if (newRaw === raw && fmBody !== newFmBody) {
    return { ok: false, error: 'status rewrite produced no change' }
  }
  fs.writeFileSync(abs, newRaw, 'utf8')
  chownToVaultUser(abs)

  const { data, body } = parseFrontmatter(newRaw)
  return { ok: true, status: newStatus, draft: toDraftSummary(file, data, body) }
}

// Rewrite ONLY the body region (everything below the closing frontmatter `---`),
// preserving the entire frontmatter block byte-for-byte (CONTRACT §2b — status,
// tags, granola_id, pillar, etc. must be untouched). Mirrors patchDraftStatus's
// targeted-rewrite approach but operates on the body instead of one fm line.
// Returns the re-parsed draft.
export function patchDraftBody(file: string, newBody: string): PatchResult {
  if (typeof newBody !== 'string') {
    return { ok: false, error: 'body must be a string' }
  }
  const abs = resolveDraftPath(file)
  if (!abs) return { ok: false, error: 'draft not found' }

  const raw = fs.readFileSync(abs, 'utf8')
  // Capture the frontmatter block through (and including) the closing `---`.
  // Group 1 is preserved verbatim; everything after it is the replaceable body.
  const fmMatch = /^(---\r?\n[\s\S]*?\r?\n---)([\s\S]*)$/.exec(raw)
  if (!fmMatch) return { ok: false, error: 'draft has no frontmatter block' }
  const fmBlock = fmMatch[1]
  // Normalize the body to a single trailing newline; the frontmatter→body
  // separator is one blank line (matches what the intake skill writes).
  const normalizedBody = newBody.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  const newRaw = `${fmBlock}\n\n${normalizedBody}\n`
  fs.writeFileSync(abs, newRaw, 'utf8')
  chownToVaultUser(abs)

  const { data, body } = parseFrontmatter(newRaw)
  return { ok: true, draft: toDraftSummary(file, data, body) }
}

// ── Hooks (short-form video) ─────────────────────────────────────────────────
// A raw video Mike recorded riffing on a hook. Persisted as a single-line flow-style JSON
// array on a `videos:` frontmatter key (CONTRACT §2c) — added/updated only by this UI, never
// by the granola-intake skill. Single-line JSON keeps the array valid YAML AND lets the flat
// frontmatter parser read it as one scalar string (then JSON.parse), avoiding a multi-line YAML
// writer that could reorder/clobber the rest of the block.
export interface VideoMeta {
  path: string // object path within the hook-videos bucket
  url: string // public shareable URL (for inline player + AI clippers)
  hook_index: number // which bullet in hooks[] this video is for (-1 = unassigned/whole doc)
  label: string // optional free-text label
  uploaded_at: string // ISO8601
  size: number // bytes
}

export interface HookDoc {
  file: string
  granola_id: string
  source_note: string
  date: string
  title: string
  hooks: string[]
  videos: VideoMeta[]
}

// Parse the single-line `videos:` JSON array from frontmatter. Tolerant: bad/absent → [].
function parseVideos(data: Record<string, string>): VideoMeta[] {
  const raw = data.videos
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.map((v: Record<string, unknown>) => ({
      path: String(v.path || ''),
      url: String(v.url || ''),
      hook_index: typeof v.hook_index === 'number' ? v.hook_index : Number(v.hook_index) || -1,
      label: String(v.label || ''),
      uploaded_at: String(v.uploaded_at || ''),
      size: typeof v.size === 'number' ? v.size : Number(v.size) || 0,
    }))
  } catch {
    return []
  }
}

function parseHookDoc(file: string, raw: string): HookDoc {
  const { data, body } = parseFrontmatter(raw)
  const lines = body.split(/\r?\n/)
  const titleLine = lines.find(l => l.startsWith('# '))
  const hooks = lines
    .filter(l => /^\s*-\s+/.test(l))
    .map(l => l.replace(/^\s*-\s+/, '').trim())
    .filter(Boolean)
  return {
    file,
    granola_id: data.granola_id || '',
    source_note: data.source_note || '',
    date: data.date || '',
    title: titleLine ? titleLine.replace(/^#\s+/, '') : file,
    hooks,
    videos: parseVideos(data),
  }
}

export function listHooks(): HookDoc[] {
  const out: HookDoc[] = []
  for (const file of safeReaddir(HOOKS_DIR)) {
    let raw: string
    try {
      raw = fs.readFileSync(path.join(HOOKS_DIR, file), 'utf8')
    } catch {
      continue
    }
    out.push(parseHookDoc(file, raw))
  }
  out.sort((a, b) => b.date.localeCompare(a.date))
  return out
}

// Validate a hook filename (prevent traversal): bare `*.md` basename that lives in HOOKS_DIR.
function resolveHookPath(file: string): string | null {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(file)) return null
  const abs = path.join(HOOKS_DIR, file)
  const rel = path.relative(HOOKS_DIR, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  if (!fs.existsSync(abs)) return null
  return abs
}

export interface HookPatchResult {
  ok: boolean
  error?: string
  hook?: HookDoc
}

// Upsert the `videos:` frontmatter line to `videos: <json>`, preserving the rest of the
// frontmatter block and the entire body byte-for-byte. If the line exists it's replaced;
// otherwise it's inserted just before the closing `---`.
function writeHookVideos(abs: string, file: string, videos: VideoMeta[]): HookPatchResult {
  const raw = fs.readFileSync(abs, 'utf8')
  const fmMatch = /^(---\r?\n)([\s\S]*?)(\r?\n---)([\s\S]*)$/.exec(raw)
  if (!fmMatch) return { ok: false, error: 'hook doc has no frontmatter block' }
  const [, open, fmBody, close, rest] = fmMatch
  let newFmBody: string
  if (videos.length === 0) {
    // No videos left → drop the `videos:` line entirely so docs that never had a video
    // (or had their last one removed) stay clean rather than carrying `videos: []`.
    newFmBody = fmBody.replace(/^videos:\s*.*\r?\n?/m, '').replace(/\s+$/, '')
  } else {
    const line = `videos: ${JSON.stringify(videos)}`
    newFmBody = /^videos:\s*.*$/m.test(fmBody)
      ? fmBody.replace(/^videos:\s*.*$/m, line)
      : `${fmBody.replace(/\s+$/, '')}\n${line}` // append as the last frontmatter key
  }
  const newRaw = `${open}${newFmBody}${close}${rest}`
  fs.writeFileSync(abs, newRaw, 'utf8')
  chownToVaultUser(abs)
  return { ok: true, hook: parseHookDoc(file, newRaw) }
}

// Build the storage object path for a hook video: personal/<hookbase>/<ts>-<sanitized-filename>.
export function hookVideoObjectPath(file: string, filename: string): string {
  const base = file.replace(/\.md$/, '')
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'video'
  const ts = Date.now()
  return `${GRANOLA_WORKSPACE}/${base}/${ts}-${safeName}`
}

// Append a recorded video to a hook doc's frontmatter.
export function addHookVideo(file: string, meta: VideoMeta): HookPatchResult {
  const abs = resolveHookPath(file)
  if (!abs) return { ok: false, error: 'hook doc not found' }
  const current = parseHookDoc(file, fs.readFileSync(abs, 'utf8')).videos
  // de-dupe by path (idempotent re-record)
  const next = [...current.filter(v => v.path !== meta.path), meta]
  return writeHookVideos(abs, file, next)
}

// Remove a recorded video from a hook doc's frontmatter (storage object deleted by the caller).
export function removeHookVideo(file: string, objectPath: string): HookPatchResult {
  const abs = resolveHookPath(file)
  if (!abs) return { ok: false, error: 'hook doc not found' }
  const current = parseHookDoc(file, fs.readFileSync(abs, 'utf8')).videos
  const next = current.filter(v => v.path !== objectPath)
  return writeHookVideos(abs, file, next)
}

// ── Tasks / Ideas inboxes (rolling logs) ─────────────────────────────────────
export interface InboxItem {
  text: string
  date: string
  done: boolean
  granola_id: string
  source: string
}

function parseInbox(file: string, kind: 'task' | 'idea'): InboxItem[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: InboxItem[] = []
  for (const line of raw.split(/\r?\n/)) {
    // tasks: `- [ ] 2026-06-18 — text (...)`  ideas: `- 2026-06-18 — text (...)`
    const taskM = /^\s*-\s*\[( |x|X)\]\s*(.*)$/.exec(line)
    const ideaM = /^\s*-\s+(?!\[)(.*)$/.exec(line)
    let done = false
    let rest: string | null = null
    if (kind === 'task' && taskM) {
      done = taskM[1].toLowerCase() === 'x'
      rest = taskM[2]
    } else if (kind === 'idea' && ideaM) {
      rest = ideaM[1]
    }
    if (rest == null) continue
    const dateM = /^(\d{4}-\d{2}-\d{2})\s*[—-]\s*(.*)$/.exec(rest)
    const date = dateM ? dateM[1] : ''
    let text = dateM ? dateM[2] : rest
    const gM = /granola:(\S+?)[)\s]/.exec(text)
    const granola_id = gM ? gM[1] : ''
    const srcM = /\(\[source\]\(([^)]+)\)/.exec(text)
    const source = srcM ? srcM[1] : ''
    // Trim the trailing `([source](...) · granola:...)` decoration for display.
    text = text.replace(/\s*\(\[source\][\s\S]*$/, '').trim()
    out.push({ text, date, done, granola_id, source })
  }
  return out.reverse() // newest first
}

export function listIdeas(): InboxItem[] {
  return parseInbox(IDEAS_FILE, 'idea')
}

// ── Schedule / Run-now (session spawn via the native routine scheduler) ──────
export function getGranolaRoutine(): RoutineRow | undefined {
  return getDb()
    .prepare('SELECT * FROM routines WHERE name = ?')
    .get(GRANOLA_ROUTINE_NAME) as RoutineRow | undefined
}

export interface ScheduleInfo {
  exists: boolean
  enabled: boolean
  cron_expr: string | null
  last_run_at: string | null
  workspace: string
}

export function scheduleInfo(): ScheduleInfo {
  const r = getGranolaRoutine()
  return {
    exists: !!r,
    enabled: !!r && r.enabled === 1,
    cron_expr: r ? r.cron_expr : null,
    last_run_at: r ? r.last_run_at : null,
    workspace: GRANOLA_WORKSPACE,
  }
}

// "Run now" — fire the SAME routine the nightly schedule uses, so the manual run
// and the automatic run take the identical session-spawn code path.
export async function runNow(): Promise<FireResult & { error?: string }> {
  const r = getGranolaRoutine()
  if (!r) return { ok: false, reason: `routine '${GRANOLA_ROUTINE_NAME}' not found` }
  return fireRoutine(r, 'run-now')
}
