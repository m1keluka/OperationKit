/* Force layout for the workspace knowledge-base graph (obj 900674).

   A small, dependency-free force simulation in the style of d3-force — the
   same thing Obsidian's graph view does: every page pushes every other page
   away (many-body, Barnes–Hut approximated so a few thousand pages stay fast),
   every link pulls its two pages together like a spring, and a weak pull
   toward the middle keeps unconnected pages orbiting instead of drifting off.

   Pure and deterministic: the same nodes and links always give the same
   picture, so the graph doesn't reshuffle every time the panel re-renders. */

export interface SimNode {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  /** Pinned position while the user drags the node (null = free). */
  fx: number | null
  fy: number | null
  /** Link count, for the node's radius and the spring strength. */
  degree: number
}

export interface SimLink { source: number; target: number }

export interface Simulation {
  nodes: SimNode[]
  links: SimLink[]
  alpha: number
}

export const ALPHA_MIN = 0.02
const ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300) // ≈ 300 ticks from 1 to 0.001, like d3
const VELOCITY_DECAY = 0.4
const CHARGE = -90
const LINK_DISTANCE = 46
const GRAVITY = 0.045
const THETA2 = 0.81 // Barnes–Hut accuracy (θ = 0.9)
const DIST_MIN2 = 1

/** Radius of a page's dot: bigger for better-connected pages. */
export function nodeRadius(degree: number): number {
  return Math.min(16, 3.5 + Math.sqrt(degree) * 1.6)
}

/**
 * Initial positions on a sunflower spiral (d3's phyllotaxis seed), best
 * connected first so the hubs start in the middle.
 */
export function createSimulation(ids: string[], degrees: number[], pairs: Array<[number, number]>): Simulation {
  const order = ids.map((_, i) => i).sort((a, b) => degrees[b] - degrees[a] || a - b)
  const nodes: SimNode[] = ids.map((id, i) => ({ id, x: 0, y: 0, vx: 0, vy: 0, fx: null, fy: null, degree: degrees[i] ?? 0 }))
  const golden = Math.PI * (3 - Math.sqrt(5))
  order.forEach((idx, k) => {
    const r = 10 * Math.sqrt(0.5 + k)
    const a = k * golden
    nodes[idx].x = r * Math.cos(a)
    nodes[idx].y = r * Math.sin(a)
  })
  const links = pairs.filter(([a, b]) => a !== b && nodes[a] && nodes[b]).map(([source, target]) => ({ source, target }))
  return { nodes, links, alpha: 1 }
}

// ── Barnes–Hut quadtree ──────────────────────────────────────────────────────

interface Quad {
  x0: number; y0: number; size: number
  /** Total charge weight and its centre. */
  mass: number; cx: number; cy: number
  /** A leaf holds node indexes; an inner quad holds 4 children. */
  items: number[] | null
  kids: (Quad | null)[] | null
}

const LEAF_MAX = 4
const MAX_DEPTH = 24

function newQuad(x0: number, y0: number, size: number): Quad {
  return { x0, y0, size, mass: 0, cx: 0, cy: 0, items: [], kids: null }
}

function insert(q: Quad, i: number, nodes: SimNode[], depth: number): void {
  if (q.items) {
    if (q.items.length < LEAF_MAX || depth >= MAX_DEPTH) { q.items.push(i); return }
    const old = q.items
    q.items = null
    q.kids = [null, null, null, null]
    for (const j of old) insertKid(q, j, nodes, depth)
  }
  insertKid(q, i, nodes, depth)
}

function insertKid(q: Quad, i: number, nodes: SimNode[], depth: number): void {
  const h = q.size / 2
  const right = nodes[i].x >= q.x0 + h ? 1 : 0
  const down = nodes[i].y >= q.y0 + h ? 1 : 0
  const k = down * 2 + right
  let kid = q.kids![k]
  if (!kid) { kid = newQuad(q.x0 + right * h, q.y0 + down * h, h); q.kids![k] = kid }
  insert(kid, i, nodes, depth + 1)
}

function accumulate(q: Quad, nodes: SimNode[]): void {
  let m = 0, sx = 0, sy = 0
  if (q.items) {
    for (const i of q.items) { m += 1; sx += nodes[i].x; sy += nodes[i].y }
  } else {
    for (const kid of q.kids!) {
      if (!kid) continue
      accumulate(kid, nodes)
      m += kid.mass; sx += kid.cx * kid.mass; sy += kid.cy * kid.mass
    }
  }
  q.mass = m
  q.cx = m ? sx / m : 0
  q.cy = m ? sy / m : 0
}

function buildTree(nodes: SimNode[]): Quad {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y) }
  const size = Math.max(x1 - x0, y1 - y0, 1) + 1
  const root = newQuad(x0, y0, size)
  for (let i = 0; i < nodes.length; i++) insert(root, i, nodes, 0)
  accumulate(root, nodes)
  return root
}

