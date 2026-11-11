// ── Daily Session Retrospective (DSR) — PURE detection primitives ────────────
//
// Spec: ~/second-brain/workspaces/operator/decisions/
//       2026-08-08-cc-daily-session-retrospective-loop-design.md  (§C.2, §D.1)
//
// Everything in this file is PURE and side-effect free: no DB handle, no fs, no
// clock, no network. It is the unit-test surface for the detector, so a change
// to the taxonomy is provable without a board, a transcript, or an LLM.
//
// The single most important CC-specific adaptation (audit finding A.6-a): the
// human-correction channel on Command Center transcripts is the first-class
// `type:"followup"` event, NOT `role:"user"` text. On CC, `type:"user"` text is
// the session's own sub-agent prompts, so porting the cattle scanner's
// role:"user" detector unchanged would be a near-100%-false-positive detector.
// classifyFollowup() is therefore the gate every D1 signal passes through.

import { createHash } from 'crypto'

// ── Signal taxonomy (§C.2) ───────────────────────────────────────────────────

export type SignalType =
  | 'human_correction'      // D1
  | 'agent_self_correction' // D2
  | 'tool_error'            // D3
  | 'review_failure'        // D4
  | 'iterate_loop'          // D5
  | 'escalation'            // D6
  | 'max_turns_truncation'  // D7

/** Base confidence per signal type, straight from the §C.2 table. */
export const BASE_CONFIDENCE: Record<SignalType, number> = {
  human_correction: 0.70,
  agent_self_correction: 0.55,
  tool_error: 0.35,
  review_failure: 0.75,
  iterate_loop: 0.60,
  escalation: 0.50,
  max_turns_truncation: 0.25,
}

/** Global confidence floor (settings `dsr_min_confidence`, env CC_DSR_MIN_CONFIDENCE). */
export const DEFAULT_MIN_CONFIDENCE = 0.60

// ── Followup classification (§C.2 AUTO patterns) ─────────────────────────────

/**
 * A followup matching ANY of these is machine-generated and is NOT a D1
 * human_correction. Measured on 2026-08-07 these accounted for 169/580
 * followups. The classifier MUST be kept in sync — `runDailyRetro` counts
 * unclassified followups per run (dsr_runs.unclassified_followups) so a new
 * automated prefix shows up as a spike instead of silently becoming a false
 * "human correction" (open risk D.6-1).
 */
export const AUTO_FOLLOWUP_PATTERNS: RegExp[] = [
  /^\[child-complete\]/,
  /^## AI Review Findings/,
  /^AUTO-RESUME:/,
  /^\[oracle\]/i,
  /deterministic floor|floor gate/i,
  /reached maximum number of turns/i,
  /^\[auto\]|^\[system\]|^\[watchdog\]|^\[pr-health\]/i,
]

/**
 * Corrective phrasing that promotes a human followup to a D1 candidate. A
 * human followup WITHOUT corrective phrasing is a plain instruction ("also add
 * X"), not a correction, and is not a defect signal.
 */
