/**
 * Secret scrubbing at the persistence boundary (obj 715532).
 *
 * Session summaries, card descriptions, activity rows and session events are
 * written from dozens of call sites (22 `INSERT INTO activity_log` alone), so
 * scrubbing each site would be both incomplete and rot the moment someone adds
 * a 23rd. Instead `installWriteScrubber` wraps `db.prepare`: any INSERT /
 * UPDATE / REPLACE that targets a SCRUBBED table gets every string parameter
 * passed through the redactor before better-sqlite3 binds it. Reads, and writes
 * to every other table, are returned untouched.
 *
 * This is how a worker that echoes a known Supabase key into its summary ends up
 * stored as `[REDACTED:SUPABASE_SERVICE_ROLE]` (the #712937 thread leak).
 */
import type Database from 'better-sqlite3'

export const SCRUBBED_TABLES = [
  'activity_log',
  'objectives',
  'session_events',
  'session_intel',
  'objective_reviews',
  'objective_audit',
  'alerts',
  // Built-in agent chat (obj 719987): a person may paste a key into a chat.
  'agent_chat_messages',
  'agent_chat_drafts',
] as const

const WRITE_SQL_RE = new RegExp(
  String.raw`^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?)\s+["\x60\[]?(${SCRUBBED_TABLES.join('|')})["\x60\]]?[\s(]`,
  'i',
)

export function isScrubbedWrite(sql: string): boolean {
  return WRITE_SQL_RE.test(sql)
}

type Scrub = (s: string) => string

function scrubValue(v: unknown, scrub: Scrub): unknown {
  if (typeof v === 'string') return scrub(v)
  if (Array.isArray(v)) return v.map(x => scrubValue(x, scrub))
  // Named-parameter objects: `stmt.run({ summary })`. Buffers/BigInts/null pass through.
  if (v && typeof v === 'object' && !Buffer.isBuffer(v) && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = typeof x === 'string' ? scrub(x) : x
    return out
  }
  return v
}

const BINDING_METHODS = new Set(['run', 'get', 'all', 'iterate', 'bind'])
const CHAINING_METHODS = new Set(['pluck', 'expand', 'raw', 'columns', 'safeIntegers', 'bind'])

function wrapStatement(stmt: Database.Statement, scrub: Scrub): Database.Statement {
  const proxy: Database.Statement = new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      const name = String(prop)
      return (...args: unknown[]) => {
        const callArgs = BINDING_METHODS.has(name) ? args.map(a => scrubValue(a, scrub)) : args
        const result = (value as (...a: unknown[]) => unknown).apply(target, callArgs)
        // Keep chained calls (`stmt.pluck().get(...)`) on the scrubbing proxy.
        return CHAINING_METHODS.has(name) && result === target ? proxy : result
      }
    },
  })
  return proxy
}

const INSTALLED = Symbol.for('cc.writeScrubberInstalled')

/** Idempotent: wraps `db.prepare` once. `scrub` must be pure and never throw. */
export function installWriteScrubber(db: Database.Database, scrub: Scrub): void {
  const anyDb = db as unknown as Record<symbol, boolean>
  if (anyDb[INSTALLED]) return
  anyDb[INSTALLED] = true
  const original = db.prepare.bind(db)
  const safeScrub: Scrub = s => {
    try { return scrub(s) } catch { return s }
  }
  ;(db as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
    const stmt = original(sql)
    return isScrubbedWrite(sql) ? wrapStatement(stmt, safeScrub) : stmt
  }) as typeof db.prepare
}
