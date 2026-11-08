/**
 * Truthful terminal outcomes (obj 900322, constraint C3 / go-no-go G11).
 *
 * ## The lie
 *
 * `getSessionState` returns `'dead'` for a transcript with no `type:"result"`
 * event (session-control.ts). The poller's `dead` branch routes that straight to
 * `review` — it never reaches `classifyNoOpSpawn` or `readStartupFailure`, which
 * are wired only under the `working → review` TRANSITION branch. So the three
 * shapes that mean "this session produced nothing":
 *
 *   - the wrapper died before the agent started (`type:"error"`,
 *     `subtype:"startup_failure"` — and `jsonlHasResult` does not match `error`,
 *     so it lands in `dead`);
 *   - the process exited before any model turn (no events at all);
 *   - the agent refused and emitted no tool call and no answer;
 *
 * all arrive on the card as an unexplained `review`, with no verdict, no reason
 * and no activity row. `session_intel.outcome='failed'` / "Session produced no
 * output" IS computed, and no status path reads it.
 *
 * ## The shape of the fix
 *
 * {@link classifyTerminalOutcome} is a pure function over what the transcript
 * actually contains. {@link applyTruthfulOutcome} writes the result using the
 * project's EXISTING blocked convention — `status='review'`,
 * `ai_review_verdict='blocked'`, `ai_review_findings=<specific reason>`,
 * `has_blockers=1`, plus an `activity_log` `error` row — rather than inventing a
 * new status. (`ObjectiveStatus` has no `'blocked'` member; the convention is
 * what the obj-840 and obj-900038 block paths already use, and the board renders
 * it as blocked.) Reusing it is deliberate: this objective is wiring, not a new
 * lifecycle.
 *
 * Nothing here guesses. If the transcript shows real work, the classifier says
 * `produced-output` and the caller's existing routing runs untouched.
 */
import type { Database } from 'better-sqlite3'
import {
  describeStartupFailure,
  type StartupFailure,
} from './session-startup-failure.js'

export type TerminalOutcomeKind =
  /** The session did real work — route it normally. */
  | 'produced-output'
  /** The wrapper died before the agent ever ran. */
  | 'startup-failed'
  /** The process ran but emitted nothing at all. */
  | 'no-output'
  /** The agent answered/refused with zero tool calls and zero file changes. */
  | 'refused'
  /** The run was stopped by its configured budget. */
  | 'ceiling-stopped'

export interface TerminalOutcome {
  kind: TerminalOutcomeKind
  /** True when the card must be visibly blocked rather than silently reviewed. */
  blocked: boolean
  /** Specific, human-readable. Non-null for every blocked outcome. */
  reason: string | null
  /** Short machine tag for `activity_log.metadata.kind` and tests. */
  code: string
}

export interface TerminalSignals {
  /** The transcript carried a `type:"result"` event. */
  hasResult: boolean
  toolCalls: number
  filesCreated: number
  filesModified: number
  /** Non-null when the wrapper reported a pre-agent failure. */
  startupFailure?: StartupFailure | null
  /** The terminal turn was a clean, non-empty assistant answer. */
  completedWithAnswer?: boolean
  /** Text of the terminal refusal, when the agent declined the work. */
  refusalText?: string | null
  /** Set when the runner stopped this job at its configured ceiling. */
  ceilingReason?: string | null
}

const PRODUCED: TerminalOutcome = {
  kind: 'produced-output',
  blocked: false,
  reason: null,
  code: 'produced_output',
}

/**
 * Classify what a finished session actually produced.
 *
 * Order matters and is not arbitrary:
 *  1. a ceiling stop is the runner's own decision and outranks transcript shape;
 *  2. a startup failure outranks "no output" — the session did not produce
 *     nothing, it never ran, and re-spawning reproduces the fault exactly
 *     (obj 900038 learned this the expensive way: one bad mount, six dead cards);
 *  3. a refusal is distinguished from silence, because the two need different
 *     human responses — a refusal is a brief problem, silence is an infra problem;
 *  4. only then, genuine no-output.
 */
export function classifyTerminalOutcome(signals: TerminalSignals): TerminalOutcome {
  if (signals.ceilingReason) {
    return {
      kind: 'ceiling-stopped',
      blocked: true,
      code: 'job_ceiling_stopped',
      reason: signals.ceilingReason,
    }
  }

  if (signals.startupFailure) {
    return {
      kind: 'startup-failed',
      blocked: true,
      code: 'session_startup_failed',
      reason: describeStartupFailure(signals.startupFailure),
    }
  }

  const touchedNothing =
    signals.toolCalls === 0 && signals.filesCreated === 0 && signals.filesModified === 0

  if (touchedNothing && signals.refusalText) {
    return {
      kind: 'refused',
      blocked: true,
      code: 'session_refused',
      reason:
        'The agent refused the work and produced no tool call and no file change. ' +
        'This is a brief/permissions problem, not a deliverable — it is blocked for a human, ' +
        `never auto-completed.\n--- refusal ---\n${signals.refusalText.slice(0, 1200)}`,
    }
  }

  if (touchedNothing && !signals.completedWithAnswer) {
    const detail = signals.hasResult
      ? 'the session reached a result event but executed no tool call and changed no file'
      : 'the session ended with no result event at all — the process exited before completing a turn'
    return {
      kind: 'no-output',
      blocked: true,
      code: 'session_no_output',
      reason:
        `Session produced no output: ${detail}. ` +
        'Nothing was delivered, so the card is blocked with this reason rather than ' +
        'routed to review or marked done.',
    }
  }

  return PRODUCED
}

