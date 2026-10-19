/**
 * External-CI webhook classification and check-class rules — extracted from
 * external-remediation.ts (behavior frozen).
 *
 * No GitHub act-path, no session spawn. handleExternalCheckEvent stays on the facade.
 */
import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'

/** Conclusions (GitHub Actions / check_run / check_suite / workflow_run) that mean
 *  "this required check failed and is worth remediating". Success, neutral, skipped,
 *  cancelled, queued, in_progress are intentionally NOT here. */
const FAIL_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required'])
/** Commit-`status` event states (Vercel and other status-API posters) that mean failure. */
const FAIL_STATES = new Set(['failure', 'error'])
/** Conclusions handled by the CANCELLED path (obj 704698, gap B) — deliberately NOT in
 *  FAIL_CONCLUSIONS: a cancelled job must never nudge a worker (there is nothing to
 *  diagnose), but it must not be ignored either, or a job cancelled at a concurrency
 *  gate leaves the PR permanently red. It gets a bounded re-dispatch instead. */
const CANCEL_CONCLUSIONS = new Set(['cancelled'])

export const HANDLED_EVENTS = new Set(['check_run', 'check_suite', 'workflow_run', 'status'])

/** Default cap, in the spirit of MAX_AI_REVIEW_ITERATIONS (3). Env-overridable. */
export function maxRemediationAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.MAX_REMEDIATION_ATTEMPTS || '', 10)
  return Number.isInteger(raw) && raw > 0 ? raw : 5
}

/** The owner switch for the whole act-path. Two sources, OR'd together:
 *   1. settings.auto_remediation_enabled — the toggle the owner flips (board / SQL),
 *      mirroring auto_merge_enabled. Default OFF. Read at call time, so flipping it
 *      arms/disarms instantly with no restart.
 *   2. AUTO_REMEDIATION_ENABLED env var — an ops/CI override; also lets the unit
 *      tests drive the flag without a DB. An explicit truthy env var wins outright.
 *  The act-path stays inert unless one of these is on. */
export function isRemediationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.AUTO_REMEDIATION_ENABLED || '').trim().toLowerCase()
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true
  try {
    const row = getDb()
      .prepare(`SELECT value FROM settings WHERE key = 'auto_remediation_enabled'`)
      .get() as { value: string } | undefined
    return row?.value === '1'
  } catch {
    return false
  }
}

export interface ClassifiedCheck {
  kind: 'check_run' | 'check_suite' | 'workflow_run' | 'status'
  /** Human check name / status context, e.g. "Vitest", "build", "vercel". */
  checkName: string
  /** Head commit SHA the check ran against. */
  headSha: string
  /** owner/repo. */
  repoFullName: string
  /** PR number carried in the event payload, if any (status events carry none). */
  prNumberHint: number | null
  /** GitHub Actions run id (workflow_run) for `gh run view --log-failed`. */
  runId: number | null
  /** check_run id, for the Checks-API annotations endpoint. */
  checkRunId: number | null
  /** Vercel/status deployment URL (NOT fetched; surfaced to the session). */
  targetUrl: string | null
  /** Raw conclusion/state, for logging + prompt context. */
  outcome: string
  /** What TRIGGERED the run (`workflow_run.event`): push / pull_request / schedule /
   *  workflow_dispatch. `schedule` is the strongest possible signal that this is a cron
   *  job and not a PR check (obj 704698, gap A). Null for events that don't carry it. */
  triggerEvent?: string | null
}

/** Lowercased helper: is this the internal harness gate (which the test-agent loop
 *  already drives)? If so we must NOT remediate it — that would double-drive the PR. */
export function isHarnessCheck(checkName: string): boolean {
  const n = (checkName || '').trim().toLowerCase()
  return n === 'harness/test-agent' || n.startsWith('harness/')
}

export interface AnyPayload {
  [k: string]: unknown
}

function firstPrNumber(prs: unknown): number | null {
  if (!Array.isArray(prs)) return null
  for (const p of prs) {
    const n = (p as { number?: unknown })?.number
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) return n
  }
  return null
}

/**
 * Pure classifier: turn a raw webhook (event header + parsed body) into a
 * ClassifiedCheck IFF it is a FAILURE on a handled event type for a real check, else
 * null. Success / non-failure / non-PR-able / harness-gate / unhandled events all
 * return null so the caller cleanly ignores them. No DB, no IO — exhaustively testable.
 */
