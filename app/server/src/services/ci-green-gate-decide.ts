/**
 * CI-green gate types, config, rollup normalisation, and pure decision —
 * extracted from ci-green-gate.ts (behavior frozen).
 *
 * No GitHub calls, no DB writes. runCompletionGate stays in ci-green-gate-run.ts.
 */
import type { Database } from 'better-sqlite3'

// ── Types ───────────────────────────────────────────────────────────────────────

/** Same shape pr-health-watchdog.ts / external-remediation.ts use. */
export type ExecFn = (file: string, args: string[]) => Promise<string>

/** A single entry from `gh pr view --json statusCheckRollup`. */
export interface RollupEntry {
  __typename?: string
  /** CheckRun */
  name?: string
  status?: string
  conclusion?: string
  workflowName?: string
  detailsUrl?: string
  /** StatusContext */
  context?: string
  state?: string
  targetUrl?: string
}

/** A rollup entry normalised across the CheckRun / StatusContext split. */
export interface NormalisedCheck {
  name: string
  /** `pending` covers queued/in_progress/waiting — a check that has not spoken yet. */
  state: 'success' | 'failure' | 'cancelled' | 'pending' | 'neutral'
  url: string | null
}

/** Where the required-check set came from. `unknown` ⇒ we could not read it. */
export type RequiredSource = 'ruleset' | 'branch-protection' | 'none' | 'unknown'

export interface RequiredChecks {
  contexts: string[]
  source: RequiredSource
  /** Populated when source === 'unknown'. */
  error?: string
}

export type CiGateAction =
  /** Green, advisory-only red, or nothing to gate on. Completion proceeds. */
  | 'allow'
  /** A required check genuinely FAILED. Completion is refused; hand back to the owner. */
  | 'hold'
  /** Not green, but holding would deadlock (absent checks past the bound, or the
   *  hold cap on an unschedulable check). Completion proceeds WITH a durable record. */
  | 'complete-with-red'
  /** Hold cap reached on a genuine failure. Stop bouncing; raise it to Mike. */
  | 'escalate'

export interface CiGateDecision {
  action: CiGateAction
  /** One line, human-readable, safe to persist and to show Mike. */
  reason: string
  failingRequired: string[]
  /** Required contexts with no entry, or an entry that is queued/cancelled. */
  missingRequired: string[]
  /** Red checks that are NOT required — recorded for context, never a blocker. */
  advisoryRed: string[]
  requiredChecks: string[]
  requiredSource: RequiredSource
  holdCount: number
  waitedMinutes: number
}

/**
 * `enforce`  — the normal completion boundary: a failing required check HOLDS.
 * `record-only` — for paths that exist SPECIFICALLY to break limbo (the 30-day
 *   review hard-expiry sweeper). Holding there would re-create the deadlock the
 *   sweeper exists to break, so it never holds — but it still records and surfaces
 *   the non-green PR, so nothing slips through unseen.
 */
export type GateMode = 'enforce' | 'record-only'

export interface CiGateConfig {
  /** Max hold cycles for one objective, ever. Beyond this we escalate to Mike. */
  holdCap: number
  /** Wall-clock bound (minutes, from first gate evaluation) for ABSENT/queued
   *  required checks. Past this the objective completes with a record. */
  absentWaitMinutes: number
  enabled: boolean
}

export const DEFAULT_CONFIG: CiGateConfig = {
  holdCap: 2,
  absentWaitMinutes: 45,
  enabled: true,
}

export interface CiGateInput {
  requiredChecks: RequiredChecks
  rollup: RollupEntry[] | null | undefined
  holdCount: number
  waitedMinutes: number
  mode: GateMode
  config: CiGateConfig
}

// ── Config (env → settings row → default, same three-layer idiom as the watchdog) ──

function settingsValue(db: Database | null, key: string): string | undefined {
  if (!db) return undefined
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  } catch {
    return undefined
  }
}

