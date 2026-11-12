// okflow/1 → Open Workflow DSL exporter (B10, docs/design/WORKFLOWS.md §3.1, §8).
//
// Exports the MAPPABLE SUBSET of an okflow/1 definition as an Open Workflow
// (ex-CNCF Serverless Workflow) document, DSL 1.0.3, so a definition is never
// locked in. Pure function, no imports, no runtime dependency: the YAML emitter
// below is hand-written. The test suite validates the output against the
// upstream JSON Schema pinned at tag v1.0.3 (vendored under the server test
// fixtures with its Apache-2.0 notice); nothing here loads that schema.
//
// What does NOT export is listed explicitly in OPEN_WORKFLOW_NON_EXPORTABLE.
// `refuse` features make the export throw (OkflowExportError) because dropping
// them would silently change what the workflow does; `drop` features are
// OperationKit-only control data and are listed in the result's `dropped`.
//
// Input type: B1 (`okflow/1` schema + validator) owns the canonical types in
// app/shared/flow/. Until it merges, this file reads a minimal STRUCTURAL view
// (OkflowExportInput) taken from WORKFLOWS.md §3.2/§3.5. It is not a second
// schema: it declares only the fields the exporter reads, so B1's definition
// type is assignable to it. Validate with B1's validateFlow() before exporting;
// the exporter assumes a valid definition and only checks what it maps.

/** Open Workflow DSL version emitted; must match the schema tag pinned in tests. */
export const OPEN_WORKFLOW_DSL_VERSION = '1.0.3'

export type NonExportableHandling = 'refuse' | 'drop' | 'degrade'

/** Every okflow/1 feature that has no faithful Open Workflow equivalent. */
export const OPEN_WORKFLOW_NON_EXPORTABLE: ReadonlyArray<{
  feature: string
  handling: NonExportableHandling
  reason: string
}> = [
  { feature: 'llm', handling: 'refuse', reason: 'Open Workflow has no model-call task; an llm node cannot be expressed.' },
  { feature: 'agent', handling: 'refuse', reason: 'Open Workflow has no agent/child-session task (call: a2a is a different protocol).' },
  { feature: 'goal', handling: 'drop', reason: 'Open Workflow has no goal or end condition; a workflow ends when its tasks end.' },
  { feature: 'wait.until', handling: 'refuse', reason: 'wait only takes a duration; waiting until a wall-clock time has no equivalent.' },
  { feature: 'budget', handling: 'drop', reason: 'Budgets are enforced by the OperationKit engine, not the DSL.' },
  { feature: 'approvals', handling: 'drop', reason: 'Per-version owner approvals are OperationKit records.' },
  { feature: 'workspace', handling: 'drop', reason: 'Workspace isolation is an OperationKit concept (used as the document namespace only).' },
  { feature: 'trigger.on=board', handling: 'drop', reason: 'Board triggers are OperationKit-specific; exported as a manually started workflow.' },
  { feature: 'mock', handling: 'drop', reason: 'Dry-run fixtures are an OperationKit self-test feature.' },
  { feature: 'idempotency', handling: 'drop', reason: 'No idempotency-key concept in the DSL.' },
  { feature: 'effect', handling: 'degrade', reason: 'Kept as task metadata only; nothing in the DSL enforces it.' },
  { feature: 'loop.max_items', handling: 'degrade', reason: 'Kept as task metadata only; for has no item cap.' },
  { feature: 'loop.output', handling: 'degrade', reason: 'A for task outputs its last iteration, not the list of every iteration; steps.<loop>.output differs.' },
  { feature: 'loop.concurrency', handling: 'degrade', reason: 'for is sequential; the export runs the loop with concurrency 1.' },
  { feature: 'check.on_fail=repair', handling: 'degrade', reason: 'No auto-repair in the DSL; a failed check raises a validation error.' },
]

// ── Structural input view (see header) ──────────────────────────────────────

