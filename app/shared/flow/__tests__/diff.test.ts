// Version diff for the viewer's changed-node tags (card B7, docs/design/WORKFLOWS.md §6.2).
import { describe, it, expect } from 'vitest'
import { diffFlowNodes } from '../diff.js'
import { DAILY_BOOKING_TRIAGE } from './example.js'
import type { FlowDefinition, FlowNode } from '../types.js'

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('diffFlowNodes', () => {
  it('an identical version has no changes', () => {
    expect(diffFlowNodes(DAILY_BOOKING_TRIAGE, clone(DAILY_BOOKING_TRIAGE))).toEqual({ added: [], changed: [], removed: [], byNode: {} })
  })

  it('key order inside a node is not a change', () => {
    const next = clone(DAILY_BOOKING_TRIAGE)
    next.nodes = next.nodes.map((n) => Object.fromEntries(Object.entries(n).reverse()) as unknown as FlowNode)
    expect(diffFlowNodes(DAILY_BOOKING_TRIAGE, next).changed).toEqual([])
  })

  it('tags added and changed nodes and lists removed ones', () => {
    const next: FlowDefinition = clone(DAILY_BOOKING_TRIAGE)
    const notify = next.nodes.find((n) => n.id === 'notify') as FlowNode & { arguments: Record<string, unknown> }
    notify.arguments = { ...notify.arguments, channel: '#ops' }
    next.nodes = next.nodes.filter((n) => n.id !== 'upsert')
    next.nodes.push({ id: 'audit', kind: 'check', assert: [{ expr: 'true' }] })
    const d = diffFlowNodes(DAILY_BOOKING_TRIAGE, next)
    expect(d.changed).toEqual(['notify'])
    expect(d.added).toEqual(['audit'])
    expect(d.removed).toEqual(['upsert'])
    expect(d.byNode).toEqual({ notify: 'changed', audit: 'added' })
  })

  it('a missing base marks every node added', () => {
    expect(diffFlowNodes(null, DAILY_BOOKING_TRIAGE).added).toHaveLength(DAILY_BOOKING_TRIAGE.nodes.length)
  })
})
