import { describe, it, expect } from 'vitest'
import { previewText } from './sidebar.js'

// obj 900798 — the one-line last-message preview in the Bots sidebar.
describe('previewText', () => {
  it('flattens markdown to one plain line', () => {
    expect(previewText('# Plan\n\n- **ship** the `queue` fix\n- write _notes_\n> quoted')).toBe('Plan ship the queue fix write notes quoted')
    expect(previewText('See [the PR](https://x.test/1) ![shot](a.png)')).toBe('See the PR')
    expect(previewText('Before\n```ts\nconst a = 1\n```\nafter')).toBe('Before [code] after')
  })

  it('keeps characters that are content, not markup', () => {
    expect(previewText('Pricing moved from #9 to #4 for "ai ops"')).toBe('Pricing moved from #9 to #4 for "ai ops"')
    expect(previewText('3 * 4 = 12 and a > b')).toBe('3 * 4 = 12 and a > b')
    expect(previewText('call list_objectives first')).toBe('call list_objectives first')
  })

  it('clips long text with an ellipsis', () => {
    const p = previewText('word '.repeat(100))
    expect(p.length).toBeLessThanOrEqual(140)
    expect(p.endsWith('…')).toBe(true)
  })
})
