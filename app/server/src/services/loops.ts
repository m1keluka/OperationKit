// Loops engine — read/write surface for the personal "loops" tracker.
//
// A "loop" is a thread/task that moves through a 3-stage Kanban: queued -> working
// -> done. It is either a thread with a person ("waiting on Colin's signed contract",
// "owe Max the pricing breakdown") or a party-less personal to-do. Loops come from two
// sources: AUTO (the granola-intake session skill proposes candidate loops per meeting)
// and MANUAL (the "New loop" button in the CC UI).
//
// Storage is Mike-only second-brain markdown — one file per loop under
// workspaces/personal/loops/<slug>.md. This module READS those files for the
// admin UI and WRITES them on manual-add / edit / status-move. It is a SEPARATE
// stream from the granola-content engine: it never touches the drafts/hooks files
// nor the granola_processed_meetings / granola_action_items DB tables.
//
// This module owns the ENTIRE loop frontmatter schema, so writes re-serialize the
// frontmatter from a known canonical field order (FM_ORDER). The body (editable
// markdown) is preserved exactly across frontmatter edits; the frontmatter is
// preserved exactly across body edits.
//
// SCHEMA NOTE (r5 redesign, 2026-06-20): status enum changed open|closed ->
// queued|working|done. The `closed` frontmatter key is REUSED as the done-date
// (stamped when status=done, cleared otherwise) — we keep the key name for
// back-compat with pre-r5 files. New fields: `project` (single-select org axis)
// and `due` (optional due date). The `party` key is unchanged in storage but is
// labeled "People" in the UI. On READ, legacy status values are migrated in-memory
// (open->queued, closed->done); migrateLoopFiles() rewrites them on disk one-shot.
import fs from 'fs'
import path from 'path'

// host path == container path (bind-mounted, verified writable)
const VAULT_BASE = process.env.VAULT_PATH || '/home/operator/second-brain'
export const LOOPS_WORKSPACE = process.env.GRANOLA_WORKSPACE || 'personal'
const WS_ROOT = path.join(VAULT_BASE, 'workspaces', LOOPS_WORKSPACE)
const LOOPS_DIR = path.join(WS_ROOT, 'loops')

// `pending` is the pre-queue REVIEW lane: auto-detected (meeting) loops land here
// and must be APPROVED (moved to `queued`) or DENIED (archived) before they reach
// the active board. It is FIRST so it reads as the earliest stage. Only NEW auto
// loops are ever written `pending` (see granola-intake/loops-add.mjs) — every
// legacy/stored value still migrates to `queued` (normalizeStatus below), so the
// existing loop files are untouched by adding this lane.
export const LOOP_STATUSES = ['pending', 'queued', 'working', 'done'] as const
export type LoopStatus = (typeof LOOP_STATUSES)[number]
export const LOOP_PROJECTS = ['example', 'example2', 'shabo-dl', 'example-project', 'personal', ''] as const
export type LoopProject = (typeof LOOP_PROJECTS)[number]
export const PARTY_TYPES = ['team', 'client', ''] as const

// Canonical frontmatter key order for (re)serialization. `tags` is written as a
// single-line JSON flow array (valid YAML + JSON.parse-able) — same trick the
// granola-content `videos:` line uses, so the flat parser reads it as one scalar.
// `closed` holds the done-date (see SCHEMA NOTE above).
const FM_ORDER = [
  'title',
  'status',
  'project',
  'party',
  'party_type',
  'due',
  'tags',
  'source_meeting',
  'source_note',
  'opened',
  'closed',
] as const

export interface Loop {
  slug: string // basename without .md — the id used by the API
  title: string
  status: LoopStatus
  project: LoopProject // org axis: example | example2 | example-project | personal | ''
  party: string // "People" in the UI — who else is involved (optional)
  party_type: string // 'team' | 'client' | '' (legacy; not surfaced in r5 UI)
  due: string // YYYY-MM-DD or '' (optional)
  tags: string[]
  source_meeting: string // granola_id when auto, '' when manual
  source_note: string // workspace-relative path to the meeting note (auto only)
  opened: string // YYYY-MM-DD — the CREATED date
  closed: string // YYYY-MM-DD — the DONE date, set only when status=done
  body: string
}

// ── Minimal frontmatter parser (flat key: value; `tags` is JSON flow) ─────────
interface ParsedDoc {
  data: Record<string, string>
  body: string
}

