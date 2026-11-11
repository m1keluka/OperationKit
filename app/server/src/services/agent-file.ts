/**
 * Agent file format (obj 719986, shared contract with built-in chat obj 719987).
 *
 * One agent = one file: `agents/<slug>/agent.yaml`, or `agents/<slug>/agent.md`
 * with YAML front matter (the Markdown body is the system prompt when the
 * front matter has no `system_prompt`). This module is PURE — parse, validate
 * and serialize only, no disk or DB — so the server routes, the CLI script, the
 * tests and the chat runtime all share one definition of "a valid agent".
 *
 * There is deliberately no YAML dependency: adding one is an image rebuild on
 * every install, and an agent file only needs a small, well-defined subset
 * (maps, lists, quoted/plain scalars, `|`/`>` block text, `[a, b]` lists).
 * Anything outside that subset is reported as a clear error, never guessed at.
 */
import { PATTERN_RULES } from './secret-redaction.js'

export const AGENT_FILE_FORMAT_VERSION = 1

export interface AgentSchedule {
  name: string
  /** 5-field cron, server time. */
  cron: string
  /** What the agent is asked to do when the schedule fires. */
  prompt: string
}

export interface AgentFileDef {
  name: string
  slug: string
  description: string
  /** Emoji or up to 2 letters. Optional; the UI derives a monogram otherwise. */
  avatar: string | null
  /** One of AGENT_COLOURS. */
  colour: AgentColour | null
  system_prompt: string
  /** Knowledge-base folders the agent may read/write, relative to the KB root. */
  knowledge_folders: string[]
  /** Allowed MCP tools / connectors, by name. */
  tools: string[]
  /** Optional; omitted = workspace default. */
  model: string | null
  provider: AgentProvider | null
  schedules: AgentSchedule[]
  version: string
  author: string
}

export const AGENT_COLOURS = ['blue', 'pink', 'green', 'amber', 'grey'] as const
export type AgentColour = (typeof AGENT_COLOURS)[number]

/** Colour name → the existing agent design tokens (tailwind `agent.*`). */
export const AGENT_COLOUR_TOKENS: Record<AgentColour, { tw: string; hex: string }> = {
  blue: { tw: 'bg-agent-cto', hex: '#6F9AD8' },
  pink: { tw: 'bg-agent-cmo', hex: '#D389B0' },
  green: { tw: 'bg-agent-coo', hex: '#6FB58C' },
  amber: { tw: 'bg-agent-cfo', hex: '#D6A24E' },
  grey: { tw: 'bg-agent-general', hex: '#8C8A92' },
}

export const AGENT_PROVIDERS = ['claude', 'anthropic', 'openai', 'xai', 'openai-compatible', 'demo'] as const
export type AgentProvider = (typeof AGENT_PROVIDERS)[number]

/**
 * Tool names the platform knows today (agreed with obj 719987). Anything else is
 * a WARNING, not an error: a client may add their own MCP connectors, and a
 * template written for a newer install must still import on an older one.
 */
export const KNOWN_AGENT_TOOLS = [
  // knowledge base (scoped to knowledge_folders)
  'search', 'list_folders', 'read_file', 'write_doc', 'file_answer',
  // board
  'create_objective', 'get_objective', 'list_objectives',
  // connectors (drafts only — a person presses Send)
  'email', 'calendar',
] as const

export const AGENT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/
const TOOL_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const FOLDER_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]*$/
const MAX_PROMPT = 20000

const KNOWN_KEYS = new Set([
  'name', 'slug', 'description', 'avatar', 'colour', 'color', 'system_prompt',
  'knowledge_folders', 'tools', 'model', 'provider', 'schedules', 'version', 'author',
  'format',
])

export interface AgentFileProblem {
  field: string
  message: string
}

export type ParseAgentResult =
  | { ok: true; agent: AgentFileDef; warnings: AgentFileProblem[] }
  | { ok: false; errors: AgentFileProblem[]; warnings: AgentFileProblem[] }

// ── Minimal YAML subset ─────────────────────────────────────────────────────

export class YamlSubsetError extends Error {
  constructor(public line: number, message: string) {
    super(`line ${line}: ${message}`)
  }
}

type YamlValue = string | YamlValue[] | { [k: string]: YamlValue }

interface Line { n: number; indent: number; text: string }

