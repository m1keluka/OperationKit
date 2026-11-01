#!/usr/bin/env tsx
/**
 * db-backup — consistent copy of the live SQLite database (obj 720210).
 *
 *   tsx server/src/scripts/db-backup.ts <dest.db>
 *
 * Run by install/backup.sh inside the app container while the app is running.
 * Uses SQLite's online backup API (the same thing as `sqlite3 .backup`), so the
 * copy is consistent even mid-write, then opens the copy and runs
 * `PRAGMA integrity_check`. Prints one JSON line; exit 1 unless the copy is ok.
 */
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

export async function backupDatabase(src: string, dest: string): Promise<{ ok: boolean; bytes: number; integrity: string }> {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.rmSync(dest, { force: true })
  const live = new Database(src, { readonly: true, fileMustExist: true })
  try {
    await live.backup(dest)
  } finally {
    live.close()
  }
  const copy = new Database(dest, { readonly: true, fileMustExist: true })
  let integrity: string
  try {
    const rows = copy.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
    integrity = rows.map(r => r.integrity_check).join('; ')
  } finally {
    copy.close()
  }
  return { ok: integrity === 'ok', bytes: fs.statSync(dest).size, integrity }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)
if (isMain) {
  const dest = process.argv[2]
  const src = process.env.DB_PATH || '/app/data/command-center.db'
  if (!dest) {
    console.error('usage: db-backup.ts <dest.db>')
    process.exit(2)
  }
  try {
    const r = await backupDatabase(src, dest)
    console.log(JSON.stringify(r))
    process.exit(r.ok ? 0 : 1)
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: (err as Error).message }))
    process.exit(1)
  }
}
