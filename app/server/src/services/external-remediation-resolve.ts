/**
 * Objective resolution and PR auto-link for the external-CI remediation loop —
 * extracted from external-remediation.ts (behavior frozen).
 *
 * No GitHub act-path, no session spawn. handleExternalCheckEvent stays in
 * external-remediation-act.ts.
 */
import type { Database } from 'better-sqlite3'
import type { Objective } from '@command-center/shared'
import { parsePrNumberFromUrl } from './pr-url.js'
import { upsertObjectivePR } from './objective-prs.js'
import { isHumanTerminalGuardEnabled } from './objective-audit.js'
import {
  type ClassifiedCheck,
  TRUNK_BRANCHES,
  isRemediableObjective,
  parseObjectiveIdCandidates,
} from './external-remediation-classify.js'

/**
 * Resolve the owning objective for a failing check. Matching order (most→least
 * precise): explicit pr_number hint → pr_url-derived number → branch_name →
 * branch-parsed objective id (obj 702632, gap A). The pr_url fallback is the
 * obj-1138 hole (pr_url set, pr_number NULL) re-applied here. Only returns an
 * objective that is still remediable (see isRemediableObjective; `opts` threads
 * the done-grace).
 */
export function resolveObjective(
  db: Database,
  classified: Pick<ClassifiedCheck, 'prNumberHint' | 'headSha' | 'repoFullName'>,
  branchHint: string | null = null,
  opts: { allowRecentDone?: boolean } = {},
): Objective | null {
  const candidates = collectObjectiveCandidates(db, classified, branchHint)
  const humanTerminalGuard = isHumanTerminalGuardEnabled(db)
  const eligible = candidates.find(c =>
    isRemediableObjective(c, { humanTerminalGuard, allowRecentDone: opts.allowRecentDone }),
  )
  return eligible || null
}

/** The candidate-gathering half of resolveObjective, extracted (obj 704698, gap D) so
 *  resolveOwnerObjective can see owners that exist but are INELIGIBLE — previously they
 *  were indistinguishable from "no objective at all", which is exactly how a red PR got
 *  orphaned. Ordered most→least precise; newest objective first within each strategy. */
