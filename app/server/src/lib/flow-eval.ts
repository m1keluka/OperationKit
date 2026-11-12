// okflow/1 expression EVALUATOR (obj 900638, card B2).
//
// `app/shared/flow/expr.ts` (B1) parses and checks expressions for the validator
// but never evaluates them. This is the matching evaluator the engine uses for
// `branch.cases[].when`, `check.assert[].expr`, `end.output` and `{{ }}` inputs.
// Same grammar, same closed function list, no eval, no arithmetic beyond unary
// minus. Definitions reaching the engine have already passed validateFlow(), so
// a syntax error here is a bug or a hand-edited row — it throws FlowExprError.
//
//   expr    := or
//   or      := and ('||' and)*
//   and     := cmp ('&&' cmp)*
//   cmp     := unary (('=='|'!='|'<'|'<='|'>'|'>=') unary)?
//   unary   := ('!'|'-') unary | primary
//   primary := number | string | true | false | null | '(' expr ')'
//            | ident '(' args? ')' | ident ('.' ident | '[' int ']')*

export class FlowExprError extends Error {}

/** What a reference can see. `steps.<id>.output` is the memoised output of an upstream node. */
export interface FlowEvalScope {
  trigger: { payload: unknown }
  steps: Record<string, { output: unknown; input?: unknown }>
  item?: Record<string, unknown>
  /** Clock for `now()` — injected so tests are deterministic. */
  now: () => Date
}

type Tok = { t: 'id' | 'num' | 'str' | 'op'; v: string }
const OPS = ['==', '!=', '<=', '>=', '&&', '||', '<', '>', '!', '-', '(', ')', ',', '.', '[', ']']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[0-9.]/.test(src[j])) j++
      const v = src.slice(i, j)
      if (!/^\d+(\.\d+)?$/.test(v)) throw new FlowExprError(`bad number "${v}"`)
      out.push({ t: 'num', v }); i = j; continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let v = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue }
        v += src[j++]
      }
      if (j >= src.length) throw new FlowExprError('unterminated string')
      out.push({ t: 'str', v }); i = j + 1; continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new FlowExprError(`unexpected character "${c}"`)
    out.push({ t: 'op', v: op }); i += op.length
  }
  return out
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  return !!v
}

function getPath(base: unknown, seg: string): unknown {
  if (base === null || base === undefined) return null
  if (Array.isArray(base) && /^\d+$/.test(seg)) return base[Number(seg)] ?? null
  if (typeof base === 'object' && Object.prototype.hasOwnProperty.call(base, seg)) {
    return (base as Record<string, unknown>)[seg] ?? null
  }
  return null
}

const DAY_MS = 86_400_000
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: DAY_MS, week: 7 * DAY_MS }

function callFn(name: string, args: unknown[], scope: FlowEvalScope): unknown {
  switch (name) {
    case 'len': {
      const v = args[0]
      if (Array.isArray(v) || typeof v === 'string') return v.length
      if (isObj(v)) return Object.keys(v).length
      return 0
    }
    case 'now': return scope.now().toISOString()
    case 'date_add': {
      const [d, n, unitRaw] = args
      const unit = String(unitRaw).replace(/s$/, '')
      const ms = UNIT_MS[unit]
      const t = new Date(String(d)).getTime()
      if (!ms || Number.isNaN(t) || typeof n !== 'number') throw new FlowExprError(`date_add(${JSON.stringify(d)}, ${JSON.stringify(n)}, ${JSON.stringify(unitRaw)}) is not a valid date/amount/unit`)
      return new Date(t + n * ms).toISOString()
    }
    case 'lower': return args[0] === null || args[0] === undefined ? '' : String(args[0]).toLowerCase()
    case 'join': {
      const list = Array.isArray(args[0]) ? args[0] : []
      return list.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(args.length > 1 ? String(args[1]) : ',')
    }
    case 'default': return args[0] === null || args[0] === undefined ? args[1] : args[0]
    default: throw new FlowExprError(`unknown function "${name}()"`)
  }
}

