// The okflow/1 → Mermaid renderer lives in app/shared/flow (pure, no deps). Its
// output is snapshot-tested there; this test proves the client's real Mermaid
// parser (already a client dependency) accepts that output.
import { describe, it, expect } from 'vitest'
import mermaid from 'mermaid'
import { definitionToMermaid } from '../../../shared/flow/index'
import { DAILY_BOOKING_TRIAGE } from '../../../shared/flow/__tests__/example'
import { KITCHEN_SINK } from '../../../shared/flow/__tests__/kitchen-sink'

describe('definitionToMermaid output parses with mermaid', () => {
  it.each([
    ['§3.5 example', definitionToMermaid(DAILY_BOOKING_TRIAGE)],
    ['§3.5 example with a run overlay', definitionToMermaid(DAILY_BOOKING_TRIAGE, { status: { start: 'succeeded', each: 'running', upsert: 'failed', notify: 'skipped' } })],
    ['kitchen sink (every node kind, nested loop, branch, keyword ids)', definitionToMermaid(KITCHEN_SINK)],
  ])('%s', async (_name, src) => {
    await expect(mermaid.parse(src)).resolves.toBeTruthy()
  })

  it("the parser is not vacuous: a bare keyword node id (why ids get an n_ prefix) is rejected", async () => {
    await expect(mermaid.parse("flowchart TD\n  a --> end")).rejects.toThrow()
  })
})
