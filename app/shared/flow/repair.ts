// Auto-debug: the SAFE-CLASS classifier, failure signatures and definition rot
// (card B8, docs/design/WORKFLOWS.md §5.3). Pure; shared by the server's repair
// watcher, its tests and the viewer.
//
// A repair patch may be AUTO-APPLIED only when every change it makes is on the
// safe list. Anything else — and anything the classifier does not recognise —
// goes to Needs Review. The classifier compares the definition BEFORE and AFTER
// the patch (not the patch text), so two patches that produce the same document
// always get the same verdict however they are spelled.
//
// Safe (may auto-apply), §5.3:
//   - a node's `input` / `arguments` mapping (tool / mcp nodes that are not send/spend)
//   - a node's `retry` / `timeout_ms` (not on a send/spend node)
//   - a `branch` case condition (`when`)
//   - a `loop.max_items` DECREASE
//   - an `llm` `prompt` or `output_schema`
//   - ADD a read-only `tool` / `mcp` node (declared `effect: "read"`, a Tool or
//     connector the flow already uses), or ADD a `check`
//   - re-wiring that only INSERTS such an added node into an existing sequence or block
//   - lowering `budget.*` (never raising it)
//
// Never auto-applied (always Needs Review):
//   - anything that adds, removes or changes a send/spend node (any field) — an
//     agent node always counts as spend
//   - adds a connector or Tool not already used
//   - raises any budget, cap or `loop.max_items`
//   - touches `approvals`, `workspace`, the `trigger`, or `goal` in ANY way —
//     a repair may never weaken the end condition to make its own test pass
//   - edits an existing `check` (its asserts are the flow's own guard rails)
//   - anything else not on the safe list (a removed node, a changed kind, a
//     changed Tool slug, a mock, fixtures …)

import { declaredOrDefaultEffect, type RawNode } from './analyze.js'
import type { FlowDefinition, FlowEffect } from './types.js'

export const REPAIR_BLOCKER_CODES = [
  'goal_changed', 'approvals_changed', 'workspace_changed', 'trigger_changed', 'document_field_changed',
  'budget_raised', 'send_spend_node_changed', 'node_removed', 'node_kind_changed', 'node_added_not_safe',
  'new_tool', 'new_connector', 'tool_changed', 'connector_changed', 'effect_changed', 'loop_max_items_raised',
  'check_changed', 'field_not_safe', 'rewire_not_insertion', 'invalid_definition', 'send_route_changed',
] as const
export type RepairBlockerCode = (typeof REPAIR_BLOCKER_CODES)[number]

export interface RepairBlocker {
  code: RepairBlockerCode
  /** Node id, or a document field like `goal` / `budget.repair_usd`. */
  where: string
  message: string
}

export interface RepairSafeChange {
  where: string
  what: string
}

export interface RepairClassification {
  /** True only when `blockers` is empty AND at least one change was made. */
  safe: boolean
  changes: RepairSafeChange[]
  blockers: RepairBlocker[]
}

export interface ClassifyRepairOptions {
  /** Registry effect of a Tool slug (so an added node cannot understate its effect). Unknown ⇒ skipped. */
  toolEffect?: (slug: string) => FlowEffect | undefined
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v ?? null)
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)

/**
 * send / spend by declaration or default; `agent` always spends (it files a card);
 * a Tool whose REGISTRY effect is send/spend counts too, whatever the node declares.
 */
function isSendSpend(n: RawNode, toolEffect?: (slug: string) => FlowEffect | undefined): boolean {
  if (n.kind === 'agent') return true
  const e = declaredOrDefaultEffect(n)
  if (e === 'send' || e === 'spend') return true
  if (n.kind === 'tool' && toolEffect) {
    const reg = toolEffect(String(n.tool))
    if (reg === 'send' || reg === 'spend') return true
  }
  return false
}

