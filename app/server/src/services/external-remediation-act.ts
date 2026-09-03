/**
 * External-CI auto-remediation act-path — fetch, prompt, and handlers —
 * extracted from external-remediation.ts (behavior frozen).
 *
 * Classify lives in external-remediation-classify.ts; owner matching in
 * external-remediation-resolve.ts. This file is the webhook act-path.
 */
import { execFile } from 'child_process'
import type { Database } from 'better-sqlite3'
import type { Objective, ServerMessage } from '@operationkit/shared'
import { parsePrNumberFromUrl } from './pr-url.js'
import { isHumanTerminalGuardEnabled } from './objective-audit.js'
import {
  type AnyPayload,
  type CheckClass,
  type CheckClassification,
  type ClassifiedCheck,
  HANDLED_EVENTS,
  TRUNK_BRANCHES,
  classifyCancelledEvent,
  classifyCheckEvent,
  classifyCheckFixability,
  isRemediableObjective,
  isRemediationEnabled,
  maxRemediationAttempts,
} from './external-remediation-classify.js'
import {
  resolveObjective,
  resolveOwnerObjective,
} from './external-remediation-resolve.js'

const DEFAULT_HARNESS_REPO = process.env.HARNESS_REPO || 'your-org/command-center-infra'

/**
 * A workflow_run whose JOBS were all cancelled still rolls up to `conclusion: failure`
 * at the run level (obj 704698 — observed live on this very PR: run 31123994413 reported
 * `failure` while both `vitest (client)` and `vitest (server)` were `cancelled` with zero
 * steps executed, having never been assigned a runner). Keying cancellation detection on
 * the run-level conclusion alone therefore misses the most common real cancellation and
 * nudges a worker to "diagnose and fix" a run in which nothing ever ran.
 *
 * This asks GitHub for the job conclusions and reports true only when NO job failed and at
 * least one was cancelled. Best-effort by design: any exec/parse error returns false, so
 * the caller falls through to the normal failure path and behaviour is unchanged.
 */
export async function runWasOnlyCancelled(
  classified: Pick<ClassifiedCheck, 'repoFullName' | 'runId'>,
  exec: ExecFn = defaultExec,
): Promise<boolean> {
  if (!classified.runId || !classified.repoFullName) return false
  try {
    const raw = await exec('gh', [
      'api',
      `repos/${classified.repoFullName}/actions/runs/${classified.runId}/jobs`,
      '--jq',
      '[.jobs[].conclusion]',
    ])
    const parsed = JSON.parse(raw || '[]')
    if (!Array.isArray(parsed) || parsed.length === 0) return false
    const failed = parsed.filter((c) => c === 'failure' || c === 'timed_out' || c === 'action_required')
    const cancelled = parsed.filter((c) => c === 'cancelled')
    return failed.length === 0 && cancelled.length > 0
  } catch {
    return false
  }
}


// ── Failure-context fetch (TOKEN DISCIPLINE) ────────────────────────────────────
// We capture ONLY failing lines/annotations, never full logs. Caps are deliberate.
const MAX_CONTEXT_CHARS = 6000
const MAX_CONTEXT_LINES = 80

/** Mirror of state-poller.ghExecEnv — the server's `gh` has no auth in its default
 *  config dir; the host hosts.yml is mounted at /etc/gh. Kept local to avoid a heavy
 *  import cycle through state-poller → session-manager. */
function ghExecEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GH_CONFIG_DIR: base.GH_CONFIG_DIR || '/etc/gh' }
}

export type ExecFn = (file: string, args: string[]) => Promise<string>

const defaultExec: ExecFn = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024, env: ghExecEnv() }, (err, stdout, stderr) => {
      // Never reject — a fetch failure must degrade gracefully to "no extra context",
      // not crash the remediation. Return stdout (or stderr tail) best-effort.
      if (err && !stdout) resolve((stderr || '').toString())
      else resolve((stdout || '').toString())
    })
  })

/** Clip text to the token-discipline caps (last N lines are usually the actionable
 *  ones; we keep the tail). */
export function clipContext(text: string): string {
  if (!text) return ''
  let lines = text.split('\n').map((l) => l.replace(/\s+$/, '')).filter((l) => l.length > 0)
  if (lines.length > MAX_CONTEXT_LINES) {
    lines = ['… (earlier lines trimmed for token discipline) …', ...lines.slice(-MAX_CONTEXT_LINES)]
  }
  let out = lines.join('\n')
  if (out.length > MAX_CONTEXT_CHARS) out = '… (trimmed) …\n' + out.slice(-MAX_CONTEXT_CHARS)
  return out
}

/**
 * Fetch ONLY the failing context for a classified check. Token discipline is the
 * whole point: Actions → `gh run view <id> --log-failed` (failing steps only);
 * check_run → Checks-API annotations only; Vercel/status → we do NOT pull logs (no
 * Vercel auth, and it would blow the budget), we surface the deployment URL + status
 * description and let the session open it if needed.
 */
export async function fetchFailureContext(
  classified: ClassifiedCheck,
  statusDescription: string | null,
  exec: ExecFn = defaultExec,
): Promise<string> {
  const repo = classified.repoFullName || DEFAULT_HARNESS_REPO
  try {
    if (classified.kind === 'workflow_run' && classified.runId) {
      const raw = await exec('gh', ['run', 'view', String(classified.runId), '--log-failed', '-R', repo])
      const clipped = clipContext(raw)
      return clipped ? `Failing job log (gh run view --log-failed):\n${clipped}` : ''
    }
    if (classified.kind === 'check_run' && classified.checkRunId) {
      const raw = await exec('gh', ['api', `repos/${repo}/check-runs/${classified.checkRunId}/annotations`])
      const anns = safeParseAnnotations(raw)
      if (anns.length === 0) return ''
      const lines = anns
        .slice(0, MAX_CONTEXT_LINES)
        .map((a) => `- ${a.path ? a.path + (a.start_line ? `:${a.start_line}` : '') + ' — ' : ''}${a.annotation_level || 'failure'}: ${a.message || ''}`)
      return `Check annotations (Checks API, failing only):\n${clipContext(lines.join('\n'))}`
    }
    // status / Vercel: NO log pull — token discipline + no creds.
    const bits: string[] = []
    if (statusDescription) bits.push(`Status description: ${statusDescription}`)
    if (classified.targetUrl) bits.push(`Deployment / details URL: ${classified.targetUrl}`)
    bits.push('(Full deploy logs intentionally NOT fetched — open the URL above for detail if the description is insufficient.)')
    return bits.join('\n')
  } catch {
    // Degrade gracefully — the prompt still names the check; the session can dig in.
    return classified.targetUrl ? `Details URL: ${classified.targetUrl}` : ''
  }
}

