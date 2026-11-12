import { describe, it, expect } from 'vitest'
import { buildFlowGraph, absoluteRects } from './flow-graph'
import { THIRTY_NODE_FLOW } from '../../../shared/flow/__tests__/thirty-nodes'
import { DAILY_BOOKING_TRIAGE } from '../../../shared/flow/__tests__/example'
import { validateFlow } from '../../../shared/flow/validate'

/**
 * Card B7 (obj 900643) — "a 30-node flow lays out without overlap". The layout
 * is dagre, hierarchical over loop groups; these assertions are on the absolute
 * canvas rectangles React Flow will draw.
 */

type Rect = { x: number; y: number; w: number; h: number; parent: string | null }
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const inside = (c: Rect, p: Rect) => c.x >= p.x && c.y >= p.y && c.x + c.w <= p.x + p.w && c.y + c.h <= p.y + p.h

function assertNoOverlap(def: Parameters<typeof buildFlowGraph>[0]) {
  const g = buildFlowGraph(def)
  const rects = absoluteRects(g.nodes)
  const groups = new Set(g.nodes.filter(n => n.type === 'flowLoop').map(n => n.id))
  const all = [...rects.entries()]
  const clashes: string[] = []
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [ia, a] = all[i]
      const [ib, b] = all[j]
      // A group legitimately contains its own descendants; anything else must not touch.
      const related = (x: string, y: string) => {
        let p = rects.get(y)?.parent ?? null
        while (p) { if (p === x) return true; p = rects.get(p)?.parent ?? null }
        return false
      }
      if (related(ia, ib) || related(ib, ia)) continue
      if (overlaps(a, b)) clashes.push(`${ia} × ${ib}`)
    }
  }
  expect(clashes, `overlapping nodes: ${clashes.join(', ')}`).toEqual([])
  // every child sits inside its loop's frame
  for (const [id, r] of rects) if (r.parent) expect(inside(r, rects.get(r.parent)!), `${id} escapes ${r.parent}`).toBe(true)
  // every node got finite, positive geometry
  for (const [id, r] of rects) {
    expect(Number.isFinite(r.x) && Number.isFinite(r.y), id).toBe(true)
    expect(r.w > 0 && r.h > 0, id).toBe(true)
  }
  return { g, rects, groups }
}

describe('buildFlowGraph — dagre layout', () => {
  it('the 30-node fixture is a valid okflow/1 definition with 30 nodes', () => {
    expect(THIRTY_NODE_FLOW.nodes).toHaveLength(30)
    const v = validateFlow(THIRTY_NODE_FLOW, { requireApprovals: false })
    expect(v.errors, JSON.stringify(v.errors)).toEqual([])
  })

  it('a 30-node flow lays out without overlap (loops, branches, nested branch in a loop)', () => {
    const { g, groups } = assertNoOverlap(THIRTY_NODE_FLOW)
    expect(g.nodes).toHaveLength(30)
    expect([...groups].sort()).toEqual(['contact_each', 'score_each'])
    // loop bodies are children of their group, not free-floating
    expect(g.nodes.find(n => n.id === 'score')?.parentId).toBe('score_each')
    expect(g.nodes.find(n => n.id === 'flag_risk')?.parentId).toBe('score_each')
    expect(g.nodes.find(n => n.id === 'verify_email')?.parentId).toBe('contact_each')
    // React Flow needs every parent before its children
    const idx = new Map(g.nodes.map((n, i) => [n.id, i]))
    for (const n of g.nodes) if (n.parentId) expect(idx.get(n.parentId)!).toBeLessThan(idx.get(n.id)!)
  })

  it('the §3.5 example lays out without overlap too, top-to-bottom', () => {
    const { rects } = assertNoOverlap(DAILY_BOOKING_TRIAGE)
    expect(rects.get('start')!.y).toBeLessThan(rects.get('fetch')!.y)
    expect(rects.get('fetch')!.y).toBeLessThan(rects.get('each')!.y)
    expect(rects.get('notify')!.y).toBeLessThan(rects.get('done')!.y)
  })

  it('is deterministic: the same definition always gives the same layout (no stored layout to drift)', () => {
    const a = buildFlowGraph(THIRTY_NODE_FLOW)
    const b = buildFlowGraph(JSON.parse(JSON.stringify(THIRTY_NODE_FLOW)))
    expect(a.nodes.map(n => [n.id, n.position])).toEqual(b.nodes.map(n => [n.id, n.position]))
  })

  it('every node is non-draggable, non-connectable and non-deletable', () => {
    const g = buildFlowGraph(THIRTY_NODE_FLOW)
    for (const n of g.nodes) expect({ d: n.draggable, c: n.connectable, x: n.deletable }).toEqual({ d: false, c: false, x: false })
    for (const e of g.edges) expect({ r: e.reconnectable, x: e.deletable }).toEqual({ r: false, x: false })
  })

  it('encodes kind, effect, approval, run status, loop counts and change tags in node data', () => {
    const g = buildFlowGraph(THIRTY_NODE_FLOW, {
      status: { accounts: 'succeeded', score_each: 'failed', post_summary: 'running' },
      changes: { score: 'changed', archive: 'added' },
      changeAuthor: 'repair:run-123',
      steps: [
        { node_id: 'score', iteration: 0, attempt: 1, status: 'succeeded' },
        { node_id: 'score', iteration: 1, attempt: 1, status: 'failed' },
        { node_id: 'save_score', iteration: 0, attempt: 1, status: 'succeeded' },
      ],
      approvedNodes: ['warn_large'],
    })
    const d = (id: string) => g.nodes.find(n => n.id === id)!.data
    expect(d('score')).toMatchObject({ kind: 'llm', effect: 'read', change: 'changed', changeAuthor: 'repair:run-123' })
    expect(d('archive')).toMatchObject({ kind: 'tool', effect: 'write', change: 'added' })
    expect(d('accounts').status).toBe('succeeded')
    expect(d('warn_large').approval).toBe('owner-approved v2')
    expect(d('post_summary').approval).toBe('approval each run')
    expect(d('verify_email')).toMatchObject({ effect: 'spend', approval: 'NOT APPROVED' })
    expect(d('score_each').loopCounts).toBe('2 iterations · 1 ok · 1 failed')
    expect(g.edges.find(e => e.target === 'post_summary')?.animated).toBe(true)
  })

  it('an empty or malformed definition yields an empty graph instead of throwing', () => {
    expect(buildFlowGraph(null).nodes).toEqual([])
    expect(buildFlowGraph({} as never).nodes).toEqual([])
  })
})
