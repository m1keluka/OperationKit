/**
 * Agent registry — promoted from the hard-coded `AgentContext` literal union
 * (shared/types-core.ts) to a real table, mirroring what `workspaces.ts` already
 * did for workspaces. A fresh install ships five generic executives and nothing
 * else; the operator's real roster lives in a gitignored `seed.agents.json` that
 * never leaves their host.
 *
 * Also drops the `objectives.agent_context` CHECK constraint. The old constraint
 * enumerated only eight slugs, so nine of the personas the UI offered were not
 * actually insertable. Rather than widen a hardcoded list (which is the very
 * thing being removed), the constraint is dropped outright: the registry table
 * is now the source of truth and validation happens at the API boundary — the
 * same contract `objectives.workspace` has had since workspaces became a table.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'
import { rebuildObjectivesTable } from './objectives-rebuild.js'

export type AgentWorkdirKind = 'projects' | 'workspace' | 'home' | 'custom'

export interface AgentSeedRow {
  slug: string
  label: string
  kind?: 'executive' | 'routing-only'
  assignable?: boolean
  prompt_file?: string | null
  workdir_kind?: AgentWorkdirKind
  workdir_path?: string | null
  mono?: string | null
  badge_hex?: string | null
  badge_tw?: string | null
  sort_order?: number
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
// dist/db/schema/agents.js and src/db/schema/agents.ts are both three levels
// below the server package root, so one relative walk serves both.
const SERVER_ROOT = path.resolve(HERE, '..', '..', '..')

/**
 * Seed precedence, mirroring the documented `seed.workspaces.json` contract
 * (docs/MIGRATION.md): an explicit SEED_AGENTS_PATH wins, then the operator's
 * gitignored real roster, then the committed generic example.
 */
