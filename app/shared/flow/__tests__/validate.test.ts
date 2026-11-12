import { describe, it, expect } from 'vitest'
import { validateFlow, parseExpression, type FlowErrorCode, type FlowRegistry } from '../index.js'
import { DAILY_BOOKING_TRIAGE, example, node, type Loose } from './example.js'

const codes = (doc: unknown, opts?: Parameters<typeof validateFlow>[1]) =>
  [...new Set(validateFlow(doc, opts).errors.map((e) => e.code))].sort()

describe('validateFlow — the §3.5 example', () => {
  it('validates with no errors and no warnings', () => {
    const r = validateFlow(DAILY_BOOKING_TRIAGE)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('does not mutate its input', () => {
    const doc = example()
    const before = JSON.stringify(doc)
    validateFlow(doc)
    expect(JSON.stringify(doc)).toBe(before)
  })
})

// Each fixture is one targeted edit of the §3.5 example. The assertion is the
// EXACT set of error codes, so every fixture proves a specific code fires and
// nothing else does.
const NEGATIVE: [string, (d: Loose) => unknown, FlowErrorCode[]][] = [
  ['duplicate node id', (d) => { d.nodes.push({ id: 'fetch', kind: 'end' }) }, ['DUPLICATE_NODE_ID']],
  ['two triggers', (d) => { d.nodes.push({ id: 'again', kind: 'trigger', on: 'manual', next: 'fetch' }) }, ['MULTIPLE_TRIGGERS']],
  ['no trigger', (d) => { d.nodes.shift() }, ['NO_TRIGGER']],
  ['trigger not first', (d) => { d.nodes.push(d.nodes.shift()) }, ['TRIGGER_NOT_FIRST']],
  ['dangling edge (loop body names a missing node)', (d) => { node(d, 'each').body.push('ghost') }, ['DANGLING_EDGE']],
  ['dangling reference (steps.ghost)', (d) => { node(d, 'notify').arguments.text = '{{ steps.ghost.output }}' }, ['DANGLING_REFERENCE']],
  ['cycle outside a loop (branch jumps back to fetch)', (d) => {
    node(d, 'upsert').next = 'retry_gate'
    d.nodes.push({ id: 'retry_gate', kind: 'branch', cases: [{ when: "steps.upsert.status == 'failed'", then: ['fetch'] }], next: 'notify' })
  }, ['CYCLE']],
  ['cycle back to the trigger', (d) => { node(d, 'upsert').next = 'start' }, ['CYCLE', 'TRIGGER_HAS_INCOMING', 'UNREACHABLE_NODE']],
  ['missing loop.max_items', (d) => { delete node(d, 'each').max_items }, ['LOOP_MAX_ITEMS_MISSING']],
  ['loop.concurrency > 4', (d) => { node(d, 'each').concurrency = 5 }, ['LOOP_CONCURRENCY_EXCEEDED']],
  ['llm.max_iterations > 8', (d) => { node(d, 'classify').max_iterations = 9 }, ['LLM_MAX_ITERATIONS_EXCEEDED']],
  ['{{ secrets.X }} in arguments', (d) => { node(d, 'notify').arguments.token = '{{ secrets.SLACK_TOKEN }}' }, ['SECRET_REFERENCE']],
  ['{{secrets.X}} hidden in a mock fixture', (d) => { node(d, 'fetch').mock.output.key = '{{secrets.X}}' }, ['SECRET_REFERENCE']],
  ['secrets.X in a bare assert', (d) => { d.goal.end_condition.assert[0].expr = "secrets.API_KEY != ''" }, ['SECRET_REFERENCE']],
  ['judge-only goal', (d) => { d.goal.end_condition.assert = [] }, ['GOAL_NO_DETERMINISTIC_ASSERT']],
  ['missing goal', (d) => { delete d.goal }, ['GOAL_MISSING']],
  ['unapproved send node', (d) => { d.approvals.nodes = [] }, ['UNAPPROVED_EFFECT']],
  ['approvals recorded for an older version', (d) => { d.version = 4 }, ['UNAPPROVED_EFFECT']],
  ['approval by an agent, not the owner', (d) => { d.approvals.by = 'agent:900637' }, ['APPROVAL_INVALID_APPROVER', 'UNAPPROVED_EFFECT']],
  ['approval names a missing node', (d) => { d.approvals.nodes.push('ghost') }, ['APPROVAL_UNKNOWN_NODE']],
  ['tool with no declared effect defaults to send', (d) => { delete node(d, 'fetch').effect }, ['UNAPPROVED_EFFECT']],
  ['reference to a downstream node', (d) => { node(d, 'fetch').input.since = '{{ steps.notify.output.ok }}' }, ['REFERENCE_NOT_UPSTREAM']],
  ['loop-body output read after the loop', (d) => { node(d, 'notify').arguments.text = '{{ steps.classify.output.category }}' }, ['REFERENCE_NOT_UPSTREAM']],
  ['a node reading its own output', (d) => { node(d, 'notify').arguments.text = '{{ steps.notify.output }}' }, ['REFERENCE_NOT_UPSTREAM']],
  ['bad step field (outputs)', (d) => { node(d, 'notify').arguments.text = '{{ steps.fetch.outputs }}' }, ['REFERENCE_INVALID_PATH']],
  ['unknown reference root', (d) => { node(d, 'notify').arguments.text = '{{ run.id }}' }, ['UNKNOWN_REFERENCE_ROOT']],
  ['item outside a loop', (d) => { node(d, 'notify').arguments.text = '{{ item.b.id }}' }, ['ITEM_OUTSIDE_LOOP']],
  ['item in the goal', (d) => { d.goal.end_condition.assert[1].expr = 'item.b.id == 1' }, ['ITEM_OUTSIDE_LOOP']],
  ['wrong loop variable', (d) => { node(d, 'classify').prompt = 'Note: {{ item.booking.notes }}' }, ['UNKNOWN_LOOP_VARIABLE']],
  ['unknown function', (d) => { node(d, 'notify').arguments.text = '{{ upper(steps.fetch.output) }}' }, ['EXPR_UNKNOWN_FUNCTION']],
  ['wrong arity', (d) => { node(d, 'fetch').input.since = '{{ date_add(now(), -1) }}' }, ['EXPR_ARITY']],
  ['arithmetic is not part of the language', (d) => { node(d, 'notify').arguments.text = '{{ len(steps.fetch.output.bookings) + 1 }}' }, ['EXPR_SYNTAX']],
  ['unclosed template', (d) => { node(d, 'notify').arguments.text = 'Triaged {{ len(steps.fetch.output.bookings) bookings' }, ['EXPR_SYNTAX']],
  ['unknown node kind (inline code)', (d) => { Object.assign(node(d, 'upsert'), { kind: 'code', code: 'return 1' }) }, ['UNKNOWN_NODE_KIND']],
  ['invalid node id', (d) => { node(d, 'done').id = 'Done!'; node(d, 'notify').next = 'Done!' }, ['DANGLING_EDGE', 'INVALID_NODE_ID']],
  ['wait with two modes', (d) => {
    node(d, 'upsert').next = 'hold'
    d.nodes.push({ id: 'hold', kind: 'wait', for: '15m', until: '2026-12-01T00:00:00Z', next: 'notify' })
  }, ['WAIT_MODE_INVALID']],
  ['block member declares next', (d) => { node(d, 'classify').next = 'upsert_one' }, ['BLOCK_NODE_HAS_NEXT']],
  ['unreachable node', (d) => { d.nodes.push({ id: 'orphan', kind: 'end' }) }, ['UNREACHABLE_NODE']],
  ['end node with next', (d) => { node(d, 'done').next = 'fetch' }, ['END_HAS_NEXT']],
  ['effect on a structural node', (d) => { node(d, 'upsert').effect = 'send' }, ['EFFECT_NOT_APPLICABLE']],
  ['unsupported apiVersion', (d) => { d.apiVersion = 'okflow/2' }, ['UNSUPPORTED_API_VERSION']],
  ['schedule trigger without cron', (d) => { delete node(d, 'start').schedule }, ['MISSING_FIELD']],
  ['llm without output_schema', (d) => { delete node(d, 'classify').output_schema }, ['MISSING_FIELD']],
  ['bad retry backoff', (d) => { node(d, 'fetch').retry.backoff = 'linear' }, ['INVALID_FIELD']],
]

describe('validateFlow — negative fixtures', () => {
  it('has at least 15 fixtures with distinct codes', () => {
    expect(NEGATIVE.length).toBeGreaterThanOrEqual(15)
    expect(new Set(NEGATIVE.flatMap(([, , c]) => c)).size).toBeGreaterThanOrEqual(15)
  })

  it.each(NEGATIVE)('%s', (_name, mutate, expected) => {
    const doc = example()
    mutate(doc)
    const r = validateFlow(doc)
    expect(r.ok).toBe(false)
    expect(codes(doc)).toEqual([...expected].sort())
    for (const e of r.errors) {
      expect(e.severity).toBe('error')
      expect(e.message.length).toBeGreaterThan(0)
      expect(typeof e.path).toBe('string')
    }
  })

  it('points the error at the offending field', () => {
    const doc = example()
    node(doc, 'classify').max_iterations = 12
    expect(validateFlow(doc).errors).toEqual([expect.objectContaining({
      code: 'LLM_MAX_ITERATIONS_EXCEEDED', path: 'nodes[3].max_iterations', node_id: 'classify',
    })])
  })

  it('rejects non-objects and a missing node list', () => {
    expect(codes(null)).toEqual(['INVALID_DOCUMENT'])
    expect(codes([])).toEqual(['INVALID_DOCUMENT'])
    const doc = example()
    doc.nodes = []
    expect(codes(doc)).toEqual(['INVALID_FIELD'])
  })
})

describe('validateFlow — warnings', () => {
  it('flags unknown fields (typos) as warnings, not errors', () => {
    const doc = example()
    node(doc, 'each').maxItems = 10
    const r = validateFlow(doc)
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toEqual(['UNKNOWN_FIELD'])
  })

  it('reports a stale approval record as a warning alongside the error', () => {
    const doc = example()
    doc.version = 4
    expect(validateFlow(doc).warnings.map((w) => w.code)).toEqual(['APPROVAL_VERSION_MISMATCH'])
  })

  it('requireApprovals:false downgrades UNAPPROVED_EFFECT for drafts', () => {
    const doc = example()
    delete doc.approvals
    const r = validateFlow(doc, { requireApprovals: false })
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => w.code)).toEqual(['UNAPPROVED_EFFECT'])
  })
})

