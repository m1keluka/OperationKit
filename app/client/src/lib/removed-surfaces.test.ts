/**
 * obj 900543 — the six unfinished surfaces (Notes/loops, Feed, Strategies,
 * Development, Status, Contacts) are removed, not parked. This guard fails if
 * a page component, route element, ⌘K entry or in-app link to one comes back.
 * Old URLs are handled only by REMOVED_ROUTES (redirect to the board).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const SRC = join(__dirname, '..')

const DELETED_FILES = [
  'components/LoopsPage.tsx', 'components/loops',
  'components/ProjectFeed.tsx',
  'components/StrategiesPage.tsx', 'components/StrategyDetailPage.tsx',
  'components/DevelopmentPage.tsx', 'components/development',
  'lib/devItems.ts', 'lib/devItemsFixture.ts',
  'components/StatusPage.tsx',
  'components/ContactsPage.tsx',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('removed surfaces stay removed (obj 900543)', () => {
  it.each(DELETED_FILES)('%s is gone', (f) => {
    expect(existsSync(join(SRC, f))).toBe(false)
  })

  it('no source file links or navigates to a removed URL', () => {
    // A path literal for a removed page: '/loops', `/strategy/${id}`, "/development", …
    // API calls (`/api/...`, api.get('/x')) are a different namespace and not matched,
    // because the client api helper prefixes /api itself — so we only scan for
    // navigation sinks: href=, navigate(, to=, pushState.
    const sink = /(href=|navigate\(|\bto=|pushState\([^)]*?,)\s*\{?\s*[`'"]\/(loops|feed|strategies|strategy|development|feedback|status|contacts)\b/
    const hits = walk(SRC)
      .filter(f => !f.endsWith('lib/routes.ts'))
      .flatMap(f => readFileSync(f, 'utf8').split('\n')
        .map((line, i) => (sink.test(line) ? `${relative(SRC, f)}:${i + 1}: ${line.trim()}` : null))
        .filter((x): x is string => x !== null))
    expect(hits).toEqual([])
  })

  it('the ⌘K palette has no parked-surface entries', () => {
    const layout = readFileSync(join(SRC, 'components/Layout.tsx'), 'utf8')
    expect(layout).not.toMatch(/PALETTE_ONLY/)
    for (const label of ['Contacts', 'Strategies', 'Development', 'Notes', 'Feed']) {
      expect(layout).not.toMatch(new RegExp(`label:\\s*'${label}'`))
    }
  })
})
