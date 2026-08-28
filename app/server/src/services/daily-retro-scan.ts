/**
 * Daily Session Retrospective transcript scan and candidate detection —
 * extracted from daily-retro.ts (behavior frozen).
 *
 * No lens calls, no board posts. The review gate stays in daily-retro-gate.ts.
 */
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import type { Database } from 'better-sqlite3'
import { getDb } from '../db/index.js'
import {
  classifyFollowup,
  isCorrective,
  claimsCompletion,
  isSelfCorrection,
  mentionsPath,
  isHarnessNoise,
  normalizeAnchor,
  fingerprint,
  scoreSignal,
  type SignalType,
} from './daily-retro.detect.js'
import {
  DSR_ORIGIN,
  DSR_PROJECT,
  TRANSCRIPT_DIR,
  WINDOW_RADIUS,
  MAX_LINES_PER_TRANSCRIPT,
  MAX_LINE_CHARS,
  loadConfig,
  type RetroConfig,
  type RetroCandidate,
} from './daily-retro-config.js'

// ── Tier 1: transcript structural scan ───────────────────────────────────────

interface TranscriptLine {
  i: number
  kind: 'followup' | 'assistant' | 'user' | 'tool_error' | 'other'
  text: string
}

interface TranscriptScan {
  lines: TranscriptLine[]
  followups: TranscriptLine[]
  toolErrors: TranscriptLine[]
  assistants: TranscriptLine[]
  /** Followups classified neither auto nor human-corrective — the drift counter. */
  unclassified: number
  hasEditAfter: (i: number, within: number) => boolean
}

