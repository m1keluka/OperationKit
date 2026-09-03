/**
 * AI-review side effects and persist loop — extracted from state-poller.ts (behavior frozen).
 * Verdict parse, screenshot upload, cap-out, watchdog force-route, harness status,
 * PR-linkage sweep, and pollAIReviewSessions. The worker poll loop stays in the facade.
 */
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import type { Objective, ObjectiveStatus } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import {
  getSessionOutput,
  stopSession,
  getSessionState,
  handleSessionDeath,
  sendFollowUp,
  computeObjectiveSpend,
  resolveWorkdir,
} from './session-manager.js'
import { sendTelegram, insertAlert } from './notifier.js'
import { runCompletionGate, applyGateHandback } from './ci-green-gate.js'
import { wakeDelegator } from './delegation.js'
import { broadcast } from '../ws/index.js'
import { signUpload } from './supabase-storage.js'
import { mustRouteToHumanReview } from '../lib/human-tracked.js'
import { skipMachineStatusWrite, runMachineStatusUpdate } from '../lib/status-lock.js'
import { evaluateAutoMerge } from './auto-merge.js'
import { TRANSCRIPT_DIR } from '../config.js'
import { deriveWorktreeBranchName } from './branch-scope.js'
import { isGateRejectionMemoryEnabled, getObjectiveTreeSha } from './governance.js'
import { parsePrNumberFromUrl } from './pr-url.js'
import {
  discoverAndBackfillPR,
  selfHealHarnessStatus,
  isPrAutolinkKilled,
  selectAgedEarnedStatusTargets,
  EARNED_STATUS_BACKSTOP_INTERVAL_MS,
  type GhExec,
} from './pr-linkage.js'
import {
  type CapOutReason,
  type WatchdogReason,
  AI_REVIEW_ITERATION_CAP,
  extractTag,
  extractFeatureBriefTag,
  extractScreenshotsTag,
  extractJsonArrayTag,
  parseAcceptanceCriteria,
  parseCriteriaResults,
  extractScreenshotPaths,
  decideRespawnAction,
  failingCriterionIds,
  budgetCeilingForEffort,
} from './poller-decisions.js'
import { delegatorParentOf } from './poller-delegator.js'

/** A single parsed test-agent criterion result (PR-gated harness loop). */
interface CriterionResult {
  id?: string
  criterion?: string
  status?: string
  severity?: string
  repro?: string
  expected?: string
  actual?: string
}

/**
 * Build an "UNRESOLVED CRITICAL FAILURES" markdown block from the latest persisted
 * review's criteria_results — listing every critical+fail criterion with repro and
 * expected-vs-actual. Returns '' if there are none (or on any parse/DB error), so
 * callers can prepend it unconditionally. PR-gated harness loop only.
 */
function buildCriticalFailureBlock(objectiveId: number): string {
  try {
    const row = getDb()
      .prepare(
        'SELECT criteria_results FROM objective_reviews WHERE objective_id = ? ORDER BY iteration DESC LIMIT 1'
      )
      .get(objectiveId) as { criteria_results: string } | undefined
    if (!row?.criteria_results) return ''
    const parsed = JSON.parse(row.criteria_results) as CriterionResult[]
    if (!Array.isArray(parsed)) return ''
    const critical = parsed.filter(c => c.severity === 'critical' && c.status === 'fail')
    if (critical.length === 0) return ''
    const lines = critical.map(c =>
      `- **${c.id || c.criterion || 'criterion'}** — ${c.criterion || ''}\n`
      + `  - repro: ${c.repro || '(none)'}\n`
      + `  - expected: ${c.expected || '(none)'}\n`
      + `  - actual: ${c.actual || '(none)'}`
    )
    return `## ⚠️ UNRESOLVED CRITICAL FAILURES (${critical.length})\n\n${lines.join('\n')}`
  } catch (err) {
    console.warn(`[state-poller] buildCriticalFailureBlock failed for obj ${objectiveId}:`, (err as Error).message)
    return ''
  }
}

// ── Reviewer verdict extraction ──────────────────────────────────────────────

