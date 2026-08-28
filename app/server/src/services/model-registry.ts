// ── Model registry ───────────────────────────────────────────────────────
// DB-backed source of truth for which models are selectable, plus which model
// is the default (new objectives) and the planner (planning sub-sessions).
// Replaces the hardcoded 'claude-fable-5' literals that were scattered across
// the spawn path. Fable 5 + Mythos 5 were disabled by Anthropic on 2026-06-12
// to comply with a US Commerce/BIS export-control directive, which is why the
// registry exists: a model can now be toggled off without a code change.
// Table + first-seed/cutover migration live in db/index.ts.
import { getDb } from '../db/index.js'
import type { ModelRow, ModelEngine } from '@command-center/shared'

// Safety floor used only if the registry has no default row (should never
// happen — the seed guarantees one). Opus 4.8 is the strongest live model.
const FALLBACK_DEFAULT = 'claude-opus-4-8'

interface ModelDbRow {
  id: string
  label: string
  engine: string
  enabled: number
  is_default: number
  is_planner: number
  sort_order: number
}

function mapRow(r: ModelDbRow): ModelRow {
  return {
    id: r.id,
    label: r.label,
    engine: (r.engine === 'codex' ? 'codex' : r.engine === 'grok' ? 'grok' : 'claude') as ModelEngine,
    enabled: r.enabled === 1,
    is_default: r.is_default === 1,
    is_planner: r.is_planner === 1,
    sort_order: r.sort_order,
  }
}

/** All models, disabled included, ordered for display. */
export function listModels(): ModelRow[] {
  return (getDb().prepare('SELECT * FROM models ORDER BY sort_order, id').all() as ModelDbRow[]).map(mapRow)
}

/** Only models a user may pick for an objective. */
export function listEnabledModels(): ModelRow[] {
  return (getDb().prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY sort_order, id').all() as ModelDbRow[]).map(mapRow)
}

/** Model id for new objectives when the caller didn't specify one. */
export function getDefaultModelId(): string {
  const row = getDb().prepare('SELECT id FROM models WHERE is_default = 1 LIMIT 1').get() as { id: string } | undefined
  return row?.id ?? FALLBACK_DEFAULT
}

/** Cheaper model for grunt workers (tasks/bugs without a PR, not delegators). */
export const GRUNT_WORKER_MODEL_ID = 'claude-sonnet-4-6'

export function getGruntModelId(): string {
  const row = getDb()
    .prepare('SELECT id FROM models WHERE id = ? AND enabled = 1 LIMIT 1')
    .get(GRUNT_WORKER_MODEL_ID) as { id: string } | undefined
  return row?.id ?? getDefaultModelId()
}

/**
 * AI reviewer is a fresh-context verifier, not a designer. Prod was spawning
 * it with no `--model`, so the CLI used the account default (Opus 4.8 / Opus 5)
 * and median review took ~3 min. Sonnet 4.6 is the same id as grunt workers.
 */
export function getReviewerModelId(): string {
  return getGruntModelId()
}

/**
 * Pick the model for a newly created objective. An explicit `model` always
 * wins. Otherwise grunt workers (type task/bug, no PR, not a delegator) get
 * Sonnet so they don't cook the OAuth pool; projects / PR work / delegators
 * keep the board default (Opus 5 in prod).
 */
export function resolveObjectiveModel(opts: {
  model?: string | null
  type?: string | null
  create_pr?: boolean | number | null
  delegate_mode?: boolean | number | null
}): string {
  if (opts.model) return opts.model
  const type = opts.type || 'task'
  const createPr = !!opts.create_pr
  const delegate = !!opts.delegate_mode
  if (!createPr && !delegate && (type === 'task' || type === 'bug')) {
    return getGruntModelId()
  }
  return getDefaultModelId()
}

/** Model id for planning sub-sessions. Falls back to the default model. */
export function getPlannerModelId(): string {
  const row = getDb().prepare('SELECT id FROM models WHERE is_planner = 1 LIMIT 1').get() as { id: string } | undefined
  return row?.id ?? getDefaultModelId()
}

/** Which CLI/engine a model id runs on. Driven by the registry's `engine`
 *  column so a model id like 'gpt-5.5' routes to the Codex CLI. Falls back to a
 *  heuristic for ids not in the registry (e.g. a follow-up on an old objective
 *  whose row was removed): the legacy 'codex' alias + OpenAI-style ids → codex. */
export function getModelEngine(id: string | null | undefined): ModelEngine {
  if (!id) return 'claude'
  const row = getDb().prepare('SELECT engine FROM models WHERE id = ?').get(id) as { engine: string } | undefined
  if (row) {
    if (row.engine === 'codex') return 'codex'
    if (row.engine === 'grok') return 'grok'
    return 'claude'
  }
  if (id === 'codex' || /^(gpt-|o\d)/i.test(id)) return 'codex'
  if (/^grok/i.test(id)) return 'grok'
  return 'claude'
}

function requireModel(id: string): ModelRow {
  const row = getDb().prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelDbRow | undefined
  if (!row) throw new Error(`Unknown model: ${id}`)
  return mapRow(row)
}

/** Enable/disable a model. The active default and planner cannot be disabled —
 *  reassign those roles to another model first. */
export function setModelEnabled(id: string, enabled: boolean): ModelRow {
  const model = requireModel(id)
  if (!enabled && (model.is_default || model.is_planner)) {
    const role = model.is_default ? 'default' : 'planner'
    throw new Error(`Cannot disable ${id}: it is the current ${role} model. Assign another model as ${role} first.`)
  }
  getDb().prepare("UPDATE models SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, id)
  return requireModel(id)
}

/** Set the default model. Clears the previous default and auto-enables the new
 *  one (you can't default to a model nobody can use). */
export function setDefaultModel(id: string): ModelRow {
  requireModel(id)
  const db = getDb()
  db.transaction(() => {
    db.prepare('UPDATE models SET is_default = 0 WHERE is_default = 1').run()
    db.prepare("UPDATE models SET is_default = 1, enabled = 1, updated_at = datetime('now') WHERE id = ?").run(id)
  })()
  return requireModel(id)
}

/** Set the planner model. Clears the previous planner and auto-enables it. */
export function setPlannerModel(id: string): ModelRow {
  requireModel(id)
  const db = getDb()
  db.transaction(() => {
    db.prepare('UPDATE models SET is_planner = 0 WHERE is_planner = 1').run()
    db.prepare("UPDATE models SET is_planner = 1, enabled = 1, updated_at = datetime('now') WHERE id = ?").run(id)
  })()
  return requireModel(id)
}
