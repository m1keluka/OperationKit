// Structural walk over an okflow/1 node list, shared by validateFlow() and
// definitionToMermaid(). Tolerates malformed input (it runs before/without
// shape validation) and never throws.
//
// Semantics (see types.ts): the top level is a chain from the trigger following
// `next`. `branch` cases/default and `loop` body are ordered blocks whose
// members have no `next`; a finished block rejoins at its owner's continuation.
// The only sanctioned cycle is a loop's implicit back-edge, so any other way of
// reaching a node that is already on the current path is a CYCLE.

import type { FlowEffect, FlowErrorCode } from './types.js'
import { FLOW_EFFECTS } from './types.js'

export type RawNode = Record<string, unknown> & { id: string; kind?: unknown }

export interface FlowEdge {
  from: string
  to: string
  label?: string
}

export interface StructuralIssue {
  code: Extract<FlowErrorCode, 'CYCLE' | 'MULTIPLE_INCOMING' | 'BLOCK_NODE_HAS_NEXT'>
  node_id: string
  message: string
}

export interface FlowAnalysis {
  /** Node ids reached from the trigger, in walk order. */
  order: string[]
  /** Owner (branch/loop id) of a node placed inside a block; `null` = top level. */
  owner: Map<string, string | null>
  /** Ids whose output is visible to a node (upstream on a control path, loop bodies excluded outside their loop). */
  availableBefore: Map<string, Set<string>>
  /** Enclosing loops, outermost first. */
  enclosingLoops: Map<string, { id: string; as: string }[]>
  /** True when an approval `wait` dominates the node (on every path from the trigger). */
  approvalWaitBefore: Map<string, boolean>
  edges: FlowEdge[]
  issues: StructuralIssue[]
  triggerId: string | null
}