describe('validateFlow — approval waits (per-run approval)', () => {
  const withGate = (d: Loose) => {
    delete d.approvals
    node(d, 'upsert').next = 'gate'
    d.nodes.push({ id: 'gate', kind: 'wait', approval: { from: 'owner', prompt: 'Post the summary?' }, next: 'notify' })
    return d
  }

  it('an approval wait in front of a send node satisfies the gate', () => {
    expect(validateFlow(withGate(example())).errors).toEqual([])
  })

  it('an approval wait on only one branch arm does not dominate the send', () => {
    const d = example()
    delete d.approvals
    node(d, 'upsert').next = 'route'
    d.nodes.push(
      { id: 'route', kind: 'branch', cases: [{ when: 'len(steps.fetch.output.bookings) > 50', then: ['gate'] }], next: 'notify' },
      { id: 'gate', kind: 'wait', approval: { from: 'owner', prompt: 'Big day — post?' } },
    )
    expect(codes(d)).toEqual(['UNAPPROVED_EFFECT'])
  })

  it('approval waits on every arm (incl. default) do dominate', () => {
    const d = example()
    delete d.approvals
    node(d, 'upsert').next = 'route'
    d.nodes.push(
      { id: 'route', kind: 'branch', cases: [{ when: 'len(steps.fetch.output.bookings) > 50', then: ['gate_a'] }], default: 'gate_b', next: 'notify' },
      { id: 'gate_a', kind: 'wait', approval: { from: 'owner', prompt: 'Big day — post?' } },
      { id: 'gate_b', kind: 'wait', approval: { from: 'owner', prompt: 'Post?' } },
    )
    expect(codes(d)).toEqual([])
  })
})

