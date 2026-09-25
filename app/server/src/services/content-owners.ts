// Content-owner resolution + per-owner provisioning.
//
// Everything the content engine used to read from module-level constants now
// hangs off a ContentOwner: vault paths, the founder voice pack, the nightly
// routine, and the Granola API key. One owner == one person == one second-brain
// workspace. See db/schema/content.ts for why ownership is a table and not a role.
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { CONTENT_ROUTINE_PREFIX } from '../db/schema/content.js'
import { chownToVaultUser } from './vault-fs.js'
import { getSecret, getSecretValue, setSecret, deleteSecret } from './secrets-store.js'
import type { RoutineRow } from './routine-scheduler.js'

export const VAULT_BASE = process.env.VAULT_PATH || '/home/operator/second-brain'
export const AI_WORKSPACE = process.env.AI_WORKSPACE || '/home/operator/ai-workspace'

/** Per-user Granola credential. Stored user-scoped in the native secrets store. */
export const GRANOLA_KEY_NAME = 'GRANOLA_API_KEY'

export interface ContentOwner {
  user_id: number
  vault_workspace: string
  founder_slug: string
  display_name: string
  routine_name: string
  enabled: number
  created_at: string
}

/** Filesystem layout for one owner's content streams. */
export interface OwnerPaths {
  wsRoot: string
  draftsDir: string
  hooksDir: string
  granolaDir: string
  loopsDir: string
  ideasFile: string
  /** li-post-writer founder pack — the voice profile the drafts are written in. */
  founderPackDir: string
  voicePatternsFile: string
}

export function ownerPaths(owner: ContentOwner): OwnerPaths {
  const wsRoot = path.join(VAULT_BASE, 'workspaces', owner.vault_workspace)
  const founderPackDir = path.join(
    AI_WORKSPACE, 'skills', 'li-post-writer', 'references', 'founders', owner.founder_slug
  )
  return {
    wsRoot,
    draftsDir: path.join(wsRoot, 'content', 'drafts'),
    hooksDir: path.join(wsRoot, 'content', 'hooks'),
    granolaDir: path.join(wsRoot, 'content', 'granola'),
    loopsDir: path.join(wsRoot, 'loops'),
    ideasFile: path.join(wsRoot, 'inbox', 'ideas.md'),
    founderPackDir,
    voicePatternsFile: path.join(founderPackDir, 'voice_patterns.md'),
  }
}

// ── Lookup ───────────────────────────────────────────────────────────────────

export function getContentOwner(userId: number): ContentOwner | null {
  const row = getDb()
    .prepare('SELECT * FROM content_owners WHERE user_id = ? AND enabled = 1')
    .get(userId) as ContentOwner | undefined
  return row ?? null
}

export function listContentOwners(): ContentOwner[] {
  return getDb()
    .prepare('SELECT * FROM content_owners ORDER BY vault_workspace')
    .all() as ContentOwner[]
}

export function isContentOwner(userId: number): boolean {
  return getContentOwner(userId) !== null
}

// ── Granola credential (per owner) ───────────────────────────────────────────

/**
 * The owner's Granola key, or null. Reads the user-scoped secret first and only
 * falls back to the process env for the LEGACY single-tenant owner — Mike's key
 * predates this table and lives in Doppler as a global. A second owner never
 * inherits someone else's credential from the environment.
 */
export function getGranolaKey(owner: ContentOwner): string | null {
  const stored = getSecretValue(
    { scopeType: 'user', userId: owner.user_id }, GRANOLA_KEY_NAME, owner.user_id
  )
  if (stored) return stored
  if (owner.vault_workspace === (process.env.GRANOLA_WORKSPACE || 'operator')) {
    return process.env[GRANOLA_KEY_NAME] || null
  }
  return null
}

export interface ConnectionInfo {
  connected: boolean
  /** 'stored' = this owner pasted a key; 'env' = inherited legacy global. */
  source: 'stored' | 'env' | null
  updated_at: string | null
}

export function granolaConnection(owner: ContentOwner): ConnectionInfo {
  const summary = getSecret({ scopeType: 'user', userId: owner.user_id }, GRANOLA_KEY_NAME)
  if (summary) return { connected: true, source: 'stored', updated_at: summary.updatedAt }
  if (
    owner.vault_workspace === (process.env.GRANOLA_WORKSPACE || 'operator') &&
    process.env[GRANOLA_KEY_NAME]
  ) {
    return { connected: true, source: 'env', updated_at: null }
  }
  return { connected: false, source: null, updated_at: null }
}

export function setGranolaKey(owner: ContentOwner, value: string): void {
  setSecret({
    scope: { scopeType: 'user', userId: owner.user_id },
    key: GRANOLA_KEY_NAME,
    value,
    actorUserId: owner.user_id,
  })
}

export function clearGranolaKey(owner: ContentOwner): boolean {
  return deleteSecret({ scopeType: 'user', userId: owner.user_id }, GRANOLA_KEY_NAME, owner.user_id)
}

// ── Provisioning ─────────────────────────────────────────────────────────────