interface Ctx {
  path: Set<string>
  avail: Set<string>
  loops: { id: string; as: string }[]
  approved: boolean
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strList = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

/** Branch blocks as `[label, member ids]`, cases first then default. */
export function branchBlocks(node: RawNode): { label: string; ids: string[]; isDefault: boolean }[] {
  const out: { label: string; ids: string[]; isDefault: boolean }[] = []
  const cases = Array.isArray(node.cases) ? node.cases : []
  for (const c of cases) {
    if (!c || typeof c !== 'object') continue
    const rec = c as Record<string, unknown>
    out.push({ label: str(rec.when) ?? '?', ids: strList(rec.then), isDefault: false })
  }
  if (node.default !== undefined) out.push({ label: 'default', ids: strList(node.default), isDefault: true })
  return out
}

export function blockMembers(node: RawNode): string[] {
  if (node.kind === 'loop') return strList(node.body)
  if (node.kind === 'branch') return branchBlocks(node).flatMap((b) => b.ids)
  return []
}

/** Declared effect if valid, else the per-kind default (§3.2). `null` = structural node, no effect. */
export function declaredOrDefaultEffect(node: RawNode): FlowEffect | null {
  if (!['trigger', 'tool', 'mcp', 'llm', 'agent'].includes(node.kind as string)) return null
  const e = node.effect
  if (typeof e === 'string' && (FLOW_EFFECTS as readonly string[]).includes(e)) return e as FlowEffect
  switch (node.kind) {
    case 'trigger': case 'llm': case 'agent': return 'read'
    case 'tool': case 'mcp': return 'send' // unknown ⇒ send
    default: return null
  }
}

export function isApprovalWait(node: RawNode | undefined): boolean {
  return !!node && node.kind === 'wait' && !!node.approval && typeof node.approval === 'object'
}

export function analyzeFlow(nodes: readonly RawNode[]): FlowAnalysis {
  const byId = new Map<string, RawNode>()
  for (const n of nodes) if (!byId.has(n.id)) byId.set(n.id, n)

  const a: FlowAnalysis = {
    order: [], owner: new Map(), availableBefore: new Map(), enclosingLoops: new Map(),
    approvalWaitBefore: new Map(), edges: [], issues: [], triggerId: null,
  }
  const edge = (from: string, to: string | null | undefined, label?: string) => {
    if (to && byId.has(to)) a.edges.push(label === undefined ? { from, to } : { from, to, label })
  }

  const walkBlock = (ids: string[], ctx: Ctx, cont: string | null, owner: string) => {
    ids.forEach((id, i) => {
      if (visit(id, ctx, i + 1 < ids.length ? ids[i + 1] : cont, owner) && byId.get(id)!.next !== undefined) {
        a.issues.push({ code: 'BLOCK_NODE_HAS_NEXT', node_id: id, message: `"${id}" is a member of "${owner}"'s block, so it must not declare "next" (control rejoins after the block)` })
      }
    })
  }

  const visit = (id: string, ctx: Ctx, cont: string | null, owner: string | null): boolean => {
    const n = byId.get(id)
    if (!n) return false // dangling: reported by the validator's edge pass
    if (ctx.path.has(id)) {
      a.issues.push({ code: 'CYCLE', node_id: id, message: `"${id}" is reached again on its own path — cycles are only allowed through a loop's body` })
      return false
    }
    if (a.owner.has(id)) {
      a.issues.push({ code: 'MULTIPLE_INCOMING', node_id: id, message: `"${id}" is reached from more than one place; each node has exactly one position (blocks rejoin automatically)` })
      return false
    }
    a.owner.set(id, owner)
    a.order.push(id)
    a.availableBefore.set(id, new Set(ctx.avail))
    a.enclosingLoops.set(id, [...ctx.loops])
    a.approvalWaitBefore.set(id, ctx.approved)
    ctx.path.add(id)

    if (n.kind === 'branch') {
      const blocks = branchBlocks(n)
      const subs: Ctx[] = []
      for (const b of blocks) {
        const sub: Ctx = { path: new Set(ctx.path), avail: new Set([...ctx.avail, id]), loops: ctx.loops, approved: ctx.approved }
        if (b.ids.length) {
          edge(id, b.ids[0], b.label)
          walkBlock(b.ids, sub, cont, id)
        } else edge(id, cont, b.label)
        subs.push(sub)
      }
      const hasDefault = blocks.some((b) => b.isDefault)
      if (!hasDefault) edge(id, cont, 'else')
      for (const s of subs) {
        s.path.forEach((x) => ctx.path.add(x))
        s.avail.forEach((x) => ctx.avail.add(x))
      }
      ctx.avail.add(id)
      ctx.approved = ctx.approved || (hasDefault && subs.length > 0 && subs.every((s) => s.approved))
    } else if (n.kind === 'loop') {
      const body = strList(n.body)
      const as = str(n.as) ?? ''
      const sub: Ctx = { path: new Set(ctx.path), avail: new Set(ctx.avail), loops: [...ctx.loops, { id, as }], approved: ctx.approved }
      if (body.length) {
        edge(id, body[0], 'each')
        walkBlock(body, sub, null, id)
      }
      sub.path.forEach((x) => ctx.path.add(x))
      ctx.avail.add(id) // body outputs are per-iteration: only the loop's own output is visible after it
      edge(id, cont)
    } else {
      ctx.avail.add(id)
      if (isApprovalWait(n)) ctx.approved = true
      if (n.kind !== 'end') edge(id, cont)
    }
    return true
  }

  const trigger = nodes.find((n) => n.kind === 'trigger')
  if (trigger) {
    a.triggerId = trigger.id
    const ctx: Ctx = { path: new Set(), avail: new Set(), loops: [], approved: false }
    let cur: string | undefined = trigger.id
    while (cur !== undefined) {
      const n = byId.get(cur)
      if (!n) break
      const next = str(n.next)
      if (!visit(cur, ctx, next ?? null, null) || n.kind === 'end') break
      cur = next
    }
  }
  return a
}