export function extractReviewerOutput(sessionId: string): {
  verdict: 'pass' | 'fail' | 'blocked' | null
  findings: string | null
  mode: 'browser' | 'api' | 'doc' | 'noop'
  transcript: string
  // PR-gated harness loop: machine-readable, ready-to-store JSON strings.
  criteriaResults: string
  screenshotPaths: string
  artifactPaths: string
  // Stakeholder changelog (obj 937): raw FeatureBrief JSON string ('' if absent/invalid)
  // and the absolute screenshot paths from the reviewer's <screenshots> block.
  featureBrief: string
  screenshotPathsList: string[]
} {
  // Concatenate all assistant text from the reviewer's JSONL — verdict can land
  // in any of the last few messages, especially in long sessions with tool use.
  let transcript = ''
  try {
    const messages = getSessionOutput(sessionId)
    transcript = messages.filter(m => m.type === 'assistant' && m.text).map(m => m.text!).join('\n\n')
  } catch {}
  const verdictRaw = extractTag(transcript, 'verdict')
  const verdict = verdictRaw?.toLowerCase() === 'pass' ? 'pass'
    : verdictRaw?.toLowerCase() === 'fail' ? 'fail'
    : verdictRaw?.toLowerCase() === 'blocked' ? 'blocked'
    : null
  const findings = extractTag(transcript, 'findings')
  const modeRaw = extractTag(transcript, 'mode')?.toLowerCase()
  const mode: 'browser' | 'api' | 'doc' | 'noop' =
    modeRaw === 'api' ? 'api'
      : modeRaw === 'doc' ? 'doc'
      : modeRaw === 'noop' ? 'noop'
      : 'browser'
  // Structured test-agent output (only emitted by PR reviewers; '[]' otherwise).
  const criteriaResults = extractJsonArrayTag(transcript, 'criteria_results')
  const screenshotPaths = extractJsonArrayTag(transcript, 'screenshot_paths')
  const artifactPaths = extractJsonArrayTag(transcript, 'artifact_paths')
  // Stakeholder changelog (obj 937).
  const featureBrief = extractFeatureBriefTag(transcript)
  const screenshotPathsList = extractScreenshotsTag(transcript)
  return {
    verdict, findings, mode, transcript,
    criteriaResults, screenshotPaths, artifactPaths,
    featureBrief, screenshotPathsList,
  }
}

// ── Stakeholder screenshot upload (obj 937) ──────────────────────────────────
// Best-effort: reads each local screenshot the reviewer captured and PUTs it to
// Supabase storage via a signed upload URL, returning the PUBLIC URLs. This MUST
// NEVER throw or block the verdict/persistence path — if Supabase is unconfigured
// (getStorageConfig throws) or any upload fails, we log and return whatever
// succeeded (possibly []).
export async function uploadReviewScreenshots(
  objectiveId: number,
  iteration: number,
  localPaths: string[],
): Promise<string[]> {
  if (!localPaths.length) return []
  const urls: string[] = []
  try {
    for (const localPath of localPaths) {
      try {
        if (!localPath || !fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) continue
        const bytes = fs.readFileSync(localPath)
        const base = path.basename(localPath)
        const ext = path.extname(base).toLowerCase()
        const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
        const objectPath = `ai-review-screenshots/${objectiveId}/${iteration}/${base}`
        const { putUrl, publicUrl } = await signUpload(objectPath)
        const res = await fetch(putUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentType, 'x-upsert': 'true' },
          body: bytes,
        })
        if (res.ok) {
          urls.push(publicUrl)
        } else {
          console.warn(`[state-poller] screenshot upload failed (${res.status}) for ${localPath}`)
        }
      } catch (err) {
        console.warn(`[state-poller] screenshot upload error for ${localPath}:`, err instanceof Error ? err.message : err)
      }
    }
  } catch (err) {
    // getStorageConfig threw (Supabase unconfigured) or another fatal — degrade gracefully.
    console.warn(`[state-poller] screenshot upload skipped (storage unavailable):`, err instanceof Error ? err.message : err)
  }
  return urls
}

// ── Bounce policy (budget- and signal-aware) ─────────────────────────────────
// A failed review bounces the objective back to working — but only while it is
// still worth the money. Bouncing stops when ANY of:
//   (a) iteration cap reached (backstop),
//   (b) cumulative objective spend exceeds the effort-derived budget ceiling,
//   (c) the reviewer's findings repeat verbatim two iterations in a row
//       (no progress signal — another bounce just burns budget).
// On stop, the objective escalates to human review with a needs-human warning
// event + Telegram notification instead of silently parking.

/**
 * Stop bouncing for any cap-out reason: park the objective in human review
 * with a prominent needs-human marker (session_events warning row + JSONL
 * warning so SessionViewer shows it), then fire a Telegram escalation.
 */
