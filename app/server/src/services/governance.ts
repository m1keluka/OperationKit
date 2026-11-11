// ── Governance pack (obj-2509 / Kitchen-Loop Rec #5) ────────────────────────
//
// Two additive, flag-guarded efficiency mechanisms that attack two named active
// blockers — token waste on re-grading unchanged trees, and re-spawning work
// that is blocked on an external dependency:
//
//   KL-21  gate-rejection memory   — skip the LLM auditor when an objective was
//          already rejected and its head tree SHA is byte-identical to the tree
//          it was rejected on (no point re-grading an unchanged-but-rejected tree).
//   KL-11  blocked-combos registry — skip generating/spawning objectives whose
//          title matches a known-blocked pattern, with rows that auto-expire.
//
// HARD SAFETY: every behavior-changing path here is OFF by default and gated by a
// flag + kill switch (same env-OR-settings, fail-closed pattern as the
// deterministic floor). With the flags off, both mechanisms are inert no-ops and
// the spawn/generation paths behave byte-for-byte as before.
//
// Pure decision logic (gateRejectionDecision, matchesBlockedPattern) is separated
// from the DB/git side-effects so it is exhaustively unit-testable without a live
// board, tmux, or git.

import { execSync } from 'child_process'
import fs from 'fs'
import type { Database } from 'better-sqlite3'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

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

// ── Feature flags (env overrides settings; fail-closed on any error) ──────────

/** KL-21 gate-rejection memory globally enabled? OFF by default. */
export function isGateRejectionMemoryEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_GATE_REJECTION_MEMORY_ENABLED')) return true
  return settingOn(db, 'gate_rejection_memory_enabled')
}

/** Belt-and-suspenders global OFF for KL-21. */
export function isGateRejectionMemoryKilled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_GATE_REJECTION_MEMORY_KILLED')) return true
  return settingOn(db, 'gate_rejection_memory_killed')
}

/** KL-11 blocked-combos registry globally enabled? OFF by default. */
export function isBlockedRegistryEnabled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_BLOCKED_REGISTRY_ENABLED')) return true
  return settingOn(db, 'blocked_registry_enabled')
}

/** Belt-and-suspenders global OFF for KL-11. */
export function isBlockedRegistryKilled(db: Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (envFlagOn(env, 'CC_BLOCKED_REGISTRY_KILLED')) return true
  return settingOn(db, 'blocked_registry_killed')
}

// ── KL-21: gate-rejection memory ──────────────────────────────────────────────

export interface GateRejectionInput {
  enabled: boolean
  killed: boolean
  /** The objective's last recorded review verdict ('pass' | 'fail' | 'blocked' | null). */
  priorVerdict?: string | null
  /** Head tree SHA recorded at the moment of the last rejection. */
  rejectedTreeSha?: string | null
  /** Head tree SHA of the objective's branch right now. */
  currentTreeSha: string | null
}

export interface GateRejectionDecision {
  skipAuditor: boolean
  reason: string | null
}

/**
 * Pure decision: should we SKIP spawning the LLM auditor for this objective?
 *
 * Only skips when the gate is ON (and not killed), the objective was previously
 * REJECTED (`fail`), and the current head tree SHA is known and byte-identical to
 * the tree it was rejected on. Any missing SHA, a changed tree, a non-fail prior
 * verdict, or the flag being off → do NOT skip (fail-open: behave as today and
 * let the auditor run). This is the single source of truth the smoke test asserts.
 */
export function gateRejectionDecision(input: GateRejectionInput): GateRejectionDecision {
  const { enabled, killed, priorVerdict, rejectedTreeSha, currentTreeSha } = input
  if (!enabled || killed) return { skipAuditor: false, reason: null }
  if (priorVerdict !== 'fail') return { skipAuditor: false, reason: null }
  if (!rejectedTreeSha || !currentTreeSha) return { skipAuditor: false, reason: null }
  if (rejectedTreeSha === currentTreeSha) {
    return {
      skipAuditor: true,
      reason: `head tree ${currentTreeSha.slice(0, 12)} unchanged since rejection — NOT_MERGEABLE, auditor skipped`,
    }
  }
  return { skipAuditor: false, reason: null }
}

type GitExec = (cmd: string) => string

