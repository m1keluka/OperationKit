import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
// objective-audit.ts imports ONLY `import type` from better-sqlite3 — it never
// touches db/index — so a static import here can NEVER open the live DB. All
// state lives in an explicit in-memory database created below.
import {
  logObjectiveAudit,
  checkHumanTerminalReactivation,
  isClearDeadSessionEnabled,
  isHumanTerminalGuardEnabled,
  isSoftDeleteEnabled,
} from './objective-audit.js'

function freshDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE objective_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER, event_type TEXT, from_status TEXT, to_status TEXT,
      actor TEXT, pathway TEXT, session_id TEXT, title_snapshot TEXT, workspace TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
  `)
  return db
}

const rowsFor = (db: Database.Database, id: number) =>
  db.prepare('SELECT * FROM objective_audit WHERE objective_id = ? ORDER BY id').all(id) as Record<string, unknown>[]

describe('logObjectiveAudit', () => {
  it('appends exactly one row with the given fields', () => {
    const db = freshDb()
    logObjectiveAudit(db, {
      objectiveId: 42, eventType: 'status_change', fromStatus: 'review', toStatus: 'done',
      actor: 'user', pathway: 'public-patch-status', sessionId: 'cc-42-1', titleSnapshot: 'T', workspace: 'example',
    })
    const rows = rowsFor(db, 42)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      event_type: 'status_change', from_status: 'review', to_status: 'done',
      actor: 'user', pathway: 'public-patch-status', workspace: 'example',
    })
  })

  it('is best-effort: a missing table never throws', () => {
    const db = new Database(':memory:')
    expect(() => logObjectiveAudit(db, { objectiveId: 1, eventType: 'create', pathway: 'x' })).not.toThrow()
  })
})

describe('flag defaults', () => {
  it('CC_POLL_CLEAR_DEAD_SESSION defaults ON; only an explicit falsey value disables it', () => {
    expect(isClearDeadSessionEnabled({} as NodeJS.ProcessEnv)).toBe(true)
    expect(isClearDeadSessionEnabled({ CC_POLL_CLEAR_DEAD_SESSION: '0' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isClearDeadSessionEnabled({ CC_POLL_CLEAR_DEAD_SESSION: 'off' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isClearDeadSessionEnabled({ CC_POLL_CLEAR_DEAD_SESSION: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })

  it('CC_HUMAN_TERMINAL_GUARD defaults OFF (env + settings)', () => {
    const db = freshDb()
    expect(isHumanTerminalGuardEnabled(db, {} as NodeJS.ProcessEnv)).toBe(false)
    expect(isHumanTerminalGuardEnabled(db, { CC_HUMAN_TERMINAL_GUARD: '1' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    db.prepare("INSERT INTO settings (key, value) VALUES ('human_terminal_guard_enabled', '1')").run()
    expect(isHumanTerminalGuardEnabled(db, {} as NodeJS.ProcessEnv)).toBe(true)
  })

  it('soft_delete_enabled defaults OFF (settings-driven)', () => {
    const db = freshDb()
    expect(isSoftDeleteEnabled(db, {} as NodeJS.ProcessEnv)).toBe(false)
    db.prepare("INSERT INTO settings (key, value) VALUES ('soft_delete_enabled', '1')").run()
    expect(isSoftDeleteEnabled(db, {} as NodeJS.ProcessEnv)).toBe(true)
  })
})

describe('checkHumanTerminalReactivation (FIX B guard)', () => {
  const parkedTerminal = { id: 7, status: 'review', terminal_by_human: 1, session_id: null, title: 'T', workspace: 'example' }

  it('DRY-RUN (flag OFF, default): logs a reactivate audit row but does NOT block', () => {
    const db = freshDb()
    const r = checkHumanTerminalReactivation(db, parkedTerminal, 'internal-patch-start', {}, {} as NodeJS.ProcessEnv)
    expect(r.blocked).toBe(false)
    const rows = rowsFor(db, 7)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event_type: 'reactivate', from_status: 'review', to_status: 'working', pathway: 'internal-patch-start' })
  })

  it('ENFORCED (flag ON): blocks AND logs a reactivate audit row', () => {
    const db = freshDb()
    const env = { CC_HUMAN_TERMINAL_GUARD: '1' } as unknown as NodeJS.ProcessEnv
    const r = checkHumanTerminalReactivation(db, parkedTerminal, 'internal-patch-start', {}, env)
    expect(r.blocked).toBe(true)
    expect(rowsFor(db, 7)).toHaveLength(1)
  })

  it('PRESERVED: an already-working objective (account-limit auto-resume) is never guarded — both flag states, no audit', () => {
    const working = { id: 8, status: 'working', terminal_by_human: 1, session_id: 'cc-8-1', title: 'W', workspace: 'example' }
    for (const env of [{}, { CC_HUMAN_TERMINAL_GUARD: '1' }] as unknown as NodeJS.ProcessEnv[]) {
      const db = freshDb()
      const r = checkHumanTerminalReactivation(db, working, 'account-limit-resume', {}, env)
      expect(r.blocked).toBe(false)
      expect(rowsFor(db, 8)).toHaveLength(0) // not a parked→working reactivation → nothing audited
    }
  })

  it('PRESERVED: an explicit human reopen (reopen:true) is never blocked — both flag states, no audit', () => {
    for (const env of [{}, { CC_HUMAN_TERMINAL_GUARD: '1' }] as unknown as NodeJS.ProcessEnv[]) {
      const db = freshDb()
      const r = checkHumanTerminalReactivation(db, parkedTerminal, 'public-reopen', { explicitHumanReopen: true }, env)
      expect(r.blocked).toBe(false)
      expect(rowsFor(db, 7)).toHaveLength(0)
    }
  })

  it('a non-terminal parked objective is not guarded and not audited', () => {
    const db = freshDb()
    const notTerminal = { id: 9, status: 'review', terminal_by_human: 0, session_id: null, title: 'N', workspace: 'example' }
    const r = checkHumanTerminalReactivation(db, notTerminal, 'internal-patch-start', {}, { CC_HUMAN_TERMINAL_GUARD: '1' } as unknown as NodeJS.ProcessEnv)
    expect(r.blocked).toBe(false)
    expect(rowsFor(db, 9)).toHaveLength(0)
  })
})