export function escalateCapOut(
  obj: Objective,
  reason: CapOutReason,
  details: { iteration: number; spend: number; ceiling: number; findings: string | null }
): void {
  const db = getDb()
  const { iteration, spend, ceiling, findings } = details
  const reasonText =
    reason === 'iteration-cap'
      ? `iteration cap (${AI_REVIEW_ITERATION_CAP}) reached`
      : reason === 'budget'
        ? `cumulative budget ceiling exceeded — $${spend.toFixed(2)} spent vs $${ceiling} ceiling (effort '${obj.effort || 'normal'}')`
        : 'no progress — reviewer findings repeated verbatim two iterations in a row'

  // Delegator workers (a task with a delegator parent) must escalate to `review`
  // so the parent is re-nudged — never silently to `done`. Standalone tasks go
  // to `done` (no human gate). Projects/bugs always escalate to human review.
  let nextStatus: ObjectiveStatus =
    (obj.type === 'task' && delegatorParentOf(obj) == null) ? 'done' : 'review'
  // Human-tracked objectives never auto-complete — park in review for admin sign-off (obj-1074).
  if (mustRouteToHumanReview(obj) && nextStatus === 'done') nextStatus = 'review'
  // PR-gated harness loop (#840): when any persisted criterion is a critical failure,
  // prepend an explicit UNRESOLVED CRITICAL FAILURES block so Mike sees them in the
  // review column. Non-PR objectives keep the plain note.
  const criticalBlock = obj.pr_number ? buildCriticalFailureBlock(obj.id) : ''
  const capNote =
    (criticalBlock ? criticalBlock + '\n\n' : '') +
    [
      `⚠️ NEEDS HUMAN REVIEW — AI review bouncing stopped: ${reasonText}.`,
      `Cumulative objective spend: $${spend.toFixed(2)} (ceiling $${ceiling}, iteration ${iteration}/${AI_REVIEW_ITERATION_CAP}).`,
      '',
      'Last reviewer findings:',
      '',
      findings || '(no findings)',
    ].join('\n')

  // ── CI-green gate, RECORD-ONLY (obj 704785) ──────────────────────────────
  // An eighth done-transition: a standalone task that caps out goes straight to
  // `done`, and this path explicitly handles PR-bearing objectives (see the
  // criticalBlock above). Like review-hard-expiry, this path exists precisely to
  // STOP the bounce loop — holding here would re-enter the loop that just capped
  // out — so the gate runs in `record-only` mode: it never blocks, but a non-green
  // PR still lands on the pr-health digest with its reason instead of vanishing.
  // Fired without awaiting because record-only cannot change the outcome, which is
  // what keeps escalateCapOut synchronous for its many callers.
  if (nextStatus === 'done') {
    void runCompletionGate(db, obj, { mode: 'record-only', pathway: 'ai-review-cap-out' })
  }

  if (skipMachineStatusWrite(db, obj.id)) return

  runMachineStatusUpdate(
    db,
    "UPDATE objectives SET status = ?, ai_review_verdict = 'fail', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
    nextStatus,
    capNote,
    obj.id,
  )

  // Needs-human warning event — surfaces in the objective's events feed.
  const warnDescription = `NEEDS HUMAN: AI review capped out (${reasonText}). Spend $${spend.toFixed(2)}. Last findings: ${(findings || '(none)').slice(0, 300)}`
  try {
    db.prepare(
      `INSERT INTO session_events (session_id, objective_id, event_type, description, metadata, created_at)
       VALUES (?, ?, 'warning', ?, ?, datetime('now'))`
    ).run(
      obj.session_id || obj.ai_review_session_id || 'unknown',
      obj.id,
      warnDescription,
      JSON.stringify({
        kind: 'ai_review_cap_out',
        reason,
        iteration,
        spend_usd: Number(spend.toFixed(4)),
        ceiling_usd: ceiling,
        effort: obj.effort || 'normal',
        last_findings: (findings || '').slice(0, 2000),
      })
    )
  } catch (err) {
    console.error(`[state-poller] Failed to insert cap-out warning event for obj ${obj.id}:`, err)
  }

  // Prominent warning in the worker session JSONL — SessionViewer renders it.
  if (obj.session_id) {
    try {
      const jsonlPath = path.join(TRANSCRIPT_DIR, `${obj.session_id}.jsonl`)
      fs.appendFileSync(
        jsonlPath,
        JSON.stringify({
          type: 'warning',
          text: `⚠️ NEEDS HUMAN REVIEW: AI review bouncing stopped — ${reasonText}. Cumulative spend $${spend.toFixed(2)}.`,
          timestamp: new Date().toISOString(),
        }) + '\n'
      )
    } catch {}
  }

  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
       VALUES (?, ?, ?, ?, 'milestone', 'ai_review_cap_out', ?)`
    ).run(
      obj.project || 'unknown',
      obj.workspace,
      obj.id,
      obj.ai_review_session_id,
      `Bouncing stopped (${reason}): ${reasonText}. Spend $${spend.toFixed(2)}. Escalated to ${nextStatus}.`
    )
  } catch (err) {
    console.error(`[state-poller] Failed to log activity for cap-out on obj ${obj.id}:`, err)
  }

  // Telegram escalation — fire and forget; the warning event is the fallback.
  void sendTelegram(
    `Objective #${obj.id} ("${obj.title}") capped out of AI review: ${reasonText}. Spend $${spend.toFixed(2)} — needs human review.`
  )

  console.log(`[state-poller] Reviewer FAIL on objective ${obj.id} capped out (${reason}, spend $${spend.toFixed(2)}) → ${nextStatus}`)
}

/**
 * Force a hung/idle worker off `working` → `review`: kill the tmux session so it
 * stops burning, mark the objective `review` with a needs-human marker, and wake
 * the delegator parent. Fail-safe: any error is logged and swallowed so the
 * watchdog can never wedge the poller.
 */
