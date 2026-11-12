// validateFlow(): the one okflow/1 validator, used by API, MCP, builder and CI
// (docs/design/WORKFLOWS.md §3.4). Pure: registry lookups (Tool slugs,
// connectors) go through an injected FlowRegistry and are skipped without one.

import { analyzeFlow, blockMembers, declaredOrDefaultEffect, type RawNode } from './analyze.js'
import { parseExpressionField, parseTemplate, type ParsedExpr } from './expr.js'
import {
  FLOW_EFFECTS, FLOW_ID_RE, FLOW_NODE_KINDS, LLM_MAX_ITERATIONS_CAP, LOOP_MAX_CONCURRENCY,
  MAX_FLOW_FIXTURES, NODE_ID_RE, SUPPORTED_API_VERSIONS, TRIGGER_SOURCES,
  type FlowEffect, type FlowErrorCode, type FlowIssue, type FlowValidationResult, type ValidateFlowOptions,
} from './types.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const isNonEmptyStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isNonNegNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

const TOP_KEYS = ['apiVersion', 'id', 'name', 'description', 'workspace', 'version', 'goal', 'budget', 'approvals', 'fixtures', 'nodes']
const BASE_KEYS = ['id', 'kind', 'label', 'next', 'retry', 'timeout_ms', 'idempotency', 'effect', 'mock']
const KIND_KEYS: Record<string, string[]> = {
  trigger: ['on', 'schedule', 'event'],
  tool: ['tool', 'input'],
  mcp: ['connector', 'tool', 'arguments'],
  llm: ['prompt', 'output_schema', 'model', 'max_iterations', 'tools', 'budget_usd'],
  agent: ['brief', 'agent', 'budget_usd'],
  branch: ['cases', 'default'],
  loop: ['over', 'as', 'body', 'max_items', 'concurrency'],
  wait: ['for', 'until', 'event', 'approval'],
  check: ['assert', 'on_fail'],
  end: ['output'],
}
/** Fields whose string values may contain `{{ }}` templates. */
const TEMPLATE_FIELDS = ['input', 'arguments', 'prompt', 'brief', 'output', 'for', 'until', 'event', 'approval']
const EFFECTFUL_KINDS = ['trigger', 'tool', 'mcp', 'llm', 'agent']
const STEP_FIELDS = ['output', 'input', 'status', 'error']
const DURATION_RE = /^(\d+\s*(ms|s|m|h|d)|P(?=\d|T\d)(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?)$/
const EFFECT_RANK: Record<FlowEffect, number> = { read: 0, write: 1, send: 2, spend: 3 }

export function validateFlow(input: unknown, options: ValidateFlowOptions = {}): FlowValidationResult {
  const issues: FlowIssue[] = []
  const seen = new Set<string>()
  const add = (code: FlowErrorCode, path: string, message: string, node_id?: string, severity: FlowIssue['severity'] = 'error') => {
    // One SECRET_REFERENCE per path: the ref check and the raw sweep both see templates.
    const key = code === 'SECRET_REFERENCE' ? `${code}|${path}` : `${code}|${path}|${message}`
    if (seen.has(key)) return
    seen.add(key)
    issues.push(node_id === undefined ? { code, severity, message, path } : { code, severity, message, path, node_id })
  }
  const done = (): FlowValidationResult => {
    const errors = issues.filter((i) => i.severity === 'error')
    return { ok: errors.length === 0, errors, warnings: issues.filter((i) => i.severity === 'warning') }
  }

  if (!isObj(input)) {
    add('INVALID_DOCUMENT', '', 'a flow definition must be a JSON object')
    return done()
  }
  const doc = input

  // ── document fields ──────────────────────────────────────────────────────
  if (typeof doc.apiVersion !== 'string' || !SUPPORTED_API_VERSIONS.includes(doc.apiVersion)) {
    add('UNSUPPORTED_API_VERSION', 'apiVersion', `apiVersion must be one of ${SUPPORTED_API_VERSIONS.join(', ')}, got ${JSON.stringify(doc.apiVersion)}`)
  }
  if (doc.id === undefined) add('MISSING_FIELD', 'id', 'flow id is required')
  else if (typeof doc.id !== 'string' || !FLOW_ID_RE.test(doc.id)) add('INVALID_FIELD', 'id', `flow id must match ${FLOW_ID_RE}`)
  if (!isNonEmptyStr(doc.name)) add(doc.name === undefined ? 'MISSING_FIELD' : 'INVALID_FIELD', 'name', 'name must be a non-empty string')
  if (doc.version === undefined) add('MISSING_FIELD', 'version', 'version is required')
  else if (!isInt(doc.version) || doc.version < 1) add('INVALID_FIELD', 'version', 'version must be a positive integer')
  for (const k of ['description', 'workspace']) {
    if (doc[k] !== undefined && typeof doc[k] !== 'string') add('INVALID_FIELD', k, `${k} must be a string`)
  }
  if (doc.budget !== undefined) {
    if (!isObj(doc.budget)) add('INVALID_FIELD', 'budget', 'budget must be an object')
    else for (const k of ['run_usd', 'repair_usd', 'repairs_per_day']) {
      if (doc.budget[k] !== undefined && !isNonNegNum(doc.budget[k])) add('INVALID_FIELD', `budget.${k}`, `${k} must be a non-negative number`)
    }
  }
  if (doc.fixtures !== undefined) {
    // Self-test trigger payloads (§5.2, card B5): [{ name, payload }].
    if (!Array.isArray(doc.fixtures) || doc.fixtures.length === 0 || doc.fixtures.length > MAX_FLOW_FIXTURES) {
      add('INVALID_FIELD', 'fixtures', `fixtures must be a list of 1..${MAX_FLOW_FIXTURES} { name, payload } objects`)
    } else {
      const names = new Set<string>()
      doc.fixtures.forEach((f: unknown, i: number) => {
        const p = `fixtures[${i}]`
        if (!isObj(f)) { add('INVALID_FIELD', p, 'a fixture is { name, payload }'); return }
        if (!isNonEmptyStr(f.name)) add('INVALID_FIELD', `${p}.name`, 'fixture name must be a non-empty string')
        else if (names.has(f.name)) add('INVALID_FIELD', `${p}.name`, `fixture name "${f.name}" is used twice`)
        else names.add(f.name)
        if (f.payload !== undefined && !isObj(f.payload)) add('INVALID_FIELD', `${p}.payload`, 'fixture payload must be a JSON object')
        for (const k of Object.keys(f)) if (k !== 'name' && k !== 'payload') add('UNKNOWN_FIELD', `${p}.${k}`, `unknown fixture field "${k}"`, undefined, 'warning')
      })
    }
  }
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) add('UNKNOWN_FIELD', k, `unknown field "${k}"`, undefined, 'warning')

  if (doc.nodes === undefined) {
    add('MISSING_FIELD', 'nodes', 'nodes is required')
    return done()
  }
  if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) {
    add('INVALID_FIELD', 'nodes', 'nodes must be a non-empty array')
    return done()
  }

  // ── per-node shape ───────────────────────────────────────────────────────
  const raw: RawNode[] = []
  const indexOf = new Map<string, number>()
  doc.nodes.forEach((n: unknown, i: number) => {
    const p = `nodes[${i}]`
    if (!isObj(n)) { add('INVALID_FIELD', p, 'a node must be an object'); return }
    if (typeof n.id !== 'string' || !NODE_ID_RE.test(n.id)) {
      add('INVALID_NODE_ID', `${p}.id`, `node id ${JSON.stringify(n.id)} must match ${NODE_ID_RE}`)
      return
    }
    if (indexOf.has(n.id)) {
      add('DUPLICATE_NODE_ID', `${p}.id`, `node id "${n.id}" is already used by nodes[${indexOf.get(n.id)}]`, n.id)
      return
    }
    indexOf.set(n.id, i)
    raw.push(n as RawNode)
    checkNodeShape(n as RawNode, p, add)
  })
  const pathOf = (id: string) => `nodes[${indexOf.get(id)}]`
  const nodeById = new Map(raw.map((n) => [n.id, n]))

  // ── trigger + edges ──────────────────────────────────────────────────────
  const triggers = raw.filter((n) => n.kind === 'trigger')
  if (triggers.length === 0) add('NO_TRIGGER', 'nodes', 'a flow needs exactly one trigger node')
  triggers.slice(1).forEach((t) => add('MULTIPLE_TRIGGERS', pathOf(t.id), `second trigger "${t.id}" — a flow has exactly one trigger`, t.id))
  if (triggers.length > 0 && isObj(doc.nodes[0]) && (doc.nodes[0] as Obj).kind !== 'trigger') {
    add('TRIGGER_NOT_FIRST', 'nodes[0]', 'the trigger must be the first node')
  }
  for (const n of raw) {
    const targets: [string, string][] = []
    if (typeof n.next === 'string') targets.push([n.next, `${pathOf(n.id)}.next`])
    else if (n.next !== undefined) add('INVALID_FIELD', `${pathOf(n.id)}.next`, 'next must be a node id string', n.id)
    for (const m of blockMembers(n)) targets.push([m, pathOf(n.id)])
    for (const [to, p] of targets) {
      const target = nodeById.get(to)
      if (!target) add('DANGLING_EDGE', p, `"${n.id}" points to unknown node "${to}"`, n.id)
      else if (target.kind === 'trigger') add('TRIGGER_HAS_INCOMING', p, `"${n.id}" points back to trigger "${to}"`, n.id)
    }
    if (n.kind === 'end' && n.next !== undefined) add('END_HAS_NEXT', `${pathOf(n.id)}.next`, `end node "${n.id}" must not have "next"`, n.id)
    if (n.kind === 'trigger' && n.id === triggers[0]?.id && n.next === undefined) add('MISSING_FIELD', `${pathOf(n.id)}.next`, `trigger "${n.id}" must point at the first step`, n.id)
  }
  if (!raw.some((n) => n.kind === 'end')) add('NO_END_NODE', 'nodes', 'no end node: the run output will be empty', undefined, 'warning')

  // ── graph walk ───────────────────────────────────────────────────────────
  const an = analyzeFlow(raw)
  for (const is of an.issues) add(is.code, pathOf(is.node_id), is.message, is.node_id)
  if (an.triggerId) {
    for (const n of raw) {
      if (!an.owner.has(n.id) && n.kind !== 'trigger') add('UNREACHABLE_NODE', pathOf(n.id), `"${n.id}" is not reachable from the trigger`, n.id)
    }
  }

  // ── references ───────────────────────────────────────────────────────────
  const checkRefs = (parsed: ParsedExpr, path: string, scope: { nodeId?: string; goal?: boolean }) => {
    for (const pr of parsed.problems) add(pr.code, path, pr.message, scope.nodeId)
    const placed = scope.nodeId !== undefined && an.owner.has(scope.nodeId)
    for (const { segments: s } of parsed.refs) {
      const ref = s.join('.')
      switch (s[0]) {
        case 'secrets':
          add('SECRET_REFERENCE', path, `"${ref}": secrets never appear in a definition; Tools resolve their own credentials by name`, scope.nodeId)
          break
        case 'trigger':
          break
        case 'steps': {
          const id = s[1]
          if (!id) { add('REFERENCE_INVALID_PATH', path, `"${ref}": expected steps.<node id>.output…`, scope.nodeId); break }
          if (!nodeById.has(id)) { add('DANGLING_REFERENCE', path, `"${ref}" references unknown node "${id}"`, scope.nodeId); break }
          if (!STEP_FIELDS.includes(s[2] ?? '')) {
            add('REFERENCE_INVALID_PATH', path, `"${ref}": expected steps.${id}.(${STEP_FIELDS.join('|')})`, scope.nodeId)
            break
          }
          if (placed && !an.availableBefore.get(scope.nodeId!)!.has(id)) {
            add('REFERENCE_NOT_UPSTREAM', path, `"${ref}": "${id}" has not run before "${scope.nodeId}" on every path that reaches it`, scope.nodeId)
          }
          break
        }
        case 'item': {
          if (scope.goal) { add('ITEM_OUTSIDE_LOOP', path, `"${ref}": item is only defined inside a loop body`, scope.nodeId); break }
          if (!placed) break
          const loops = an.enclosingLoops.get(scope.nodeId!)!
          if (loops.length === 0) add('ITEM_OUTSIDE_LOOP', path, `"${ref}": item is only defined inside a loop body`, scope.nodeId)
          else if (!loops.some((l) => l.as === s[1])) {
            add('UNKNOWN_LOOP_VARIABLE', path, `"${ref}": no enclosing loop binds "${s[1] ?? ''}" (have: ${loops.map((l) => l.as).join(', ')})`, scope.nodeId)
          }
          break
        }
        default:
          add('UNKNOWN_REFERENCE_ROOT', path, `"${ref}": references start with trigger., steps., or item.`, scope.nodeId)
      }
    }
  }
  const scanTemplates = (v: unknown, path: string, nodeId: string) => {
    if (typeof v === 'string') checkRefs(parseTemplate(v), path, { nodeId })
    else if (Array.isArray(v)) v.forEach((x, i) => scanTemplates(x, `${path}[${i}]`, nodeId))
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) scanTemplates(x, `${path}.${k}`, nodeId)
  }
  for (const n of raw) {
    const p = pathOf(n.id)
    for (const f of TEMPLATE_FIELDS) if (n[f] !== undefined) scanTemplates(n[f], `${p}.${f}`, n.id)
    if (n.kind === 'loop' && typeof n.over === 'string') checkRefs(parseExpressionField(n.over), `${p}.over`, { nodeId: n.id })
    if (n.kind === 'branch' && Array.isArray(n.cases)) {
      n.cases.forEach((c, i) => {
        if (isObj(c) && typeof c.when === 'string') checkRefs(parseExpressionField(c.when), `${p}.cases[${i}].when`, { nodeId: n.id })
      })
    }
    if (n.kind === 'check' && Array.isArray(n.assert)) {
      n.assert.forEach((a, i) => {
        if (isObj(a) && typeof a.expr === 'string') checkRefs(parseExpressionField(a.expr), `${p}.assert[${i}].expr`, { nodeId: n.id })
      })
    }
  }
  // Belt and braces: a secret template anywhere (mock, output_schema, labels…).
  const sweepSecrets = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      if (hasSecretTemplate(v)) add('SECRET_REFERENCE', path, 'secrets never appear in a definition; Tools resolve their own credentials by name')
    } else if (Array.isArray(v)) v.forEach((x, i) => sweepSecrets(x, `${path}[${i}]`))
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) sweepSecrets(x, path ? `${path}.${k}` : k)
  }
  sweepSecrets(doc, '')

  // ── goal ─────────────────────────────────────────────────────────────────
  if (doc.goal === undefined) add('GOAL_MISSING', 'goal', 'a flow needs a goal with a machine-checkable end condition')
  else if (!isObj(doc.goal)) add('INVALID_FIELD', 'goal', 'goal must be an object')
  else {
    const g = doc.goal
    if (!isNonEmptyStr(g.statement)) add(g.statement === undefined ? 'MISSING_FIELD' : 'INVALID_FIELD', 'goal.statement', 'goal.statement must be a non-empty string')
    const ec = isObj(g.end_condition) ? g.end_condition : undefined
    const asserts = ec && Array.isArray(ec.assert) ? ec.assert : []
    if (asserts.length === 0) {
      add('GOAL_NO_DETERMINISTIC_ASSERT', 'goal.end_condition.assert', 'at least one deterministic assert is required (a judge is never the only check)')
    }
    asserts.forEach((a, i) => {
      const p = `goal.end_condition.assert[${i}]`
      if (!isObj(a) || !isNonEmptyStr(a.expr)) add('INVALID_FIELD', p, 'an assert is { expr, why? }')
      else checkRefs(parseExpressionField(a.expr), `${p}.expr`, { goal: true })
    })
    if (ec && ec.judge !== undefined) {
      const j = ec.judge
      if (!isObj(j) || !isNonEmptyStr(j.rubric) || !isNonEmptyStr(j.on)) add('INVALID_FIELD', 'goal.end_condition.judge', 'judge is { rubric, on, budget_usd? }')
      else {
        checkRefs(parseExpressionField(j.on), 'goal.end_condition.judge.on', { goal: true })
        if (j.budget_usd !== undefined && !isNonNegNum(j.budget_usd)) add('INVALID_FIELD', 'goal.end_condition.judge.budget_usd', 'budget_usd must be a non-negative number')
      }
    }
  }

  // ── effects + registry ───────────────────────────────────────────────────
  const reg = options.registry
  const effective = new Map<string, FlowEffect | null>()
  for (const n of raw) {
    const p = pathOf(n.id)
    if (n.effect !== undefined && !EFFECTFUL_KINDS.includes(n.kind as string)) {
      add('EFFECT_NOT_APPLICABLE', `${p}.effect`, `"${n.kind}" nodes have no side effect; remove "effect"`, n.id)
    }
    let eff = declaredOrDefaultEffect(n)
    const declared = FLOW_EFFECTS.includes(n.effect as FlowEffect) ? (n.effect as FlowEffect) : undefined
    const raise = (regEffect: FlowEffect, what: string) => {
      if (declared && EFFECT_RANK[declared] < EFFECT_RANK[regEffect]) {
        add('EFFECT_UNDERSTATED', `${p}.effect`, `"${n.id}" declares effect "${declared}" but ${what} is "${regEffect}"`, n.id)
      }
      if (!declared || EFFECT_RANK[regEffect] > EFFECT_RANK[declared]) eff = regEffect
    }
    if (reg && n.kind === 'tool' && typeof n.tool === 'string') {
      const t = reg.getTool(n.tool)
      if (!t) add('UNKNOWN_TOOL', `${p}.tool`, `no Tool "${n.tool}" in the registry`, n.id)
      else raise(t.effect ?? 'send', `Tool "${n.tool}"`)
    }
    if (reg && n.kind === 'mcp' && typeof n.connector === 'string') {
      const c = reg.getConnector(n.connector)
      if (!c) add('UNKNOWN_CONNECTOR', `${p}.connector`, `no connector "${n.connector}" in this workspace`, n.id)
      else {
        if (!c.enabled) add('CONNECTOR_DISABLED', `${p}.connector`, `connector "${n.connector}" is not enabled for this workspace`, n.id)
        if (c.getTool && typeof n.tool === 'string') {
          const t = c.getTool(n.tool)
          if (t === null) add('UNKNOWN_CONNECTOR_TOOL', `${p}.tool`, `connector "${n.connector}" has no tool "${n.tool}"`, n.id)
          else if (t) raise(t.effect ?? (t.readOnlyHint ? 'read' : 'send'), `${n.connector}.${n.tool}`)
        }
      }
    }
    if (reg && n.kind === 'llm' && Array.isArray(n.tools)) {
      n.tools.forEach((slug, i) => {
        if (typeof slug !== 'string') return
        const t = reg.getTool(slug)
        if (!t) add('UNKNOWN_TOOL', `${p}.tools[${i}]`, `no Tool "${slug}" in the registry`, n.id)
        else if ((t.effect ?? 'send') !== 'read') add('LLM_TOOL_NOT_READ_ONLY', `${p}.tools[${i}]`, `llm tool loops may only use read-only Tools; "${slug}" is "${t.effect ?? 'send'}"`, n.id)
      })
    }
    effective.set(n.id, eff)
  }

  // ── approvals (§5.4) ─────────────────────────────────────────────────────
  let approvedIds = new Set<string>()
  if (doc.approvals !== undefined) {
    const ap = doc.approvals
    if (!isObj(ap) || !isInt(ap.version) || !Array.isArray(ap.nodes) || typeof ap.by !== 'string' || typeof ap.at !== 'string') {
      add('INVALID_FIELD', 'approvals', 'approvals is { version, nodes[], by, at }')
    } else {
      let counts = true
      if (!/^user:\S+$/.test(ap.by)) {
        add('APPROVAL_INVALID_APPROVER', 'approvals.by', `approvals.by must be the owner ("user:<id>"); "${ap.by}" cannot approve`)
        counts = false
      }
      if (ap.version !== doc.version) {
        add('APPROVAL_VERSION_MISMATCH', 'approvals.version', `approvals were recorded for version ${ap.version}, this is version ${String(doc.version)} — they do not carry over`, undefined, 'warning')
        counts = false
      }
      ap.nodes.forEach((id, i) => {
        if (typeof id !== 'string' || !nodeById.has(id)) add('APPROVAL_UNKNOWN_NODE', `approvals.nodes[${i}]`, `approved node ${JSON.stringify(id)} does not exist`)
      })
      if (counts) approvedIds = new Set(ap.nodes.filter((x): x is string => typeof x === 'string'))
    }
  }
  const requireApprovals = options.requireApprovals !== false
  for (const id of an.order) {
    const eff = effective.get(id)
    if (eff !== 'send' && eff !== 'spend') continue
    if (an.approvalWaitBefore.get(id) || approvedIds.has(id)) continue
    add('UNAPPROVED_EFFECT', pathOf(id),
      `"${id}" is a ${eff} node with no approval wait before it and no owner approval for version ${String(doc.version)}`,
      id, requireApprovals ? 'error' : 'warning')
  }

  return done()
}

