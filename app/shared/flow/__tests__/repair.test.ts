// Card B8 (docs/design/WORKFLOWS.md §5.3): the safe-class classifier, the JSON
// Patch applier, failure signatures and definition rot. Pure tests.
//
// Acceptance: "a patch that edits `goal` or a send node is never auto-applied
// (unit-tested classifier with ≥ 12 cases)". The base document is the §3.5
// example: start → fetch (read tool) → each (loop: classify llm, upsert_one
// write mcp) → upsert (check) → notify (SEND mcp) → done.
import { describe, it, expect } from 'vitest'
import { DAILY_BOOKING_TRIAGE } from './example.js'
import { applyJsonPatch, isJsonPatch, parseJsonPointer } from '../json-patch.js'
import { classifyRepairPatch, flowFailureSignature, isDefinitionRot } from '../repair.js'
import type { FlowDefinition } from '../types.js'

const BASE = DAILY_BOOKING_TRIAGE
const idx = (id: string) => BASE.nodes.findIndex((n) => n.id === id)

function patched(ops: unknown[]): FlowDefinition {
  const r = applyJsonPatch(BASE, ops)
  if (!r.ok) throw new Error(`patch failed: ${r.error}`)
  return r.doc
}

function classify(ops: unknown[]) {
  return classifyRepairPatch(BASE, patched(ops))
}

const codes = (ops: unknown[]) => classify(ops).blockers.map((b) => b.code)

describe('classifyRepairPatch — safe class (may auto-apply)', () => {
  it('1. re-mapping a read tool input is safe', () => {
    const c = classify([{ op: 'replace', path: `/nodes/${idx('fetch')}/input/since`, value: "{{ date_add(now(), -2, 'day') }}" }])
    expect(c.safe).toBe(true)
    expect(c.changes).toEqual([{ where: 'fetch', what: 'input' }])
  })

  it('2. re-mapping a WRITE mcp node arguments is safe (only send/spend need the owner)', () => {
    const c = classify([{ op: 'replace', path: `/nodes/${idx('upsert_one')}/arguments/tag`, value: '{{ steps.classify.output.label }}' }])
    expect(c.safe).toBe(true)
  })

  it('3. a retry / timeout change is safe', () => {
    const c = classify([
      { op: 'replace', path: `/nodes/${idx('fetch')}/retry/max`, value: 5 },
      { op: 'add', path: `/nodes/${idx('fetch')}/timeout_ms`, value: 90_000 },
    ])
    expect(c.safe).toBe(true)
  })

  it('4. an llm prompt and output_schema change is safe', () => {
    const c = classify([
      { op: 'replace', path: `/nodes/${idx('classify')}/prompt`, value: 'Classify: {{ item.b.notes }}' },
      { op: 'add', path: `/nodes/${idx('classify')}/output_schema/properties/confidence`, value: { type: 'number' } },
    ])
    expect(c.safe).toBe(true)
  })

  it('5. a loop.max_items DECREASE is safe', () => {
    expect(classify([{ op: 'replace', path: `/nodes/${idx('each')}/max_items`, value: 50 }]).safe).toBe(true)
  })

  it('6. inserting a new check between two nodes is safe', () => {
    const c = classify([
      { op: 'add', path: '/nodes/-', value: { id: 'has_bookings', kind: 'check', assert: [{ expr: 'len(steps.fetch.output.bookings) >= 0' }], next: 'each' } },
      { op: 'replace', path: `/nodes/${idx('fetch')}/next`, value: 'has_bookings' },
    ])
    expect(c.safe).toBe(true)
    expect(c.changes.map((x) => x.what)).toContain('added a check')
  })

  it('7. inserting a read-only tool node that reuses an existing Tool is safe', () => {
    const c = classify([
      { op: 'add', path: '/nodes/-', value: { id: 'refetch', kind: 'tool', tool: 'calendar-bookings-list', effect: 'read', input: {}, next: 'each' } },
      { op: 'replace', path: `/nodes/${idx('fetch')}/next`, value: 'refetch' },
    ])
    expect(c.safe).toBe(true)
  })

  it('8. lowering a budget is safe', () => {
    expect(classify([{ op: 'replace', path: '/budget/run_usd', value: 0.25 }]).safe).toBe(true)
  })

  it('a branch condition change is safe', () => {
    const base: FlowDefinition = {
      ...BASE,
      nodes: [
        { id: 'start', kind: 'trigger', on: 'manual', next: 'pick' },
        { id: 'pick', kind: 'branch', cases: [{ when: 'trigger.payload.n > 1', then: ['big'] }], default: 'small', next: 'done' },
        { id: 'big', kind: 'check', assert: [{ expr: 'true' }] },
        { id: 'small', kind: 'check', assert: [{ expr: 'true' }] },
        { id: 'done', kind: 'end' },
      ],
    }
    const r = applyJsonPatch(base, [{ op: 'replace', path: '/nodes/1/cases/0/when', value: 'trigger.payload.n > 2' }])
    expect(r.ok && classifyRepairPatch(base, r.doc).safe).toBe(true)
  })

  it('a no-op patch is not "safe" (nothing to apply)', () => {
    const c = classify([{ op: 'test', path: '/id', value: BASE.id }])
    expect(c.safe).toBe(false)
    expect(c.blockers).toEqual([])
  })
})