// DEVIATION FROM SPEC §C.2, deliberate: the spec writes this alternation with a
// trailing `\b`, which can NEVER match the two alternatives that end in
// punctuation — `actually,` and `correction:` — because \b requires a word
// boundary and both are followed by whitespace. Shipping it verbatim would
// silently dead-code two of the ten corrective phrasings. The trailing
// assertion is therefore `(?![A-Za-z0-9_])`, which is identical to \b after a
// word character (so `reverted` still does not match `revert`) and correctly
// permissive after punctuation.
export const CORRECTIVE_PHRASING =
  /\b(that'?s (wrong|not right)|you (forgot|missed|didn'?t)|make sure you|actually,|no,? (it'?s|its)|instead of|should have|correction:|revert|undo)(?![A-Za-z0-9_])/i

/** Completion claim in the preceding assistant turn — a D1 booster. */
export const COMPLETION_CLAIM = /\b(done|complete|finished|shipped|all set)\b/i

/** Agent self-correction phrasing (D2). */
export const SELF_CORRECTION_PHRASING =
  /\b(I (forgot|should have|was wrong|mis(read|understood))|my mistake|correcting myself|that was incorrect)\b/i

export type FollowupClass = 'auto' | 'human' | 'empty'

/**
 * Classify a transcript `type:"followup"` payload as machine-generated ('auto')
 * or plausibly human ('human'). Empty/whitespace payloads are 'empty' and are
 * counted separately so they never inflate the unclassified counter.
 *
 * Deliberately conservative in the AUTO direction: a false 'auto' loses one
 * candidate (it resurfaces the next day if the underlying defect persists),
 * while a false 'human' puts machine chatter on the board.
 */
export function classifyFollowup(text: string | null | undefined): FollowupClass {
  const t = (text ?? '').trim()
  if (!t) return 'empty'
  for (const p of AUTO_FOLLOWUP_PATTERNS) {
    if (p.test(t)) return 'auto'
  }
  return 'human'
}

/** True when a human followup carries corrective phrasing (the D1 trigger). */
export function isCorrective(text: string | null | undefined): boolean {
  return CORRECTIVE_PHRASING.test((text ?? '').trim())
}

/** True when an assistant turn contains a completion claim (D1 +0.10 booster). */
export function claimsCompletion(text: string | null | undefined): boolean {
  return COMPLETION_CLAIM.test((text ?? '').trim())
}

/** True when assistant text is an explicit self-correction (the D2 trigger). */
export function isSelfCorrection(text: string | null | undefined): boolean {
  return SELF_CORRECTION_PHRASING.test((text ?? '').trim())
}

/** True when the text names a repo/absolute path or a source file (D1 +0.05). */
export function mentionsPath(text: string | null | undefined): boolean {
  const t = text ?? ''
  return /(^|\s)\/[\w.\-/]+/.test(t) || /\b[\w.\-/]+\.(ts|tsx|js|jsx|py|sql|md|json|sh|css)\b/.test(t)
}

// ── Harness noise (§C.2 D3 penalty) ──────────────────────────────────────────

/**
 * Tool errors that are the harness talking to itself, not a defect.
 *
 * Rationale (spec §C.2): the cattle scanner's first dry-run surfaced 130
 * signals of which 80 were this exact class. `tool_error` starts at the lowest
 * base confidence (0.35) precisely because of this noise profile, and noise
 * takes a further −0.25 — which puts it well below the 0.60 floor unless it is
 * *also* repeating or terminal.
 */
export const HARNESS_NOISE_PATTERNS: RegExp[] = [
  // permission / approval plumbing
  /requested permissions?|permission denied by user|user (rejected|denied|doesn'?t want)/i,
  /tool use was (rejected|blocked)|operation was (aborted|cancelled|canceled)/i,
  // exploratory shell probing — "does this exist?" answered with 127/1
  /exit code 127/i,
  /command not found/i,
  /no such file or directory\s*$/i,
  // interrupted / timed-out harness calls, not product failures
  /the user (interrupted|stopped)/i,
  /request (was )?aborted|abortError/i,
]

/**
 * True when an error payload is harness noise rather than a real defect
 * signal.
 *
 * Refinement over a flat pattern match: `ENOENT`/`no such file` against a
 * *source* file is a real defect (a broken import, a missing fixture), while
 * the same error from an exploratory `ls` is noise. We therefore treat a
 * no-such-file error as noise ONLY when it does not reference a source-looking
 * path.
 */
export function isHarnessNoise(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  if (!t) return true
  const looksLikeSourceFile = /\.(ts|tsx|js|jsx|py|sql|json|css|md|sh)\b/.test(t)
  for (const p of HARNESS_NOISE_PATTERNS) {
    if (!p.test(t)) continue
    // ENOENT on a real source file is a defect, not a probe.
    if (looksLikeSourceFile && /(no such file or directory|ENOENT)/i.test(t)) return false
    return true
  }
  return false
}

// ── Anchor normalization + fingerprint (§C.2) ────────────────────────────────

export const ANCHOR_MAX_LEN = 160

/**
 * Normalize an excerpt into the stable `anchor` half of a fingerprint.
 *
 * Order matters — session ids (`cc-705052-1786…`) are stripped BEFORE the
 * generic digit rule so they collapse to a single `<sid>` token rather than
 * `cc-<num>-<num>`. Absolute paths are deliberately KEPT: they are the most
 * discriminating token in a CC error, and dropping them would collapse
 * unrelated defects onto one fingerprint.
 *
 * The anchor deliberately excludes objective_id and session_id, so the same
 * bug hit by five different workers collapses to ONE candidate whose
 * recurrence count is a booster — instead of five near-identical objectives.
 */
export function normalizeAnchor(text: string | null | undefined): string {
  let s = (text ?? '').toLowerCase()
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
  s = s.replace(/\bcc-(?:review-)?\d+-\d+\b/g, '<sid>')
  s = s.replace(/\btoolu_[a-za-z0-9]+\b/g, '<toolid>')
  s = s.replace(/\b70\d{4}\b/g, '<oid>')
  s = s.replace(/\$\s?\d+(?:[.,]\d+)*/g, '<num>')
  s = s.replace(/\b\d+(?:[.,]\d+)*\b/g, '<num>')
  s = s.replace(/\s+/g, ' ').trim()
  return s.slice(0, ANCHOR_MAX_LEN)
}

/**
 * `fingerprint = sha1(project | signal_type | anchor)` — the dedup identity.
 * Every fingerprint ever PROPOSED is ledgered in `dsr_fingerprints` and never
 * re-proposed; a fingerprint dropped by the per-run cap is NOT ledgered, so it
 * resurfaces on the next run.
 */
export function fingerprint(project: string, signal: SignalType | string, anchor: string): string {
  return createHash('sha1')
    .update(`${project}|${signal}|${normalizeAnchor(anchor)}`)
    .digest('hex')
}

// ── Scoring (§C.2 boosters / penalties) ──────────────────────────────────────

/** Booster/penalty inputs. All optional — absent means "not observed". */
export interface SignalBoosters {
  /** D1: the followup arrived right after an assistant completion claim. */
  afterCompletionClaim?: boolean
  /** D1: the followup names a repo path or file. */
  namesPath?: boolean
  /** D1: source objective is in DSR_CHAT_OBJECTIVES (obj 1432 trap). */
  chatObjective?: boolean
  /** D2: a real Edit/Write followed within 5 turns (rework, not a verbal hedge). */
  followedByEdit?: boolean
  /** D3: the same normalized error repeats >=3x in one session (a stuck loop). */
  repeatedInSession?: boolean
  /** D3: it is the last tool call before session end. */
  lastBeforeEnd?: boolean
  /** D3: classified as harness noise. */
  harnessNoise?: boolean
  /** D4: the failing review ran in browser mode (verified against a running app). */
  browserReview?: boolean
  /** D4: additional failed iterations beyond the first. */
  extraFailedIterations?: number
  /** D5: ai_review_iteration >= 3 (a fix that didn't take). */
  deepIteration?: boolean
  /** D6: the blocker text recurs across >=3 objectives. */
  recurrenceAcrossObjectives?: number
}

/** Clamp to the [0,1] probability range. */
function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/**
 * Deterministic confidence for one signal. No LLM, no randomness — the score
 * must be reproducible from the stored candidate row so the §C.6 tuner can
 * re-derive why something cleared the floor.
 */
export function scoreSignal(signal: SignalType, boosters: SignalBoosters = {}): number {
  let score = BASE_CONFIDENCE[signal] ?? 0
  switch (signal) {
    case 'human_correction':
      if (boosters.afterCompletionClaim) score += 0.10
      if (boosters.namesPath) score += 0.05
      if (boosters.chatObjective) score -= 0.30
      break
    case 'agent_self_correction':
      if (boosters.followedByEdit) score += 0.10
      break
    case 'tool_error':
      if (boosters.repeatedInSession) score += 0.20
      if (boosters.lastBeforeEnd) score += 0.15
      if (boosters.harnessNoise) score -= 0.25
      break
    case 'review_failure':
      if (boosters.browserReview) score += 0.10
      score += 0.05 * Math.max(0, boosters.extraFailedIterations ?? 0)
      break
    case 'iterate_loop':
      if (boosters.deepIteration) score += 0.15
      break
    case 'escalation':
      if ((boosters.recurrenceAcrossObjectives ?? 0) >= 3) score += 0.20
      break
    case 'max_turns_truncation':
      // D7 is informational only: it is recorded, never promoted alone, and no
      // booster may lift it to the floor. Hard-capped below DEFAULT_MIN_CONFIDENCE.
      return Math.min(score, DEFAULT_MIN_CONFIDENCE - 0.01)
  }
  return clamp01(Number(score.toFixed(4)))
}

/**
 * Convenience for D1: classify a followup and score it in one call. Returns
 * null when the followup is not a human correction at all (auto, empty, or
 * non-corrective phrasing) — the A.6-a regression surface.
 */
export function scoreFollowupCorrection(
  text: string | null | undefined,
  boosters: Omit<SignalBoosters, 'namesPath'> & { namesPath?: boolean } = {},
): { signal: 'human_correction'; confidence: number } | null {
  if (classifyFollowup(text) !== 'human') return null
  if (!isCorrective(text)) return null
  return {
    signal: 'human_correction',
    confidence: scoreSignal('human_correction', {
      ...boosters,
      namesPath: boosters.namesPath ?? mentionsPath(text),
    }),
  }
}
