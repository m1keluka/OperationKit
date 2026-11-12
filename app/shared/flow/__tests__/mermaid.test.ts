import { describe, it, expect } from 'vitest'
import { definitionToMermaid, mermaidNodeId, validateFlow } from '../index.js'
import { DAILY_BOOKING_TRIAGE, example, node } from './example.js'
import { KITCHEN_SINK } from './kitchen-sink.js'

describe('definitionToMermaid', () => {
  it('renders the §3.5 example (snapshot)', async () => {
    await expect(definitionToMermaid(DAILY_BOOKING_TRIAGE)).toMatchFileSnapshot('./__snapshots__/daily-booking-triage.mmd')
  })

  it('renders a last-run status overlay (snapshot)', async () => {
    const out = definitionToMermaid(DAILY_BOOKING_TRIAGE, {
      status: { start: 'succeeded', fetch: 'mocked', each: 'running', upsert: 'failed', notify: 'skipped', done: 'waiting' },
    })
    await expect(out).toMatchFileSnapshot('./__snapshots__/daily-booking-triage.status.mmd')
  })

  it('renders every node kind, nested loops and escaped labels (snapshot)', async () => {
    expect(validateFlow(KITCHEN_SINK).errors).toEqual([])
    await expect(definitionToMermaid(KITCHEN_SINK)).toMatchFileSnapshot('./__snapshots__/kitchen-sink.mmd')
  })

  it('distinguishes kind, effect and approval state', () => {
    const out = definitionToMermaid(KITCHEN_SINK)
    expect(out).toContain('n_summarise{{"🧠 LLM · summarise') // llm = hexagon
    expect(out).toContain('n_deep_dive[["🤖 agent session → card') // agent = subroutine box
    expect(out).toContain('n_score{"🔀 branch · score"}')
    expect(out).toContain('SPEND · approval each run')
    expect(out).toMatch(/subgraph n_graph \[.*\]\n\s+direction TB\n\s+subgraph n_subgraph/)
    expect(out).toContain('class n_file_report spend')
  })

  it('never emits a bare Mermaid keyword as a node id', () => {
    expect(mermaidNodeId('end')).toBe('n_end')
    expect(definitionToMermaid(KITCHEN_SINK)).not.toMatch(/^\s*end\(/m)
  })

  it('escapes quotes, # and angle brackets in labels', () => {
    const out = definitionToMermaid(KITCHEN_SINK)
    expect(out).toContain('Accounts #34;A–Z#34; #35;1')
    expect(out).not.toMatch(/\["[^\n]*"[^\n]*"\]/) // no raw quote inside a quoted label
  })

  it('marks an unapproved send node', () => {
    const d = example()
    delete d.approvals
    expect(definitionToMermaid(d)).toContain('SEND · NOT APPROVED')
  })

  it('is total on an invalid definition (no throw, no infinite loop)', () => {
    const d = example()
    node(d, 'notify').next = 'fetch' // cycle
    d.nodes.push({ id: 'orphan', kind: 'loop', as: 'x', body: ['ghost'] })
    const out = definitionToMermaid(d)
    expect(out.startsWith('flowchart TD\n')).toBe(true)
    expect(out).toContain('n_orphan["🔁 loop · for each x"]')
  })
})