function numFrom(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function loadConfig(db: Database | null, env: NodeJS.ProcessEnv = process.env): CiGateConfig {
  const enabledRaw = env.CI_GREEN_GATE_ENABLED ?? settingsValue(db, 'ci_green_gate_enabled')
  return {
    // Default ON: the whole point of the objective is that completion stops being
    // blind to CI. The kill-switch is an explicit '0'.
    enabled: enabledRaw === undefined ? DEFAULT_CONFIG.enabled : enabledRaw === '1' || enabledRaw === 'true',
    holdCap: numFrom(
      env.CI_GREEN_GATE_HOLD_CAP ?? settingsValue(db, 'ci_green_gate_hold_cap'),
      DEFAULT_CONFIG.holdCap,
    ),
    absentWaitMinutes: numFrom(
      env.CI_GREEN_GATE_ABSENT_WAIT_MINUTES ?? settingsValue(db, 'ci_green_gate_absent_wait_minutes'),
      DEFAULT_CONFIG.absentWaitMinutes,
    ),
  }
}

// ── Pure: rollup normalisation ──────────────────────────────────────────────────

const FAILURE_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
const PENDING_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'])

/**
 * Flatten `statusCheckRollup` into one comparable shape. CheckRun entries carry
 * `name`/`status`/`conclusion`; StatusContext entries carry `context`/`state`. Treating
 * them as one list is what lets a required context match either kind — GitHub's required
 * set is a list of context strings that spans both.
 */
export function normaliseRollup(rollup: RollupEntry[] | null | undefined): NormalisedCheck[] {
  if (!Array.isArray(rollup)) return []
  const out: NormalisedCheck[] = []
  for (const e of rollup) {
    const name = (e.name ?? e.context ?? '').trim()
    if (!name) continue
    const url = e.detailsUrl ?? e.targetUrl ?? null
    if (e.context !== undefined && e.name === undefined) {
      // StatusContext: single `state` field.
      const s = (e.state ?? '').toUpperCase()
      out.push({
        name,
        state:
          s === 'SUCCESS' ? 'success'
            : s === 'FAILURE' || s === 'ERROR' ? 'failure'
              : s === 'PENDING' || s === 'EXPECTED' ? 'pending'
                : 'neutral',
        url,
      })
      continue
    }
    // CheckRun: `status` gates whether `conclusion` is meaningful yet.
    const status = (e.status ?? '').toUpperCase()
    const conclusion = (e.conclusion ?? '').toUpperCase()
    if (status && status !== 'COMPLETED') {
      out.push({ name, state: PENDING_STATUSES.has(status) ? 'pending' : 'pending', url })
      continue
    }
    out.push({
      name,
      state:
        conclusion === 'SUCCESS' ? 'success'
          : FAILURE_CONCLUSIONS.has(conclusion) ? 'failure'
            : conclusion === 'CANCELLED' ? 'cancelled'
              : conclusion === '' ? 'pending'
                : 'neutral', // SKIPPED / NEUTRAL — not a failure, not a pass
      url,
    })
  }
  return out
}

/**
 * The gate's OWN status context — the one {@link runCompletionGate}'s callers post when
 * this gate holds. See `THE GATE MUST NOT GRADE ITS OWN OUTPUT` in the module header.
 *
 * Deliberately duplicated from `external-remediation.isHarnessCheck` rather than imported:
 * that module pulls in `getDb` and `objective-audit`, and this one is kept dependency-free
 * (execFile + a type) so {@link evaluateCiGate} stays a pure, trivially-testable function.
 * Both predicates must agree; they are three lines and covered by tests on both sides.
 */
export function isHarnessOwnStatus(checkName: string): boolean {
  const n = (checkName || '').trim().toLowerCase()
  return n === 'harness/test-agent' || n.startsWith('harness/')
}

/**
 * Match a required CONTEXT string against the rollup. GitHub matches required checks by
 * the check-run *name* (or status context), but a workflow that never scheduled produces
 * no entry at all — which is exactly the ABSENT case we must not hold on. We also accept
 * a `workflowName` match so a required context expressed at workflow granularity still
 * resolves.
 */
export function findCheck(checks: NormalisedCheck[], context: string): NormalisedCheck | undefined {
  const want = context.trim().toLowerCase()
  return checks.find(c => c.name.trim().toLowerCase() === want)
}

// ── Pure: the decision ──────────────────────────────────────────────────────────

/**
 * The whole gate, as a pure function. Every branch here is unit-tested; the async
 * wrapper below only supplies IO.
 */
export function evaluateCiGate(input: CiGateInput): CiGateDecision {
  const { requiredChecks, rollup, holdCount, waitedMinutes, mode, config } = input
  // THE GATE MUST NOT GRADE ITS OWN OUTPUT (obj 706069).
  //
  // `harness/test-agent` is a REQUIRED check on this repo's ruleset but has no CI
  // producer — it is posted by the harness itself, and one of its posters is this
  // gate's own caller: on HOLD, state-poller posts `harness/test-agent=failure`
  // ("Completion blocked — required checks not green"). So a single hold made the
  // required set permanently unsatisfiable: the next evaluation read that failure as
  // world 1 (required check FAILED → HOLD), posted it again, and no push could clear
  // it because nothing but a `done` transition posts success — which the gate blocks.
  // The module header claims this gate cannot deadlock; this was the case it missed.
  //
  // Live instance: obj 706069 / PR #273. Review iteration 1 was blocked by a dead
  // preview (legitimate failure posted 02:08). The preview was fixed, iteration 2
  // PASSED at 03:03:38 — and 11s later the gate refused completion by reading
  // iteration 1's superseded status. Both real CI jobs were green throughout.
  //
  // Filtered out of `checks` as well as `required` so it can never resurface as
  // `advisoryRed` either — it is not evidence about the diff in any column. Third-party
  // required checks are untouched; this narrows the gate by exactly one self-reference.
  const checks = normaliseRollup(rollup).filter(c => !isHarnessOwnStatus(c.name))
  const required = requiredChecks.contexts.filter(c => !isHarnessOwnStatus(c))
  const requiredSet = new Set(required.map(c => c.trim().toLowerCase()))
  const advisoryRed = checks
    .filter(c => (c.state === 'failure' || c.state === 'cancelled') && !requiredSet.has(c.name.trim().toLowerCase()))
    .map(c => c.name)

  const base = {
    advisoryRed,
    requiredChecks: required,
    requiredSource: requiredChecks.source,
    holdCount,
    waitedMinutes,
  }

  // We could not read the ruleset. Inventing a required set here would either block on
  // advisory noise or block on nothing — both wrong. Never hold on our own blindness.
  if (requiredChecks.source === 'unknown') {
    const anyRed = checks.some(c => c.state === 'failure')
    return {
      ...base,
      action: anyRed ? 'complete-with-red' : 'allow',
      failingRequired: [],
      missingRequired: [],
      reason: anyRed
        ? `Could not read the branch ruleset (${requiredChecks.error ?? 'unknown error'}) so required-vs-advisory is undecidable; ` +
          `${checks.filter(c => c.state === 'failure').length} red check(s) present. Completed and handed to the pr-health watchdog.`
        : `Could not read the branch ruleset (${requiredChecks.error ?? 'unknown error'}); no red checks — nothing to gate on.`,
    }
  }

  // The branch has no required checks at all. Every red is advisory by definition.
  // (Or the only required check was the gate's own harness status — same outcome, but say
  // which, so a released completion is never explained by a reason that reads false.)
  if (required.length === 0) {
    const onlyHarness = requiredChecks.contexts.length > 0
    if (onlyHarness) {
      return {
        ...base,
        action: 'allow',
        failingRequired: [],
        missingRequired: [],
        reason:
          `The only required check(s) on this branch are the harness's own status ` +
          `(${requiredChecks.contexts.join(', ')}), which this gate does not grade — ` +
          `nothing independent left to gate on.`,
      }
    }
    return {
      ...base,
      action: 'allow',
      failingRequired: [],
      missingRequired: [],
      reason: advisoryRed.length
        ? `No required checks on this branch; ${advisoryRed.length} advisory check(s) red (${advisoryRed.join(', ')}) — advisory never blocks completion.`
        : 'No required checks configured on this branch.',
    }
  }

  const failingRequired: string[] = []
  const missingRequired: string[] = []
  for (const ctx of required) {
    const c = findCheck(checks, ctx)
    if (!c) { missingRequired.push(`${ctx} (never scheduled)`); continue }
    if (c.state === 'failure') { failingRequired.push(ctx); continue }
    if (c.state === 'cancelled') { missingRequired.push(`${ctx} (cancelled)`); continue }
    if (c.state === 'pending') { missingRequired.push(`${ctx} (queued/in progress)`); continue }
    // success / neutral / skipped → satisfied
  }

  // ── 1. A required check genuinely FAILED. This is the worker's to fix. ──────────
  if (failingRequired.length > 0) {
    if (holdCount >= config.holdCap) {
      return {
        ...base,
        action: 'escalate',
        failingRequired,
        missingRequired,
        reason:
          `Hold cap reached (${holdCount}/${config.holdCap}) with required check(s) still FAILING: ` +
          `${failingRequired.join(', ')}. Escalated to Mike rather than bouncing worker→review again.`,
      }
    }
    if (mode === 'record-only') {
      return {
        ...base,
        action: 'complete-with-red',
        failingRequired,
        missingRequired,
        reason:
          `Required check(s) FAILING (${failingRequired.join(', ')}) but this is a limbo-breaking path ` +
          `(record-only) — completing rather than re-wedging the objective. Handed to the pr-health watchdog.`,
      }
    }
    return {
      ...base,
      action: 'hold',
      failingRequired,
      missingRequired,
      reason: `Required check(s) FAILING: ${failingRequired.join(', ')}.`,
    }
  }

  // ── 2. Required checks absent / queued / cancelled-at-a-gate. NOT the worker's ──
  //      fault (GitHub Actions outages do exactly this). Bounded wait only.
  if (missingRequired.length > 0) {
    const capped = holdCount >= config.holdCap
    const waited = waitedMinutes >= config.absentWaitMinutes
    if (capped || waited || mode === 'record-only') {
      return {
        ...base,
        action: 'complete-with-red',
        failingRequired,
        missingRequired,
        reason:
          `Required check(s) never reported: ${missingRequired.join(', ')}. ` +
          `No required check FAILED — this is not a worker failure (an Actions outage or a concurrency-gate ` +
          `cancellation looks exactly like this). Bound reached (` +
          `waited ${Math.round(waitedMinutes)}m/${config.absentWaitMinutes}m, holds ${holdCount}/${config.holdCap}` +
          `${mode === 'record-only' ? ', limbo-breaking path' : ''}) — completed and handed to the pr-health watchdog.`,
      }
    }
    return {
      ...base,
      action: 'hold',
      failingRequired,
      missingRequired,
      reason:
        `Required check(s) have not reported yet: ${missingRequired.join(', ')}. ` +
        `Waiting (${Math.round(waitedMinutes)}m/${config.absentWaitMinutes}m) before completing regardless.`,
    }
  }

  // ── 3. All required checks satisfied. Advisory red is noted and ignored. ───────
  return {
    ...base,
    action: 'allow',
    failingRequired: [],
    missingRequired: [],
    reason: advisoryRed.length
      ? `All ${required.length} required check(s) green. ${advisoryRed.length} advisory check(s) red ` +
        `(${advisoryRed.join(', ')}) — advisory never blocks completion.`
      : `All ${required.length} required check(s) green.`,
  }
}

/** The message handed back to the worker on a HOLD. Concrete instruction, not "go look". */
export function buildHandback(decision: CiGateDecision, repo: string, prNumber: number): string {
  const lines = [
    `## Completion blocked — PR #${prNumber} (${repo}) is not green`,
    '',
    'Your work was NOT accepted. An objective must not reach `done` leaving a red PR behind,',
    'because the PR then has no owner and Mike has to hunt down who is responsible for it.',
    '',
  ]
  if (decision.failingRequired.length) {
    lines.push('**Required checks that are FAILING — fix these:**')
    for (const c of decision.failingRequired) lines.push(`- \`${c}\``)
    lines.push('')
    lines.push(`Inspect them with: \`gh pr checks ${prNumber} --repo ${repo}\``)
    lines.push(`and the failing logs with: \`gh run view --repo ${repo} --log-failed\`.`)
  }
  if (decision.missingRequired.length) {
    lines.push('**Required checks that have not reported:**')
    for (const c of decision.missingRequired) lines.push(`- \`${c}\``)
    lines.push('')
    lines.push(
      'These are NOT necessarily your fault (GitHub Actions outages and concurrency-gate',
      'cancellations look like this). Do NOT `workflow_dispatch` anything to force them —',
      'a third entrant to a static concurrency group evicts the real pending run. Push a',
      'commit if you have a real fix; otherwise the gate will release this on its own bound.',
    )
  }
  if (decision.advisoryRed.length) {
    lines.push('')
    lines.push(
      `_Advisory (non-required) checks also red — these did NOT block you and you are not ` +
      `required to fix them: ${decision.advisoryRed.map(c => `\`${c}\``).join(', ')}._`,
    )
  }
  lines.push('')
  lines.push(
    `_Required-vs-advisory was read from the repo's live branch ${decision.requiredSource}. ` +
    `Hold ${decision.holdCount + 1}/${DEFAULT_CONFIG.holdCap} — after the cap this escalates to Mike instead of bouncing again._`,
  )
  lines.push('')
  lines.push('Do NOT merge the PR. Fix the checks, push, then complete again.')
  return lines.join('\n')
}