export function classifyCheckEvent(event: string, payload: AnyPayload | null | undefined): ClassifiedCheck | null {
  if (!event || !HANDLED_EVENTS.has(event) || !payload) return null
  const repoFullName = ((payload.repository as { full_name?: string } | undefined)?.full_name || '').trim()

  if (event === 'check_run') {
    const cr = payload.check_run as AnyPayload | undefined
    if (!cr) return null
    if ((cr.status as string) !== 'completed') return null
    const conclusion = (cr.conclusion as string) || ''
    if (!FAIL_CONCLUSIONS.has(conclusion)) return null
    const checkName = (cr.name as string) || 'check_run'
    if (isHarnessCheck(checkName)) return null
    return {
      kind: 'check_run',
      checkName,
      headSha: (cr.head_sha as string) || '',
      repoFullName,
      prNumberHint: firstPrNumber(cr.pull_requests),
      runId: null,
      checkRunId: typeof cr.id === 'number' ? (cr.id as number) : null,
      targetUrl: (cr.details_url as string) || null,
      outcome: conclusion,
    }
  }

  if (event === 'check_suite') {
    const cs = payload.check_suite as AnyPayload | undefined
    if (!cs) return null
    if ((cs.status as string) !== 'completed') return null
    const conclusion = (cs.conclusion as string) || ''
    if (!FAIL_CONCLUSIONS.has(conclusion)) return null
    const checkName = ((cs.app as { name?: string } | undefined)?.name) || 'check_suite'
    if (isHarnessCheck(checkName)) return null
    return {
      kind: 'check_suite',
      checkName,
      headSha: (cs.head_sha as string) || '',
      repoFullName,
      prNumberHint: firstPrNumber(cs.pull_requests),
      runId: null,
      checkRunId: null,
      targetUrl: null,
      outcome: conclusion,
    }
  }

  if (event === 'workflow_run') {
    const wr = payload.workflow_run as AnyPayload | undefined
    if (!wr) return null
    if ((wr.status as string) !== 'completed') return null
    const conclusion = (wr.conclusion as string) || ''
    if (!FAIL_CONCLUSIONS.has(conclusion)) return null
    const checkName = (wr.name as string) || 'workflow_run'
    if (isHarnessCheck(checkName)) return null
    return {
      kind: 'workflow_run',
      checkName,
      headSha: (wr.head_sha as string) || '',
      repoFullName,
      prNumberHint: firstPrNumber(wr.pull_requests),
      runId: typeof wr.id === 'number' ? (wr.id as number) : null,
      checkRunId: null,
      targetUrl: (wr.html_url as string) || null,
      outcome: conclusion,
      triggerEvent: (wr.event as string) || null,
    }
  }

  // event === 'status' — Vercel and other commit-status posters. No PR list; resolve
  // by SHA / branch downstream. This is ALSO the event our own postHarnessStatus
  // emits, so the harness-gate guard above is load-bearing here.
  const state = (payload.state as string) || ''
  if (!FAIL_STATES.has(state)) return null
  const checkName = (payload.context as string) || 'status'
  if (isHarnessCheck(checkName)) return null
  return {
    kind: 'status',
    checkName,
    headSha: (payload.sha as string) || ((payload.commit as { sha?: string } | undefined)?.sha) || '',
    repoFullName,
    prNumberHint: null,
    runId: null,
    checkRunId: null,
    targetUrl: (payload.target_url as string) || null,
    outcome: state,
  }
}

// ── Check FIXABILITY classifier (obj 704698, gap A) ─────────────────────────────
// The loop used to nudge a worker to "diagnose and fix" ANY red check. Some checks no
// code push can ever turn green:
//   - environmental: `Verify migrations applied to prod` asserts live prod DB state;
//     `Vercel` / provider deploy statuses depend on the platform, not the diff.
//   - advisory: `Claude security review (advisory)` is non-blocking by design.
//   - scheduled: cron workflow runs (`ReadyMode dialer-performance 6pm ET`, …) are not
//     attached to any PR at all.
// Each of those burned attempts 1..5 on a real objective and then escalated with a
// misleading reason. Now they are classified, never nudged, and escalated ONCE with an
// accurate reason — and crucially they no longer consume the code-fixable attempt budget
// (their remediation rows are stamped with `check_class`, which countAttempts excludes).
//
// DATA-DRIVEN: the rules are an ordered table, not a string list buried in a function.
// Operators can prepend rules without a deploy via the REMEDIATION_CHECK_CLASS_RULES env
// var or the `remediation_check_class_rules` settings row (same JSON shape as below).
export type CheckClass = 'code-fixable' | 'environmental' | 'advisory' | 'scheduled'