function stripComment(s: string): string {
  // A `#` starts a comment only at line start or after whitespace, and never
  // inside quotes.
  let q: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === '\\' && q === '"') { i++; continue }
      if (c === q) q = null
    } else if (c === '"' || c === "'") {
      q = c
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd()
    }
  }
  return s
}

function parseScalar(raw: string, n: number): string {
  const s = raw.trim()
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlSubsetError(n, 'unclosed double quote')
    try {
      return JSON.parse(s) as string
    } catch {
      throw new YamlSubsetError(n, 'invalid double-quoted text')
    }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlSubsetError(n, 'unclosed single quote')
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s === '~' || s === 'null') return ''
  if (/^[&*!%@`]/.test(s)) throw new YamlSubsetError(n, `unsupported YAML feature "${s[0]}" — quote the value`)
  if (s.startsWith('{')) throw new YamlSubsetError(n, 'inline {…} maps are not supported — use one key per line')
  return s
}

function parseFlowList(s: string, n: number): string[] {
  const inner = s.trim().slice(1, -1).trim()
  if (!inner) return []
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (q) {
      cur += c
      if (c === '\\' && q === '"') { cur += inner[++i] ?? ''; continue }
      if (c === q) q = null
    } else if (c === '"' || c === "'") {
      q = c; cur += c
    } else if (c === ',') {
      out.push(parseScalar(cur, n)); cur = ''
    } else if (c === '[' || c === '{') {
      throw new YamlSubsetError(n, 'nested lists/maps inside [ … ] are not supported')
    } else {
      cur += c
    }
  }
  if (q) throw new YamlSubsetError(n, 'unclosed quote inside [ … ]')
  if (cur.trim()) out.push(parseScalar(cur, n))
  return out
}

/** Split `key: rest` respecting quotes in the key is unnecessary — keys are plain. */
function splitKey(text: string, n: number): [string, string] | null {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*)|\s*)$/.exec(text)
  if (!m) return null
  void n
  return [m[1], m[2] ?? '']
}

class Parser {
  i = 0
  constructor(private lines: Line[], private raw: string[]) {}

  peek(): Line | undefined { return this.lines[this.i] }

  parseBlock(indent: number): YamlValue {
    const first = this.peek()
    if (!first) return ''
    if (first.text.startsWith('- ') || first.text === '-') return this.parseList(first.indent)
    return this.parseMap(indent)
  }

  parseMap(indent: number): { [k: string]: YamlValue } {
    const out: { [k: string]: YamlValue } = {}
    while (this.i < this.lines.length) {
      const ln = this.lines[this.i]
      if (ln.indent < indent) break
      if (ln.indent > indent) throw new YamlSubsetError(ln.n, 'unexpected indentation')
      if (ln.text.startsWith('- ')) throw new YamlSubsetError(ln.n, 'a list item where a "key: value" line was expected')
      const kv = splitKey(ln.text, ln.n)
      if (!kv) throw new YamlSubsetError(ln.n, `expected "key: value", got "${ln.text.slice(0, 40)}"`)
      const [key, rest] = kv
      if (key in out) throw new YamlSubsetError(ln.n, `"${key}" appears twice`)
      this.i++
      out[key] = this.parseValue(rest, ln, indent)
    }
    return out
  }

  parseList(indent: number): YamlValue[] {
    const out: YamlValue[] = []
    while (this.i < this.lines.length) {
      const ln = this.lines[this.i]
      if (ln.indent < indent) break
      if (ln.indent > indent) throw new YamlSubsetError(ln.n, 'unexpected indentation')
      if (!(ln.text.startsWith('- ') || ln.text === '-')) break
      const rest = ln.text === '-' ? '' : ln.text.slice(2).trim()
      const kv = rest ? splitKey(rest, ln.n) : null
      if (kv && !rest.startsWith('"') && !rest.startsWith("'")) {
        // `- key: value` starts a map item; following keys sit at indent + 2.
        const childIndent = indent + 2
        this.lines[this.i] = { n: ln.n, indent: childIndent, text: rest }
        out.push(this.parseMap(childIndent))
      } else {
        this.i++
        if (!rest) {
          const next = this.peek()
          out.push(next && next.indent > indent ? this.parseBlock(next.indent) : '')
        } else if (rest.startsWith('[')) {
          out.push(parseFlowList(rest, ln.n))
        } else {
          out.push(parseScalar(rest, ln.n))
        }
      }
    }
    return out
  }

  parseValue(rest: string, ln: Line, indent: number): YamlValue {
    const r = rest.trim()
    if (/^[|>][-+]?$/.test(r)) return this.parseBlockScalar(r, ln, indent)
    if (r.startsWith('[')) {
      if (!r.endsWith(']')) throw new YamlSubsetError(ln.n, 'unclosed [ … ] list')
      return parseFlowList(r, ln.n)
    }
    if (r) return parseScalar(r, ln.n)
    const next = this.peek()
    if (!next || next.indent < indent) return ''
    if (next.indent === indent) {
      // YAML allows `key:\n- item` at the same indent for lists.
      return next.text.startsWith('- ') || next.text === '-' ? this.parseList(indent) : ''
    }
    return this.parseBlock(next.indent)
  }

  /** `|` keeps newlines, `>` folds them; `-` strips the final newline. Reads RAW
   *  lines so blank lines and `#` inside prompt text survive. */
  parseBlockScalar(style: string, ln: Line, indent: number): string {
    const folded = style.startsWith('>')
    const chomp = style.slice(1)
    const body: string[] = []
    let blockIndent = -1
    let rawIdx = ln.n // ln.n is 1-based; raw[ln.n] is the next line
    while (rawIdx < this.raw.length) {
      const line = this.raw[rawIdx]
      if (line.trim() === '') { body.push(''); rawIdx++; continue }
      const ind = line.length - line.trimStart().length
      if (blockIndent === -1) {
        if (ind <= indent) break
        blockIndent = ind
      }
      if (ind < blockIndent) break
      body.push(line.slice(blockIndent))
      rawIdx++
    }
    // Drop trailing blank lines from the block (they belong to the gap).
    while (body.length && body[body.length - 1] === '') { body.pop(); rawIdx-- }
    while (this.i < this.lines.length && this.lines[this.i].n <= rawIdx) this.i++
    let text = folded
      ? body.reduce((acc, l, k) => (k === 0 ? l : l === '' ? acc + '\n' : acc.endsWith('\n') ? acc + l : `${acc} ${l}`), '')
      : body.join('\n')
    if (chomp !== '-') text += '\n'
    return text
  }
}

/** Parse the YAML subset into plain objects. Throws YamlSubsetError. */
export function parseYamlSubset(src: string): YamlValue {
  const raw = src.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n')
  const lines: Line[] = []
  raw.forEach((l, idx) => {
    if (/\t/.test(l.slice(0, l.length - l.trimStart().length))) {
      throw new YamlSubsetError(idx + 1, 'tabs are not allowed for indentation — use spaces')
    }
    const t = stripComment(l)
    if (!t.trim() || t.trim() === '---' || t.trim() === '...') return
    lines.push({ n: idx + 1, indent: t.length - t.trimStart().length, text: t.trim() })
  })
  if (!lines.length) return {}
  const p = new Parser(lines, raw)
  const v = p.parseBlock(lines[0].indent)
  if (p.i < lines.length) throw new YamlSubsetError(lines[p.i].n, 'could not read this line (check its indentation)')
  return v
}

// ── Front matter ────────────────────────────────────────────────────────────

/** Split `---\n<yaml>\n---\n<body>`. Returns null when there is no front matter. */
export function splitFrontMatter(src: string): { yaml: string; body: string; bodyLine: number } | null {
  const text = src.replace(/\r\n?/g, '\n').replace(/^﻿/, '')
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 4)
  if (end === -1) return null
  const afterFence = text.indexOf('\n', end + 4)
  const yaml = text.slice(4, end + 1)
  const body = afterFence === -1 ? '' : text.slice(afterFence + 1)
  return { yaml, body, bodyLine: yaml.split('\n').length + 2 }
}

