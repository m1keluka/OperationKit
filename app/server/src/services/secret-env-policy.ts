/**
 * Session secret-env policy — Sprint 6b, decision D4 (obj 900540).
 *
 * Operator's decision (2026-11-10): "allowlist only, with logging migration".
 *   - A session's environment gets only the Secrets-store keys allowlisted for
 *     its agent profile or its skills. Everything else stays reachable through
 *     the secrets broker (`{{secret:NAME}}`), which uses a value without
 *     handing it to the agent.
 *   - MIGRATION mode (the default for every existing install) still passes
 *     today's full set, and logs which NON-allowlisted names each session
 *     actually referenced, so an operator can build allowlists from evidence.
 *   - ENFORCE mode passes only allowlisted keys and keeps logging references to
 *     withheld names, so a missing allowlist entry shows up instead of failing
 *     silently.
 *   - Review: `tsx server/src/scripts/secrets-env-allowlist.ts report`, or
 *     GET /api/secrets/env-policy. Switch: `… mode enforce` or
 *     PUT /api/secrets/env-policy/mode. Both are audited.
 *
 * Scope of the filter: ONLY keys resolved from the Secrets store. Identity env
 * the server builds itself (GitHub / Google connector tokens, CC_SESSION_TOKEN,
 * git identity) is governed by the connector rules, not by this allowlist.
 *
 * What "referenced" means: the session's own tool calls (Bash commands, file
 * writes, script bodies…) mention the name as an environment read — `$NAME`,
 * `${NAME}`, `process.env.NAME`, `os.environ["NAME"]`, `getenv("NAME")`,
 * `ENV["NAME"]`. A program that reads the variable internally without the
 * agent ever writing its name is not seen; enforce mode's withheld log is the
 * backstop for those.
 *
 * Nothing here ever reads, logs or returns a secret VALUE — names and counts only.
 */
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { logAccess, resolveSecretNames } from './secrets-store.js'
import { resolveAvailable } from './resource-assignments.js'

export type SessionEnvMode = 'migration' | 'enforce'
export const SESSION_ENV_MODES: readonly SessionEnvMode[] = ['migration', 'enforce'] as const
export const SESSION_ENV_MODE_SETTING = 'secrets_session_env_mode'
export const SESSION_ENV_MODE_ENV = 'CC_SECRETS_SESSION_ENV_MODE'
/** Agent subject that applies to every session (a baseline allowlist). */
export const ALL_AGENTS = '*'

export type AllowlistSubjectType = 'agent' | 'skill'

export function isSessionEnvMode(v: unknown): v is SessionEnvMode {
  return v === 'migration' || v === 'enforce'
}

/**
 * Current mode. Env `CC_SECRETS_SESSION_ENV_MODE` wins (an operator override that
 * survives a DB restore); otherwise the settings row; a missing row, missing
 * table or DB error reads as 'migration' — today's behaviour, plus logging.
 */
export function getSessionEnvMode(db?: Database.Database, env: NodeJS.ProcessEnv = process.env): SessionEnvMode {
  const override = env[SESSION_ENV_MODE_ENV]?.trim()
  if (isSessionEnvMode(override)) return override
  try {
    const row = (db ?? getDb()).prepare('SELECT value FROM settings WHERE key = ?').get(SESSION_ENV_MODE_SETTING) as
      | { value: string }
      | undefined
    return isSessionEnvMode(row?.value) ? row!.value as SessionEnvMode : 'migration'
  } catch {
    return 'migration'
  }
}

/** Switch the mode. Audited in secret_access_log (action env_policy). */
export function setSessionEnvMode(mode: SessionEnvMode, actorUserId: number | null, source = 'policy'): void {
  if (!isSessionEnvMode(mode)) throw new Error(`mode must be one of ${SESSION_ENV_MODES.join(', ')}`)
  const db = getDb()
  const before = getSessionEnvMode(db, {})
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SESSION_ENV_MODE_SETTING, mode)
  logAccess(actorUserId, 'env_policy', 'global', '*', { source, detail: `mode:${before}->${mode}` })
}

