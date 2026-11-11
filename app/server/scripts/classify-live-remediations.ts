/**
 * READ-ONLY validation of the check-fixability classifier (obj 704698, gap A) against the
 * real rows of `external_check_remediations` in the live Command Center DB. Opens the DB
 * with readonly:true and writes nothing. Run:
 *   DB_PATH=/dev/null ./node_modules/.bin/tsx server/scripts/classify-live-remediations.ts /app/data/command-center.db
 */
import Database from 'better-sqlite3'
import { classifyCheckFixability, type CheckClass } from '../src/services/external-remediation-classify.js'

const dbPath = process.argv[2] || '/app/data/command-center.db'
const db = new Database(dbPath, { readonly: true })

interface Row { check_name: string; repo: string; pr_number: number; attempt: number; escalated: number }
const rows = db.prepare('SELECT check_name, repo, pr_number, attempt, escalated FROM external_check_remediations').all() as Row[]

const byClass = new Map<CheckClass, { rows: number; names: Map<string, number>; attemptsBurned: number }>()
for (const r of rows) {
  const c = classifyCheckFixability(r.check_name)
  const bucket = byClass.get(c.class) || { rows: 0, names: new Map(), attemptsBurned: 0 }
  bucket.rows++
  bucket.names.set(r.check_name, (bucket.names.get(r.check_name) || 0) + 1)
  // Attempts burned on a REAL PR by a non-code-fixable check — the waste this closes.
  if (c.class !== 'code-fixable' && r.pr_number > 0) bucket.attemptsBurned++
  byClass.set(c.class, bucket)
}

console.log(`DB: ${dbPath}`)
console.log(`TOTAL ROWS: ${rows.length}\n`)
for (const cls of ['code-fixable', 'environmental', 'advisory', 'scheduled'] as CheckClass[]) {
  const b = byClass.get(cls)
  if (!b) { console.log(`${cls.toUpperCase()}: 0 rows\n`); continue }
  console.log(`${cls.toUpperCase()}: ${b.rows} rows across ${b.names.size} distinct check names` +
    (cls === 'code-fixable' ? '' : ` — ${b.attemptsBurned} of them attached to a REAL PR (attempts previously burned)`))
  for (const [name, n] of [...b.names.entries()].sort((a, b2) => b2[1] - a[1])) {
    console.log(`   ${String(n).padStart(3)}  ${name}`)
  }
  console.log('')
}
const nonFixable = rows.filter(r => !classifyCheckFixability(r.check_name).fixable)
console.log(`NOT code-fixable: ${nonFixable.length}/${rows.length} rows (${Math.round((nonFixable.length / rows.length) * 100)}%)`)
console.log(`  …of which on a real PR (would have burned that PR's attempt cap): ${nonFixable.filter(r => r.pr_number > 0).length}`)
db.close()
