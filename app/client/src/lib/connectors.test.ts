// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { parseConnectorList, connectorOptionsOf } from './connectors'

/**
 * obj 900303. The bug this exists to prevent: `GET /api/connectors` answers
 * with a bare array, one consumer read `res.connectors` off it, and the
 * resulting `undefined ?? []` rendered a confident "No connectors available."
 * on an install that had connectors connected.
 */
describe('parseConnectorList', () => {
  it('reads the real contract — a bare array', () => {
    const parsed = parseConnectorList([
      { id: 'github', name: 'GitHub' },
      { id: 'google-workspace', name: 'Google Workspace' },
    ])
    expect(parsed.fromEnvelope).toBe(false)
    expect(parsed.options).toEqual([
      { id: 'github', name: 'GitHub' },
      { id: 'google-workspace', name: 'Google Workspace' },
    ])
  })

  it('still reads the envelope, so the picker cannot blank again on a server change', () => {
    const parsed = parseConnectorList({ connectors: [{ id: 'github', name: 'GitHub' }] })
    expect(parsed.fromEnvelope).toBe(true)
    expect(parsed.options).toEqual([{ id: 'github', name: 'GitHub' }])
  })

  it('an empty catalogue is an empty list, not an error', () => {
    expect(parseConnectorList([]).options).toEqual([])
    expect(parseConnectorList({ connectors: [] }).options).toEqual([])
  })

  it('THROWS on a shape it cannot read, rather than claiming you have none', () => {
    for (const bad of [null, undefined, 'nope', 42, { error: 'Authentication required' }, {}]) {
      expect(() => parseConnectorList(bad)).toThrow(/does not understand/i)
    }
  })

  it('drops entries with no usable id and falls back to the id for a missing name', () => {
    expect(connectorOptionsOf([
      { id: 'github', name: 'GitHub' },
      { id: '', name: 'nameless' },
      { name: 'no id at all' },
      null,
      'string',
      { id: 'bare' },
      { id: 'blank-name', name: '   ' },
    ])).toEqual([
      { id: 'github', name: 'GitHub' },
      { id: 'bare', name: 'bare' },
      { id: 'blank-name', name: 'blank-name' },
    ])
  })

  it('trims, so a padded id still matches the one a key stores', () => {
    expect(connectorOptionsOf([{ id: ' github ', name: ' GitHub ' }])).toEqual([{ id: 'github', name: 'GitHub' }])
  })
})