interface Annotation { path?: string; start_line?: number; annotation_level?: string; message?: string }
function safeParseAnnotations(raw: string): Annotation[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as Annotation[]).filter((a) => (a.annotation_level === 'failure' || a.annotation_level === 'warning') && a.message)
  } catch {
    return []
  }
}

// ── Remediation prompt ──────────────────────────────────────────────────────────

export function buildRemediationPrompt(args: {
  objective: Objective
  classified: ClassifiedCheck
  failureContext: string
  attempt: number
  maxAttempts: number
}): string {
  const { classified, failureContext, attempt, maxAttempts } = args
  return [
    `## ⚠️ External CI failure on your PR — auto-remediation (attempt ${attempt}/${maxAttempts})`,
    ``,
    `A third-party required check just FAILED on the PR for this objective. This is an`,
    `automated hand-off (not the internal harness/test-agent gate). Fix it in your`,
    `worktree, push, and confirm the check goes green.`,
    ``,
    `**(a) What went wrong**`,
    `- Check: \`${classified.checkName}\` (${classified.kind}, outcome: ${classified.outcome})`,
    `- Commit: \`${classified.headSha || '(unknown)'}\``,
    classified.targetUrl ? `- Details: ${classified.targetUrl}` : ``,
    ``,
    failureContext ? `**Failing output (only the failing lines were captured):**\n\`\`\`\n${failureContext}\n\`\`\`` : `(No log lines were retrievable — inspect the check via the URL above.)`,
    ``,
    `**(b) Diagnose the cause** — read the failing lines above; reproduce locally if useful.`,
    `**(c) State the fix** — one or two sentences on the root cause and what you'll change.`,
    `**(d) Apply it IN THE WORKTREE** (\`/tmp/cc-worktree-${args.objective.id}/\`, absolute paths only),`,
    `   commit, and \`git push\` to your PR branch. Do NOT edit the live checkout.`,
    `**(e) Confirm the check re-runs green.** If it fails again you'll get another automated`,
    `   nudge (bounded at ${maxAttempts} attempts). Do NOT merge — Mike merges.`,
    ``,
    `Token discipline: only the failing lines were pulled, never full logs. If you need`,
    `more, fetch narrowly (\`gh run view <id> --log-failed\`, annotations) — never dump whole logs.`,
  ].join('\n')
}

// ── Trunk-branch failures → objective card (obj 702632, gap D) ─────────────────
// A Railway deploy failure on `main` (railway-app[bot] posts commit statuses with
// context "<project> - <service>") — or any check failure on a trunk branch — has
// no owning PR objective, so before this it was silently dropped as `no-objective`.
// Nothing alerted anyone about a broken deploy on main. Two-step recovery:
//   1. resolve the MERGED PR for the failing sha (GET /commits/{sha}/pulls) and,
//      if it maps to an objective, remediate into that objective (subject to the
//      same done-grace / terminal_by_human guards);
//   2. else CREATE a new objective card in the repo's workspace so a session
//      picks it up from the queue. Strictly deduped + daily-capped — webhook
//      re-deliveries and flapping checks must never spam the board.

/** repo short-name → workspace slug. Slugs verified against the live `workspaces`
 *  table (example / example2 / personal / example-project all exist). Keyed on the short
 *  name so a fork/owner rename doesn't break the map. */
const REPO_WORKSPACES: Record<string, string> = {
  'command-center-infra': 'personal',
  'example-platform': 'example',
  'example-project-platform': 'example-project',
  'example3-platform': 'example2',
}

/** Fallback workspace when the repo is unmapped — the harness's own board, where
 *  Mike triages everything anyway. */
const DEFAULT_TRUNK_WORKSPACE = 'personal'

export function workspaceForRepo(db: Database, repoFullName: string): string {
  const short = (repoFullName || '').split('/').pop() || ''
  const mapped = REPO_WORKSPACES[short]
  const slug = mapped || DEFAULT_TRUNK_WORKSPACE
  try {
    // Verify the slug actually exists (workspaces are a live table, not a literal
    // union) — an unmapped/renamed workspace falls back rather than FK-failing.
    const row = db.prepare('SELECT slug FROM workspaces WHERE slug = ?').get(slug) as { slug?: string } | undefined
    if (row?.slug) return row.slug
    const fb = db.prepare('SELECT slug FROM workspaces WHERE slug = ?').get(DEFAULT_TRUNK_WORKSPACE) as { slug?: string } | undefined
    return fb?.slug || slug
  } catch {
    return slug
  }
}

/** Daily cap on auto-created trunk-failure cards, per repo. Beyond it we log +
 *  drop (the dedupe row is still written so re-deliveries stay silent). */
export function maxTrunkCardsPerDay(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.MAX_TRUNK_FAILURE_CARDS_PER_DAY || '', 10)
  return Number.isInteger(raw) && raw > 0 ? raw : 3
}

export function buildTrunkFailureObjective(args: {
  classified: ClassifiedCheck
  branch: string
  statusDescription: string | null
}): { title: string; description: string } {
  const { classified, branch } = args
  const repo = classified.repoFullName
  const title = `[Auto] Deploy/check failure on ${repo.split('/').pop() || repo} ${branch}: ${classified.checkName}`
  const description = [
    `An external check FAILED on a trunk branch with no owning objective — auto-filed by the`,
    `external-remediation webhook loop (obj 702632). Nothing else alerts on trunk failures.`,
    ``,
    `- Repo: ${repo}`,
    `- Branch: \`${branch}\``,
    `- Commit: \`${classified.headSha || '(unknown)'}\``,
    `- Check / status context: \`${classified.checkName}\` (${classified.kind})`,
    `- Conclusion/state: ${classified.outcome}`,
    classified.targetUrl ? `- Details: ${classified.targetUrl}` : null,
    args.statusDescription ? `- Status description: ${args.statusDescription}` : null,
    ``,
    `**What to do:**`,
    `1. Diagnose: open the details URL / fetch ONLY the failing lines (\`gh run view <id> --log-failed\`,`,
    `   never full logs). Identify the commit(s) that broke ${branch}.`,
    `2. Fix it in your worktree — never edit the live checkout.`,
    `3. Open a PR against ${branch}. Do NOT merge — Mike merges. Do NOT redeploy by hand.`,
  ].filter((l): l is string => l !== null).join('\n')
  return { title, description }
}

/**
 * Create the trunk-failure card via the same direct-insert shape the
 * routine-scheduler uses (the internal HTTP route is for sessions; server-side
 * creators insert + broadcast). Lands in `queue` so the toplevel-queue-starter
 * picks it up under normal capacity rules — we never force-spawn. Returns the new
 * objective id, or null on failure.
 */