/**
 * Is this tool / mcp step PROVABLY read-only? A declared `effect: "read"` is just
 * text a repair agent typed, so it counts only when the same Tool (or the same
 * connector + MCP tool pair) is already used by a read step of the `before`
 * definition the owner published — and, for a Tool, its registry effect (when
 * known) is `read`. Used by the classifier for ADDED steps and by the engine's
 * replay, which stubs an added/changed step that is not proven read (so a replay
 * can never really send through a step that merely claims to be a read).
 */
export function isProvenReadStep(node: unknown, before: FlowDefinition, toolEffect?: (slug: string) => FlowEffect | undefined): boolean {
  if (!isObj(node) || node.effect !== 'read') return false
  const prior = nodesOf(before)
  if (node.kind === 'tool') {
    const slug = String(node.tool)
    const reg = toolEffect?.(slug)
    if (reg !== undefined && reg !== 'read') return false
    return prior.some((b) => b.kind === 'tool' && String(b.tool) === slug && declaredOrDefaultEffect(b) === 'read')
  }
  if (node.kind === 'mcp') {
    return prior.some((b) => b.kind === 'mcp' && String(b.connector) === String(node.connector) && String(b.tool) === String(node.tool)
      && declaredOrDefaultEffect(b) === 'read')
  }
  return false
}

/** Ids of nodes inside a branch's blocks (nested branches included). */
function branchReach(n: RawNode, byId: Map<string, RawNode>, out = new Set<string>()): Set<string> {
  const ids = [...(Array.isArray(n.cases) ? n.cases.flatMap((c) => (isObj(c) ? asList(c.then) : [])) : []), ...asList(n.default)]
  for (const id of ids) {
    if (out.has(id)) continue
    out.add(id)
    const m = byId.get(id)
    if (m?.kind === 'branch') branchReach(m, byId, out)
  }
  return out
}

function nodesOf(def: unknown): RawNode[] {
  const nodes = isObj(def) && Array.isArray(def.nodes) ? def.nodes : []
  return nodes.filter((n): n is RawNode => isObj(n) && typeof n.id === 'string')
}

/** Safe fields per kind (besides `label`, and `next` / block lists checked as insertions). */
const SAFE_FIELDS: Record<string, readonly string[]> = {
  tool: ['input', 'retry', 'timeout_ms'],
  mcp: ['arguments', 'retry', 'timeout_ms'],
  llm: ['prompt', 'output_schema', 'retry', 'timeout_ms'],
  branch: [],
  loop: [],
  check: [],
  wait: [],
  agent: [],
  trigger: [],
  end: [],
}

const DOC_FIELDS_HANDLED = new Set(['nodes', 'goal', 'approvals', 'workspace', 'budget', 'version'])

/**
 * Classify the change from `before` to `after` (both full okflow/1 documents;
 * `after` is `before` with the repair patch applied). `version` is ignored: the
 * server assigns the draft's version number itself.
 */