export interface OkflowExportNode {
  id: string
  kind: string
  label?: string
  next?: string
  effect?: string
  retry?: { max: number; backoff?: 'fixed' | 'exponential'; delay_ms?: number }
  timeout_ms?: number
  idempotency?: string
  mock?: unknown
  // trigger
  on?: string
  schedule?: { cron?: string }
  event?: unknown
  // tool / mcp
  tool?: string
  input?: unknown
  connector?: string
  arguments?: unknown
  // branch
  cases?: Array<{ when: string; then: string[] | string }>
  default?: string[] | string
  // loop
  over?: string
  as?: string
  body?: string[]
  max_items?: number
  concurrency?: number
  // wait
  for?: number | string | Record<string, number>
  until?: string
  approval?: { from?: string; prompt?: string }
  // check
  assert?: Array<{ expr: string; why?: string }>
  on_fail?: string
  // end
  output?: unknown
}

export interface OkflowExportInput {
  apiVersion: string
  id: string
  name?: string
  workspace?: string
  version?: number
  goal?: unknown
  budget?: unknown
  approvals?: unknown
  nodes: OkflowExportNode[]
}

export interface OkflowExportIssue {
  code:
    | 'NON_EXPORTABLE_NODE'
    | 'NON_EXPORTABLE_FEATURE'
    | 'UNSUPPORTED_STRUCTURE'
    | 'UNSUPPORTED_REFERENCE'
    | 'UNSUPPORTED_EXPRESSION'
  nodeId?: string
  message: string
}

export class OkflowExportError extends Error {
  constructor(public readonly issues: OkflowExportIssue[]) {
    super(`okflow → Open Workflow export refused:\n${issues.map((i) => `- [${i.code}]${i.nodeId ? ` ${i.nodeId}:` : ''} ${i.message}`).join('\n')}`)
    this.name = 'OkflowExportError'
  }
}

export interface OpenWorkflowExportResult {
  /** The Open Workflow document as a plain JSON-compatible object. */
  workflow: Record<string, unknown>
  /** The same document serialised as YAML. */
  yaml: string
  /** `drop`/`degrade` features present in the input, with where they were. */
  dropped: Array<{ feature: string; nodeId?: string }>
}

// ── Expressions: okflow path syntax → jq runtime expressions ────────────────

const TIME_UNITS: Record<string, number> = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 }

class ExprError extends Error {
  constructor(public readonly code: OkflowExportIssue['code'], message: string) { super(message) }
}

type Tok = { t: 'num' | 'str' | 'id' | 'op'; v: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  const re = /\s*(?:(\d+(?:\.\d+)?)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_][A-Za-z0-9_-]*)|(==|!=|<=|>=|&&|\|\||[<>()[\],.+\-*/!]))/y
  let pos = 0
  while (pos < src.length) {
    if (/^\s*$/.test(src.slice(pos))) break
    re.lastIndex = pos
    const m = re.exec(src)
    if (!m) throw new ExprError('UNSUPPORTED_EXPRESSION', `cannot parse "${src}" at offset ${pos}`)
    pos = re.lastIndex
    if (m[1] !== undefined) out.push({ t: 'num', v: m[1] })
    else if (m[2] !== undefined) out.push({ t: 'str', v: m[2].replace(/\\(.)/g, '$1') })
    else if (m[3] !== undefined) out.push({ t: 'str', v: m[3].replace(/\\(.)/g, '$1') })
    else if (m[4] !== undefined) out.push({ t: 'id', v: m[4] })
    else out.push({ t: 'op', v: m[5] })
  }
  return out
}

