// okflow/1 expressions: a tiny path syntax plus a fixed list of pure functions
// and comparison/boolean operators. No eval, no arithmetic, no jq (§3.2).
//
//   expr    := or
//   or      := and ('||' and)*
//   and     := cmp ('&&' cmp)*
//   cmp     := unary (('=='|'!='|'<'|'<='|'>'|'>=') unary)?
//   unary   := ('!'|'-') unary | primary
//   primary := number | string | true | false | null | '(' expr ')'
//            | ident '(' args? ')'                 -- allowed function
//            | ident ('.' ident | '[' int ']')*     -- reference path

import { FLOW_FUNCTIONS } from './types.js'
import type { FlowErrorCode } from './types.js'

export interface ExprRef {
  /** e.g. ['steps', 'fetch', 'output', 'bookings'] (indexes become strings). */
  segments: string[]
}

export interface ExprProblem {
  code: Extract<FlowErrorCode, 'EXPR_SYNTAX' | 'EXPR_UNKNOWN_FUNCTION' | 'EXPR_ARITY'>
  message: string
}

export interface ParsedExpr {
  refs: ExprRef[]
  problems: ExprProblem[]
}

type Tok =
  | { t: 'id'; v: string }
  | { t: 'num'; v: string }
  | { t: 'str'; v: string }
  | { t: 'op'; v: string }

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
      if (!/^\d+(\.\d+)?$/.test(v)) throw new SyntaxError(`bad number "${v}"`)
      out.push({ t: 'num', v }); i = j; continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let v = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { v += src[j + 1]; j += 2; continue }
        v += src[j++]
      }
      if (j >= src.length) throw new SyntaxError('unterminated string')
      out.push({ t: 'str', v }); i = j + 1; continue
    }
    const op = OPS.find((o) => src.startsWith(o, i))
    if (!op) throw new SyntaxError(`unexpected character "${c}"`)
    out.push({ t: 'op', v: op }); i += op.length
  }
  return out
}

/** Parse one expression (no surrounding `{{ }}`), collecting references and problems. */
export function parseExpression(src: string): ParsedExpr {
  const refs: ExprRef[] = []
  const problems: ExprProblem[] = []
  let toks: Tok[]
  try {
    toks = tokenize(src)
  } catch (e) {
    return { refs, problems: [{ code: 'EXPR_SYNTAX', message: `${(e as Error).message} in "${src}"` }] }
  }
  if (toks.length === 0) return { refs, problems: [{ code: 'EXPR_SYNTAX', message: 'empty expression' }] }
  let p = 0
  const peek = (v?: string) => {
    const tk = toks[p]
    return tk && (v === undefined || (tk.t === 'op' && tk.v === v)) ? tk : undefined
  }
  const expect = (v: string) => {
    if (!peek(v)) throw new SyntaxError(`expected "${v}"`)
    p++
  }

  const primary = (): void => {
    const tk = toks[p]
    if (!tk) throw new SyntaxError('unexpected end of expression')
    if (tk.t === 'num' || tk.t === 'str') { p++; return }
    if (tk.t === 'op' && tk.v === '(') { p++; or(); expect(')'); return }
    if (tk.t !== 'id') throw new SyntaxError(`unexpected "${tk.v}"`)
    p++
    if (['true', 'false', 'null'].includes(tk.v)) return
    if (peek('(')) {
      p++
      let argc = 0
      if (!peek(')')) {
        or(); argc++
        while (peek(',')) { p++; or(); argc++ }
      }
      expect(')')
      const fn = FLOW_FUNCTIONS[tk.v]
      if (!Object.prototype.hasOwnProperty.call(FLOW_FUNCTIONS, tk.v)) {
        problems.push({ code: 'EXPR_UNKNOWN_FUNCTION', message: `unknown function "${tk.v}()" (allowed: ${Object.keys(FLOW_FUNCTIONS).join(', ')})` })
      } else if (argc < fn.min || argc > fn.max) {
        const want = fn.min === fn.max ? `${fn.min}` : `${fn.min}-${fn.max}`
        problems.push({ code: 'EXPR_ARITY', message: `${tk.v}() takes ${want} argument(s), got ${argc}` })
      }
      return
    }
    const segments = [tk.v]
    for (;;) {
      if (peek('.')) {
        p++
        const nx = toks[p]
        if (!nx || nx.t !== 'id') throw new SyntaxError('expected a name after "."')
        segments.push(nx.v); p++
      } else if (peek('[')) {
        p++
        const nx = toks[p]
        if (!nx || nx.t !== 'num' || nx.v.includes('.')) throw new SyntaxError('expected an integer index inside [ ]')
        segments.push(nx.v); p++
        expect(']')
      } else break
    }
    refs.push({ segments })
  }
  const unary = (): void => {
    if (peek('!') || peek('-')) { p++; unary(); return }
    primary()
  }
  const cmp = (): void => {
    unary()
    const tk = toks[p]
    if (tk && tk.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(tk.v)) { p++; unary() }
  }
  const and = (): void => {
    cmp()
    while (peek('&&')) { p++; cmp() }
  }
  const or = (): void => {
    and()
    while (peek('||')) { p++; and() }
  }

  try {
    or()
    if (p < toks.length) throw new SyntaxError(`unexpected "${toks[p].v}"`)
  } catch (e) {
    problems.push({ code: 'EXPR_SYNTAX', message: `${(e as Error).message} in "${src}"` })
  }
  return { refs, problems }
}

/** Every `{{ … }}` segment in a string, parsed. An unclosed `{{` is a syntax problem. */
export function parseTemplate(src: string): ParsedExpr {
  const refs: ExprRef[] = []
  const problems: ExprProblem[] = []
  let i = 0
  for (;;) {
    const open = src.indexOf('{{', i)
    if (open < 0) break
    const close = src.indexOf('}}', open + 2)
    if (close < 0) {
      problems.push({ code: 'EXPR_SYNTAX', message: `unclosed "{{" in "${src}"` })
      break
    }
    const r = parseExpression(src.slice(open + 2, close))
    refs.push(...r.refs)
    problems.push(...r.problems)
    i = close + 2
  }
  return { refs, problems }
}

/**
 * An expression-valued field (`when`, `over`, `assert[].expr`, `judge.on`):
 * either bare (`a == 1`) or one wrapped template (`{{ a == 1 }}`).
 */
export function parseExpressionField(src: string): ParsedExpr {
  const s = src.trim()
  if (s.startsWith('{{') && s.endsWith('}}') && s.indexOf('{{', 2) < 0) return parseExpression(s.slice(2, -2))
  if (s.includes('{{')) return parseTemplate(s)
  return parseExpression(s)
}
