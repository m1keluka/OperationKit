/**
 * Auto-merge-on-green (flag-gated, ON by default once wired into reviewer-PASS).
 *
 * The long-referenced fast-follow (CLAUDE.md Decision #1, prompt-builder.ts):
 * once a lightweight PR's harness/test-agent commit status is GREEN and its
 * adversarial review APPROVED (verdict=pass), merge it automatically so
 * standalone task output ships without human babysitting — the spend fix that
 * sat in unmerged PR #76 for hours (incident obj-1124) is exactly the rot this
 * prevents.
 *
 * SAFETY: money-path titles, project-type cards, and PRs that are behind/dirty
 * never merge. The owner can set auto_merge_enabled=0 for a dry-run. Every
 * decision is logged. `decideAutoMerge` is pure so it is unit-testable without
 * GitHub.
 */
import { execFile } from 'child_process'
import { getDb } from '../db/index.js'
import type { Objective } from '@operationkit/shared'
import { isMoneyPath } from './merge-lane.js'

export { isMoneyPath }

const HARNESS_REPO = process.env.HARNESS_REPO || 'your-org/command-center-infra'
const AUTO_MERGE_SETTING = 'auto_merge_enabled'

/** Owner-controlled switch. Reads the `settings` KV table; defaults OFF. */
export function isAutoMergeEnabled(): boolean {
  try {
    const row = getDb()
      .prepare(`SELECT value FROM settings WHERE key = '${AUTO_MERGE_SETTING}'`)
      .get() as { value: string } | undefined
    return row?.value === '1'
  } catch {
    return false
  }
}

export interface AutoMergeInputs {
  /** Owner switch (settings.auto_merge_enabled). */
  enabled: boolean
  /** Does this objective have an open PR to merge? */
  hasPr: boolean
  /** PR number, if any. */
  prNumber: number | null
  /** harness/test-agent commit status — must be 'success' to merge. */
  harnessStatus: 'success' | 'failure' | 'pending' | 'unknown'
  /** Adversarial review verdict — must be 'pass' to merge. */
  reviewVerdict: 'pass' | 'fail' | 'blocked' | null
  /**
   * Only lightweight/standalone PRs auto-merge. A PR-building "project" still
   * routes to human review; non-project work (task) is the auto-merge target.
   */
  objectiveType: string
  /** GitHub mergeStateStatus is BEHIND / DIRTY / BLOCKED / etc. */
  unsafe?: boolean
  /** Title/description looks like a live money path. */
  moneyPath?: boolean
}

export type AutoMergeAction = 'merge' | 'dry-run' | 'skip'

export interface AutoMergeDecision {
  action: AutoMergeAction
  reason: string
}

/**
 * PURE decision: given the gates, decide whether to merge, dry-run, or skip.
 * - skip   → preconditions not met (no PR, not green, not approved, wrong type)
 * - dry-run→ preconditions met but the owner switch is OFF (log "would merge")
 * - merge  → preconditions met AND switch ON
 */
export function decideAutoMerge(i: AutoMergeInputs): AutoMergeDecision {
  if (!i.hasPr || !i.prNumber) {
    return { action: 'skip', reason: 'no PR to merge' }
  }
  // Project objectives intentionally route to human review, not auto-merge.
  if (i.objectiveType === 'project') {
    return { action: 'skip', reason: 'project-type objective routes to human review, not auto-merge' }
  }
  if (i.reviewVerdict !== 'pass') {
    return { action: 'skip', reason: `adversarial review not passing (verdict=${i.reviewVerdict ?? 'none'})` }
  }
  if (i.harnessStatus !== 'success') {
    return { action: 'skip', reason: `harness status not green (status=${i.harnessStatus})` }
  }
  if (i.moneyPath) {
    return { action: 'skip', reason: 'money-path objective — human merge' }
  }
  if (i.unsafe) {
    return { action: 'skip', reason: 'PR is behind/blocked/dirty — rebase before auto-merge' }
  }
  // All gates green from here on.
  if (!i.enabled) {
    return {
      action: 'dry-run',
      reason: `PR #${i.prNumber} is green + approved — WOULD auto-merge (switch ${AUTO_MERGE_SETTING} is OFF)`,
    }
  }
  return { action: 'merge', reason: `PR #${i.prNumber} green + approved + switch ON — auto-merging` }
}

