import { describe, it, expect } from 'vitest'
import {
  evaluateExpression, evaluateCondition, evaluateExpressionField, resolveTemplates, FlowExprError, type FlowEvalScope,
} from './flow-eval.js'
import { parseExpression } from '../../../shared/flow/expr.js'

const scope: FlowEvalScope = {
  trigger: { payload: { kind: 'big', n: 3, tags: ['A', 'b'] } },
  steps: {
    fetch: { output: { bookings: [{ id: 'b1' }, { id: 'b2' }], ok: true, count: 2, name: 'MiXed' } },
    empty: { output: { rows: [] } },
  },
  now: () => new Date('2026-11-12T08:00:00.000Z'),
}
const ev = (s: string) => evaluateExpression(s, scope)

describe('flow-eval: okflow/1 expressions', () => {
  it('resolves reference paths, including indexes and missing segments as null', () => {
    expect(ev('steps.fetch.output.bookings[1].id')).toBe('b2')
    expect(ev('trigger.payload.kind')).toBe('big')
    expect(ev('steps.fetch.output.nope.deeper')).toBeNull()
    expect(ev('steps.missing.output')).toBeNull()
  })

  it('implements the closed function list', () => {
    expect(ev('len(steps.fetch.output.bookings)')).toBe(2)
    expect(ev('len("abc")')).toBe(3)
    expect(ev('len(steps.nope)')).toBe(0)
    expect(ev('now()')).toBe('2026-11-12T08:00:00.000Z')
    expect(ev("date_add(now(), -1, 'day')")).toBe('2026-11-11T08:00:00.000Z')
    expect(ev("date_add(now(), 2, 'hours')")).toBe('2026-11-12T10:00:00.000Z')
    expect(ev('lower(steps.fetch.output.name)')).toBe('mixed')
    expect(ev('join(trigger.payload.tags, "-")')).toBe('A-b')
    expect(ev('join(trigger.payload.tags)')).toBe('A,b')
    expect(ev('default(steps.fetch.output.none, 7)')).toBe(7)
    expect(ev('default(steps.fetch.output.count, 7)')).toBe(2)
  })

  it('comparison and boolean operators', () => {
    expect(ev('len(steps.fetch.output.bookings) == steps.fetch.output.count')).toBe(true)
    expect(ev('steps.fetch.output.ok == true && trigger.payload.n > 2')).toBe(true)
    expect(ev('trigger.payload.n >= 4 || trigger.payload.kind != "big"')).toBe(false)
    expect(ev('!(trigger.payload.n < 3)')).toBe(true)
    expect(ev('-trigger.payload.n < 0')).toBe(true)
    expect(ev('steps.empty.output.rows == steps.empty.output.rows')).toBe(true) // structural equality
    expect(ev('"a" < 1')).toBe(false) // mixed types never order
  })

  it('evaluateCondition: arrays are truthy only when non-empty; wrapped and bare forms agree', () => {
    expect(evaluateCondition('steps.empty.output.rows', scope)).toBe(false)
    expect(evaluateCondition('steps.fetch.output.bookings', scope)).toBe(true)
    expect(evaluateCondition('{{ trigger.payload.kind == "big" }}', scope)).toBe(true)
    expect(evaluateExpressionField('{{ len(steps.fetch.output.bookings) }}', scope)).toBe(2)
  })

  it('resolveTemplates keeps the type of a whole-string template and interpolates mixed strings', () => {
    expect(resolveTemplates({
      list: '{{ steps.fetch.output.bookings }}',
      text: 'Triaged {{ len(steps.fetch.output.bookings) }} bookings for {{ trigger.payload.kind }}.',
      nested: [{ n: '{{ trigger.payload.n }}' }, 5, null],
      plain: 'no template',
    }, scope)).toEqual({
      list: [{ id: 'b1' }, { id: 'b2' }],
      text: 'Triaged 2 bookings for big.',
      nested: [{ n: 3 }, 5, null],
      plain: 'no template',
    })
  })

  it('rejects anything outside the grammar (no eval, no secrets root, no unknown functions)', () => {
    expect(() => ev('secrets.API_KEY')).toThrow(FlowExprError)
    expect(() => ev('process.env')).toThrow(FlowExprError)
    expect(() => ev('eval("1")')).toThrow(FlowExprError)
    expect(() => ev('1 +')).toThrow(FlowExprError)
    expect(() => ev('')).toThrow(FlowExprError)
    expect(() => ev("date_add('not a date', 1, 'day')")).toThrow(FlowExprError)
  })

  it('accepts every expression the B1 parser accepts in its own tests (grammar parity spot-check)', () => {
    for (const src of [
      'len(steps.fetch.output.bookings) == steps.fetch.output.count',
      'steps.fetch.output.ok == true',
      "date_add(now(), -1, 'day')",
      '(trigger.payload.n > 1) && !steps.fetch.output.ok || null == null',
    ]) {
      expect(parseExpression(src).problems).toEqual([])
      expect(() => ev(src)).not.toThrow()
    }
  })
})
