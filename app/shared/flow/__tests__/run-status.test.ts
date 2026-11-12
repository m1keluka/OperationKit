// Run overlay + Jobs lane helpers (card B4, docs/design/WORKFLOWS.md §6.2 / §7.1).
import { describe, it, expect } from 'vitest'
import { nodeStatusFromSteps, flowRunLane, isActiveFlowRun } from '../run-status.js'

describe('nodeStatusFromSteps', () => {
  it('takes the latest attempt per node and maps step statuses onto overlay classes', () => {
    const s = nodeStatusFromSteps([
      { node_id: 'a', attempt: 1, status: 'succeeded' },
      { node_id: 'b', attempt: 1, status: 'failed' },
      { node_id: 'b', attempt: 2, status: 'succeeded' },
      { node_id: 'c', attempt: 1, status: 'interrupted' },
      { node_id: 'd', attempt: 1, status: 'unknown' },
      { node_id: 'e', attempt: 1, status: 'failed' },
    ], 'failed')
    expect(s).toEqual({ a: 'succeeded', b: 'succeeded', c: 'running', d: 'waiting', e: 'failed' })
  })

  it('a failed attempt on a still-active run is a pending retry (running), not a failure', () => {
    expect(nodeStatusFromSteps([{ node_id: 'x', attempt: 1, status: 'failed' }], 'running')).toEqual({ x: 'running' })
  })

  it('B9: a running row in a WAITING run is a parked node (approval, agent card, timer) — shown as waiting', () => {
    expect(nodeStatusFromSteps([
      { node_id: 'a', attempt: 1, status: 'succeeded' },
      { node_id: 'gate', attempt: 1, status: 'running' },
    ], 'waiting')).toEqual({ a: 'succeeded', gate: 'waiting' })
    expect(nodeStatusFromSteps([{ node_id: 'gate', attempt: 1, status: 'running' }], 'running')).toEqual({ gate: 'running' })
  })

  it('later loop iterations win over earlier ones', () => {
    expect(nodeStatusFromSteps([
      { node_id: 'x', iteration: 1, attempt: 1, status: 'failed' },
      { node_id: 'x', iteration: 0, attempt: 3, status: 'succeeded' },
    ], 'failed')).toEqual({ x: 'failed' })
  })

  it('nodes without a row are skipped only on a succeeded run (a branch not taken)', () => {
    const steps = [{ node_id: 'a', attempt: 1, status: 'succeeded' }]
    expect(nodeStatusFromSteps(steps, 'succeeded', ['a', 'b'])).toEqual({ a: 'succeeded', b: 'skipped' })
    expect(nodeStatusFromSteps(steps, 'failed', ['a', 'b'])).toEqual({ a: 'succeeded' })
    expect(nodeStatusFromSteps(steps, 'running', ['a', 'b'])).toEqual({ a: 'succeeded' })
  })
})

describe('flowRunLane', () => {
  it('maps run states onto the Jobs lanes (§7.1)', () => {
    for (const st of ['queued', 'running', 'waiting', 'repairing']) {
      expect(isActiveFlowRun(st)).toBe(true)
      expect(flowRunLane({ status: st })).toBe('running')
    }
    expect(flowRunLane({ status: 'failed' })).toBe('needs_review')
    expect(flowRunLane({ status: 'succeeded', goal_met: 0 })).toBe('needs_review')
    expect(flowRunLane({ status: 'succeeded', goal_met: 1 })).toBe('complete')
    expect(flowRunLane({ status: 'succeeded', goal_met: null })).toBe('complete')
    expect(flowRunLane({ status: 'cancelled' })).toBe('complete')
  })
})
