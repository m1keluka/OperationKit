// RFC 6902 JSON Patch, applied immutably (card B8, docs/design/WORKFLOWS.md §5.3).
//
// The repair agent answers with "a JSON Patch against the definition plus a
// one-paragraph explanation". This is the whole applier — no dependency — so the
// shared package stays dependency-free and the server, the classifier tests and
// a future UI all apply a patch identically.
//
// Supported: add, remove, replace, move, copy, test; RFC 6901 pointers with the
// `~0` / `~1` escapes and the `-` (append) array index. The input document is
// never mutated: the patch is applied to a deep copy and either every operation
// succeeds or the caller gets the first failing operation's index and reason.

export type JsonPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown }

export const JSON_PATCH_MAX_OPS = 100

export type JsonPatchResult<T> =
  | { ok: true; doc: T }
  | { ok: false; index: number; error: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** RFC 6901 pointer → reference tokens. `''` is the whole document. */
export function parseJsonPointer(pointer: string): string[] | null {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) return null
  return pointer.slice(1).split('/').map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

/** Array index token: a canonical non-negative integer (`-` only where the caller allows it). */
function arrayIndex(token: string, length: number, allowEnd: boolean): number | null {
  if (allowEnd && token === '-') return length
  if (!/^(0|[1-9]\d*)$/.test(token)) return null
  const i = Number(token)
  return i <= (allowEnd ? length : length - 1) ? i : null
}

function get(doc: unknown, tokens: string[]): { ok: true; value: unknown } | { ok: false } {
  let cur = doc
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      const i = arrayIndex(t, cur.length, false)
      if (i === null) return { ok: false }
      cur = cur[i]
    } else if (isObj(cur)) {
      if (!Object.prototype.hasOwnProperty.call(cur, t)) return { ok: false }
      cur = cur[t]
    } else {
      return { ok: false }
    }
  }
  return { ok: true, value: cur }
}

/** The container holding the last token, or an error. */
function parentOf(doc: unknown, tokens: string[]): unknown {
  const p = get(doc, tokens.slice(0, -1))
  return p.ok ? p.value : undefined
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

type Box = { root: unknown }

function addAt(box: Box, tokens: string[], value: unknown): string | null {
  if (tokens.length === 0) { box.root = value; return null }
  const key = tokens[tokens.length - 1]
  if (FORBIDDEN_KEYS.has(key)) return `key "${key}" is not allowed`
  const parent = parentOf(box.root, tokens)
  if (Array.isArray(parent)) {
    const i = arrayIndex(key, parent.length, true)
    if (i === null) return `array index "${key}" is out of range`
    parent.splice(i, 0, value)
    return null
  }
  if (isObj(parent)) { parent[key] = value; return null }
  return 'parent path does not exist'
}

function removeAt(box: Box, tokens: string[]): string | null {
  if (tokens.length === 0) return 'cannot remove the whole document'
  const key = tokens[tokens.length - 1]
  const parent = parentOf(box.root, tokens)
  if (Array.isArray(parent)) {
    const i = arrayIndex(key, parent.length, false)
    if (i === null) return `array index "${key}" is out of range`
    parent.splice(i, 1)
    return null
  }
  if (isObj(parent) && Object.prototype.hasOwnProperty.call(parent, key)) { delete parent[key]; return null }
  return 'path does not exist'
}

function opError(op: unknown): string | null {
  if (!isObj(op)) return 'operation must be an object'
  if (typeof op.op !== 'string' || !['add', 'remove', 'replace', 'move', 'copy', 'test'].includes(op.op)) return `unknown op "${String(op.op)}"`
  if (typeof op.path !== 'string' || parseJsonPointer(op.path) === null) return 'path must be a JSON pointer ("" or "/…")'
  if ((op.op === 'move' || op.op === 'copy') && (typeof op.from !== 'string' || parseJsonPointer(op.from) === null)) return 'from must be a JSON pointer'
  if ((op.op === 'add' || op.op === 'replace' || op.op === 'test') && !('value' in op)) return `"${op.op}" needs a value`
  return null
}

/** Shape check only (no document): is this a list of well-formed operations? */
export function isJsonPatch(raw: unknown): raw is JsonPatchOp[] {
  return Array.isArray(raw) && raw.length <= JSON_PATCH_MAX_OPS && raw.every((op) => opError(op) === null)
}

/** Apply `ops` to a deep copy of `doc`. All-or-nothing. */
export function applyJsonPatch<T>(doc: T, ops: unknown): JsonPatchResult<T> {
  if (!Array.isArray(ops)) return { ok: false, index: -1, error: 'patch must be a list of operations' }
  if (ops.length === 0) return { ok: false, index: -1, error: 'patch is empty' }
  if (ops.length > JSON_PATCH_MAX_OPS) return { ok: false, index: -1, error: `patch has more than ${JSON_PATCH_MAX_OPS} operations` }
  const box: Box = { root: clone(doc) }
  for (let i = 0; i < ops.length; i++) {
    const bad = opError(ops[i])
    if (bad) return { ok: false, index: i, error: bad }
    const op = ops[i] as JsonPatchOp
    const path = parseJsonPointer(op.path)!
    let err: string | null = null
    switch (op.op) {
      case 'add':
        err = addAt(box, path, clone(op.value))
        break
      case 'remove':
        err = removeAt(box, path)
        break
      case 'replace': {
        if (!get(box.root, path).ok) { err = 'path does not exist'; break }
        if (path.length === 0) { box.root = clone(op.value); break }
        err = removeAt(box, path) ?? addAt(box, path, clone(op.value))
        break
      }
      case 'move': {
        const from = parseJsonPointer(op.from)!
        if (op.path.startsWith(`${op.from}/`)) { err = 'cannot move a value into one of its own children'; break }
        const v = get(box.root, from)
        if (!v.ok) { err = 'from does not exist'; break }
        err = removeAt(box, from) ?? addAt(box, path, v.value)
        break
      }
      case 'copy': {
        const v = get(box.root, parseJsonPointer(op.from)!)
        if (!v.ok) { err = 'from does not exist'; break }
        err = addAt(box, path, clone(v.value))
        break
      }
      case 'test': {
        const v = get(box.root, path)
        if (!v.ok || !deepEqual(v.value, op.value)) err = 'test failed'
        break
      }
    }
    if (err) return { ok: false, index: i, error: `${op.op} ${op.path}: ${err}` }
  }
  return { ok: true, doc: box.root as T }
}
