import { describe, it, expect } from 'vitest'
import {
  decideRespawnAction,
  classifyFailType,
  watchdogDecision,
  budgetCeilingForEffort,
  AI_REVIEW_ITERATION_CAP,
} from './state-poller.js'

// ST3 — VERIFIER SIGNAL #1: a low-ceiling objective must auto-escalate (cap-out)
// instead of respawning once cumulative spend crosses the ceiling. The per-spawn
// dollar cap resets every respawn; decideRespawnAction enforces the CUMULATIVE
// ceiling across all respawns. Cap-outs route through escalateCapOut (escalate),
// never another bounce.
describe('decideRespawnAction (cumulative ceiling / cap-out)', () => {
  const findings = 'fix the foo'
  const prev = 'something different'

  it('prod bounce cap is 2 (third round was mostly fail)', () => {
    expect(AI_REVIEW_ITERATION_CAP).toBe(2)
  })

  it('UNDER ceiling, fresh findings, below iteration cap → bounce (respawn)', () => {
    const d = decideRespawnAction({ iteration: 1, iterationCap: 3, spend: 10, ceiling: 75, findings, prevFindings: prev })
    expect(d.action).toBe('bounce')
  })

  it('OVER ceiling → cap-out with reason "budget" (escalate, NOT respawn)', () => {
    const d = decideRespawnAction({ iteration: 1, iterationCap: 3, spend: 80, ceiling: 75, findings, prevFindings: prev })
    expect(d).toEqual({ action: 'cap', reason: 'budget' })
  })

  it('exactly AT ceiling → cap-out (>= is the boundary)', () => {
    const d = decideRespawnAction({ iteration: 1, iterationCap: 3, spend: 75, ceiling: 75, findings, prevFindings: prev })
    expect(d).toEqual({ action: 'cap', reason: 'budget' })
  })

  it('a deliberately LOW ceiling caps out almost immediately (verifier knob)', () => {
    // demonstrates the "low-ceiling test objective auto-escalates instead of spinning" signal
    const d = decideRespawnAction({ iteration: 1, iterationCap: 3, spend: 1.5, ceiling: 1, findings, prevFindings: prev })
    expect(d).toEqual({ action: 'cap', reason: 'budget' })
  })

  it('iteration cap is the backstop and takes precedence', () => {
    const d = decideRespawnAction({ iteration: 2, iterationCap: 2, spend: 0, ceiling: 75, findings, prevFindings: prev })
    expect(d).toEqual({ action: 'cap', reason: 'iteration-cap' })
  })

  it('verbatim-repeated findings → cap-out "no-progress"', () => {
    const d = decideRespawnAction({ iteration: 1, iterationCap: 3, spend: 10, ceiling: 75, findings: 'same text', prevFindings: 'same text' })
    expect(d).toEqual({ action: 'cap', reason: 'no-progress' })
  })

  it('ceiling <= 0 disables the budget arm (fail-safe when spend is unknown)', () => {
    const d = decideRespawnAction({ iteration: 1, iterationCap: 3, spend: 9999, ceiling: 0, findings, prevFindings: prev })
    expect(d.action).toBe('bounce')
  })

  it('budgetCeilingForEffort maps effort tiers and defaults to normal', () => {
    expect(budgetCeilingForEffort('high')).toBeGreaterThan(budgetCeilingForEffort('normal'))
    expect(budgetCeilingForEffort('ultracode')).toBeGreaterThanOrEqual(budgetCeilingForEffort('high'))
    expect(budgetCeilingForEffort(undefined)).toBe(budgetCeilingForEffort('normal'))
    expect(budgetCeilingForEffort('bogus')).toBe(budgetCeilingForEffort('normal'))
  })
})

