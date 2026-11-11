/**
 * Secrets audit-log retention — Sprint 6b, decision D5 (obj 900540).
 *
 * Operator's decision (2026-11-10): "1 year then export". `secret_access_log` keeps
 * one year in the database. Older rows are EXPORTED to a JSONL file (with a
 * sha256 sidecar) and only then pruned, by this one deliberate, audited job.
 *
 * How it respects the append-only design (db/schema/secrets.ts triggers):
 *   1. Select rows older than the window (`at < cutoff`), oldest first.
 *   2. Write them to `<exportDir>/secret-audit-<cutoff>-<stamp>.jsonl` (mode
 *      600, created exclusively, fsync'd) plus `<file>.sha256`.
 *   3. Re-read the file and check the row count and hash. Any mismatch stops
 *      here with nothing deleted.
 *   4. In ONE transaction: drop the DELETE guard trigger, delete exactly the
 *      exported id range, re-create the trigger, and append an `audit_prune`
 *      row (source `retention`) naming the count, cutoff, file and hash. If the
 *      delete count differs from the export, the transaction rolls back — the
 *      trigger is back and nothing is lost. The UPDATE guard is never touched.
 *
 * The window cannot be shorter than 365 days. Dry run is the default.
 * Rows hold names, scopes, actors and actions — never a value — so the export
 * holds none either.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { SECRET_AUDIT_NO_DELETE_TRIGGER_SQL } from '../db/schema/secrets.js'

export const AUDIT_RETENTION_MIN_DAYS = 365
export const DEFAULT_AUDIT_EXPORT_DIR = '/app/data/audit-exports'

export function auditExportDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SECRETS_AUDIT_EXPORT_DIR?.trim() || DEFAULT_AUDIT_EXPORT_DIR
}

/** SQLite `datetime('now')` format: 'YYYY-MM-DD HH:MM:SS' (UTC). */
export function sqliteTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export interface RetentionOptions {
  days?: number
  exportDir?: string
  apply?: boolean
  now?: Date
  actorUserId?: number | null
  db?: Database.Database
}

export interface RetentionResult {
  applied: boolean
  cutoff: string
  rows: number
  minId: number | null
  maxId: number | null
  file: string | null
  sha256: string | null
}

interface AuditRow {
  id: number
  actor_user_id: number | null
  action: string
  scope: string
  key: string
  at: string
  secret_id: number | null
  source: string | null
  detail: string | null
}

export function runAuditRetention(opts: RetentionOptions = {}): RetentionResult {
  const days = Math.floor(opts.days ?? AUDIT_RETENTION_MIN_DAYS)
  if (!Number.isFinite(days) || days < AUDIT_RETENTION_MIN_DAYS) {
    throw new Error(`retention window must be at least ${AUDIT_RETENTION_MIN_DAYS} days (D5); got ${opts.days}`)
  }
  const db = opts.db ?? getDb()
  const now = opts.now ?? new Date()
  const cutoff = sqliteTimestamp(new Date(now.getTime() - days * 86_400_000))
  const rows = db
    .prepare(
      `SELECT id, actor_user_id, action, scope, key, at, secret_id, source, detail
         FROM secret_access_log WHERE at < ? ORDER BY id`,
    )
    .all(cutoff) as AuditRow[]
  const base: RetentionResult = {
    applied: false,
    cutoff,
    rows: rows.length,
    minId: rows[0]?.id ?? null,
    maxId: rows[rows.length - 1]?.id ?? null,
    file: null,
    sha256: null,
  }
  if (!opts.apply || rows.length === 0) return base

  // ── Export ────────────────────────────────────────────────────────────────
  const dir = opts.exportDir ?? auditExportDir()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const file = path.join(dir, `secret-audit-before-${cutoff.slice(0, 10)}-${stamp}.jsonl`)
  const body = rows.map(r => JSON.stringify(r)).join('\n') + '\n'
  const fd = fs.openSync(file, 'wx', 0o600)
  try {
    fs.writeSync(fd, body)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  const sha256 = crypto.createHash('sha256').update(body).digest('hex')
  fs.writeFileSync(`${file}.sha256`, `${sha256}  ${path.basename(file)}\n`, { mode: 0o600 })

  // ── Verify before deleting anything ──────────────────────────────────────
  const reread = fs.readFileSync(file, 'utf8')
  const rereadHash = crypto.createHash('sha256').update(reread).digest('hex')
  const lines = reread.split('\n').filter(Boolean)
  if (rereadHash !== sha256 || lines.length !== rows.length) {
    throw new Error(`export verification failed for ${file}; nothing was deleted`)
  }

  // ── Prune, atomically, with the guard restored before commit ─────────────
  const minId = rows[0]!.id
  const maxId = rows[rows.length - 1]!.id
  const detail = `rows=${rows.length};before=${cutoff};sha256=${sha256.slice(0, 16)};file=${path.basename(file)}`.slice(0, 200)
  const tx = db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS trg_secret_access_log_no_delete')
    const r = db
      .prepare('DELETE FROM secret_access_log WHERE id BETWEEN ? AND ? AND at < ?')
      .run(minId, maxId, cutoff)
    if (r.changes !== rows.length) {
      throw new Error(`prune deleted ${r.changes} rows but ${rows.length} were exported; rolled back`)
    }
    db.exec(SECRET_AUDIT_NO_DELETE_TRIGGER_SQL)
    db.prepare(
      `INSERT INTO secret_access_log (actor_user_id, action, scope, key, source, detail)
       VALUES (?, 'audit_prune', 'global', '*', 'retention', ?)`,
    ).run(opts.actorUserId ?? null, detail)
  })
  tx()
  return { ...base, applied: true, file, sha256 }
}
