/**
 * Server-side secret redaction (obj 715532).
 *
 * One module answers "could this text carry a credential?" for every surface
 * that hands text to a bot or persists it for later display:
 *
 *   - /api/files system roots   (search snippets, stat previews, downloads)
 *   - /api/secrets-broker       (upstream response bodies + headers)
 *   - DB writes                 (activity_log, objectives summaries/descriptions… — db/write-scrubber.ts)
 *   - session transcripts       (the jsonl stream filter + the /output read path)
 *
 * Two layers, applied in this order:
 *
 *   1. KNOWN VALUES — every configured secret value (the native secrets store,
 *      secret-looking process env vars, and configured `.env` files) is
 *      replaced by `[REDACTED:<NAME>]`. Exact, so it never over-matches, and the
 *      marker names the env var a worker can use instead.
 *   2. PATTERNS — credential shapes we were never told about (API key prefixes,
 *      JWTs, PEM private keys, Bearer headers, `password=` assignments,
 *      `scheme://user:pass@` connection strings).
 *
 * Values never leave this module: callers get redacted text + a count, and the
 * registry exposes names only. Values shorter than MIN_SECRET_LEN are ignored —
 * replacing every "true" or "example" would shred ordinary text.
 */
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { decryptSecret } from './secrets-crypto.js'

export const MIN_SECRET_LEN = 8
const REGISTRY_TTL_MS = 60_000

export interface RedactResult {
  text: string
  count: number
}

// ── Known-value registry ────────────────────────────────────────────────────

/** Env var NAMES that look like credentials. Shared with the transcript filter. */
export const SECRET_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE|CREDENTIAL|DSN|SALT|COOKIE|AUTH)/i

/** Values that are obviously not secrets even under a secret-looking name. */
export function isPlausibleSecretValue(value: string): boolean {
  if (!value || value.length < MIN_SECRET_LEN) return false
  if (/^(true|false|null|none|undefined|user|absent)$/i.test(value)) return false
  if (/^\d+$/.test(value)) return false
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('~/')) return false
  return true
}

