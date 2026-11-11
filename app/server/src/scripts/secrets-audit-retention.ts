#!/usr/bin/env tsx
/**
 * Secrets audit-log retention job — D5 (obj 900540): keep 1 year, export, prune.
 *
 *   docker exec command-center tsx server/src/scripts/secrets-audit-retention.ts           # dry run
 *   docker exec command-center tsx server/src/scripts/secrets-audit-retention.ts --apply   # export + prune
 *
 * Options: --days N (minimum and default 365), --export-dir DIR (default
 * $SECRETS_AUDIT_EXPORT_DIR or /app/data/audit-exports, which the nightly backup
 * includes). See services/secrets-audit-retention.ts for the exact steps, and
 * docs/security.md → "Audit log retention" for where exports go and how to read one.
 */
import { initDb } from '../db/index.js'
import { auditExportDir, runAuditRetention } from '../services/secrets-audit-retention.js'

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)
if (isMain) {
  const argv = process.argv.slice(2)
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  try {
    initDb()
    const apply = argv.includes('--apply')
    const r = runAuditRetention({
      days: val('--days') ? Number(val('--days')) : undefined,
      exportDir: val('--export-dir') ?? auditExportDir(),
      apply,
    })
    if (r.rows === 0) {
      console.log(`secrets-audit-retention: nothing older than ${r.cutoff} UTC`)
    } else if (!r.applied) {
      console.log(`secrets-audit-retention: [dry run] ${r.rows} row(s) older than ${r.cutoff} UTC (ids ${r.minId}..${r.maxId}) would be exported and pruned. Re-run with --apply.`)
    } else {
      console.log(`secrets-audit-retention: exported ${r.rows} row(s) to ${r.file} (sha256 ${r.sha256}) and pruned them; audit_prune row written`)
    }
  } catch (err) {
    console.error(`secrets-audit-retention: ${(err as Error).message}`)
    process.exit(1)
  }
}
