import { describe, it, expect } from 'vitest'
import { echoLandedInSegments } from './followup-echo'

describe('echoLandedInSegments', () => {
  it('is false until a matching divider exists', () => {
    expect(echoLandedInSegments([], 'hello')).toBe(false)
    expect(echoLandedInSegments([{ type: 'summary', text: 'hello' }], 'hello')).toBe(false)
    expect(echoLandedInSegments([{ type: 'divider', text: 'other' }], 'hello')).toBe(false)
  })

  it('is true when the follow-up divider matches (or starts with) the echo', () => {
    expect(echoLandedInSegments([{ type: 'divider', text: 'hello' }], 'hello')).toBe(true)
    expect(echoLandedInSegments(
      [{ type: 'divider', text: 'hello\n\nAttached files (accessible on disk):\n- /tmp/x' }],
      'hello',
    )).toBe(true)
  })
})
