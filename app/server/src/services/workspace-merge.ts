/**
 * workspace-merge — fold one workspace slug into another, reversibly (obj 900206).
 *
 * Why this exists: there is no supported path for merging two workspaces. The
 * slug is denormalised across ~30 tables, so the only alternatives were a pile
 * of hand-written `UPDATE` statements (which silently miss any table a later
 * migration adds) or nothing. This module is the supported path: it derives the
 * table/column set by **PRAGMA introspection**, not from a hard-coded list, so a
 * table added tomorrow is swept tomorrow.
 *
 * ## Safety properties
 *
 * - **Dry-run first.** `planMerge()` is pure-read and is what the CLI runs by
 *   default; `applyMerge()` is the only writer and the CLI gates it behind an
 *   explicit `--apply` plus a verified DB backup.
 * - **One transaction.** `applyMerge()` wraps every statement so a failed
 *   verification rolls the whole merge back.
 * - **Never a blind overwrite.** Rows whose move would violate a UNIQUE/PK key
 *   the target already occupies (the `secrets` upsert key, a membership row, a
 *   settings key) are **left on the source** and reported as conflicts. The
 *   target's value always wins and is never touched.
 * - **Never a delete.** The source workspace row is ARCHIVED, not removed —
 *   `initWorkspacesSchema()` runs `DELETE FROM user_workspaces WHERE workspace
 *   NOT IN (SELECT slug FROM workspaces)` on every boot, and
 *   `workspace_repos` / `workspace_integrations` / `dev_items` cascade on a
 *   `workspaces` row delete, so dropping the row would silently destroy
 *   memberships and integrations on the next restart.
 * - **CHECK constraints are detected, not crashed into.**
 *   `granola_processed_meetings.workspace` carries
 *   `CHECK(workspace IN ('example','example-project','personal','operator','example2','example5'))`
 *   and SQLite cannot `ALTER` a CHECK. Such a table is reported as `blocked`
 *   and skipped rather than aborting the merge.
 */
import type Database from 'better-sqlite3'

/** Column names that hold a workspace slug. */
const SLUG_COLUMNS = ['workspace', 'workspace_slug', 'vault_workspace'] as const

/**
 * Tables whose slug column must NOT be swept generically.
 * - `workspaces` — the registry row itself (`slug` is the identity, and the
 *   source row must survive as an archived tombstone).
 * - `user_workspaces` — a membership is a UNION, not a move: see
 *   `mergeMemberships()`.
 */
const SKIP_TABLES = new Set(['workspaces', 'user_workspaces'])

export interface WorkspaceColumnRef {
  table: string
  column: string
}

export interface TablePlan extends WorkspaceColumnRef {
  /** Rows on the source slug. */
  rows: number
  /** Rows that would move cleanly. */
  moving: number
  /** Rows blocked by a UNIQUE/PK the target already occupies. */
  conflicts: number
  /** Set when the whole table cannot be swept. */
  blocked?: 'check-constraint'
  /** Human-readable conflict keys (identifiers only — never a value). */
  conflictKeys: string[]
}

export interface MembershipPlan {
  /** user_ids that gain access to the target because of the merge. */
  added: number[]
  /** user_ids already in both — the row is de-duplicated, privileges unioned. */
  merged: number[]
  /** user_ids whose target-side privileges are raised to the source's. */
  upgraded: number[]
}

export interface MergePlan {
  from: string
  to: string
  objectives: { from: number; to: number; expectedAfter: number }
  tables: TablePlan[]
  memberships: MembershipPlan
  warnings: string[]
}

export interface MergeReport extends MergePlan {
  applied: true
  /** Post-merge recount, used to gate the archive. */
  verified: { from: number; to: number; ok: boolean }
  archivedSource: boolean
}

