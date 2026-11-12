import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { initFlowSchema, enableFlowsOnce, FLOWS_ENABLED_DEFAULT_ON_MARKER } from './flow.js'
import { flowsEnabled } from '../../services/flow-engine.js'

// obj 900675 — the Workflows kill switch goes ON once per install and a later
// manual turn-off is never overridden.
function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  initFlowSchema(db)
  return db
}
const get = (db: Database.Database, k: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value

describe('enableFlowsOnce', () => {
  it('initFlowSchema alone keeps the fail-closed default off', () => {
    expect(flowsEnabled(freshDb())).toBe(false)
  })

  it('flips flows_enabled on and records the marker', () => {
    const db = freshDb()
    expect(enableFlowsOnce(db)).toBe(true)
    expect(get(db, 'flows_enabled')).toBe('1')
    expect(get(db, FLOWS_ENABLED_DEFAULT_ON_MARKER)).toBe('1')
    expect(flowsEnabled(db)).toBe(true)
  })

  it('never overrides an operator who switched it back off', () => {
    const db = freshDb()
    enableFlowsOnce(db)
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'flows_enabled'").run()
    initFlowSchema(db) // next boot
    expect(enableFlowsOnce(db)).toBe(false)
    expect(flowsEnabled(db)).toBe(false)
  })

  it('is a no-op without a settings table', () => {
    expect(enableFlowsOnce(new Database(':memory:'))).toBe(false)
  })
})
