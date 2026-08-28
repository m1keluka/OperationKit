import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Plus, Minus, Crosshair, Network } from 'lucide-react'
import { Badge, Button, IconButton, EmptyState, Skeleton, cn } from './ui'

/**
 * Skill Graph — the OperationKit three-layer graph, rendered from the
 * okit-validated frontmatter layer graph served by GET /api/admin/skill-graph.
 *
 * Agents (outer ring) -> Skills (middle ring) -> Tools (inner ring). Every edge
 * drawn here is a DECLARED edge: an agent's `skills:` frontmatter or a skill's
 * `tools:` frontmatter. Nothing is inferred.
 *
 * Before obj 707012 this canvas laid skills out in concentric rings by `tier`
 * and drew skill->skill `depends_on` edges, both sourced from a hand-maintained
 * block in skills/registry.json that no validator checked and that had drifted
 * badly (11 agents where there are 19, dangling targets). That block is gone;
 * `tier` and skill->skill dependency do not exist in the frontmatter layer, so
 * they are not rendered rather than being kept alive on stale data.
 *
 * Canvas needs literal color values, so layer colors are read from the design
 * tokens' CSS custom properties at draw time — no hex lives in this file, and
 * the graph follows the accent theme like the rest of the chrome.
 */

// ── Types (mirror services/skill-graph.ts) ──

interface GraphAgent {
  always: string[]
  available: string[]
}

interface GraphSkill {
  depth: number
  parent: string | null
  subskills: string[]
  tools: string[]
  agents_always: string[]
  agents_available: string[]
  description?: string
  usage_count?: number
  failure_count?: number
  needs_improvement?: boolean
}

interface SkillGraphPayload {
  source: string
  generated_at: string
  counts: {
    agents: number
    skills: number
    skills_top_level: number
    subskills: number
    tools: number
    agent_skill_edges: number
    skill_tool_edges: number
  }
  agents: Record<string, GraphAgent>
  skills: Record<string, GraphSkill>
  tools: Record<string, { skills: string[] }>
  orphans: { tools: string[]; skills: string[] }
}

type Layer = 'agent' | 'skill' | 'tool'

interface GraphNode {
  id: string
  slug: string
  label: string
  layer: Layer
  x: number
  y: number
  /** Radians from the origin — used to park an agent's label clear of the ring. */
  angle: number
  radius: number
  needsImprovement?: boolean
  description?: string
  detail: string
}

interface GraphEdge {
  from: string
  to: string
  /** `available` renders dashed — a load-on-demand edge, not an always-loaded one. */
  kind: 'always' | 'available' | 'tool'
}

/** Layer colors resolved from the token CSS variables (see index.css §01/§04). */
interface Palette {
  agent: string
  skill: string
  tool: string
  alarm: string
  label: string
  labelDim: string
}

function readPalette(el: HTMLElement | null): Palette {
  const cs = getComputedStyle(el ?? document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    agent: v('--st-working', 'currentColor'),
    skill: v('--accent', 'currentColor'),
    tool: v('--ok-verify', 'currentColor'),
    alarm: v('--ok-alarm', 'currentColor'),
    label: v('--fg-0', 'currentColor'),
    labelDim: v('--fg-3', 'currentColor'),
  }
}