export function classifyRepairPatch(before: FlowDefinition, after: FlowDefinition, opts: ClassifyRepairOptions = {}): RepairClassification {
  const changes: RepairSafeChange[] = []
  const blockers: RepairBlocker[] = []
  const block = (code: RepairBlockerCode, where: string, message: string) => blockers.push({ code, where, message })
  const b = before as unknown as Record<string, unknown>
  const a = after as unknown as Record<string, unknown>

  // ── document-level fields ────────────────────────────────────────────────
  if (!same(b.goal, a.goal)) block('goal_changed', 'goal', 'the goal / end condition may never be changed by a repair')
  if (!same(b.approvals, a.approvals)) block('approvals_changed', 'approvals', 'approvals are recorded by the owner only')
  if (!same(b.workspace, a.workspace)) block('workspace_changed', 'workspace', 'the workspace may not be changed')
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (DOC_FIELDS_HANDLED.has(k)) continue
    if (!same(b[k], a[k])) block('document_field_changed', k, `"${k}" is not something a repair may change`)
  }
  const bb = isObj(b.budget) ? b.budget : {}
  const ab = isObj(a.budget) ? a.budget : {}
  for (const k of new Set([...Object.keys(bb), ...Object.keys(ab)])) {
    const was = bb[k]
    const now = ab[k]
    if (same(was, now)) continue
    const lowered = typeof was === 'number' && typeof now === 'number' && now < was && now >= 0
    if (lowered) changes.push({ where: `budget.${k}`, what: `lowered ${was} → ${now}` })
    else block('budget_raised', `budget.${k}`, `budget.${k} may only be lowered by a repair (${String(was)} → ${String(now)})`)
  }

  // ── nodes ────────────────────────────────────────────────────────────────
  const beforeNodes = nodesOf(before)
  const afterNodes = nodesOf(after)
  const bById = new Map(beforeNodes.map((n) => [n.id, n]))
  const aById = new Map(afterNodes.map((n) => [n.id, n]))
  const usedTools = new Set(beforeNodes.filter((n) => n.kind === 'tool' || n.kind === 'llm').flatMap((n) =>
    n.kind === 'tool' ? [String(n.tool)] : Array.isArray(n.tools) ? n.tools.map(String) : []))
  const usedConnectors = new Set(beforeNodes.filter((n) => n.kind === 'mcp').map((n) => String(n.connector)))

  const added = new Set<string>()
  for (const n of afterNodes) {
    if (bById.has(n.id)) continue
    added.add(n.id)
    if (n.kind === 'check') {
      changes.push({ where: n.id, what: 'added a check' })
      continue
    }
    if (n.kind === 'tool' || n.kind === 'mcp') {
      const declared = n.effect
      if (declared !== 'read') {
        block('node_added_not_safe', n.id, `added ${n.kind} node "${n.id}" is not declared effect "read"`)
        continue
      }
      if (n.kind === 'tool') {
        const slug = String(n.tool)
        if (!usedTools.has(slug)) { block('new_tool', n.id, `added node "${n.id}" uses Tool "${slug}", which the flow did not use`); continue }
        const reg = opts.toolEffect?.(slug)
        if (reg !== undefined && reg !== 'read') { block('node_added_not_safe', n.id, `Tool "${slug}" is "${reg}" in the registry, not read-only`); continue }
      } else if (!usedConnectors.has(String(n.connector))) {
        block('new_connector', n.id, `added node "${n.id}" uses connector "${String(n.connector)}", which the flow did not use`)
        continue
      }
      if (!isProvenReadStep(n, before, opts.toolEffect)) {
        block('node_added_not_safe', n.id, `added ${n.kind} node "${n.id}" is not provably read-only: no existing read step uses ${n.kind === 'tool' ? `Tool "${String(n.tool)}"` : `${String(n.connector)}/${String(n.tool)}`}`)
        continue
      }
      changes.push({ where: n.id, what: `added a read-only ${n.kind} node` })
      continue
    }
    block('node_added_not_safe', n.id, `adding a "${String(n.kind)}" node is not on the safe list`)
  }

  for (const n of beforeNodes) {
    const m = aById.get(n.id)
    if (!m) {
      block(isSendSpend(n, opts.toolEffect) ? 'send_spend_node_changed' : 'node_removed', n.id, `node "${n.id}" was removed`)
      continue
    }
    if (same(n, m)) continue
    if (isSendSpend(n, opts.toolEffect) || isSendSpend(m, opts.toolEffect)) {
      block('send_spend_node_changed', n.id, `"${n.id}" is a send/spend node; any change needs the owner`)
      continue
    }
    if (n.kind !== m.kind) { block('node_kind_changed', n.id, `"${n.id}" changed kind ${String(n.kind)} → ${String(m.kind)}`); continue }
    if (n.kind === 'trigger') { block('trigger_changed', n.id, 'the trigger may not be changed by a repair'); continue }
    if (n.kind === 'check') { block('check_changed', n.id, `existing check "${n.id}" may not be edited (add a new check instead)`); continue }
    if (!same(n.effect, m.effect)) { block('effect_changed', n.id, `"${n.id}" effect ${String(n.effect)} → ${String(m.effect)}`); continue }
    if (n.kind === 'tool' && !same(n.tool, m.tool)) { block('tool_changed', n.id, `"${n.id}" switched Tool ${String(n.tool)} → ${String(m.tool)}`); continue }
    if (n.kind === 'mcp' && (!same(n.connector, m.connector) || !same(n.tool, m.tool))) {
      block('connector_changed', n.id, `"${n.id}" switched connector/tool`)
      continue
    }
    // A branch condition decides WHETHER a send/spend runs: re-routing one is the owner's call.
    if (n.kind === 'branch' && !same(n.cases, m.cases)) {
      const reach = [...branchReach(n, bById), ...branchReach(m, aById)]
      const sends = reach.filter((id) => { const x = aById.get(id) ?? bById.get(id); return !!x && isSendSpend(x, opts.toolEffect) })
      if (sends.length) {
        block('send_route_changed', n.id, `"${n.id}" decides whether send/spend node(s) ${[...new Set(sends)].join(', ')} run; changing it needs the owner`)
        continue
      }
    }
    diffNodeFields(n, m, added, aById, changes, block)
  }

  const safe = blockers.length === 0 && changes.length > 0
  return { safe, changes, blockers }
}

