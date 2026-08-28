// Regression for bug #836: auto-created adversarial review cards (and other
// INSERTs that omit `model`) were minted on the disabled 'claude-fable-5'
// model because the legacy prod DB's objectives.model column DEFAULT was never
// repointed off the dead model. Disabled models never spawn, so those cards
// stranded in `queue` and parked their parent delegator forever.
//
// These tests cover the durable safety net: the boot-time "disabled-model
// rescue" pass in initDb().
//
// Attribution guard (audit 2026-07-04): NON-terminal objectives are no longer
// silently repointed — silently rebasing in-flight Fable work onto Opus is the
// exact attribution hole we're closing. Instead the pass raises a HIGH-severity
// alert and leaves the model untouched. Terminal `done` rows are still left
// untouched to preserve their historical model attribution.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-review-model-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch {/* ignore */}
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

describe('disabled-model rescue migration (bug #836)', () => {
  it('seeds claude-fable-5 as a DISABLED model in the registry', () => {
    const row = getDb()
      .prepare('SELECT enabled FROM models WHERE id = ?')
      .get('claude-fable-5') as { enabled: number } | undefined
    expect(row).toBeDefined()
    expect(row!.enabled).toBe(0)
  })

  it('does NOT silently repoint an in-flight objective on a disabled model — raises a high-severity alert instead (audit 2026-07-04)', async () => {
    const db = getDb()
    const def = (db.prepare('SELECT id FROM models WHERE is_default = 1').get() as { id: string }).id
    expect(def).not.toBe('claude-fable-5')

    // Simulate an in-flight (non-terminal) objective on a now-disabled model.
    const r = db.prepare(
      `INSERT INTO objectives (title, agent_context, status, model)
       VALUES ('in-flight on fable', 'cto', 'queue', 'claude-fable-5')`
    ).run()
    const id = r.lastInsertRowid as number

    // Re-run initDb (idempotent) — the guarded rescue pass should fire.
    initDb()

    // The model is LEFT UNTOUCHED (not silently rebased onto Opus) so attribution
    // stays honest; an operator decides via the alert.
    const after = db.prepare('SELECT model FROM objectives WHERE id = ?').get(id) as { model: string }
    expect(after.model).toBe('claude-fable-5')

    // A high-severity alert is raised via the notifier (fire-and-forget dynamic
    // import); flush timers so it lands before we assert.
    await new Promise(res => setTimeout(res, 50))
    const alert = db.prepare(
      "SELECT severity FROM alerts WHERE source = 'disabled-model-rescue' ORDER BY id DESC LIMIT 1"
    ).get() as { severity: string } | undefined
    expect(alert).toBeDefined()
    expect(alert!.severity).toBe('high')
  })

  it('leaves a terminal (done) objective on a disabled model untouched (history preserved)', () => {
    const db = getDb()
    const r = db.prepare(
      `INSERT INTO objectives (title, agent_context, status, model)
       VALUES ('finished on fable', 'cto', 'done', 'claude-fable-5')`
    ).run()
    const id = r.lastInsertRowid as number

    initDb()

    const after = db.prepare('SELECT model FROM objectives WHERE id = ?').get(id) as { model: string }
    expect(after.model).toBe('claude-fable-5')
  })
})