export function forceRouteStuckWorker(objective: Objective, reason: WatchdogReason, detail: string): void {
  const db = getDb()
  try {
    if (skipMachineStatusWrite(db, objective.id)) return
    if (objective.session_id) {
      void stopSession(objective.session_id).catch(() => {})
    }
    const note = `⚠️ WATCHDOG: worker force-routed to review — ${reason === 'idle' ? 'idle beyond threshold' : 'wall-clock budget exceeded'} (${detail}).`
    runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
      objective.id,
    )
    try {
      db.prepare(
        `INSERT INTO session_events (session_id, objective_id, event_type, description, metadata, created_at)
         VALUES (?, ?, 'warning', ?, ?, datetime('now'))`
      ).run(
        objective.session_id || 'unknown',
        objective.id,
        note,
        JSON.stringify({ kind: 'watchdog_force_route', reason, detail })
      )
    } catch (err) {
      console.error(`[state-poller] watchdog: failed to insert warning event for obj ${objective.id}:`, err)
    }
    try {
      db.prepare(
        `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail)
         VALUES (?, ?, ?, ?, 'milestone', 'watchdog_force_route', ?)`
      ).run(objective.project || 'unknown', objective.workspace, objective.id, objective.session_id, `${reason}: ${detail}; force-routed to review.`)
    } catch {}
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
    broadcast({ type: 'objective_updated', payload: updated })
    // Re-nudge the delegator parent (force-route is an actionable signature change).
    const parent = delegatorParentOf(objective)
    if (parent != null) wakeDelegator(parent, updated)
    void sendTelegram(`Objective #${objective.id} ("${objective.title}") watchdog force-routed to review (${reason}: ${detail}).`)
    console.log(`[state-poller] Watchdog force-routed obj ${objective.id} (${reason}: ${detail}) → review`)
  } catch (err) {
    console.error(`[state-poller] watchdog force-route failed for obj ${objective.id} (fail-safe — left in working):`, err)
  }
}

// ── KL-21 gate-rejection memory (obj-2509) ─────────────────────────────────────
// Best-effort head tree SHA for an objective's committed work, used to detect a
// re-review of an UNCHANGED-but-rejected tree. Resolves the objective's worktree
// branch + workdir and delegates to the pure governance helper, which fails OPEN
// (returns null) on any git/fs error so a missing SHA never triggers a skip.
export function currentTreeShaForObjective(obj: Objective): string | null {
  const branch = deriveWorktreeBranchName(obj)
  let workdir: string | null = null
  try {
    workdir = resolveWorkdir(obj)
  } catch {
    workdir = null
  }
  return getObjectiveTreeSha({
    objectiveId: obj.id,
    branchName: branch,
    projectDir: workdir,
    worktreePath: workdir, // resolveWorkdir returns the per-objective worktree for isolated sessions
  })
}

// ── GitHub commit status (PR-gated harness loop) ─────────────────────────────
// Best-effort: post a `harness/test-agent` commit status to the PR head SHA so the
// PR is gated on the test-agent verdict. Only fires when obj.pr_number is set; any
// `gh` failure is logged and swallowed so the poller never breaks on it.
const HARNESS_REPO = process.env.HARNESS_REPO || 'your-org/command-center-infra'

/**
 * Env for server-side `gh` invocations. The Node server runs as root with HOME=/root
 * and NO gh auth in its default config dir (~/.config/gh), so a bare `gh api` fails
 * with "not logged into any GitHub hosts." Sessions authenticate by spawning gh with
 * GH_CONFIG_DIR=/etc/gh (see session-manager spawn env), where the host's hosts.yml is
 * mounted; the server's own gh calls — i.e. {@link postHarnessStatus} — must point at
 * the same dir or every harness/test-agent status post silently fails and the PR is
 * stranded with no check (root cause #3 of the create_pr no-op). Env-overridable so
 * tests and alternate deployments can redirect it.
 * Exported for unit testing.
 */
export function ghExecEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GH_CONFIG_DIR: base.GH_CONFIG_DIR || '/etc/gh' }
}

function ghApi(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['api', ...args], { timeout: 15000, env: ghExecEnv() }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.trim())
    })
  })
}