export function collectObjectiveCandidates(
  db: Database,
  classified: Pick<ClassifiedCheck, 'prNumberHint' | 'headSha' | 'repoFullName'>,
  branchHint: string | null = null,
): Objective[] {
  const candidates: Objective[] = []
  const seen = new Set<number>()
  const push = (rows: Objective[]) => {
    for (const r of rows) {
      if (r && !seen.has(r.id)) { seen.add(r.id); candidates.push(r) }
    }
  }

  // 1. by explicit PR number (from the event) OR any objective whose pr_url derives
  //    to that number. We OR pr_number and pr_url so a row that has only one set still
  //    matches.
  if (classified.prNumberHint) {
    const n = classified.prNumberHint
    // Repo-qualify the PR-number match. Two active repos reuse the same small PR
    // numbers, so a repo-blind `pr_number = N` / `pr_url LIKE '%/pull/N%'` match
    // routes a example-project-platform PR 447 event to an example-platform objective
    // that owns PR 447 (obj 703235 / 703352, 2026-08-22 — cross-repo scope-bleed;
    // 703352 pushed to a foreign worker's live branch). When the event carries a
    // repo, anchor the pr_url LIKE to `/<owner>/<repo>/pull/N`. Fall back to the
    // old repo-blind behavior only when the event gave us no repo.
    //
    // The bare `pr_number = N` arm is NARROWED, not dropped. Dropping it outright
    // (the first cut of this fix) regressed every pr_number-only owner: a
    // `workflow_run` event carries a repo + PR number but NO branch, so strategies
    // 2/2b have no handle and the PR resolves to nobody. It now matches only rows
    // that have no pr_url to disqualify them by, repo-qualified through `project`
    // (which is the repo's short name) when the row declares one. Both mis-routed
    // objectives carried an example-platform pr_url, so the URL anchor excludes them.
    const repo = (classified.repoFullName || '').trim()
    const repoShort = repo.split('/').pop() || repo
    const byNum = repo
      ? (db
          .prepare(
            `SELECT * FROM objectives
             WHERE (pr_url IS NOT NULL AND pr_url != '' AND pr_url LIKE ?)
                OR (pr_number = ? AND (pr_url IS NULL OR pr_url = '')
                    AND (project IS NULL OR project = '' OR project = ?))
             ORDER BY id DESC`,
          )
          .all(`%/${repo}/pull/${n}%`, n, repoShort) as Objective[])
          // `LIKE '%/pull/447%'` also matches `/pull/4478`. Re-derive the number
          // from the URL and require an exact hit, so a repo-qualified match can
          // never be a prefix collision. (URL-less rows already matched exactly.)
          .filter(r => !r.pr_url || parsePrNumberFromUrl(r.pr_url) === n || r.pr_number === n)
      : db
          .prepare(
            `SELECT * FROM objectives
             WHERE (pr_number = ? AND pr_number IS NOT NULL)
                OR (pr_url IS NOT NULL AND pr_url != '' AND pr_url LIKE ?)
             ORDER BY id DESC`,
          )
          .all(n, `%/pull/${n}%`) as Objective[]
    push(byNum)
  }

  // 2. by branch name (status events carry no PR; branch is the only handle).
  if (branchHint && branchHint.trim()) {
    const byBranch = db
      .prepare(`SELECT * FROM objectives WHERE branch_name = ? ORDER BY id DESC`)
      .all(branchHint.trim()) as Objective[]
    push(byBranch)
  }

  // 2b. by objective id PARSED from the branch name (obj 702632, gap A): sessions
  //     push `fix/<id>-…` / `w3/<id>-…` / `cc/obj-<id>-…` branches without ever
  //     registering pr_number/pr_url/branch_name, so strategies 1–2 come up empty.
  //     Each parsed candidate is verified against the objectives table; on a hit we
  //     ALSO backfill branch_name onto the row (NULL-only, best-effort) so future
  //     events for this branch resolve directly via strategy 2.
  if (candidates.length === 0 && branchHint && branchHint.trim()) {
    const branch = branchHint.trim()
    for (const candId of parseObjectiveIdCandidates(branch)) {
      const row = db.prepare('SELECT * FROM objectives WHERE id = ?').get(candId) as Objective | undefined
      if (!row) continue
      if (!row.branch_name) {
        try {
          db.prepare("UPDATE objectives SET branch_name = ?, updated_at = datetime('now') WHERE id = ? AND branch_name IS NULL")
            .run(branch, row.id)
          row.branch_name = branch
          console.log(`[external-remediation] backfilled branch_name=${branch} onto obj ${row.id} (parsed from branch)`)
        } catch { /* backfill is best-effort; resolution still stands */ }
      }
      push([row])
      break // first verified candidate wins (parser already orders by signal strength)
    }
  }

  // 3. last resort: any objective with a pr_url that derives to a number, when the
  //    event only gave us a hint we already used — covers the pr_number-NULL row whose
  //    pr_url is the canonical link. (Re-derive defensively per row.)
  for (const c of candidates) {
    if (!c.pr_number && c.pr_url) {
      // annotate-in-place is fine; consumers read pr_number ?? derive anyway.
      const derived = parsePrNumberFromUrl(c.pr_url)
      if (derived) (c as Objective).pr_number = derived
    }
  }

  return candidates
}

export type OwnerBlockedReason = 'terminal-by-human' | 'done-past-grace' | 'no-handle' | null

export interface OwnerResolution {
  /** The first ELIGIBLE candidate, else the first candidate at all (so the caller can
   *  see who used to own this PR), else null. */
  objective: Objective | null
  eligible: boolean
  blockedBy: OwnerBlockedReason
}

/**
 * Gap D (obj 704698). resolveObjective() returns null both when nobody owns the PR and
 * when the owner exists but has gone `done` past the grace window — so the loop dropped
 * the event either way and the PR stayed red with nobody responsible. This variant keeps
 * the distinction, and says WHY the owner can't be nudged:
 *   - `terminal-by-human` → HARD STOP; a human parked it, CI must never resurrect it.
 *   - `done-past-grace`   → hand the PR to a fresh inheritor objective.
 */
