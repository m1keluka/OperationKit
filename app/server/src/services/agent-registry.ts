// ── Agent registry ───────────────────────────────────────────────────────
// DB-backed source of truth for which personas exist, what they are called,
// where they run, and which prompt file they inline. Replaces the hardcoded
// `AGENT_META` / `AGENT_CONTEXTS` unions in shared/types-core.ts and the
// `AGENT_MAP` / `WORKDIR_MAP` records in prompt-builder-workdir.ts.
//
// Same shape as services/model-registry.ts and services/workspaces.ts: a
// process-wide cache with an explicit invalidate-on-write hook. Table + seed
// live in db/schema/agents.ts.
import { getDb } from '../db/index.js'
import { PROJECTS_DIR, AI_WORKSPACE_DIR, HOME_DIR } from '../config.js'
import type { AgentRow, AgentKind, AgentWorkdirKind } from '@operationkit/shared'

interface AgentDbRow {
  slug: string
  label: string
  kind: string
  assignable: number
  prompt_file: string | null
  workdir_kind: string
  workdir_path: string | null
  mono: string | null
  badge_hex: string | null
  badge_tw: string | null
  archived: number
  sort_order: number
  created_at: string
  updated_at: string
}

function mapRow(r: AgentDbRow): AgentRow {
  return {
    slug: r.slug,
    label: r.label,
    kind: (r.kind === 'routing-only' ? 'routing-only' : 'executive') as AgentKind,
    assignable: r.assignable === 1,
    prompt_file: r.prompt_file,
    workdir_kind: (['projects', 'workspace', 'home', 'custom'].includes(r.workdir_kind)
      ? r.workdir_kind
      : 'workspace') as AgentWorkdirKind,
    workdir_path: r.workdir_path,
    mono: r.mono,
    badge_hex: r.badge_hex,
    badge_tw: r.badge_tw,
    archived: r.archived === 1,
    sort_order: r.sort_order,
  }
}

let cache: Map<string, AgentRow> | null = null

function loadCache(): Map<string, AgentRow> {
  if (cache) return cache
  const rows = getDb()
    .prepare('SELECT * FROM agents ORDER BY sort_order, slug')
    .all() as AgentDbRow[]
  cache = new Map(rows.map(r => [r.slug, mapRow(r)]))
  return cache
}

export function invalidateAgentsCache(): void {
  cache = null
}

/** All registry rows, ordered for display. Archived rows are excluded unless asked for. */
export function listAgents(opts: { includeArchived?: boolean } = {}): AgentRow[] {
  const rows = Array.from(loadCache().values())
  return opts.includeArchived ? rows : rows.filter(a => !a.archived)
}

/** Slugs a user may pick as an objective's primary agent. */
export function listAssignableAgents(): AgentRow[] {
  return listAgents().filter(a => a.assignable)
}

export function getAgent(slug: string | null | undefined): AgentRow | undefined {
  if (!slug) return undefined
  return loadCache().get(slug)
}

export function agentExists(slug: string): boolean {
  return loadCache().has(slug)
}

/**
 * Persona filename (no `.md`) under AGENTS_DIR. The registry column is normally
 * NULL because the mapping is the identity — the old AGENT_MAP was 17 rows of
 * `x: 'x'` and carried no information. An unknown slug falls back to itself so a
 * running session never reads "You are the undefined agent" (audit risk #3).
 */
export function resolveAgentPromptFile(slug: string | null | undefined): string {
  return getAgent(slug)?.prompt_file || (slug || 'general')
}

/**
 * Default working directory for a persona. `workdir_kind` is stored rather than
 * a raw path so registry rows stay portable across installs while the host paths
 * stay in config.ts. Unknown slug → HOME_DIR, matching the previous
 * `WORKDIR_MAP[ctx] || HOME_DIR` behaviour exactly.
 */
export function resolveAgentWorkdir(slug: string | null | undefined): string {
  const agent = getAgent(slug)
  if (!agent) return HOME_DIR
  switch (agent.workdir_kind) {
    case 'projects': return PROJECTS_DIR
    case 'workspace': return AI_WORKSPACE_DIR
    case 'home': return HOME_DIR
    case 'custom': return agent.workdir_path || HOME_DIR
    default: return HOME_DIR
  }
}