/** URL-ish env values carry a credential only when they embed `user:pass@`. */
const CONN_WITH_CREDS = /^[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i

export function isSecretEnvEntry(name: string, value: string | undefined): boolean {
  if (!value) return false
  if (CONN_WITH_CREDS.test(value)) return true
  return SECRET_NAME_RE.test(name) && isPlausibleSecretValue(value)
}

interface Registry {
  /** value → name; the longest value wins when one value contains another. */
  byValue: Map<string, string>
  matcher: RegExp | null
  loadedAt: number
}

let registry: Registry | null = null
const extraValues = new Map<string, string>()

/** Force a reload on next use (called by the secrets store after every write). */
export function invalidateSecretRegistry(): void {
  registry = null
}

/** Test seam: register a value without touching the store or env. */
export function registerKnownSecret(name: string, value: string): void {
  if (value && value.length >= MIN_SECRET_LEN) extraValues.set(value, name)
  registry = null
}

export function clearRegisteredSecretsForTests(): void {
  extraValues.clear()
  registry = null
}

function envFileSources(): string[] {
  const raw = process.env.CC_REDACT_ENV_FILES
  const list = raw !== undefined
    ? raw.split(',').map(s => s.trim()).filter(Boolean)
    : ['/home/operator/projects/operationkit/.env', '/home/operator/env-master']
  const files: string[] = []
  for (const p of list) {
    try {
      const st = fs.statSync(p)
      if (st.isFile()) files.push(p)
      else if (st.isDirectory()) {
        for (const name of fs.readdirSync(p)) {
          if (/^\.env/i.test(name) || /\.env$/i.test(name)) files.push(path.join(p, name))
        }
      }
    } catch { /* missing source — skip */ }
  }
  return files
}

const ENV_LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/

function parseEnvValue(raw: string): string {
  let v = raw.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
  else v = v.replace(/\s+#.*$/, '')
  return v
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function loadRegistry(): Registry {
  const byValue = new Map<string, string>()
  const add = (name: string, value: string | undefined | null) => {
    if (!value || value.length < MIN_SECRET_LEN) return
    if (!byValue.has(value)) byValue.set(value, name)
    // The JSON-escaped form is what lands in jsonl / metadata columns when the
    // value contains quotes, backslashes or newlines (PEM keys).
    const escaped = JSON.stringify(value).slice(1, -1)
    if (escaped !== value && !byValue.has(escaped)) byValue.set(escaped, name)
  }

  // 1. Native secrets store — every row in every scope (store keys win naming).
  try {
    const rows = getDb().prepare('SELECT key, value_encrypted FROM secrets').all() as { key: string; value_encrypted: string }[]
    for (const r of rows) {
      try { add(r.key, decryptSecret(r.value_encrypted)) } catch { /* undecryptable row — skip */ }
    }
  } catch { /* db not ready / no master key — env + files still apply */ }

  // 2. Test/ops registrations.
  for (const [value, name] of extraValues) add(name, value)

  // 3. Secret-looking process env.
  for (const [name, value] of Object.entries(process.env)) {
    if (isSecretEnvEntry(name, value)) add(name, value)
  }

  // 4. Configured .env files.
  for (const file of envFileSources()) {
    let text: string
    try { text = fs.readFileSync(file, 'utf-8') } catch { continue }
    for (const line of text.split('\n')) {
      const m = ENV_LINE_RE.exec(line)
      if (!m) continue
      const value = parseEnvValue(m[2])
      if (isSecretEnvEntry(m[1], value)) add(m[1], value)
    }
  }

  const values = [...byValue.keys()].sort((a, b) => b.length - a.length)
  const matcher = values.length ? new RegExp(values.map(escapeRe).join('|'), 'g') : null
  return { byValue, matcher, loadedAt: Date.now() }
}

function getRegistry(): Registry {
  if (!registry || Date.now() - registry.loadedAt > REGISTRY_TTL_MS) registry = loadRegistry()
  return registry
}

/** Names (never values) currently known to the redactor. */
export function knownSecretNames(): string[] {
  return [...new Set(getRegistry().byValue.values())].sort()
}

/**
 * Replace every known secret value with `[REDACTED:<NAME>]`.
 * `extra` adds one-off values (e.g. the exact values a broker call injected),
 * so a stale registry can never let them through.
 */
export function redactKnownValues(text: string, extra?: Map<string, string>): RedactResult {
  if (!text || text.length < MIN_SECRET_LEN) return { text, count: 0 }
  let count = 0
  let out = text
  if (extra && extra.size) {
    const vals = [...extra.keys()].filter(v => v.length >= MIN_SECRET_LEN).sort((a, b) => b.length - a.length)
    if (vals.length) {
      out = out.replace(new RegExp(vals.map(escapeRe).join('|'), 'g'), v => { count++; return `[REDACTED:${extra.get(v)}]` })
    }
  }
  const reg = getRegistry()
  if (reg.matcher) {
    reg.matcher.lastIndex = 0
    out = out.replace(reg.matcher, v => { count++; return `[REDACTED:${reg.byValue.get(v)}]` })
  }
  return { text: out, count }
}

// ── Pattern detection ───────────────────────────────────────────────────────

interface PatternRule {
  family: string
  re: RegExp
  /** high = precise shape; safe to apply to transcripts as well as file reads. */
  high: boolean
  /** Optional replacement builder; default replaces the whole match. */
  replace?: (m: string, ...groups: string[]) => string | null
}

const PLACEHOLDER_VALUE = /^(\[REDACTED|\$|\{|<|%|\*{3})|^(null|none|true|false|undefined|changeme|example|xxx+|\.\.\.|…)$/i

/** Order matters: block/structured shapes first so later rules don't split them. */
export const PATTERN_RULES: PatternRule[] = [
  { family: 'PRIVATE_KEY', high: true, re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|(?=")|$)/g },
  { family: 'JWT', high: true, re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { family: 'CC_API_KEY', high: true, re: /\bcc_live_[A-Za-z0-9_-]{16,}/g },
  { family: 'ANTHROPIC_KEY', high: true, re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { family: 'OPENAI_KEY', high: true, re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { family: 'STRIPE_KEY', high: true, re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { family: 'SUPABASE_KEY', high: true, re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g },
  { family: 'GITHUB_TOKEN', high: true, re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { family: 'SLACK_TOKEN', high: true, re: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g },
  { family: 'AWS_ACCESS_KEY', high: true, re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { family: 'GOOGLE_API_KEY', high: true, re: /\bAIza[0-9A-Za-z_-]{35}/g },
  {
    family: 'CONN_PASSWORD', high: true,
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@'"]+):([^\s@/'"]+)@/gi,
    replace: (_m, scheme, user, pass) => (PLACEHOLDER_VALUE.test(pass) ? null : `${scheme}${user}:[REDACTED:CONN_PASSWORD]@`),
  },
  {
    family: 'BEARER', high: false,
    re: /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{16,})/g,
    replace: (_m, scheme, sp, tok) => (/\d/.test(tok) && /[A-Za-z]/.test(tok) && !tok.startsWith('[REDACTED') ? `${scheme}${sp}[REDACTED:BEARER]` : null),
  },
  {
    family: 'ASSIGNMENT', high: false,
    re: /\b([A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)(["']?)([^\s"'`,;}&)]+)/gi,
    replace: (_m, key, sep, q, value) => (PLACEHOLDER_VALUE.test(value) || value.length < 4 || /^[\d.]+$/.test(value) ? null : `${key}${sep}${q}[REDACTED:ASSIGNMENT]`),
  },
]

export function redactPatterns(text: string, opts: { highOnly?: boolean } = {}): RedactResult {
  if (!text) return { text, count: 0 }
  let count = 0
  let out = text
  for (const rule of PATTERN_RULES) {
    if (opts.highOnly && !rule.high) continue
    rule.re.lastIndex = 0
    out = out.replace(rule.re, (m: string, ...rest: unknown[]) => {
      if (m.startsWith('[REDACTED')) return m
      if (rule.replace) {
        const groups = rest.slice(0, -2).map(g => (typeof g === 'string' ? g : ''))
        const r = rule.replace(m, ...groups)
        if (r === null) return m
        count++
        return r
      }
      count++
      return `[REDACTED:${rule.family}]`
    })
  }
  return { text: out, count }
}

/** Full redaction: known values, then every pattern family. For bot-facing reads. */
export function redactText(text: string, extra?: Map<string, string>): RedactResult {
  const a = redactKnownValues(text, extra)
  const b = redactPatterns(a.text)
  return { text: b.text, count: a.count + b.count }
}

/**
 * Persistence redaction: known values + HIGH-confidence shapes only. Used for
 * transcripts, summaries and activity rows, where the fuzzy heuristics
 * (`token=`, `Bearer x`) would mangle ordinary code/prose a human reads later.
 */
export function redactForStorage(text: string): RedactResult {
  const a = redactKnownValues(text)
  const b = redactPatterns(a.text, { highOnly: true })
  return { text: b.text, count: a.count + b.count }
}

/** `.env*` files: names stay visible, every value becomes `[REDACTED]`. */
export function redactEnvFile(text: string): RedactResult {
  let count = 0
  const lines = text.split('\n').map(line => {
    const m = /^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=)(.*)$/.exec(line)
    if (m) {
      if (m[2].trim() === '') return line
      count++
      return `${m[1]}[REDACTED]`
    }
    const r = redactText(line)
    count += r.count
    return r.text
  })
  return { text: lines.join('\n'), count }
}

/**
 * Worker prompts: known values only (precise — patterns would mangle sample
 * tokens in docs). When anything was replaced, tell the worker how to use the
 * credential without seeing it: the marker names its env var.
 */
export function redactPromptForWorker(prompt: string): string {
  const r = redactKnownValues(prompt)
  if (r.count === 0) return prompt
  return `${r.text}\n\n---\nNote: ${r.count} credential value(s) in this brief were replaced by \`[REDACTED:<NAME>]\`. ` +
    'Where NAME is set in your environment, use it by reference (e.g. "$NAME" in a shell command or `process.env.NAME`). ' +
    'Never print, echo, or paste a credential value into output, files, commits, or messages.\n'
}
