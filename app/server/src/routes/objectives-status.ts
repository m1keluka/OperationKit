/**
 * PATCH /:id/status — extracted from objectives.ts (behavior frozen).
 * Registered on the same /api/objectives router. Status machine and SQL unchanged.
 */
import { execSync } from 'child_process'
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import {
  MAX_CONCURRENT_SESSIONS,
  isTransitionAllowed,
  type Objective,
  type StatusChangeRequest,
  type ObjectiveStatus,
} from '@command-center/shared'
import {
  startSession,
  stopSession,
  sendFollowUp,
  spawnReviewerSession,
  reopenObjective,
  BranchLeaseConflictError,
  SessionLeaseConflictError,
} from '../services/session-manager.js'
import { releaseBranchLeasesForObjective } from '../services/branch-lease.js'
import { releaseSessionLeasesForObjective } from '../services/session-lease.js'
import { recordReopenFalsePass } from '../services/false-pass.js'
import { logObjectiveAudit } from '../services/objective-audit.js'
import {
  isFloorActiveForProject,
  getFloorConfig,
  runFloor,
  resolveFloorCwd,
  evaluateFloorGate,
  recordFloorRunRow,
  logFloorMilestoneRow,
  isOutcomeVerificationActiveForObjective,
  getOutcomeAssertion,
  evaluateOutcomeGate,
  recordOutcomeRunRow,
  isOracleGateActiveForObjective,
  evaluateOracleGate,
} from '../services/deterministic-floor.js'
import { runCompletionGate, applyGateHandback } from '../services/ci-green-gate.js'
import { insertAlert } from '../services/notifier.js'
import { resolveWorkdir } from '../services/prompt-builder.js'
import { deriveWorktreeBranchName } from '../services/branch-scope.js'
import { cleanupOrphanedChildrenOnParentTerminal } from '../lib/cleanup-orphaned-children.js'
import { broadcast } from '../ws/index.js'
import { mapObjective, requireOwnership } from './objectives-helpers.js'

