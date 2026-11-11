import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import Database from 'better-sqlite3'

// Regression guard for the 2026-06-28 outage (obj-2376 / PR #154): a migration
// that created `CREATE INDEX ... ON gate_false_pass(source)` BEFORE the migration
// that adds `source` crashed initDb() at boot — but ONLY on a pre-existing
// (production-shaped) DB. CI never saw it because the test suite always starts from
// a FRESH DB, where the table is created WITH the column.
//
// This test closes that gap: it builds a DB at the REAL current production schema
// (a checked-in schema-only snapshot of command-center.db) and runs initDb() over
// it — exactly what a deploy does on prod. Any future migration that is incompatible
// with the live table shapes fails the PR here instead of crash-looping prod.
//
// Regenerate the snapshot when the schema legitimately changes (a stale snapshot is
// SAFE — initDb just creates missing tables — it only reduces coverage):
//   docker exec -w /app/server command-center node -e "const D=require('better-sqlite3'); \
//     const db=new D('/app/data/command-center.db',{readonly:true}); const o={table:0,trigger:1,index:2}; \
//     const r=db.prepare(\"SELECT type,name,sql FROM sqlite_master WHERE type IN ('table','index','trigger') \
//     AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'\").all(); \
//     r.sort((a,b)=>(o[a.type]-o[b.type])||a.name.localeCompare(b.name)); \
//     process.stdout.write(r.map(x=>x.sql.trim()+';').join('\\n'))" > src/__fixtures__/prod-schema-snapshot.sql

const SNAPSHOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'prod-schema-snapshot.sql')
const TMP_DB = path.join(os.tmpdir(), `cc-prodschema-initdb-${process.pid}.db`)

afterAll(() => {
  try { getDbRef?.close() } catch { /* noop */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${s}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

let getDbRef: Database.Database | undefined

describe('initDb() against a prod-shaped DB (migration-ordering regression guard, obj-1955)', () => {
  it('runs cleanly over the real production schema snapshot', async () => {
    // 1. Build a DB at the CURRENT production schema shape.
    if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
    const snapshotSql = fs.readFileSync(SNAPSHOT, 'utf8')
    const seed = new Database(TMP_DB)
    seed.exec(snapshotSql)
    seed.close()

    // 2. Run initDb() against it — the exact operation a deploy performs on prod.
    // A "CREATE INDEX/constraint before its column-add migration" bug throws HERE.
    process.env.DB_PATH = TMP_DB
    const { initDb, getDb } = await import('../db/index.js')
    expect(() => initDb()).not.toThrow()

    // 3. Sanity: the DB is usable and core tables are present post-migration.
    getDbRef = getDb()
    const objectives = getDbRef.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='objectives'").get()
    expect(objectives).toBeTruthy()
  })
})
