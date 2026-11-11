/**
 * Auto-re-review for preview-infra-blocked PRs (obj 719328, distill 2026-10-28 P2).
 *
 * WHY THIS EXISTS: `selfHealHarnessStatus` (pr-linkage.ts) is pass-only BY DESIGN
 * (gated on `latestVerdictIsPass`, L258-259) — it must never flip a FAIL/blocked
 * verdict into success, and this module does not touch it or its sweep. But that
 * means a `blocked` PR has exactly ONE recovery path today: a human resurrects the
 * objective to `working` (chat/upload/reopen). When the block was pure preview-tier
 * infra (the reviewer couldn't reach `pr-N.cc.example.com`, not an app bug — see
 * the `PREVIEW-INFRA-UNREACHABLE:` marker added to the reviewer prompt in the P1
 * companion change), the code was never actually verified bad; it just sat RED
 * until someone noticed and reopened it by hand.
 *
 * This module is a SIBLING to pr-linkage.ts's self-heal sweep, not a modification
 * of it: it only ever acts on objectives already tagged `blocked_reason =
 * 'preview-infra'` by the persist path in poller-ai-review.ts, and it moves them
 * back to `working` (the exact same transition a human reopen performs) so the
 * NORMAL re-review path (worker respawn → reviewer → fresh verdict) fires on its
 * own. It never assigns a verdict itself.
 *
 * Capped at {@link PREVIEW_INFRA_RESURRECT_CAP} probe attempts per PR, for the PR's
 * whole lifetime (not a rolling window — mirrors the discipline of
 * ci-followup-cap.ts, but that module counts DELIVERED follow-ups over 30 days;
 * this counts PROBES, unbounded in time, because a preview outage can span days
 * and the risk being capped is "wake a dead session repeatedly forever", not spend
 * velocity). Every decision (resurrected / still-down / cap-exhausted) is logged to
 * console and to the attempts table so it is auditable.
 */
import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { PR_LINKAGE_REPO } from './pr-linkage.js'
import { REPO_SCOPE_SQL, repoScopeParams } from './objective-prs.js'
import { previewHostFor } from '../lib/preview-health.js'
import { startSession } from './session-manager.js'
import { broadcast } from '../ws/index.js'

/** The exact marker the reviewer prompt (P1) begins `<findings>` with on a
 *  confirmed preview-infra outage. Findings text, not a structured field, so this
 *  prefix match is the one place that string is interpreted as a signal. */
export const PREVIEW_INFRA_MARKER = 'PREVIEW-INFRA-UNREACHABLE:'

/** True iff a reviewer's findings opened with the P1 infra marker. */
export function isPreviewInfraBlockedFindings(findings: string | null | undefined): boolean {
  return !!findings && findings.trim().startsWith(PREVIEW_INFRA_MARKER)
}

/** Cap on probe attempts per PR, for the PR's whole lifetime (not time-windowed). */
export const PREVIEW_INFRA_RESURRECT_CAP = 3

/** Cadence for the sweep — matches the EARNED_STATUS_BACKSTOP_INTERVAL_MS precedent
 *  (pr-linkage.ts): a probe sweep is cheap but not free (one fetch per candidate),
 *  and recovery is not time-critical to the second. */
export const PREVIEW_INFRA_RESURRECT_SWEEP_INTERVAL_MS = 10 * 60 * 1000

const PROBE_TIMEOUT_MS = 8_000

export function ensurePreviewInfraResurrectTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS preview_infra_resurrect_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      pr_number INTEGER NOT NULL,
      host TEXT NOT NULL,
      outcome TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_preview_infra_resurrect_objective
      ON preview_infra_resurrect_attempts (objective_id, created_at);
  `)
}

export type PreviewInfraResurrectOutcome = 'resurrected' | 'still-down' | 'probe-error'

export function countPreviewInfraResurrectAttempts(db: Database, objectiveId: number): number {
  try {
    ensurePreviewInfraResurrectTable(db)
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM preview_infra_resurrect_attempts WHERE objective_id = ?')
      .get(objectiveId) as { n: number } | undefined
    return row?.n || 0
  } catch (err) {
    console.warn('[preview-infra-resurrect] attempt count failed (treating as 0):', (err as Error).message)
    return 0
  }
}

export function recordPreviewInfraResurrectAttempt(
  db: Database,
  objectiveId: number,
  prNumber: number,
  host: string,
  outcome: PreviewInfraResurrectOutcome,
): void {
  try {
    ensurePreviewInfraResurrectTable(db)
    db.prepare(
      `INSERT INTO preview_infra_resurrect_attempts (objective_id, pr_number, host, outcome, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(objectiveId, prNumber, host, outcome)
  } catch (err) {
    console.warn('[preview-infra-resurrect] failed to record attempt (best-effort, non-fatal):', (err as Error).message)
  }
}

/**
 * Candidates: review/done objectives the P1→persist path tagged as a pure
 * infra block, repo-scoped (same `REPO_SCOPE_SQL` discipline as pr-linkage.ts —
 * without it a PR from another repo sharing the branch-name template could be
 * probed against the wrong host) and bounded.
 */
export function selectPreviewInfraBlockedCandidates(db: Database, repo: string = PR_LINKAGE_REPO): Objective[] {
  try {
    return db
      .prepare(
        `SELECT o.* FROM objectives o
          WHERE o.status IN ('review','done') AND o.ai_review_verdict = 'blocked'
            AND o.blocked_reason = 'preview-infra'
            AND o.pr_number IS NOT NULL
            AND ${REPO_SCOPE_SQL}
          ORDER BY o.updated_at DESC
          LIMIT 50`,
      )
      .all(...repoScopeParams(repo)) as Objective[]
  } catch (err) {
    console.error('[preview-infra-resurrect] candidate query failed:', (err as Error).message)
    return []
  }
}

/** Probe result — mirrors `PreviewProbeResult` in lib/preview-health.ts but this
 *  checks a SPECIFIC route (`/login`) rather than the bare host root, per the
 *  design sketch ("a healthy response (200 on the login route)"). */
export interface LoginRouteProbeResult {
  ok: boolean
  httpCode: number | null
}

/** Injectable probe fn so the decision logic is unit-testable without a network call. */
export type PreviewProbe = (host: string) => Promise<LoginRouteProbeResult>

