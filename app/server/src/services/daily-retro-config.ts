/**
 * Daily Session Retrospective flags, config, and types — extracted from
 * daily-retro.ts (behavior frozen).
 *
 * No transcript IO, no lens calls, no board posts. Detection and the run
 * stay in daily-retro-scan.ts / daily-retro.ts.
 */
import type { Database } from 'better-sqlite3'
import { DEFAULT_MIN_CONFIDENCE, type SignalType } from './daily-retro.detect.js'

// ── Constants ────────────────────────────────────────────────────────────────

export const DSR_PROJECT = 'command-center-infra'
export const DSR_ORIGIN = 'retro'
export const TRANSCRIPT_DIR = '/home/operator/transcripts'
/** Statuses that count as an OPEN retro objective for the WIP brake. */
export const OPEN_STATUSES = ['planning', 'queue', 'working', 'ai_review', 'review'] as const
/** ±N transcript lines handed to a lens as the evidence window. */
export const WINDOW_RADIUS = 20
/** Hard ceiling on lines parsed from one transcript (memory guard). */
export const MAX_LINES_PER_TRANSCRIPT = 40_000
/** Chars of any one line retained for the window (a full line can be ~1 MB). */
export const MAX_LINE_CHARS = 800

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

// ── Feature flags — env overrides settings, fail-closed ──────────────────────
// Copied in shape from kitchen-loop.ts:40-91 deliberately: one flag idiom in
// this codebase, one place to reason about "is it armed?".

function envFlagOn(env: NodeJS.ProcessEnv, name: string): boolean {
  return TRUE_VALUES.has((env[name] || '').toLowerCase())
}

function settingOn(db: Database, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

/** Detection + lens gate armed? OFF by default. */
export function isRetroEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_DSR_ENABLED')) return true
  return settingOn(db, 'dsr_enabled')
}

/**
 * Objective CREATION armed? OFF by default. This is the Operator-gated cutover —
 * no worker flips it. Note the caller must ALSO satisfy the parent-objective
 * requirement (see resolveParentObjectiveId): live without a parent is refused.
 */
export function isRetroLive(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_DSR_LIVE')) return true
  return settingOn(db, 'dsr_live')
}

/** Instant disarm — checked FIRST, before enabled/live. */
export function isRetroKilled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_DSR_KILLED')) return true
  return settingOn(db, 'dsr_killed')
}

// ── Numeric / list config (§D.3) ─────────────────────────────────────────────