export function registerObjectiveStatusRoutes(router: Router): void {
router.patch('/:id/status', async (req: AuthRequest, res) => {
  const { status } = req.body as StatusChangeRequest
  const db = getDb()

  const existing = db
    .prepare('SELECT * FROM objectives WHERE id = ?')
    .get(req.params.id) as Objective | undefined

  if (!existing) {
    res.status(404).json({ error: 'Objective not found' })
    return
  }

  const ownershipError = requireOwnership(req, existing)
  if (ownershipError) {
    res.status(403).json({ error: ownershipError })
    return
  }

  // Already running: a delegator PATCH working after auto-start is a no-op.
  if (status === 'working' && existing.status === 'working') {
    res.json(mapObjective(existing))
    return
  }

  if (!isTransitionAllowed(existing.type, existing.status as ObjectiveStatus, status)) {
    res.status(400).json({
      error: `Cannot transition '${existing.type}' objective from '${existing.status}' to '${status}'`,
    })
    return
  }

  // Enforce concurrent session cap — count only states that hold a RUNNING
  // session: 'working' (active worker) and 'ai_review' (active AI reviewer).
  // 'review' is excluded: it is parked awaiting a human with no session running,
  // so it must not consume the concurrent-session budget (a review backlog was
  // saturating the cap and blocking the queue).
  if (status === 'working') {
    const activeCount = db
      .prepare("SELECT COUNT(*) as count FROM objectives WHERE status IN ('working', 'ai_review')")
      .get() as { count: number }

    if (activeCount.count >= MAX_CONCURRENT_SESSIONS) {
      res.status(409).json({
        error: `Maximum ${MAX_CONCURRENT_SESSIONS} concurrent sessions reached`,
      })
      return
    }
  }

  // Handle session lifecycle
  try {
    const startsFromReviewLike =
      existing.status === 'queue' ||
      existing.status === 'review' ||
      existing.status === 'ai_review'

    if (status === 'working' && existing.status === 'done') {
      // Re-Open: resume the most recent thread in place instead of starting over.
      // ST2: if this objective was pass-gated, the reopen means the gate's pass
      // was a false pass — record it (links reopen → prior passing review).
      recordReopenFalsePass(existing)
      const sessionId = await reopenObjective(existing)
      db.prepare(
        "UPDATE objectives SET status = ?, session_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(status, sessionId, req.params.id)
    } else if (status === 'working' && startsFromReviewLike) {
      // If reopening from a review state, record outcome as failed on last session intel
      if (existing.status !== 'queue' && existing.session_id) {
        db.prepare(
          "UPDATE session_intel SET outcome = 'failed' WHERE session_id = ? AND outcome IS NULL"
        ).run(existing.session_id)
      }

      const sessionId = await startSession(existing)
      db.prepare(
        "UPDATE objectives SET status = ?, session_id = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(status, sessionId, req.params.id)
    } else if (status === 'ai_review' && existing.status === 'working') {
      // Manual override: human triggered AI review without waiting for state-poller.
      // Stop the running worker session and spawn a reviewer.
      if (existing.session_id) {
        await stopSession(existing.session_id).catch(() => {})
      }
      const nextIteration = (existing.ai_review_iteration || 0) + 1
      ;(existing as Objective & { ai_review_iteration: number }).ai_review_iteration = nextIteration
      const reviewerSessionId = await spawnReviewerSession(existing)
      db.prepare(
        `UPDATE objectives SET
           status = 'ai_review',
           ai_review_session_id = ?,
           ai_review_verdict = NULL,
           ai_review_findings = NULL,
           ai_review_iteration = ?,
           updated_at = datetime('now')
         WHERE id = ?`
      ).run(reviewerSessionId, nextIteration, req.params.id)
    } else if (status === 'done') {
      // ── Deterministic floor on the SELF-CLAIM path (obj 2335) ──────────────
      // A direct working→done PATCH is a self-claimed completion that would
      // otherwise skip the floor the state-poller applies on the session-end
      // path. Gate it symmetrically: when this project is floor-active (global
      // flag OR its own `floor_config:<project>` opt-in row) and the objective is
      // coming straight from `working`, run the floor first. A RED floor BLOCKS
      // the completion (the LLM/worker claim cannot bypass it); everything else
      // (green / fail-safe-open / not opted in) advances exactly as before.
      if (existing.status === 'working' && isFloorActiveForProject(db, existing.project)) {
        const decision = evaluateFloorGate({
          getConfig: () => getFloorConfig(db, existing.project),
          resolveCwd: () => resolveFloorCwd(existing, () => resolveWorkdir(existing)),
          run: (cfg, cwd) => runFloor(cfg, cwd),
          // Self-claim never had an LLM reviewer queued → llmWouldHaveRun=false.
          record: (cwd, run) => recordFloorRunRow(db, existing, 'done', cwd, run, false),
          logMilestone: (title, detail) => logFloorMilestoneRow(db, existing, title, detail),
        })
        if (decision.action === 'block') {
          logFloorMilestoneRow(
            db,
            existing,
            'floor_caught_failure',
            `Self-claimed working→done BLOCKED — deterministic floor FAILED on \`${decision.run.failedCommand}\`. ` +
              `A completion claim cannot bypass the floor (obj 2335).`,
          )
          // Persist the failing output as the verdict/findings and bounce the
          // worker back to `working` with the floor feedback (mirrors the poller's
          // red-floor branch). No live session → park in `review` for a human.
          db.prepare(
            "UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
          ).run(decision.followUp, existing.id)
          if (existing.session_id) {
            try {
              const newSessionId = sendFollowUp(existing.session_id, decision.followUp, existing)
              db.prepare(
                "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
              ).run(newSessionId, existing.id)
            } catch {
              db.prepare(
                "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
              ).run(existing.id)
            }
          } else {
            db.prepare(
              "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
            ).run(existing.id)
          }
          const bounced = db.prepare('SELECT * FROM objectives WHERE id = ?').get(existing.id) as Objective
          broadcast({ type: 'objective_updated', payload: bounced })
          res.status(409).json({
            error: 'Deterministic floor failed — completion blocked',
            floor: { failedCommand: decision.run.failedCommand, findings: decision.followUp },
          })
          return
        }
      }

      // ── Oracle hard merge gate on the SELF-CLAIM path (obj 700316) ─────────
      // Symmetric to the poller: when `kitchen_loop_oracle_gate` is ON AND the
      // target is the command-center-infra pilot, a direct working→done PATCH must
      // not skip the regression oracle. A non-GREEN verdict BLOCKS (409) and bounces
      // the worker. SCOPE GUARD inside isOracleGateActiveForObjective ⇒ no other
      // workspace is ever gated; flag OFF ⇒ this block is never entered.
      if (existing.status === 'working' && isOracleGateActiveForObjective(db, existing)) {
        const oracleDecision = evaluateOracleGate({
          resolveCwd: () => resolveFloorCwd(existing, () => resolveWorkdir(existing)),
          run: (cfg, cwd) => runFloor(cfg, cwd),
          logMilestone: (title, detail) => logFloorMilestoneRow(db, existing, title, detail),
        })
        if (oracleDecision.action === 'block') {
          logFloorMilestoneRow(
            db,
            existing,
            'oracle_caught_regression',
            `Self-claimed working→done BLOCKED — regression oracle returned non-GREEN. ` +
              `A completion claim cannot bypass the oracle gate (obj 700316).`,
          )
          db.prepare(
            "UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
          ).run(oracleDecision.followUp, existing.id)
          if (existing.session_id) {
            try {
              const newSessionId = sendFollowUp(existing.session_id, oracleDecision.followUp, existing)
              db.prepare(
                "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
              ).run(newSessionId, existing.id)
            } catch {
              db.prepare(
                "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
              ).run(existing.id)
            }
          } else {
            db.prepare(
              "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
            ).run(existing.id)
          }
          const bounced = db.prepare('SELECT * FROM objectives WHERE id = ?').get(existing.id) as Objective
          broadcast({ type: 'objective_updated', payload: bounced })
          res.status(409).json({
            error: 'Regression oracle non-GREEN — completion blocked',
            oracle: { findings: oracleDecision.followUp },
          })
          return
        }
      }

      // ── Outcome verification on the SELF-CLAIM path (obj 700028) ───────────
      // Symmetric to the poller: a non-code objective that opts in (per-objective
      // or per-type `outcome_assertion:*` row) gets its outcome assertion run on a
      // direct working→done PATCH too, so a self-claimed completion cannot bypass
      // the outcome gate. Flag-guarded, GLOBAL DEFAULT OFF, fail-safe-open. A RED
      // outcome BLOCKS the completion (409) and bounces the worker, mirroring the
      // floor branch above. Independent of the code floor — runs even when this
      // objective has no project / no code checks.
      if (existing.status === 'working' && isOutcomeVerificationActiveForObjective(db, existing)) {
        const outcomeDecision = evaluateOutcomeGate({
          getConfig: () => getOutcomeAssertion(db, existing),
          resolveFallbackCwd: () => resolveFloorCwd(existing, () => resolveWorkdir(existing)),
          run: (cfg, cwd) => runFloor(cfg, cwd),
          record: (cwd, run) => recordOutcomeRunRow(db, existing, 'done', cwd, run),
          logMilestone: (title, detail) => logFloorMilestoneRow(db, existing, title, detail),
        })
        if (outcomeDecision.action === 'block') {
          logFloorMilestoneRow(
            db,
            existing,
            'outcome_caught_failure',
            `Self-claimed working→done BLOCKED — outcome verification FAILED on \`${outcomeDecision.run.failedCommand}\`. ` +
              `A completion claim cannot bypass the outcome gate (obj 700028).`,
          )
          db.prepare(
            "UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
          ).run(outcomeDecision.followUp, existing.id)
          if (existing.session_id) {
            try {
              const newSessionId = sendFollowUp(existing.session_id, outcomeDecision.followUp, existing)
              db.prepare(
                "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
              ).run(newSessionId, existing.id)
            } catch {
              db.prepare(
                "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
              ).run(existing.id)
            }
          } else {
            db.prepare(
              "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
            ).run(existing.id)
          }
          const bounced = db.prepare('SELECT * FROM objectives WHERE id = ?').get(existing.id) as Objective
          broadcast({ type: 'objective_updated', payload: bounced })
          res.status(409).json({
            error: 'Outcome verification failed — completion blocked',
            outcome: { failedCommand: outcomeDecision.run.failedCommand, findings: outcomeDecision.followUp },
          })
          return
        }
      }
      // ── CI-green gate (obj 704785) ────────────────────────────────────────
      // The last gate before `done`. The three gates above judge the code; this one
      // judges the PR's REQUIRED checks, which nothing previously looked at — which
      // is how objectives closed on red PRs and left them ownerless. A FAILING
      // required check blocks (409) and hands the worker the specific check names; an
      // ABSENT/queued one only holds for a bounded window and then completes with a
      // durable record; advisory red never blocks. Fails open on any error.
      {
        const gate = await runCompletionGate(db, existing, { pathway: 'human-patch-done', alert: insertAlert })
        if (gate.blocked) {
          const landed = applyGateHandback(db, existing, gate, { sendFollowUp, broadcast })
          res.status(409).json({
            error: gate.decision.action === 'escalate'
              ? 'PR required checks still failing after the hold cap — escalated to Operator'
              : 'PR required checks not green — completion blocked',
            ciGate: {
              action: gate.decision.action,
              failingRequired: gate.decision.failingRequired,
              missingRequired: gate.decision.missingRequired,
              advisoryRed: gate.decision.advisoryRed,
              requiredSource: gate.decision.requiredSource,
              reason: gate.decision.reason,
              landedStatus: landed,
              findings: gate.handback,
            },
          })
          return
        }
      }

      // Record outcome as success on last session intel
      if (existing.session_id) {
        db.prepare(
          "UPDATE session_intel SET outcome = 'success' WHERE session_id = ? AND outcome IS NULL"
        ).run(existing.session_id)
        await stopSession(existing.session_id)
      }
      db.prepare(
        "UPDATE objectives SET status = ?, session_id = NULL, updated_at = datetime('now') WHERE id = ?"
      ).run(status, req.params.id)

      // Release any branch lease this objective held (obj 994) so the branch is
      // immediately reclaimable. Reclamation-on-stale covers crashes; this is the
      // clean path. Also release the non-PR identity lease(s) (obj 1075) — no-op for
      // PR objectives, which hold no session_leases rows.
      releaseBranchLeasesForObjective(db, Number(req.params.id))
      releaseSessionLeasesForObjective(db, Number(req.params.id))

      // Clean up the git worktree + local branch. As of obj 1059 EVERY
      // project-scoped session is isolated into /tmp/cc-worktree-<id>, so cleanup
      // keys on `project`, not on a persisted branch_name (task workers never set
      // one). The branch to delete is the deterministic worktree branch.
      if (existing.project) {
        const worktreePath = `/tmp/cc-worktree-${existing.id}`
        const wtBranch = existing.branch_name || deriveWorktreeBranchName(existing)
        try {
          // Remove worktree directory first
          execSync(`rm -rf ${worktreePath} 2>/dev/null || true`, { timeout: 5000 })
          // Prune worktree references from all project repos
          execSync(`find /home/operator/projects -maxdepth 2 -name .git -type d -exec git --git-dir={} worktree prune 2>/dev/null \\;`, { timeout: 10000 })
          // Delete the local branch from the project repo (if we know which one)
          if (wtBranch) {
            const projectDir = `/home/operator/projects/${existing.project}`
            execSync(`git -C ${projectDir} branch -D ${wtBranch} 2>/dev/null || true`, { timeout: 5000 })
          }
          console.log(`[objectives] Cleaned up worktree and branch for objective ${existing.id}: ${wtBranch || '(no branch)'}`)
        } catch (err) {
          console.log(`[objectives] Worktree cleanup failed for ${existing.id}: ${err instanceof Error ? err.message : err}`)
        }
      }
    } else {
      db.prepare(
        "UPDATE objectives SET status = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(status, req.params.id)
    }
  } catch (err) {
    // Branch-lease conflict (obj 994): another objective owns this branch and is
    // live. Status was NOT changed (the throw precedes the UPDATE), so the row is
    // not stranded — surface 409 so the operator sees the duplicate was suppressed.
    if (err instanceof BranchLeaseConflictError) {
      res.status(409).json({ error: err.message, branch_name: err.branchName, owner_objective_id: err.ownerObjectiveId })
      return
    }
    // Identity-lease conflict (obj 1075): a duplicate non-PR card is live on this
    // identity. Status was NOT changed (throw precedes the UPDATE) and a 'warning'
    // board event was already recorded — surface 409 to the caller.
    if (err instanceof SessionLeaseConflictError) {
      res.status(409).json({ error: err.message, lease_key: err.leaseKey, owner_objective_id: err.ownerObjectiveId })
      return
    }
    const message = err instanceof Error ? err.message : 'Session operation failed'
    res.status(500).json({ error: message })
    return
  }

  // Human-terminal marker (obj 700415, FIX B). This is the authenticated HUMAN
  // surface, so a transition here is an explicit human action: mark the objective
  // human-terminated when a human ends it (→ done/review), and clear the marker
  // when a human explicitly reopens it (→ working). Machine reactivation pathways
  // consult this marker under CC_HUMAN_TERMINAL_GUARD (default OFF → dry-run).
  if (status === 'done' || status === 'review') {
    db.prepare('UPDATE objectives SET terminal_by_human = 1 WHERE id = ?').run(req.params.id)
  } else if (status === 'working') {
    db.prepare('UPDATE objectives SET terminal_by_human = 0 WHERE id = ?').run(req.params.id)
  }

  // Append exactly one audit row for this status transition (obj 700415).
  logObjectiveAudit(db, {
    objectiveId: Number(req.params.id),
    eventType: 'status_change',
    fromStatus: existing.status,
    toStatus: status,
    actor: 'user',
    pathway: 'public-patch-status',
    sessionId: existing.session_id,
    titleSnapshot: existing.title,
    workspace: existing.workspace,
  })

  const updated = mapObjective(
    db.prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective
  )

  broadcast({ type: 'objective_updated', payload: updated })

  // Orphan-child cleanup on parent-terminal (obj 700595, FIX 1a). When this
  // objective reaches a terminal state, retire its still-queued, never-ran
  // children to `cancelled` instead of stranding them. Event-driven + always
  // live (safe: never touches a child that produced work). Best-effort.
  if (status === 'done' || status === 'review' || status === 'cancelled') {
    try {
      cleanupOrphanedChildrenOnParentTerminal(db, Number(req.params.id), broadcast, status)
    } catch (err) {
      console.error('[objectives] orphan-child cleanup failed:', (err as Error).message)
    }
  }

  res.json(updated)
})

}