/** Blend a hex/rgb token color with an alpha, for dim + glow passes. */
function withAlpha(color: string, alpha: number): string {
  const hex = color.replace('#', '')
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const n = parseInt(hex, 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const [r, g, b] = hex.split('').map(c => parseInt(c + c, 16))
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return color
}

// ── Layout ──

// The layout origin is (0,0); the canvas translates it to the container centre,
// so ring radii can grow with the node count without a hardcoded viewbox.
const NODE_R: Record<Layer, number> = { agent: 19, skill: 8, tool: 8 }
/** Clear space between adjacent nodes ON a ring, in layout units. */
const NODE_GAP: Record<Layer, number> = { agent: 34, skill: 15, tool: 15 }
/** Minimum clear space BETWEEN rings, so edges are legible rather than hidden. */
const RING_GAP = 150

/**
 * Ring radius from the node count, not a constant.
 *
 * A fixed radius is what made this unreadable: 81 skills on a 265-unit ring
 * packed into a solid band with every edge buried underneath. Sizing the ring to
 * its own circumference guarantees the declared gap between neighbours whatever
 * the workspace grows to.
 */
function ringRadius(count: number, layer: Layer, min: number): number {
  const needed = (count * (2 * NODE_R[layer] + NODE_GAP[layer])) / (2 * Math.PI)
  return Math.max(min, needed)
}

function layoutGraph(data: SkillGraphPayload): { nodes: GraphNode[]; edges: GraphEdge[]; extent: number } {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const toolSlugs = Object.keys(data.tools).sort()
  // Alphabetical keeps a sub-skill (`parent/child`) adjacent to its parent, so
  // the nesting reads off the ring without a special case.
  const skillSlugs = Object.keys(data.skills).sort()
  const agentSlugs = Object.keys(data.agents).sort()

  const rTool = ringRadius(toolSlugs.length, 'tool', 140)
  const rSkill = ringRadius(skillSlugs.length, 'skill', rTool + RING_GAP)
  const rAgent = ringRadius(agentSlugs.length, 'agent', rSkill + RING_GAP)

  const place = (i: number, n: number, radius: number, phase = 0) => {
    const angle = (i / Math.max(n, 1)) * 2 * Math.PI - Math.PI / 2 + phase
    return { angle, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  }

  toolSlugs.forEach((slug, i) => {
    const consumers = data.tools[slug].skills
    nodes.push({
      id: `tool:${slug}`, slug, label: slug, layer: 'tool',
      ...place(i, toolSlugs.length, rTool), radius: NODE_R.tool,
      detail: `${consumers.length} skill${consumers.length === 1 ? '' : 's'} declare this tool`,
    })
  })

  skillSlugs.forEach((slug, i) => {
    const s = data.skills[slug]
    const consumers = s.agents_always.length + s.agents_available.length
    nodes.push({
      id: `skill:${slug}`, slug, label: slug, layer: 'skill',
      ...place(i, skillSlugs.length, rSkill),
      // A sub-skill sits a touch smaller than its parent — the only depth cue
      // the frontmatter layer actually supports.
      radius: s.depth > 1 ? NODE_R.skill - 2 : NODE_R.skill,
      needsImprovement: s.needs_improvement,
      description: s.description,
      detail: `${consumers} agent${consumers === 1 ? '' : 's'} · ${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}`,
    })
    for (const t of s.tools) {
      if (data.tools[t]) edges.push({ from: `skill:${slug}`, to: `tool:${t}`, kind: 'tool' })
    }
  })

  agentSlugs.forEach((slug, i) => {
    const a = data.agents[slug]
    nodes.push({
      id: `agent:${slug}`, slug, label: slug.replace(/-/g, ' '), layer: 'agent',
      ...place(i, agentSlugs.length, rAgent), radius: NODE_R.agent,
      detail: `${a.always.length} always-loaded · ${a.available.length} available`,
    })
    for (const s of a.always) {
      if (data.skills[s]) edges.push({ from: `agent:${slug}`, to: `skill:${s}`, kind: 'always' })
    }
    for (const s of a.available) {
      if (data.skills[s]) edges.push({ from: `agent:${slug}`, to: `skill:${s}`, kind: 'available' })
    }
  })

  // Outer ring plus room for the agent labels parked outside it.
  return { nodes, edges, extent: rAgent + 110 }
}

/** Zoom bounds: out far enough to frame the whole graph, in far enough to read a slug. */
const ZOOM_MIN = 0.15
const ZOOM_MAX = 4
const clampZoom = (z: number) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z))

// ── Canvas ──