const jqKey = (k: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`)

/** Translate one okflow expression (no `{{ }}`) to jq. `loopVars` = the in-scope `loop.as` names. */
export function okflowExprToJq(src: string, loopVars: ReadonlySet<string> = new Set()): string {
  const toks = tokenize(src)
  let i = 0
  const peek = () => toks[i]
  const isOp = (v: string) => peek()?.t === 'op' && peek().v === v
  const isWord = (v: string) => peek()?.t === 'id' && peek().v === v
  const expect = (v: string) => {
    if (!isOp(v)) throw new ExprError('UNSUPPORTED_EXPRESSION', `expected "${v}" in "${src}"`)
    i++
  }

  const binary = (next: () => string, ops: Record<string, string>): string => {
    let left = next()
    for (;;) {
      const tk = peek()
      const jqOp = tk && (tk.t === 'op' || tk.t === 'id') ? ops[tk.v] : undefined
      if (!jqOp) return left
      i++
      left = `(${left} ${jqOp} ${next()})`
    }
  }
  const orExpr = (): string => binary(andExpr, { or: 'or', '||': 'or' })
  const andExpr = (): string => binary(cmpExpr, { and: 'and', '&&': 'and' })
  const cmpExpr = (): string => binary(addExpr, { '==': '==', '!=': '!=', '<': '<', '>': '>', '<=': '<=', '>=': '>=' })
  const addExpr = (): string => binary(mulExpr, { '+': '+', '-': '-' })
  const mulExpr = (): string => binary(unary, { '*': '*', '/': '/' })
  const unary = (): string => {
    if (isOp('!') || isWord('not')) { i++; return `(${unary()} | not)` }
    if (isOp('-')) { i++; return `(0 - ${unary()})` }
    return primary()
  }
  const args = (): string[] => {
    expect('(')
    const out: string[] = []
    if (!isOp(')')) {
      out.push(orExpr())
      while (isOp(',')) { i++; out.push(orExpr()) }
    }
    expect(')')
    return out
  }
  const call = (name: string): string => {
    const a = args()
    const arity = (n: number) => {
      if (a.length !== n) throw new ExprError('UNSUPPORTED_EXPRESSION', `${name}() takes ${n} argument(s) in "${src}"`)
    }
    switch (name) {
      case 'len': arity(1); return `(${a[0]} | length)`
      case 'now': arity(0); return '(now | todate)'
      case 'lower': arity(1); return `(${a[0]} | ascii_downcase)`
      case 'join': arity(2); return `(${a[0]} | join(${a[1]}))`
      case 'default': arity(2); return `(${a[0]} // ${a[1]})`
      case 'date_add': {
        arity(3)
        // The unit must be a literal so it maps to a fixed number of seconds.
        const unit = /^"([a-z]+?)s?"$/.exec(a[2])?.[1]
        const secs = unit ? TIME_UNITS[unit] : undefined
        if (secs === undefined) {
          throw new ExprError('UNSUPPORTED_EXPRESSION', `date_add() unit must be a literal second/minute/hour/day/week in "${src}"`)
        }
        return `((${a[0]} | fromdate) + (${a[1]}) * ${secs} | todate)`
      }
      default: throw new ExprError('UNSUPPORTED_EXPRESSION', `unknown function ${name}() in "${src}"`)
    }
  }
  const path = (root: string): string => {
    const segs: string[] = []
    for (;;) {
      if (isOp('.')) {
        i++
        const tk = peek()
        if (!tk || tk.t !== 'id') throw new ExprError('UNSUPPORTED_EXPRESSION', `bad path in "${src}"`)
        segs.push(jqKey(tk.v)); i++
      } else if (isOp('[')) {
        i++
        const tk = peek()
        if (!tk || (tk.t !== 'num' && tk.t !== 'str')) throw new ExprError('UNSUPPORTED_EXPRESSION', `bad index in "${src}"`)
        segs.push(tk.t === 'num' ? `[${tk.v}]` : `[${JSON.stringify(tk.v)}]`); i++
        expect(']')
      } else break
    }
    if (root === 'trigger') {
      // trigger.payload.x → the workflow's raw input.
      if (segs[0] === '.payload') return `$workflow.input${segs.slice(1).join('')}`
      if (segs.length === 0) return '$workflow.input'
      throw new ExprError('UNSUPPORTED_REFERENCE', `only trigger.payload.* is exportable, got "${src}"`)
    }
    if (root === 'steps') {
      if (segs.length < 2 || segs[1] !== '.output') {
        throw new ExprError('UNSUPPORTED_REFERENCE', `only steps.<id>.output.* is exportable, got "${src}"`)
      }
      return `$context.steps${segs.join('')}`
    }
    if (root === 'item') {
      const name = segs[0]?.slice(1)
      if (!name || !loopVars.has(name)) {
        throw new ExprError('UNSUPPORTED_REFERENCE', `item.${name ?? ''} is not bound by an enclosing loop in "${src}"`)
      }
      return `$${name}${segs.slice(1).join('')}`
    }
    throw new ExprError('UNSUPPORTED_REFERENCE', `unknown reference root "${root}" in "${src}"`)
  }
  const primary = (): string => {
    const tk = peek()
    if (!tk) throw new ExprError('UNSUPPORTED_EXPRESSION', `unexpected end of "${src}"`)
    if (tk.t === 'num') { i++; return tk.v }
    if (tk.t === 'str') { i++; return JSON.stringify(tk.v) }
    if (isOp('(')) { i++; const e = orExpr(); expect(')'); return `(${e})` }
    if (tk.t === 'id') {
      i++
      if (tk.v === 'true' || tk.v === 'false' || tk.v === 'null') return tk.v
      if (isOp('(')) return call(tk.v)
      return path(tk.v)
    }
    throw new ExprError('UNSUPPORTED_EXPRESSION', `unexpected "${tk.v}" in "${src}"`)
  }

  const out = orExpr()
  if (i !== toks.length) throw new ExprError('UNSUPPORTED_EXPRESSION', `trailing input in "${src}"`)
  return out
}