export interface CheckClassRule {
  /** Stable id, surfaced in logs/results so a classification is always explainable. */
  id: string
  /** JS regex source tested against the check name. */
  pattern: string
  /** Regex flags (default 'i'). */
  flags?: string
  class: CheckClass
  /** Human reason, used verbatim in the escalation note. */
  reason: string
}

/** Only this class is worth handing to a worker. */
export function isFixableClass(c: CheckClass): boolean {
  return c === 'code-fixable'
}

/** Ordered — first match wins. Every pattern below was written against the REAL
 *  check names observed in the live `external_check_remediations` table. */
export const DEFAULT_CHECK_CLASS_RULES: CheckClassRule[] = [
  {
    id: 'prod-migration-assertion',
    pattern: '^\\s*verify migrations? applied',
    class: 'environmental',
    reason: 'Asserts live prod database state — no code push can turn it green; a human must apply/repair the migration.',
  },
  {
    id: 'advisory-review',
    pattern: '\\(advisory\\)|\\badvisory\\b',
    class: 'advisory',
    reason: 'Advisory, non-blocking check — informational only, it does not gate the merge.',
  },
  {
    id: 'vercel-deploy',
    pattern: '\\bvercel\\b',
    class: 'environmental',
    reason: 'Hosting-provider deploy status (Vercel) — depends on project/env configuration, not on the diff alone.',
  },
  {
    id: 'provider-deploy-status',
    // Railway/Vercel bots post commit statuses as "<project> - <service>", e.g.
    // "example-project - example-project-platform", "example-platform - example-v2".
    pattern: '^[a-z0-9][a-z0-9._-]* - [a-z0-9][a-z0-9._-]*$',
    class: 'environmental',
    reason: 'Hosting-provider deployment status — owned by the platform/env, not by a code fix on this PR.',
  },
  {
    id: 'deploy-job',
    pattern: '^deploy\\b',
    class: 'environmental',
    reason: 'Deployment job — usually credentials/env/target state rather than a code defect.',
  },
  {
    id: 'readymode-cron',
    pattern: '^readymode\\b',
    class: 'scheduled',
    reason: 'Scheduled ReadyMode ingest/report job — a cron run unrelated to any pull request.',
  },
  {
    id: 'scheduled-job-name',
    pattern: '\\b(nightly|cron|hourly|daily|delta ingest|data-freshness)\\b',
    class: 'scheduled',
    reason: 'Scheduled job — a cron run unrelated to any pull request.',
  },
]

/** Parse a JSON rule array defensively — a malformed operator override must degrade to
 *  the defaults, never break classification. */
function parseRuleJson(raw: string | null | undefined): CheckClassRule[] {
  if (!raw || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as CheckClassRule[]).filter(
      (r) =>
        r && typeof r.pattern === 'string' && r.pattern.length > 0 &&
        typeof r.class === 'string' &&
        ['code-fixable', 'environmental', 'advisory', 'scheduled'].includes(r.class),
    ).map((r) => ({
      id: typeof r.id === 'string' && r.id ? r.id : 'custom',
      pattern: r.pattern,
      flags: typeof r.flags === 'string' ? r.flags : undefined,
      class: r.class,
      reason: typeof r.reason === 'string' && r.reason ? r.reason : 'Operator-configured non-code-fixable check.',
    }))
  } catch {
    return []
  }
}

/**
 * Effective rule table: operator overrides first (so they can reclassify a default),
 * then the built-ins. Sources, both optional: REMEDIATION_CHECK_CLASS_RULES env JSON and
 * the `remediation_check_class_rules` settings row (read at call time — editing it takes
 * effect with no restart, like auto_remediation_enabled).
 */
export function loadCheckClassRules(opts: { env?: NodeJS.ProcessEnv; db?: Database } = {}): CheckClassRule[] {
  const env = opts.env || process.env
  const custom = parseRuleJson(env.REMEDIATION_CHECK_CLASS_RULES)
  let fromDb: CheckClassRule[] = []
  try {
    const db = opts.db
    if (db) {
      const row = db
        .prepare(`SELECT value FROM settings WHERE key = 'remediation_check_class_rules'`)
        .get() as { value?: string } | undefined
      fromDb = parseRuleJson(row?.value)
    }
  } catch { /* settings table unreadable → defaults only */ }
  return [...custom, ...fromDb, ...DEFAULT_CHECK_CLASS_RULES]
}

export interface CheckClassification {
  class: CheckClass
  fixable: boolean
  reason: string
  ruleId: string
}