describe('validateFlow — branch semantics', () => {
  const branchy = () => {
    const d = example()
    node(d, 'upsert').next = 'route'
    d.nodes.push(
      { id: 'route', kind: 'branch', cases: [{ when: "steps.upsert.status == 'ok'", then: ['tag_ok'] }], default: ['tag_other'], next: 'notify' },
      { id: 'tag_ok', kind: 'tool', tool: 'tagger', effect: 'write', input: { v: '{{ steps.fetch.output.bookings }}' } },
      { id: 'tag_other', kind: 'tool', tool: 'tagger', effect: 'write' },
    )
    return d
  }

  it('case blocks rejoin at the branch continuation and their outputs are visible after it', () => {
    const d = branchy()
    node(d, 'notify').arguments.text = '{{ default(steps.tag_ok.output, steps.tag_other.output) }}'
    expect(validateFlow(d).errors).toEqual([])
  })

  it('one arm cannot read a sibling arm', () => {
    const d = branchy()
    node(d, 'tag_other').input = { v: '{{ steps.tag_ok.output }}' }
    expect(codes(d)).toEqual(['REFERENCE_NOT_UPSTREAM'])
  })

  it('a node placed in two arms is MULTIPLE_INCOMING', () => {
    const d = branchy()
    node(d, 'route').default = ['tag_ok']
    node(d, 'tag_other').next = 'notify'
    expect(codes(d)).toContain('MULTIPLE_INCOMING')
  })
})