/** Real probe: GET https://{host}/login, 200 = recovered. Never throws. */
export async function probePreviewLoginRoute(host: string): Promise<LoginRouteProbeResult> {
  try {
    const res = await fetch(`https://${host}/login`, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    return { ok: res.status === 200, httpCode: res.status }
  } catch {
    return { ok: false, httpCode: null }
  }
}

/** Resurrects an objective exactly like the human `working`-from-`review` reopen
 *  path (routes/objectives-status.ts `startsFromReviewLike`): spawn a fresh worker
 *  session and flip status→working, so the NORMAL re-review cycle (worker →
 *  reviewer → verdict) fires on its own. Injected so decision logic is testable. */
export type StartWorkingSession = (objective: Objective) => Promise<string>

export interface ResurrectDecision {
  objectiveId: number
  prNumber: number
  host: string
  outcome: PreviewInfraResurrectOutcome | 'cap-exhausted'
}

/**
 * Pure-ish decision loop: for each candidate, cap-check, probe, and on a healthy
 * response resurrect to `working`. Never throws — one candidate's failure must not
 * block the rest of the sweep. Does not write `ai_review_verdict` — leaves that to
 * the next reviewer pass.
 */
export async function resurrectPreviewInfraBlockedObjectives(
  db: Database,
  deps: { probe: PreviewProbe; startWorkingSession: StartWorkingSession },
  repo: string = PR_LINKAGE_REPO,
): Promise<ResurrectDecision[]> {
  const decisions: ResurrectDecision[] = []
  for (const obj of selectPreviewInfraBlockedCandidates(db, repo)) {
    const prNumber = obj.pr_number as number
    const host = previewHostFor(prNumber)
    try {
      const attempts = countPreviewInfraResurrectAttempts(db, obj.id)
      if (attempts >= PREVIEW_INFRA_RESURRECT_CAP) {
        console.log(
          `[preview-infra-resurrect] obj ${obj.id} (PR #${prNumber}) at cap ` +
          `(${attempts}/${PREVIEW_INFRA_RESURRECT_CAP}) — not probing again, needs a human.`,
        )
        decisions.push({ objectiveId: obj.id, prNumber, host, outcome: 'cap-exhausted' })
        continue
      }

      let probe: LoginRouteProbeResult
      try {
        probe = await deps.probe(host)
      } catch (err) {
        console.warn(`[preview-infra-resurrect] probe threw for obj ${obj.id} (${host}):`, (err as Error).message)
        recordPreviewInfraResurrectAttempt(db, obj.id, prNumber, host, 'probe-error')
        decisions.push({ objectiveId: obj.id, prNumber, host, outcome: 'probe-error' })
        continue
      }

      if (!probe.ok) {
        recordPreviewInfraResurrectAttempt(db, obj.id, prNumber, host, 'still-down')
        console.log(
          `[preview-infra-resurrect] obj ${obj.id} (PR #${prNumber}, ${host}) still down ` +
          `(attempt ${attempts + 1}/${PREVIEW_INFRA_RESURRECT_CAP}).`,
        )
        decisions.push({ objectiveId: obj.id, prNumber, host, outcome: 'still-down' })
        continue
      }

      // Re-read immediately before writing — a human may have already reopened or
      // closed this card between SELECT and here (sweep runs on a 10-min cadence).
      const fresh = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective | undefined
      if (!fresh || fresh.status !== obj.status || fresh.ai_review_verdict !== 'blocked' || fresh.blocked_reason !== 'preview-infra') {
        console.log(`[preview-infra-resurrect] obj ${obj.id} changed state before resurrect — skipping this tick.`)
        continue
      }

      const sessionId = await deps.startWorkingSession(fresh)
      db.prepare(
        "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('review','done')",
      ).run(sessionId, obj.id)
      recordPreviewInfraResurrectAttempt(db, obj.id, prNumber, host, 'resurrected')
      console.log(
        `[preview-infra-resurrect] obj ${obj.id} (PR #${prNumber}, ${host}) RECOVERED — resurrected to working, session ${sessionId}.`,
      )
      decisions.push({ objectiveId: obj.id, prNumber, host, outcome: 'resurrected' })
    } catch (err) {
      console.error(`[preview-infra-resurrect] decision loop threw for obj ${obj.id}:`, (err as Error).message)
    }
  }
  return decisions
}

let lastSweepAt = 0

/**
 * Production wiring, throttled to {@link PREVIEW_INFRA_RESURRECT_SWEEP_INTERVAL_MS}.
 * Called from the poller loop (poller-loop.ts) as its own try/catch block, a
 * SIBLING of `sweepPRLinkageAndHarness` — deliberately not folded into it, so this
 * module can be killed/changed independently of the pass-only self-heal sweep.
 */
export async function sweepPreviewInfraResurrect(): Promise<void> {
  const nowMs = Date.now()
  if (nowMs - lastSweepAt < PREVIEW_INFRA_RESURRECT_SWEEP_INTERVAL_MS) return
  lastSweepAt = nowMs

  const db = getDb()
  const decisions = await resurrectPreviewInfraBlockedObjectives(db, {
    probe: probePreviewLoginRoute,
    startWorkingSession: startSession,
  })
  for (const d of decisions) {
    if (d.outcome !== 'resurrected') continue
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(d.objectiveId) as Objective | undefined
    if (updated) broadcast({ type: 'objective_updated', payload: updated })
  }
}