const defaultGitExec: GitExec = (cmd) => execSync(cmd, { timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString()

/**
 * Best-effort head tree SHA for an objective's committed work. Tries the
 * objective's isolated worktree first (HEAD^{tree} — the tree the worker actually
 * built), then falls back to `<branch>^{tree}` inside the project dir. Returns
 * null on ANY failure (no branch, no worktree, git error) so the caller fails
 * OPEN — a null SHA never triggers a skip, so the auditor still runs.
 *
 * The TREE SHA (not the commit SHA) is used deliberately: it is identical across
 * two commits with identical content (e.g. an empty re-commit / rebase no-op), so
 * "unchanged tree" means "the bytes the reviewer would grade are the same".
 */
export function getObjectiveTreeSha(
  opts: { objectiveId: number; branchName: string | null; projectDir: string | null; worktreePath?: string | null },
  gitExec: GitExec = defaultGitExec,
): string | null {
  const { objectiveId, branchName, projectDir } = opts
  const worktreePath = opts.worktreePath ?? `/tmp/cc-worktree-${objectiveId}`
  // 1) The objective's own worktree (its HEAD is the branch tip the worker built).
  try {
    if (worktreePath && fs.existsSync(worktreePath)) {
      const out = gitExec(`git -C ${JSON.stringify(worktreePath)} rev-parse --verify --quiet "HEAD^{tree}"`)
      const sha = out.trim()
      if (sha) return sha
    }
  } catch {
    /* fall through */
  }
  // 2) The project checkout, resolving the branch by name.
  if (projectDir && branchName) {
    try {
      const out = gitExec(`git -C ${JSON.stringify(projectDir)} rev-parse --verify --quiet ${JSON.stringify(`${branchName}^{tree}`)}`)
      const sha = out.trim()
      if (sha) return sha
    } catch {
      /* fall through */
    }
  }
  return null
}

// ── KL-11: blocked-combos registry ────────────────────────────────────────────

export interface BlockedObjectiveRow {
  id: number
  objective_pattern: string
  reason: string
  since: string
  unblock_ticket: string | null
  expires_at: string | null
  resolved_at: string | null
  created_at: string
}

/**
 * Match a blocked-objective pattern against an objective title. Case-insensitive.
 * A pattern containing `*` is treated as a glob (anchored full match, `*` ⇒ `.*`);
 * otherwise it is a substring "contains" match. Pure — no DB, no side effects.
 */
export function matchesBlockedPattern(pattern: string, title: string): boolean {
  if (!pattern || !title) return false
  const p = pattern.trim().toLowerCase()
  const t = title.toLowerCase()
  if (!p) return false
  if (p.includes('*')) {
    const escaped = p
      .split('*')
      .map((seg) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp(`^${escaped}$`).test(t)
  }
  return t.includes(p)
}

/**
 * Active (non-resolved, non-time-expired) blocked rules. Time-based auto-expiry is
 * applied here on every read — a row with a past `expires_at` is simply not
 * returned, so it requires no sweeper job. Returns [] on any error (fail-open).
 */
export function listActiveBlockedObjectives(db: Database): BlockedObjectiveRow[] {
  try {
    return db
      .prepare(
        `SELECT * FROM blocked_objectives
           WHERE resolved_at IS NULL
             AND (expires_at IS NULL OR expires_at > datetime('now'))
           ORDER BY id`,
      )
      .all() as BlockedObjectiveRow[]
  } catch {
    return []
  }
}

/**
 * The first active blocking rule whose pattern matches `title`, or null. The
 * caller (objective-generation path) uses a non-null result to SKIP creating that
 * objective. Fail-open: returns null on any error.
 */
export function findBlockingRule(db: Database, title: string | null | undefined): BlockedObjectiveRow | null {
  if (!title || !title.trim()) return null
  for (const row of listActiveBlockedObjectives(db)) {
    if (matchesBlockedPattern(row.objective_pattern, title)) return row
  }
  return null
}

/**
 * Ticket-based auto-expiry: stamp `resolved_at` on every active rule whose
 * `unblock_ticket` now resolves. `isResolved` is injected (e.g. a GitHub/Linear
 * status check) so this stays testable and dependency-free. Returns the count
 * expired. Combined with the time-based filter in {@link listActiveBlockedObjectives},
 * this gives the registry two independent auto-expiry mechanisms.
 */
export function expireResolvedBlockedObjectives(db: Database, isResolved: (ticket: string) => boolean): number {
  let expired = 0
  let rows: { id: number; unblock_ticket: string | null }[] = []
  try {
    rows = db
      .prepare(`SELECT id, unblock_ticket FROM blocked_objectives WHERE resolved_at IS NULL AND unblock_ticket IS NOT NULL`)
      .all() as { id: number; unblock_ticket: string | null }[]
  } catch {
    return 0
  }
  const stamp = db.prepare(`UPDATE blocked_objectives SET resolved_at = datetime('now') WHERE id = ?`)
  for (const row of rows) {
    if (!row.unblock_ticket) continue
    let resolved = false
    try {
      resolved = isResolved(row.unblock_ticket)
    } catch {
      resolved = false // a failed status check must NOT expire a still-active block
    }
    if (resolved) {
      stamp.run(row.id)
      expired++
    }
  }
  return expired
}

/** Convenience for tests/admin: register a blocked rule. Returns the new row id. */
export function addBlockedObjective(
  db: Database,
  rule: { objective_pattern: string; reason: string; unblock_ticket?: string | null; expires_at?: string | null },
): number {
  const result = db
    .prepare(
      `INSERT INTO blocked_objectives (objective_pattern, reason, unblock_ticket, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(rule.objective_pattern, rule.reason, rule.unblock_ticket ?? null, rule.expires_at ?? null)
  return result.lastInsertRowid as number
}
