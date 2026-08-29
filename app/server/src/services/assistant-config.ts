import { getDb } from '../db/index.js'
import type {
  AssistantConfig,
  AssistantConfigPatch,
  AutonomyConfig,
  ConnectorBinding,
  ConnectorId,
  KnowledgeSourceRef,
  PersonaConfig,
} from '@command-center/shared'

/**
 * Per-user Personal Assistant config: persistence + resolver (obj 701700).
 *
 * Replaces the single-tenant `isOwnerThread()` gate in mentor-session.ts with a
 * `(user, workspace)`-grained config lookup. The three behaviors that were
 * hardcoded to Operator (persona/manual, Google identity, confirmation gating) are
 * now DATA read from `assistant_configs` (see db/index.ts). Every user with
 * Assistant access resolves their OWN config; the owner migrates losslessly via
 * the seed written at migration time.
 */

// ── Row shape (JSON columns are TEXT) ───────────────────────────────────────
interface AssistantConfigRow {
  user_id: number
  workspace: string
  display_name: string
  tagline: string | null
  system_prompt: string
  manual_source: string | null
  model: string | null
  autonomy: string
  enabled_capabilities: string
  enabled_connectors: string
  connector_bindings: string
  knowledge_sources: string
  enabled: number
  created_at: string
  updated_at: string
}

/** Sensible create-on-read default for a user who has never configured one. */
export const DEFAULT_AUTONOMY_LEVEL = 'confirm_external' as const

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    const v = JSON.parse(raw)
    return (v ?? fallback) as T
  } catch {
    return fallback
  }
}