/** Every (table, column) pair in this database that stores a workspace slug. */
export function listWorkspaceColumns(db: Database.Database): WorkspaceColumnRef[] {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>
  const out: WorkspaceColumnRef[] = []
  for (const { name } of tables) {
    if (SKIP_TABLES.has(name)) continue
    const cols = db.prepare(`PRAGMA table_info(${quoteIdent(name)})`).all() as Array<{ name: string }>
    for (const c of cols) {
      if ((SLUG_COLUMNS as readonly string[]).includes(c.name)) out.push({ table: name, column: c.name })
    }
  }
  return out
}

/**
 * True when `table` carries a `CHECK(<column> IN (...))` whose value list does
 * NOT include `value`. Parsed from the stored DDL because SQLite exposes no
 * introspection for CHECK constraints.
 */
export function checkConstraintRejects(
  db: Database.Database,
  table: string,
  column: string,
  value: string,
): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { sql: string | null } | undefined
  const sql = row?.sql
  if (!sql) return false
  const re = new RegExp(`CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(([^)]*)\\)`, 'i')
  const m = re.exec(sql)
  if (!m) return false
  const allowed = m[1]
    .split(',')
    .map(s => s.trim().replace(/^'(.*)'$/, '$1'))
    .filter(Boolean)
  return !allowed.includes(value)
}

/**
 * Column sets that must stay unique and that INCLUDE the workspace column —
 * i.e. the keys a move could collide on. Covers the PRIMARY KEY and every
 * UNIQUE index.
 */
