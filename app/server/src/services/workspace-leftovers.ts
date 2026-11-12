/**
 * workspace-leftovers — read-only inventory of everything that still names a
 * workspace slug (obj 900667).
 *
 * Follow-up to the workspace-merge tool (obj 900206 / PR 641). The merge's own
 * dry run counts rows in slug COLUMNS; it cannot see the places a slug hides
 * elsewhere, which is exactly where the "old Example projects still in the picker"
 * leftovers came from:
 *
 *   - `projects` rows on the retired slug (a same-named project cannot move
 *     because of `UNIQUE(workspace, name)`), and cards in OTHER workspaces whose
 *     `project_id` still points at them;
 *   - routine templates — `routines.objective_template` is JSON, and its
 *     `"workspace"` key is invisible to a column sweep, so every fire re-files a
 *     card under the retired org;
 *   - filesystem references in the `workspaces` registry (`vault_path`,
 *     `doc_read_roots`, `doc_write_roots`) that point into `workspaces/<slug>/`.
 *
 * Nothing here writes. It is what the operator runs on the live host before any
 * mutation, and the shape `workspace-merge.ts --inventory <slug>` prints.
 */
import type Database from 'better-sqlite3'
import { listWorkspaceColumns } from './workspace-merge.js'

export interface LeftoverInventory {
  slug: string
  workspace: { exists: boolean; archived: boolean | null; merged_into: string | null }
  /** Rows per slug-carrying column (zero-row columns omitted). */
  columns: Array<{ table: string; column: string; rows: number }>
  memberships: number
  projects: Array<{ id: number; name: string; archived: boolean; cards: number }>
  /** Cards in another workspace whose `project_id` is one of this slug's projects. */
  foreignCardsOnProjects: number
  /** Routines whose JSON template still files cards under this slug. */
  routineTemplates: Array<{ id: number; name: string; enabled: boolean }>
  /** OTHER registry rows whose filesystem roots point into `workspaces/<slug>`. */
  pathRefs: Array<{ workspace: string; field: string; value: string }>
  /** Total rows that still name the slug anywhere this inventory looks. */
  total: number
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name)
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(c => c.name)
}

/**
 * True when `p` names `<…>/workspaces/<slug>` or something under it, matched on
 * whole path segments — so `workspaces/your-org` is NOT a reference to `example`.
 */
export function pathPointsInto(p: string, slug: string): boolean {
  const segs = p.split('/').filter(Boolean)
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === 'workspaces' && segs[i + 1] === slug) return true
  }
  return false
}