function diffNodeFields(
  n: RawNode, m: RawNode, added: Set<string>, aById: Map<string, RawNode>,
  changes: RepairSafeChange[], block: (code: RepairBlockerCode, where: string, message: string) => void,
): void {
  const safeFields = SAFE_FIELDS[String(n.kind)] ?? []
  for (const k of new Set([...Object.keys(n), ...Object.keys(m)])) {
    if (k === 'id' || same(n[k], m[k])) continue
    if (k === 'label') { changes.push({ where: n.id, what: 'label' }); continue }
    if (safeFields.includes(k)) { changes.push({ where: n.id, what: k }); continue }
    if (k === 'next') {
      if (insertionOnlyNext(n, m, added, aById)) changes.push({ where: n.id, what: 'next (inserted a node)' })
      else block('rewire_not_insertion', n.id, `"${n.id}".next was re-wired, not just extended with an added node`)
      continue
    }
    if (n.kind === 'branch' && k === 'cases') {
      diffBranchCases(n, m, added, changes, block)
      continue
    }
    if (n.kind === 'branch' && k === 'default') {
      if (insertionOnlyList(asList(n.default), asList(m.default), added)) changes.push({ where: n.id, what: 'default (inserted a node)' })
      else block('rewire_not_insertion', n.id, `"${n.id}".default was re-wired`)
      continue
    }
    if (n.kind === 'loop' && k === 'max_items') {
      if (typeof n.max_items === 'number' && typeof m.max_items === 'number' && m.max_items < n.max_items && m.max_items >= 1) {
        changes.push({ where: n.id, what: `max_items lowered ${n.max_items} → ${m.max_items}` })
      } else block('loop_max_items_raised', n.id, `"${n.id}".max_items may only be lowered (${String(n.max_items)} → ${String(m.max_items)})`)
      continue
    }
    if (n.kind === 'loop' && k === 'body') {
      if (insertionOnlyList(asList(n.body), asList(m.body), added)) changes.push({ where: n.id, what: 'body (inserted a node)' })
      else block('rewire_not_insertion', n.id, `"${n.id}".body was re-wired`)
      continue
    }
    if (n.kind === 'llm' && k === 'budget_usd') {
      if (typeof n.budget_usd === 'number' && typeof m.budget_usd === 'number' && m.budget_usd < n.budget_usd && m.budget_usd >= 0) {
        changes.push({ where: n.id, what: 'budget_usd lowered' })
      } else block('budget_raised', n.id, `"${n.id}".budget_usd may only be lowered`)
      continue
    }
    block('field_not_safe', n.id, `"${n.id}".${k} is not on the safe list`)
  }
}