/**
 * Run `fn`, retrying on rejection with exponential backoff. The gating
 * `harness/test-agent` post is effectively single-shot from the poller's
 * perspective — it fires once when the reviewer's verdict is resolved and is
 * never re-driven, so a single transient `gh`/network error drops it and strands
 * the PR with no check forever. Observed live: obj 1303/PR #98's post failed once
 * on a transient `gh api` error even with auth correctly configured (RC#3 fixed),
 * and the identical call succeeded on immediate retry. A bounded retry makes the
 * post resilient to transient failures without masking a hard one — it still
 * rejects after the final attempt so the caller logs the failure. `sleep` is
 * injectable so unit tests run with no real delay. Exported for unit testing.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts: number; baseDelayMs: number; label?: string; sleep?: (ms: number) => Promise<void> },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let lastErr: unknown
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt < opts.attempts) {
        const delay = opts.baseDelayMs * 2 ** (attempt - 1)
        if (opts.label) {
          console.warn(
            `[state-poller] ${opts.label}: attempt ${attempt}/${opts.attempts} failed ` +
            `(${(err as Error).message}); retrying in ${delay}ms`,
          )
        }
        await sleep(delay)
      }
    }
  }
  throw lastErr
}

// Re-drivable by design (obj 2352): every invocation re-reads the PR head SHA and
// POSTs the status; POSTing the same `context=harness/test-agent` overwrites the
// prior value, so calling this again is safe and idempotent. The self-healing
// backstop (sweepPRLinkageAndHarness → selfHealHarnessStatus) relies on exactly
// this — it re-invokes postHarnessStatus when an earned pass status went missing.
export function postHarnessStatus(obj: Objective, state: 'success' | 'failure', description: string): void {
  // Resilience: a row can have pr_url set but pr_number NULL (worker linked only the
  // URL). Branch protection REQUIRES this status, so a null pr_number would strand the
  // PR at "no checks reported" forever. Fall back to deriving the number from pr_url.
  const prNumber = obj.pr_number ?? parsePrNumberFromUrl(obj.pr_url)
  if (!prNumber) return
  void (async () => {
    try {
      // Retry the whole get-sha + post sequence: both calls are idempotent (the
      // GET is a read; POSTing the same context just overwrites), so re-running
      // after a partial failure is safe. A null sha is treated as retryable —
      // a transient GET miss shouldn't silently skip the gating post.
      await withRetry(
        async () => {
          const sha = await ghApi([`repos/${HARNESS_REPO}/pulls/${prNumber}`, '--jq', '.head.sha'])
          if (!sha) throw new Error(`no head SHA for PR #${prNumber}`)
          await ghApi([
            '-X', 'POST', `repos/${HARNESS_REPO}/statuses/${sha}`,
            '-f', `state=${state}`,
            '-f', 'context=harness/test-agent',
            '-f', `description=${description.slice(0, 140)}`,
          ])
        },
        { attempts: 3, baseDelayMs: 1000, label: `harness status PR #${prNumber} (obj ${obj.id})` },
      )
      console.log(`[state-poller] harness status ${state} posted for PR #${prNumber} (obj ${obj.id})`)
    } catch (err) {
      console.warn(
        `[state-poller] harness status post failed for PR #${prNumber} (obj ${obj.id}) after retries:`,
        (err as Error).message,
      )
    }
  })()
}

// ── PR auto-linkage + self-healing harness status (obj 2352) ─────────────────
// Real `gh` runner for the pr-linkage module: shells the FULL gh argv (not just
// `gh api`), routed through ghExecEnv() so GH_CONFIG_DIR=/etc/gh is set (the server
// runs as root with no default gh auth), with a bounded timeout. Rejects on
// non-zero exit so the module's try/catch records a reason and swallows it.
export const realGhExec: GhExec = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 15000, env: ghExecEnv() }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.trim())
    })
  })

let lastEarnedStatusBackstopAt = 0

/**
 * Poller backstop for obj 2352. A bounded, idempotent, failure-swallowing sweep
 * over recently-active objectives that does two safe things:
 *   1) Auto-links a PR (Part 1) for any objective with a server-derived branch but
 *      NULL pr_number — so the linkage no longer depends on the worker self-reporting.
 *   2) Self-heals (Part 2) the `harness/test-agent` status for any review/done
 *      objective with a genuine pass verdict whose PR head SHA lacks it.
 * Killable via `settings.pr_autolink_killed=1` / env CC_PR_AUTOLINK_KILLED. Every
 * per-objective action is wrapped so one failure never breaks the poll loop.
 */
export async function sweepPRLinkageAndHarness(): Promise<void> {
  const db = getDb()
  if (isPrAutolinkKilled(db)) return

  // Part 1 — backfill candidates: create_pr objectives still missing a pr_number,
  // recently active, bounded. (working covers a session-end race; review/done are
  // the strand cases.)
  let backfillTargets: Objective[] = []
  try {
    backfillTargets = db
      .prepare(
        `SELECT * FROM objectives
          WHERE create_pr = 1 AND pr_number IS NULL
            AND status IN ('working','review','done')
            AND updated_at > datetime('now','-2 days')
          ORDER BY updated_at DESC
          LIMIT 50`,
      )
      .all() as Objective[]
  } catch (err) {
    console.error('[state-poller] pr-linkage backfill query failed:', (err as Error).message)
  }
  for (const obj of backfillTargets) {
    try {
      await discoverAndBackfillPR(db, obj, realGhExec)
    } catch (err) {
      console.warn(`[state-poller] pr-linkage backfill threw for obj ${obj.id}:`, (err as Error).message)
    }
  }

  // Part 2 — self-heal candidates: review/done + pass verdict + a resolvable PR,
  // recently active, bounded. Re-read so a row just backfilled above is included.
  let healTargets: Objective[] = []
  try {
    healTargets = db
      .prepare(
        `SELECT * FROM objectives
          WHERE status IN ('review','done') AND ai_review_verdict = 'pass'
            AND (pr_number IS NOT NULL OR pr_url IS NOT NULL)
            AND updated_at > datetime('now','-2 days')
          ORDER BY updated_at DESC
          LIMIT 50`,
      )
      .all() as Objective[]
  } catch (err) {
    console.error('[state-poller] pr-linkage self-heal query failed:', (err as Error).message)
  }

  // Part 2b — the EARNED-STATUS BACKSTOP (obj 704718). See
  // `selectAgedEarnedStatusTargets` for the trap this closes. Time-throttled because
  // this sweep runs on every 3s poll tick and confirming an already-green PR still
  // costs two gh calls; `selfHealHarnessStatus` is idempotent, so a slow cadence
  // costs latency and nothing else.
  const nowMs = Date.now()
  if (nowMs - lastEarnedStatusBackstopAt >= EARNED_STATUS_BACKSTOP_INTERVAL_MS) {
    lastEarnedStatusBackstopAt = nowMs
    const seen = new Set(healTargets.map(o => o.id))
    for (const obj of selectAgedEarnedStatusTargets(db)) {
      if (!seen.has(obj.id)) healTargets.push(obj)
    }
  }
  for (const obj of healTargets) {
    try {
      await selfHealHarnessStatus(db, obj, realGhExec, (o, prNumber) =>
        postHarnessStatus({ ...o, pr_number: prNumber }, 'success', 'Self-heal: re-posted earned pass status.'),
      )
    } catch (err) {
      console.warn(`[state-poller] pr-linkage self-heal threw for obj ${obj.id}:`, (err as Error).message)
    }
  }
}