function githubRepoFor(obj: Pick<Objective, 'project'>): string {
  const project = (obj.project || '').trim()
  if (project.includes('/')) return project
  if (!project) return HARNESS_REPO
  try {
    const row = getDb()
      .prepare(
        `SELECT github FROM workspace_repos
          WHERE github IS NOT NULL AND github != ''
            AND (github = ? OR github LIKE '%/' || ? OR name = ?)
          LIMIT 1`,
      )
      .get(project, project, project) as { github: string } | undefined
    const g = (row?.github || '').trim()
    return g.includes('/') ? g : HARNESS_REPO
  } catch {
    return HARNESS_REPO
  }
}

function ghMerge(prNumber: number, repo: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // --squash keeps main linear; --delete-branch cleans the head branch.
    execFile(
      'gh',
      ['pr', 'merge', String(prNumber), '--squash', '--delete-branch', '--repo', repo],
      { timeout: 60000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message))
        else resolve()
      },
    )
  })
}

/** True when GitHub will not cleanly merge (behind main, conflicts, blocked). */
function prUnsafeToAutoMerge(prNumber: number, repo: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'mergeStateStatus'],
      { timeout: 15000 },
      (err, stdout) => {
        if (err) {
          resolve(true)
          return
        }
        try {
          const status = String(JSON.parse(stdout).mergeStateStatus || '')
          resolve(status !== 'CLEAN' && status !== 'HAS_HOOKS')
        } catch {
          resolve(true)
        }
      },
    )
  })
}

/** Audit-log every decision to activity_log so the owner can see what fired. */
function logDecision(obj: Objective, decision: AutoMergeDecision, outcome: string): void {
  console.log(
    `[auto-merge] obj ${obj.id} PR #${obj.pr_number ?? '?'} — ${decision.action.toUpperCase()}: ${decision.reason} (${outcome})`,
  )
  try {
    getDb()
      .prepare(
        `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
         VALUES (?, ?, ?, ?, 'milestone', 'auto_merge_decision', ?)`,
      )
      .run(
        obj.project || 'command-center',
        obj.workspace,
        obj.id,
        obj.ai_review_session_id ?? null,
        `[${decision.action}] ${decision.reason} — ${outcome}`,
      )
  } catch (err) {
    console.warn('[auto-merge] failed to write activity_log:', (err as Error).message)
  }
}

/**
 * Evaluate + (maybe) execute auto-merge for an objective whose adversarial
 * review just passed. Call this AFTER the harness 'success' status is posted.
 * Fully best-effort: never throws, never blocks the poller.
 *
 * @param harnessGreen the harness status we just posted/confirmed for this PR.
 */
export async function evaluateAutoMerge(
  obj: Objective,
  reviewVerdict: 'pass' | 'fail' | 'blocked' | null,
  harnessGreen: boolean,
): Promise<AutoMergeDecision> {
  const repo = githubRepoFor(obj)
  let unsafe = false
  if (obj.pr_number && harnessGreen && reviewVerdict === 'pass' && obj.type !== 'project') {
    unsafe = await prUnsafeToAutoMerge(obj.pr_number, repo)
  }
  const decision = decideAutoMerge({
    enabled: isAutoMergeEnabled(),
    hasPr: !!obj.pr_number,
    prNumber: obj.pr_number ?? null,
    harnessStatus: harnessGreen ? 'success' : 'unknown',
    reviewVerdict,
    objectiveType: obj.type,
    unsafe,
    moneyPath: isMoneyPath(obj),
  })

  if (decision.action === 'skip') {
    // Skips are common and noisy — only log when there was a PR in play.
    if (obj.pr_number) logDecision(obj, decision, 'no action')
    return decision
  }

  if (decision.action === 'dry-run') {
    logDecision(obj, decision, 'DRY-RUN — not merged (enable via settings.auto_merge_enabled=1)')
    return decision
  }

  // action === 'merge'
  try {
    await ghMerge(obj.pr_number as number, repo)
    logDecision(obj, decision, `MERGED via gh pr merge --squash --repo ${repo}`)
  } catch (err) {
    logDecision(obj, decision, `MERGE FAILED: ${(err as Error).message}`)
  }
  return decision
}
