#!/usr/bin/env tsx
/**
 * workspace-merge — the operator front door for folding one workspace into
 * another (obj 900206). Dry-run by default; `--apply` is gated on a verified
 * backup of BOTH the database and the source vault tree.
 *
 *   # 1. look, change nothing (this is the default)
 *   tsx server/src/scripts/workspace-merge.ts --from example --to your-org
 *
 *   # 2. un-archive a workspace and stop
 *   tsx server/src/scripts/workspace-merge.ts --unarchive operationkit --apply
 *
 *   # 3. do it, backing up first
 *   tsx server/src/scripts/workspace-merge.ts --from example --to your-org \
 *       --vault-root /home/operator/second-brain/workspaces \
 *       --backup-dir /home/operator/backups/ws-merge --apply
 *
 * Flags: --from --to --unarchive --apply --vault-root --backup-dir
 *        --db (default $DB_PATH or /app/data/command-center.db)
 *        --skip-vault  (DB only; the vault fold is run separately)
 *        --retire-source-vault  (rename the source tree to _archived-<slug>
 *                                once every file is accounted for)
 *
 * Exit 0 = done (or a clean dry-run). Exit 1 = refused or rolled back.
 * Conflicts are printed and written to <backup-dir>/conflicts-<ts>.json as
 * NAMES AND PATHS ONLY — this tool never prints or stores a secret value.
 */
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import Database from 'better-sqlite3'
import { backupDatabase } from './db-backup.js'
import { planMerge, applyMerge, unarchiveWorkspace } from '../services/workspace-merge.js'
import {
  moveVaultTree,
  isAccountedFor,
  retireSourceTree,
  type VaultMovePlan,
} from '../services/workspace-vault-move.js'

export interface Args {
  from?: string
  to?: string
  unarchive?: string
  apply: boolean
  db: string
  vaultRoot?: string
  backupDir: string
  skipVault: boolean
  retireSourceVault: boolean
}

export function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    from: get('--from'),
    to: get('--to'),
    unarchive: get('--unarchive'),
    apply: argv.includes('--apply'),
    db: get('--db') || process.env.DB_PATH || '/app/data/command-center.db',
    vaultRoot: get('--vault-root'),
    backupDir: get('--backup-dir') || '/tmp/ws-merge-backups',
    skipVault: argv.includes('--skip-vault'),
    retireSourceVault: argv.includes('--retire-source-vault'),
  }
}

/** tar the source vault tree. Returns the archive path, or null when there is nothing to back up. */
export function backupVault(vaultRoot: string, slug: string, backupDir: string, stamp: string): string | null {
  const src = path.join(vaultRoot, slug)
  if (!fs.existsSync(src)) return null
  fs.mkdirSync(backupDir, { recursive: true })
  const out = path.join(backupDir, `vault-${slug}-${stamp}.tar.gz`)
  execFileSync('tar', ['-czf', out, '-C', vaultRoot, slug], { stdio: ['ignore', 'ignore', 'pipe'] })
  return out
}