function applyCharge(q: Quad, i: number, nodes: SimNode[], strength: number): void {
  if (!q.mass) return
  const n = nodes[i]
  let dx = q.cx - n.x
  let dy = q.cy - n.y
  let d2 = dx * dx + dy * dy
  // Far enough away: treat the whole quad as one body.
  if (!q.items && (q.size * q.size) / Math.max(d2, DIST_MIN2) < THETA2) {
    if (d2 < DIST_MIN2) d2 = DIST_MIN2
    const f = (strength * q.mass) / d2
    n.vx += dx * f; n.vy += dy * f
    return
  }
  if (q.items) {
    for (const j of q.items) {
      if (j === i) continue
      const o = nodes[j]
      dx = o.x - n.x; dy = o.y - n.y
      d2 = dx * dx + dy * dy
      // Two pages on the same spot: nudge them apart deterministically.
      if (d2 < DIST_MIN2) { dx = ((i - j) % 7 || 1) * 0.1; dy = ((i + j) % 5 || 1) * 0.1; d2 = DIST_MIN2 }
      const f = strength / d2
      n.vx += dx * f; n.vy += dy * f
    }
    return
  }
  for (const kid of q.kids!) if (kid) applyCharge(kid, i, nodes, strength)
}

/** One step of the simulation. Mutates `sim`. */
export function tick(sim: Simulation): void {
  const { nodes, links } = sim
  if (!nodes.length) { sim.alpha = 0; return }
  sim.alpha += (0 - sim.alpha) * ALPHA_DECAY
  const alpha = sim.alpha

  // Springs: pull linked pages toward LINK_DISTANCE, weaker for hubs so they don't collapse.
  for (const l of links) {
    const s = nodes[l.source], t = nodes[l.target]
    let dx = t.x + t.vx - s.x - s.vx
    let dy = t.y + t.vy - s.y - s.vy
    let d = Math.sqrt(dx * dx + dy * dy) || 0.01
    const strength = 1 / Math.max(1, Math.min(s.degree, t.degree))
    d = ((d - LINK_DISTANCE) / d) * alpha * strength
    dx *= d; dy *= d
    const bias = s.degree / (s.degree + t.degree || 1)
    t.vx -= dx * (1 - bias); t.vy -= dy * (1 - bias)
    s.vx += dx * bias; s.vy += dy * bias
  }

  // Many-body repulsion.
  const tree = buildTree(nodes)
  const strength = CHARGE * alpha
  for (let i = 0; i < nodes.length; i++) applyCharge(tree, i, nodes, strength)

  // Gravity toward the middle (keeps isolated pages in view).
  for (const n of nodes) { n.vx -= n.x * GRAVITY * alpha; n.vy -= n.y * GRAVITY * alpha }

  for (const n of nodes) {
    if (n.fx !== null && n.fy !== null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; continue }
    n.vx *= 1 - VELOCITY_DECAY; n.vy *= 1 - VELOCITY_DECAY
    n.x += n.vx; n.y += n.vy
  }
}

/** Run up to `maxTicks` steps or until the layout has settled. Returns the ticks run. */
export function settle(sim: Simulation, maxTicks = 300): number {
  if (!sim.nodes.length) { sim.alpha = 0; return 0 }
  let n = 0
  while (sim.alpha > ALPHA_MIN && n < maxTicks) { tick(sim); n++ }
  return n
}

/** Warm the layout back up (after a drag) so the neighbours follow. */
export function reheat(sim: Simulation, to = 0.3): void {
  sim.alpha = Math.max(sim.alpha, to)
}

export interface Bounds { x0: number; y0: number; x1: number; y1: number }

export function boundsOf(nodes: Array<{ x: number; y: number }>): Bounds {
  if (!nodes.length) return { x0: -1, y0: -1, x1: 1, y1: 1 }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y) }
  return { x0, y0, x1, y1 }
}

export interface View { x: number; y: number; k: number }

export const MIN_ZOOM = 0.08
export const MAX_ZOOM = 4

export function clampZoom(k: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, k))
}

/** The pan/zoom that fits `b` into a `w`×`h` box with `pad` pixels to spare. */
export function fitView(b: Bounds, w: number, h: number, pad = 40): View {
  const bw = Math.max(1, b.x1 - b.x0)
  const bh = Math.max(1, b.y1 - b.y0)
  const k = clampZoom(Math.min((w - pad * 2) / bw, (h - pad * 2) / bh, 1.6))
  return { k, x: w / 2 - ((b.x0 + b.x1) / 2) * k, y: h / 2 - ((b.y0 + b.y1) / 2) * k }
}

/** Zoom by `factor` keeping the screen point (px, py) still. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const k = clampZoom(v.k * factor)
  const f = k / v.k
  return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f }
}
