import { describe, it, expect } from 'vitest'
import { buildLiveProgressBlock, CC_LIVE_SCRIPT } from './prompt-builder.js'

// obj 715699 — the worker prompt tells sessions how to keep their card readable
// mid-run: progress snapshots, live/ partial outputs, and the fan-out helper.
describe('buildLiveProgressBlock', () => {
  const block = buildLiveProgressBlock(4242, '/mem/4242').join('\n')

  it('gives the exact progress command with the objective id filled in', () => {
    expect(block).toContain(`node ${CC_LIVE_SCRIPT} progress 4242 --step`)
    expect(block).toContain('GET /api/objectives/4242/progress')
  })

  it('points partial outputs at live/ and documents fan-out + children roll-up', () => {
    expect(block).toContain('/mem/4242/live/')
    expect(block).toContain(`node ${CC_LIVE_SCRIPT} fanout 4242`)
    expect(block).toContain(`node ${CC_LIVE_SCRIPT} children 4242`)
  })

  it('never names the scratch file (the reviewer mask invariant extends to anything echoed)', () => {
    expect(block).not.toMatch(/NOTES\.md/)
  })
})