/**
 * Fresh installs start in enforce mode; existing installs keep migration. Only
 * writes when no row exists AND the store is empty, so re-running the installer
 * on a live install never flips it. Returns the mode now in effect.
 */
export function initSessionEnvModeForFreshInstall(db: Database.Database = getDb()): SessionEnvMode {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SESSION_ENV_MODE_SETTING)
  if (!row) {
    const secrets = (db.prepare('SELECT COUNT(*) AS n FROM secrets').get() as { n: number }).n
    if (secrets === 0) {
      db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(SESSION_ENV_MODE_SETTING, 'enforce')
    }
  }
  return getSessionEnvMode(db, {})
}

// ── Allowlist ────────────────────────────────────────────────────────────────

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const SUBJECT_RE = /^(\*|[A-Za-z0-9][A-Za-z0-9._/-]{0,127})$/

export interface AllowlistEntry {
  id: number
  subjectType: AllowlistSubjectType
  subject: string
  key: string
  createdBy: number | null
  createdAt: string
}

function validateEntry(subjectType: string, subject: string, key: string): void {
  if (subjectType !== 'agent' && subjectType !== 'skill') throw new Error("subjectType must be 'agent' or 'skill'")
  if (!SUBJECT_RE.test(subject)) throw new Error('subject must be an agent/skill slug, or * for every agent')
  if (subjectType === 'skill' && subject === ALL_AGENTS) throw new Error("use subjectType 'agent' with subject '*' for a baseline")
  if (!KEY_RE.test(key)) throw new Error('key must be an environment variable name')
}

export function listAllowlist(db: Database.Database = getDb()): AllowlistEntry[] {
  return (
    db.prepare('SELECT * FROM secret_env_allowlist ORDER BY subject_type, subject, key').all() as {
      id: number; subject_type: AllowlistSubjectType; subject: string; key: string; created_by: number | null; created_at: string
    }[]
  ).map(r => ({ id: r.id, subjectType: r.subject_type, subject: r.subject, key: r.key, createdBy: r.created_by, createdAt: r.created_at }))
}

/** Add one name. Idempotent. Audited. Returns true when a row was added. */
export function addAllowlistEntry(subjectType: AllowlistSubjectType, subject: string, key: string, actorUserId: number | null, source = 'policy'): boolean {
  validateEntry(subjectType, subject, key)
  const r = getDb()
    .prepare('INSERT OR IGNORE INTO secret_env_allowlist (subject_type, subject, key, created_by) VALUES (?, ?, ?, ?)')
    .run(subjectType, subject, key, actorUserId)
  if (r.changes > 0) logAccess(actorUserId, 'env_policy', 'global', key, { source, detail: `allow:${subjectType}:${subject}` })
  return r.changes > 0
}

/** Remove one name. Audited. Returns true when a row was removed. */
export function removeAllowlistEntry(subjectType: AllowlistSubjectType, subject: string, key: string, actorUserId: number | null, source = 'policy'): boolean {
  validateEntry(subjectType, subject, key)
  const r = getDb()
    .prepare('DELETE FROM secret_env_allowlist WHERE subject_type = ? AND subject = ? AND key = ?')
    .run(subjectType, subject, key)
  if (r.changes > 0) logAccess(actorUserId, 'env_policy', 'global', key, { source, detail: `disallow:${subjectType}:${subject}` })
  return r.changes > 0
}

export interface SessionSubjects {
  agent: string
  /** Skills this session may use. null = unrestricted (every skill's list applies). */
  skills: string[] | null
}

/** The agent profile and skills a session runs with, for allowlist matching. */
export function sessionSubjects(
  objective: Pick<Objective, 'agent_context' | 'workspace' | 'project'> & { assigned_user_id?: number | null; created_by?: number | null },
  userId: number | null,
): SessionSubjects {
  const agent = String(objective.agent_context || 'general')
  let skills: string[] | null = null
  try {
    const avail = resolveAvailable('skill', {
      workspace: objective.workspace || '',
      project: objective.project ?? null,
      userId,
    })
    skills = avail.restricted ? avail.allowed : null
  } catch {
    skills = null
  }
  return { agent, skills }
}

