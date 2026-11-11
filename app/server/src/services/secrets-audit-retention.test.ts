/**
 * D5 (obj 900540) — 1-year audit retention: export, verify, then prune inside
 * one transaction that restores the append-only guard. Fake names only.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { clearSecretAuditLogForTests } from '../__fixtures__/secret-audit-log.js'

process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 19).toString('base64')
process.env.DB_PATH = path.join(os.tmpdir(), `cc-d5-retention-${process.pid}-${Date.now()}.db`)

const { initDb, getDb } = await import('../db/index.js')
const { runAuditRetention, AUDIT_RETENTION_MIN_DAYS, sqliteTimestamp } = await import('./secrets-audit-retention.js')

const NOW = new Date('2026-11-11T12:00:00Z')
const daysAgo = (n: number) => sqliteTimestamp(new Date(NOW.getTime() - n * 86_400_000))
let exportDir: string

function insert(at: string, key: string): void {
  getDb()
    .prepare(`INSERT INTO secret_access_log (actor_user_id, action, scope, key, at, source) VALUES (1, 'inject', 'global', ?, ?, 'spawn')`)
    .run(key, at)
}
const keys = () => (getDb().prepare('SELECT key FROM secret_access_log ORDER BY id').all() as { key: string }[]).map(r => r.key)
const triggers = () =>
  (getDb().prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='secret_access_log' ORDER BY name`).all() as { name: string }[]).map(r => r.name)

beforeAll(() => initDb())
beforeEach(() => {
  clearSecretAuditLogForTests(getDb())
  exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-d5-export-'))
  insert(daysAgo(800), 'FAKE_OLD_A')
  insert(daysAgo(400), 'FAKE_OLD_B')
  insert(daysAgo(364), 'FAKE_RECENT_C')
  insert(daysAgo(1), 'FAKE_RECENT_D')
})

describe('runAuditRetention', () => {
  it('refuses a window shorter than one year', () => {
    expect(AUDIT_RETENTION_MIN_DAYS).toBe(365)
    expect(() => runAuditRetention({ days: 90, now: NOW, exportDir })).toThrow(/at least 365/)
  })

  it('dry run (default) reports and changes nothing', () => {
    const r = runAuditRetention({ now: NOW, exportDir })
    expect(r).toMatchObject({ applied: false, rows: 2, file: null })
    expect(keys()).toEqual(['FAKE_OLD_A', 'FAKE_OLD_B', 'FAKE_RECENT_C', 'FAKE_RECENT_D'])
    expect(fs.readdirSync(exportDir)).toEqual([])
  })

  it('--apply exports the old rows (600, sha256 sidecar), prunes exactly those, restores the guard and audits itself', () => {
    const r = runAuditRetention({ now: NOW, exportDir, apply: true })
    expect(r.applied).toBe(true)
    expect(r.rows).toBe(2)

    const body = fs.readFileSync(r.file!, 'utf8')
    const rows = body.trim().split('\n').map(l => JSON.parse(l))
    expect(rows.map(x => x.key)).toEqual(['FAKE_OLD_A', 'FAKE_OLD_B'])
    expect(fs.statSync(r.file!).mode & 0o777).toBe(0o600)
    const sidecar = fs.readFileSync(`${r.file}.sha256`, 'utf8')
    expect(sidecar.split(' ')[0]).toBe(crypto.createHash('sha256').update(body).digest('hex'))
    expect(r.sha256).toBe(sidecar.split(' ')[0])

    expect(keys()).toEqual(['FAKE_RECENT_C', 'FAKE_RECENT_D', '*'])
    const prune = getDb().prepare(`SELECT * FROM secret_access_log WHERE action = 'audit_prune'`).get() as { source: string; detail: string }
    expect(prune.source).toBe('retention')
    expect(prune.detail).toContain('rows=2;')
    expect(prune.detail).toContain(path.basename(r.file!))

    // Both guards are back: the table is append-only again.
    expect(triggers()).toEqual(['trg_secret_access_log_no_delete', 'trg_secret_access_log_no_update'])
    expect(() => getDb().exec('DELETE FROM secret_access_log')).toThrow(/append-only/)
    expect(() => getDb().exec(`UPDATE secret_access_log SET key = 'x'`)).toThrow(/append-only/)
  })

  it('a failed export deletes nothing and leaves the guard in place', () => {
    const stamp = NOW.toISOString().replace(/[:.]/g, '-')
    const clash = path.join(exportDir, `secret-audit-before-${daysAgo(365).slice(0, 10)}-${stamp}.jsonl`)
    fs.writeFileSync(clash, 'already here')
    expect(() => runAuditRetention({ now: NOW, exportDir, apply: true })).toThrow()
    expect(keys()).toHaveLength(4)
    expect(triggers()).toContain('trg_secret_access_log_no_delete')
  })

  it('nothing old = nothing written', () => {
    const r = runAuditRetention({ now: new Date('2020-01-01T00:00:00Z'), exportDir, apply: true })
    expect(r).toMatchObject({ applied: false, rows: 0 })
    expect(fs.readdirSync(exportDir)).toEqual([])
  })
})
