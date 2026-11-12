import { graphlib, layout } from '@dagrejs/dagre'
import type { Edge, Node } from '@xyflow/react'
import { analyzeFlow, declaredOrDefaultEffect, type RawNode } from '../../../shared/flow/analyze'
import type { FlowEffect, FlowNodeKind, FlowNodeRunStatus } from '../../../shared/flow/types'
import type { FlowNodeChange } from '../../../shared/flow/diff'

/**
 * okflow/1 definition → React Flow nodes + edges, laid out by dagre (viewer V2,
 * card B7, docs/design/WORKFLOWS.md §6.2). A pure function of the definition:
 * the layout is recomputed every time, so there is no stored layout to drift.
 *
 * Loops are GROUP nodes that contain their body. Layout is hierarchical: each
 * loop's body is laid out first (its own dagre graph), the loop then takes
 * that size as one node in the graph of its container. Children are positioned
 * relative to their loop (`parentId`), which is how React Flow nests nodes, so
 * nothing in a loop can overlap anything outside it.
 */

export const NODE_W = 236
export const NODE_H = 78
const GROUP_PAD_X = 24
const GROUP_MIN_W = 320
const GROUP_PAD_TOP = 52
const GROUP_PAD_BOTTOM = 20
const NODE_SEP = 36
const RANK_SEP = 46
const EDGE_LABEL_H = 18

export interface FlowNodeData extends Record<string, unknown> {
  id: string
  kind: FlowNodeKind | 'unknown'
  /** Effect class (`null` for structural nodes). */
  effect: FlowEffect | null
  /** First line: icon + kind + main subject. */
  title: string
  /** Secondary lines (tool slug, model/budget, approval…). */
  lines: string[]
  label?: string
  /** Send/spend approval wording, e.g. "owner-approved v3" / "approval each run" / "NOT APPROVED". */
  approval?: string
  status?: FlowNodeRunStatus
  change?: FlowNodeChange
  changeAuthor?: string
  /** Loops only: "12 iterations · 11 ok · 1 failed" from the selected run. */
  loopCounts?: string
  selected?: boolean
}

export type FlowRFNode = Node<FlowNodeData>

export interface BuildFlowGraphOptions {
  status?: Readonly<Record<string, FlowNodeRunStatus>>
  changes?: Readonly<Record<string, FlowNodeChange>>
  changeAuthor?: string
  /** Step rows of the selected run (for loop iteration counts). */
  steps?: readonly { node_id: string; iteration: number; attempt: number; status: string }[]
  /** Owner-approved send/spend node ids for this version (recorded approval). */
  approvedNodes?: readonly string[]
  version?: number
}

export interface FlowGraph {
  nodes: FlowRFNode[]
  edges: Edge[]
  width: number
  height: number
}