/** Names a session with these subjects is allowed to hold in its env. */
export function allowlistedKeys(subjects: SessionSubjects, db: Database.Database = getDb()): Set<string> {
  const out = new Set<string>()
  let rows: { subject_type: string; subject: string; key: string }[] = []
  try {
    rows = db.prepare('SELECT subject_type, subject, key FROM secret_env_allowlist').all() as typeof rows
  } catch {
    return out
  }
  const skillSet = subjects.skills ? new Set(subjects.skills) : null
  for (const r of rows) {
    if (r.subject_type === 'agent' && (r.subject === ALL_AGENTS || r.subject === subjects.agent)) out.add(r.key)
    else if (r.subject_type === 'skill' && (skillSet === null || skillSet.has(r.subject))) out.add(r.key)
  }
  return out
}

/**
 * The key filter buildSpawnEnv hands to resolveSecrets. Migration = keep every
 * key (today's set); enforce = keep only allowlisted keys.
 */
export function sessionKeyFilter(mode: SessionEnvMode, allowed: Set<string>): ((key: string) => boolean) | undefined {
  return mode === 'enforce' ? (key: string) => allowed.has(key) : undefined
}

// ── Usage detection (the migration log) ─────────────────────────────────────

// An environment READ of NAME, as an agent writes it in a tool call.
const ENV_REF_RE =
  /(?:\$\{?|process\.env\.|process\.env\[\s*["'`]|os\.environ(?:\.get)?\s*[[(]\s*["']|getenv\(\s*["']|ENV\[\s*["']|env::var\(\s*")([A-Za-z_][A-Za-z0-9_]*)/g

/** Every string leaf of a tool_use input, joined. */
function stringLeaves(v: unknown, out: string[], depth = 0): void {
  if (depth > 8) return
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out, depth + 1)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringLeaves(x, out, depth + 1)
}

/**
 * Count environment references to `candidates` in a session transcript (Claude
 * stream-json lines). Only the assistant's own tool_use inputs are scanned —
 * not tool OUTPUT, so a name that merely appears in a file the agent read does
 * not count as a use.
 */
export function findEnvReferences(transcript: string, candidates: Set<string>): Map<string, number> {
  const counts = new Map<string, number>()
  if (candidates.size === 0) return counts
  for (const line of transcript.split('\n')) {
    const t = line.trim()
    if (!t || !t.includes('tool_use')) continue
    let obj: { type?: string; message?: { content?: unknown } }
    try {
      obj = JSON.parse(t)
    } catch {
      continue
    }
    if (obj.type !== 'assistant' || !Array.isArray(obj.message?.content)) continue
    for (const block of obj.message!.content as { type?: string; input?: unknown }[]) {
      if (block?.type !== 'tool_use') continue
      const leaves: string[] = []
      stringLeaves(block.input, leaves)
      for (const text of leaves) {
        for (const m of text.matchAll(ENV_REF_RE)) {
          const name = m[1]!
          if (candidates.has(name)) counts.set(name, (counts.get(name) ?? 0) + 1)
        }
      }
    }
  }
  return counts
}

export interface UsageRecordInput {
  objectiveId: number | null
  sessionId: string
  workspace: string
  agent: string
  mode: SessionEnvMode
  counts: Map<string, number>
}

/** Upsert the per-(session, key) rows. Idempotent across repeat scans of one session. */
export function recordEnvUsage(input: UsageRecordInput, db: Database.Database = getDb()): number {
  const stmt = db.prepare(
    `INSERT INTO secret_env_usage (objective_id, session_id, workspace, agent, key, mode, uses)
     VALUES (@objectiveId, @sessionId, @workspace, @agent, @key, @mode, @uses)
     ON CONFLICT(session_id, key) DO UPDATE SET
       uses = MAX(secret_env_usage.uses, excluded.uses),
       mode = excluded.mode,
       last_seen_at = datetime('now')`,
  )
  let n = 0
  const tx = db.transaction(() => {
    for (const [key, uses] of input.counts) {
      stmt.run({ objectiveId: input.objectiveId, sessionId: input.sessionId, workspace: input.workspace, agent: input.agent, key, mode: input.mode, uses })
      n++
    }
  })
  tx()
  return n
}

/**
 * Session-end hook (called from scanStreamTelemetry). Works out which store
 * names this session held (or would have held) WITHOUT being allowlisted, finds
 * the ones its tool calls referenced, and logs them. Never throws.
 */
export function recordSessionEnvUsageFromTranscript(objectiveId: number, sessionId: string, transcript: string): number {
  try {
    const db = getDb()
    const o = db
      .prepare('SELECT id, workspace, project, agent_context, assigned_user_id, created_by FROM objectives WHERE id = ?')
      .get(objectiveId) as
      | { id: number; workspace: string | null; project: string | null; agent_context: string | null; assigned_user_id: number | null; created_by: number | null }
      | undefined
    if (!o) return 0
    const userId =
      typeof o.assigned_user_id === 'number' && o.assigned_user_id > 0
        ? o.assigned_user_id
        : typeof o.created_by === 'number' && o.created_by > 0
          ? o.created_by
          : null
    const workspace = o.workspace || ''
    const subjects = sessionSubjects(
      { agent_context: (o.agent_context || 'general') as Objective['agent_context'], workspace, project: o.project ?? '' },
      userId,
    )
    const allowed = allowlistedKeys(subjects, db)
    const candidates = new Set(resolveSecretNames({ workspace: workspace || null, userId }).filter(k => !allowed.has(k)))
    const counts = findEnvReferences(transcript, candidates)
    if (counts.size === 0) return 0
    const mode = getSessionEnvMode(db)
    return recordEnvUsage({ objectiveId, sessionId, workspace, agent: subjects.agent, mode, counts }, db)
  } catch (err) {
    console.warn(`[secret-env-policy] usage scan failed for objective ${objectiveId}:`, (err as Error).message)
    return 0
  }
}

// ── Review ──────────────────────────────────────────────────────────────────

export interface UsageReportRow {
  agent: string
  key: string
  sessions: number
  uses: number
  lastSeenAt: string
  /** Sessions where the key was withheld (enforce mode) but referenced anyway. */
  withheldSessions: number
}

export interface UsageReport {
  mode: SessionEnvMode
  sinceDays: number
  rows: UsageReportRow[]
  /** agent → keys to allowlist, from the rows (min-session threshold applied). */
  suggestions: Record<string, string[]>
}

/** Aggregate the migration log per (agent, key) over the last `sinceDays`. */
export function envUsageReport(opts: { sinceDays?: number; minSessions?: number } = {}, db: Database.Database = getDb()): UsageReport {
  const sinceDays = Math.max(1, Math.min(3650, Math.floor(opts.sinceDays ?? 30)))
  const minSessions = Math.max(1, Math.floor(opts.minSessions ?? 1))
  const rows = db
    .prepare(
      `SELECT agent, key,
              COUNT(DISTINCT session_id) AS sessions,
              SUM(uses) AS uses,
              MAX(last_seen_at) AS last_seen_at,
              COUNT(DISTINCT CASE WHEN mode = 'enforce' THEN session_id END) AS withheld_sessions
         FROM secret_env_usage
        WHERE last_seen_at >= datetime('now', ?)
        GROUP BY agent, key
        ORDER BY agent, sessions DESC, key`,
    )
    .all(`-${sinceDays} days`) as { agent: string; key: string; sessions: number; uses: number; last_seen_at: string; withheld_sessions: number }[]
  const suggestions: Record<string, string[]> = {}
  for (const r of rows) {
    if (r.sessions < minSessions) continue
    ;(suggestions[r.agent] ??= []).push(r.key)
  }
  return {
    mode: getSessionEnvMode(db),
    sinceDays,
    rows: rows.map(r => ({ agent: r.agent, key: r.key, sessions: r.sessions, uses: r.uses, lastSeenAt: r.last_seen_at, withheldSessions: r.withheld_sessions })),
    suggestions,
  }
}