const TEMPLATE_RE = /\{\{([\s\S]*?)\}\}/g

/** A string value: literal, one `{{ expr }}`, or text with embedded `{{ }}` → Open Workflow string. */
function templateToRuntime(value: string, loopVars: ReadonlySet<string>): string {
  const whole = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(value)
  if (whole && !whole[1].includes('{{')) return `\${ ${okflowExprToJq(whole[1].trim(), loopVars)} }`
  if (!value.includes('{{')) {
    // A literal that happens to look like a runtime expression must stay literal.
    return /^\s*\$\{/.test(value) ? `\${ ${JSON.stringify(value)} }` : value
  }
  let jq = ''
  let last = 0
  for (const m of value.matchAll(TEMPLATE_RE)) {
    jq += JSON.stringify(value.slice(last, m.index)).slice(1, -1)
    jq += `\\(${okflowExprToJq(m[1].trim(), loopVars)})`
    last = m.index! + m[0].length
  }
  jq += JSON.stringify(value.slice(last)).slice(1, -1)
  return `\${ "${jq}" }`
}

/** A bare expression field (`assert[].expr`, `branch.cases[].when`), with or without `{{ }}`. */
function exprField(value: string, loopVars: ReadonlySet<string>): string {
  const whole = /^\s*\{\{([\s\S]*?)\}\}\s*$/.exec(value)
  return okflowExprToJq((whole ? whole[1] : value).trim(), loopVars)
}

function mapValues(value: unknown, loopVars: ReadonlySet<string>): unknown {
  if (typeof value === 'string') return templateToRuntime(value, loopVars)
  if (Array.isArray(value)) return value.map((v) => mapValues(v, loopVars))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapValues(v, loopVars)]))
  }
  return value
}

// ── Graph → nested task lists ───────────────────────────────────────────────

type Task = Record<string, unknown>
type TaskItem = Record<string, Task>

const RESERVED_CALLS = new Set(['asyncapi', 'grpc', 'http', 'openapi', 'a2a', 'mcp'])
const VALIDATION_ERROR = 'https://serverlessworkflow.io/spec/1.0.0/errors/validation'

function slugify(value: string, fallback: string): string {
  const s = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '')
  return s || fallback
}

function durationFrom(value: unknown): unknown {
  if (typeof value === 'number') return { milliseconds: value }
  return value
}

/**
 * Export an okflow/1 definition to an Open Workflow (DSL 1.0.3) document.
 * Throws OkflowExportError listing EVERY non-exportable part at once.
 */