const KIND_ICON: Record<string, string> = {
  trigger: '⏰', tool: '🔧', mcp: '🔌', llm: '🧠', agent: '🤖', branch: '🔀', loop: '🔁', wait: '⏳', check: '✔', end: '⏹',
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const join = (...parts: (string | undefined | false)[]) => parts.filter(Boolean).join(' · ')

function describe(n: RawNode): { title: string; lines: string[] } {
  const icon = KIND_ICON[String(n.kind)] ?? '?'
  const retry = n.retry as { max?: unknown } | undefined
  const attempts = retry && num(retry.max) !== undefined ? `${retry.max} attempt${retry.max === 1 ? '' : 's'} max` : undefined
  switch (n.kind) {
    case 'trigger': {
      const sched = n.schedule as { cron?: unknown } | undefined
      return { title: `${icon} trigger · ${str(n.on) ?? '?'}`, lines: [str(sched?.cron) ?? str(n.event) ?? ''].filter(Boolean) }
    }
    case 'tool':
      return { title: `${icon} tool · ${str(n.tool) ?? '?'}`, lines: [join(attempts)].filter(Boolean) }
    case 'mcp':
      return { title: `${icon} MCP · ${str(n.connector) ?? '?'}.${str(n.tool) ?? '?'}`, lines: [join(attempts)].filter(Boolean) }
    case 'llm': {
      const it = num(n.max_iterations) ?? 1
      return {
        title: `${icon} LLM · ${n.id}`,
        lines: [join(str(n.model) && `model ${n.model}`, `${it} iteration${it === 1 ? '' : 's'}`,
          num(n.budget_usd) !== undefined && `$${n.budget_usd} cap`)],
      }
    }
    case 'agent':
      return { title: `${icon} agent session → card`, lines: [join(n.id, str(n.agent), num(n.budget_usd) !== undefined && `$${n.budget_usd} cap`)] }
    case 'branch': {
      const cases = Array.isArray(n.cases) ? n.cases.length : 0
      return { title: `${icon} branch · ${n.id}`, lines: [`${cases} case${cases === 1 ? '' : 's'}${n.default !== undefined ? ' + default' : ''}`] }
    }
    case 'check': {
      const asserts = Array.isArray(n.assert) ? (n.assert as { why?: unknown }[]) : []
      const why = asserts.map((a) => a && a.why).find((w): w is string => typeof w === 'string')
      return {
        title: `${icon} check · ${n.id}`,
        lines: [join(why ?? `${asserts.length} assert${asserts.length === 1 ? '' : 's'}`, n.on_fail !== undefined && `on fail: ${String(n.on_fail)}`)],
      }
    }
    case 'wait': {
      const appr = n.approval as { from?: unknown } | undefined
      const mode = appr ? `approval from ${str(appr.from) ?? '?'}`
        : n.for !== undefined ? `for ${String(n.for)}`
          : n.until !== undefined ? `until ${String(n.until)}`
            : n.event !== undefined ? `event ${String(n.event)}` : '?'
      return { title: `${icon} wait · ${n.id}`, lines: [mode] }
    }
    case 'loop': {
      const conc = num(n.concurrency)
      return {
        title: `${icon} loop · for each ${str(n.as) ?? '?'}`,
        lines: [join(num(n.max_items) !== undefined && `max ${n.max_items}`, conc !== undefined && conc > 1 && `${conc} parallel`)],
      }
    }
    case 'end':
      return { title: `${icon} end`, lines: [] }
    default:
      return { title: `? ${String(n.kind)} · ${n.id}`, lines: [] }
  }
}

interface Box { w: number; h: number }
interface Placed { x: number; y: number }

/** Loop iteration counts for the selected run: distinct iterations and how many ended failed. */
function loopCounts(
  members: Set<string>,
  steps: BuildFlowGraphOptions['steps'],
): string | undefined {
  if (!steps?.length) return undefined
  const latest = new Map<string, { iteration: number; attempt: number; status: string }>()
  for (const s of steps) {
    if (!members.has(s.node_id)) continue
    const k = `${s.node_id}#${s.iteration}`
    const prev = latest.get(k)
    if (!prev || s.attempt >= prev.attempt) latest.set(k, s)
  }
  if (latest.size === 0) return undefined
  // Per iteration: failed if any member's latest attempt failed, running if any is
  // still in flight (running / interrupted / unknown outcome), else ok.
  const state = new Map<number, 'ok' | 'running' | 'failed'>()
  for (const s of latest.values()) {
    const cur = state.get(s.iteration) ?? 'ok'
    const next = s.status === 'failed' ? 'failed' : s.status === 'succeeded' ? 'ok' : 'running'
    if (cur === 'failed' || (cur === 'running' && next === 'ok')) continue
    state.set(s.iteration, next)
  }
  const n = { ok: 0, running: 0, failed: 0 }
  for (const v of state.values()) n[v]++
  return [`${state.size} iteration${state.size === 1 ? '' : 's'}`, n.ok && `${n.ok} ok`, n.running && `${n.running} running`, n.failed && `${n.failed} failed`]
    .filter(Boolean).join(' · ')
}

export function buildFlowGraph(definition: { nodes?: unknown; version?: number } | null | undefined, opts: BuildFlowGraphOptions = {}): FlowGraph {
  const raw = (Array.isArray(definition?.nodes) ? definition!.nodes : []) as RawNode[]
  const byId = new Map<string, RawNode>()
  for (const n of raw) if (n && typeof n.id === 'string' && !byId.has(n.id)) byId.set(n.id, n)
  if (byId.size === 0) return { nodes: [], edges: [], width: 0, height: 0 }
  const an = analyzeFlow([...byId.values()])

  // Container = nearest enclosing loop (branch blocks are not containers).
  const containerOf = (id: string): string | null => {
    let o = an.owner.get(id) ?? null
    while (o !== null && byId.get(o)?.kind !== 'loop') o = an.owner.get(o) ?? null
    return o
  }
  const order = [...an.order, ...[...byId.keys()].filter((id) => !an.owner.has(id))]
  const members = new Map<string | null, string[]>()
  for (const id of order) {
    const c = an.owner.has(id) ? containerOf(id) : null
    const l = members.get(c) ?? []
    l.push(id)
    members.set(c, l)
  }
  const isGroup = (id: string) => byId.get(id)?.kind === 'loop' && (members.get(id)?.length ?? 0) > 0

  // Edges drawn = analyzer edges minus loop → first body member ("each": the body sits inside the group).
  const drawn = an.edges.filter((e) => !(byId.get(e.from)?.kind === 'loop' && e.label === 'each'))

  const size = new Map<string, Box>()
  const pos = new Map<string, Placed>() // top-left, relative to the container
  const layoutContainer = (cid: string | null): Box => {
    const ids = members.get(cid) ?? []
    for (const id of ids) if (isGroup(id)) layoutContainer(id)
    const g = new graphlib.Graph({ multigraph: true })
    g.setGraph({ rankdir: 'TB', nodesep: NODE_SEP, ranksep: RANK_SEP, edgesep: 16, marginx: 0, marginy: 0 })
    g.setDefaultEdgeLabel(() => ({}))
    const inHere = new Set(ids)
    for (const id of ids) {
      const box = isGroup(id) ? size.get(id)! : { w: NODE_W, h: NODE_H }
      size.set(id, box)
      g.setNode(id, { width: box.w, height: box.h })
    }
    drawn.forEach((e, i) => {
      if (!inHere.has(e.from) || !inHere.has(e.to)) return
      const lbl = e.label ? { width: Math.min(180, 7 * e.label.length + 12), height: EDGE_LABEL_H, labelpos: 'c' as const } : {}
      g.setEdge(e.from, e.to, lbl, `e${i}`)
    })
    layout(g)
    let w = 0
    let h = 0
    for (const id of ids) {
      const n = g.node(id) as { x: number; y: number; width: number; height: number }
      const p = { x: n.x - n.width / 2, y: n.y - n.height / 2 }
      pos.set(id, p)
      w = Math.max(w, p.x + n.width)
      h = Math.max(h, p.y + n.height)
    }
    if (cid !== null) {
      // Pad the group (wide enough for its header) and centre the body inside the frame.
      const box = { w: Math.max(GROUP_MIN_W, w + 2 * GROUP_PAD_X), h: h + GROUP_PAD_TOP + GROUP_PAD_BOTTOM }
      const dx = (box.w - w) / 2
      for (const id of ids) {
        const p = pos.get(id)!
        pos.set(id, { x: p.x + dx, y: p.y + GROUP_PAD_TOP })
      }
      size.set(cid, box)
      return box
    }
    return { w, h }
  }
  const total = layoutContainer(null)

  const approved = new Set(opts.approvedNodes ?? [])
  const nodes: FlowRFNode[] = []
  const emit = (cid: string | null) => {
    for (const id of members.get(cid) ?? []) {
      const n = byId.get(id)!
      const effect = declaredOrDefaultEffect(n)
      const d = describe(n)
      let approval: string | undefined
      if (n.kind !== 'trigger' && (effect === 'send' || effect === 'spend')) {
        approval = approved.has(id) ? `owner-approved v${opts.version ?? definition?.version ?? '?'}`
          : an.approvalWaitBefore.get(id) ? 'approval each run' : 'NOT APPROVED'
      }
      const box = size.get(id)!
      const group = isGroup(id)
      const kind = (typeof n.kind === 'string' ? n.kind : 'unknown') as FlowNodeData['kind']
      const loopMembers = group ? new Set([...an.enclosingLoops.entries()].filter(([, ls]) => ls.some((l) => l.id === id)).map(([k]) => k)) : null
      nodes.push({
        id,
        type: group ? 'flowLoop' : 'flowStep',
        position: pos.get(id)!,
        ...(cid !== null ? { parentId: cid, extent: 'parent' as const } : {}),
        data: {
          id,
          kind,
          effect,
          title: d.title,
          lines: d.lines.filter(Boolean),
          ...(typeof n.label === 'string' ? { label: n.label } : {}),
          ...(approval ? { approval } : {}),
          ...(opts.status?.[id] ? { status: opts.status[id] } : {}),
          ...(opts.changes?.[id] ? { change: opts.changes[id], changeAuthor: opts.changeAuthor } : {}),
          ...(loopMembers ? { loopCounts: loopCounts(loopMembers, opts.steps) } : {}),
        },
        width: box.w,
        height: box.h,
        style: { width: box.w, height: box.h },
        draggable: false,
        connectable: false,
        deletable: false,
        selectable: true,
      })
      if (group) emit(id) // a parent must precede its children in React Flow's node array
    }
  }
  emit(null)

  const edges: Edge[] = drawn.map((e, i) => ({
    id: `e${i}-${e.from}-${e.to}`,
    source: e.from,
    target: e.to,
    ...(e.label ? { label: e.label.length > 28 ? `${e.label.slice(0, 27)}…` : e.label } : {}),
    type: 'smoothstep',
    focusable: false,
    deletable: false,
    selectable: false,
    reconnectable: false,
    animated: opts.status?.[e.to] === 'running',
  }))

  return { nodes, edges, width: total.w, height: total.h }
}

/** Absolute (canvas) rectangle of every node — used by the no-overlap test and fit-to-view. */
export function absoluteRects(nodes: readonly FlowRFNode[]): Map<string, { x: number; y: number; w: number; h: number; parent: string | null }> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const out = new Map<string, { x: number; y: number; w: number; h: number; parent: string | null }>()
  const abs = (n: FlowRFNode): { x: number; y: number } => {
    if (!n.parentId) return n.position
    const p = abs(byId.get(n.parentId)!)
    return { x: p.x + n.position.x, y: p.y + n.position.y }
  }
  for (const n of nodes) {
    const a = abs(n)
    out.set(n.id, { x: a.x, y: a.y, w: Number(n.width), h: Number(n.height), parent: n.parentId ?? null })
  }
  return out
}