/**
 * Create the owner's four content stream directories (plus the ideas inbox) if
 * absent, chowned to the vault user so Claude sessions can write them. Idempotent.
 */
export function ensureVaultDirs(owner: ContentOwner): string[] {
  const p = ownerPaths(owner)
  const created: string[] = []
  for (const dir of [p.granolaDir, p.draftsDir, p.hooksDir, p.loopsDir, path.dirname(p.ideasFile)]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
      created.push(dir)
    }
    chownToVaultUser(dir)
  }
  if (!fs.existsSync(p.ideasFile)) {
    fs.writeFileSync(p.ideasFile, `# Ideas — ${owner.display_name || owner.vault_workspace}\n\n`, 'utf8')
    created.push(p.ideasFile)
  }
  chownToVaultUser(p.ideasFile)
  return created
}

/** The nightly objective this owner's routine spawns. */
export function routineTemplate(owner: ContentOwner): string {
  return JSON.stringify({
    title: `Granola content intake — ${owner.vault_workspace}`,
    description:
      `Read ${AI_WORKSPACE}/skills/granola-intake/SKILL.md and follow its process for\n` +
      `content owner "${owner.display_name || owner.vault_workspace}"\n` +
      `(vault workspace ${owner.vault_workspace}, founder pack ${owner.founder_slug}).\n\n` +
      `Pull recent Granola meeting transcripts (default lookback 14 days) using THIS OWNER'S\n` +
      `Granola API key — resolve it with scripts/owner-env.mjs, never a global env var.\n` +
      `For each NEW meeting write the content streams into\n` +
      `${VAULT_BASE}/workspaces/${owner.vault_workspace}/ exactly per the skill:\n` +
      `raw meeting note (content/granola/), LinkedIn draft(s) = the posting queue\n` +
      `(content/drafts/), short-form hooks (content/hooks/), ideas (inbox/ideas.md) and\n` +
      `open loops (loops/). Idempotency lives in content/granola/.processed.json.\n\n` +
      `Before drafting, run the voice-profile step: if the founder pack\n` +
      `skills/li-post-writer/references/founders/${owner.founder_slug}/voice_patterns.md is\n` +
      `missing or stale, build it from THIS owner's own speech in their transcripts first —\n` +
      `drafts written against a missing voice pack are the generic-AI failure mode.\n\n` +
      `HARD ISOLATION RULES: never read or write another owner's vault workspace, and never\n` +
      `read or write the granola_processed_meetings / granola_action_items DB tables (those\n` +
      `belong to the separate CC-146 meeting pipeline).`,
    agent_context: 'cto',
    workspace: 'operationkit',
    project: 'operationkit',
    category: 'content',
    completion_goal:
      `For every new Granola meeting in the lookback window, ${owner.vault_workspace}'s content ` +
      `streams are written (raw note, LinkedIn draft(s), hooks, ideas, loops), each draft is ` +
      `written against the ${owner.founder_slug} founder voice pack, and each meeting is ` +
      `recorded in the engine JSON processed store. No rows written to ` +
      `granola_processed_meetings or granola_action_items.`,
    workflow_hint: null,
    effort: 'normal',
    model: 'claude-opus-4-8',
    type: 'task',
  })
}

/**
 * Ensure the owner has their nightly routine row. Created DISABLED when the owner
 * has no Granola key yet (a routine that fires without a credential just burns a
 * session), and enabled on connect. Never rewrites an existing row's cron or
 * enabled flag — those are the owner's to change.
 */
export function ensureRoutine(owner: ContentOwner, enable: boolean): RoutineRow {
  const db = getDb()
  const existing = db
    .prepare('SELECT * FROM routines WHERE name = ?')
    .get(owner.routine_name) as RoutineRow | undefined
  if (existing) {
    if (enable && existing.enabled !== 1) {
      db.prepare('UPDATE routines SET enabled = 1 WHERE id = ?').run(existing.id)
      return { ...existing, enabled: 1 }
    }
    return existing
  }
  // Stagger owners across the 07:00 hour so two intakes never spawn in the same
  // minute; deterministic in user_id so a re-create lands on the same slot.
  const minute = 40 + ((owner.user_id * 7) % 20)
  db.prepare(
    `INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth)
     VALUES (?, ?, ?, ?, 1)`
  ).run(owner.routine_name, `${minute} 7 * * *`, routineTemplate(owner), enable ? 1 : 0)
  return db.prepare('SELECT * FROM routines WHERE name = ?').get(owner.routine_name) as RoutineRow
}

export function ensureFounderPackDir(owner: ContentOwner): void {
  const p = ownerPaths(owner)
  if (!fs.existsSync(p.founderPackDir)) fs.mkdirSync(p.founderPackDir, { recursive: true })
  chownToVaultUser(p.founderPackDir)
}

/** True once the owner's voice pack exists — i.e. drafts will sound like them. */
export function voiceProfileReady(owner: ContentOwner): boolean {
  try {
    return fs.statSync(ownerPaths(owner).voicePatternsFile).size > 0
  } catch {
    return false
  }
}