/** Evaluate one expression (no surrounding `{{ }}`). */
export function evaluateExpression(src: string, scope: FlowEvalScope): unknown {
  const toks = tokenize(src)
  if (!toks.length) throw new FlowExprError('empty expression')
  let p = 0
  const isOp = (v: string) => toks[p]?.t === 'op' && toks[p].v === v
  const expect = (v: string) => {
    if (!isOp(v)) throw new FlowExprError(`expected "${v}" in "${src}"`)
    p++
  }

  const primary = (): unknown => {
    const tk = toks[p]
    if (!tk) throw new FlowExprError(`unexpected end of "${src}"`)
    if (tk.t === 'num') { p++; return Number(tk.v) }
    if (tk.t === 'str') { p++; return tk.v }
    if (tk.t === 'op' && tk.v === '(') { p++; const v = or(); expect(')'); return v }
    if (tk.t !== 'id') throw new FlowExprError(`unexpected "${tk.v}" in "${src}"`)
    p++
    if (tk.v === 'true') return true
    if (tk.v === 'false') return false
    if (tk.v === 'null') return null
    if (isOp('(')) {
      p++
      const args: unknown[] = []
      if (!isOp(')')) {
        args.push(or())
        while (isOp(',')) { p++; args.push(or()) }
      }
      expect(')')
      return callFn(tk.v, args, scope)
    }
    let cur: unknown
    switch (tk.v) {
      case 'trigger': cur = scope.trigger; break
      case 'steps': cur = scope.steps; break
      case 'item': cur = scope.item ?? null; break
      default: throw new FlowExprError(`unknown reference root "${tk.v}"`)
    }
    for (;;) {
      if (isOp('.')) {
        p++
        const nx = toks[p]
        if (!nx || nx.t !== 'id') throw new FlowExprError(`expected a name after "." in "${src}"`)
        cur = getPath(cur, nx.v); p++
      } else if (isOp('[')) {
        p++
        const nx = toks[p]
        if (!nx || nx.t !== 'num' || nx.v.includes('.')) throw new FlowExprError(`expected an integer index in "${src}"`)
        cur = getPath(cur, nx.v); p++
        expect(']')
      } else break
    }
    return cur === undefined ? null : cur
  }
  const unary = (): unknown => {
    if (isOp('!')) { p++; return !truthy(unary()) }
    if (isOp('-')) {
      p++
      const v = unary()
      if (typeof v !== 'number') throw new FlowExprError(`unary "-" needs a number in "${src}"`)
      return -v
    }
    return primary()
  }
  const cmp = (): unknown => {
    const left = unary()
    const tk = toks[p]
    if (!tk || tk.t !== 'op' || !['==', '!=', '<', '<=', '>', '>='].includes(tk.v)) return left
    p++
    const right = unary()
    switch (tk.v) {
      case '==': return deepEqual(left, right)
      case '!=': return !deepEqual(left, right)
    }
    const comparable =
      (typeof left === 'number' && typeof right === 'number') || (typeof left === 'string' && typeof right === 'string')
    if (!comparable) return false
    const l = left as number | string
    const r = right as number | string
    return tk.v === '<' ? l < r : tk.v === '<=' ? l <= r : tk.v === '>' ? l > r : l >= r
  }
  const and = (): unknown => {
    let v = cmp()
    while (isOp('&&')) { p++; const r = cmp(); v = truthy(v) && truthy(r) }
    return v
  }
  const or = (): unknown => {
    let v = and()
    while (isOp('||')) { p++; const r = and(); v = truthy(v) || truthy(r) }
    return v
  }

  const v = or()
  if (p < toks.length) throw new FlowExprError(`unexpected "${toks[p].v}" in "${src}"`)
  return v
}

/** An expression-valued field: bare (`a == 1`) or one wrapped template (`{{ a == 1 }}`). */
export function evaluateExpressionField(src: string, scope: FlowEvalScope): unknown {
  const s = src.trim()
  if (s.startsWith('{{') && s.endsWith('}}') && s.indexOf('{{', 2) < 0) return evaluateExpression(s.slice(2, -2), scope)
  if (s.includes('{{')) return renderTemplateString(s, scope)
  return evaluateExpression(s, scope)
}

export function evaluateCondition(src: string, scope: FlowEvalScope): boolean {
  return truthy(evaluateExpressionField(src, scope))
}

function renderTemplateString(src: string, scope: FlowEvalScope): unknown {
  const t = src.trim()
  // A string that is exactly one `{{ expr }}` keeps the value's type (list, number…).
  if (t.startsWith('{{') && t.endsWith('}}') && t.indexOf('{{', 2) < 0 && !t.slice(0, -1).includes('}}')) {
    return evaluateExpression(t.slice(2, -2), scope)
  }
  let out = ''
  let i = 0
  for (;;) {
    const open = src.indexOf('{{', i)
    if (open < 0) { out += src.slice(i); break }
    const close = src.indexOf('}}', open + 2)
    if (close < 0) throw new FlowExprError(`unclosed "{{" in "${src}"`)
    out += src.slice(i, open)
    const v = evaluateExpression(src.slice(open + 2, close), scope)
    out += v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v)
    i = close + 2
  }
  return out
}

/** Resolve every `{{ }}` inside a JSON value (node `input`, `end.output`). Non-strings pass through. */
export function resolveTemplates(value: unknown, scope: FlowEvalScope): unknown {
  if (typeof value === 'string') return value.includes('{{') ? renderTemplateString(value, scope) : value
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, scope))
  if (isObj(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplates(v, scope)
    return out
  }
  return value
}
