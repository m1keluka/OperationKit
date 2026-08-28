#!/usr/bin/env tsx
// Phase 1 Personal CRM — backfill the contacts_index from vault, then seed
// last_interaction from the last 90 days of granola_processed_meetings and
// the Gmail live label.
//
// Usage:
//   tsx contacts-backfill.ts              # apply
//   tsx contacts-backfill.ts --dry-run    # report what would change
//   tsx contacts-backfill.ts --since=180  # widen lookback window
//
// Idempotent. Safe to re-run. Reads VAULT_PATH and DB_PATH from env, matching
// granola-ingest.ts conventions.

import Database from 'better-sqlite3'
import {
  rebuildContactsIndex,
  seedLastInteractionFromMeetings,
  seedLastInteractionFromGmail,
} from '../services/contacts.js'

const DB_PATH = process.env.DB_PATH || '/app/data/command-center.db'
const VAULT_BASE = process.env.VAULT_PATH || '/home/operator/second-brain'

interface Args {
  dryRun: boolean
  sinceDays: number
}

function parseArgs(argv: string[]): Args {
  let dryRun = false
  let sinceDays = 90
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run' || arg === '-n') dryRun = true
    else if (arg.startsWith('--since=')) {
      const n = parseInt(arg.slice('--since='.length), 10)
      if (Number.isFinite(n) && n > 0) sinceDays = n
    }
  }
  return { dryRun, sinceDays }
}

function ensureSchema(db: Database.Database): void {
  // Same shape as db/index.ts initDb(). Re-applied here so the script works
  // even when the server hasn't booted against the DB file yet (e.g. running
  // from cron / a fresh container).
  db.exec(`
    CREATE TABLE IF NOT EXISTS granola_processed_meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      meeting_date TEXT,
      workspace TEXT,
      vault_path TEXT,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS granola_action_items (
      id TEXT PRIMARY KEY,
      meeting_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending-review',
      title TEXT,
      description TEXT,
      workspace TEXT,
      priority INTEGER NOT NULL DEFAULT 2,
      owner TEXT,
      deadline TEXT,
      source_excerpt TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      reviewed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS gmail_triage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT UNIQUE,
      thread_id TEXT,
      from_address TEXT,
      subject TEXT,
      snippet TEXT,
      label TEXT,
      classified_at TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS contacts_index (
      vault_path        TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      email             TEXT,
      phone             TEXT,
      company           TEXT,
      role              TEXT,
      tags              TEXT NOT NULL DEFAULT '[]',
      follow_up_days    INTEGER,
      last_interaction  TEXT,
      next_touchpoint   TEXT,
      confidence        TEXT NOT NULL DEFAULT 'high',
      workspace         TEXT,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  // Add related_contacts column on granola_action_items if missing.
  const cols = db.prepare('PRAGMA table_info(granola_action_items)').all() as { name: string }[]
  if (!cols.some(c => c.name === 'related_contacts')) {
    db.exec("ALTER TABLE granola_action_items ADD COLUMN related_contacts TEXT NOT NULL DEFAULT '[]'")
  }
}

function fmt(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(24)} ${JSON.stringify(value)}`)
}

async function main(): Promise<void> {
  const { dryRun, sinceDays } = parseArgs(process.argv)
  const ts = new Date().toISOString()

  console.log(`[${ts}] contacts-backfill ${dryRun ? '(DRY RUN)' : ''}`)
  console.log(`  DB:        ${DB_PATH}`)
  console.log(`  Vault:     ${VAULT_BASE}`)
  console.log(`  Lookback:  ${sinceDays} days`)
  console.log('')

  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  try {
    // Schema migrations are purely additive (CREATE TABLE IF NOT EXISTS + ALTER
    // ADD COLUMN). They're applied in both modes so dry-run can preview data
    // writes correctly — but dry-run still skips every DELETE/INSERT/UPDATE.
    console.log('Step 1: ensure schema (additive, idempotent — runs in dry-run too)')
    ensureSchema(db)

    console.log('Step 2: scan vault contacts → contacts_index')
    const reindex = rebuildContactsIndex(db, VAULT_BASE, { dryRun })
    fmt('files_scanned', reindex.files_scanned)
    fmt('indexed', reindex.indexed)
    fmt('errors', reindex.errors.length)
    if (reindex.errors.length > 0) {
      for (const e of reindex.errors) console.log(`    ! ${e.path}: ${e.error}`)
    }

    console.log('Step 3: seed last_interaction from Granola meetings')
    const meetings = seedLastInteractionFromMeetings(db, VAULT_BASE, { sinceDays, dryRun })
    fmt('attendee_matches', meetings.matches)
    fmt('contacts_bumped', meetings.bumped)

    console.log('Step 4: seed last_interaction from Gmail live label')
    const gmail = seedLastInteractionFromGmail(db, { sinceDays, dryRun })
    fmt('email_matches', gmail.matches)
    fmt('contacts_bumped', gmail.bumped)

    if (!dryRun) {
      console.log('')
      console.log('Step 5: rebuild next_touchpoint after bumps (sql)')
      const upd = db.prepare(`
        UPDATE contacts_index
           SET next_touchpoint = CASE
             WHEN last_interaction IS NOT NULL AND follow_up_days IS NOT NULL
             THEN date(last_interaction, '+' || follow_up_days || ' days')
             ELSE NULL
           END
      `).run()
      fmt('rows_recomputed', upd.changes)
    }

    console.log('')
    console.log(`[${new Date().toISOString()}] backfill complete`)
  } finally {
    db.close()
  }
}

main().catch(err => {
  console.error(`[${new Date().toISOString()}] FATAL:`, err instanceof Error ? err.message : err)
  process.exit(1)
})
