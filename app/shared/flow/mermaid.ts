// definitionToMermaid(): read-only viewer V1 (docs/design/WORKFLOWS.md §6).
// A pure function of (definition, optional per-node run status) → a Mermaid
// `flowchart TD`. Shapes and classDefs encode kind, effect and run status; loop
// bodies are subgraphs. Rendered by the client's existing lazy Mermaid path.
//
// Mermaid ids are prefixed `n_` because valid okflow ids such as `end`,
// `graph` or `subgraph` are Mermaid keywords.

import { analyzeFlow, declaredOrDefaultEffect, type RawNode } from './analyze.js'
import type { FlowDefinition, FlowNodeRunStatus } from './types.js'

export interface MermaidOptions {
  /** Per-node status of a selected run (border colour overlay). */
  status?: Readonly<Record<string, FlowNodeRunStatus>>
}

export const mermaidNodeId = (id: string): string => `n_${id}`

const CLASS_DEFS: [string, string][] = [
  ['llm', 'fill:#efe3ff,stroke:#7a4cc2,stroke-width:2px'],
  ['agent', 'fill:#e3eeff,stroke:#2b5fc2,stroke-width:2px'],
  ['write', 'fill:#fff8db,stroke:#a68500'],
  ['send', 'fill:#ffe9e0,stroke:#c2562b,stroke-width:2px'],
  ['spend', 'fill:#ffe3ea,stroke:#c22b55,stroke-width:2px'],
  ['succeeded', 'stroke:#2f8f4e,stroke-width:3px'],
  ['failed', 'stroke:#c22b2b,stroke-width:3px,stroke-dasharray:4 2'],
  ['running', 'stroke:#2b6fc2,stroke-width:3px'],
  ['waiting', 'stroke:#c2952b,stroke-width:3px,stroke-dasharray:2 2'],
  ['skipped', 'fill:#f2f2f2,color:#888888,stroke:#bbbbbb'],
  ['mocked', 'stroke:#888888,stroke-width:2px,stroke-dasharray:1 3'],
]