export function okflowToOpenWorkflow(
  def: OkflowExportInput,
  opts: { namespace?: string } = {},
): OpenWorkflowExportResult {
  const issues: OkflowExportIssue[] = []
  const dropped: OpenWorkflowExportResult['dropped'] = []
  const byId = new Map(def.nodes.map((n) => [n.id, n]))
  const placed = new Set<string>()

  if (def.goal !== undefined) dropped.push({ feature: 'goal' })
  if (def.budget !== undefined) dropped.push({ feature: 'budget' })
  if (def.approvals !== undefined) dropped.push({ feature: 'approvals' })
  if (def.workspace !== undefined) dropped.push({ feature: 'workspace' })

  for (const n of def.nodes) {
    if (n.kind === 'llm' || n.kind === 'agent') {
      issues.push({ code: 'NON_EXPORTABLE_NODE', nodeId: n.id, message: OPEN_WORKFLOW_NON_EXPORTABLE.find((f) => f.feature === n.kind)!.reason })
    }
  }

  const guard = <T>(nodeId: string, fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch (e) {
      if (e instanceof ExprError) { issues.push({ code: e.code, nodeId, message: e.message }); return fallback }
      throw e
    }
  }

  const exportAs = (id: string) => ({
    as: `\${ $context + { steps: (($context.steps // {}) + { ${JSON.stringify(id)}: { output: . } }) } }`,
  })

  /** Emit `ids` as one task list; `terminal` is the directive that leaves it (`end` top level, `exit` nested). */
  const emitList = (ids: string[], loopVars: ReadonlySet<string>, terminal: 'end' | 'exit'): TaskItem[] => {
    const out: TaskItem[] = []
    ids.forEach((id, idx) => {
      const node = byId.get(id)
      if (!node) { issues.push({ code: 'UNSUPPORTED_STRUCTURE', nodeId: id, message: `unknown node "${id}"` }); return }
      if (placed.has(id)) {
        issues.push({ code: 'UNSUPPORTED_STRUCTURE', nodeId: id, message: 'node is reachable from more than one place (only tree-shaped flows export)' })
        return
      }
      placed.add(id)
      const after = ids[idx + 1] ?? terminal
      out.push(...emitNode(node, loopVars, after))
    })
    return out
  }

  /** `after` = where control goes once this node is done (next sibling, or `end`/`exit`). */
  const emitNode = (n: OkflowExportNode, loopVars: ReadonlySet<string>, after: string): TaskItem[] => {
    const meta: Record<string, unknown> = { kind: n.kind }
    if (n.label) meta.label = n.label
    if (n.effect) { meta.effect = n.effect; dropped.push({ feature: 'effect', nodeId: n.id }) }
    if (n.mock !== undefined) dropped.push({ feature: 'mock', nodeId: n.id })
    if (n.idempotency !== undefined) dropped.push({ feature: 'idempotency', nodeId: n.id })

    let task: Task | undefined
    const extra: TaskItem[] = []
    switch (n.kind) {
      case 'llm':
      case 'agent':
        return [] // already reported as NON_EXPORTABLE_NODE
      case 'tool': {
        const slug = n.tool ?? ''
        if (!slug || RESERVED_CALLS.has(slug)) {
          issues.push({ code: 'UNSUPPORTED_STRUCTURE', nodeId: n.id, message: `tool slug "${slug}" is empty or collides with a built-in call type` })
          return []
        }
        meta.tool = slug
        task = { call: slug }
        if (n.input !== undefined) task.with = guard(n.id, () => mapValues(n.input, loopVars), {})
        break
      }
      case 'mcp': {
        meta.connector = n.connector
        const parameters: Record<string, unknown> = { name: n.tool }
        if (n.arguments !== undefined) parameters.arguments = guard(n.id, () => mapValues(n.arguments, loopVars), {})
        task = {
          call: 'mcp',
          with: {
            method: 'tools/call',
            parameters,
            // Connectors are resolved per workspace by OperationKit; the importer
            // binds this placeholder endpoint to the real MCP server URL.
            transport: { http: { endpoint: `okflow://connectors/${encodeURIComponent(n.connector ?? '')}` } },
          },
        }
        break
      }
      case 'check': {
        const conds = guard(n.id, () => (n.assert ?? []).map((a) => exprField(a.expr, loopVars)), [] as string[])
        const all = conds.length ? conds.map((c) => `(${c})`).join(' and ') : 'true'
        if (n.on_fail === 'continue') {
          task = { set: { passed: `\${ ${all} }` } }
        } else {
          if (n.on_fail === 'repair') dropped.push({ feature: 'check.on_fail=repair', nodeId: n.id })
          const why = (n.assert ?? []).map((a) => a.why ?? a.expr).join('; ')
          task = {
            if: `\${ (${all}) | not }`,
            raise: { error: { type: VALIDATION_ERROR, status: 400, title: `Check "${n.id}" failed`, detail: why } },
          }
        }
        break
      }
      case 'wait': {
        if (n.until !== undefined) {
          issues.push({ code: 'NON_EXPORTABLE_FEATURE', nodeId: n.id, message: OPEN_WORKFLOW_NON_EXPORTABLE.find((f) => f.feature === 'wait.until')!.reason })
          return []
        }
        if (n.for !== undefined) task = { wait: durationFrom(n.for) }
        else if (n.approval !== undefined) {
          meta.approval = n.approval
          task = { listen: { to: { one: { with: { type: 'io.operationkit.flow.approval.granted', subject: n.id } } } } }
        } else if (typeof n.event === 'string') {
          task = { listen: { to: { one: { with: { type: n.event } } } } }
        } else {
          issues.push({ code: 'UNSUPPORTED_STRUCTURE', nodeId: n.id, message: 'wait needs for, approval or a string event' })
          return []
        }
        break
      }
      case 'loop': {
        if (!n.as || !n.over) {
          issues.push({ code: 'UNSUPPORTED_STRUCTURE', nodeId: n.id, message: 'loop needs over and as' })
          return []
        }
        dropped.push({ feature: 'loop.output', nodeId: n.id })
        if (n.max_items !== undefined) { meta.max_items = n.max_items; dropped.push({ feature: 'loop.max_items', nodeId: n.id }) }
        if ((n.concurrency ?? 1) > 1) { meta.concurrency = n.concurrency; dropped.push({ feature: 'loop.concurrency', nodeId: n.id }) }
        const inner = new Set([...loopVars, n.as])
        task = {
          for: { each: n.as, in: guard(n.id, () => templateToRuntime(n.over!, loopVars), '${ [] }') },
          do: emitList(n.body ?? [], inner, 'exit'),
        }
        break
      }
      case 'branch': {
        const cont = n.next ?? after
        const cases: Array<Record<string, unknown>> = []
        ;(n.cases ?? []).forEach((c, ci) => {
          const name = `${n.id}__case_${ci}`
          cases.push({ [name]: { when: guard(n.id, () => `\${ ${exprField(c.when, loopVars)} }`, '${ false }'), then: name } })
          const ids = Array.isArray(c.then) ? c.then : [c.then]
          extra.push({ [name]: { do: emitList(ids, loopVars, 'exit'), then: cont } })
        })
        if (n.default !== undefined) {
          const name = `${n.id}__default`
          const ids = Array.isArray(n.default) ? n.default : [n.default]
          cases.push({ default: { then: name } })
          extra.push({ [name]: { do: emitList(ids, loopVars, 'exit'), then: cont } })
        } else {
          cases.push({ default: { then: cont } })
        }
        for (const item of extra) {
          const name = Object.keys(item)[0]
          if (byId.has(name)) issues.push({ code: 'UNSUPPORTED_STRUCTURE', nodeId: n.id, message: `generated task name "${name}" collides with a node id` })
        }
        task = { switch: cases }
        break
      }
      case 'end': {
        // set takes a non-empty object or a string (a runtime expression here).
        const out = n.output === undefined ? {} : guard(n.id, () => mapValues(n.output, loopVars), {})
        const isObj = out !== null && typeof out === 'object' && !Array.isArray(out) && Object.keys(out).length > 0
        task = { set: typeof out === 'string' || isObj ? out : `\${ ${JSON.stringify(out)} }`, then: 'end' }
        break
      }
      case 'trigger':
        issues.push({ code: 'UNSUPPORTED_STRUCTURE', nodeId: n.id, message: 'a trigger may only start the flow' })
        return []
      default:
        issues.push({ code: 'UNSUPPORTED_STRUCTURE', nodeId: n.id, message: `unknown node kind "${n.kind}"` })
        return []
    }

    if (n.kind !== 'end' && n.kind !== 'branch') task.export = exportAs(n.id)
    if (n.timeout_ms !== undefined) task.timeout = { after: { milliseconds: n.timeout_ms } }
    task.metadata = { okflow: meta }

    let wrapped: Task = task
    if (n.retry && n.retry.max > 0) {
      // The DSL's only retry construct is try/catch.retry (dsl.md "Errors").
      const retry: Record<string, unknown> = {
        backoff: n.retry.backoff === 'exponential' ? { exponential: {} } : { constant: {} },
        limit: { attempt: { count: n.retry.max } },
      }
      if (n.retry.delay_ms !== undefined) retry.delay = { milliseconds: n.retry.delay_ms }
      const { metadata, timeout, ...inner } = task
      wrapped = { try: [{ [n.id]: inner }], catch: { retry }, metadata }
      if (timeout) wrapped.timeout = timeout
    }
    return [{ [n.id]: wrapped }, ...extra]
  }

  const triggers = def.nodes.filter((n) => n.kind === 'trigger')
  if (triggers.length !== 1) {
    issues.push({ code: 'UNSUPPORTED_STRUCTURE', message: `expected exactly one trigger, found ${triggers.length}` })
    throw new OkflowExportError(issues)
  }
  const trigger = triggers[0]
  placed.add(trigger.id)

  // The main chain follows `next` from the trigger; loop bodies and branch
  // cases are emitted inside their parent task.
  const chain: string[] = []
  const seen = new Set<string>([trigger.id])
  for (let cur = trigger.next; cur !== undefined; cur = byId.get(cur)?.next) {
    if (seen.has(cur)) { issues.push({ code: 'UNSUPPORTED_STRUCTURE', nodeId: cur, message: 'cycle in next chain' }); break }
    seen.add(cur)
    chain.push(cur)
    if (byId.get(cur)?.kind === 'end') break
  }
  const tasks = emitList(chain, new Set(), 'end')

  for (const n of def.nodes) {
    if (!placed.has(n.id) && n.kind !== 'llm' && n.kind !== 'agent') {
      issues.push({ code: 'UNSUPPORTED_STRUCTURE', nodeId: n.id, message: 'node is not reachable from the trigger' })
    }
  }

  let schedule: Record<string, unknown> | undefined
  if (trigger.on === 'schedule' && trigger.schedule?.cron) {
    schedule = { cron: trigger.schedule.cron }
  } else if (trigger.on === 'event' && typeof trigger.event === 'string') {
    schedule = { on: { one: { with: { type: trigger.event } } } }
  } else if (trigger.on === 'board') {
    dropped.push({ feature: 'trigger.on=board', nodeId: trigger.id })
  }

  if (tasks.length === 0) issues.push({ code: 'UNSUPPORTED_STRUCTURE', message: 'nothing to export after the trigger' })
  if (issues.length) throw new OkflowExportError(issues)

  const workflow: Record<string, unknown> = {
    document: {
      dsl: OPEN_WORKFLOW_DSL_VERSION,
      namespace: slugify(opts.namespace ?? def.workspace ?? 'operationkit', 'operationkit'),
      name: slugify(def.id, 'okflow'),
      version: `${Math.max(0, Math.trunc(def.version ?? 1))}.0.0`,
      ...(def.name ? { title: def.name } : {}),
      metadata: {
        okflow: {
          apiVersion: def.apiVersion,
          id: def.id,
          ...(def.version !== undefined ? { version: def.version } : {}),
          trigger: trigger.on ?? 'manual',
          dropped: [...new Set(dropped.map((d) => d.feature))],
        },
      },
    },
  }
  if (schedule) workflow.schedule = schedule
  workflow.do = tasks
  return { workflow, yaml: toYaml(workflow), dropped }
}