function GraphCanvas({ data }: { data: SkillGraphPayload }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [hovered, setHovered] = useState<GraphNode | null>(null)
  const [selected, setSelected] = useState<GraphNode | null>(null)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  // 0 = "not measured yet"; the fit effect sets the real value once the
  // container has a size, so the graph always opens fully in frame.
  const [zoom, setZoom] = useState(0)
  const [dragging, setDragging] = useState(false)

  const graph = useMemo(() => layoutGraph(data), [data])
  const fitZoom = useCallback(() => {
    const el = containerRef.current
    if (!el) return 1
    const { width, height } = el.getBoundingClientRect()
    if (!width || !height) return 1
    return Math.min(width, height) / (2 * graph.extent)
  }, [graph])
  const nodeById = useMemo(
    () => new Map(graph.nodes.map(n => [n.id, n])),
    [graph],
  )
  const neighbors = useMemo(() => {
    if (!selected) return null
    const set = new Set<string>()
    for (const e of graph.edges) {
      if (e.from === selected.id) set.add(e.to)
      if (e.to === selected.id) set.add(e.from)
    }
    return set
  }, [graph, selected])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !zoom) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const palette = readPalette(canvas)
    const layerColor = (l: Layer) => (l === 'agent' ? palette.agent : l === 'skill' ? palette.skill : palette.tool)

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)
    ctx.save()
    ctx.translate(pan.x + rect.width / 2, pan.y + rect.height / 2)
    ctx.scale(zoom, zoom)

    // Stroke widths are specified in SCREEN pixels and divided by the zoom, so a
    // hairline stays a hairline instead of collapsing to sub-pixel (and vanishing)
    // when the whole graph is fitted into view.
    const px = (n: number) => n / zoom

    for (const edge of graph.edges) {
      const a = nodeById.get(edge.from)
      const b = nodeById.get(edge.to)
      if (!a || !b) continue
      const lit = !!selected && (edge.from === selected.id || edge.to === selected.id)
      const dim = !!selected && !lit
      const base = edge.kind === 'tool' ? palette.tool : palette.agent
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      // Resting edges are tinted by their own layer rather than drawn in the
      // neutral hairline color: on this surface a `--line-strong` stroke at low
      // alpha is indistinguishable from the background, which read as "no edges".
      ctx.strokeStyle = withAlpha(base, dim ? 0.06 : lit ? 0.95 : 0.3)
      ctx.lineWidth = px(lit ? 1.6 : 0.7)
      ctx.setLineDash(edge.kind === 'available' ? [px(3), px(4)] : [])
      ctx.stroke()
    }
    ctx.setLineDash([])

    for (const node of graph.nodes) {
      const isSelected = selected?.id === node.id
      const isNeighbor = !!neighbors?.has(node.id)
      const isHovered = hovered?.id === node.id
      const dim = !!selected && !isSelected && !isNeighbor
      const color = layerColor(node.layer)

      if (isSelected || isHovered) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, node.radius + 7, 0, Math.PI * 2)
        ctx.fillStyle = withAlpha(color, 0.18)
        ctx.fill()
      }
      if (node.needsImprovement && !dim) {
        ctx.beginPath()
        ctx.arc(node.x, node.y, node.radius + 3.5, 0, Math.PI * 2)
        ctx.strokeStyle = palette.alarm
        ctx.lineWidth = px(1.75)
        ctx.stroke()
      }

      ctx.beginPath()
      ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2)
      ctx.fillStyle = withAlpha(color, dim ? 0.14 : 0.82)
      ctx.fill()
      ctx.strokeStyle = withAlpha(color, dim ? 0.2 : 1)
      ctx.lineWidth = px(isSelected ? 2.5 : 1.25)
      ctx.stroke()

      // Agent labels are parked OUTSIDE the ring, aligned away from the centre,
      // so they read in full instead of being truncated to fit inside a circle.
      // Skill/tool labels would be a hairball at rest, so they appear only for
      // the node you are pointing at or the neighbourhood you selected.
      const labelled =
        node.layer === 'agent' || isHovered || isSelected || (isNeighbor && node.layer !== 'tool')
      if (labelled) {
        const outward = node.layer === 'agent'
        // Type is sized in SCREEN pixels for the same reason strokes are: a label
        // measured in layout units is illegible at fit-zoom.
        ctx.font = `${outward ? '600 ' : ''}${px(outward ? 10 : 9)}px "Geist Mono", ui-monospace, monospace`
        ctx.textBaseline = 'middle'
        ctx.fillStyle = withAlpha(palette.label, dim ? 0.3 : 0.95)
        const right = Math.cos(node.angle) >= 0
        const off = node.radius + px(7)
        ctx.textAlign = right ? 'left' : 'right'
        ctx.fillText(node.label, node.x + (right ? off : -off), node.y)
      }
    }

    ctx.restore()
  }, [graph, nodeById, neighbors, pan, zoom, hovered, selected])

  useEffect(() => { draw() }, [draw])

  // Fit on first measure and whenever the graph changes, so the whole thing is
  // in frame without the operator hunting for it.
  useEffect(() => { setZoom(fitZoom()); setPan({ x: 0, y: 0 }) }, [fitZoom])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => {
      setZoom(z => (z ? z : fitZoom()))
      draw()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [draw, fitZoom])

  function findNodeAt(clientX: number, clientY: number): GraphNode | null {
    const canvas = canvasRef.current
    if (!canvas || !zoom) return null
    const rect = canvas.getBoundingClientRect()
    const x = (clientX - rect.left - pan.x - rect.width / 2) / zoom
    const y = (clientY - rect.top - pan.y - rect.height / 2) / zoom
    for (let i = graph.nodes.length - 1; i >= 0; i--) {
      const n = graph.nodes[i]
      const dx = x - n.x
      const dy = y - n.y
      // Generous hit slop so small tool nodes stay reachable on touch.
      // Hit slop scales with zoom so a small node stays reachable when zoomed out.
      const r = n.radius + 6 / Math.max(zoom, 0.2)
      if (dx * dx + dy * dy <= r * r) return n
    }
    return null
  }

  function handleMouseMove(e: React.MouseEvent) {
    if (dragging) {
      setPan(p => ({ x: p.x + e.movementX, y: p.y + e.movementY }))
      return
    }
    const node = findNodeAt(e.clientX, e.clientY)
    setHovered(node)
    if (canvasRef.current) canvasRef.current.style.cursor = node ? 'pointer' : 'grab'
  }

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        onMouseMove={handleMouseMove}
        onClick={e => {
          const node = findNodeAt(e.clientX, e.clientY)
          setSelected(prev => (prev?.id === node?.id ? null : node))
        }}
        onWheel={e => setZoom(z => clampZoom(z * (e.deltaY > 0 ? 0.9 : 1.1)))}
        onMouseDown={e => { if (!findNodeAt(e.clientX, e.clientY)) setDragging(true) }}
        onMouseUp={() => setDragging(false)}
        onMouseLeave={() => { setDragging(false); setHovered(null) }}
      />

      {hovered && !selected && (
        <NodeCard node={hovered} className="pointer-events-none left-3 top-3 max-w-[15rem]" />
      )}

      {selected && (
        <NodeCard
          node={selected}
          onClose={() => setSelected(null)}
          className="right-3 top-3 w-[17rem] max-h-[calc(100%-1.5rem)] overflow-y-auto"
        />
      )}

      {/* Legend */}
      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-line bg-surface-1/90 px-3 py-2 text-[11px] backdrop-blur">
        <LegendDot layer="agent" label="agent" />
        <LegendDot layer="skill" label="skill" />
        <LegendDot layer="tool" label="tool" />
        <span className="flex items-center gap-1.5 border-l border-line pl-3 text-fg-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-signal-alarm" />
          needs work
        </span>
        <span className="text-fg-2">dashed = load-on-demand</span>
      </div>

      {/* Controls */}
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-line bg-surface-1/90 p-1 backdrop-blur">
        {/* Disabled AT the clamp, so pressing a button that cannot move the view
            reads as unavailable instead of silently doing nothing. */}
        <IconButton label="Zoom in" disabled={zoom >= ZOOM_MAX}
          onClick={() => setZoom(z => clampZoom(z * 1.2))}>
          <Plus className="h-4 w-4" />
        </IconButton>
        <IconButton label="Zoom out" disabled={zoom > 0 && zoom <= ZOOM_MIN}
          onClick={() => setZoom(z => clampZoom(z * 0.8))}>
          <Minus className="h-4 w-4" />
        </IconButton>
        <IconButton label="Fit to view" onClick={() => { setZoom(fitZoom()); setPan({ x: 0, y: 0 }); setSelected(null) }}>
          <Crosshair className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  )
}