/**
 * Persist a blocked terminal outcome onto the card, truthfully and visibly.
 *
 * Idempotent on `(objective, session, code)`: the poller re-selects a card every
 * 3s tick, so a second pass must not append a second activity row or re-broadcast
 * an unchanged card. Returns false when this exact outcome was already recorded.
 *
 * Never throws — a logging failure must not wedge the poll tick.
 */
export function applyTruthfulOutcome(
  db: Database,
  objective: {
    id: number
    project?: string | null
    workspace?: string | null
    session_id?: string | null
  },
  outcome: TerminalOutcome,
): boolean {
  if (!outcome.blocked || !outcome.reason) return false

  // Already recorded this exact outcome for this exact session → no-op.
  try {
    const dup = db
      .prepare(
        `SELECT 1 FROM activity_log
          WHERE objective_id = ? AND title = ? AND IFNULL(session_id,'') = IFNULL(?,'')
          LIMIT 1`,
      )
      .get(objective.id, outcome.code, objective.session_id ?? null)
    if (dup) return false
  } catch { /* activity_log unreadable → fall through and still write status */ }

  try {
    db.prepare(
      `UPDATE objectives
          SET status = 'review',
              ai_review_verdict = 'blocked',
              ai_review_findings = ?,
              has_blockers = 1,
              updated_at = datetime('now')
        WHERE id = ?`,
    ).run(outcome.reason, objective.id)
  } catch (err) {
    console.error(`[session-outcome] failed to write blocked outcome for obj ${objective.id}:`, err)
    return false
  }

  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail, metadata)
       VALUES (?, ?, ?, ?, 'error', ?, ?, ?)`,
    ).run(
      objective.project || 'unknown',
      objective.workspace,
      objective.id,
      objective.session_id ?? null,
      outcome.code,
      outcome.reason,
      JSON.stringify({ kind: outcome.code, outcome: outcome.kind }),
    )
  } catch (err) {
    console.warn(`[session-outcome] activity_log write failed for obj ${objective.id}:`, (err as Error).message)
  }

  // Make the already-correct intel signal agree with the card, so the two
  // surfaces can never tell a reader different stories (C3: the signal existed
  // and nothing read it).
  if (objective.session_id) {
    try {
      db.prepare(
        "UPDATE session_intel SET outcome = 'failed' WHERE session_id = ? AND (outcome IS NULL OR outcome = 'success')",
      ).run(objective.session_id)
    } catch { /* table may not exist in a minimal test DB */ }
  }

  return true
}

/**
 * Does this terminal answer read as a REFUSAL rather than a deliverable?
 *
 * Narrow and conservative on purpose. It runs only on sessions that already
 * made zero tool calls and zero file changes, so the only question left is
 * "did the model decline, or did it answer a question?" — a genuine answer-only
 * card is legitimate and must keep working. Returns the matched text (so the
 * card can quote it) or null.
 *
 * Matching is phrase-anchored, not keyword-anchored: "I can't" inside a long
 * delivered analysis is ordinary prose, whereas a refusal is short and leads
 * with the decline. Hence the length bound AND the leading-position check.
 */
export function detectRefusal(finalText: string): string | null {
  const text = (finalText || '').trim()
  if (!text) return null
  // A long answer is a deliverable, not a refusal.
  if (text.length > 2000) return null
  const head = text.slice(0, 400).toLowerCase()
  const patterns = [
    /\bi (?:can(?:no|'?)t|am unable to|won'?t) (?:help|assist|complete|do|proceed|continue)/,
    /\bi'?m (?:not able|unable) to\b/,
    /\bi (?:must|have to) (?:decline|refuse)\b/,
    /\b(?:this|that) (?:request|task) (?:is outside|falls outside|is not something)\b/,
    /\bi (?:don'?t|do not) have (?:the )?(?:access|permission|credentials)\b/,
    /\bscope-split needed\b/,
  ]
  for (const re of patterns) {
    const m = head.match(re)
    if (m && m.index !== undefined && m.index < 200) return text.slice(0, 1200)
  }
  return null
}
