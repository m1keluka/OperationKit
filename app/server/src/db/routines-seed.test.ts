import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs'
import Database from 'better-sqlite3'

// obj 712948 — the docs-breathe (living docs) prompt is code-owned: initDb rewrites
// routines.objective_template on every boot, so the "one open card per repo" rule
// has to live in db/index.ts. Also proves the additive objectives.dedupe_key column
// used by the trunk-failure watcher.
const TMP_DB = path.join(os.tmpdir(), `cc-routines-seed-${process.pid}-${Date.now()}.db`)
let mod: typeof import('./index.js')
let getDb: () => Database.Database

beforeAll(async () => {
  process.env.DB_PATH = TMP_DB
  mod = await import('./index.js')
  mod.initDb()
  getDb = mod.getDb
})

afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix) } catch { /* ignore */ }
  }
})

function breatheTemplate(): { description: string } {
  const row = getDb().prepare("SELECT objective_template FROM routines WHERE name = 'docs-breathe'").get() as { objective_template: string }
  return JSON.parse(row.objective_template)
}

describe('docs-breathe seed (obj 712948)', () => {
  it('carries the skip-or-append clause before any sibling card is filed', () => {
    const d = breatheTemplate().description
    expect(d).toContain('Before filing ANY sibling card')
    expect(d).toContain('do NOT message it (a message starts a worker)')
    expect(d).toContain('title exactly "Living docs — {name}" (no "stub" variants)')
    expect(d).toContain('one open card per repo, ever')
    expect(d).toContain('filed / appended / skipped-open(#id) / skipped-open-pr(#n) / skipped-no-change')
    // The old unconditional "spawn a sibling for every other repo" wording is gone.
    expect(d).not.toContain('spawn a sibling Board card')
  })

  it('gates the docs edit on an open breathe PR, before any PR is opened (obj 717142 / 718440)', () => {
    const d = breatheTemplate().description
    const check = d.indexOf('check for an OPEN, unmerged breathe/docs PR')
    expect(check).toBeGreaterThan(-1)
    expect(d).toContain('gh pr list --repo your-org/operationkit --state open')
    // Matched by branch + touched files, not by the (drifting) PR title.
    expect(d).toContain('headRefName contains "living-product-docs-breathe"')
    expect(d).toContain('files touch docs/product/')
    expect(d).toContain('do NOT open a new branch/PR')
    // The check precedes the step that edits docs and opens the PR.
    const edit = d.indexOf('Only if no breathe PR is open')
    expect(edit).toBeGreaterThan(check)
    expect(d).toContain('Open the PR (create_pr is on)')
    expect(d).not.toContain('Open/update the PR')
    // Sibling cards inherit the same rule on their own repo.
    expect(d).toContain('that card must run the same open-PR check on its own repo')
  })

  it('re-running init restores a stale template, stays idempotent, and never flips enabled', () => {
    const db = getDb()
    db.prepare("UPDATE routines SET objective_template = ?, enabled = 0 WHERE name = 'docs-breathe'")
      .run(JSON.stringify({ description: 'stale prompt' }))
    mod.initDb()
    mod.initDb()
    expect(breatheTemplate().description).toContain('Before filing ANY sibling card')
    const rows = db.prepare("SELECT enabled FROM routines WHERE name = 'docs-breathe'").all() as { enabled: number }[]
    expect(rows).toEqual([{ enabled: 0 }])
  })

  it('adds the nullable objectives.dedupe_key column + its index', () => {
    const cols = getDb().prepare('PRAGMA table_info(objectives)').all() as { name: string; notnull: number }[]
    const col = cols.find((c) => c.name === 'dedupe_key')
    expect(col).toBeDefined()
    expect(col!.notnull).toBe(0)
    const idx = getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_objectives_dedupe_key'").get()
    expect(idx).toBeDefined()
  })
})
