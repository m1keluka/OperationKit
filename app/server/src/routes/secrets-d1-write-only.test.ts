/**
 * D1 (obj 900540) — "never, write-only". There is no reveal path, no revealable
 * class and no flag that could add one. These checks pin that:
 *   1. No code (server, shared, Secrets UI) holds a reveal string other than the
 *      audited tripwire's own names. A new `secrets_reveal_enabled` setting, a
 *      `REVEAL_ENABLED` env read or a "Reveal" button would trip this.
 *   2. The secrets table has no column that could mark a secret revealable.
 * The route-level proof (POST /reveal is refused even with such flags set) is in
 * secrets-hardening.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.resolve(HERE, '../../..')

/** The only reveal-ish string literals allowed: the tripwire route, its audit action and error code. */
const ALLOWED = new Set(['reveal_attempt', 'reveal_disabled', '/reveal', 'Reveal attempt (refused)'])

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
  }
  return out
}

describe('D1 write-only: no reveal path in code', () => {
  it('no string literal outside comments names a reveal flag, route or control except the audited tripwire', () => {
    const roots = [
      path.join(APP, 'server/src'),
      path.join(APP, 'shared'),
      path.join(APP, 'client/src/components/secrets'),
      path.join(APP, 'client/src/components/SecretsPage.tsx'),
    ]
    const files = roots.flatMap(r => (fs.statSync(r).isDirectory() ? walk(r) : [r]))
    expect(files.length).toBeGreaterThan(50)
    const offenders: string[] = []
    for (const f of files) {
      const lines = fs.readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const t = line.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
        for (const m of line.matchAll(/(['"`])([^'"`\n]*reveal[^'"`\n]*)\1/gi)) {
          if (!ALLOWED.has(m[2]!)) offenders.push(`${path.relative(APP, f)}:${i + 1} ${m[2]}`)
        }
        if (/process\.env\.[A-Z_]*REVEAL/i.test(line)) offenders.push(`${path.relative(APP, f)}:${i + 1} env flag`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('the secrets schema has no revealable/reveal column', async () => {
    process.env.DB_PATH = path.join(os.tmpdir(), `cc-d1-${process.pid}-${Date.now()}.db`)
    process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 5).toString('base64')
    const { initDb, getDb } = await import('../db/index.js')
    initDb()
    for (const table of ['secrets', 'secret_versions']) {
      const cols = (getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name)
      expect(cols.some(c => /reveal/i.test(c))).toBe(false)
    }
  })
})