type Add = (code: FlowErrorCode, path: string, message: string, node_id?: string, severity?: FlowIssue['severity']) => void

function checkNodeShape(n: RawNode, p: string, add: Add): void {
  const id = n.id
  const kind = n.kind
  if (typeof kind !== 'string' || !(FLOW_NODE_KINDS as readonly string[]).includes(kind)) {
    add('UNKNOWN_NODE_KIND', `${p}.kind`, `unknown node kind ${JSON.stringify(kind)} (allowed: ${FLOW_NODE_KINDS.join(', ')})`, id)
    return
  }
  const need = (field: string, ok: boolean, what: string) => {
    if (n[field] === undefined) add('MISSING_FIELD', `${p}.${field}`, `${kind} "${id}" needs "${field}"`, id)
    else if (!ok) add('INVALID_FIELD', `${p}.${field}`, `${kind} "${id}": "${field}" must be ${what}`, id)
  }
  const opt = (field: string, ok: boolean, what: string) => {
    if (n[field] !== undefined && !ok) add('INVALID_FIELD', `${p}.${field}`, `${kind} "${id}": "${field}" must be ${what}`, id)
  }
  const isIdList = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')

  // common
  opt('label', typeof n.label === 'string', 'a string')
  opt('timeout_ms', isInt(n.timeout_ms) && n.timeout_ms > 0, 'a positive integer')
  opt('idempotency', n.idempotency === 'auto' || n.idempotency === 'none', '"auto" or "none"')
  opt('effect', FLOW_EFFECTS.includes(n.effect as FlowEffect), FLOW_EFFECTS.join(' | '))
  opt('mock', isObj(n.mock), 'an object')
  if (n.retry !== undefined) {
    const r = n.retry
    if (!isObj(r) || !isInt(r.max) || r.max < 0 || (r.backoff !== 'fixed' && r.backoff !== 'exponential') || !isInt(r.delay_ms) || r.delay_ms < 0) {
      add('INVALID_FIELD', `${p}.retry`, `${kind} "${id}": retry is { max: int ≥ 0, backoff: fixed|exponential, delay_ms: int ≥ 0 }`, id)
    }
  }
  const allowed = [...BASE_KEYS, ...KIND_KEYS[kind]]
  for (const k of Object.keys(n)) if (!allowed.includes(k)) add('UNKNOWN_FIELD', `${p}.${k}`, `${kind} "${id}": unknown field "${k}"`, id, 'warning')

  switch (kind) {
    case 'trigger':
      need('on', (TRIGGER_SOURCES as readonly string[]).includes(n.on as string), TRIGGER_SOURCES.join(' | '))
      if (n.on === 'schedule') need('schedule', isObj(n.schedule) && isNonEmptyStr(n.schedule.cron), '{ cron }')
      else opt('schedule', isObj(n.schedule) && isNonEmptyStr(n.schedule.cron), '{ cron }')
      if (n.on === 'event') need('event', isNonEmptyStr(n.event), 'an event name')
      else opt('event', isNonEmptyStr(n.event), 'an event name')
      break
    case 'tool':
      need('tool', isNonEmptyStr(n.tool), 'a Tool registry slug')
      opt('input', isObj(n.input), 'an object')
      break
    case 'mcp':
      need('connector', isNonEmptyStr(n.connector), 'a connector id')
      need('tool', isNonEmptyStr(n.tool), 'a tool name')
      opt('arguments', isObj(n.arguments), 'an object')
      break
    case 'llm':
      need('prompt', isNonEmptyStr(n.prompt), 'a non-empty string')
      need('output_schema', isObj(n.output_schema), 'a JSON Schema object')
      opt('model', isNonEmptyStr(n.model), 'a model name')
      if (n.max_iterations !== undefined) {
        if (!isInt(n.max_iterations) || n.max_iterations < 1) add('INVALID_FIELD', `${p}.max_iterations`, `llm "${id}": max_iterations must be an integer ≥ 1`, id)
        else if (n.max_iterations > LLM_MAX_ITERATIONS_CAP) {
          add('LLM_MAX_ITERATIONS_EXCEEDED', `${p}.max_iterations`, `llm "${id}": max_iterations ${n.max_iterations} exceeds the cap of ${LLM_MAX_ITERATIONS_CAP}`, id)
        }
      }
      opt('tools', Array.isArray(n.tools) && n.tools.every(isNonEmptyStr), 'a list of Tool slugs')
      opt('budget_usd', isNonNegNum(n.budget_usd), 'a non-negative number')
      break
    case 'agent':
      need('brief', isNonEmptyStr(n.brief), 'a non-empty string')
      opt('agent', isNonEmptyStr(n.agent), 'an agent name')
      opt('budget_usd', isNonNegNum(n.budget_usd), 'a non-negative number')
      break
    case 'branch':
      need('cases', Array.isArray(n.cases) && n.cases.length > 0 &&
        n.cases.every((c) => isObj(c) && isNonEmptyStr(c.when) && isIdList(c.then)), 'a non-empty list of { when, then: [node ids] }')
      opt('default', isNonEmptyStr(n.default) || isIdList(n.default), 'a node id or a list of node ids')
      break
    case 'loop':
      need('over', isNonEmptyStr(n.over), 'an expression yielding a list')
      need('as', typeof n.as === 'string' && /^[a-z][a-z0-9_]*$/.test(n.as), 'a lower_snake_case name')
      need('body', isIdList(n.body), 'a non-empty list of node ids')
      if (n.max_items === undefined) add('LOOP_MAX_ITEMS_MISSING', `${p}.max_items`, `loop "${id}" needs "max_items" (an unbounded loop is never allowed)`, id)
      else if (!isInt(n.max_items) || n.max_items < 1) add('INVALID_FIELD', `${p}.max_items`, `loop "${id}": max_items must be a positive integer`, id)
      if (n.concurrency !== undefined) {
        if (!isInt(n.concurrency) || n.concurrency < 1) add('INVALID_FIELD', `${p}.concurrency`, `loop "${id}": concurrency must be an integer ≥ 1`, id)
        else if (n.concurrency > LOOP_MAX_CONCURRENCY) {
          add('LOOP_CONCURRENCY_EXCEEDED', `${p}.concurrency`, `loop "${id}": concurrency ${n.concurrency} exceeds the cap of ${LOOP_MAX_CONCURRENCY}`, id)
        }
      }
      break
    case 'wait': {
      const modes = ['for', 'until', 'event', 'approval'].filter((k) => n[k] !== undefined)
      if (modes.length !== 1) {
        add('WAIT_MODE_INVALID', p, `wait "${id}" needs exactly one of for / until / event / approval (has ${modes.length ? modes.join(', ') : 'none'})`, id)
      }
      opt('for', typeof n.for === 'string' && (DURATION_RE.test(n.for.trim()) || n.for.includes('{{')), 'a duration like 30s, 15m, 2h, 1d or PT15M')
      opt('until', isNonEmptyStr(n.until), 'a timestamp or expression')
      opt('event', isNonEmptyStr(n.event), 'an event name')
      opt('approval', isObj(n.approval) && isNonEmptyStr(n.approval.from) && isNonEmptyStr(n.approval.prompt), '{ from, prompt }')
      break
    }
    case 'check':
      need('assert', Array.isArray(n.assert) && n.assert.length > 0 && n.assert.every((a) => isObj(a) && isNonEmptyStr(a.expr)), 'a non-empty list of { expr, why? }')
      opt('on_fail', ['fail', 'repair', 'continue'].includes(n.on_fail as string), 'fail | repair | continue')
      break
    case 'end':
      break
  }
}

/**
 * True when a `{{ … }}` template in `s` references `secrets.` — the same match
 * as the old `/\{\{[^}]*\bsecrets\s*\./`, which backtracked quadratically on a
 * string with many `{{` and no `}`. Each `{{` is scanned only up to the next
 * `}` and the scan resumes after that `}`, so every character is read once.
 */
export function hasSecretTemplate(s: string): boolean {
  let i = s.indexOf('{{')
  while (i >= 0) {
    const close = s.indexOf('}', i + 2)
    const body = close < 0 ? s.slice(i + 2) : s.slice(i + 2, close)
    if (/\bsecrets\s*\./.test(body)) return true
    if (close < 0) return false
    i = s.indexOf('{{', close + 1)
  }
  return false
}