function createTrunkFailureObjective(
  deps: RemediationDeps,
  classified: ClassifiedCheck,
  branch: string,
  statusDescription: string | null,
): number | null {
  const workspace = workspaceForRepo(deps.db, classified.repoFullName)
  const { title, description } = buildTrunkFailureObjective({ classified, branch, statusDescription })
  try {
    const result = deps.db
      .prepare(
        `INSERT INTO objectives (title, description, agent_context, workspace, category, status, origin)
         VALUES (?, ?, 'cto', ?, 'general', 'queue', 'trunk-failure')`,
      )
      .run(title, description, workspace)
    const id = Number(result.lastInsertRowid)
    try {
      const obj = deps.db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined
      if (obj) deps.broadcast({ type: 'objective_updated', payload: obj })
    } catch { /* broadcast is best-effort */ }
    return id
  } catch (err) {
    console.error('[external-remediation] trunk card insert failed:', (err as Error).message)
    return null
  }
}

// ── Orchestration ───────────────────────────────────────────────────────────────

export interface RemediationDeps {
  db: Database
  /** Same signature as session-manager.sendFollowUp. Injected for testability. */
  sendFollowUp: (sessionId: string, message: string, objective: Objective) => string
  broadcast: (msg: ServerMessage) => void
  exec?: ExecFn
  env?: NodeJS.ProcessEnv
}

export interface RemediationResult {
  handled: boolean
  reason:
    | 'ignored-event'
    | 'not-a-failure'
    | 'harness-check'
    | 'disabled'
    | 'no-objective'
    | 'pr-not-open'
    | 'duplicate'
    | 'cap-exhausted'
    | 'cap-exhausted-already-escalated'
    | 'remediated'
    | 'trunk-card-created'
    | 'trunk-duplicate'
    | 'trunk-cap'
    // obj 704698 — convergence outcomes. Every one of these is a state the loop used to
    // reach silently (or not at all); each now ends in an owned or escalated outcome.
    | 'not-code-fixable'
    | 'not-code-fixable-duplicate'
    | 'not-code-fixable-unowned'
    | 'cancelled-rerun'
    | 'cancelled-rerun-capped'
    | 'cancelled-rerun-failed'
    | 'cancelled-ignored'
    | 'unowned-pr-owned'
    | 'unowned-pr-duplicate'
    | 'unowned-pr-cap'
    | 'orphan-inherited'
    | 'orphan-duplicate'
    | 'terminal-by-human'
    | 'error'
  objectiveId?: number
  attempt?: number
  checkName?: string
  /** Fixability class when the event was classified (obj 704698, gap A). */
  checkClass?: CheckClass
}

/**
 * Top-level entry the webhook route calls. ALWAYS resolves (never throws) — the route
 * stays crash-safe. Returns a structured result for logging/tests. Order of guards:
 * classify → enabled → resolve objective → open PR → dedup → cap → fetch → spawn.
 */
