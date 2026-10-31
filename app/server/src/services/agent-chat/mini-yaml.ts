// ── Minimal YAML reader for agent files (obj 719987) ──
//
// The agent file format (agents/<slug>/agent.yaml, or agent.md with YAML front
// matter) only needs a small slice of YAML, and the server has no YAML
// dependency (adding one means an image rebuild). This reader covers exactly
// that slice:
//   key: scalar            plain, 'single' or "double" quoted, numbers, booleans, null
//   key: [a, "b c"]        flow lists of scalars
//   key:                   block list of scalars or of one-level maps
//     - item
//     - name: x
//       cron: "0 9 * * 1"
//   key: |  /  key: >      block strings (literal / folded), with optional -/+ chomping
//   # comments, blank lines
// Anything else is reported as an error with its line number instead of being
// guessed at. The sibling agent-templates card owns the canonical
// parser (services/agent-file.ts); this one exists so chat does not depend on
// that landing first.

export type YamlScalar = string | number | boolean | null
export type YamlValue = YamlScalar | YamlValue[] | { [k: string]: YamlValue }

export class YamlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`line ${line}: ${message}`)
  }
}

interface Line { n: number; indent: number; text: string }

function stripComment(s: string): string {
  let q: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q) q = null
    } else if (c === '"' || c === "'") {
      q = c
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd()
    }
  }
  return s.trimEnd()
}

export function parseScalar(raw: string, line = 0): YamlScalar {
  const s = raw.trim()
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError('unterminated "quoted" string', line)
    try {
      return JSON.parse(s) as string
    } catch {
      throw new YamlError('bad escape in "quoted" string', line)
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError("unterminated 'quoted' string", line)
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

function splitFlow(inner: string, line: number): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (const c of inner) {
    if (q) {
      cur += c
      if (c === q) q = null
    } else if (c === '"' || c === "'") {
      q = c
      cur += c
    } else if (c === ',') {
      out.push(cur)
      cur = ''
    } else if (c === '[' || c === '{') {
      throw new YamlError('nested flow collections are not supported', line)
    } else {
      cur += c
    }
  }
  if (q) throw new YamlError('unterminated quoted string in list', line)
  if (cur.trim() !== '' || out.length > 0) out.push(cur)
  return out.map(x => x.trim()).filter(x => x !== '')
}

function inlineValue(raw: string, line: number): YamlValue {
  const s = raw.trim()
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new YamlError('unterminated [list]', line)
    return splitFlow(s.slice(1, -1), line).map(x => parseScalar(x, line))
  }
  if (s.startsWith('{')) throw new YamlError('inline {maps} are not supported — use one key per line', line)
  return parseScalar(s, line)
}

const KEY_RE = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/

/** Parse a YAML document (the subset above) into a plain object. */
export function parseMiniYaml(text: string): Record<string, YamlValue> {
  const raw = text.replace(/\r\n?/g, '\n').split('\n')
  let i = 0

  const peek = (): Line | null => {
    while (i < raw.length) {
      const t = raw[i]
      if (/^\s*$/.test(t) || /^\s*#/.test(t)) { i++; continue }
      if (/^\t/.test(t)) throw new YamlError('tabs are not allowed for indentation', i + 1)
      const indent = t.length - t.trimStart().length
      return { n: i + 1, indent, text: stripComment(t.trim()) }
    }
    return null
  }

  const blockString = (style: string, parentIndent: number): string => {
    const lines: string[] = []
    let blockIndent = -1
    while (i < raw.length) {
      const t = raw[i]
      if (/^\s*$/.test(t)) { lines.push(''); i++; continue }
      const ind = t.length - t.trimStart().length
      if (ind <= parentIndent) break
      if (blockIndent < 0) blockIndent = ind
      if (ind < blockIndent) break
      lines.push(t.slice(blockIndent))
      i++
    }
    const chomp = style.includes('-') ? 'strip' : style.includes('+') ? 'keep' : 'clip'
    let body: string
    if (style.startsWith('>')) {
      body = ''
      for (let k = 0; k < lines.length; k++) {
        const l = lines[k]
        if (l === '') body += '\n'
        else if (/^\s/.test(l)) body += (body && !body.endsWith('\n') ? '\n' : '') + l + '\n'
        else body += (body && !body.endsWith('\n') ? ' ' : '') + l
      }
    } else {
      body = lines.join('\n')
    }
    if (chomp === 'keep') return body.endsWith('\n') ? body : body + '\n'
    body = body.replace(/\n+$/, '')
    return chomp === 'strip' ? body : body + '\n'
  }

  const parseMap = (indent: number): Record<string, YamlValue> => {
    const obj: Record<string, YamlValue> = {}
    for (;;) {
      const ln = peek()
      if (!ln || ln.indent < indent) return obj
      if (ln.indent > indent) throw new YamlError('unexpected indentation', ln.n)
      if (ln.text.startsWith('- ') || ln.text === '-') throw new YamlError('list item where a key was expected', ln.n)
      const m = ln.text.match(KEY_RE)
      if (!m) throw new YamlError(`expected "key: value", got "${ln.text.slice(0, 40)}"`, ln.n)
      const key = m[1]
      const rest = (m[2] ?? '').trim()
      if (key in obj) throw new YamlError(`duplicate key "${key}"`, ln.n)
      i++
      if (/^[|>][+-]?$/.test(rest)) {
        obj[key] = blockString(rest, indent)
      } else if (rest !== '') {
        obj[key] = inlineValue(rest, ln.n)
      } else {
        const next = peek()
        if (!next || next.indent < indent || (next.indent === indent && !next.text.startsWith('-'))) {
          obj[key] = null
        } else if (next.text.startsWith('-')) {
          obj[key] = parseList(next.indent)
        } else {
          obj[key] = parseMap(next.indent)
        }
      }
    }
  }

  const parseList = (indent: number): YamlValue[] => {
    const arr: YamlValue[] = []
    for (;;) {
      const ln = peek()
      if (!ln || ln.indent < indent) return arr
      if (ln.indent > indent) throw new YamlError('unexpected indentation in list', ln.n)
      if (!(ln.text === '-' || ln.text.startsWith('- '))) return arr
      const item = ln.text === '-' ? '' : ln.text.slice(2).trim()
      const km = item.match(KEY_RE)
      if (km && !item.startsWith('"') && !item.startsWith("'")) {
        // "- key: value" opens a one-level map; its other keys sit 2 cols in.
        const childIndent = indent + 2
        raw[i] = ' '.repeat(childIndent) + item
        arr.push(parseMap(childIndent))
      } else {
        i++
        arr.push(inlineValue(item, ln.n))
      }
    }
  }

  const first = peek()
  if (!first) return {}
  if (first.indent !== 0) throw new YamlError('top-level keys must not be indented', first.n)
  const out = parseMap(0)
  const leftover = peek()
  if (leftover) throw new YamlError('could not read this line', leftover.n)
  return out
}

/** Split "---\nfront matter\n---\nbody" into its two parts (null when absent). */
export function splitFrontMatter(text: string): { front: string; body: string } | null {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  if (!t.startsWith('---\n')) return null
  const end = t.indexOf('\n---', 4)
  if (end < 0) return null
  const after = t.slice(end + 4)
  if (after !== '' && !after.startsWith('\n')) return null
  return { front: t.slice(4, end + 1), body: after.replace(/^\n/, '') }
}