export function resolveAgentSeedPath(): string | null {
  const candidates = [
    process.env.SEED_AGENTS_PATH,
    path.join(SERVER_ROOT, 'seed.agents.json'),
    path.join(SERVER_ROOT, 'seed.agents.example.json'),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}

/** Built-in fallback used when no seed file is readable at all (e.g. a packaged
 *  build whose JSON was not copied). Identical to seed.agents.example.json. */
export const DEFAULT_AGENT_SEED: AgentSeedRow[] = [
  { slug: 'cto', label: 'CTO', kind: 'executive', workdir_kind: 'projects', mono: 'CT', badge_hex: '#6F9AD8', badge_tw: 'bg-agent-cto', sort_order: 1 },
  { slug: 'cmo', label: 'CMO', kind: 'executive', workdir_kind: 'workspace', mono: 'CM', badge_hex: '#D389B0', badge_tw: 'bg-agent-cmo', sort_order: 2 },
  { slug: 'coo', label: 'COO', kind: 'executive', workdir_kind: 'workspace', mono: 'CO', badge_hex: '#6FB58C', badge_tw: 'bg-agent-coo', sort_order: 3 },
  { slug: 'cfo', label: 'CFO', kind: 'executive', workdir_kind: 'workspace', mono: 'CF', badge_hex: '#D6A24E', badge_tw: 'bg-agent-cfo', sort_order: 4 },
  { slug: 'general', label: 'General', kind: 'executive', workdir_kind: 'home', mono: 'GN', badge_hex: '#8C8A92', badge_tw: 'bg-agent-general', sort_order: 5 },
]

const VALID_KINDS = new Set(['executive', 'routing-only'])
const VALID_WORKDIRS = new Set(['projects', 'workspace', 'home', 'custom'])

export function loadAgentSeed(): AgentSeedRow[] {
  const file = resolveAgentSeedPath()
  if (!file) return DEFAULT_AGENT_SEED
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    console.warn(`[db] agent seed ${file} is unreadable/invalid JSON — falling back to defaults:`, (err as Error).message)
    return DEFAULT_AGENT_SEED
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[db] agent seed ${file} is not a JSON array — falling back to defaults`)
    return DEFAULT_AGENT_SEED
  }
  const rows: AgentSeedRow[] = []
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const slug = typeof r.slug === 'string' ? r.slug.trim() : ''
    if (!slug) continue
    const kind = typeof r.kind === 'string' && VALID_KINDS.has(r.kind) ? (r.kind as 'executive' | 'routing-only') : 'executive'
    const workdir_kind = typeof r.workdir_kind === 'string' && VALID_WORKDIRS.has(r.workdir_kind)
      ? (r.workdir_kind as AgentWorkdirKind)
      : 'workspace'
    rows.push({
      slug,
      label: typeof r.label === 'string' && r.label ? r.label : slug,
      kind,
      assignable: r.assignable === undefined ? true : !!r.assignable,
      prompt_file: typeof r.prompt_file === 'string' ? r.prompt_file : null,
      workdir_kind,
      workdir_path: typeof r.workdir_path === 'string' ? r.workdir_path : null,
      mono: typeof r.mono === 'string' ? r.mono : null,
      badge_hex: typeof r.badge_hex === 'string' ? r.badge_hex : null,
      badge_tw: typeof r.badge_tw === 'string' ? r.badge_tw : null,
      sort_order: typeof r.sort_order === 'number' ? r.sort_order : 0,
    })
  }
  return rows.length ? rows : DEFAULT_AGENT_SEED
}

/** True when the stored `objectives` DDL still carries an agent_context CHECK. */
export function objectivesHasAgentContextCheck(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'objectives'")
    .get() as { sql: string | null } | undefined
  if (!row?.sql) return false
  return /CHECK\s*\(\s*agent_context/i.test(row.sql)
}


/**
 * A DIFFERENT `agents` table already exists on the live board: an 8-row roster
 * (columns id/name/role/version/…) created out-of-band by the OperationKit
 * authoring subsystem via a mis-targeted migration (obj 701253 — no tracked
 * source creates it), together with two triggers that ABORT any objectives
 * insert/update whose agent_context is not in it. The W1 audit did not see this
 * because it read tracked source, not the production DB.
 *
 * It matters for two reasons: `CREATE TABLE IF NOT EXISTS agents` would silently
 * no-op against it and the seed INSERT would then throw at boot, and the triggers
 * are a THIRD hardcoded copy of the roster constraint this refactor exists to
 * remove — the same constraint the design spec explicitly declined to reintroduce
 * as a foreign key ("referential integrity is enforced at the API layer").
 *
 * So: drop the triggers, rename the old table aside (never DELETE — its rows are
 * preserved verbatim in `agents_legacy_okit`), and fold its roster into the new
 * registry so no board card is orphaned.
 */
function migrateLegacyAgentsTable(db: Database.Database): void {
  const existing = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'")
    .get() as { sql: string | null } | undefined
  if (!existing) return

  const cols = (db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map(c => c.name)
  if (cols.includes('slug')) return // already the registry table

  console.log('[db] Found a legacy out-of-band `agents` table — migrating it aside to `agents_legacy_okit`...')

  // Any trigger that gates objectives on the agents table must go first: once the
  // table is renamed its `SELECT id FROM agents` would resolve against the new
  // registry (which has no `id` column) and every board write would error.
  const triggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'objectives' AND sql LIKE '%FROM agents%'")
    .all() as { name: string }[]
  for (const t of triggers) {
    console.log(`[db]   dropping roster-enforcement trigger ${t.name}`)
    db.exec(`DROP TRIGGER IF EXISTS "${t.name}"`)
  }

  db.exec('DROP TABLE IF EXISTS agents_legacy_okit')
  db.exec('ALTER TABLE agents RENAME TO agents_legacy_okit')
}

/** Fold the preserved legacy roster into the registry. INSERT OR IGNORE, so the
 *  seed's richer metadata always wins; this only rescues slugs the seed lacks. */
function adoptLegacyAgentRows(db: Database.Database): void {
  const legacy = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agents_legacy_okit'")
    .get() as { name: string } | undefined
  if (!legacy) return
  const cols = (db.prepare('PRAGMA table_info(agents_legacy_okit)').all() as { name: string }[]).map(c => c.name)
  if (!cols.includes('id') || !cols.includes('name')) return
  db.exec(`
    INSERT OR IGNORE INTO agents (slug, label, kind, assignable, sort_order)
    SELECT id, COALESCE(NULLIF(name, ''), id), 'routing-only', 1, 998
    FROM agents_legacy_okit
    WHERE id IS NOT NULL AND id != ''
  `)
}

export function initAgentsSchema(db: Database.Database): void {
  migrateLegacyAgentsTable(db)

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      slug TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'executive' CHECK(kind IN ('executive', 'routing-only')),
      assignable INTEGER NOT NULL DEFAULT 1,
      prompt_file TEXT,
      workdir_kind TEXT NOT NULL DEFAULT 'workspace'
        CHECK(workdir_kind IN ('projects', 'workspace', 'home', 'custom')),
      workdir_path TEXT,
      mono TEXT,
      badge_hex TEXT,
      badge_tw TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agents_sort ON agents(archived, sort_order);
  `)

  // Idempotent: INSERT OR IGNORE never overwrites a row the operator has since
  // edited in the UI, and there is deliberately no DELETE anywhere in this
  // migration — an existing board card must never lose its agent.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO agents
       (slug, label, kind, assignable, prompt_file, workdir_kind, workdir_path,
        mono, badge_hex, badge_tw, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const a of loadAgentSeed()) {
    insert.run(
      a.slug,
      a.label,
      a.kind ?? 'executive',
      a.assignable === false ? 0 : 1,
      a.prompt_file ?? null,
      a.workdir_kind ?? 'workspace',
      a.workdir_path ?? null,
      a.mono ?? null,
      a.badge_hex ?? null,
      a.badge_tw ?? null,
      a.sort_order ?? 0,
    )
  }

  // Drop the agent_context CHECK. SQLite cannot ALTER a constraint, so the table
  // is rebuilt column-for-column with the constraint omitted.
  if (objectivesHasAgentContextCheck(db)) {
    console.log('[db] Rebuilding objectives table to DROP the agent_context CHECK constraint (registry is now the source of truth)...')
    rebuildObjectivesTable(db, {})
  }

  adoptLegacyAgentRows(db)

  // Backfill: promote any slug the board already uses into the registry so no
  // existing card points at a row that does not exist. Runs AFTER the seed, so
  // seeded labels/kinds win; an unknown historical slug becomes a visible (if
  // unstyled) registry row rather than a dangling reference.
  db.exec(`
    INSERT OR IGNORE INTO agents (slug, label, kind, assignable, sort_order)
    SELECT DISTINCT agent_context, agent_context, 'routing-only', 1, 999
    FROM objectives
    WHERE agent_context IS NOT NULL AND agent_context != ''
  `)
}
