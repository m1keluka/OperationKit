/**
 * Static guard for schema §5 mitigation 1.
 *
 * CC is not multi-tenant Postgres, so the row-level tenancy that Supabase RLS
 * gave both source platforms is now an APPLICATION concern: every dev_items
 * read must carry a workspace predicate and `deleted_at IS NULL`. The design
 * doc's stated mitigation is "all dev_items reads go through a single
 * scopedDevItems() helper; a lint rule / test asserts no route builds a raw
 * SELECT ... FROM dev_items without it".
 *
 * This is that test. It is deliberately a grep over source text rather than a
 * runtime assertion: the failure it prevents is a FUTURE route author writing
 * their own query, which no runtime test of today's routes can catch.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROUTES_DIR = path.join(SRC, 'routes')

/** Strip line and block comments so prose mentioning the table never trips us. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function routeFiles(): string[] {
  return fs
    .readdirSync(ROUTES_DIR)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map(f => path.join(ROUTES_DIR, f))
}

/**
 * Split a source file into its string/template literals, so we inspect SQL
 * rather than surrounding TypeScript.
 */
function sqlLiterals(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/g)) {
    const body = m[1] ?? m[2] ?? m[3] ?? ''
    // The negative lookahead keeps `dev_items` from matching the satellite
    // tables `dev_item_notes` / `dev_item_prs` / `dev_item_attachments`, which
    // are workspace-scoped transitively through their dev_item_id FK.
    if (/\bdev_items\b(?!_)/i.test(body)) out.push(body)
  }
  return out
}

/**
 * A route-level statement is acceptable ONLY if it is pinned to a single,
 * explicitly-identified item — `WHERE id = ?` for a direct read/write, or a
 * join keyed on an already-scoped `dev_item_id`. Anything else is a LIST read,
 * which is precisely the shape that can silently omit the workspace predicate
 * and serve one platform's board to another.
 */
function isSingleItemPinned(sql: string): boolean {
  return /\bid\s*=\s*\?/i.test(sql) || /\bdi\.id\s*=\s*\w+\.dev_item_id\b/i.test(sql)
}

describe('dev_items scoping discipline (schema §5 mitigation 1)', () => {
  it('routes never build an unscoped LIST read of dev_items', () => {
    const offenders: string[] = []
    for (const file of routeFiles()) {
      const code = stripComments(fs.readFileSync(file, 'utf8'))
      for (const sql of sqlLiterals(code)) {
        if (!isSingleItemPinned(sql)) {
          offenders.push(`${path.basename(file)}: ${sql.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
        }
      }
    }
    expect(
      offenders,
      `These route files run a multi-row dev_items query instead of going ` +
        `through services/dev-items.ts (scopedDevItems/getDevItem/...). ` +
        `Route-local list SQL is how a workspace predicate gets forgotten and ` +
        `one platform's board leaks into another's. Narrow by-id reads and ` +
        `back-stamps are allowed; listings are not.`,
    ).toEqual([])
  })

  it('the service layer is the only place that names the dev_items table', () => {
    // Sanity check on the guard itself: if this ever finds nothing, the regex
    // above has silently stopped matching and the first test became vacuous.
    // Join-scan the facade and its extracted modules (schema/query/mutate).
    const dir = path.join(SRC, 'services')
    const files = fs
      .readdirSync(dir)
      .filter(f => /^dev-items.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
    const found = files.some(f =>
      /\bFROM dev_items\b/i.test(stripComments(fs.readFileSync(path.join(dir, f), 'utf8'))),
    )
    expect(found).toBe(true)
  })
})