// ── Validation ──────────────────────────────────────────────────────────────

function asString(v: YamlValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asStringList(
  v: YamlValue | undefined,
  field: string,
  errors: AgentFileProblem[],
): string[] {
  if (v === undefined || v === '') return []
  if (typeof v === 'string') return [v.trim()].filter(Boolean)
  if (!Array.isArray(v)) {
    errors.push({ field, message: 'must be a list, e.g. one "- item" per line' })
    return []
  }
  const out: string[] = []
  v.forEach((item, i) => {
    if (typeof item !== 'string') errors.push({ field: `${field}[${i}]`, message: 'must be plain text' })
    else if (item.trim()) out.push(item.trim())
  })
  return out
}

/** Reject anything that looks like a pasted credential. Agent files are meant to
 *  be shared; secrets are referenced by NAME and live in Settings → Secrets. */
function findSecretLike(src: string): string[] {
  const hits: string[] = []
  for (const rule of PATTERN_RULES) {
    if (!rule.high) continue
    rule.re.lastIndex = 0
    if (rule.re.test(src)) hits.push(rule.family)
    rule.re.lastIndex = 0
  }
  return hits
}

export interface ParseOptions {
  /** The file name or path (used to pick YAML vs Markdown and to check the folder slug). */
  filename?: string
}

/**
 * Parse + validate an agent file. Never throws: every problem comes back as a
 * `{field, message}` pair written for a non-technical reader.
 */
export function parseAgentFile(src: string, opts: ParseOptions = {}): ParseAgentResult {
  const errors: AgentFileProblem[] = []
  const warnings: AgentFileProblem[] = []
  const fail = (): ParseAgentResult => ({ ok: false, errors, warnings })

  if (typeof src !== 'string' || !src.trim()) {
    errors.push({ field: 'file', message: 'the file is empty' })
    return fail()
  }
  if (src.length > 200_000) {
    errors.push({ field: 'file', message: 'the file is too large (limit 200 KB)' })
    return fail()
  }

  const secretHits = findSecretLike(src)
  if (secretHits.length) {
    errors.push({
      field: 'file',
      message: `the file appears to contain a secret value (${secretHits.join(', ')}). Remove it — agent files reference secrets by name only; store values in Settings → Secrets.`,
    })
    return fail()
  }

  const filename = opts.filename ?? ''
  const isMd = /\.(md|markdown)$/i.test(filename) || (!/\.ya?ml$/i.test(filename) && src.replace(/^﻿/, '').startsWith('---\n'))
  let yamlText = src
  let body = ''
  if (isMd) {
    const fm = splitFrontMatter(src)
    if (!fm) {
      errors.push({ field: 'file', message: 'a .md agent file must start with YAML front matter between two "---" lines' })
      return fail()
    }
    yamlText = fm.yaml
    body = fm.body.trim()
  }

  let doc: YamlValue
  try {
    doc = parseYamlSubset(yamlText)
  } catch (err) {
    errors.push({ field: 'file', message: (err as Error).message })
    return fail()
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    errors.push({ field: 'file', message: 'the file must be a list of "key: value" fields' })
    return fail()
  }
  const o = doc as Record<string, YamlValue>

  for (const k of Object.keys(o)) {
    if (!KNOWN_KEYS.has(k)) warnings.push({ field: k, message: `unknown field "${k}" is ignored` })
  }

  const name = asString(o.name)?.trim() ?? ''
  if (!name) errors.push({ field: 'name', message: 'is required (the display name, e.g. "Personal assistant")' })
  else if (name.length > 80) errors.push({ field: 'name', message: 'must be 80 characters or fewer' })

  const slug = asString(o.slug)?.trim() ?? ''
  if (!slug) errors.push({ field: 'slug', message: 'is required (a short id like "personal-assistant")' })
  else if (!AGENT_SLUG_RE.test(slug)) errors.push({ field: 'slug', message: 'must be 2–41 characters: lowercase letters, numbers and hyphens, starting with a letter or number' })
  else if (filename) {
    const parts = filename.replace(/\\/g, '/').split('/')
    const base = parts[parts.length - 1]
    const folder = parts.length >= 2 ? parts[parts.length - 2] : ''
    if (/^agent\.(ya?ml|md)$/i.test(base) && folder && AGENT_SLUG_RE.test(folder) && folder !== slug) {
      errors.push({ field: 'slug', message: `"${slug}" must match its folder name "${folder}" (agents/<slug>/agent.yaml)` })
    }
  }

  const description = asString(o.description)?.trim() ?? ''
  if (o.description !== undefined && typeof o.description !== 'string') errors.push({ field: 'description', message: 'must be plain text' })
  if (!description) warnings.push({ field: 'description', message: 'is empty — a one-line description helps people pick the right agent' })
  else if (description.length > 500) errors.push({ field: 'description', message: 'must be 500 characters or fewer' })

  const avatarRaw = asString(o.avatar)?.trim() ?? ''
  if (avatarRaw && [...avatarRaw].length > 2 && !/^\p{Extended_Pictographic}/u.test(avatarRaw)) {
    errors.push({ field: 'avatar', message: 'must be one emoji or up to 2 letters' })
  }

  let colour: AgentColour | null = null
  if (o.colour !== undefined && o.color !== undefined) warnings.push({ field: 'color', message: 'both "colour" and "color" are set; "colour" is used' })
  const colourRaw = (asString(o.colour) ?? asString(o.color) ?? '').trim().toLowerCase()
  if (colourRaw) {
    const norm = colourRaw === 'gray' ? 'grey' : colourRaw
    if ((AGENT_COLOURS as readonly string[]).includes(norm)) colour = norm as AgentColour
    else warnings.push({ field: 'colour', message: `"${colourRaw}" is not one of ${AGENT_COLOURS.join(', ')} — grey is used` })
  }

  let systemPrompt = typeof o.system_prompt === 'string' ? o.system_prompt.trim() : ''
  if (o.system_prompt !== undefined && typeof o.system_prompt !== 'string') {
    errors.push({ field: 'system_prompt', message: 'must be text (use "system_prompt: |" and indent the instructions below it)' })
  }
  if (!systemPrompt && body) systemPrompt = body
  else if (systemPrompt && body) warnings.push({ field: 'system_prompt', message: 'both the front matter and the Markdown body set instructions; the front matter wins' })
  if (!systemPrompt) errors.push({ field: 'system_prompt', message: 'is required — these are the agent\'s instructions' })
  else if (systemPrompt.length > MAX_PROMPT) errors.push({ field: 'system_prompt', message: `must be ${MAX_PROMPT} characters or fewer` })

  const knowledgeFolders = asStringList(o.knowledge_folders, 'knowledge_folders', errors).map(f => f.replace(/\/+$/, ''))
  knowledgeFolders.forEach((f, i) => {
    const segs = f.split('/')
    if (f.startsWith('/') || f.startsWith('~') || /^[A-Za-z]:/.test(f)) {
      errors.push({ field: `knowledge_folders[${i}]`, message: `"${f}" must be a folder inside the knowledge base (relative, e.g. "notes/clients"), not a full server path` })
    } else if (segs.some(s => s === '..' || s === '.' || !FOLDER_SEGMENT_RE.test(s))) {
      errors.push({ field: `knowledge_folders[${i}]`, message: `"${f}" is not a valid folder name (letters, numbers, spaces, "-", "_" and "/" only; no "..")` })
    }
  })

  const tools = asStringList(o.tools, 'tools', errors)
  tools.forEach((t, i) => {
    if (!TOOL_RE.test(t)) errors.push({ field: `tools[${i}]`, message: `"${t}" is not a valid tool name (lowercase letters, numbers, "_", "-", ".", ":")` })
    else if (!(KNOWN_AGENT_TOOLS as readonly string[]).includes(t)) {
      warnings.push({ field: `tools[${i}]`, message: `"${t}" is not a built-in tool; it only works if a connector with that name is installed` })
    }
  })

  const model = asString(o.model)?.trim() || null
  const providerRaw = asString(o.provider)?.trim().toLowerCase() || ''
  let provider: AgentProvider | null = null
  if (providerRaw) {
    if ((AGENT_PROVIDERS as readonly string[]).includes(providerRaw)) provider = providerRaw as AgentProvider
    else errors.push({ field: 'provider', message: `"${providerRaw}" is not supported; use one of ${AGENT_PROVIDERS.join(', ')}, or leave it out to use the workspace default` })
  }

  const schedules: AgentSchedule[] = []
  if (o.schedules !== undefined && o.schedules !== '') {
    if (!Array.isArray(o.schedules)) {
      errors.push({ field: 'schedules', message: 'must be a list of { name, cron, prompt }' })
    } else {
      o.schedules.forEach((s, i) => {
        const f = `schedules[${i}]`
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
          errors.push({ field: f, message: 'must have name, cron and prompt fields' })
          return
        }
        const sn = asString(s.name)?.trim() ?? ''
        const cron = asString(s.cron)?.trim() ?? ''
        const sp = asString(s.prompt)?.trim() ?? ''
        if (!sn) errors.push({ field: `${f}.name`, message: 'is required' })
        if (cron.split(/\s+/).length !== 5 || !/^[\d*/,\-\sA-Za-z?]+$/.test(cron)) {
          errors.push({ field: `${f}.cron`, message: `"${cron}" must be a 5-part schedule, e.g. "0 8 * * 1-5" (8:00 on weekdays)` })
        }
        if (!sp) errors.push({ field: `${f}.prompt`, message: 'is required — what should the agent do when this runs?' })
        schedules.push({ name: sn, cron, prompt: sp })
      })
    }
  }

  let version = asString(o.version)?.trim() ?? ''
  if (!version) {
    version = '0.1.0'
    warnings.push({ field: 'version', message: 'is missing; "0.1.0" is used' })
  } else if (!SEMVER_RE.test(version)) {
    errors.push({ field: 'version', message: `"${version}" must look like 1.0.0 (major.minor.patch)` })
  }

  let author = asString(o.author)?.trim() ?? ''
  if (!author) {
    author = 'unknown'
    warnings.push({ field: 'author', message: 'is missing; "unknown" is used' })
  } else if (author.length > 120) {
    errors.push({ field: 'author', message: 'must be 120 characters or fewer' })
  }

  if (errors.length) return fail()
  return {
    ok: true,
    warnings,
    agent: {
      name,
      slug,
      description,
      avatar: avatarRaw || null,
      colour,
      system_prompt: systemPrompt,
      knowledge_folders: knowledgeFolders,
      tools,
      model,
      provider,
      schedules,
      version,
      author,
    },
  }
}