/** Escape label text with Mermaid entity codes; `<br/>` is added after escaping. */
function esc(s: string): string {
  return s.replace(/[#"<>]/g, (c) => `#${c.charCodeAt(0)};`)
}
function short(s: string, max = 48): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function definitionToMermaid(def: FlowDefinition, options: MermaidOptions = {}): string {
  const nodes = (Array.isArray(def.nodes) ? def.nodes : []) as unknown as RawNode[]
  const byId = new Map<string, RawNode>()
  for (const n of nodes) if (n && typeof n.id === 'string' && !byId.has(n.id)) byId.set(n.id, n)
  const an = analyzeFlow([...byId.values()])

  const ap = def.approvals
  const approvedForThisVersion = new Set(
    ap && ap.version === def.version && /^user:\S+$/.test(ap.by ?? '') && Array.isArray(ap.nodes) ? ap.nodes : [],
  )

  const effectLine = (n: RawNode): string | undefined => {
    const eff = declaredOrDefaultEffect(n)
    if (!eff || n.kind === 'trigger') return undefined
    if (eff !== 'send' && eff !== 'spend') return eff
    const how = approvedForThisVersion.has(n.id)
      ? `owner-approved v${def.version}`
      : an.approvalWaitBefore.get(n.id) ? 'approval each run' : 'NOT APPROVED'
    return `${eff.toUpperCase()} · ${how}`
  }

  const shape = (n: RawNode): string => {
    const lines: string[] = []
    if (n.label) lines.push(String(n.label))
    const retry = n.retry as { max?: unknown } | undefined
    const attempts = retry && typeof retry.max === 'number' ? `${retry.max} ${retry.max === 1 ? 'attempt' : 'attempts'} max` : undefined
    const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ')
    let open = '['
    let close = ']'
    switch (n.kind) {
      case 'trigger': {
        const sched = n.schedule as { cron?: unknown } | undefined
        lines.push(`⏰ trigger · ${str(n.on) ?? '?'}`)
        if (sched && typeof sched.cron === 'string') lines.push(sched.cron)
        else if (n.event) lines.push(String(n.event))
        open = '(['; close = '])'
        break
      }
      case 'tool':
        lines.push(`🔧 tool · ${str(n.tool) ?? '?'}`, join(effectLine(n), attempts))
        break
      case 'mcp':
        lines.push(`🔌 MCP · ${str(n.connector) ?? '?'}.${str(n.tool) ?? '?'}`, join(effectLine(n), attempts))
        break
      case 'llm': {
        const it = typeof n.max_iterations === 'number' ? n.max_iterations : 1
        lines.push(`🧠 LLM · ${n.id}`,
          join(str(n.model) ? `model ${n.model}` : undefined, `${it} iteration${it === 1 ? '' : 's'}`,
            typeof n.budget_usd === 'number' ? `$${n.budget_usd} cap` : undefined))
        open = '{{'; close = '}}'
        break
      }
      case 'agent':
        lines.push(`🤖 agent session → card · ${n.id}`,
          join(str(n.agent), typeof n.budget_usd === 'number' ? `$${n.budget_usd} cap` : undefined))
        open = '[['; close = ']]'
        break
      case 'branch':
        lines.push(`🔀 branch · ${n.id}`)
        open = '{'; close = '}'
        break
      case 'check': {
        const asserts = Array.isArray(n.assert) ? (n.assert as { why?: unknown }[]) : []
        const why = asserts.map((a) => a && a.why).find((w): w is string => typeof w === 'string')
        lines.push(`✔ check · ${why ?? `${asserts.length} assert${asserts.length === 1 ? '' : 's'}`}`)
        if (n.on_fail) lines.push(`on fail: ${String(n.on_fail)}`)
        open = '{'; close = '}'
        break
      }
      case 'wait': {
        const appr = n.approval as { from?: unknown } | undefined
        const mode = appr ? `approval from ${str(appr.from) ?? '?'}`
          : n.for !== undefined ? `for ${String(n.for)}`
            : n.until !== undefined ? `until ${String(n.until)}`
              : n.event !== undefined ? `event ${String(n.event)}` : '?'
        lines.push(`⏳ wait · ${mode}`)
        open = '('; close = ')'
        break
      }
      case 'loop': // only reached for a loop that is not on the trigger's path
        lines.push(`🔁 loop · for each ${str(n.as) ?? '?'}`)
        break
      case 'end':
        lines.push('⏹ end')
        open = '(['; close = '])'
        break
      default:
        lines.push(`? ${String(n.kind)} · ${n.id}`)
    }
    const text = lines.filter(Boolean).map((l) => esc(short(l))).join('<br/>')
    return `${mermaidNodeId(n.id)}${open}"${text}"${close}`
  }

  // Container = nearest enclosing loop (loop bodies are subgraphs; branch blocks are not).
  const containerOf = (id: string): string | null => {
    let o = an.owner.get(id) ?? null
    while (o !== null && byId.get(o)?.kind !== 'loop') o = an.owner.get(o) ?? null
    return o
  }
  const order = [...an.order, ...[...byId.keys()].filter((id) => !an.owner.has(id))]
  const out: string[] = ['flowchart TD']
  for (const [name, style] of CLASS_DEFS) out.push(`  classDef ${name} ${style}`)

  const render = (container: string | null, indent: string) => {
    for (const id of order) {
      if ((an.owner.has(id) ? containerOf(id) : null) !== container) continue
      const n = byId.get(id)!
      if (n.kind === 'loop' && an.owner.has(id)) {
        const conc = typeof n.concurrency === 'number' && n.concurrency > 1 ? `${n.concurrency} parallel` : undefined
        const title = [n.label ? String(n.label) : undefined,
          [`🔁 loop · for each ${str(n.as) ?? '?'}`, typeof n.max_items === 'number' ? `max ${n.max_items}` : undefined, conc]
            .filter(Boolean).join(' · ')]
          .filter(Boolean).map((l) => esc(short(l!))).join('<br/>')
        out.push(`${indent}subgraph ${mermaidNodeId(id)} ["${title}"]`)
        out.push(`${indent}  direction TB`)
        render(id, `${indent}  `)
        out.push(`${indent}end`)
      } else out.push(`${indent}${shape(n)}`)
    }
  }
  render(null, '  ')

  for (const e of an.edges) {
    if (byId.get(e.from)?.kind === 'loop' && e.label === 'each') continue // body sits inside the subgraph
    const label = e.label === undefined ? '' : `|"${esc(short(e.label, 32))}"|`
    out.push(`  ${mermaidNodeId(e.from)} -->${label} ${mermaidNodeId(e.to)}`)
  }

  const classes = new Map<string, string[]>()
  const tag = (cls: string, id: string) => {
    const l = classes.get(cls) ?? []
    l.push(mermaidNodeId(id))
    classes.set(cls, l)
  }
  for (const id of order) {
    const n = byId.get(id)!
    if (n.kind === 'llm' || n.kind === 'agent') tag(n.kind, id)
    const eff = declaredOrDefaultEffect(n)
    if (eff === 'write' || eff === 'send' || eff === 'spend') tag(eff, id)
    const st = options.status?.[id]
    if (st) tag(st, id)
  }
  for (const [name] of CLASS_DEFS) {
    const ids = classes.get(name)
    if (ids) out.push(`  class ${ids.join(',')} ${name}`)
  }
  return `${out.join('\n')}\n`
}