/** Human label for a slug; falls back to the slug so nothing renders blank. */
export function agentLabel(slug: string | null | undefined): string {
  return getAgent(slug)?.label || (slug || 'general')
}

// ── Admin CRUD ───────────────────────────────────────────────────────────

export interface UpsertAgentInput {
  slug: string
  label: string
  kind?: AgentKind
  assignable?: boolean
  prompt_file?: string | null
  workdir_kind?: AgentWorkdirKind
  workdir_path?: string | null
  mono?: string | null
  badge_hex?: string | null
  badge_tw?: string | null
  sort_order?: number
  archived?: boolean
}

export function createAgent(input: UpsertAgentInput): AgentRow {
  getDb().prepare(
    `INSERT INTO agents
       (slug, label, kind, assignable, prompt_file, workdir_kind, workdir_path,
        mono, badge_hex, badge_tw, sort_order, archived, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    input.slug,
    input.label,
    input.kind ?? 'executive',
    input.assignable === false ? 0 : 1,
    input.prompt_file ?? null,
    input.workdir_kind ?? 'workspace',
    input.workdir_path ?? null,
    input.mono ?? null,
    input.badge_hex ?? null,
    input.badge_tw ?? null,
    input.sort_order ?? 0,
    input.archived ? 1 : 0,
  )
  invalidateAgentsCache()
  const row = getAgent(input.slug)
  if (!row) throw new Error('Agent insert returned no row')
  return row
}

export function updateAgent(slug: string, patch: Partial<UpsertAgentInput>): AgentRow | undefined {
  const existing = getAgent(slug)
  if (!existing) return undefined
  const merged: AgentRow = {
    ...existing,
    label: patch.label ?? existing.label,
    kind: patch.kind ?? existing.kind,
    assignable: patch.assignable ?? existing.assignable,
    prompt_file: patch.prompt_file === undefined ? existing.prompt_file : patch.prompt_file,
    workdir_kind: patch.workdir_kind ?? existing.workdir_kind,
    workdir_path: patch.workdir_path === undefined ? existing.workdir_path : patch.workdir_path,
    mono: patch.mono === undefined ? existing.mono : patch.mono,
    badge_hex: patch.badge_hex === undefined ? existing.badge_hex : patch.badge_hex,
    badge_tw: patch.badge_tw === undefined ? existing.badge_tw : patch.badge_tw,
    sort_order: patch.sort_order ?? existing.sort_order,
    archived: patch.archived ?? existing.archived,
  }
  getDb().prepare(
    `UPDATE agents SET
       label = ?, kind = ?, assignable = ?, prompt_file = ?, workdir_kind = ?,
       workdir_path = ?, mono = ?, badge_hex = ?, badge_tw = ?, sort_order = ?,
       archived = ?, updated_at = datetime('now')
     WHERE slug = ?`
  ).run(
    merged.label,
    merged.kind,
    merged.assignable ? 1 : 0,
    merged.prompt_file,
    merged.workdir_kind,
    merged.workdir_path,
    merged.mono,
    merged.badge_hex,
    merged.badge_tw,
    merged.sort_order,
    merged.archived ? 1 : 0,
    slug,
  )
  invalidateAgentsCache()
  return getAgent(slug)
}

/**
 * Archive (never DELETE) — historical objectives keep pointing at the slug, so
 * removing the row would orphan board cards (audit risk #1). Refuses while the
 * persona still owns non-terminal work (audit risk #3).
 */
export function archiveAgent(slug: string): { ok: boolean; reason?: string } {
  if (!agentExists(slug)) return { ok: false, reason: 'not_found' }
  const active = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM objectives
       WHERE agent_context = ? AND status NOT IN ('done', 'cancelled') AND deleted_at IS NULL`
    )
    .get(slug) as { n: number }
  if (active.n > 0) {
    return { ok: false, reason: `${active.n} active objective(s) still assigned to '${slug}'` }
  }
  getDb().prepare("UPDATE agents SET archived = 1, updated_at = datetime('now') WHERE slug = ?").run(slug)
  invalidateAgentsCache()
  return { ok: true }
}