function line(s = ''): void { console.log(s) }

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')

  if (!fs.existsSync(a.db)) {
    console.error(`database not found: ${a.db} (pass --db or set DB_PATH)`)
    return 1
  }

  // ---- --unarchive: surgical, and deliberately its own mode -----------------
  if (a.unarchive) {
    const db = new Database(a.db)
    try {
      if (!a.apply) {
        const row = db.prepare('SELECT slug, name, archived FROM workspaces WHERE slug = ?').get(a.unarchive)
        line(`DRY RUN — would unarchive: ${JSON.stringify(row)}`)
        line('Re-run with --apply to write.')
        return 0
      }
      const r = unarchiveWorkspace(db, a.unarchive)
      line(r.wasArchived ? `unarchived '${r.slug}'` : `'${r.slug}' was already visible — no change`)
      return 0
    } finally {
      db.close()
    }
  }

  if (!a.from || !a.to) {
    console.error('usage: workspace-merge.ts --from <slug> --to <slug> [--apply]')
    console.error('       workspace-merge.ts --unarchive <slug> [--apply]')
    return 2
  }

  // ---- read-only plan, always ----------------------------------------------
  const ro = new Database(a.db, { readonly: true, fileMustExist: true })
  let plan
  try {
    plan = planMerge(ro, a.from, a.to)
  } finally {
    ro.close()
  }

  let vaultPlan: VaultMovePlan | null = null
  if (!a.skipVault && a.vaultRoot) {
    vaultPlan = moveVaultTree(path.join(a.vaultRoot, a.from), path.join(a.vaultRoot, a.to), a.from)
  }

  line(`${a.apply ? 'PLAN' : 'DRY RUN'} — merge '${a.from}' into '${a.to}'`)
  line(`  cards: ${a.from}=${plan.objectives.from}  ${a.to}=${plan.objectives.to}  ->  ${a.to}=${plan.objectives.expectedAfter}`)
  line('  tables:')
  for (const t of plan.tables) {
    line(
      `    ${t.table}.${t.column}: ${t.rows} row(s)` +
        (t.blocked ? `  [BLOCKED: ${t.blocked} — left on '${a.from}']` : `  move=${t.moving} conflict=${t.conflicts}`),
    )
  }
  line(`  memberships: +${plan.memberships.added.length} added, ${plan.memberships.merged.length} merged (${plan.memberships.upgraded.length} upgraded)`)
  if (vaultPlan) {
    line(`  vault: ${vaultPlan.files} file(s) / ${vaultPlan.bytes} bytes — copy=${vaultPlan.copied}, ` +
      `duplicate=${vaultPlan.collisions.filter(c => c.kind === 'duplicate').length}, ` +
      `renamed=${vaultPlan.collisions.filter(c => c.kind === 'renamed').length}`)
  } else if (!a.skipVault) {
    line('  vault: SKIPPED — pass --vault-root to include the KB fold (or --skip-vault to silence this)')
  }
  for (const w of plan.warnings) line(`  WARN  ${w}`)

  if (!a.apply) {
    line()
    line('Nothing was written. Re-run with --apply (and --backup-dir) to perform the merge.')
    return 0
  }

  // ---- backup gate: no backup, no mutation ---------------------------------
  fs.mkdirSync(a.backupDir, { recursive: true })
  const dbSnap = path.join(a.backupDir, `command-center-${stamp}.db`)
  const snap = await backupDatabase(a.db, dbSnap)
  if (!snap.ok) {
    console.error(`REFUSING: database backup failed integrity_check (${snap.integrity}). Nothing was changed.`)
    return 1
  }
  line(`  backup(db):    ${dbSnap}  (${snap.bytes} bytes, integrity ${snap.integrity})`)
  if (a.vaultRoot) {
    const tar = backupVault(a.vaultRoot, a.from, a.backupDir, stamp)
    line(tar ? `  backup(vault): ${tar}` : `  backup(vault): source tree absent — nothing to archive`)
  } else if (!a.skipVault) {
    console.error('REFUSING: --apply without --vault-root and without --skip-vault. Be explicit about the KB.')
    return 1
  }

  // ---- mutate --------------------------------------------------------------
  const db = new Database(a.db)
  let report
  try {
    report = applyMerge(db, a.from, a.to)
  } catch (err) {
    console.error(`ROLLED BACK: ${(err as Error).message}`)
    return 1
  } finally {
    db.close()
  }
  line(`  merged. ${a.from}=${report.verified.from}, ${a.to}=${report.verified.to}; '${a.from}' archived (row kept).`)

  if (vaultPlan && a.vaultRoot) {
    vaultPlan = moveVaultTree(path.join(a.vaultRoot, a.from), path.join(a.vaultRoot, a.to), a.from, { apply: true })
    line(`  vault folded: copy=${vaultPlan.copied}, collisions=${vaultPlan.collisions.length}`)
    if (a.retireSourceVault) {
      if (!isAccountedFor(vaultPlan)) {
        console.error('REFUSING to retire source vault: not every file is accounted for. Tree left in place.')
      } else {
        line(`  source vault retired to: ${retireSourceTree(vaultPlan, a.from)}`)
      }
    }
  }

  const conflictLog = path.join(a.backupDir, `conflicts-${stamp}.json`)
  fs.writeFileSync(
    conflictLog,
    JSON.stringify(
      {
        from: a.from,
        to: a.to,
        at: new Date().toISOString(),
        note: 'Identifiers only. No secret value, and no file content, is recorded here.',
        warnings: report.warnings,
        tables: report.tables.filter(t => t.conflicts > 0 || t.blocked).map(t => ({
          table: t.table, rows: t.rows, blocked: t.blocked ?? null, conflictKeys: t.conflictKeys,
        })),
        memberships: report.memberships,
        vaultCollisions: vaultPlan?.collisions ?? [],
      },
      null,
      2,
    ),
  )
  line(`  conflict log:  ${conflictLog}`)
  line()
  line('Reverse: restore the DB snapshot above and un-tar the vault archive. Nothing was deleted.')
  return 0
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!)
if (isMain) process.exit(await main())