describe('classifyRepairPatch — never auto-applied', () => {
  it('9. editing goal.statement', () => {
    expect(codes([{ op: 'replace', path: '/goal/statement', value: 'Something easier.' }])).toContain('goal_changed')
  })

  it('10. weakening an end-condition assert', () => {
    expect(codes([{ op: 'replace', path: '/goal/end_condition/assert/0/expr', value: 'true' }])).toContain('goal_changed')
  })

  it('11. dropping the goal judge', () => {
    expect(codes([{ op: 'remove', path: '/goal/end_condition/judge' }])).toContain('goal_changed')
  })

  it('12. changing a send node\'s arguments', () => {
    const c = classify([{ op: 'replace', path: `/nodes/${idx('notify')}/arguments/channel`, value: '#everyone' }])
    expect(c.safe).toBe(false)
    expect(c.blockers.map((b) => b.code)).toEqual(['send_spend_node_changed'])
  })

  it('13. changing only a send node\'s retry (still a send node)', () => {
    expect(codes([{ op: 'add', path: `/nodes/${idx('notify')}/retry`, value: { max: 5, backoff: 'fixed', delay_ms: 1000 } }]))
      .toContain('send_spend_node_changed')
  })

  it('14. downgrading a send node to read to sneak past the gate', () => {
    expect(codes([{ op: 'replace', path: `/nodes/${idx('notify')}/effect`, value: 'read' }])).toContain('send_spend_node_changed')
  })

  it('15. removing a send node', () => {
    expect(codes([
      { op: 'replace', path: `/nodes/${idx('upsert')}/next`, value: 'done' },
      { op: 'remove', path: `/nodes/${idx('notify')}` },
    ])).toContain('send_spend_node_changed')
  })

  it('16. adding a send node', () => {
    expect(codes([
      { op: 'add', path: '/nodes/-', value: { id: 'ping', kind: 'mcp', connector: 'slack', tool: 'post_message', effect: 'send', arguments: {}, next: 'done' } },
      { op: 'replace', path: `/nodes/${idx('notify')}/next`, value: 'ping' },
    ])).toContain('node_added_not_safe')
  })

  it('17. adding a tool node with no declared effect (unknown ⇒ send)', () => {
    expect(codes([
      { op: 'add', path: '/nodes/-', value: { id: 'peek', kind: 'tool', tool: 'calendar-bookings-list', next: 'each' } },
      { op: 'replace', path: `/nodes/${idx('fetch')}/next`, value: 'peek' },
    ])).toContain('node_added_not_safe')
  })

  it('18. adding a read node on a Tool the flow never used', () => {
    expect(codes([
      { op: 'add', path: '/nodes/-', value: { id: 'peek', kind: 'tool', tool: 'some-new-tool', effect: 'read', next: 'each' } },
      { op: 'replace', path: `/nodes/${idx('fetch')}/next`, value: 'peek' },
    ])).toContain('new_tool')
  })

  it('19. adding a read mcp node on a connector the flow never used', () => {
    expect(codes([
      { op: 'add', path: '/nodes/-', value: { id: 'peek', kind: 'mcp', connector: 'hubspot', tool: 'get', effect: 'read', next: 'each' } },
      { op: 'replace', path: `/nodes/${idx('fetch')}/next`, value: 'peek' },
    ])).toContain('new_connector')
  })

  it('20. an added "read" node whose registry effect is send', () => {
    const after = patched([
      { op: 'add', path: '/nodes/-', value: { id: 'peek', kind: 'tool', tool: 'calendar-bookings-list', effect: 'read', next: 'each' } },
      { op: 'replace', path: `/nodes/${idx('fetch')}/next`, value: 'peek' },
    ])
    const c = classifyRepairPatch(BASE, after, { toolEffect: () => 'send' })
    expect(c.blockers.map((b) => b.code)).toContain('node_added_not_safe')
  })

  it('21. raising budget.run_usd / repair_usd, or removing a budget', () => {
    expect(codes([{ op: 'replace', path: '/budget/run_usd', value: 5 }])).toContain('budget_raised')
    expect(codes([{ op: 'replace', path: '/budget/repair_usd', value: 20 }])).toContain('budget_raised')
    expect(codes([{ op: 'remove', path: '/budget/repairs_per_day' }])).toContain('budget_raised')
  })

  it('22. raising loop.max_items', () => {
    expect(codes([{ op: 'replace', path: `/nodes/${idx('each')}/max_items`, value: 500 }])).toContain('loop_max_items_raised')
  })

  it('23. touching approvals, workspace or the trigger', () => {
    expect(codes([{ op: 'replace', path: '/approvals/nodes', value: [] }])).toContain('approvals_changed')
    expect(codes([{ op: 'replace', path: '/workspace', value: 'other' }])).toContain('workspace_changed')
    expect(codes([{ op: 'replace', path: '/nodes/0/schedule/cron', value: '* * * * *' }])).toContain('trigger_changed')
  })

  it('24. editing an existing check (weakening a guard rail)', () => {
    expect(codes([{ op: 'replace', path: `/nodes/${idx('upsert')}/assert/0/expr`, value: 'true' }])).toContain('check_changed')
    expect(codes([{ op: 'replace', path: `/nodes/${idx('upsert')}/on_fail`, value: 'continue' }])).toContain('check_changed')
  })

  it('25. switching a node to another Tool / connector', () => {
    expect(codes([{ op: 'replace', path: `/nodes/${idx('fetch')}/tool`, value: 'other-list' }])).toContain('tool_changed')
    expect(codes([{ op: 'replace', path: `/nodes/${idx('upsert_one')}/connector`, value: 'other-crm' }])).toContain('connector_changed')
  })

  it('26. re-wiring that skips a node instead of inserting one', () => {
    expect(codes([{ op: 'replace', path: `/nodes/${idx('fetch')}/next`, value: 'upsert' }])).toContain('rewire_not_insertion')
  })

  it('27. editing mocks, fixtures, an llm model or an agent node', () => {
    expect(codes([{ op: 'replace', path: `/nodes/${idx('fetch')}/mock/output`, value: { bookings: [] } }])).toContain('field_not_safe')
    expect(codes([{ op: 'add', path: '/fixtures', value: [{ name: 'x', payload: {} }] }])).toContain('document_field_changed')
    expect(codes([{ op: 'replace', path: `/nodes/${idx('classify')}/model`, value: 'opus' }])).toContain('field_not_safe')
    const withAgent: FlowDefinition = { ...BASE, nodes: [...BASE.nodes.slice(0, -1), { id: 'help', kind: 'agent', brief: 'x', budget_usd: 1, next: 'done' }, BASE.nodes[BASE.nodes.length - 1]] }
    const r = applyJsonPatch(withAgent, [{ op: 'replace', path: `/nodes/${withAgent.nodes.length - 2}/brief`, value: 'y' }])
    expect(r.ok && classifyRepairPatch(withAgent, r.doc).blockers.map((b) => b.code)).toContain('send_spend_node_changed')
  })

  it('29. an added "read" mcp node on a connector/tool only a SEND node uses (a disguised send)', () => {
    expect(codes([
      { op: 'add', path: '/nodes/-', value: { id: 'ping', kind: 'mcp', connector: 'slack', tool: 'post_message', effect: 'read', arguments: { text: 'hi' }, next: 'notify' } },
      { op: 'replace', path: `/nodes/${idx('upsert')}/next`, value: 'ping' },
    ])).toContain('node_added_not_safe')
  })

  it('30. an added "read" tool node whose registry metadata is missing (unknown ⇒ send)', () => {
    const after = patched([
      { op: 'add', path: '/nodes/-', value: { id: 'refetch', kind: 'tool', tool: 'calendar-bookings-list', effect: 'read', next: 'each' } },
      { op: 'replace', path: `/nodes/${idx('fetch')}/next`, value: 'refetch' },
    ])
    expect(classifyRepairPatch(BASE, after, { toolEffect: () => 'send' }).safe).toBe(false)
    expect(classifyRepairPatch(BASE, after, { toolEffect: () => 'read' }).safe).toBe(true)
  })

  it('31. re-mapping a node declared read whose Tool is send in the registry', () => {
    const after = patched([{ op: 'replace', path: `/nodes/${idx('fetch')}/input/since`, value: 'x' }])
    expect(classifyRepairPatch(BASE, after, { toolEffect: () => 'send' }).blockers.map((b) => b.code)).toContain('send_spend_node_changed')
  })

  it('32. a branch condition that decides whether a send node runs', () => {
    const base: FlowDefinition = {
      ...BASE,
      nodes: [
        { id: 'start', kind: 'trigger', on: 'manual', next: 'pick' },
        { id: 'pick', kind: 'branch', cases: [{ when: 'trigger.payload.n > 1', then: ['mail'] }], next: 'done' },
        { id: 'mail', kind: 'tool', tool: 'mailer', effect: 'send', input: {} },
        { id: 'done', kind: 'end' },
      ],
    }
    const r = applyJsonPatch(base, [{ op: 'replace', path: '/nodes/1/cases/0/when', value: 'true' }])
    expect(r.ok && classifyRepairPatch(base, r.doc).blockers.map((b) => b.code)).toContain('send_route_changed')
  })

  it('28. a safe change bundled with a goal edit is still refused as a whole', () => {
    const c = classify([
      { op: 'replace', path: `/nodes/${idx('fetch')}/input/since`, value: 'x' },
      { op: 'replace', path: '/goal/end_condition/assert/1/expr', value: 'true' },
    ])
    expect(c.safe).toBe(false)
    expect(c.changes.length).toBe(1)
    expect(c.blockers.map((b) => b.code)).toEqual(['goal_changed'])
  })
})