export async function handleExternalCheckEvent(
  event: string,
  payload: AnyPayload | null | undefined,
  deps: RemediationDeps,
): Promise<RemediationResult> {
  const env = deps.env || process.env
  try {
    const classified = classifyCheckEvent(event, payload)
    if (!classified) {
      // Not a failure — but it may be a CANCELLATION (obj 704698, gap B), which needs a
      // bounded re-dispatch rather than a worker nudge.
      const cancelled = classifyCancelledEvent(event, payload)
      if (cancelled) {
        if (!isRemediationEnabled(env)) {
          logDrop('disabled', cancelled, extractBranchHint(payload), '(DARK — would re-run cancelled check)')
          return { handled: false, reason: 'disabled', checkName: cancelled.checkName }
        }
        return await handleCancelledCheck(deps, cancelled, extractBranchHint(payload), env)
      }
      // Distinguish harness/no-failure for observability without leaking which.
      return { handled: false, reason: HANDLED_EVENTS.has(event) ? 'not-a-failure' : 'ignored-event' }
    }

    // SHIP DARK: do nothing observable unless explicitly enabled.
    if (!isRemediationEnabled(env)) {
      logDrop('disabled', classified, extractBranchHint(payload), '(DARK — AUTO_REMEDIATION_ENABLED off; would remediate)')
      return { handled: false, reason: 'disabled', checkName: classified.checkName }
    }

    const branchHint = extractBranchHint(payload)

    // FIXABILITY (gap A) — before any objective work. In the live table, 20 of the 26
    // `ReadyMode …` cron rows are attached to REAL PR numbers (405, 419, 421, 454, 455,
    // 458, 461, 465): scheduled runs and prod-state assertions were consuming attempts
    // 1..5 of PRs whose actual test failures then had no budget left.
    //
    // SCOPE: the gate applies to PR-linked failures. On a TRUNK branch the pre-existing
    // trunk-card path (obj 702632) is already the right terminal state for an
    // environmental failure — a broken deploy on main SHOULD raise a human-visible card —
    // so only the `scheduled` class is gated there (a cron flake says nothing about trunk
    // health and a card per flake is precisely the wall of red this objective exists to
    // stop). Deliberately narrow: this can only reduce futile nudges, never suppress a
    // real one.
    const isTrunkFailure = !!branchHint && TRUNK_BRANCHES.has(branchHint.trim())
    const fixability = classifyCheckFixability(classified.checkName, {
      triggerEvent: classified.triggerEvent,
      env,
      db: deps.db,
    })
    if (!fixability.fixable && (!isTrunkFailure || fixability.class === 'scheduled')) {
      return handleNonFixableCheck(deps, classified, fixability, branchHint)
    }

    // Gap B, run-level: a workflow_run reports `failure` even when every job was merely
    // CANCELLED (runner starvation, a concurrency gate). Nothing failed, so there is
    // nothing to diagnose — route it to the bounded re-dispatch instead of a nudge.
    // One extra API call, only on the workflow_run failure path; any error falls through
    // to the normal failure handling below.
    if (classified.kind === 'workflow_run' && classified.runId && await runWasOnlyCancelled(classified, deps.exec)) {
      console.log(
        `[external-remediation] run ${classified.runId} (${classified.checkName}) concluded 'failure' but every job was cancelled — treating as a cancellation`,
      )
      return await handleCancelledCheck(deps, { ...classified, outcome: 'cancelled' }, branchHint, env)
    }
    // allowRecentDone (gap C): a merged PR flips its objective `done` before the
    // checks even finish, so a failure minutes later must still remediate. The
    // grace is bounded (doneGraceDays) and terminal_by_human stays a hard stop.
    // Owner resolution (obj 704698, gap D): keep the distinction between "nobody owns
    // this PR" and "the owner exists but can't be nudged", so neither ends in silence.
    const owner = resolveOwnerObjective(deps.db, classified, branchHint, { allowRecentDone: true, env })
    let obj = owner.eligible ? owner.objective : null

    // HARD STOP: a human explicitly parked this objective. CI never resurrects it and
    // never re-homes its PR — that would route around the human's decision.
    if (!obj && owner.blockedBy === 'terminal-by-human' && owner.objective) {
      logDrop('terminal-by-human', classified, branchHint, `objective=${owner.objective.id}`)
      return { handled: false, reason: 'terminal-by-human', objectiveId: owner.objective.id, checkName: classified.checkName }
    }

    // Trunk-branch failure (gap D of obj 702632): no objective owns main/master/redesign. First
    // try the MERGED PR for the failing sha; else file a deduped, capped card.
    if (!obj && branchHint && TRUNK_BRANCHES.has(branchHint.trim())) {
      const mergedPr = await lookupMergedPrNumber(classified, deps.exec)
      if (mergedPr) {
        obj = resolveObjective(
          deps.db,
          { prNumberHint: mergedPr, headSha: classified.headSha, repoFullName: classified.repoFullName },
          null,
          { allowRecentDone: true },
        )
        if (obj) {
          console.log(`[external-remediation] trunk failure on ${branchHint} mapped to merged PR #${mergedPr} → obj ${obj.id}`)
          classified.prNumberHint = mergedPr
        }
      }
      if (!obj) {
        return handleTrunkFailure(deps, classified, branchHint.trim(), (payload?.description as string) || null, env)
      }
    }

    // Gap D: the owner exists but flipped `done` past the grace window (workers flip done
    // the moment review passes, often BEFORE their checks finish). Previously the nudge
    // was dropped and the red PR was orphaned. Hand it to a fresh live owner instead.
    if (!obj && owner.blockedBy === 'done-past-grace' && owner.objective) {
      return handleOrphanedObjective(deps, classified, owner.objective, branchHint)
    }
    // Gap D (cont.): owner exists but carries no PR/branch handle — unchanged behaviour.
    if (!obj && owner.blockedBy === 'no-handle' && owner.objective) {
      logDrop('pr-not-open', classified, branchHint, `objective=${owner.objective.id}`)
      return { handled: false, reason: 'pr-not-open', objectiveId: owner.objective.id }
    }

    if (!obj) {
      // Gap C: a REAL open PR that no objective owns (every dependabot/* PR, plus any
      // hand-pushed branch). It used to drop here and stay red forever with nobody
      // responsible. Route it to a single, reused, human-visible maintenance owner.
      const unownedPr = classified.prNumberHint
      if (unownedPr && unownedPr > 0) {
        return handleUnownedPrFailure(deps, classified, unownedPr, branchHint, env)
      }
      logDrop('no-objective', classified, branchHint)
      return { handled: false, reason: 'no-objective', checkName: classified.checkName }
    }
    if (!isRemediableObjective(obj, { humanTerminalGuard: isHumanTerminalGuardEnabled(deps.db, env), allowRecentDone: true })) {
      logDrop('pr-not-open', classified, branchHint, `objective=${obj.id}`)
      return { handled: false, reason: 'pr-not-open', objectiveId: obj.id }
    }

    // Negative fallback key (gap A follow-through): a branch-resolved objective may
    // have NO PR yet. Keying dedupe/attempts on -obj.id keeps them per-objective
    // and can never collide with a real PR number or the trunk sentinel (0).
    const prNumber = obj.pr_number ?? parsePrNumberFromUrl(obj.pr_url) ?? classified.prNumberHint ?? -obj.id
    const repo = classified.repoFullName || DEFAULT_HARNESS_REPO

    // IDEMPOTENCY: INSERT OR IGNORE on the UNIQUE (repo, pr, check, sha). If the row
    // already existed (changes()===0) this is a re-delivery → skip.
    const attemptCountBefore = countAttempts(deps.db, repo, prNumber)
    const attempt = attemptCountBefore + 1
    const ins = deps.db
      .prepare(
        `INSERT OR IGNORE INTO external_check_remediations
           (objective_id, repo, pr_number, check_name, head_sha, attempt, check_class)
         VALUES (?, ?, ?, ?, ?, ?, 'code-fixable')`,
      )
      .run(obj.id, repo, prNumber, classified.checkName, classified.headSha, attempt)
    if (ins.changes === 0) {
      logDrop('duplicate', classified, branchHint, `objective=${obj.id}`)
      return { handled: false, reason: 'duplicate', objectiveId: obj.id, checkName: classified.checkName }
    }

    // BOUND: once we exceed the cap, escalate to a human-visible state ONCE and stop.
    const cap = maxRemediationAttempts(env)
    if (attempt > cap) {
      const alreadyEscalated = countEscalated(deps.db, repo, prNumber) > 0
      if (!alreadyEscalated) {
        escalate(deps, obj, classified, prNumber, cap)
        deps.db
          .prepare(
            `UPDATE external_check_remediations SET escalated = 1
             WHERE repo = ? AND pr_number = ? AND check_name = ? AND head_sha = ?`,
          )
          .run(repo, prNumber, classified.checkName, classified.headSha)
        return { handled: true, reason: 'cap-exhausted', objectiveId: obj.id, attempt }
      }
      logDrop('cap-exhausted-already-escalated', classified, branchHint, `objective=${obj.id}`)
      return { handled: false, reason: 'cap-exhausted-already-escalated', objectiveId: obj.id, attempt }
    }

    // Fetch ONLY failing context, then resume the session.
    const failureContext = await fetchFailureContext(
      classified,
      (payload?.description as string) || null,
      deps.exec,
    )
    const prompt = buildRemediationPrompt({ objective: obj, classified, failureContext, attempt, maxAttempts: cap })

    const sessionId = obj.session_id || lastSessionId(deps.db, obj.id) || `cc-${obj.id}-${Date.now()}`
    const newSessionId = deps.sendFollowUp(sessionId, prompt, obj)
    deps.db
      .prepare("UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(newSessionId, obj.id)
    try {
      const updated = deps.db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective | undefined
      if (updated) deps.broadcast({ type: 'objective_updated', payload: updated })
    } catch { /* broadcast is best-effort */ }

    console.log(`[external-remediation] remediating obj ${obj.id} PR #${prNumber} — ${classified.checkName} (attempt ${attempt}/${cap})`)
    return { handled: true, reason: 'remediated', objectiveId: obj.id, attempt, checkName: classified.checkName }
  } catch (err) {
    console.error('[external-remediation] handler error:', (err as Error).message)
    return { handled: false, reason: 'error' }
  }
}

function escalate(deps: RemediationDeps, obj: Objective, classified: ClassifiedCheck, prNumber: number, cap: number): void {
  const note = `Auto-remediation hit its ${cap}-attempt cap on external check "${classified.checkName}" (PR #${prNumber}). Needs a human — the loop has stopped and will not retry.`
  try {
    deps.db
      .prepare("UPDATE objectives SET has_blockers = 1, last_session_summary = ?, updated_at = datetime('now') WHERE id = ?")
      .run(note, obj.id)
    const updated = deps.db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective | undefined
    if (updated) deps.broadcast({ type: 'objective_updated', payload: updated })
  } catch (err) {
    console.warn('[external-remediation] escalate failed:', (err as Error).message)
  }
  console.warn(`[external-remediation] ESCALATED obj ${obj.id} PR #${prNumber}: ${note}`)
}

/** Single structured drop line (obj 702632, gap E): every silently-dropped event
 *  must be greppable as `[external-remediation] drop reason=… repo=… branch=… check=…`. */
function logDrop(reason: string, classified: ClassifiedCheck, branch: string | null, extra = ''): void {
  console.log(
    `[external-remediation] drop reason=${reason} repo=${classified.repoFullName || '(none)'} branch=${branch || '(none)'} check=${classified.checkName}${extra ? ' ' + extra : ''}`,
  )
}

/** GET /repos/{owner}/{repo}/commits/{sha}/pulls — the PR(s) a trunk commit was
 *  merged from. Best-effort: any exec/parse failure returns null (the trunk-card
 *  path still files a card). Uses the same authenticated `gh` as the log fetch. */
async function lookupMergedPrNumber(
  classified: Pick<ClassifiedCheck, 'repoFullName' | 'headSha'>,
  exec: ExecFn = defaultExec,
): Promise<number | null> {
  if (!classified.repoFullName || !classified.headSha) return null
  try {
    const raw = await exec('gh', ['api', `repos/${classified.repoFullName}/commits/${classified.headSha}/pulls`, '--jq', '[.[].number]'])
    const parsed = JSON.parse(raw || '[]')
    if (Array.isArray(parsed)) {
      for (const n of parsed) {
        if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Gap-D step 2: no objective resolves for a trunk failure → file a board card.
 * Guards, in order:
 *  - IDEMPOTENT: INSERT OR IGNORE into external_check_remediations keyed
 *    (repo, 0, check_name, head_sha) — pr_number=0 is the trunk sentinel (real PR
 *    numbers are >0, branch-only objective keys are <0). Re-deliveries and check
 *    flaps on the same commit drop as `trunk-duplicate`.
 *  - CAPPED: at most maxTrunkCardsPerDay (default 3) auto-created cards per repo
 *    per rolling day; only rows that actually created a card (objective_id > 0)
 *    count, so capped/duplicate drops never consume budget. Beyond the cap we
 *    log + drop — the dedupe row stays so the same sha never re-fires later.
 * Never throws (caller wraps, but each write is also individually best-effort).
 */
function handleTrunkFailure(
  deps: RemediationDeps,
  classified: ClassifiedCheck,
  branch: string,
  statusDescription: string | null,
  env: NodeJS.ProcessEnv,
): RemediationResult {
  const repo = classified.repoFullName || DEFAULT_HARNESS_REPO
  const ins = deps.db
    .prepare(
      `INSERT OR IGNORE INTO external_check_remediations
         (objective_id, repo, pr_number, check_name, head_sha, attempt)
       VALUES (0, ?, 0, ?, ?, 0)`,
    )
    .run(repo, classified.checkName, classified.headSha)
  if (ins.changes === 0) {
    logDrop('trunk-duplicate', classified, branch)
    return { handled: false, reason: 'trunk-duplicate', checkName: classified.checkName }
  }

  const cap = maxTrunkCardsPerDay(env)
  const created = deps.db
    .prepare(
      `SELECT COUNT(*) AS n FROM external_check_remediations
        WHERE repo = ? AND pr_number = 0 AND objective_id > 0
          AND created_at >= datetime('now', '-1 day')`,
    )
    .get(repo) as { n: number }
  if ((created?.n || 0) >= cap) {
    logDrop('trunk-cap', classified, branch, `cap=${cap}/day`)
    return { handled: false, reason: 'trunk-cap', checkName: classified.checkName }
  }

  const newId = createTrunkFailureObjective(deps, classified, branch, statusDescription)
  if (newId == null) return { handled: false, reason: 'error', checkName: classified.checkName }

  // Stamp the card onto the dedupe row so the daily-cap count sees it.
  try {
    deps.db
      .prepare(
        `UPDATE external_check_remediations SET objective_id = ?
          WHERE repo = ? AND pr_number = 0 AND check_name = ? AND head_sha = ?`,
      )
      .run(newId, repo, classified.checkName, classified.headSha)
  } catch { /* count under-reports by one on failure — safe direction (more capping) */ }

  console.log(
    `[external-remediation] trunk failure on ${repo} ${branch} (${classified.checkName}) → created objective ${newId}`,
  )
  return { handled: true, reason: 'trunk-card-created', objectiveId: newId, checkName: classified.checkName }
}

/** Attempts CONSUMED by remediable work only (obj 704698, gap A). Rows stamped with a
 *  non-code-fixable class — environmental / advisory / scheduled checks, cancelled-run
 *  re-dispatch sentinels, unowned-PR bookkeeping — are excluded, so a wall of Vercel and
 *  cron noise can no longer burn the five attempts a real test failure needs. Legacy rows
 *  (check_class NULL, written before this migration, and by ci-feedback-bridge) still
 *  count, preserving the historical bound. */
function countAttempts(db: Database, repo: string, prNumber: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM external_check_remediations
        WHERE repo = ? AND pr_number = ?
          AND (check_class IS NULL OR check_class = 'code-fixable')`,
    )
    .get(repo, prNumber) as { n: number }
  return row?.n || 0
}

// ── GAP A: non-code-fixable checks ─────────────────────────────────────────────
/**
 * A check no code push can fix (environmental / advisory / scheduled). We must NOT nudge
 * a worker — that is what burned attempts 1..5 on PRs 646/629/564/563 — but we must not
 * pretend it didn't happen either. So: record it (idempotently, stamped with its class so
 * it never consumes the code-fixable budget) and escalate ONCE, with the accurate reason,
 * onto whichever objective owns the PR. With no owner there is no PR to be red — these
 * are cron runs — so a structured drop line is the correct terminal state.
 */
function handleNonFixableCheck(
  deps: RemediationDeps,
  classified: ClassifiedCheck,
  fixability: CheckClassification,
  branchHint: string | null,
): RemediationResult {
  const repo = classified.repoFullName || DEFAULT_HARNESS_REPO
  const owner = resolveOwnerObjective(deps.db, classified, branchHint, { allowRecentDone: true, env: deps.env })
  const obj = owner.objective
  const prNumber = classified.prNumberHint ?? (obj ? (obj.pr_number ?? parsePrNumberFromUrl(obj.pr_url) ?? -obj.id) : 0)

  const ins = deps.db
    .prepare(
      `INSERT OR IGNORE INTO external_check_remediations
         (objective_id, repo, pr_number, check_name, head_sha, attempt, check_class)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(obj?.id ?? 0, repo, prNumber, classified.checkName, classified.headSha, fixability.class)
  if (ins.changes === 0) {
    logDrop('not-code-fixable-duplicate', classified, branchHint, `class=${fixability.class}`)
    return { handled: false, reason: 'not-code-fixable-duplicate', objectiveId: obj?.id, checkName: classified.checkName, checkClass: fixability.class }
  }

  if (!obj) {
    logDrop('not-code-fixable-unowned', classified, branchHint, `class=${fixability.class} rule=${fixability.ruleId}`)
    return { handled: false, reason: 'not-code-fixable-unowned', checkName: classified.checkName, checkClass: fixability.class }
  }

  // Escalate at most once per (repo, pr, check) — the UNIQUE insert above already gives
  // one row per head sha, and this guard collapses repeated shas of the same check.
  const alreadyEscalated = deps.db
    .prepare(
      `SELECT COUNT(*) AS n FROM external_check_remediations
        WHERE repo = ? AND pr_number = ? AND check_name = ? AND escalated = 1`,
    )
    .get(repo, prNumber, classified.checkName) as { n: number }
  if ((alreadyEscalated?.n || 0) > 0) {
    logDrop('not-code-fixable-duplicate', classified, branchHint, `class=${fixability.class} (already escalated)`)
    return { handled: false, reason: 'not-code-fixable-duplicate', objectiveId: obj.id, checkName: classified.checkName, checkClass: fixability.class }
  }

  const note = `Check "${classified.checkName}" is ${fixability.class}, not code-fixable — ${fixability.reason} Auto-remediation did NOT nudge a session (that would burn the attempt budget on something no push can fix). A human needs to clear it or mark it non-required. (PR #${prNumber}, rule ${fixability.ruleId})`
  try {
    deps.db
      .prepare("UPDATE objectives SET has_blockers = 1, last_session_summary = ?, updated_at = datetime('now') WHERE id = ?")
      .run(note, obj.id)
    deps.db
      .prepare(
        `UPDATE external_check_remediations SET escalated = 1
          WHERE repo = ? AND pr_number = ? AND check_name = ? AND head_sha = ?`,
      )
      .run(repo, prNumber, classified.checkName, classified.headSha)
    const updated = deps.db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective | undefined
    if (updated) deps.broadcast({ type: 'objective_updated', payload: updated })
  } catch (err) {
    console.warn('[external-remediation] non-fixable escalate failed:', (err as Error).message)
  }
  console.warn(`[external-remediation] NOT-CODE-FIXABLE obj ${obj.id} PR #${prNumber}: ${note}`)
  return { handled: true, reason: 'not-code-fixable', objectiveId: obj.id, checkName: classified.checkName, checkClass: fixability.class }
}

// ── GAP B: cancelled runs ──────────────────────────────────────────────────────
/** Hard cap on automatic re-dispatches of a cancelled run, per (repo, pr, head_sha).
 *  Default 1: one push, one re-run. Env-overridable, but always finite. */
export function maxCancelledReruns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.MAX_CANCELLED_RERUNS || '', 10)
  return Number.isInteger(raw) && raw > 0 ? raw : 1
}

/** Sentinel check_name prefix for re-run bookkeeping rows. They live in the shared
 *  dedupe table (so the webhook loop and ci-feedback-bridge can never double-drive) and
 *  are stamped check_class='cancelled', which excludes them from the attempt budget. */
const RERUN_SENTINEL = '__cancelled_rerun__'

/**
 * A job cancelled at a concurrency gate is not a failure — there is nothing to diagnose,
 * so nudging a worker is pure noise — but nothing else handled it either, so the PR just
 * stayed red forever (obj 704698, gap B). Re-dispatch the run instead, capped per
 * (repo, pr, head_sha) by sentinel rows on the UNIQUE dedupe key: the cap is enforced by
 * the count BEFORE the insert AND by the UNIQUE constraint, so concurrent deliveries — or
 * a repo-side re-run workflow doing the same thing — cannot compound into a loop. A new
 * head sha (i.e. a real push) gets its own fresh, single re-run.
 */
async function handleCancelledCheck(
  deps: RemediationDeps,
  classified: ClassifiedCheck,
  branchHint: string | null,
  env: NodeJS.ProcessEnv,
): Promise<RemediationResult> {
  const repo = classified.repoFullName || DEFAULT_HARNESS_REPO
  const owner = resolveOwnerObjective(deps.db, classified, branchHint, { allowRecentDone: true, env })
  const prNumber = classified.prNumberHint
    ?? (owner.objective ? (owner.objective.pr_number ?? parsePrNumberFromUrl(owner.objective.pr_url)) : null)

  // Only PR-linked cancellations are re-dispatched. A cancelled cron/trunk run has no PR
  // to unblock, and guessing a run to re-run there is how you build a re-run storm.
  if (!prNumber || prNumber <= 0 || !classified.headSha) {
    logDrop('cancelled-ignored', classified, branchHint, 'no PR handle')
    return { handled: false, reason: 'cancelled-ignored', checkName: classified.checkName }
  }
  if (!classified.runId) {
    logDrop('cancelled-ignored', classified, branchHint, 'no workflow run id')
    return { handled: false, reason: 'cancelled-ignored', objectiveId: owner.objective?.id, checkName: classified.checkName }
  }

  const cap = maxCancelledReruns(env)
  const used = deps.db
    .prepare(
      `SELECT COUNT(*) AS n FROM external_check_remediations
        WHERE repo = ? AND pr_number = ? AND head_sha = ? AND check_name LIKE ?`,
    )
    .get(repo, prNumber, classified.headSha, `${RERUN_SENTINEL}%`) as { n: number }
  if ((used?.n || 0) >= cap) {
    logDrop('cancelled-rerun-capped', classified, branchHint, `cap=${cap} per (repo,pr,sha)`)
    return { handled: false, reason: 'cancelled-rerun-capped', objectiveId: owner.objective?.id, checkName: classified.checkName }
  }

  const sentinel = `${RERUN_SENTINEL}#${(used?.n || 0) + 1}`
  const ins = deps.db
    .prepare(
      `INSERT OR IGNORE INTO external_check_remediations
         (objective_id, repo, pr_number, check_name, head_sha, attempt, check_class)
       VALUES (?, ?, ?, ?, ?, 0, 'cancelled')`,
    )
    .run(owner.objective?.id ?? 0, repo, prNumber, sentinel, classified.headSha)
  if (ins.changes === 0) {
    // Lost the race with a concurrent delivery — that one is doing the re-run.
    logDrop('cancelled-rerun-capped', classified, branchHint, 'concurrent re-run already claimed')
    return { handled: false, reason: 'cancelled-rerun-capped', objectiveId: owner.objective?.id, checkName: classified.checkName }
  }

  const exec = deps.exec || defaultExec
  try {
    const out = await exec('gh', ['run', 'rerun', String(classified.runId), '-R', repo])
    console.log(
      `[external-remediation] cancelled ${classified.checkName} on ${repo} PR #${prNumber} @${classified.headSha.slice(0, 8)} → re-dispatched run ${classified.runId} (${(used?.n || 0) + 1}/${cap}) ${out ? out.trim().slice(0, 200) : ''}`,
    )
    return { handled: true, reason: 'cancelled-rerun', objectiveId: owner.objective?.id, checkName: classified.checkName }
  } catch (err) {
    // The sentinel row STAYS: a failed re-run must not free the cap and invite a storm.
    console.warn('[external-remediation] cancelled re-run dispatch failed:', (err as Error).message)
    return { handled: false, reason: 'cancelled-rerun-failed', objectiveId: owner.objective?.id, checkName: classified.checkName }
  }
}

// ── GAP C: PRs nobody owns ─────────────────────────────────────────────────────
type UnownedKind = 'dependency-maintenance' | 'unowned-pr-maintenance'

function unownedKindFor(branch: string | null): UnownedKind {
  return (branch || '').trim().startsWith('dependabot/') ? 'dependency-maintenance' : 'unowned-pr-maintenance'
}

/**
 * A red PR with no derivable objective (every dependabot/* PR by design, plus any
 * hand-pushed branch) had NOBODY responsible: PR 331 sat with five failing checks
 * indefinitely. Policy implemented here: ONE long-lived maintenance objective per
 * (repo, kind), reused across PRs, with each failing PR appended to its description so
 * the queue shows exactly what it owns. Deduped per (repo, pr, check, sha) like every
 * other path, and card CREATION is daily-capped so a burst of bumps can't spam the board.
 */
function handleUnownedPrFailure(
  deps: RemediationDeps,
  classified: ClassifiedCheck,
  prNumber: number,
  branchHint: string | null,
  env: NodeJS.ProcessEnv,
): RemediationResult {
  const repo = classified.repoFullName || DEFAULT_HARNESS_REPO
  const kind = unownedKindFor(branchHint)

  const ins = deps.db
    .prepare(
      `INSERT OR IGNORE INTO external_check_remediations
         (objective_id, repo, pr_number, check_name, head_sha, attempt, check_class)
       VALUES (0, ?, ?, ?, ?, 0, 'unowned')`,
    )
    .run(repo, prNumber, classified.checkName, classified.headSha)
  if (ins.changes === 0) {
    logDrop('unowned-pr-duplicate', classified, branchHint, `pr=#${prNumber}`)
    return { handled: false, reason: 'unowned-pr-duplicate', checkName: classified.checkName }
  }

  let card = findMaintenanceObjective(deps.db, repo, kind)
  if (!card) {
    const cap = maxTrunkCardsPerDay(env)
    const created = deps.db
      .prepare(
        `SELECT COUNT(*) AS n FROM objectives
          WHERE origin IN ('dependency-maintenance','unowned-pr-maintenance','ci-orphan-inherit','trunk-failure')
            AND created_at >= datetime('now', '-1 day')`,
      )
      .get() as { n: number }
    if ((created?.n || 0) >= cap) {
      logDrop('unowned-pr-cap', classified, branchHint, `cap=${cap}/day`)
      return { handled: false, reason: 'unowned-pr-cap', checkName: classified.checkName }
    }
    card = createMaintenanceObjective(deps, repo, kind)
    if (!card) return { handled: false, reason: 'error', checkName: classified.checkName }
  }

  appendPrToMaintenanceObjective(deps.db, card.id, prNumber, classified)
  try {
    deps.db
      .prepare('UPDATE external_check_remediations SET objective_id = ? WHERE repo = ? AND pr_number = ? AND check_name = ? AND head_sha = ?')
      .run(card.id, repo, prNumber, classified.checkName, classified.headSha)
  } catch { /* bookkeeping only */ }
  console.log(`[external-remediation] unowned PR #${prNumber} (${repo}, ${kind}) → owned by objective ${card.id} — check ${classified.checkName}`)
  return { handled: true, reason: 'unowned-pr-owned', objectiveId: card.id, checkName: classified.checkName }
}

function findMaintenanceObjective(db: Database, repo: string, kind: UnownedKind): Objective | null {
  try {
    const row = db
      .prepare(
        `SELECT * FROM objectives
          WHERE origin = ? AND title LIKE ?
            AND status NOT IN ('done', 'archived', 'cancelled')
          ORDER BY id DESC LIMIT 1`,
      )
      .get(kind, `%${repo}%`) as Objective | undefined
    return row || null
  } catch {
    return null
  }
}

function createMaintenanceObjective(deps: RemediationDeps, repo: string, kind: UnownedKind): Objective | null {
  const workspace = workspaceForRepo(deps.db, repo)
  const isDeps = kind === 'dependency-maintenance'
  const title = isDeps
    ? `[Auto] Dependency-bump PR health — ${repo}`
    : `[Auto] Unowned red PRs — ${repo}`
  const description = [
    isDeps
      ? `Standing owner for **dependency-bump PR health** on ${repo}. Dependabot PRs carry no objective id,`
      : `Standing owner for **red PRs with no owning objective** on ${repo}. These PRs carry no derivable`,
    isDeps
      ? `so the auto-remediation loop could never route their failing checks to anyone — they stayed red`
      : `objective id, so the auto-remediation loop could never route their failing checks to anyone — they`,
    isDeps ? `indefinitely (obj 704698, gap C).` : `stayed red indefinitely (obj 704698, gap C).`,
    ``,
    `Failing PRs are appended below as their checks fail. For each one: diagnose the failing check,`,
    `fix it on the PR branch (or close the PR if the bump is not worth taking), and push. Do NOT merge —`,
    `Mike merges. Fetch only failing lines (\`gh run view <id> --log-failed\`), never full logs.`,
    ``,
    `### Failing PRs`,
  ].join('\n')
  try {
    const result = deps.db
      .prepare(
        `INSERT INTO objectives (title, description, agent_context, workspace, category, status, origin)
         VALUES (?, ?, 'cto', ?, 'general', 'queue', ?)`,
      )
      .run(title, description, workspace, kind)
    const obj = deps.db.prepare('SELECT * FROM objectives WHERE id = ?').get(Number(result.lastInsertRowid)) as Objective | undefined
    if (obj) {
      try { deps.broadcast({ type: 'objective_updated', payload: obj }) } catch { /* best-effort */ }
      return obj
    }
    return null
  } catch (err) {
    console.error('[external-remediation] maintenance card insert failed:', (err as Error).message)
    return null
  }
}

/** Append `- PR #N — check` once. Idempotent on the `#N` marker so the same PR failing
 *  five different checks doesn't produce five lines of noise. */
function appendPrToMaintenanceObjective(db: Database, objectiveId: number, prNumber: number, classified: ClassifiedCheck): void {
  try {
    const row = db.prepare('SELECT description FROM objectives WHERE id = ?').get(objectiveId) as { description?: string } | undefined
    const desc = row?.description || ''
    const marker = `- PR #${prNumber}`
    if (desc.includes(marker)) return
    const line = `${marker} — first seen red on \`${classified.checkName}\`${classified.targetUrl ? ` (${classified.targetUrl})` : ''}`
    db.prepare("UPDATE objectives SET description = ?, updated_at = datetime('now') WHERE id = ?")
      .run(`${desc}\n${line}`, objectiveId)
  } catch { /* description bookkeeping is best-effort */ }
}

// ── GAP D: orphaned PRs whose objective went done past the grace window ────────
/**
 * Nearly every remediated objective in the live DB is `done` — a worker flips done as
 * soon as its session ends and review passes, often BEFORE its checks finish. Past the
 * done-grace window the nudge was DROPPED and the PR was orphaned: red, with its owner
 * closed. Fix the ownership handoff instead of widening the grace (which would keep
 * resuming long-finished sessions): file a fresh objective that INHERITS the PR, so a
 * live session picks it up from the queue under normal capacity rules.
 *
 * Guards: exactly one heir per (repo, pr) via a sentinel row on the UNIQUE dedupe key;
 * the done objective is never modified or resurrected; terminal_by_human never reaches
 * here (it is a hard stop upstream).
 */
function handleOrphanedObjective(
  deps: RemediationDeps,
  classified: ClassifiedCheck,
  doneOwner: Objective,
  branchHint: string | null,
): RemediationResult {
  const repo = classified.repoFullName || DEFAULT_HARNESS_REPO
  const prNumber = classified.prNumberHint ?? doneOwner.pr_number ?? parsePrNumberFromUrl(doneOwner.pr_url) ?? -doneOwner.id

  const ins = deps.db
    .prepare(
      `INSERT OR IGNORE INTO external_check_remediations
         (objective_id, repo, pr_number, check_name, head_sha, attempt, check_class)
       VALUES (?, ?, ?, '__orphan_inherit__', '', 0, 'orphan')`,
    )
    .run(doneOwner.id, repo, prNumber)
  if (ins.changes === 0) {
    logDrop('orphan-duplicate', classified, branchHint, `done-owner=${doneOwner.id} pr=#${prNumber}`)
    return { handled: false, reason: 'orphan-duplicate', objectiveId: doneOwner.id, checkName: classified.checkName }
  }

  const prUrl = doneOwner.pr_url || (prNumber > 0 ? `https://github.com/${repo}/pull/${prNumber}` : null)
  const branch = doneOwner.branch_name || branchHint || null
  const title = `[Auto] CI red on ${repo.split('/').pop() || repo} PR #${prNumber} — inherited from obj ${doneOwner.id}`
  const description = [
    `PR #${prNumber} is RED but its owning objective (${doneOwner.id} — "${doneOwner.title}") is \`done\` and past the`,
    `remediation grace window, so the auto-remediation nudge had nowhere to land (obj 704698, gap D).`,
    `This objective INHERITS the PR so it has a live owner. Objective ${doneOwner.id} is left closed — it is not resurrected.`,
    ``,
    `- Repo: ${repo}`,
    `- PR: ${prUrl || `#${prNumber}`}`,
    branch ? `- Branch: \`${branch}\`` : null,
    `- Failing check: \`${classified.checkName}\` (${classified.kind}, ${classified.outcome}) @ \`${classified.headSha || 'unknown'}\``,
    classified.targetUrl ? `- Details: ${classified.targetUrl}` : null,
    ``,
    `**What to do:** diagnose the failing check (fetch ONLY failing lines — \`gh run view <id> --log-failed\`),`,
    `fix it in your worktree, push to the PR branch, confirm the check goes green. Do NOT merge — Mike merges.`,
  ].filter((l): l is string => l !== null).join('\n')

  try {
    const result = deps.db
      .prepare(
        `INSERT INTO objectives (title, description, agent_context, workspace, category, status, origin, pr_number, pr_url, branch_name)
         VALUES (?, ?, 'cto', ?, 'general', 'queue', 'ci-orphan-inherit', ?, ?, ?)`,
      )
      .run(title, description, doneOwner.workspace || workspaceForRepo(deps.db, repo), prNumber > 0 ? prNumber : null, prUrl, branch)
    const heirId = Number(result.lastInsertRowid)
    try {
      deps.db.prepare('UPDATE external_check_remediations SET objective_id = ? WHERE repo = ? AND pr_number = ? AND check_name = ?')
        .run(heirId, repo, prNumber, '__orphan_inherit__')
      const heir = deps.db.prepare('SELECT * FROM objectives WHERE id = ?').get(heirId) as Objective | undefined
      if (heir) deps.broadcast({ type: 'objective_updated', payload: heir })
    } catch { /* best-effort */ }
    console.log(`[external-remediation] orphaned PR #${prNumber} (owner ${doneOwner.id} done past grace) → inherited by new objective ${heirId}`)
    return { handled: true, reason: 'orphan-inherited', objectiveId: heirId, checkName: classified.checkName }
  } catch (err) {
    console.error('[external-remediation] orphan inherit insert failed:', (err as Error).message)
    return { handled: false, reason: 'error', objectiveId: doneOwner.id, checkName: classified.checkName }
  }
}

function countEscalated(db: Database, repo: string, prNumber: number): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM external_check_remediations WHERE repo = ? AND pr_number = ? AND escalated = 1')
    .get(repo, prNumber) as { n: number }
  return row?.n || 0
}

function lastSessionId(db: Database, objectiveId: number): string | null {
  try {
    const row = db
      .prepare('SELECT session_id FROM session_intel WHERE objective_id = ? ORDER BY ended_at DESC LIMIT 1')
      .get(objectiveId) as { session_id?: string } | undefined
    return row?.session_id || null
  } catch {
    return null
  }
}

/** Best-effort branch extraction for status events (which carry no PR list). The
 *  status event includes `branches: [{name}]`; check_suite/workflow_run carry
 *  `head_branch`. */
function extractBranchHint(payload: AnyPayload | null | undefined): string | null {
  if (!payload) return null
  const branches = payload.branches as Array<{ name?: string }> | undefined
  if (Array.isArray(branches) && branches[0]?.name) return branches[0].name as string
  const cs = payload.check_suite as { head_branch?: string } | undefined
  if (cs?.head_branch) return cs.head_branch
  const wr = payload.workflow_run as { head_branch?: string } | undefined
  if (wr?.head_branch) return wr.head_branch
  return null
}