function stripQuotes(v: string): string {
  const t = v.trim()
  // Scalars are written via JSON.stringify (serializeLoop), so a double-quoted value is a
  // JSON string — JSON.parse it so escaped inner quotes (\") unescape correctly rather than
  // leaking the backslash into the display. Fall back to a naive strip if it isn't valid JSON.
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t)
      if (typeof parsed === 'string') return parsed
    } catch {
      /* fall through */
    }
    if (t.endsWith('"')) return t.slice(1, -1)
  }
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1)
  return t
}

function parseFrontmatter(raw: string): ParsedDoc {
  const data: Record<string, string> = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) return { data, body: raw }
  const [, fm, body] = m
  for (const line of fm.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    // tags keeps its raw value (a JSON/flow array) for JSON.parse; others strip quotes.
    data[kv[1]] = kv[1] === 'tags' ? kv[2].trim() : stripQuotes(kv[2])
  }
  return { data, body: body.replace(/^\s+/, '') }
}

function parseTags(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) return arr.map(String).map(s => s.trim()).filter(Boolean)
  } catch {
    // tolerate a bare YAML flow list "[a, b]" without quotes
    const inner = raw.replace(/^\[/, '').replace(/\]$/, '')
    if (inner.trim()) return inner.split(',').map(s => stripQuotes(s).trim()).filter(Boolean)
  }
  return []
}

// Map any stored status value to the r5 enum. Legacy: open->queued, closed->done.
// `pending` is recognized EXPLICITLY only: a file literally stamped `status: pending`
// (produced solely by the updated loops-add.mjs for NEW auto-detected loops) reads as
// pending. Legacy/unknown values ('open', '', etc.) still collapse to `queued`, so the
// existing loop files never flip into the review lane.
function normalizeStatus(raw: string | undefined): LoopStatus {
  if (raw === 'pending') return 'pending'
  if (raw === 'working') return 'working'
  if (raw === 'done' || raw === 'closed') return 'done'
  // 'queued', 'open', '', anything else → queued (the default lane)
  return 'queued'
}

function normalizeProject(raw: string | undefined): LoopProject {
  return (LOOP_PROJECTS as readonly string[]).includes(raw || '') ? (raw as LoopProject) : ''
}

// Accept only a YYYY-MM-DD date; anything else collapses to '' (optional/unset).
function normalizeDate(raw: string | undefined): string {
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? raw.trim() : ''
}

function toLoop(slug: string, raw: string): Loop {
  const { data, body } = parseFrontmatter(raw)
  const status = normalizeStatus(data.status)
  return {
    slug,
    title: data.title || slug,
    status,
    project: normalizeProject(data.project),
    party: data.party || '',
    party_type: data.party_type === 'team' || data.party_type === 'client' ? data.party_type : '',
    due: normalizeDate(data.due),
    tags: parseTags(data.tags),
    source_meeting: data.source_meeting || '',
    source_note: data.source_note || '',
    opened: data.opened || '',
    // done-date lives in `closed` (reused key); only meaningful when status=done.
    closed: status === 'done' ? data.closed || data.opened || '' : '',
    body,
  }
}

// Serialize a Loop back to a full markdown file. We own the whole schema, so this
// is a clean canonical render (FM_ORDER), not a byte-for-byte preserve. `closed`
// (done-date) is only emitted when status=done; empty optional fields are omitted.
function serializeLoop(loop: Loop): string {
  const fields: Record<string, string> = {
    title: JSON.stringify(loop.title || loop.slug),
    status: loop.status,
    project: loop.project,
    party: JSON.stringify(loop.party || ''),
    party_type: loop.party_type,
    due: loop.due,
    tags: JSON.stringify(loop.tags || []),
    source_meeting: loop.source_meeting,
    source_note: loop.source_note,
    opened: loop.opened,
    closed: loop.status === 'done' ? loop.closed : '',
  }
  const lines: string[] = ['---']
  for (const key of FM_ORDER) {
    const val = fields[key]
    // Always emit the required spine; omit optional fields when empty.
    const required = key === 'title' || key === 'status' || key === 'party' || key === 'tags' || key === 'opened'
    if (!required && (val === undefined || val === '')) continue
    lines.push(`${key}: ${val}`)
  }
  lines.push('---')
  const body = (loop.body || '').replace(/\r\n/g, '\n').replace(/\s+$/, '')
  return `${lines.join('\n')}\n\n${body}\n`
}