export function inventoryWorkspace(db: Database.Database, slug: string): LeftoverInventory {
  const wsCols = tableExists(db, 'workspaces') ? columnsOf(db, 'workspaces') : []
  const wsRow = wsCols.length
    ? (db.prepare('SELECT * FROM workspaces WHERE slug = ?').get(slug) as Record<string, unknown> | undefined)
    : undefined

  const columns: LeftoverInventory['columns'] = []
  for (const ref of listWorkspaceColumns(db)) {
    const rows = (db.prepare(`SELECT COUNT(*) n FROM "${ref.table}" WHERE "${ref.column}" = ?`).get(slug) as { n: number }).n
    if (rows > 0) columns.push({ ...ref, rows })
  }

  const memberships = tableExists(db, 'user_workspaces')
    ? (db.prepare('SELECT COUNT(*) n FROM user_workspaces WHERE workspace = ?').get(slug) as { n: number }).n
    : 0

  let projects: LeftoverInventory['projects'] = []
  let foreignCardsOnProjects = 0
  const hasProjectId = tableExists(db, 'objectives') && columnsOf(db, 'objectives').includes('project_id')
  if (tableExists(db, 'projects') && hasProjectId) {
    projects = (
      db
        .prepare(
          `SELECT p.id, p.name, p.archived, COUNT(o.id) AS cards
             FROM projects p LEFT JOIN objectives o ON o.project_id = p.id
            WHERE p.workspace = ? GROUP BY p.id ORDER BY p.id`,
        )
        .all(slug) as Array<{ id: number; name: string; archived: number; cards: number }>
    ).map(r => ({ id: r.id, name: r.name, archived: Number(r.archived) > 0, cards: r.cards }))
    foreignCardsOnProjects = (
      db
        .prepare(
          `SELECT COUNT(*) n FROM objectives o JOIN projects p ON p.id = o.project_id
            WHERE p.workspace = ? AND o.workspace <> p.workspace`,
        )
        .get(slug) as { n: number }
    ).n
  }

  const routineTemplates = listRoutineTemplateRefs(db, slug)

  const pathRefs: LeftoverInventory['pathRefs'] = []
  if (wsCols.length) {
    const rows = db.prepare('SELECT * FROM workspaces').all() as Array<Record<string, unknown>>
    for (const r of rows) {
      // The slug's own row is the archived tombstone and keeps its historical
      // roots by design (the merge never rewrites or deletes it).
      if (r.slug === slug) continue
      for (const field of ['vault_path', 'doc_read_roots', 'doc_write_roots']) {
        const raw = r[field]
        if (typeof raw !== 'string' || !raw) continue
        let values: string[] = [raw]
        if (field !== 'vault_path') {
          try {
            const parsed = JSON.parse(raw)
            values = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
          } catch {
            values = []
          }
        }
        for (const v of values) {
          if (pathPointsInto(v, slug)) pathRefs.push({ workspace: String(r.slug), field, value: v })
        }
      }
    }
  }

  const total =
    columns.reduce((s, c) => s + c.rows, 0) + memberships + foreignCardsOnProjects + routineTemplates.length + pathRefs.length

  return {
    slug,
    workspace: {
      exists: !!wsRow,
      archived: wsRow ? Number(wsRow.archived) > 0 : null,
      merged_into: wsRow && typeof wsRow.merged_into === 'string' ? wsRow.merged_into : null,
    },
    columns,
    memberships,
    projects,
    foreignCardsOnProjects,
    routineTemplates,
    pathRefs,
    total,
  }
}

/** Routines whose `objective_template` JSON has `"workspace": <slug>`. */
export function listRoutineTemplateRefs(
  db: Database.Database,
  slug: string,
): Array<{ id: number; name: string; enabled: boolean }> {
  if (!tableExists(db, 'routines') || !columnsOf(db, 'routines').includes('objective_template')) return []
  return (
    db
      .prepare(
        `SELECT id, name, enabled FROM routines
          WHERE json_valid(objective_template)
            AND json_extract(objective_template, '$.workspace') = ?
          ORDER BY id`,
      )
      .all(slug) as Array<{ id: number; name: string; enabled: number }>
  ).map(r => ({ id: r.id, name: r.name, enabled: Number(r.enabled) > 0 }))
}

/** Render an inventory as the plain-text block the CLI prints. */
export function formatInventory(inv: LeftoverInventory): string[] {
  const out: string[] = []
  const w = inv.workspace
  out.push(`INVENTORY (read-only) — leftovers naming '${inv.slug}'`)
  out.push(
    `  workspace row: ${w.exists ? `archived=${w.archived} merged_into=${w.merged_into ?? '-'}` : 'absent'}`,
  )
  out.push(`  memberships: ${inv.memberships}`)
  out.push('  slug columns:')
  if (inv.columns.length === 0) out.push('    (none)')
  for (const c of inv.columns) out.push(`    ${c.table}.${c.column}: ${c.rows}`)
  out.push(`  projects: ${inv.projects.length}`)
  for (const p of inv.projects) out.push(`    #${p.id} ${JSON.stringify(p.name)} archived=${p.archived} cards=${p.cards}`)
  out.push(`  cards in other workspaces still filed under these projects: ${inv.foreignCardsOnProjects}`)
  out.push(`  routine templates filing into '${inv.slug}': ${inv.routineTemplates.length}`)
  for (const r of inv.routineTemplates) out.push(`    routine #${r.id} ${JSON.stringify(r.name)} enabled=${r.enabled}`)
  out.push(`  registry path references into workspaces/${inv.slug}: ${inv.pathRefs.length}`)
  for (const p of inv.pathRefs) out.push(`    ${p.workspace}.${p.field}: ${p.value}`)
  out.push(`  TOTAL leftover references: ${inv.total}`)
  return out
}