function rowToConfig(row: AssistantConfigRow): AssistantConfig {
  const persona: PersonaConfig = {
    displayName: row.display_name,
    tagline: row.tagline,
    systemPrompt: row.system_prompt,
    manualSource: safeParse<KnowledgeSourceRef | null>(row.manual_source, null),
  }
  const autonomy = safeParse<AutonomyConfig>(row.autonomy, { level: DEFAULT_AUTONOMY_LEVEL })
  return {
    userId: row.user_id,
    workspace: row.workspace,
    persona,
    model: row.model,
    autonomy,
    enabledCapabilities: safeParse<string[]>(row.enabled_capabilities, []),
    enabledConnectors: safeParse<string[]>(row.enabled_connectors, []),
    connectorBindings: safeParse<Record<ConnectorId, ConnectorBinding>>(row.connector_bindings, {}),
    knowledgeSources: safeParse<KnowledgeSourceRef[]>(row.knowledge_sources, []),
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * The in-memory default config for a brand-new (user, workspace). Not yet
 * persisted — `resolveAssistantConfig` persists it via create-on-read. Enabled
 * so every Assistant-access user gets a working (chat-first) assistant they can
 * then name/configure. Fail-safe: confirm_external gating, no connectors, so a
 * default assistant can never send email/etc. without the user wiring one up.
 */
export function defaultAssistantConfig(userId: number, workspace: string): AssistantConfig {
  const now = new Date().toISOString()
  return {
    userId,
    workspace,
    persona: {
      displayName: 'Assistant',
      tagline: null,
      systemPrompt:
        'You are a concise personal assistant. Help with the day-to-day: triage, ' +
        'drafting, planning, and retrieving what the user needs. Keep answers short ' +
        'and act only within the confirmation policy below.',
      manualSource: null,
    },
    model: null,
    autonomy: { level: DEFAULT_AUTONOMY_LEVEL },
    enabledCapabilities: [],
    enabledConnectors: [],
    connectorBindings: {},
    knowledgeSources: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
  }
}

function getRow(userId: number, workspace: string): AssistantConfigRow | undefined {
  return getDb()
    .prepare('SELECT * FROM assistant_configs WHERE user_id = ? AND workspace = ?')
    .get(userId, workspace) as AssistantConfigRow | undefined
}

/** The user's "default identity" row across workspaces (oldest wins). */
function getAnyRowForUser(userId: number): AssistantConfigRow | undefined {
  return getDb()
    .prepare('SELECT * FROM assistant_configs WHERE user_id = ? ORDER BY created_at, workspace LIMIT 1')
    .get(userId) as AssistantConfigRow | undefined
}

function insertConfig(cfg: AssistantConfig): void {
  getDb()
    .prepare(
      `INSERT INTO assistant_configs
         (user_id, workspace, display_name, tagline, system_prompt, manual_source,
          model, autonomy, enabled_capabilities, enabled_connectors, connector_bindings,
          knowledge_sources, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      cfg.userId,
      cfg.workspace,
      cfg.persona.displayName,
      cfg.persona.tagline ?? null,
      cfg.persona.systemPrompt,
      cfg.persona.manualSource ? JSON.stringify(cfg.persona.manualSource) : null,
      cfg.model ?? null,
      JSON.stringify(cfg.autonomy),
      JSON.stringify(cfg.enabledCapabilities),
      JSON.stringify(cfg.enabledConnectors),
      JSON.stringify(cfg.connectorBindings ?? {}),
      JSON.stringify(cfg.knowledgeSources),
      cfg.enabled ? 1 : 0,
      cfg.createdAt,
      cfg.updatedAt,
    )
}

/**
 * Resolve the effective AssistantConfig for a (user, workspace).
 *
 * Order:
 *  1. Exact (user, workspace) row → return it.
 *  2. Any row for the user (their default identity) → return it, so a user has
 *     ONE assistant identity across workspaces unless they set a per-workspace
 *     override via `upsertAssistantConfig`.
 *  3. No row anywhere → create-on-read a sensible default, persist it, return it.
 *
 * Returns null only when the user id is missing (legacy NULL created_by) — this
 * is the fail-closed equivalent of the old `isOwnerThread(null) === false`.
 */
export function resolveAssistantConfig(
  userId: number | null | undefined,
  workspace: string,
): AssistantConfig | null {
  if (!userId) return null
  const exact = getRow(userId, workspace)
  if (exact) return rowToConfig(exact)

  const fallback = getAnyRowForUser(userId)
  if (fallback) return rowToConfig(fallback)

  // Create-on-read default.
  const def = defaultAssistantConfig(userId, workspace)
  try {
    insertConfig(def)
    const persisted = getRow(userId, workspace)
    return persisted ? rowToConfig(persisted) : def
  } catch (err) {
    // A concurrent insert may have raced us; re-read.
    const raced = getRow(userId, workspace) || getAnyRowForUser(userId)
    if (raced) return rowToConfig(raced)
    console.warn('[assistant-config] create-on-read failed:', (err as Error).message)
    return def
  }
}

/**
 * Merge-write a partial patch onto the caller's existing/default config for
 * (user, workspace) and return the full updated config. Creates a per-workspace
 * override row if none exists (seeding from the resolved identity so unspecified
 * fields carry over). Bumps updated_at.
 */
export function upsertAssistantConfig(
  userId: number,
  workspace: string,
  patch: AssistantConfigPatch,
): AssistantConfig {
  const base = resolveAssistantConfig(userId, workspace) ?? defaultAssistantConfig(userId, workspace)
  const now = new Date().toISOString()

  const mergedPersona: PersonaConfig = patch.persona
    ? {
        displayName: patch.persona.displayName ?? base.persona.displayName,
        tagline: patch.persona.tagline !== undefined ? patch.persona.tagline : base.persona.tagline,
        systemPrompt: patch.persona.systemPrompt ?? base.persona.systemPrompt,
        manualSource:
          patch.persona.manualSource !== undefined ? patch.persona.manualSource : base.persona.manualSource,
      }
    : base.persona

  const merged: AssistantConfig = {
    userId,
    workspace,
    persona: mergedPersona,
    model: patch.model !== undefined ? patch.model : base.model,
    autonomy: patch.autonomy ?? base.autonomy,
    enabledCapabilities: patch.enabledCapabilities ?? base.enabledCapabilities,
    enabledConnectors: patch.enabledConnectors ?? base.enabledConnectors,
    connectorBindings: patch.connectorBindings !== undefined ? patch.connectorBindings : base.connectorBindings,
    knowledgeSources: patch.knowledgeSources ?? base.knowledgeSources,
    enabled: patch.enabled !== undefined ? patch.enabled : base.enabled,
    createdAt: base.createdAt,
    updatedAt: now,
  }

  const existing = getRow(userId, workspace)
  const db = getDb()
  if (existing) {
    db.prepare(
      `UPDATE assistant_configs SET
         display_name = ?, tagline = ?, system_prompt = ?, manual_source = ?,
         model = ?, autonomy = ?, enabled_capabilities = ?, enabled_connectors = ?,
         connector_bindings = ?, knowledge_sources = ?, enabled = ?, updated_at = ?
       WHERE user_id = ? AND workspace = ?`
    ).run(
      merged.persona.displayName,
      merged.persona.tagline ?? null,
      merged.persona.systemPrompt,
      merged.persona.manualSource ? JSON.stringify(merged.persona.manualSource) : null,
      merged.model ?? null,
      JSON.stringify(merged.autonomy),
      JSON.stringify(merged.enabledCapabilities),
      JSON.stringify(merged.enabledConnectors),
      JSON.stringify(merged.connectorBindings ?? {}),
      JSON.stringify(merged.knowledgeSources),
      merged.enabled ? 1 : 0,
      merged.updatedAt,
      userId,
      workspace,
    )
  } else {
    insertConfig(merged)
  }

  const persisted = getRow(userId, workspace)
  return persisted ? rowToConfig(persisted) : merged
}

/**
 * Resolve the config for a mentor thread from its creator + workspace. Returns
 * null for legacy threads with no creator (fail-closed).
 */
export function getAssistantConfigForThread(threadId: number): AssistantConfig | null {
  const row = getDb()
    .prepare('SELECT created_by, workspace FROM mentor_threads WHERE id = ?')
    .get(threadId) as { created_by: number | null; workspace: string | null } | undefined
  if (!row) return null
  return resolveAssistantConfig(row.created_by, row.workspace || 'example')
}