const LAYER_DOT: Record<Layer, string> = {
  agent: 'bg-status-working',
  skill: 'bg-accent',
  tool: 'bg-signal-verify',
}
const LAYER_TONE = { agent: 'info', skill: 'accent', tool: 'verify' } as const

function LegendDot({ layer, label }: { layer: Layer; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-fg-2">
      <span className={cn('inline-block h-2.5 w-2.5 rounded-full', LAYER_DOT[layer])} />
      {label}
    </span>
  )
}

/** Hover tooltip and click-through detail share one card so the two readings agree. */
function NodeCard({ node, onClose, className }: { node: GraphNode; onClose?: () => void; className?: string }) {
  return (
    <div className={cn('absolute rounded-lg border border-line bg-surface-2 p-3 shadow-float cc-land', className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={LAYER_TONE[node.layer]}>{node.layer}</Badge>
            {node.needsImprovement && <Badge tone="alarm">needs work</Badge>}
          </div>
          <div className="mt-1.5 break-words font-mono text-[12px] font-medium text-fg-0">{node.slug}</div>
        </div>
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close detail">Close</Button>
        )}
      </div>
      <p className="mt-1 text-[11px] text-fg-2">{node.detail}</p>
      {node.description && (
        <p className="mt-2 line-clamp-4 text-[11px] leading-relaxed text-fg-2">{node.description}</p>
      )}
    </div>
  )
}