describe('validateFlow — injected registry resolver', () => {
  const registry = (over: Partial<Record<string, unknown>> = {}): FlowRegistry => ({
    getTool: (slug) => (({ 'calendar-bookings-list': { effect: 'read' }, 'read-only-lookup': { effect: 'read' }, mailer: { effect: 'send' } } as Record<string, { effect: 'read' | 'send' }>)[slug] ?? null),
    getConnector: (id) => {
      if (id === 'crm') return { enabled: over.crmEnabled !== false, getTool: (n) => (n === 'upsert_contact' ? { effect: (over.upsertEffect as 'write') ?? 'write' } : null) }
      if (id === 'slack') return { enabled: true, getTool: (n) => (n === 'post_message' ? { readOnlyHint: false } : null) }
      return null
    },
  })

  it('the example passes with a registry that knows its tools and connectors', () => {
    expect(validateFlow(DAILY_BOOKING_TRIAGE, { registry: registry() }).errors).toEqual([])
  })

  it.each<[string, (d: Loose) => void, Partial<Record<string, unknown>>, FlowErrorCode[]]>([
    ['unknown Tool slug', (d) => { node(d, 'fetch').tool = 'nope' }, {}, ['UNKNOWN_TOOL']],
    ['unknown connector', (d) => { node(d, 'upsert_one').connector = 'hubspot' }, {}, ['UNKNOWN_CONNECTOR']],
    ['connector disabled for the workspace', () => {}, { crmEnabled: false }, ['CONNECTOR_DISABLED']],
    ['connector lacks the tool', (d) => { node(d, 'upsert_one').tool = 'delete_contact' }, {}, ['UNKNOWN_CONNECTOR_TOOL']],
    ['declared effect weaker than the registry', () => {}, { upsertEffect: 'send' }, ['EFFECT_UNDERSTATED', 'UNAPPROVED_EFFECT']],
    ['llm tool loop with a sending Tool', (d) => { node(d, 'classify').tools = ['read-only-lookup', 'mailer'] }, {}, ['LLM_TOOL_NOT_READ_ONLY']],
  ])('%s', (_n, mutate, over, expected) => {
    const d = example()
    mutate(d)
    expect(codes(d, { registry: registry(over) })).toEqual([...expected].sort())
  })

  it('registry checks are skipped when no resolver is injected', () => {
    const d = example()
    node(d, 'fetch').tool = 'nope'
    node(d, 'upsert_one').connector = 'hubspot'
    expect(validateFlow(d).ok).toBe(true)
  })
})

describe('parseExpression', () => {
  it('collects reference paths, including indexes', () => {
    const r = parseExpression("len(steps.fetch.output.bookings[0].tags) >= 1 && lower(trigger.payload.kind) == 'x'")
    expect(r.problems).toEqual([])
    expect(r.refs.map((x) => x.segments.join('.'))).toEqual(['steps.fetch.output.bookings.0.tags', 'trigger.payload.kind'])
  })

  it('accepts literals, negation and grouping', () => {
    expect(parseExpression("!(steps.a.output.ok == true) || -1 < 0 || null != 'x'").problems).toEqual([])
  })

  it.each(['', 'a = 1', 'a +', 'steps.', 'x[1.5]', "'open", 'f(1', 'a b'])('rejects %j', (src) => {
    expect(parseExpression(src).problems.map((p) => p.code)).toEqual(['EXPR_SYNTAX'])
  })

  it('does not treat Object.prototype names as allowed functions', () => {
    expect(parseExpression('toString(1)').problems.map((p) => p.code)).toEqual(['EXPR_UNKNOWN_FUNCTION'])
  })
})

describe('fixtures (card B5: self-test trigger payloads)', () => {
  it('accepts a list of { name, payload } and does not warn about the field', () => {
    const doc = example()
    doc.fixtures = [{ name: 'empty', payload: { bookings: [] } }, { name: 'normal' }]
    const r = validateFlow(doc)
    expect(r.ok).toBe(true)
    expect(r.warnings.filter((w) => w.path.startsWith('fixtures'))).toEqual([])
  })

  it.each([
    ['not a list', { a: 1 }],
    ['empty list', []],
    ['eleven fixtures', Array.from({ length: 11 }, (_, i) => ({ name: `f${i}` }))],
    ['missing name', [{ payload: {} }]],
    ['duplicate name', [{ name: 'a' }, { name: 'a' }]],
    ['payload not an object', [{ name: 'a', payload: [1] }]],
  ])('rejects %s with INVALID_FIELD', (_label, fixtures) => {
    const doc = example()
    doc.fixtures = fixtures
    const r = validateFlow(doc)
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => e.code)).toContain('INVALID_FIELD')
    expect(r.errors.every((e) => e.path.startsWith('fixtures'))).toBe(true)
  })
})