// obj 714137 — completeness-type iter-1 FAILs must respawn a fresh worker
// instead of bouncing into the exited session for a guaranteed-to-fail iter-2.
// Each findings excerpt below is the ACTUAL (verbatim, truncated) iteration-1
// `objective_reviews.markdown_body` from prod for the objective named, pulled
// from the 2026-10-05 distillation's 5-objective, ~$80 cap-out window — see
// `~/ai-workspace/objective-memory/714137/ARTIFACT.md` for the full replay.
describe('classifyFailType (completeness vs logic) — real cap-out findings', () => {
  it('713954: "zero commits" / working-tree-only edit → completeness', () => {
    const findings =
      '- [FAIL] fields-live: No committed/pushed setup script exists to produce this. ' +
      '`example-crm-infra-wt-713954` has `scripts/setup-bd-workspace.ts` modified only in the ' +
      'working tree (`git status --short` shows `M scripts/setup-bd-workspace.ts`, ' +
      '`?? scripts/bd-segments.ts`) with zero commits on `cto/713954-bd-segments`.'
    expect(classifyFailType(findings)).toBe('completeness')
  })

  it('713962: no ARTIFACT.md / unpushed local-only branches → completeness', () => {
    const findings =
      '- No `ARTIFACT.md` was ever written for this objective.\n' +
      '- No PR opened on either repo — let alone merged.\n' +
      'Both branches are local-only, unpushed ("ahead of origin by N commits", no `origin/feat/...` ref).'
    expect(classifyFailType(findings)).toBe('completeness')
  })

  it('713979: ARTIFACT.md literal "TBD" pending the apply → completeness', () => {
    const findings =
      '- [FAIL] apply-counts-match: ARTIFACT.md section reads literally "TBD — filled after ' +
      'the apply run exits and live Twenty opportunity counts are queried."'
    expect(classifyFailType(findings)).toBe('completeness')
  })

  it('714006: ARTIFACT.md "TBD ... pending apply completion" → completeness', () => {
    const findings =
      '- [FAIL] import-counts: ARTIFACT.md states "TBD — dry-run table + live readback ' +
      'pending apply completion." No dry-run table, no live Twenty readback exists.'
    expect(classifyFailType(findings)).toBe('completeness')
  })

  it('714114: PR still open / checks IN_PROGRESS, not merged → completeness', () => {
    const findings =
      '- [FAIL] flag-merged-deployed: PR #739 is still OPEN, not merged (`gh pr view 739` → ' +
      '"mergeStateStatus":"BLOCKED"), and gate CI checks build, typecheck, unit, migration-drift ' +
      'are still IN_PROGRESS/pending.'
    expect(classifyFailType(findings)).toBe('completeness')
  })

  it('a genuine code/logic defect does NOT classify as completeness', () => {
    const findings =
      '- [FAIL] rate-limit: the retry handler does not back off on a 429 response and busy-loops, ' +
      'exhausting the account in under a minute. Add exponential backoff keyed on retryAfterSeconds.'
    expect(classifyFailType(findings)).toBe('logic')
  })

  it('null/empty findings default to logic (never silently respawn on nothing)', () => {
    expect(classifyFailType(null)).toBe('logic')
    expect(classifyFailType('')).toBe('logic')
  })
})

describe('decideRespawnAction — completeness-type iteration-1 FAIL routes to respawn', () => {
  const completenessFindings = '- [FAIL] evidence: zero commits exist on the branch for this work.'
  const logicFindings = 'fix the off-by-one in the paginator'

  it('iteration 1, completeness-type FAIL → respawn (skips the guaranteed-fail bounce)', () => {
    const d = decideRespawnAction({
      iteration: 1, iterationCap: 2, spend: 5, ceiling: 75,
      findings: completenessFindings, prevFindings: null,
    })
    expect(d).toEqual({ action: 'respawn', reason: 'completeness' })
  })

  it('iteration 1, logic-type FAIL → still bounces (unchanged behavior)', () => {
    const d = decideRespawnAction({
      iteration: 1, iterationCap: 2, spend: 5, ceiling: 75,
      findings: logicFindings, prevFindings: null,
    })
    expect(d).toEqual({ action: 'bounce' })
  })

  it('iteration 2, completeness-type FAIL → the normal iteration-cap still governs (no infinite respawn)', () => {
    const d = decideRespawnAction({
      iteration: 2, iterationCap: 2, spend: 5, ceiling: 75,
      findings: completenessFindings, prevFindings: completenessFindings,
    })
    expect(d).toEqual({ action: 'cap', reason: 'iteration-cap' })
  })

  it('completeness classification never overrides the iteration-cap/budget backstops', () => {
    // iteration already AT the cap — cap-out wins even though findings are completeness-type.
    const d = decideRespawnAction({
      iteration: 3, iterationCap: 2, spend: 5, ceiling: 75,
      findings: completenessFindings, prevFindings: null,
    })
    expect(d).toEqual({ action: 'cap', reason: 'iteration-cap' })
  })
})

// ST3 — VERIFIER SIGNAL #2: a hung/idle worker must be force-routed off
// `working` (→ review) once it crosses the idle OR wall-clock threshold.
describe('watchdogDecision (idle / wall-clock force-route)', () => {
  const idleForceMs = 90 * 60 * 1000   // 90 min
  const wallClockLimitMs = 8 * 60 * 60 * 1000  // 8 h

  it('healthy session (recent activity, young) → no force-route', () => {
    const d = watchdogDecision({ idleMs: 60_000, wallClockMs: 10 * 60_000, idleForceMs, wallClockLimitMs })
    expect(d.forceRoute).toBe(false)
    expect(d.reason).toBeNull()
  })

  it('idle beyond threshold → force-route (reason idle)', () => {
    const d = watchdogDecision({ idleMs: 100 * 60_000, wallClockMs: 2 * 60 * 60_000, idleForceMs, wallClockLimitMs })
    expect(d).toEqual({ forceRoute: true, reason: 'idle' })
  })

  it('wall-clock budget exceeded → force-route (reason wall-clock) even if not idle', () => {
    const d = watchdogDecision({ idleMs: 1_000, wallClockMs: 9 * 60 * 60_000, idleForceMs, wallClockLimitMs })
    expect(d).toEqual({ forceRoute: true, reason: 'wall-clock' })
  })

  it('wall-clock takes precedence over idle when both trip', () => {
    const d = watchdogDecision({ idleMs: 100 * 60_000, wallClockMs: 9 * 60 * 60_000, idleForceMs, wallClockLimitMs })
    expect(d.reason).toBe('wall-clock')
  })

  it('a threshold of <= 0 disables that arm', () => {
    const d = watchdogDecision({ idleMs: 999 * 60_000, wallClockMs: 999 * 60 * 60_000, idleForceMs: 0, wallClockLimitMs: 0 })
    expect(d.forceRoute).toBe(false)
  })
})