/**
 * Classify a check by NAME (plus, when available, what triggered its run). Pure apart
 * from the optional settings read inside loadCheckClassRules. Unknown checks default to
 * `code-fixable` — the loop's previous behaviour — so this can only ever REDUCE the
 * number of futile nudges, never suppress a real one by accident.
 */
export function classifyCheckFixability(
  checkName: string,
  opts: { triggerEvent?: string | null; rules?: CheckClassRule[]; env?: NodeJS.ProcessEnv; db?: Database } = {},
): CheckClassification {
  const name = (checkName || '').trim()
  // Trigger beats name: a schedule-triggered run is a cron job whatever it is called.
  if ((opts.triggerEvent || '').toLowerCase() === 'schedule') {
    return {
      class: 'scheduled',
      fixable: false,
      reason: 'Schedule-triggered workflow run (cron) — not attached to any pull request, so no PR-side code fix applies.',
      ruleId: 'trigger-schedule',
    }
  }
  const rules = opts.rules || loadCheckClassRules({ env: opts.env, db: opts.db })
  for (const rule of rules) {
    let re: RegExp
    try {
      re = new RegExp(rule.pattern, rule.flags ?? 'i')
    } catch {
      continue // a bad operator regex is skipped, not fatal
    }
    if (re.test(name)) {
      return { class: rule.class, fixable: isFixableClass(rule.class), reason: rule.reason, ruleId: rule.id }
    }
  }
  return { class: 'code-fixable', fixable: true, reason: 'Ordinary CI check — a code fix on this PR can turn it green.', ruleId: 'default' }
}

// ── CANCELLED classifier (obj 704698, gap B) ───────────────────────────────────
/**
 * Deliberately a SEPARATE function from classifyCheckEvent: that one's contract is
 * "failures only" and the rest of the loop (and its tests) depend on it returning null
 * for a cancelled run. This one recognises ONLY cancellations, so the caller can route
 * them to the bounded re-dispatch path. Same harness-namespace guard applies.
 */
export function classifyCancelledEvent(event: string, payload: AnyPayload | null | undefined): ClassifiedCheck | null {
  if (!event || !HANDLED_EVENTS.has(event) || !payload) return null
  const repoFullName = ((payload.repository as { full_name?: string } | undefined)?.full_name || '').trim()
  const node = (event === 'check_run' ? payload.check_run
    : event === 'check_suite' ? payload.check_suite
    : event === 'workflow_run' ? payload.workflow_run
    : null) as AnyPayload | null
  if (!node) return null // `status` events have no cancelled state
  if ((node.status as string) !== 'completed') return null
  if (!CANCEL_CONCLUSIONS.has((node.conclusion as string) || '')) return null
  const checkName = (node.name as string)
    || ((node.app as { name?: string } | undefined)?.name)
    || event
  if (isHarnessCheck(checkName)) return null
  const runId = event === 'workflow_run' && typeof node.id === 'number'
    ? (node.id as number)
    : parseRunIdFromUrl((node.details_url as string) || (node.html_url as string) || null)
  return {
    kind: event as ClassifiedCheck['kind'],
    checkName,
    headSha: (node.head_sha as string) || '',
    repoFullName,
    prNumberHint: firstPrNumber(node.pull_requests),
    runId,
    checkRunId: event === 'check_run' && typeof node.id === 'number' ? (node.id as number) : null,
    targetUrl: (node.html_url as string) || (node.details_url as string) || null,
    outcome: 'cancelled',
    triggerEvent: (node.event as string) || null,
  }
}

/** `…/actions/runs/<id>` or `…/runs/<id>/job/<jobId>` → <id>. */
export function parseRunIdFromUrl(url: string | null | undefined): number | null {
  const m = /\/runs\/(\d+)/.exec(url || '')
  if (!m) return null
  const n = parseInt(m[1], 10)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Trunk branches (obj 702632, gap D): a failure here has no owning PR objective —
 *  it belongs to whatever merged last. Config list, not a pattern: `redesign` is
 *  example-platform's long-lived second trunk. */
export const TRUNK_BRANCHES = new Set(['main', 'master', 'redesign'])

/** Grace window for remediating an objective that already flipped `done`
 *  (obj 702632, gap C). Objectives go done minutes before their check finishes;
 *  a failure landing just after must not be silently dropped. Env-overridable. */
export function doneGraceDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseInt(env.REMEDIATION_DONE_GRACE_DAYS || '', 10)
  return Number.isInteger(raw) && raw >= 0 ? raw : 7
}

/** True when the SQLite timestamp (UTC `YYYY-MM-DD HH:MM:SS` or ISO) is within the
 *  last `days` days. Unparseable/missing → false (fail-closed: no grace). */
