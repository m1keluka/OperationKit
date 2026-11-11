import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { backupDatabase } from './db-backup.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-db-backup-'))
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }))

describe('db-backup (obj 720210)', () => {
  it('copies a live WAL database consistently and integrity-checks the copy', async () => {
    const src = path.join(TMP, 'live.db')
    const live = new Database(src)
    live.pragma('journal_mode = WAL')
    live.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const ins = live.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < 500; i++) ins.run(`row ${i}`)
    // The writer stays open (as the app does): rows still in the WAL must be in the copy.
    const dest = path.join(TMP, 'out', 'copy.db')
    const r = await backupDatabase(src, dest)
    expect(r).toMatchObject({ ok: true, integrity: 'ok' })
    expect(r.bytes).toBeGreaterThan(0)
    const copy = new Database(dest, { readonly: true })
    expect((copy.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(500)
    copy.close()
    live.close()
  })

  it('fails when the source does not exist', async () => {
    await expect(backupDatabase(path.join(TMP, 'missing.db'), path.join(TMP, 'x.db'))).rejects.toThrow()
  })
})