export function resolveOwnerObjective(
  db: Database,
  classified: Pick<ClassifiedCheck, 'prNumberHint' | 'headSha' | 'repoFullName'>,
  branchHint: string | null = null,
  opts: { allowRecentDone?: boolean; env?: NodeJS.ProcessEnv } = {},
): OwnerResolution {
  const allowRecentDone = opts.allowRecentDone ?? true
  const candidates = collectObjectiveCandidates(db, classified, branchHint)
  const humanTerminalGuard = isHumanTerminalGuardEnabled(db, opts.env)
  const eligible = candidates.find(c => isRemediableObjective(c, { humanTerminalGuard, allowRecentDone }))
  if (eligible) return { objective: eligible, eligible: true, blockedBy: null }
  const owner = candidates[0] || null
  if (!owner) return { objective: null, eligible: false, blockedBy: null }
  if (owner.terminal_by_human) return { objective: owner, eligible: false, blockedBy: 'terminal-by-human' }
  if (owner.status === 'done') return { objective: owner, eligible: false, blockedBy: 'done-past-grace' }
  return { objective: owner, eligible: false, blockedBy: 'no-handle' }
}

// ── PR auto-link (obj 702632, gap B) ────────────────────────────────────────────

export interface AutoLinkResult {
  linked: boolean
  reason: 'linked' | 'already-linked' | 'mismatch' | 'no-objective' | 'no-branch' | 'no-number' | 'error'
  objectiveId?: number
}

/**
 * Stamp pr_number / pr_url / branch_name onto the owning objective when a
 * `pull_request` webhook (opened / reopened / synchronize) arrives for a branch we
 * can resolve — exact branch_name match first, then the branch-id parser above.
 * This is what makes FUTURE check_run/workflow_run failures resolve by PR directly
 * instead of limping through the branch fallback every time.
 *
 * Idempotent: NULL fields are filled, non-NULL fields are never overwritten — a
 * DIFFERENT existing pr_number is logged as a mismatch and left alone (the row may
 * legitimately point at an earlier PR for the same objective; the per-objective PR
 * log via upsertObjectivePR still records the new PR). Never throws.
 */
export function autoLinkPullRequest(
  db: Database,
  args: { repoFullName: string; prNumber: number; prUrl: string | null; branch: string | null },
): AutoLinkResult {
  try {
    const branch = (args.branch || '').trim()
    if (!branch || TRUNK_BRANCHES.has(branch)) return { linked: false, reason: 'no-branch' }
    if (!args.prNumber || !Number.isInteger(args.prNumber) || args.prNumber <= 0) {
      return { linked: false, reason: 'no-number' }
    }

    // Resolve: exact branch_name first, then parsed-id fallback (verified per id).
    let obj = db
      .prepare('SELECT * FROM objectives WHERE branch_name = ? ORDER BY id DESC LIMIT 1')
      .get(branch) as Objective | undefined
    if (!obj) {
      for (const candId of parseObjectiveIdCandidates(branch)) {
        const row = db.prepare('SELECT * FROM objectives WHERE id = ?').get(candId) as Objective | undefined
        if (row) { obj = row; break }
      }
    }
    if (!obj) return { linked: false, reason: 'no-objective' }

    // Append to the per-objective PR log regardless of the pointer fields below —
    // same write the /pr-created route and pr-linkage backfill perform.
    try {
      upsertObjectivePR({
        objective_id: obj.id,
        pr_number: args.prNumber,
        pr_url: args.prUrl,
        branch_name: branch,
      })
    } catch { /* PR-log append is best-effort */ }

    if (obj.pr_number != null && obj.pr_number !== args.prNumber) {
      console.warn(
        `[external-remediation] auto-link MISMATCH obj ${obj.id}: has pr_number=${obj.pr_number}, event says #${args.prNumber} (${args.repoFullName} ${branch}) — leaving existing link untouched`,
      )
      return { linked: false, reason: 'mismatch', objectiveId: obj.id }
    }
    if (obj.pr_number === args.prNumber && obj.branch_name) {
      return { linked: false, reason: 'already-linked', objectiveId: obj.id }
    }

    // NULL-only stamping via COALESCE: fills gaps, never clobbers.
    db.prepare(
      `UPDATE objectives
          SET pr_number   = COALESCE(pr_number, ?),
              pr_url      = COALESCE(pr_url, ?),
              branch_name = COALESCE(branch_name, ?),
              updated_at  = datetime('now')
        WHERE id = ?`,
    ).run(args.prNumber, args.prUrl, branch, obj.id)
    console.log(
      `[external-remediation] auto-linked PR #${args.prNumber} (${args.repoFullName}) → obj ${obj.id} via branch ${branch}`,
    )
    return { linked: true, reason: 'linked', objectiveId: obj.id }
  } catch (err) {
    console.warn('[external-remediation] auto-link error:', (err as Error).message)
    return { linked: false, reason: 'error' }
  }
}