// ── Minimal YAML emitter (block style, JSON-compatible values only) ─────────

const YAML_RESERVED = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'boolean') return String(v)
  const s = String(v)
  // Plain only when it is unambiguously a string in YAML 1.1 and 1.2;
  // everything else is a JSON string, which is a valid YAML double-quoted scalar.
  if (/^[A-Za-z_][A-Za-z0-9_./-]*$/.test(s) && !YAML_RESERVED.test(s)) return s
  return JSON.stringify(s)
}

const yamlKey = (k: string) => yamlScalar(k)

/** Serialise a JSON-compatible value as block-style YAML. */
export function toYaml(value: unknown): string {
  const lines: string[] = []
  const isComplex = (v: unknown) =>
    v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v as object).length > 0)
  const inline = (v: unknown) => (Array.isArray(v) ? '[]' : v !== null && typeof v === 'object' ? '{}' : yamlScalar(v))

  const emit = (v: unknown, indent: string): void => {
    if (Array.isArray(v)) {
      for (const item of v) {
        if (isComplex(item)) {
          const sub: string[] = []
          const saved = lines.length
          emit(item, indent + '  ')
          sub.push(...lines.splice(saved))
          lines.push(`${indent}- ${sub[0].slice(indent.length + 2)}`, ...sub.slice(1))
        } else {
          lines.push(`${indent}- ${inline(item)}`)
        }
      }
      return
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      if (isComplex(child)) {
        lines.push(`${indent}${yamlKey(k)}:`)
        emit(child, indent + '  ')
      } else {
        lines.push(`${indent}${yamlKey(k)}: ${inline(child)}`)
      }
    }
  }
  if (!isComplex(value)) return `${inline(value)}\n`
  emit(value, '')
  return `${lines.join('\n')}\n`
}
