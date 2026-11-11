/**
 * Live card progress (obj 715699).
 *
 * Workers write structured snapshots ("step N of M", label, short note, partial
 * result, artifact refs) as they go; bots read the latest snapshot plus a paged
 * event list through GET /api/objectives/:id/progress. When a worker writes
 * nothing, coarse progress is DERIVED from its transcript (last tool call, last
 * assistant message, turn count, elapsed time) so "how's it going" always has an
 * answer. A parent card's view also rolls up its children's latest progress and
 * final results (the fan-out aggregation).
 *
 * Everything written or served here passes through `redactLive` — a progress note
 * is worker prose and can quote an env var as easily as a transcript can.
 */
import fs from 'fs'
import path from 'path'
import type { Database } from 'better-sqlite3'
import { initLiveProgressSchema } from '../db/schema/live-progress.js'
import { redactLive, redactLiveText } from './live-redaction.js'
import { TRANSCRIPT_DIR } from '../config.js'

export const MAX_LABEL = 200
export const MAX_NOTE = 2000
export const MAX_RESULT = 4000
export const MAX_ARTIFACTS = 20
export const MAX_ARTIFACT_REF = 300
export const DEFAULT_EVENT_LIMIT = 20
export const MAX_EVENT_LIMIT = 100

let ready = new WeakSet<object>()
function ensure(db: Database): void {
  if (ready.has(db)) return
  initLiveProgressSchema(db as never)
  ready.add(db)
}
export function __resetProgressSchemaCache(): void {
  ready = new WeakSet<object>()
}

export interface ProgressInput {
  session_id?: unknown
  step?: unknown
  total_steps?: unknown
  label?: unknown
  note?: unknown
  result?: unknown
  artifacts?: unknown
}

export interface ProgressEvent {
  id: number
  objective_id: number
  session_id: string | null
  step: number | null
  total_steps: number | null
  label: string | null
  note: string | null
  result: string | null
  artifacts: string[]
  source: string
  created_at: string
}

interface ProgressRow extends Omit<ProgressEvent, 'artifacts'> {
  artifacts: string | null
}

function toEvent(row: ProgressRow): ProgressEvent {
  let artifacts: string[] = []
  try {
    const parsed = row.artifacts ? JSON.parse(row.artifacts) : []
    if (Array.isArray(parsed)) artifacts = parsed.filter(a => typeof a === 'string')
  } catch { /* corrupt row → no refs */ }
  // Redact on READ too: rows written before a secret was added to the env still
  // get scrubbed against today's values.
  return {
    ...row,
    label: redactLiveText(row.label),
    note: redactLiveText(row.note),
    result: redactLiveText(row.result),
    artifacts,
  }
}

function optInt(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new ProgressValidationError(`${field} must be a non-negative integer`)
  return n
}

function optText(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null
  // Partial results may be structured — store them as JSON text.
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  if (s === undefined) throw new ProgressValidationError(`${field} is not serializable`)
  const trimmed = s.trim()
  if (!trimmed) return null
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export class ProgressValidationError extends Error {}

/** Validate + normalize a worker's progress payload. Throws ProgressValidationError. */
export function normalizeProgressInput(input: ProgressInput): Omit<ProgressEvent, 'id' | 'objective_id' | 'source' | 'created_at'> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProgressValidationError('body must be an object')
  }
  const step = optInt(input.step, 'step')
  const total = optInt(input.total_steps, 'total_steps')
  if (step !== null && total !== null && total > 0 && step > total) {
    throw new ProgressValidationError('step cannot exceed total_steps')
  }
  const label = optText(input.label, 'label', MAX_LABEL)
  const note = optText(input.note, 'note', MAX_NOTE)
  const result = optText(input.result, 'result', MAX_RESULT)
  let artifacts: string[] = []
  if (input.artifacts !== undefined && input.artifacts !== null) {
    if (!Array.isArray(input.artifacts)) throw new ProgressValidationError('artifacts must be an array of strings')
    if (input.artifacts.length > MAX_ARTIFACTS) throw new ProgressValidationError(`at most ${MAX_ARTIFACTS} artifacts per event`)
    artifacts = input.artifacts.map((a, i) => {
      if (typeof a !== 'string' || !a.trim()) throw new ProgressValidationError(`artifacts[${i}] must be a non-empty string`)
      return a.trim().slice(0, MAX_ARTIFACT_REF)
    })
  }
  if (step === null && !label && !note && !result && artifacts.length === 0) {
    throw new ProgressValidationError('provide at least one of step, label, note, result, artifacts')
  }
  const sessionId = typeof input.session_id === 'string' && input.session_id.trim() ? input.session_id.trim().slice(0, 120) : null
  return { session_id: sessionId, step, total_steps: total, label, note, result, artifacts }
}