/** One-line human summary of validation problems, for CLI / logs. */
export function formatProblems(problems: AgentFileProblem[]): string {
  return problems.map(p => `- ${p.field}: ${p.message}`).join('\n')
}

// ── Serialization ───────────────────────────────────────────────────────────

const PLAIN_SAFE = /^[A-Za-z0-9][A-Za-z0-9 _.,()/'&+-]*$/
const RESERVED_PLAIN = /^(true|false|yes|no|on|off|null|~|-?\d+(\.\d+)?)$/i

function yamlScalar(s: string): string {
  if (s && PLAIN_SAFE.test(s) && !RESERVED_PLAIN.test(s) && !s.endsWith(' ') && !/:\s|\s#/.test(s)) return s
  return JSON.stringify(s)
}

function yamlBlock(key: string, text: string, indent = ''): string[] {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n')
  return [`${indent}${key}: |`, ...lines.map(l => (l ? `${indent}  ${l}` : ''))]
}

/** Canonical `agent.yaml` text. Round-trips through parseAgentFile. */
export function serializeAgentYaml(a: AgentFileDef): string {
  const out: string[] = [
    '# Agent file — format: docs/agents/agent-file-format.md',
    `name: ${yamlScalar(a.name)}`,
    `slug: ${a.slug}`,
    `description: ${yamlScalar(a.description)}`,
  ]
  if (a.avatar) out.push(`avatar: ${JSON.stringify(a.avatar)}`)
  if (a.colour) out.push(`colour: ${a.colour}`)
  out.push(`version: ${yamlScalar(a.version)}`)
  out.push(`author: ${yamlScalar(a.author)}`)
  if (a.model) out.push(`model: ${yamlScalar(a.model)}`)
  if (a.provider) out.push(`provider: ${a.provider}`)
  out.push('knowledge_folders:' + (a.knowledge_folders.length ? '' : ' []'))
  for (const f of a.knowledge_folders) out.push(`  - ${yamlScalar(f)}`)
  out.push('tools:' + (a.tools.length ? '' : ' []'))
  for (const t of a.tools) out.push(`  - ${t}`)
  if (a.schedules.length) {
    out.push('schedules:')
    for (const s of a.schedules) {
      out.push(`  - name: ${yamlScalar(s.name)}`)
      out.push(`    cron: ${JSON.stringify(s.cron)}`)
      out.push(...yamlBlock('prompt', s.prompt, '    '))
    }
  }
  out.push(...yamlBlock('system_prompt', a.system_prompt))
  return out.join('\n') + '\n'
}

/**
 * The instructions block a worker / chat session sees for this agent: the
 * system prompt, plus plain statements of the folder and tool limits so the
 * model knows its scope even where the runtime enforces it separately.
 */
export function renderAgentInstructions(a: AgentFileDef): string {
  const parts = [`# ${a.name}`, '', a.system_prompt.trim()]
  if (a.knowledge_folders.length) {
    parts.push('', '## Knowledge folders', '', 'You may read and write only these knowledge-base folders:', ...a.knowledge_folders.map(f => `- ${f}`))
  }
  if (a.tools.length) {
    parts.push('', '## Tools', '', 'You may use only these tools and connectors:', ...a.tools.map(t => `- ${t}`))
  }
  return parts.join('\n')
}
