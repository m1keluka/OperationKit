// Version diff for the read-only viewer (card B7, docs/design/WORKFLOWS.md §6.2
// "Versions": nodes changed vs the previous version are tagged).
//
// A pure function of two stored definitions, compared node by node on the
// stable node `id`. Key order inside a node never counts as a change (the
// comparison is on canonical JSON), so re-serialising a version cannot light up
// every node.

import type { FlowDefinition } from './types.js'

export type FlowNodeChange = 'added' | 'changed'

export interface FlowNodeDiff {
  /** Node ids present in `next` but not in `prev`. */
  added: string[]
  /** Node ids present in both whose definition differs. */
  changed: string[]
  /** Node ids present in `prev` but not in `next` (cannot be drawn: listed in a caption). */
  removed: string[]
  /** Per drawn node: `added` | `changed`. Unchanged nodes are absent. */
  byNode: Record<string, FlowNodeChange>
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v ?? null)
}

function nodeMap(def: Pick<FlowDefinition, 'nodes'> | null | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const n of Array.isArray(def?.nodes) ? def!.nodes : []) {
    if (n && typeof n.id === 'string' && !out.has(n.id)) out.set(n.id, canonical(n))
  }
  return out
}

/** Which nodes of `next` were added or changed relative to `prev`, and which were removed. */
export function diffFlowNodes(
  prev: Pick<FlowDefinition, 'nodes'> | null | undefined,
  next: Pick<FlowDefinition, 'nodes'> | null | undefined,
): FlowNodeDiff {
  const a = nodeMap(prev)
  const b = nodeMap(next)
  const out: FlowNodeDiff = { added: [], changed: [], removed: [], byNode: {} }
  for (const [id, json] of b) {
    if (!a.has(id)) { out.added.push(id); out.byNode[id] = 'added' }
    else if (a.get(id) !== json) { out.changed.push(id); out.byNode[id] = 'changed' }
  }
  for (const id of a.keys()) if (!b.has(id)) out.removed.push(id)
  return out
}