export function isWithinDays(timestamp: string | null | undefined, days: number, now: number = Date.now()): boolean {
  if (!timestamp) return false
  const t = Date.parse(timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T') + 'Z')
  if (!Number.isFinite(t)) return false
  return now - t <= days * 24 * 60 * 60 * 1000
}

/** An objective is eligible for remediation when it is still active (or, with
 *  `allowRecentDone`, went `done` recently — obj 702632 gap C: a merged/closed PR
 *  lands the objective in `done` FAST, often before its checks even finish, so a
 *  strict done-drop silently ate most real post-merge failures) and carries some
 *  handle we can drive the loop through: a PR link, or a branch (a session pushed a
 *  branch without registering a PR — the remediation prompt still works; the fix
 *  lands as a push to that branch).
 *
 *  HARD STOP: terminal_by_human is never overridden by the done-grace — a human
 *  explicitly parked it; CI must not resurrect it. (The `humanTerminalGuard` flag
 *  still governs non-done terminal rows, unchanged from obj 700415.) */
export function isRemediableObjective(
  obj: Pick<Objective, 'status' | 'pr_number' | 'pr_url'> & {
    terminal_by_human?: Objective['terminal_by_human']
    updated_at?: Objective['updated_at']
    branch_name?: Objective['branch_name']
  },
  opts: { humanTerminalGuard?: boolean; allowRecentDone?: boolean; doneGraceDays?: number } = {},
): boolean {
  if (obj.status === 'done') {
    if (!opts.allowRecentDone) return false
    // Done-grace (gap C): remediable only when the done flip is FRESH — the
    // objective was updated within the grace window — and no human terminated it.
    if (obj.terminal_by_human) return false
    if (!isWithinDays(obj.updated_at, opts.doneGraceDays ?? doneGraceDays())) return false
  }
  // Human-terminal guard (obj 700415, FIX B). A human-terminated PR objective
  // must not be auto-reactivated by CI remediation (deliverable A pathway #24,
  // which excludes `done` but not human-parked `review`). Default OFF = unchanged;
  // when the guard is enforced, exclude terminal_by_human rows from remediation.
  if (opts.humanTerminalGuard && obj.terminal_by_human) return false
  return !!(obj.pr_number || (obj.pr_url && obj.pr_url.trim()) || (obj.branch_name && obj.branch_name.trim()))
}

/**
 * Parse candidate objective ids out of a branch name (obj 702632, gap A).
 * Sessions push branches without registering them, so pr_number/pr_url/branch_name
 * are all NULL on the objective row and exact matching drops the event. But the
 * branch names themselves carry the id under a handful of observed conventions:
 *
 *   fix/702577-funnel-full-month      → 702577
 *   w3/702583-bounce-deploy           → 702583
 *   cc/obj-702450-w1-thread-scanner   → 702450
 *
 * Generally: an integer id (currently 6-digit; we accept 4-8 to avoid hardcoding
 * the current length) delimited by `/`, `-`, `_`, or an `obj-` prefix. Ordering
 * matters — an explicit `obj-<id>` token is the strongest signal, then an id that
 * OPENS a path segment (`fix/<id>-…`), then any bounded digit run. The caller
 * verifies each candidate against the objectives table, so an unrelated number in
 * a branch (`fix/react-190000-upgrade`) simply fails the existence check.
 * Trunk and dependabot branches never yield candidates. Pure — no DB, no IO.
 */
export function parseObjectiveIdCandidates(branch: string | null | undefined): number[] {
  const b = (branch || '').trim()
  if (!b || TRUNK_BRANCHES.has(b) || b.startsWith('dependabot/')) return []
  const out: number[] = []
  const seen = new Set<number>()
  const push = (raw: string | undefined) => {
    const n = parseInt(raw || '', 10)
    if (Number.isInteger(n) && n > 0 && !seen.has(n)) { seen.add(n); out.push(n) }
  }
  // 1. explicit obj-<id> tokens (strongest convention).
  for (const m of b.matchAll(/\bobj[-_](\d{4,8})(?!\d)/gi)) push(m[1])
  // 2. an id opening a path segment: start-of-string or after `/`, closed by -/_ or end.
  for (const m of b.matchAll(/(?:^|\/)(\d{4,8})(?:[-_/]|$)/g)) push(m[1])
  // 3. any bounded 4-8 digit run (delimited by /-_ or string edges).
  for (const m of b.matchAll(/(?:^|[/\-_])(\d{4,8})(?=[/\-_]|$)/g)) push(m[1])
  return out
}

