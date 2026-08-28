import { describe, it, expect } from 'vitest'
import { decideRespawnAction, watchdogDecision, budgetCeilingForEffort, AI_REVIEW_ITERATION_CAP } from './state-poller.js'

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