// ── Slug + path helpers ───────────────────────────────────────────────────────
function kebab(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

// Stable key = party + normalized title. The deterministic filename IS the dedup
// key, so re-running auto-detection for the same commitment overwrites/skips rather
// than duplicating. Capped to keep filenames sane.
export function loopSlug(party: string, title: string): string {
  const p = kebab(party) || 'loop'
  const t = kebab(title) || 'untitled'
  return `${p}-${t}`.slice(0, 64).replace(/-+$/g, '')
}

function safeReaddir(): string[] {
  try {
    return fs.readdirSync(LOOPS_DIR).filter(f => f.endsWith('.md')).sort()
  } catch {
    return []
  }
}

// Validate a slug (prevent path traversal). Accepts a bare slug or `<slug>.md`;
// only a basename that resolves inside LOOPS_DIR is allowed. Returns abs path
// (which may not yet exist — caller decides) or null if the slug is malformed.
function resolveLoopPath(slug: string): string | null {
  const base = slug.endsWith('.md') ? slug : `${slug}.md`
  if (!/^[A-Za-z0-9._-]+\.md$/.test(base)) return null
  const abs = path.join(LOOPS_DIR, base)
  const rel = path.relative(LOOPS_DIR, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return abs
}

function readLoop(slug: string): Loop | null {
  const abs = resolveLoopPath(slug)
  if (!abs || !fs.existsSync(abs)) return null
  try {
    return toLoop(path.basename(abs).replace(/\.md$/, ''), fs.readFileSync(abs, 'utf8'))
  } catch {
    return null
  }
}

// ── One-shot disk migration (idempotent) ──────────────────────────────────────
// Rewrites any legacy-status (open|closed) loop file to the r5 schema (queued|done
// + empty project/due where absent). Safe on an empty dir and safe to re-run: a
// file already in canonical r5 form re-serializes to identical bytes, so we only
// write when the content actually changes. Called lazily once per process.
let migratedThisProcess = false
export function migrateLoopFiles(): { scanned: number; rewritten: number } {
  let scanned = 0
  let rewritten = 0
  for (const file of safeReaddir()) {
    scanned++
    const abs = path.join(LOOPS_DIR, file)
    let raw: string
    try {
      raw = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    const next = serializeLoop(toLoop(file.replace(/\.md$/, ''), raw))
    if (next !== raw) {
      try {
        fs.writeFileSync(abs, next, 'utf8')
        rewritten++
      } catch {
        /* leave the file as-is on a write error; reads still migrate in-memory */
      }
    }
  }
  return { scanned, rewritten }
}

// ── Public API ──────────────────────────────────────────────────────────────
export function listLoops(): Loop[] {
  if (!migratedThisProcess) {
    migrateLoopFiles()
    migratedThisProcess = true
  }
  const out: Loop[] = []
  for (const file of safeReaddir()) {
    let raw: string
    try {
      raw = fs.readFileSync(path.join(LOOPS_DIR, file), 'utf8')
    } catch {
      continue
    }
    out.push(toLoop(file.replace(/\.md$/, ''), raw))
  }
  // Newest activity first: done sort by done-date, others by opened; fall back to
  // opened. Non-done loops surface above done within the same date.
  out.sort((a, b) => {
    const da = a.status === 'done' ? a.closed || a.opened : a.opened
    const db = b.status === 'done' ? b.closed || b.opened : b.opened
    return (db || '').localeCompare(da || '')
  })
  return out
}

export interface LoopResult {
  ok: boolean
  error?: string
  loop?: Loop
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

// Manual "New loop": title required; party (People) OPTIONAL. New loops enter the
// `queued` lane, created today. project/due/tags optional. If a loop with the same
// stable slug already exists, append a numeric suffix so a manual add never clobbers
// an existing (possibly auto-created) loop.
export function createLoop(input: {
  party: string
  title: string
  project?: string
  due?: string
  tags?: string[]
  party_type?: string
}): LoopResult {
  const party = (input.party || '').trim()
  const title = (input.title || '').trim()
  if (!title) return { ok: false, error: 'title required' }

  fs.mkdirSync(LOOPS_DIR, { recursive: true })
  let slug = loopSlug(party, title)
  let abs = resolveLoopPath(slug)
  if (!abs) return { ok: false, error: 'could not derive a valid slug' }
  let n = 2
  while (fs.existsSync(abs)) {
    slug = `${loopSlug(party, title)}-${n++}`.slice(0, 70)
    abs = resolveLoopPath(slug)
    if (!abs) return { ok: false, error: 'could not derive a valid slug' }
  }

  const party_type = input.party_type === 'team' || input.party_type === 'client' ? input.party_type : ''
  const tags = Array.isArray(input.tags) ? input.tags.map(String).map(s => s.trim()).filter(Boolean) : []
  const loop: Loop = {
    slug,
    title,
    status: 'queued',
    project: normalizeProject(input.project),
    party,
    party_type,
    due: normalizeDate(input.due),
    tags,
    source_meeting: '',
    source_note: '',
    opened: todayISO(),
    closed: '',
    body: '',
  }
  fs.writeFileSync(abs, serializeLoop(loop), 'utf8')
  return { ok: true, loop }
}

// Edit the markdown body, preserving all frontmatter.
export function patchLoopBody(slug: string, newBody: string): LoopResult {
  if (typeof newBody !== 'string') return { ok: false, error: 'body must be a string' }
  const loop = readLoop(slug)
  if (!loop) return { ok: false, error: 'loop not found' }
  const abs = resolveLoopPath(slug)!
  const next = { ...loop, body: newBody }
  fs.writeFileSync(abs, serializeLoop(next), 'utf8')
  return { ok: true, loop: next }
}

// Move across lanes queued|working|done. Moving to `done` stamps `closed: <today>`
// (the done-date), preserving an existing one; moving off `done` clears it.
export function patchLoopStatus(slug: string, newStatus: string): LoopResult {
  if (!(LOOP_STATUSES as readonly string[]).includes(newStatus)) {
    return { ok: false, error: `invalid status '${newStatus}' (allowed: ${LOOP_STATUSES.join(', ')})` }
  }
  const loop = readLoop(slug)
  if (!loop) return { ok: false, error: 'loop not found' }
  const abs = resolveLoopPath(slug)!
  const status = newStatus as LoopStatus
  const next: Loop = {
    ...loop,
    status,
    closed: status === 'done' ? loop.closed || todayISO() : '',
  }
  fs.writeFileSync(abs, serializeLoop(next), 'utf8')
  return { ok: true, loop: next }
}

// Change project / due / party (People) / party_type and/or replace the tag set.
// Only provided fields change.
export function patchLoopMeta(
  slug: string,
  input: { project?: string; due?: string; party?: string; party_type?: string; tags?: string[] },
): LoopResult {
  const loop = readLoop(slug)
  if (!loop) return { ok: false, error: 'loop not found' }
  const abs = resolveLoopPath(slug)!
  const next: Loop = { ...loop }
  if (typeof input.project === 'string') {
    next.project = normalizeProject(input.project)
  }
  if (typeof input.due === 'string') {
    next.due = normalizeDate(input.due)
  }
  if (typeof input.party === 'string') {
    // party (People) is optional — allow clearing it.
    next.party = input.party.trim()
  }
  if (typeof input.party_type === 'string') {
    next.party_type = input.party_type === 'team' || input.party_type === 'client' ? input.party_type : ''
  }
  if (Array.isArray(input.tags)) {
    next.tags = input.tags.map(String).map(s => s.trim()).filter(Boolean)
  }
  // NOTE: party change does NOT rename the file (slug is stable post-creation) — the
  // slug is an opaque id once created; the displayed party comes from frontmatter.
  fs.writeFileSync(abs, serializeLoop(next), 'utf8')
  return { ok: true, loop: next }
}

// Archive dir — sibling of LOOPS_DIR. "Removing" a loop MOVES it here (never a hard
// delete), so it drops off the board (listLoops only reads LOOPS_DIR, non-recursively)
// while staying fully recoverable.
const LOOPS_ARCHIVE_DIR = path.join(WS_ROOT, 'loops-archive')

// Move a loop out of the active set. Reversible: the file lands in loops-archive/.
export function archiveLoop(slug: string): LoopResult {
  const abs = resolveLoopPath(slug)
  if (!abs || !fs.existsSync(abs)) return { ok: false, error: 'loop not found' }
  const loop = readLoop(slug)
  fs.mkdirSync(LOOPS_ARCHIVE_DIR, { recursive: true })
  let dest = path.join(LOOPS_ARCHIVE_DIR, path.basename(abs))
  if (fs.existsSync(dest)) {
    // Don't clobber a previously-archived loop with the same slug.
    dest = path.join(LOOPS_ARCHIVE_DIR, path.basename(abs).replace(/\.md$/, `-${Date.now()}.md`))
  }
  fs.renameSync(abs, dest)
  return { ok: true, loop: loop ?? undefined }
}
