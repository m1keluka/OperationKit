/**
 * Column-preserving rebuild of the `objectives` table.
 *
 * SQLite cannot ALTER a CHECK constraint, so changing one means recreating the
 * table and copying every row. This was previously inlined in db/index.ts for
 * the `status` constraint; it is shared here because the agent-registry
 * migration needs the identical machinery to DROP the `agent_context` CHECK.
 *
 * Latent-defect fix carried by this extraction: the inline version re-created
 * only `idx_objectives_status` after the DROP, silently destroying every other
 * index on the table (the live board carries 20). This version enumerates the
 * real index set from `sqlite_master` first and restores all of them.
 */
import type Database from 'better-sqlite3'

export interface RebuildOverrides {
  /** Column name → full column definition to emit instead of the derived one.
   *  Omit a column to keep its current type / NOT NULL / DEFAULT verbatim. */
  [column: string]: string
}

interface ColumnInfo {
  name: string
  type: string
  dflt_value: string | null
  notnull: number
  pk: number
}

/**
 * Rebuild `objectives`, replacing the definitions of the columns named in
 * `overrides` and passing every other column through unchanged. All non-implicit
 * indexes are captured before the DROP and re-created afterwards.
 */
export function rebuildObjectivesTable(db: Database.Database, overrides: RebuildOverrides): void {
  const cols = db.prepare('PRAGMA table_info(objectives)').all() as ColumnInfo[]
  const colNames = cols.map(c => c.name)
  const colList = colNames.join(', ')

  // Capture every index BEFORE the table is dropped. Auto-indexes (UNIQUE /
  // PK backing indexes) have a NULL `sql` and are recreated by the CREATE
  // TABLE itself, so they are skipped.
  const indexes = (db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'objectives' AND sql IS NOT NULL")
    .all() as { name: string; sql: string }[])

  // DROP TABLE also drops the table's triggers. Capture and re-create them for
  // the same reason as the indexes — the previous inline rebuild restored
  // neither.
  const triggers = (db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'objectives' AND sql IS NOT NULL")
    .all() as { name: string; sql: string }[])

  const colDefs = cols.map(c => {
    if (overrides[c.name]) return overrides[c.name]
    if (c.name === 'id') return 'id INTEGER PRIMARY KEY AUTOINCREMENT'
    const notNull = c.notnull ? ' NOT NULL' : ''
    // PRAGMA strips outer parens from expression defaults (e.g. `(datetime('now'))` →
    // `datetime('now')`). SQLite requires compound-expression defaults to be
    // parenthesized, so re-wrap anything that isn't a bare literal.
    let dflt = ''
    if (c.dflt_value !== null) {
      const v = String(c.dflt_value)
      const isLiteral = /^'.*'$/.test(v) || /^-?\d+(\.\d+)?$/.test(v) || /^(NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME)$/i.test(v)
      dflt = isLiteral ? ` DEFAULT ${v}` : ` DEFAULT (${v})`
    }
    return `${c.name} ${c.type}${notNull}${dflt}`
  }).join(',\n        ')

  const recreateIndexes = indexes
    .map(i => `${i.sql.replace(/^CREATE (UNIQUE )?INDEX /i, (_m, u) => `CREATE ${u || ''}INDEX IF NOT EXISTS `)};`)
    .join('\n      ')

  const recreateTriggers = triggers.map(t => `${t.sql};`).join('\n      ')

  db.exec(`
      BEGIN;
      CREATE TABLE objectives_new (
        ${colDefs}
      );
      INSERT INTO objectives_new (${colList}) SELECT ${colList} FROM objectives;
      DROP TABLE objectives;
      ALTER TABLE objectives_new RENAME TO objectives;
      CREATE INDEX IF NOT EXISTS idx_objectives_status ON objectives(status);
      ${recreateIndexes}
      ${recreateTriggers}
      COMMIT;
  `)
}
