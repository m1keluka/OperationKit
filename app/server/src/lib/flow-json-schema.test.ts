// output_schema checker + reply parsing for flow `llm` nodes (obj 900639, card B3).
import { describe, it, expect } from 'vitest'
import { extractJson, unsupportedSchemaKeywords, validateAgainstSchema } from './flow-json-schema.js'

describe('validateAgainstSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      category: { enum: ['sales', 'support', 'other'] },
      score: { type: 'number', minimum: 0, maximum: 1 },
      tags: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 2 },
      id: { type: 'string', pattern: '^b[0-9]+$' },
    },
    required: ['category'],
    additionalProperties: false,
  }

  it('accepts a valid value', () => {
    expect(validateAgainstSchema({ category: 'sales', score: 0.5, tags: ['a'], id: 'b12' }, schema)).toEqual([])
  })

  it('reports each problem with a path', () => {
    const issues = validateAgainstSchema({ score: 2, tags: ['', 'x', 'y'], id: 'c1', extra: true }, schema)
    expect(issues.map((i) => `${i.path}: ${i.message}`)).toEqual([
      '$: missing required property "category"',
      '$.score: must be ≤ 1',
      '$.tags: must have at most 2 items',
      '$.tags[0]: must be at least 1 characters',
      '$.id: must match "^b[0-9]+$"',
      '$: unexpected property "extra"',
    ])
  })

  it('type checks, integer vs number, null, anyOf / oneOf / not / const', () => {
    expect(validateAgainstSchema('x', { type: 'object' })[0].message).toBe('expected object, got string')
    expect(validateAgainstSchema(1.5, { type: 'integer' })).toHaveLength(1)
    expect(validateAgainstSchema(2, { type: 'number' })).toEqual([])
    expect(validateAgainstSchema(null, { type: ['string', 'null'] })).toEqual([])
    expect(validateAgainstSchema(3, { anyOf: [{ type: 'string' }, { type: 'integer' }] })).toEqual([])
    expect(validateAgainstSchema(3, { oneOf: [{ type: 'number' }, { type: 'integer' }] })).toHaveLength(1)
    expect(validateAgainstSchema('a', { not: { type: 'string' } })).toHaveLength(1)
    expect(validateAgainstSchema({ a: 1 }, { const: { a: 1 } })).toEqual([])
  })

  it('flags assertion keywords it does not implement (so the engine refuses rather than under-checks)', () => {
    expect(unsupportedSchemaKeywords(schema)).toEqual([])
    expect(unsupportedSchemaKeywords({ type: 'object', properties: { a: { $ref: '#/x' } }, patternProperties: {} })).toEqual(['$ref', 'patternProperties'])
  })
})

describe('extractJson', () => {
  it('bare JSON, a ```json fence, and JSON wrapped in prose', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
    expect(extractJson('```json\n{"a": [1, 2]}\n```')).toEqual({ a: [1, 2] })
    expect(extractJson('Here you go: {"a": "}"} hope that helps')).toEqual({ a: '}' })
    expect(extractJson('"just a string"')).toBe('just a string')
  })
  it('nothing parseable → undefined', () => {
    expect(extractJson('no json here')).toBeUndefined()
    expect(extractJson('')).toBeUndefined()
    expect(extractJson('{broken')).toBeUndefined()
  })
})