describe('applyJsonPatch', () => {
  it('applies add / replace / remove / move / copy / test immutably', () => {
    const doc = { a: { b: 1 }, list: [1, 2, 3], 'x/y': 0, 't~': 1 }
    const r = applyJsonPatch(doc, [
      { op: 'test', path: '/a/b', value: 1 },
      { op: 'replace', path: '/a/b', value: 2 },
      { op: 'add', path: '/list/-', value: 4 },
      { op: 'add', path: '/list/0', value: 0 },
      { op: 'remove', path: '/list/1' },
      { op: 'copy', from: '/a', path: '/c' },
      { op: 'move', from: '/x~1y', path: '/moved' },
      { op: 'replace', path: '/t~0', value: 2 },
    ])
    expect(r).toEqual({ ok: true, doc: { a: { b: 2 }, list: [0, 2, 3, 4], c: { b: 2 }, moved: 0, 't~': 2 } })
    expect(doc).toEqual({ a: { b: 1 }, list: [1, 2, 3], 'x/y': 0, 't~': 1 })
  })

  it('is all-or-nothing and names the failing op', () => {
    const r = applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/a', value: 2 }, { op: 'replace', path: '/missing', value: 1 }])
    expect(r).toEqual({ ok: false, index: 1, error: 'replace /missing: path does not exist' })
    expect(applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }]).ok).toBe(false)
    expect(applyJsonPatch({ list: [1] }, [{ op: 'add', path: '/list/5', value: 1 }]).ok).toBe(false)
    expect(applyJsonPatch({}, [{ op: 'add', path: '/__proto__', value: { polluted: true } }]).ok).toBe(false)
    expect(applyJsonPatch({}, []).ok).toBe(false)
    expect(applyJsonPatch({}, [{ op: 'nope', path: '/a' }]).ok).toBe(false)
  })

  it('shape checks', () => {
    expect(isJsonPatch([{ op: 'remove', path: '/a' }])).toBe(true)
    expect(isJsonPatch([{ op: 'add', path: 'a', value: 1 }])).toBe(false)
    expect(isJsonPatch({ op: 'add' })).toBe(false)
    expect(parseJsonPointer('/a~1b/~0c')).toEqual(['a/b', '~c'])
  })
})