export function collidingKeySets(
  db: Database.Database,
  table: string,
  column: string,
): string[][] {
  const sets: string[][] = []
  const pk = (db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as Array<{ name: string; pk: number }>)
    .filter(c => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map(c => c.name)
  if (pk.length && pk.includes(column)) sets.push(pk)
  const indexes = db.prepare(`PRAGMA index_list(${quoteIdent(table)})`).all() as Array<{ name: string; unique: number }>
  for (const idx of indexes) {
    if (!idx.unique) continue
    const cols = (db.prepare(`PRAGMA index_info(${quoteIdent(idx.name)})`).all() as Array<{ name: string | null }>)
      .map(c => c.name)
      .filter((n): n is string => !!n)
    if (cols.includes(column)) sets.push(cols)
  }
  return sets
}

/**
 * Rows on `from` that cannot move because the identical key already exists on
 * `to`. Returns the conflicting key tuples, rendered as `col=value` strings so
 * they are legible in a log — the workspace column is dropped from the render
 * (it is the same for every row) and no table here stores a plaintext secret
 * (`secrets.value_encrypted` is never part of a unique key).
 */
export function findConflicts(
  db: Database.Database,
  table: string,
  column: string,
  from: string,
  to: string,
  keySets: string[][],
): string[] {
  const seen = new Set<string>()
  for (const cols of keySets) {
    const others = cols.filter(c => c !== column)
    const t = quoteIdent(table)
    // Rows on `from` whose non-workspace key columns already exist on `to`.
    const on = others.length
      ? others.map(c => `a.${quoteIdent(c)} IS b.${quoteIdent(c)}`).join(' AND ')
      : '1=1'
    const select = others.length
      ? others.map(c => `a.${quoteIdent(c)} AS ${quoteIdent(c)}`).join(', ')
      : `'(whole-table)' AS k`
    const rows = db
      .prepare(
        `SELECT DISTINCT ${select} FROM ${t} a JOIN ${t} b ON ${on}
         WHERE a.${quoteIdent(column)} = ? AND b.${quoteIdent(column)} = ?`,
      )
      .all(from, to) as Array<Record<string, unknown>>
    for (const r of rows) {
      seen.add(`${table}[${Object.entries(r).map(([k, v]) => `${k}=${String(v)}`).join(',')}]`)
    }
  }
  return [...seen].sort()
}

/** Read-only. What `applyMerge` would do. */
export function planMerge(db: Database.Database, from: string, to: string): MergePlan {
  if (from === to) throw new Error('refusing to merge a workspace into itself')
  assertWorkspaceExists(db, from)
  assertWorkspaceExists(db, to)

  const warnings: string[] = []
  const tables: TablePlan[] = []
  for (const ref of listWorkspaceColumns(db)) {
    const t = quoteIdent(ref.table)
    const c = quoteIdent(ref.column)
    const rows = (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${c} = ?`).get(from) as { n: number }).n
    if (rows === 0) continue
    if (checkConstraintRejects(db, ref.table, ref.column, to)) {
      tables.push({ ...ref, rows, moving: 0, conflicts: 0, blocked: 'check-constraint', conflictKeys: [] })
      warnings.push(
        `${ref.table}.${ref.column} has a CHECK(... IN ...) that excludes '${to}'; ` +
          `${rows} row(s) left on '${from}'. SQLite cannot ALTER a CHECK — rebuild the table to move them.`,
      )
      continue
    }
    const conflictKeys = findConflicts(db, ref.table, ref.column, from, to, collidingKeySets(db, ref.table, ref.column))
    tables.push({
      ...ref,
      rows,
      moving: rows - conflictKeys.length,
      conflicts: conflictKeys.length,
      conflictKeys,
    })
    if (conflictKeys.length) {
      warnings.push(
        `${ref.table}: ${conflictKeys.length} row(s) kept on '${from}' — '${to}' already holds that key. ` +
          `The '${to}' value wins and was NOT modified.`,
      )
    }
  }

  const objFrom = countObjectives(db, from)
  const objTo = countObjectives(db, to)

  return {
    from,
    to,
    objectives: { from: objFrom, to: objTo, expectedAfter: objFrom + objTo },
    tables,
    memberships: planMemberships(db, from, to),
    warnings,
  }
}

/** Membership union, computed read-only. */
export function planMemberships(db: Database.Database, from: string, to: string): MembershipPlan {
  const src = db.prepare('SELECT * FROM user_workspaces WHERE workspace = ?').all(from) as Membership[]
  const dst = new Map(
    (db.prepare('SELECT * FROM user_workspaces WHERE workspace = ?').all(to) as Membership[]).map(r => [r.user_id, r]),
  )
  const added: number[] = []
  const merged: number[] = []
  const upgraded: number[] = []
  for (const s of src) {
    const d = dst.get(s.user_id)
    if (!d) {
      added.push(s.user_id)
      continue
    }
    merged.push(s.user_id)
    if (unionMembership(s, d) !== null) upgraded.push(s.user_id)
  }
  return { added: added.sort(), merged: merged.sort(), upgraded: upgraded.sort() }
}

interface Membership {
  user_id: number
  workspace: string
  role: string
  can_use_assistant: number
  objective_visibility: string
}

/**
 * Most-permissive-wins union of two membership rows, or `null` when the target
 * row already dominates. "No one loses access" (requirement 5) means a user who
 * was an `example` admin with `objective_visibility='all'` must not be demoted by
 * a weaker `your-org` row.
 */
export function unionMembership(src: Membership, dst: Membership): Partial<Membership> | null {
  const role = src.role === 'admin' || dst.role === 'admin' ? 'admin' : dst.role
  const assistant = src.can_use_assistant || dst.can_use_assistant ? 1 : 0
  const vis = src.objective_visibility === 'all' || dst.objective_visibility === 'all' ? 'all' : dst.objective_visibility
  if (role === dst.role && assistant === dst.can_use_assistant && vis === dst.objective_visibility) return null
  return { role, can_use_assistant: assistant, objective_visibility: vis }
}

/**
 * Union memberships then drop the source rows. Caller must already be inside a
 * transaction. Per-user connector rows (`user_google`, `user_github_token`,
 * `workspace_user`-scoped secrets) are keyed by `user_id` as well as workspace,
 * so they re-scope per user through the generic sweep and are never merged
 * across users — connector isolation is preserved.
 */
export function mergeMemberships(db: Database.Database, from: string, to: string): MembershipPlan {
  const plan = planMemberships(db, from, to)
  const src = db.prepare('SELECT * FROM user_workspaces WHERE workspace = ?').all(from) as Membership[]
  const getDst = db.prepare('SELECT * FROM user_workspaces WHERE workspace = ? AND user_id = ?')
  const ins = db.prepare(
    `INSERT INTO user_workspaces (user_id, workspace, role, can_use_assistant, objective_visibility)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const upd = db.prepare(
    `UPDATE user_workspaces SET role = ?, can_use_assistant = ?, objective_visibility = ?
     WHERE workspace = ? AND user_id = ?`,
  )
  for (const s of src) {
    const d = getDst.get(to, s.user_id) as Membership | undefined
    if (!d) {
      ins.run(s.user_id, to, s.role, s.can_use_assistant, s.objective_visibility)
      continue
    }
    const u = unionMembership(s, d)
    if (u) upd.run(u.role, u.can_use_assistant, u.objective_visibility, to, s.user_id)
  }
  db.prepare('DELETE FROM user_workspaces WHERE workspace = ?').run(from)
  return plan
}

/**
 * Perform the merge inside ONE transaction, verify the card counts, and archive
 * the source only when they reconcile. Throws (rolling everything back) when
 * they do not.
 */
export function applyMerge(db: Database.Database, from: string, to: string): MergeReport {
  const plan = planMerge(db, from, to)
  let report!: MergeReport

  db.transaction(() => {
    for (const t of plan.tables) {
      if (t.blocked) continue
      const tbl = quoteIdent(t.table)
      const col = quoteIdent(t.column)
      // `OR IGNORE` is the enforcement of the no-blind-overwrite rule: a row
      // whose move would violate a UNIQUE/PK the target already holds is left
      // exactly where it is. `planMerge` already counted and named these.
      db.prepare(`UPDATE OR IGNORE ${tbl} SET ${col} = ? WHERE ${col} = ?`).run(to, from)
    }
    mergeMemberships(db, from, to)

    const after = { from: countObjectives(db, from), to: countObjectives(db, to) }
    const ok = after.from === 0 && after.to === plan.objectives.expectedAfter
    if (!ok) {
      throw new Error(
        `merge verification failed: expected ${from}=0 and ${to}=${plan.objectives.expectedAfter}, ` +
          `got ${from}=${after.from} and ${to}=${after.to}. Transaction rolled back; nothing changed.`,
      )
    }
    // Archive — never DELETE. See the module header.
    db.prepare("UPDATE workspaces SET archived = 1, updated_at = datetime('now') WHERE slug = ?").run(from)
    report = { ...plan, applied: true, verified: { ...after, ok }, archivedSource: true }
  })()

  return report
}

/** Requirement 7: flip a workspace back to visible. Touches nothing else. */
export function unarchiveWorkspace(db: Database.Database, slug: string): { slug: string; wasArchived: boolean } {
  assertWorkspaceExists(db, slug)
  const row = db.prepare('SELECT archived FROM workspaces WHERE slug = ?').get(slug) as { archived: number }
  const wasArchived = Number(row.archived) > 0
  if (wasArchived) {
    db.prepare("UPDATE workspaces SET archived = 0, updated_at = datetime('now') WHERE slug = ?").run(slug)
  }
  return { slug, wasArchived }
}

function countObjectives(db: Database.Database, slug: string): number {
  return (db.prepare('SELECT COUNT(*) n FROM objectives WHERE workspace = ?').get(slug) as { n: number }).n
}

function assertWorkspaceExists(db: Database.Database, slug: string): void {
  const row = db.prepare('SELECT slug FROM workspaces WHERE slug = ?').get(slug)
  if (!row) throw new Error(`workspace '${slug}' is not in the workspaces table`)
}

/** Identifiers come from sqlite_master/PRAGMA, never from user input, but quote anyway. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`)
  return `"${name}"`
}
