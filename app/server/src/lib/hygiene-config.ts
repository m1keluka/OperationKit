// ── Board-hygiene sweep configuration (obj 700595) ───────────────────────────
//
// Central home for the thresholds + flag readers used by the board-hygiene
// counterweights (root cause: /home/operator/ai-workspace/objective-memory/700583/
// w1-rootcause.md). Every autonomous MUTATING sweep is behind a flag defaulting
// OFF (safe); the event-driven orphan-child cleanup and the read-only digest are
// always live and need no flag.
//
// Thresholds are env-configurable (an env override wins over the default). They
// are expressed as day counts and rendered into SQLite `datetime('now','-Nd')`
// modifiers by the callers, so the query does the age math in UTC (avoids JS
// timezone-parsing pitfalls, matching the existing sweeps).

import type { Database } from 'better-sqlite3'

function envInt(v: string | undefined, fallback: number): number {
  if (v == null || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envTrue(v: string | undefined): boolean {
  const s = (v || '').toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function settingIsOn(db: Database, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value?: string }
      | undefined
    return row?.value === '1' || row?.value === 'true'
  } catch {
    return false
  }
}

// ── Thresholds (days) ────────────────────────────────────────────────────────

/** 1b — a queue child of a LIVE delegator is orphaned once older than this. */
export function queueOrphanTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.CC_QUEUE_ORPHAN_TTL_DAYS, 3)
}

/** 2a — a review row with verdict='pass' is auto-accepted after this grace. */
export function reviewPassTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.CC_REVIEW_PASS_TTL_DAYS, 1)
}

/** 2c — a manual (no-parent) queue card is surfaced in the digest past this. */
export function queueStaleTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.CC_QUEUE_STALE_TTL_DAYS, 3)
}

/** 2b — a review row (verdict=null) is surfaced in the digest past this. */
export function reviewStaleTtlDays(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.CC_REVIEW_STALE_TTL_DAYS, 7)
}

/** 2b (optional) — hard-expiry horizon for verdict=null review items. */
export function reviewHardExpiryDays(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.CC_REVIEW_HARD_EXPIRY_DAYS, 30)
}

// ── Flags (all default OFF / safe) ───────────────────────────────────────────

/** 1b — autonomous queue-drainer backstop. DEFAULT OFF. */
export function isQueueDrainerEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envTrue(env.CC_HYGIENE_QUEUE_DRAINER)) return true
  return settingIsOn(db, 'hygiene_queue_drainer_enabled')
}

/** 2a — auto-accept-on-pass reaper. DEFAULT OFF. */
export function isAutoAcceptEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envTrue(env.CC_HYGIENE_AUTO_ACCEPT)) return true
  return settingIsOn(db, 'hygiene_auto_accept_enabled')
}

/** 2b — hard-expiry auto-close of verdict=null review items. DEFAULT OFF. */
export function isReviewHardExpiryEnabled(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (envTrue(env.CC_HYGIENE_REVIEW_HARD_EXPIRY)) return true
  return settingIsOn(db, 'hygiene_review_hard_expiry_enabled')
}

/** Per-parent cap on how many stranded children the queue-drainer starts per tick. */
export function childCapPerParent(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.CC_CHILD_CAP_PER_PARENT, 3)
}

/** Global cap on children the queue-drainer starts across ALL parents per tick. */
export function queueDrainerTickCap(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.CC_QUEUE_DRAINER_TICK_CAP, 5)
}

// ── Top-level queue starter (obj 701663) ─────────────────────────────────────
//
// Fixes the 14-day apply-loop stall: a TOP-LEVEL (parent_id IS NULL) objective
// created via POST /api/internal/objectives lands at the schema-default
// status='queue' and — unlike a routine, which self-PATCHes to 'working' — has
// NO scheduler to start it, so it sits in queue forever (the 6 stuck distill
// review cards + every other bulk-route card). This sweep is the missing
// autonomous starter for those cards.
//
// Unlike the two hygiene sweeps above, this one DEFAULTS ON: it is the actual
// remediation for a confirmed production stall, and its allowlist (bulk-route
// `origin` ∈ {job_reply,strategy} AND `category` ∈ the platform allowlist)
// STRUCTURALLY excludes the "auto-start arbitrary user cards" risk — it can
// never touch a manual card (origin='manual'), a routine run (origin='routine'),
// or a general-category PRD-backlog project. It is still fully killable via env
// (`CC_TOPLEVEL_QUEUE_STARTER=0`) or the `toplevel_queue_starter_enabled='0'`
// setting for an operator who wants it off.

function settingIsOff(db: Database, key: string): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value?: string }
      | undefined
    return row?.value === '0' || row?.value === 'false'
  } catch {
    return false
  }
}

/** Top-level queue starter. DEFAULT ON; killable via env or setting. */
export function isTopLevelQueueStarterEnabled(
  db: Database,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Explicit env kill wins first.
  const raw = (env.CC_TOPLEVEL_QUEUE_STARTER || '').toLowerCase()
  if (raw === '0' || raw === 'false' || raw === 'off' || raw === 'no') return false
  if (envTrue(env.CC_TOPLEVEL_QUEUE_STARTER)) return true
  // Otherwise ON unless an operator explicitly disabled it via settings.
  return !settingIsOff(db, 'toplevel_queue_starter_enabled')
}

/**
 * Allowed `category` values for the top-level queue starter. Default `['platform']`
 * — the category every distill review / platform-ops card carries, and NOT the
 * `general` category of a PRD backlog. Env-overridable (comma-separated) so an
 * operator can broaden the scope without a code change.
 */
export function topLevelQueueStarterCategories(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.CC_TOPLEVEL_QUEUE_STARTER_CATEGORIES || '').trim()
  if (!raw) return ['platform']
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return list.length > 0 ? list : ['platform']
}

/** Per-tick cap on how many top-level queue cards the starter spawns. */
export function topLevelQueueStarterTickCap(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.CC_TOPLEVEL_QUEUE_STARTER_TICK_CAP, 5)
}

/**
 * Grace (minutes) before a freshly-created queue card is eligible to auto-start.
 * A small grace avoids racing a bulk insert whose row fields are still settling
 * and gives an operator a brief window to triage/cancel before it spawns.
 */
export function topLevelQueueStarterGraceMinutes(env: NodeJS.ProcessEnv = process.env): number {
  return envInt(env.CC_TOPLEVEL_QUEUE_STARTER_GRACE_MIN, 2)
}

/** Where the human-facing hygiene digest is written. */
export const HYGIENE_DIGEST_DIR = '/home/operator/ai-workspace/briefings'
export const HYGIENE_DIGEST_PATH = `${HYGIENE_DIGEST_DIR}/hygiene-latest.md`
