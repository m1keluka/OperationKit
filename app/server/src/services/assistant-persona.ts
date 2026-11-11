/**
 * Assistant persona resolution (obj 709956, Phase 4 of the blank-slate work).
 *
 * The mentor/assistant subsystem used to hardcode a single persona slug
 * (`assistant`) and the absolute path `<ai-workspace>/agents/assistant.md` in
 * three places: the `assistant_configs` owner seed (db/schema/mentor.ts), the
 * Assistant directive builder (services/mentor-session.ts), and the assistant
 * ingest prompt (routes/admin-jobs.ts). Both are operator-specific — a fresh
 * blank-slate install seeds only the five generic executives (cto/cmo/coo/cfo/
 * general) and has no `assistant` row at all, so the hardcoded slug forced a
 * private persona to stay in the shipped default seed.
 *
 * The persona is now resolved through the DB agent registry, keyed by an
 * explicit operator setting. If the setting is unset, or names a slug the
 * registry does not carry, resolution returns `null` and every caller degrades:
 * no owner config is seeded, and the ingest prompt falls back to generic
 * assistant wording. Nothing crashes and nothing private is implied.
 *
 * Operator flow: set `ASSISTANT_AGENT_SLUG` to a slug present in the agent
 * registry (seeded from the gitignored `seed.agents.json`, or created through
 * `POST /api/admin/agents-registry`). See docs/MIGRATION.md.
 */
import path from 'path'
import { AGENTS_DIR } from '../config.js'
import { getAgent } from './agent-registry.js'

export interface AssistantPersona {
  slug: string
  label: string
  /** Absolute path to the persona's operating manual, or null if it has none. */
  manualPath: string | null
}

/** The operator-configured assistant persona slug, or null when unconfigured. */
export function assistantAgentSlug(): string | null {
  const raw = (process.env.ASSISTANT_AGENT_SLUG || '').trim()
  return raw || null
}

/**
 * Absolute manual path for a registry row's `prompt_file`. The column is
 * normally NULL (the slug→filename mapping is the identity), so callers pass
 * the slug as the fallback. An absolute value is used verbatim; a bare name is
 * resolved under AGENTS_DIR and gets a `.md` suffix if it lacks one.
 */
export function agentManualPath(promptFile: string | null | undefined): string | null {
  const f = (promptFile || '').trim()
  if (!f) return null
  if (path.isAbsolute(f)) return f
  return path.join(AGENTS_DIR, f.endsWith('.md') ? f : `${f}.md`)
}

/**
 * Resolve the assistant persona from the registry. Returns null when
 * ASSISTANT_AGENT_SLUG is unset, when the registry has no such row, when the
 * row is archived, or when the registry is unavailable (DB not yet open).
 */
export function resolveAssistantPersona(): AssistantPersona | null {
  const slug = assistantAgentSlug()
  if (!slug) return null
  let row
  try {
    row = getAgent(slug)
  } catch {
    return null
  }
  if (!row || row.archived) return null
  return {
    slug: row.slug,
    label: row.label,
    manualPath: agentManualPath(row.prompt_file || row.slug),
  }
}