const asList = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.map(String) : [])

/** The new list is the old list with only ADDED node ids inserted (order of the old members kept). */
function insertionOnlyList(before: string[], after: string[], added: Set<string>): boolean {
  const kept = after.filter((id) => !added.has(id))
  return kept.length === before.length && kept.every((id, i) => id === before[i])
}

/** Following the new `next` through added nodes only lands where the old `next` pointed. */
function insertionOnlyNext(n: RawNode, m: RawNode, added: Set<string>, aById: Map<string, RawNode>): boolean {
  let cur = typeof m.next === 'string' ? m.next : undefined
  const seen = new Set<string>()
  while (cur !== undefined && added.has(cur)) {
    if (seen.has(cur)) return false
    seen.add(cur)
    const nn = aById.get(cur)
    cur = nn && typeof nn.next === 'string' ? nn.next : undefined
  }
  const was = typeof n.next === 'string' ? n.next : undefined
  return cur === was
}

function diffBranchCases(
  n: RawNode, m: RawNode, added: Set<string>, changes: RepairSafeChange[],
  block: (code: RepairBlockerCode, where: string, message: string) => void,
): void {
  const bc = Array.isArray(n.cases) ? n.cases : []
  const ac = Array.isArray(m.cases) ? m.cases : []
  if (bc.length !== ac.length) { block('field_not_safe', n.id, `"${n.id}" gained or lost a case`); return }
  for (let i = 0; i < bc.length; i++) {
    const x = isObj(bc[i]) ? bc[i] as Record<string, unknown> : {}
    const y = isObj(ac[i]) ? ac[i] as Record<string, unknown> : {}
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (same(x[k], y[k])) continue
      if (k === 'when') changes.push({ where: n.id, what: `cases[${i}].when` })
      else if (k === 'then' && insertionOnlyList(asList(x.then), asList(y.then), added)) changes.push({ where: n.id, what: `cases[${i}].then (inserted a node)` })
      else block('field_not_safe', n.id, `"${n.id}".cases[${i}].${k} is not on the safe list`)
    }
  }
}

// ── Failure signatures + definition rot ─────────────────────────────────────

export interface FlowFailureLike {
  type?: unknown
  title?: unknown
  detail?: unknown
  node_id?: unknown
  code?: unknown
  exit_code?: unknown
}

/**
 * §5.3 "same failure signature (node id + error type)". Two failures of the same
 * node with the same Problem-Details `type` are the same incident class.
 */
export function flowFailureSignature(err: FlowFailureLike | null | undefined): string {
  const node = typeof err?.node_id === 'string' && err.node_id ? err.node_id : '-'
  const type = typeof err?.type === 'string' && err.type ? err.type : 'error'
  return `${node}:${type}`
}

const ROT_TEXT = /\bENOENT\b|\bexit(?:ed)?(?: with)?(?: code| status)?[ :=]*127\b|\bcommand not found\b/i

/**
 * §5.3 / CLAUDE.md: a `127` / `ENOENT` from a script Tool is DEFINITION ROT (the
 * definition points at something that no longer exists), not a transient
 * failure. It opens a repair immediately and never counts toward the K
 * consecutive-failure auto-pause.
 */
export function isDefinitionRot(err: FlowFailureLike | null | undefined): boolean {
  if (!err) return false
  if (err.type === 'definition_rot') return true
  if (err.code === 'ENOENT' || err.exit_code === 127 || err.exit_code === '127') return true
  const text = [err.type, err.title, err.detail].filter((x) => typeof x === 'string').join(' ')
  return ROT_TEXT.test(text)
}
