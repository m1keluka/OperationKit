import { describe, it, expect } from 'vitest'
import { isCaptureGap } from './session-intel-pipeline.js'

const NO_VAULT_DOC = [
  '/home/operator/ai-workspace/objective-memory/705188/NOTES.md',
  '/home/operator/projects/example3-platform/scripts/daily_sync.py',
]

describe('isCaptureGap', () => {
  it('does NOT flag a recurring job (routine_id set) even with decisions and no vault doc', () => {
    expect(isCaptureGap(2, 792, NO_VAULT_DOC)).toBe(false)
  })

  it('still flags a NON-routine session that claimed decisions and wrote no vault doc', () => {
    expect(isCaptureGap(3, null, NO_VAULT_DOC)).toBe(true)
    expect(isCaptureGap(3, undefined, NO_VAULT_DOC)).toBe(true)
  })

  it('does not flag when a vault decision doc WAS written', () => {
    expect(isCaptureGap(2, null, [
      ...NO_VAULT_DOC,
      '/home/operator/second-brain/workspaces/example/decisions/2026-08-10-capture-gap-false-positive-storm.md',
    ])).toBe(false)
  })

  it('matches vault docs under personal/ as well as workspaces/<ws>/', () => {
    expect(isCaptureGap(1, null, [
      '/home/operator/second-brain/personal/decisions/2026-08-10-some-choice.md',
    ])).toBe(false)
  })

  it('does not flag when no decisions were extracted, routine or not', () => {
    expect(isCaptureGap(0, null, NO_VAULT_DOC)).toBe(false)
    expect(isCaptureGap(0, 792, NO_VAULT_DOC)).toBe(false)
  })

  it('routine_id of 0 is still a routine (do not use a truthiness check)', () => {
    expect(isCaptureGap(2, 0, NO_VAULT_DOC)).toBe(false)
  })

  it('does not treat a non-decisions second-brain write as a capture', () => {
    expect(isCaptureGap(1, null, [
      '/home/operator/second-brain/workspaces/example/active.md',
      '/home/operator/second-brain/workspaces/example/insights/2026-08-10-note.md',
    ])).toBe(true)
  })
})
