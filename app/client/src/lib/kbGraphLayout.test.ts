import { describe, it, expect } from 'vitest'
import { boundsOf, clampZoom, createSimulation, fitView, nodeRadius, settle, zoomAt, ALPHA_MIN, MAX_ZOOM, MIN_ZOOM } from './kbGraphLayout'

/** Two tight clusters of 6 joined by one bridge, plus 3 unconnected pages. */
function graph() {
  const ids = Array.from({ length: 15 }, (_, i) => `p${i}`)
  const pairs: Array<[number, number]> = []
  for (const base of [0, 6]) for (let i = 1; i < 6; i++) pairs.push([base, base + i])
  pairs.push([0, 6])
  const deg = ids.map((_, i) => pairs.filter(([a, b]) => a === i || b === i).length)
  return { ids, pairs, deg }
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe('kbGraphLayout (obj 900674)', () => {
  it('settles: finite positions, linked pages closer than unlinked ones', () => {
    const { ids, pairs, deg } = graph()
    const sim = createSimulation(ids, deg, pairs)
    const ticks = settle(sim)
    expect(ticks).toBeGreaterThan(50)
    expect(sim.alpha).toBeLessThanOrEqual(ALPHA_MIN)
    for (const n of sim.nodes) { expect(Number.isFinite(n.x)).toBe(true); expect(Number.isFinite(n.y)).toBe(true) }
    const linked = pairs.map(([a, b]) => dist(sim.nodes[a], sim.nodes[b]))
    const avgLinked = linked.reduce((s, d) => s + d, 0) / linked.length
    const all: number[] = []
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) all.push(dist(sim.nodes[i], sim.nodes[j]))
    expect(avgLinked).toBeLessThan((all.reduce((s, d) => s + d, 0) / all.length) * 0.8)
    // Hubs sit in the middle; unconnected pages orbit further out.
    const fromMid = (i: number) => Math.hypot(sim.nodes[i].x, sim.nodes[i].y)
    expect(Math.max(fromMid(0), fromMid(6))).toBeLessThan(Math.min(fromMid(12), fromMid(13), fromMid(14)))
    // No two pages on top of each other.
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) expect(dist(sim.nodes[i], sim.nodes[j])).toBeGreaterThan(2)
  })

  it('is deterministic: same input, same picture', () => {
    const { ids, pairs, deg } = graph()
    const a = createSimulation(ids, deg, pairs); settle(a)
    const b = createSimulation(ids, deg, pairs); settle(b)
    expect(a.nodes.map(n => [n.x, n.y])).toEqual(b.nodes.map(n => [n.x, n.y]))
  })

  it('handles an empty graph, self-links and a big graph quickly', () => {
    const empty = createSimulation([], [], [])
    expect(settle(empty)).toBe(0)
    const self = createSimulation(['a'], [0], [[0, 0]])
    expect(self.links).toEqual([])
    const n = 1500
    const ids = Array.from({ length: n }, (_, i) => `n${i}`)
    const pairs: Array<[number, number]> = ids.slice(1).map((_, i) => [Math.floor(i / 4), i + 1])
    const deg = ids.map((_, i) => pairs.filter(([a, b]) => a === i || b === i).length)
    const big = createSimulation(ids, deg, pairs)
    const t0 = Date.now()
    settle(big)
    expect(Date.now() - t0).toBeLessThan(8000)
    expect(big.nodes.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })

  it('a pinned (dragged) page stays where it is held', () => {
    const { ids, pairs, deg } = graph()
    const sim = createSimulation(ids, deg, pairs)
    sim.nodes[3].fx = 500; sim.nodes[3].fy = -200
    settle(sim)
    expect(sim.nodes[3]).toMatchObject({ x: 500, y: -200 })
  })

  it('fits, zooms around a point and clamps the zoom', () => {
    const v = fitView({ x0: -100, y0: -50, x1: 100, y1: 50 }, 600, 400, 40)
    // Content centred in the box.
    expect(v.x).toBeCloseTo(300)
    expect(v.y).toBeCloseTo(200)
    const z = zoomAt(v, 2, 100, 100)
    // The point under the cursor stays still.
    expect((100 - z.x) / z.k).toBeCloseTo((100 - v.x) / v.k)
    expect(clampZoom(100)).toBe(MAX_ZOOM)
    expect(clampZoom(0)).toBe(MIN_ZOOM)
    expect(boundsOf([])).toEqual({ x0: -1, y0: -1, x1: 1, y1: 1 })
    expect(nodeRadius(0)).toBeLessThan(nodeRadius(9))
    expect(nodeRadius(10_000)).toBe(16)
  })
})