function extractText(obj: unknown): string {
  // Transcript payloads are heterogeneous across event types; pull whatever
  // human-readable text is present without asserting a single shape.
  const o = obj as Record<string, unknown>
  if (!o) return ''
  if (typeof o.text === 'string') return o.text
  if (typeof o.content === 'string') return o.content
  if (typeof o.prompt === 'string') return o.prompt
  if (typeof o.message === 'string') return o.message
  const msg = o.message as Record<string, unknown> | undefined
  if (msg && Array.isArray(msg.content)) {
    return (msg.content as Array<Record<string, unknown>>)
      .map(b => (typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  if (Array.isArray(o.content)) {
    return (o.content as Array<Record<string, unknown>>)
      .map(b => (typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function collectToolErrors(obj: unknown): string[] {
  const out: string[] = []
  const walkBlocks = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b && b.type === 'tool_result' && b.is_error === true) {
        const c = b.content
        out.push(typeof c === 'string' ? c : JSON.stringify(c ?? ''))
      }
    }
  }
  const o = obj as Record<string, unknown>
  if (!o) return out
  walkBlocks(o.content)
  const msg = o.message as Record<string, unknown> | undefined
  if (msg) walkBlocks(msg.content)
  return out
}

function isEditTool(obj: unknown): boolean {
  const names = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
  const walk = (blocks: unknown): boolean => {
    if (!Array.isArray(blocks)) return false
    return (blocks as Array<Record<string, unknown>>).some(
      b => b && b.type === 'tool_use' && typeof b.name === 'string' && names.has(b.name),
    )
  }
  const o = obj as Record<string, unknown>
  if (!o) return false
  if (walk(o.content)) return true
  const msg = o.message as Record<string, unknown> | undefined
  return msg ? walk(msg.content) : false
}

/**
 * Stream one transcript, keeping ONLY what the detector needs. Line text is
 * truncated to MAX_LINE_CHARS and the line count is capped, so a pathological
 * 4 MB transcript cannot blow the heap — the audit measured ~90 MB/day across
 * 324 files and this pass must stay disk-bound, not memory-bound.
 */
export async function scanTranscript(filePath: string): Promise<TranscriptScan> {
  const lines: TranscriptLine[] = []
  const followups: TranscriptLine[] = []
  const toolErrors: TranscriptLine[] = []
  const assistants: TranscriptLine[] = []
  const editLineIdx: number[] = []
  let unclassified = 0

  let stream: fs.ReadStream
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  } catch {
    return { lines, followups, toolErrors, assistants, unclassified, hasEditAfter: () => false }
  }

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let i = 0
  try {
    for await (const raw of rl) {
      if (i >= MAX_LINES_PER_TRANSCRIPT) break
      const idx = i++
      if (!raw.trim()) continue
      let obj: unknown
      try {
        obj = JSON.parse(raw)
      } catch {
        continue
      }
      const type = (obj as Record<string, unknown>).type
      const text = extractText(obj).slice(0, MAX_LINE_CHARS)

      if (type === 'followup') {
        const rec: TranscriptLine = { i: idx, kind: 'followup', text }
        lines.push(rec)
        followups.push(rec)
        const cls = classifyFollowup(text)
        // "Unclassified" = plausibly human but WITHOUT corrective phrasing. A
        // spike here means a new automated prefix is leaking through the AUTO
        // list and is about to become false "human corrections" (risk D.6-1).
        if (cls === 'human' && !isCorrective(text)) unclassified++
        continue
      }

      const errs = collectToolErrors(obj)
      for (const e of errs) {
        const rec: TranscriptLine = { i: idx, kind: 'tool_error', text: e.slice(0, MAX_LINE_CHARS) }
        lines.push(rec)
        toolErrors.push(rec)
      }

      if (type === 'assistant') {
        const rec: TranscriptLine = { i: idx, kind: 'assistant', text }
        lines.push(rec)
        assistants.push(rec)
        if (isEditTool(obj)) editLineIdx.push(idx)
        continue
      }

      if (text) lines.push({ i: idx, kind: type === 'user' ? 'user' : 'other', text })
    }
  } finally {
    rl.close()
    stream.destroy()
  }

  const hasEditAfter = (at: number, within: number) =>
    editLineIdx.some(e => e > at && e - at <= within)

  return { lines, followups, toolErrors, assistants, unclassified, hasEditAfter }
}

/** Build the ±WINDOW_RADIUS evidence window around a line index. */
export function buildWindow(scan: TranscriptScan, at: number): string {
  const pos = scan.lines.findIndex(l => l.i === at)
  if (pos < 0) return ''
  const from = Math.max(0, pos - WINDOW_RADIUS)
  const to = Math.min(scan.lines.length, pos + WINDOW_RADIUS + 1)
  return scan.lines
    .slice(from, to)
    .map(l => `[${l.i}] ${l.kind}: ${l.text.replace(/\s+/g, ' ').slice(0, 400)}`)
    .join('\n')
}

// ── Detection ────────────────────────────────────────────────────────────────

interface SessionRow {
  session_id: string
  objective_id: number
  ended_at: string
  outcome: string | null
  origin: string | null
  ai_review_iteration: number | null
}

export interface DetectOptions {
  db?: Database
  env?: NodeJS.ProcessEnv
  day: string
  since?: string | null
  transcriptDir?: string
  config?: RetroConfig
}

export interface DetectResult {
  candidates: RetroCandidate[]
  sessions_scanned: number
  raw_signals: number
  unclassified_followups: number
  newest_ended_at: string | null
}

/**
 * The three-tier read. Returns EVERY raw candidate (pre-floor, pre-ledger) plus
 * the counters the run row needs. Merging by fingerprint happens here: the same
 * defect hit by five workers collapses to one candidate with recurrence=5,
 * which is a booster rather than five near-duplicate objectives.
 */
export async function detectCandidates(opts: DetectOptions): Promise<DetectResult> {
  const db = opts.db ?? getDb()
  const cfg = opts.config ?? loadConfig(db, opts.env)
  const dir = opts.transcriptDir ?? TRANSCRIPT_DIR
  const chatSet = new Set(cfg.chatObjectives)

  // ── Tier 0: SQL ────────────────────────────────────────────────────────────
  // Self-exclusion: a source objective with origin='retro' is never a source —
  // no recursive self-flagellation (§C.3).
  const sessions = db
    .prepare(
      `SELECT si.session_id, si.objective_id, si.ended_at, si.outcome,
              o.origin, o.ai_review_iteration
         FROM session_intel si
         JOIN objectives o ON o.id = si.objective_id
        WHERE date(si.ended_at) = ?
          AND (o.origin IS NULL OR o.origin != ?)
          AND (? IS NULL OR si.ended_at > ?)
        ORDER BY si.ended_at ASC`,
    )
    .all(opts.day, DSR_ORIGIN, opts.since ?? null, opts.since ?? null) as SessionRow[]

  const byFingerprint = new Map<string, RetroCandidate>()
  let rawSignals = 0
  let unclassified = 0
  let newestEndedAt: string | null = null

  const add = (c: RetroCandidate) => {
    rawSignals++
    const existing = byFingerprint.get(c.fingerprint)
    if (!existing) {
      byFingerprint.set(c.fingerprint, c)
      return
    }
    existing.recurrence++
    // Keep the strongest evidence window; recurrence is itself a signal, so a
    // later occurrence must never weaken a candidate.
    if (c.confidence > existing.confidence) {
      existing.confidence = c.confidence
      existing.excerpt = c.excerpt
      existing.window = c.window
      existing.source_objective_id = c.source_objective_id
      existing.source_session_id = c.source_session_id
      existing.transcript_path = c.transcript_path
    }
  }

  // D4 — review failures for the day.
  const reviewFails = db
    .prepare(
      `SELECT r.objective_id, r.mode, r.verdict, r.markdown_body, o.title
         FROM objective_reviews r
         JOIN objectives o ON o.id = r.objective_id
        WHERE date(r.created_at) = ?
          AND r.verdict IN ('fail','blocked')
          AND (o.origin IS NULL OR o.origin != ?)`,
    )
    .all(opts.day, DSR_ORIGIN) as Array<{
      objective_id: number
      mode: string | null
      verdict: string
      markdown_body: string | null
      title: string
    }>
  const failCountByObjective = new Map<number, number>()
  for (const r of reviewFails) failCountByObjective.set(r.objective_id, (failCountByObjective.get(r.objective_id) ?? 0) + 1)
  for (const r of reviewFails) {
    const excerpt = `[${r.verdict}/${r.mode ?? 'doc'}] ${r.title} — ${(r.markdown_body ?? '').replace(/\s+/g, ' ').slice(0, 400)}`
    add({
      fingerprint: fingerprint(DSR_PROJECT, 'review_failure', excerpt),
      signal_type: 'review_failure',
      confidence: scoreSignal('review_failure', {
        browserReview: r.mode === 'browser',
        extraFailedIterations: Math.max(0, (failCountByObjective.get(r.objective_id) ?? 1) - 1),
      }),
      recurrence: 1,
      source_objective_id: r.objective_id,
      source_session_id: null,
      transcript_path: null,
      excerpt,
      window: excerpt,
    })
  }

  // D6 — escalations: blockers repeating across objectives on the day.
  const blockerRows = db
    .prepare(
      `SELECT description, objective_id
         FROM session_events
        WHERE event_type IN ('blocker','error') AND date(created_at) = ?`,
    )
    .all(opts.day) as Array<{ description: string | null; objective_id: number }>
  const blockerGroups = new Map<string, { sample: string; objectives: Set<number> }>()
  for (const b of blockerRows) {
    if (!b.description) continue
    const key = normalizeAnchor(b.description)
    if (!key) continue
    let g = blockerGroups.get(key)
    if (!g) {
      g = { sample: b.description.trim(), objectives: new Set() }
      blockerGroups.set(key, g)
    }
    g.objectives.add(b.objective_id)
  }
  for (const g of blockerGroups.values()) {
    if (g.objectives.size < 2) continue // §C.2 D6 requires >=2 distinct objectives
    const excerpt = g.sample.slice(0, 400)
    add({
      fingerprint: fingerprint(DSR_PROJECT, 'escalation', excerpt),
      signal_type: 'escalation',
      confidence: scoreSignal('escalation', { recurrenceAcrossObjectives: g.objectives.size }),
      recurrence: g.objectives.size,
      source_objective_id: [...g.objectives][0] ?? null,
      source_session_id: null,
      transcript_path: null,
      excerpt,
      window: excerpt,
    })
  }

  // ── Tier 1: transcript structural scan, per session ────────────────────────
  let scanned = 0
  for (const s of sessions) {
    if (!newestEndedAt || s.ended_at > newestEndedAt) newestEndedAt = s.ended_at
    const tp = path.join(dir, `${s.session_id}.jsonl`)
    if (!fs.existsSync(tp)) continue
    scanned++
    const scan = await scanTranscript(tp)
    unclassified += scan.unclassified
    const isChat = chatSet.has(s.objective_id)

    // D1 — human corrections (the channel no existing CC component reads).
    for (const f of scan.followups) {
      if (classifyFollowup(f.text) !== 'human') continue
      if (!isCorrective(f.text)) continue
      const prevAssistant = [...scan.assistants].reverse().find(a => a.i < f.i)
      const conf = scoreSignal('human_correction', {
        afterCompletionClaim: !!prevAssistant && claimsCompletion(prevAssistant.text),
        namesPath: mentionsPath(f.text),
        chatObjective: isChat,
      })
      const excerpt = f.text.slice(0, 400)
      add({
        fingerprint: fingerprint(DSR_PROJECT, 'human_correction', excerpt),
        signal_type: 'human_correction',
        confidence: conf,
        recurrence: 1,
        source_objective_id: s.objective_id,
        source_session_id: s.session_id,
        transcript_path: tp,
        excerpt,
        window: buildWindow(scan, f.i),
      })

      // D5 — an "## AI Review Findings" followup is an iterate loop.
      if (/^## AI Review Findings/.test(f.text.trim())) {
        const it = s.ai_review_iteration ?? 0
        const ex = f.text.slice(0, 400)
        add({
          fingerprint: fingerprint(DSR_PROJECT, 'iterate_loop', ex),
          signal_type: 'iterate_loop',
          confidence: scoreSignal('iterate_loop', { deepIteration: it >= 3 }),
          recurrence: 1,
          source_objective_id: s.objective_id,
          source_session_id: s.session_id,
          transcript_path: tp,
          excerpt: ex,
          window: buildWindow(scan, f.i),
        })
      }

      // D7 — max-turns truncation. Recorded, never promoted alone (capped
      // below the floor by scoreSignal).
      if (/reached maximum number of turns/i.test(f.text) || /^AUTO-RESUME:/.test(f.text.trim())) {
        const ex = f.text.slice(0, 200)
        add({
          fingerprint: fingerprint(DSR_PROJECT, 'max_turns_truncation', ex),
          signal_type: 'max_turns_truncation',
          confidence: scoreSignal('max_turns_truncation'),
          recurrence: 1,
          source_objective_id: s.objective_id,
          source_session_id: s.session_id,
          transcript_path: tp,
          excerpt: ex,
          window: '',
        })
      }
    }

    // Auto followups still carry D5/D7 signal even though they are not D1.
    for (const f of scan.followups) {
      if (classifyFollowup(f.text) !== 'auto') continue
      const t = f.text.trim()
      if (/^## AI Review Findings/.test(t)) {
        const it = s.ai_review_iteration ?? 0
        const ex = t.slice(0, 400)
        add({
          fingerprint: fingerprint(DSR_PROJECT, 'iterate_loop', ex),
          signal_type: 'iterate_loop',
          confidence: scoreSignal('iterate_loop', { deepIteration: it >= 3 }),
          recurrence: 1,
          source_objective_id: s.objective_id,
          source_session_id: s.session_id,
          transcript_path: tp,
          excerpt: ex,
          window: buildWindow(scan, f.i),
        })
      } else if (/reached maximum number of turns/i.test(t) || /^AUTO-RESUME:/.test(t)) {
        const ex = t.slice(0, 200)
        add({
          fingerprint: fingerprint(DSR_PROJECT, 'max_turns_truncation', ex),
          signal_type: 'max_turns_truncation',
          confidence: scoreSignal('max_turns_truncation'),
          recurrence: 1,
          source_objective_id: s.objective_id,
          source_session_id: s.session_id,
          transcript_path: tp,
          excerpt: ex,
          window: '',
        })
      }
    }

    // D2 — agent self-corrections that produced REAL rework.
    for (const a of scan.assistants) {
      if (!isSelfCorrection(a.text)) continue
      const excerpt = a.text.slice(0, 400)
      add({
        fingerprint: fingerprint(DSR_PROJECT, 'agent_self_correction', excerpt),
        signal_type: 'agent_self_correction',
        confidence: scoreSignal('agent_self_correction', { followedByEdit: scan.hasEditAfter(a.i, 5) }),
        recurrence: 1,
        source_objective_id: s.objective_id,
        source_session_id: s.session_id,
        transcript_path: tp,
        excerpt,
        window: buildWindow(scan, a.i),
      })
    }

    // D3 — tool errors. Repetition within the session is what separates a
    // stuck loop from a probe, so count normalized repeats first.
    const errCounts = new Map<string, number>()
    for (const e of scan.toolErrors) {
      const k = normalizeAnchor(e.text)
      errCounts.set(k, (errCounts.get(k) ?? 0) + 1)
    }
    // The §C.2 "last tool call before session end" booster is about the ERROR,
    // not one instance of it: a loop that repeats the same failure until the
    // session dies must still get the booster even though we keep only the
    // first occurrence as the candidate. So compare normalized keys, not indices.
    const lastErrKey = scan.toolErrors.length ? normalizeAnchor(scan.toolErrors[scan.toolErrors.length - 1].text) : null
    const seenErrKeys = new Set<string>()
    for (const e of scan.toolErrors) {
      const k = normalizeAnchor(e.text)
      if (seenErrKeys.has(k)) continue
      seenErrKeys.add(k)
      const excerpt = e.text.slice(0, 400)
      add({
        fingerprint: fingerprint(DSR_PROJECT, 'tool_error', excerpt),
        signal_type: 'tool_error',
        confidence: scoreSignal('tool_error', {
          repeatedInSession: (errCounts.get(k) ?? 0) >= 3,
          lastBeforeEnd: k === lastErrKey,
          harnessNoise: isHarnessNoise(e.text),
        }),
        recurrence: errCounts.get(k) ?? 1,
        source_objective_id: s.objective_id,
        source_session_id: s.session_id,
        transcript_path: tp,
        excerpt,
        window: buildWindow(scan, e.i),
      })
    }

    // D6 — session-level escalation from a self-reported bad outcome.
    if (s.outcome === 'failed' || s.outcome === 'blocked') {
      const excerpt = `session ${s.session_id} reported outcome=${s.outcome}`
      add({
        fingerprint: fingerprint(DSR_PROJECT, 'escalation', excerpt),
        signal_type: 'escalation',
        confidence: scoreSignal('escalation'),
        recurrence: 1,
        source_objective_id: s.objective_id,
        source_session_id: s.session_id,
        transcript_path: tp,
        excerpt,
        window: buildWindow(scan, 0),
      })
    }
  }

  return {
    candidates: [...byFingerprint.values()],
    sessions_scanned: scanned,
    raw_signals: rawSignals,
    unclassified_followups: unclassified,
    newest_ended_at: newestEndedAt,
  }
}