// ── AI Review polling ────────────────────────────────────────────────────────
// Objectives in `ai_review` status carry their reviewer's session id in
// `ai_review_session_id`. When that session ends, we extract the verdict and
// transition the objective.

export async function pollAIReviewSessions(): Promise<void> {
  const db = getDb()
  const reviewing = db
    .prepare("SELECT * FROM objectives WHERE status = 'ai_review' AND ai_review_session_id IS NOT NULL")
    .all() as Objective[]

  for (const obj of reviewing) {
    if (!obj.ai_review_session_id) continue
    if (skipMachineStatusWrite(db, obj.id)) continue
    const state = getSessionState(obj.ai_review_session_id)
    if (state === 'working') continue  // reviewer still running

    // Delegator workers escalate failures to their delegator (not silent done),
    // and the delegator is woken when the worker reaches a terminal state.
    const delegatorParent = delegatorParentOf(obj)

    // Session ended (review or dead) — extract verdict
    const {
      verdict, findings, mode, transcript,
      // PR-harness structured emit (machine-readable JSON strings); '[]' when absent.
      criteriaResults: criteriaResultsTag,
      screenshotPaths: screenshotPathsTag,
      artifactPaths,
      featureBrief,
      screenshotPathsList,
    } = extractReviewerOutput(obj.ai_review_session_id)
    handleSessionDeath(obj.ai_review_session_id)

    // QW4: parse the reviewer transcript into structured per-criterion evidence
    // aligned to the objective's locked rubric. This is the guaranteed-non-empty
    // fallback so objective_reviews NEVER persists a blind '[]' again (a skipped
    // entry per criterion when no findings parse), for PR and non-PR objectives alike.
    const acceptanceCriteria = parseAcceptanceCriteria(
      (obj as unknown as { acceptance_criteria: unknown }).acceptance_criteria
    )
    const parsedCriteria = parseCriteriaResults(findings, acceptanceCriteria)
    // Screenshots scraped from the rubric evidence + findings/transcript (deduped).
    const recScreenshotPaths = [
      ...new Set([
        ...parsedCriteria.map(r => r.screenshot_path).filter((p): p is string => !!p),
        ...extractScreenshotPaths(findings),
        ...extractScreenshotPaths(transcript),
      ]),
    ]

    // criteria_results: prefer the PR-harness's structured <criteria_results> emit
    // when present (#684/#840); otherwise fall back to the QW4 rubric-aligned parse
    // so the column is always real, never a blind '[]'.
    const prCriteria = obj.pr_number ? criteriaResultsTag : '[]'
    const hasPrCriteria = !!prCriteria && prCriteria.trim() !== '' && prCriteria.trim() !== '[]'
    let criteriaResultsToStore = hasPrCriteria ? prCriteria : JSON.stringify(parsedCriteria)

    // screenshot_paths: for PR objectives, union the harness shots + artifact
    // (console/trace) paths with the QW4-scraped paths; otherwise the scraped paths.
    let screenshotPathsToStore: string
    if (obj.pr_number) {
      try {
        const shots = JSON.parse(screenshotPathsTag) as unknown[]
        const arts = JSON.parse(artifactPaths) as unknown[]
        screenshotPathsToStore = JSON.stringify([...new Set([...shots, ...arts, ...recScreenshotPaths])])
      } catch {
        screenshotPathsToStore = JSON.stringify([...new Set([...recScreenshotPaths])])
      }
    } else {
      screenshotPathsToStore = JSON.stringify(recScreenshotPaths)
    }

    // Stakeholder changelog (obj 937): upload the reviewer's <screenshots> captures
    // to Supabase storage (best-effort, never throws) and store the PUBLIC URLs as
    // the screenshot_paths array. The parsed feature_brief JSON goes into its own
    // column. If no public URLs come back, keep the value computed above so we
    // don't regress evidence collection.
    const iterationForRow = Math.max(1, obj.ai_review_iteration || 1)
    const publicScreenshotUrls = await uploadReviewScreenshots(
      obj.id,
      iterationForRow,
      screenshotPathsList,
    )
    if (publicScreenshotUrls.length > 0) {
      screenshotPathsToStore = JSON.stringify(publicScreenshotUrls)
    }

    // Human may have clicked Done during screenshot upload / transcript parse.
    if (skipMachineStatusWrite(db, obj.id)) continue

    // Persist per-iteration review row. The reviewer was incremented to
    // `ai_review_iteration` when it was spawned, so that's the iteration this
    // verdict belongs to. Use INSERT OR REPLACE so crash-recovery is idempotent
    // (the unique index on (objective_id, iteration) backs this).
    const persistedVerdict: 'pass' | 'fail' | 'blocked' = verdict ?? 'blocked'
    try {
      db.prepare(
        `INSERT OR REPLACE INTO objective_reviews
          (objective_id, iteration, reviewer_session_id, mode, verdict,
           criteria_results, screenshot_paths, feature_brief, markdown_body, cost_usd, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`
      ).run(
        obj.id,
        iterationForRow,
        obj.ai_review_session_id,
        mode,
        persistedVerdict,
        criteriaResultsToStore,
        screenshotPathsToStore,
        featureBrief || '',
        findings || ''
      )
    } catch (err) {
      console.error(`[state-poller] Failed to persist objective_reviews row for obj ${obj.id} iter ${iterationForRow}:`, err)
    }

    // ── CI-green gate for the REVIEWER-VERDICT paths (obj 704785) ──────────────
    // Three branches below can land an objective in `done` straight off a reviewer
    // verdict (pass→done for tasks, blocked→done for top-level tasks, no-verdict→done
    // for top-level tasks). A reviewer verdict is a judgement about the DIFF — it never
    // looked at the PR's checks. This is the exact seam that produced PRs 675/677/678
    // with their owning objectives already `done`. Returns true when the caller must
    // NOT complete: the objective has been bounced back to the worker (or parked in
    // review, or escalated to Mike at the hold cap) with the failing check names.
    const ciGateBlocks = async (intended: ObjectiveStatus): Promise<boolean> => {
      if (intended !== 'done') return false
      const gate = await runCompletionGate(db, obj, { pathway: 'reviewer-verdict', alert: insertAlert })
      if (!gate.blocked) return false
      const landed = applyGateHandback(db, obj, gate, { sendFollowUp, broadcast })
      console.warn(
        `[state-poller] CI-green gate ${gate.decision.action.toUpperCase()} on objective ${obj.id} ` +
        `(${gate.repo}#${gate.prNumber}) → ${landed}: ${gate.decision.reason}`,
      )
      postHarnessStatus(obj, 'failure', `Completion blocked — required checks not green (${gate.decision.action}).`)
      return true
    }

    if (!verdict) {
      // Couldn't parse a verdict — escalate to human review (or done for tasks).
      // Delegator workers escalate to their delegator (`review`), never silent done.
      console.warn(`[state-poller] Reviewer ${obj.ai_review_session_id} ended without a <verdict> block — escalating to review`)
      let nextStatus: ObjectiveStatus = (obj.type === 'task' && delegatorParent == null) ? 'done' : 'review'
      if (mustRouteToHumanReview(obj) && nextStatus === 'done') nextStatus = 'review'
      if (await ciGateBlocks(nextStatus)) continue
      runMachineStatusUpdate(
        db,
        "UPDATE objectives SET status = ?, ai_review_verdict = 'blocked', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
        nextStatus,
        findings || 'Reviewer ended without emitting a verdict block.',
        obj.id,
      )
      postHarnessStatus(obj, 'failure', 'Test-agent ended without a verdict (blocked).')
      const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
      broadcast({ type: 'objective_updated', payload: updated })
      continue
    }

    if (verdict === 'pass') {
      let nextStatus: ObjectiveStatus = obj.type === 'project' ? 'review' : 'done'
      if (mustRouteToHumanReview(obj, { verdict: 'pass' }) && nextStatus === 'done') nextStatus = 'review'
      if (await ciGateBlocks(nextStatus)) continue
      runMachineStatusUpdate(
        db,
        "UPDATE objectives SET status = ?, ai_review_verdict = 'pass', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
        nextStatus,
        findings,
        obj.id,
      )
      console.log(`[state-poller] Reviewer PASS on objective ${obj.id} (${obj.type}) → ${nextStatus}`)
      postHarnessStatus(obj, 'success', 'Test-agent verified the PR preview (pass).')
      const passed = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
      void evaluateAutoMerge(passed, 'pass', true)
    } else if (verdict === 'blocked') {
      let nextStatus: ObjectiveStatus = (obj.type === 'task' && delegatorParent == null) ? 'done' : 'review'
      if (mustRouteToHumanReview(obj) && nextStatus === 'done') nextStatus = 'review'
      if (await ciGateBlocks(nextStatus)) continue
      runMachineStatusUpdate(
        db,
        "UPDATE objectives SET status = ?, ai_review_verdict = 'blocked', ai_review_findings = ?, updated_at = datetime('now') WHERE id = ?",
        nextStatus,
        findings,
        obj.id,
      )
      console.log(`[state-poller] Reviewer BLOCKED on objective ${obj.id} → ${nextStatus}`)
      postHarnessStatus(obj, 'failure', 'Test-agent could not verify the PR preview (blocked).')
    } else {
      // unless a cap-out condition fires: iteration cap (backstop), CUMULATIVE
      // objective spend ≥ ceiling (ST3 — the per-spawn dollar cap resets every
      // respawn, this does not), or no-progress (findings repeated verbatim).
      // On any cap-out we route through the (formerly dead) escalateCapOut path,
      // which parks the objective with a needs-human marker + Telegram (and, for
      // PR-gated objectives, the #840 UNRESOLVED CRITICAL FAILURES block). The
      // spend lookup is fail-safe: any error falls back to the iteration cap so
      // an infra hiccup can never wedge the FSM (it just won't enforce budget).
      let spend = 0
      let ceiling = budgetCeilingForEffort(obj.effort)
      try {
        spend = computeObjectiveSpend(obj.id)
      } catch (err) {
        console.error(`[state-poller] computeObjectiveSpend failed for obj ${obj.id} (budget cap disabled this tick):`, err)
        ceiling = 0  // disable the budget arm of the decision; iteration/no-progress still apply
      }
      // Failing-criterion sets for set-based no-progress detection (the live key —
      // the verbatim findings check almost never fires). Derive BOTH sides from the
      // criteria_results JSON representation so PR-harness rows (`id`) and rubric-parse
      // rows (`criterion_id`) compare symmetrically: current = the row we just stored
      // (criteriaResultsToStore), previous = the latest PRIOR review row (iteration <
      // the row we just inserted, so we never compare the current set against itself).
      const failedCriteriaIds = failingCriterionIds(criteriaResultsToStore)
      let prevFailedCriteriaIds: string[] = []
      try {
        const prevRow = db.prepare(
          'SELECT criteria_results FROM objective_reviews WHERE objective_id = ? AND iteration < ? ORDER BY iteration DESC LIMIT 1'
        ).get(obj.id, iterationForRow) as { criteria_results: string } | undefined
        prevFailedCriteriaIds = failingCriterionIds(prevRow?.criteria_results)
      } catch (err) {
        console.error(`[state-poller] prev criteria_results read failed for obj ${obj.id} (set-based no-progress disabled this tick):`, err)
      }
      const decision = decideRespawnAction({
        iteration: obj.ai_review_iteration || 0,
        iterationCap: AI_REVIEW_ITERATION_CAP,
        spend,
        ceiling,
        findings: findings || null,
        prevFindings: obj.ai_review_findings,  // prior iteration's stored findings
        failedCriteriaIds,
        prevFailedCriteriaIds,
      })
      if (decision.action === 'cap') {
        escalateCapOut(obj, decision.reason, {
          iteration: obj.ai_review_iteration || 0,
          spend,
          ceiling,
          findings: findings || null,
        })
        // Preserve main's harness-status post on cap-out (#840 PR-gated loop).
        postHarnessStatus(obj, 'failure', `Test-agent FAIL — capped out (${decision.reason}).`)
      } else {
        // KL-21 (obj-2509): record the head tree SHA this rejection was graded on,
        // so a later re-review of a byte-identical tree can skip the auditor. Inert
        // (column stays null-ish, never read) while the flag is off. Best-effort;
        // null on any git error and simply disables the optimization for this obj.
        const rejectedTreeSha = isGateRejectionMemoryEnabled(db) ? currentTreeShaForObjective(obj) : null
        db.prepare(
          "UPDATE objectives SET ai_review_verdict = 'fail', ai_review_findings = ?, rejected_tree_sha = ?, not_mergeable = 0, updated_at = datetime('now') WHERE id = ?"
        ).run(findings, rejectedTreeSha, obj.id)
        if (obj.session_id) {
          try {
            const followUp = `## AI Review Findings\n\n${findings || '(no findings text)'}\n\nPlease address these and continue.`
            const newSessionId = sendFollowUp(obj.session_id, followUp, obj)
            runMachineStatusUpdate(
              db,
              "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?",
              newSessionId,
              obj.id,
            )
            console.log(`[state-poller] Reviewer FAIL on objective ${obj.id} (iter ${obj.ai_review_iteration}) → bounced to worker session ${newSessionId}`)
          } catch (err) {
            console.error(`[state-poller] Failed to send fail-findings follow-up for objective ${obj.id}:`, err)
            runMachineStatusUpdate(
              db,
              "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
              obj.id,
            )
          }
        } else {
          runMachineStatusUpdate(
            db,
            "UPDATE objectives SET status = 'review', updated_at = datetime('now') WHERE id = ?",
            obj.id,
          )
        }
      }
    }

    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
    broadcast({ type: 'objective_updated', payload: updated })

    // Wake the delegator when its worker has reached a terminal state post-review
    // (passed → done, or escalated → review). A fail-bounce leaves the worker in
    // `working`, so we don't wake mid-iteration.
    if (delegatorParent != null && (updated.status === 'done' || updated.status === 'review')) {
      wakeDelegator(delegatorParent, updated)
    }
  }
}