function numSetting(db: Database, key: string, envName: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = parseFloat(env[envName] ?? '')
  if (Number.isFinite(fromEnv)) return fromEnv
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    const n = parseFloat(row?.value ?? '')
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

export interface RetroConfig {
  minConfidence: number
  maxObjectives: number
  wipCap: number
  sanityMax: number
  maxCostUsd: number
  parentObjectiveId: number | null
  chatObjectives: number[]
  tunerEnabled: boolean
}

export function loadConfig(db: Database, env: NodeJS.ProcessEnv = process.env): RetroConfig {
  const parentRaw =
    env.CC_DSR_PARENT_OBJECTIVE_ID ??
    ((db.prepare('SELECT value FROM settings WHERE key = ?').get('dsr_parent_objective_id') as { value?: string } | undefined)?.value ?? '')
  const parentId = parseInt(parentRaw, 10)
  const chatRaw =
    env.CC_DSR_CHAT_OBJECTIVES ??
    ((db.prepare('SELECT value FROM settings WHERE key = ?').get('dsr_chat_objectives') as { value?: string } | undefined)?.value ?? '1432')
  return {
    minConfidence: numSetting(db, 'dsr_min_confidence', 'CC_DSR_MIN_CONFIDENCE', DEFAULT_MIN_CONFIDENCE, env),
    maxObjectives: numSetting(db, 'dsr_max_objectives', 'CC_DSR_MAX_OBJECTIVES', 5, env),
    wipCap: numSetting(db, 'dsr_wip_cap', 'CC_DSR_WIP_CAP', 8, env),
    sanityMax: numSetting(db, 'dsr_sanity_max', 'CC_DSR_SANITY_MAX', 200, env),
    maxCostUsd: numSetting(db, 'dsr_max_cost_usd', 'CC_DSR_MAX_COST_USD', 3.0, env),
    parentObjectiveId: Number.isFinite(parentId) && parentId > 0 ? parentId : null,
    chatObjectives: chatRaw
      .split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n)),
    // The tuner is READ-ONLY against the board (it grades past predictions), so
    // it is the one DSR component that is safe ON by default.
    tunerEnabled: env.CC_DSR_TUNER_ENABLED
      ? TRUE_VALUES.has(env.CC_DSR_TUNER_ENABLED.toLowerCase())
      : ((db.prepare('SELECT value FROM settings WHERE key = ?').get('dsr_tuner_enabled') as { value?: string } | undefined)?.value ?? '1') !== '0',
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface RetroCandidate {
  fingerprint: string
  signal_type: SignalType
  confidence: number
  recurrence: number
  source_objective_id: number | null
  source_session_id: string | null
  transcript_path: string | null
  /** The signal text itself — what the fingerprint anchors on. */
  excerpt: string
  /** ±WINDOW_RADIUS transcript lines around the signal, for the lenses. */
  window: string
}

export interface L1Verdict {
  // Field order matters: forced tool-use emits fields in schema order and a
  // token-cap hit silently drops trailing ones (open risk D.6-5). The two
  // decision-bearing booleans come first.
  refuted: boolean
  is_real_defect: boolean
  one_line_statement: string
  evidence_quote: string
  confidence: number
}
export interface L2Verdict {
  duplicate: boolean
  already_fixed: boolean
  duplicate_of: number | null
  evidence: string
}
export interface L3Verdict {
  remedy: 'fix_objective' | 'skill_edit' | 'memory_note' | 'prompt_edit' | 'no_action'
  scope_ok: boolean
  priority: 'P0' | 'P1' | 'P2'
  rationale: string
}

export type LensName = 'L1' | "L1'" | 'L2' | 'L3'

/** One lens invocation. Injected so tests never touch the network. */
export interface LensRunner {
  (lens: LensName, candidate: RetroCandidate, context: string): Promise<{
    verdict: L1Verdict | L2Verdict | L3Verdict
    cost_usd: number
  }>
}

/** Board writer. Injected so tests never touch the live board. */
export interface ObjectivePoster {
  (payload: Record<string, unknown>): Promise<{ id: number } | null>
}

export type GateOutcome = 'promoted' | 'killed' | 'held' | 'routed_correction'

export interface GateResult {
  outcome: GateOutcome
  l1: L1Verdict | null
  l1prime: L1Verdict | null
  l2: L2Verdict | null
  l3: L3Verdict | null
  cost_usd: number
  reason: string
}

export interface RunOptions {
  /** Target day, YYYY-MM-DD. Defaults to yesterday (UTC). */
  day?: string
  /** 'shadow' writes candidates only; 'live' also posts objectives. */
  mode?: 'shadow' | 'live'
  db?: Database
  env?: NodeJS.ProcessEnv
  lensRunner?: LensRunner
  poster?: ObjectivePoster
  transcriptDir?: string
  /** Manual watermark override for a full rescan (DSR_SINCE / --since). */
  since?: string | null
  /** Per-run objective cap override (CLI --max). */
  max?: number
  /** True for the dry-run CLI: never post, never ledger, never write rows. */
  dryRun?: boolean
}

export interface RunResult {
  run_id: number | null
  mode: 'shadow' | 'live'
  target_day: string
  skipped: string | null
  sessions_scanned: number
  raw_signals: number
  above_floor: number
  lens_killed: number
  created: number
  held: number
  routed_corrections: number
  dropped_by_cap: number
  unclassified_followups: number
  cost_usd: number
  candidates: Array<RetroCandidate & { verdict: GateOutcome | 'dropped_cap'; gate?: GateResult; would_create?: Record<string, unknown> }>
  notes: string[]
}

