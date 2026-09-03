/**
 * Preview TLS check + PR-created hook — extracted from internal.ts
 * (behavior frozen). Localhost gate and SQL unchanged.
 */
import { Router } from 'express'
import { getDb, resolveStrategyId } from '../db/index.js'
import { broadcast } from '../ws/index.js'
import { getDefaultModelId } from '../services/model-registry.js'
import type { Objective } from '@operationkit/shared'
import { parsePrNumberFromUrl } from '../services/pr-url.js'
import { upsertObjectivePR } from '../services/objective-prs.js'
import { enqueuePreviewDeploy, kickHostDrain } from '../services/preview-spool.js'
import { depthForParent } from '../lib/objective-depth.js'
import { isLocalhost } from '../lib/is-localhost.js'

export function registerInternalPreviewRoutes(router: Router): void {
// Caddy on-demand TLS check — validates preview subdomains
router.get('/check-preview', (req, res) => {
  const domain = req.query.domain as string
  if (domain?.match(/^pr-\d+\.ai\.examplegrowth\.com$/)) {
    res.status(200).end()
  } else {
    res.status(404).end()
  }
})

// Session reports PR creation — updates objective with branch/PR info
router.post('/pr-created', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const { objective_id, branch_name, pr_url, pr_number } = req.body as {
    objective_id: number
    branch_name?: string
    pr_url?: string
    pr_number?: number
  }
  if (!objective_id) {
    res.status(400).json({ error: 'objective_id required' })
    return
  }
  // Durable correctness: never leave pr_number NULL when pr_url is set. Workers often
  // link only the URL; without the number the harness gate can't post harness/test-agent
  // and the PR is stuck BLOCKED. Derive the number from the URL when not supplied.
  const resolvedPrNumber = pr_number ?? parsePrNumberFromUrl(pr_url)
  const db = getDb()
  db.prepare(
    "UPDATE objectives SET branch_name = ?, pr_url = ?, pr_number = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(branch_name || null, pr_url || null, resolvedPrNumber || null, objective_id)

  // Append to the per-objective PR log (obj 2300). This is ADDITIVE to the
  // "latest pointer" UPDATE above — two distinct PRs from one objective become
  // two rows; a re-reported PR upserts the same row. A branch-only report (no
  // resolvable PR number) inserts nothing, leaving the branch_name behavior intact.
  upsertObjectivePR({
    objective_id,
    pr_number: resolvedPrNumber,
    pr_url,
    branch_name,
  })

  const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective_id) as Objective
  if (updated) broadcast({ type: 'objective_updated', payload: updated })
  console.log(`[internal] PR created for objective ${objective_id}: ${pr_url || branch_name}`)

  // Auto-deploy the PR preview (obj 1452). The harness/test-agent (the
  // adversarial review spawned just below) drives the LIVE preview at
  // https://pr-<N>.cc.example.com via Playwright; without an auto-deploy it
  // hit a dead host and the PR got a spurious BLOCKED. We enqueue a deploy job
  // for the host-side privileged runner (the Caddy/docker-build steps need host
  // root the container lacks). Best-effort: a spool failure never fails this
  // request, and the runner/preview-deploy.sh is idempotent on re-request.
  if (resolvedPrNumber && (branch_name || updated?.branch_name)) {
    if (enqueuePreviewDeploy(resolvedPrNumber, branch_name || updated?.branch_name, objective_id)) {
      kickHostDrain() // fire the host-root drain now; no systemd install required
    }
  }

  // Auto-spawn adversarial PR review if a PR URL was provided
  if (pr_url && updated) {
    try {
      // Check if a review objective already exists for this PR
      const existingReview = db.prepare(
        "SELECT id FROM objectives WHERE parent_id = ? AND title LIKE '%[Review]%'"
      ).get(objective_id)

      if (!existingReview) {
        const reviewTitle = `[Review] ${updated.title}`
        const reviewDescription = [
          `Adversarial review of PR: ${pr_url}`,
          '',
          `**Original objective:** ${updated.title}`,
          `**Branch:** ${branch_name || 'unknown'}`,
          '',
          'You are an INDEPENDENT reviewer. Your job is to find problems the author missed.',
          'You have NOT seen the author\'s reasoning — judge the code on its own merits.',
          '',
          '## Review checklist:',
          '1. Read the PR diff thoroughly (`gh pr diff`)',
          '2. Check for bugs, logic errors, edge cases',
          '3. Check for security issues (injection, auth bypass, data exposure)',
          '4. Check for performance regressions',
          '5. Verify tests exist and cover the changes',
          '6. Check for unintended side effects on existing functionality',
          '',
          'Post your review as a PR comment via `gh pr review` with APPROVE, REQUEST_CHANGES, or COMMENT.',
        ].join('\n')

        // Pin the model explicitly to the registry default. The objectives.model
        // column DEFAULT is the dead 'claude-fable-5' on the legacy prod DB (the
        // 2026-06-13 registry cutover repointed row VALUES but never changed the
        // column DEFAULT). A disabled model never spawns, so an omitted model here
        // strands every auto-created review in `queue` and parks the parent
        // delegator forever (bug 836).
        // Provenance (obj 2386): a system-spawned adversarial review child is a
        // strategy-decomposed objective; strategy_id inherits from its parent.
        const reviewStrategyId = resolveStrategyId(db, null, objective_id)
        // depth is DERIVED (obj 707003): this child used to omit the column
        // entirely and inherit the NOT NULL DEFAULT 0, mislabelling a review of
        // a depth-1 worker as a top-level row until the next boot backfill.
        const result = db.prepare(
          `INSERT INTO objectives (title, description, status, agent_context, workspace, project, workflow_hint, parent_id, depth, model, origin, strategy_id, created_at, updated_at)
           VALUES (?, ?, 'queue', 'cto', ?, ?, 'adversarial', ?, ?, ?, 'strategy', ?, datetime('now'), datetime('now'))`
        ).run(reviewTitle, reviewDescription, updated.workspace || 'example', updated.project, objective_id, depthForParent(db, objective_id), getDefaultModelId(), reviewStrategyId)

        const reviewObjective = db.prepare('SELECT * FROM objectives WHERE id = ?').get(result.lastInsertRowid) as Objective
        if (reviewObjective) {
          broadcast({ type: 'objective_updated', payload: reviewObjective })
          console.log(`[internal] Auto-created adversarial review objective ${reviewObjective.id} for PR ${pr_url}`)
        }
      }
    } catch (err) {
      console.warn(`[internal] Failed to auto-create PR review objective:`, err)
    }
  }

  res.json({ ok: true })
})

}