describe('failure signature + definition rot', () => {
  it('signature = node id + error type', () => {
    expect(flowFailureSignature({ node_id: 'tally', type: 'tool_error', title: 'x' })).toBe('tally:tool_error')
    expect(flowFailureSignature({ type: 'goal_not_met' })).toBe('-:goal_not_met')
    expect(flowFailureSignature(null)).toBe('-:error')
  })

  it('127 / ENOENT is definition rot; an ordinary failure is not', () => {
    expect(isDefinitionRot({ type: 'tool_error', title: 'spawn /opt/run.sh ENOENT' })).toBe(true)
    expect(isDefinitionRot({ type: 'tool_error', title: 'script failed', detail: 'process exited with code 127' })).toBe(true)
    expect(isDefinitionRot({ type: 'tool_error', title: 'bash: run.sh: command not found' })).toBe(true)
    expect(isDefinitionRot({ type: 'tool_error', title: 'x', exit_code: 127 })).toBe(true)
    expect(isDefinitionRot({ type: 'tool_error', title: 'x', code: 'ENOENT' })).toBe(true)
    expect(isDefinitionRot({ type: 'tool_error', title: 'HTTP 503 from upstream' })).toBe(false)
    expect(isDefinitionRot({ type: 'tool_error', title: 'exit code 1' })).toBe(false)
    expect(isDefinitionRot(null)).toBe(false)
  })
})