// ── Main export ──

export function SkillGraphTab() {
  const [data, setData] = useState<SkillGraphPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/admin/skill-graph', { credentials: 'include' })
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body.error || 'Failed to load the skill graph')
        }
        return r.json()
      })
      .then((payload: SkillGraphPayload | null) => {
        // A 200 carrying the OLD registry shape must land in the EmptyState, not
        // in the render. `self-deploy.sh frontend` ships this client with NO
        // backend restart, so between a frontend-only deploy and the next
        // restart the previous server answers here with `{version, skills,
        // schema}` — no `counts`, no `agents`. Reading `data.counts.agents` off
        // that throws and takes the whole tab down with an ErrorBoundary.
        if (!payload?.counts || !payload.agents || !payload.skills || !payload.tools) {
          throw new Error('The skill-graph API returned an unrecognised payload. '
            + 'If the frontend was just deployed, the server still needs a restart.')
        }
        return payload
      })
      .then(setData)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-56" />
        </div>
        <div className="grid flex-1 place-items-center p-6">
          <Skeleton className="aspect-square w-full max-w-[520px] rounded-full" />
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="grid h-full place-items-center p-6">
        <EmptyState
          icon={<Network className="h-5 w-5" />}
          title="Skill graph unavailable"
          description={error || 'The layer graph returned no data.'}
        />
      </div>
    )
  }

  const c = data.counts
  return (
    <div className="flex h-full min-h-[520px] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <h3 className="font-display text-[14px] font-semibold text-fg-0">Skill Graph</h3>
          <span className="font-mono text-[11px] text-fg-2">
            {c.agents} agents · {c.skills} skills · {c.tools} tools
          </span>
          <span className="font-mono text-[11px] text-fg-2">
            {c.agent_skill_edges} agent→skill · {c.skill_tool_edges} skill→tool
          </span>
          <Badge tone="verify">{data.source}</Badge>
        </div>
        <span className="text-[11px] text-fg-2">Drag to pan · scroll to zoom · click a node to inspect</span>
      </div>
      <div className="min-h-0 flex-1">
        <GraphCanvas data={data} />
      </div>
    </div>
  )
}