export function recordProgress(
  db: Database,
  objectiveId: number,
  input: ProgressInput,
  source: 'worker' | 'api' = 'worker',
): ProgressEvent {
  ensure(db)
  const n = normalizeProgressInput(input)
  const info = db
    .prepare(
      `INSERT INTO objective_progress (objective_id, session_id, step, total_steps, label, note, result, artifacts, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      objectiveId,
      n.session_id,
      n.step,
      n.total_steps,
      // Redact on WRITE so the stored row never holds the raw value.
      redactLiveText(n.label),
      redactLiveText(n.note),
      redactLiveText(n.result),
      n.artifacts.length ? JSON.stringify(n.artifacts) : null,
      source,
    )
  return toEvent(db.prepare('SELECT * FROM objective_progress WHERE id = ?').get(info.lastInsertRowid) as ProgressRow)
}

export interface ProgressPage {
  events: ProgressEvent[]
  total: number
  next_before: number | null
}

/** Events newest-first; `before` is an event id cursor (exclusive). */
export function listProgress(db: Database, objectiveId: number, opts: { limit?: number; before?: number | null } = {}): ProgressPage {
  ensure(db)
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_EVENT_LIMIT, MAX_EVENT_LIMIT))
  const before = opts.before && opts.before > 0 ? opts.before : null
  const rows = db
    .prepare(
      `SELECT * FROM objective_progress WHERE objective_id = ? ${before ? 'AND id < ?' : ''}
        ORDER BY id DESC LIMIT ?`,
    )
    .all(...(before ? [objectiveId, before, limit + 1] : [objectiveId, limit + 1])) as ProgressRow[]
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit).map(toEvent)
  const total = (db.prepare('SELECT COUNT(*) AS c FROM objective_progress WHERE objective_id = ?').get(objectiveId) as { c: number }).c
  return { events: page, total, next_before: hasMore ? page[page.length - 1].id : null }
}

export function latestProgress(db: Database, objectiveId: number): ProgressEvent | null {
  ensure(db)
  const row = db.prepare('SELECT * FROM objective_progress WHERE objective_id = ? ORDER BY id DESC LIMIT 1').get(objectiveId) as ProgressRow | undefined
  return row ? toEvent(row) : null
}

// ── Transcript fallback ────────────────────────────────────────────────────

export interface DerivedProgress {
  source: 'transcript'
  session_id: string
  last_tool: { name: string; summary: string | null } | null
  last_assistant_message: string | null
  assistant_turns: number
  tool_calls: number
  num_turns: number | null
  last_event_at: string | null
  elapsed_seconds: number | null
  scanned_bytes: number
  truncated: boolean
}

const TAIL_BYTES = 2_000_000
const MAX_ASSISTANT_TEXT = 500
const MAX_TOOL_SUMMARY = 200

function summarizeToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const pick = o.description ?? o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.prompt
  const s = typeof pick === 'string' ? pick : JSON.stringify(o)
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_TOOL_SUMMARY ? `${oneLine.slice(0, MAX_TOOL_SUMMARY - 1)}…` : oneLine
}

/**
 * PURE: derive coarse progress from Claude CLI stream-json transcript text.
 * Only main-loop assistant events count (sub-agent sidechains are noise here).
 */
export function deriveProgressFromJsonl(
  text: string,
): Omit<DerivedProgress, 'source' | 'session_id' | 'elapsed_seconds' | 'scanned_bytes' | 'truncated' | 'last_event_at'> {
  let lastTool: DerivedProgress['last_tool'] = null
  let lastText: string | null = null
  let assistantTurns = 0
  let toolCalls = 0
  let numTurns: number | null = null
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev: Record<string, unknown>
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'assistant') {
      if (ev.parent_tool_use_id || ev.isSidechain) continue
      const content = (ev.message as { content?: unknown })?.content
      if (!Array.isArray(content)) continue
      assistantTurns++
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          toolCalls++
          lastTool = { name: block.name, summary: summarizeToolInput(block.input) }
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          lastText = block.text.trim()
        }
      }
    } else if (ev.type === 'result' && typeof ev.num_turns === 'number') {
      numTurns = ev.num_turns
    }
  }
  if (lastText && lastText.length > MAX_ASSISTANT_TEXT) lastText = `${lastText.slice(0, MAX_ASSISTANT_TEXT - 1)}…`
  if (lastTool?.summary) lastTool = { ...lastTool, summary: redactLive(lastTool.summary).text }
  return {
    last_tool: lastTool,
    last_assistant_message: lastText ? redactLive(lastText).text : null,
    assistant_turns: assistantTurns,
    tool_calls: toolCalls,
    num_turns: numTurns,
  }
}

function readTail(file: string, bytes: number): { text: string; size: number; truncated: boolean } {
  const fd = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    // Drop the partial first line of a mid-file window.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { text, size, truncated: start > 0 }
  } finally {
    fs.closeSync(fd)
  }
}

export function deriveTranscriptProgress(
  sessionId: string | null | undefined,
  opts: { transcriptDir?: string; startedAtMs?: number | null; now?: number } = {},
): DerivedProgress | null {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null
  const file = path.join(opts.transcriptDir ?? TRANSCRIPT_DIR, `${sessionId}.jsonl`)
  let stat: fs.Stats
  try { stat = fs.statSync(file) } catch { return null }
  const { text, size, truncated } = readTail(file, TAIL_BYTES)
  const now = opts.now ?? Date.now()
  const started = opts.startedAtMs ?? null
  return {
    source: 'transcript',
    session_id: sessionId,
    ...deriveProgressFromJsonl(text),
    last_event_at: stat.mtime.toISOString(),
    elapsed_seconds: started ? Math.max(0, Math.round((now - started) / 1000)) : null,
    scanned_bytes: Math.min(size, TAIL_BYTES),
    truncated,
  }
}

// ── Children roll-up (fan-out aggregation) ────────────────────────────────

export interface ChildProgress {
  id: number
  title: string
  status: string
  workspace: string
  ai_review_verdict: string | null
  pr_url: string | null
  updated_at: string
  latest: ProgressEvent | null
  /** Final result once the child is past `working` — its last session summary. */
  result: string | null
}

export interface ChildrenRollup {
  total: number
  by_status: Record<string, number>
  done: number
  items: ChildProgress[]
}

const MAX_CHILD_RESULT = 1000

export function summarizeChildren(
  db: Database,
  parentId: number,
  canSee: (child: { workspace: string; id: number }) => boolean = () => true,
): ChildrenRollup {
  ensure(db)
  const rows = db
    .prepare(
      `SELECT id, title, status, workspace, ai_review_verdict, pr_url, updated_at, last_session_summary,
              created_by, assigned_user_id
         FROM objectives WHERE parent_id = ? ORDER BY id ASC LIMIT 200`,
    )
    .all(parentId) as Array<ChildProgress & { last_session_summary: string | null }>
  const items: ChildProgress[] = []
  const byStatus: Record<string, number> = {}
  for (const r of rows) {
    if (!canSee(r)) continue
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    const summary = r.status === 'working' || r.status === 'queue' ? null : redactLiveText(r.last_session_summary)
    items.push({
      id: r.id,
      title: r.title,
      status: r.status,
      workspace: r.workspace,
      ai_review_verdict: r.ai_review_verdict,
      pr_url: r.pr_url,
      updated_at: r.updated_at,
      latest: latestProgress(db, r.id),
      result: summary && summary.length > MAX_CHILD_RESULT ? `${summary.slice(0, MAX_CHILD_RESULT - 1)}…` : summary,
    })
  }
  return { total: items.length, by_status: byStatus, done: byStatus.done ?? 0, items }
}
