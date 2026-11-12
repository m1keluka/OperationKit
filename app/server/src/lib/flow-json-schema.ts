/**
 * A small JSON Schema subset checker for `llm.output_schema` (obj 900639, card B3
 * of docs/design/WORKFLOWS.md §3.2 / §4.4). No dependency: the card adds none.
 *
 * Supported keywords — the ones an `output_schema` for a classification /
 * extraction step actually uses:
 *
 *   type (string or array; integer|number|string|boolean|object|array|null),
 *   enum, const, properties, required, additionalProperties (bool or schema),
 *   items (one schema), minItems, maxItems, minLength, maxLength, pattern,
 *   minimum, maximum, exclusiveMinimum, exclusiveMaximum, anyOf, oneOf, allOf, not.
 *
 * Annotations (`title`, `description`, `default`, `examples`, `$schema`, …) are
 * ignored. An UNSUPPORTED assertion keyword (`$ref`, `patternProperties`,
 * `if/then/else`, …) is reported by {@link unsupportedSchemaKeywords} so the
 * engine can refuse the node up front instead of silently under-checking.
 */

export interface SchemaIssue {
  /** JSON-pointer-ish path to the offending value, `$` = the root. */
  path: string
  message: string
}

const ANNOTATIONS = new Set([
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples', 'deprecated',
  'readOnly', 'writeOnly', 'format', 'contentMediaType', 'contentEncoding',
])
const SUPPORTED = new Set([
  'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'anyOf', 'oneOf', 'allOf', 'not',
])

const MAX_DEPTH = 32
const MAX_ISSUES = 20

type Schema = Record<string, unknown>
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Every assertion keyword in the schema tree this checker does not implement. */
export function unsupportedSchemaKeywords(schema: unknown, depth = 0): string[] {
  if (!isObj(schema) || depth > MAX_DEPTH) return []
  const out = new Set<string>()
  for (const [k, v] of Object.entries(schema)) {
    if (!SUPPORTED.has(k) && !ANNOTATIONS.has(k)) out.add(k)
    if (k === 'properties' && isObj(v)) for (const sub of Object.values(v)) unsupportedSchemaKeywords(sub, depth + 1).forEach((x) => out.add(x))
    if ((k === 'items' || k === 'additionalProperties' || k === 'not') && isObj(v)) unsupportedSchemaKeywords(v, depth + 1).forEach((x) => out.add(x))
    if ((k === 'anyOf' || k === 'oneOf' || k === 'allOf') && Array.isArray(v)) for (const sub of v) unsupportedSchemaKeywords(sub, depth + 1).forEach((x) => out.add(x))
  }
  return [...out].sort()
}

function typeOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number'
  return typeof v
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v)
  if (t === 'number') return actual === 'number' || actual === 'integer'
  return actual === t
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]))
  }
  const ka = Object.keys(a as object)
  const kb = Object.keys(b as object)
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

const show = (v: unknown) => {
  const s = JSON.stringify(v)
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s
}

function check(value: unknown, schema: unknown, path: string, issues: SchemaIssue[], depth: number): void {
  if (issues.length >= MAX_ISSUES) return
  if (schema === true || schema === undefined) return
  if (schema === false) { issues.push({ path, message: 'no value is allowed here' }); return }
  if (!isObj(schema)) return
  if (depth > MAX_DEPTH) { issues.push({ path, message: 'schema nests too deeply' }); return }
  const s = schema as Schema
  const add = (message: string) => { if (issues.length < MAX_ISSUES) issues.push({ path, message }) }

  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]).map(String)
    if (!types.some((t) => typeMatches(value, t))) {
      add(`expected ${types.join(' | ')}, got ${typeOf(value)}`)
      return // the rest of the keywords assume the right type
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, value))) add(`must be one of ${show(s.enum)}, got ${show(value)}`)
  if ('const' in s && !deepEqual(s.const, value)) add(`must equal ${show(s.const)}`)

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && [...value].length < s.minLength) add(`must be at least ${s.minLength} characters`)
    if (typeof s.maxLength === 'number' && [...value].length > s.maxLength) add(`must be at most ${s.maxLength} characters`)
    if (typeof s.pattern === 'string') {
      let re: RegExp | null = null
      try { re = new RegExp(s.pattern, 'u') } catch { add(`schema pattern ${show(s.pattern)} is not a valid regular expression`) }
      if (re && !re.test(value)) add(`must match ${show(s.pattern)}`)
    }
  }
  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) add(`must be ≥ ${s.minimum}`)
    if (typeof s.maximum === 'number' && value > s.maximum) add(`must be ≤ ${s.maximum}`)
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) add(`must be > ${s.exclusiveMinimum}`)
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) add(`must be < ${s.exclusiveMaximum}`)
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) add(`must have at least ${s.minItems} items`)
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) add(`must have at most ${s.maxItems} items`)
    if (s.items !== undefined) value.forEach((item, i) => check(item, s.items, `${path}[${i}]`, issues, depth + 1))
  }
  if (isObj(value)) {
    const props = isObj(s.properties) ? s.properties : {}
    if (Array.isArray(s.required)) {
      for (const k of s.required) if (typeof k === 'string' && !(k in value)) add(`missing required property ${show(k)}`)
    }
    for (const [k, v] of Object.entries(value)) {
      if (k in props) check(v, props[k], `${path}.${k}`, issues, depth + 1)
      else if (s.additionalProperties === false) add(`unexpected property ${show(k)}`)
      else if (isObj(s.additionalProperties)) check(v, s.additionalProperties, `${path}.${k}`, issues, depth + 1)
    }
  }

  const passes = (sub: unknown) => { const tmp: SchemaIssue[] = []; check(value, sub, path, tmp, depth + 1); return tmp.length === 0 }
  if (Array.isArray(s.allOf)) for (const sub of s.allOf) check(value, sub, path, issues, depth + 1)
  if (Array.isArray(s.anyOf) && !s.anyOf.some(passes)) add('does not match any of the allowed shapes (anyOf)')
  if (Array.isArray(s.oneOf)) {
    const n = s.oneOf.filter(passes).length
    if (n !== 1) add(`must match exactly one shape (oneOf), matched ${n}`)
  }
  if (s.not !== undefined && passes(s.not)) add('matches a shape that is not allowed (not)')
}

/** Validate `value` against `schema`. Empty array = valid. */
export function validateAgainstSchema(value: unknown, schema: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  check(value, schema, '$', issues, 0)
  return issues
}

/**
 * Pull one JSON value out of a model reply. Accepts the bare JSON, a reply
 * wrapped in a ```json fence, or JSON with prose around it (the first balanced
 * object/array that parses). Returns `undefined` when nothing parses — the
 * caller turns that into a schema-invalid output, never a guess.
 */
export function extractJson(text: string): unknown {
  const t = (text ?? '').trim()
  if (!t) return undefined
  const tryParse = (s: string): unknown => { try { return JSON.parse(s) } catch { return undefined } }
  const whole = tryParse(t)
  if (whole !== undefined) return whole
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(t)
  if (fence) {
    const v = tryParse(fence[1].trim())
    if (v !== undefined) return v
  }
  for (let i = 0; i < t.length; i++) {
    const open = t[i]
    if (open !== '{' && open !== '[') continue
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inStr = false
    for (let j = i; j < t.length; j++) {
      const c = t[j]
      if (inStr) {
        if (c === '\\') j++
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === open) depth++
      else if (c === close && --depth === 0) {
        const v = tryParse(t.slice(i, j + 1))
        if (v !== undefined) return v
        break
      }
    }
  }
  return undefined
}
