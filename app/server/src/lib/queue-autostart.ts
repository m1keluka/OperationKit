/**
 * Queue auto-start (obj 900625) — the PURE half: settings, candidate selection,
 * the per-card start-request flag, the hold / blocked_by fields and the card view.
 * Only touches the DB handle it is given, so the routes (create, status, CRUD,
 * progress, admin) can import it without pulling the session-manager / seat chain
 * into their import graph. The tick that actually starts sessions lives in
 * services/queue-autostart.ts, which re-exports everything here.
 */
import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'

// ── Settings keys ────────────────────────────────────────────────────────────

export const WORKSPACES_KEY = 'queue_autostart_workspaces'
export const ENABLED_AT_PREFIX = 'queue_autostart_enabled_at:'
export const MAX_CONCURRENT_KEY = 'queue_autostart_max_concurrent'
export const DEFAULT_MAX_CONCURRENT = 4
export const DEFAULT_GRACE_MINUTES = 1
export const AUDIT_PATHWAY = 'queue-autostart'
export const START_REASON = 'queue_autostart'

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

function readSetting(db: Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function writeSetting(db: Database, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Comma list → unique, valid workspace slugs (anything else is dropped). */
export function parseWorkspaceList(raw: string | null | undefined): string[] {
  const out: string[] = []
  for (const part of String(raw ?? '').split(',')) {
    const slug = part.trim()
    if (slug && SLUG_RE.test(slug) && !out.includes(slug)) out.push(slug)
  }
  return out
}

export interface EnabledWorkspace {
  workspace: string
  /** `setting` — the admin toggle; `env` — CC_QUEUE_AUTOSTART_WORKSPACES (not toggleable in the UI). */
  source: 'setting' | 'env' | 'setting+env'
  /** SQLite UTC datetime the workspace was switched on — the backlog cutoff. */
  enabledAt: string
}

/**
 * Workspaces with queue auto-start ON: the union of the setting and the env list.
 * Each needs an `enabled_at`; one turned on outside the admin toggle (env, or a
 * hand-edited setting) gets it stamped the first time it is seen, so the cutoff is
 * "when this server first saw it on" — never the beginning of time.
 */
export function resolveEnabledWorkspaces(db: Database, env: NodeJS.ProcessEnv = process.env): EnabledWorkspace[] {
  const fromSetting = parseWorkspaceList(readSetting(db, WORKSPACES_KEY))
  const fromEnv = parseWorkspaceList(env.CC_QUEUE_AUTOSTART_WORKSPACES)
  const all = [...fromSetting, ...fromEnv.filter(w => !fromSetting.includes(w))]
  const out: EnabledWorkspace[] = []
  for (const workspace of all) {
    const key = ENABLED_AT_PREFIX + workspace
    let enabledAt = readSetting(db, key)
    if (!enabledAt) {
      try {
        db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, datetime('now'))").run(key)
      } catch { /* read-only DB: fall through to "now" below */ }
      enabledAt = readSetting(db, key) ?? (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t
    }
    const inSetting = fromSetting.includes(workspace)
    const inEnv = fromEnv.includes(workspace)
    out.push({ workspace, source: inSetting && inEnv ? 'setting+env' : inSetting ? 'setting' : 'env', enabledAt })
  }
  return out
}

/**
 * Admin toggle. Enabling (re)stamps `enabled_at` to now — a workspace switched off
 * and back on must not sweep up the cards that piled up while it was off. Disabling
 * removes it from the setting (an env-listed workspace stays on; the caller says so).
 */
export function setQueueAutostartWorkspace(db: Database, workspace: string, enabled: boolean): string[] {
  if (!SLUG_RE.test(workspace)) throw new Error(`invalid workspace slug '${workspace}'`)
  const current = parseWorkspaceList(readSetting(db, WORKSPACES_KEY))
  const next = enabled ? (current.includes(workspace) ? current : [...current, workspace]) : current.filter(w => w !== workspace)
  const tx = db.transaction(() => {
    writeSetting(db, WORKSPACES_KEY, next.join(','))
    if (enabled && !current.includes(workspace)) {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(ENABLED_AT_PREFIX + workspace)
    } else if (!enabled) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(ENABLED_AT_PREFIX + workspace)
    }
  })
  tx()
  return next
}

function positiveInt(raw: string | null | undefined): number | null {
  if (raw == null || String(raw).trim() === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** In-flight cap for auto-started cards: env → setting → 4. */
export function queueAutostartMaxConcurrent(db: Database, env: NodeJS.ProcessEnv = process.env): { value: number; source: string } {
  const fromEnv = positiveInt(env.CC_QUEUE_AUTOSTART_MAX_CONCURRENT)
  if (fromEnv) return { value: fromEnv, source: 'env:CC_QUEUE_AUTOSTART_MAX_CONCURRENT' }
  const fromSetting = positiveInt(readSetting(db, MAX_CONCURRENT_KEY))
  if (fromSetting) return { value: fromSetting, source: `settings.${MAX_CONCURRENT_KEY}` }
  return { value: DEFAULT_MAX_CONCURRENT, source: 'default' }
}

/** Minutes a never-requested card sits in queue before it is eligible (lets a human hold/cancel a fresh card). */
export function queueAutostartGraceMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CC_QUEUE_AUTOSTART_GRACE_MIN
  if (raw != null && raw.trim() !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= 0) return n
  }
  return DEFAULT_GRACE_MINUTES
}

// ── Selection (pure SQL, unit-tested without spawning) ───────────────────────

/**
 * Candidates in the enabled workspaces, oldest queue entry first. Every guard is
 * in the query; the tick adds only the live gates (cap, seat, ceiling, twin).
 */
export function selectQueueAutostartCandidates(
  db: Database,
  enabled: Array<Pick<EnabledWorkspace, 'workspace' | 'enabledAt'>>,
  opts: { graceMinutes?: number } = {},
): Objective[] {
  if (enabled.length === 0) return []
  const grace = Math.max(0, opts.graceMinutes ?? DEFAULT_GRACE_MINUTES)
  const perWorkspace = enabled
    .map(
      () => `(o.workspace = ? AND (
          o.auto_start_requested_at IS NOT NULL
          OR (o.session_count = 0
              AND datetime(COALESCE(o.queued_at, o.created_at)) >= datetime(?)
              AND datetime(COALESCE(o.queued_at, o.created_at)) <= datetime('now', ?))
        ))`,
    )
    .join(' OR ')
  const params: unknown[] = []
  for (const w of enabled) params.push(w.workspace, w.enabledAt, `-${grace * 60} seconds`)
  return db
    .prepare(
      `SELECT o.* FROM objectives o
        WHERE o.status = 'queue'
          AND o.parent_id IS NULL
          AND o.deleted_at IS NULL
          AND o.type IN ('task', 'bug')
          AND COALESCE(o.is_strategy, 0) = 0
          AND o.title NOT LIKE '[Review]%'
          AND (o.queue_hold IS NULL OR trim(o.queue_hold) = '')
          AND (o.blocked_by IS NULL
               OR EXISTS (SELECT 1 FROM objectives b WHERE b.id = o.blocked_by AND b.status = 'done'))
          AND (${perWorkspace})
        ORDER BY datetime(COALESCE(o.queued_at, o.created_at)) ASC, o.id ASC`,
    )
    .all(...params) as Objective[]
}

/** Cards the auto-starter launched that still hold a running session. */
export function countAutostartedInFlight(db: Database): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM objectives WHERE status IN ('working', 'ai_review') AND autostarted_at IS NOT NULL")
      .get() as { n: number }
  ).n
}

/**
 * The per-card "auto-start" flag. Called by the start paths that hit the session
 * cap (create `start:true`, PATCH status=working / start_objective) so the card
 * flows automatically once a slot frees. Only a QUEUED card is flagged; the flag is
 * cleared by trigger when the card leaves queue. Returns whether the card's
 * workspace currently has queue auto-start on (the caller tells the requester).
 */
export function markAutoStartRequested(db: Database, id: number, env: NodeJS.ProcessEnv = process.env): { flagged: boolean; workspaceEnabled: boolean } {
  try {
    const info = db
      .prepare("UPDATE objectives SET auto_start_requested_at = COALESCE(auto_start_requested_at, datetime('now')) WHERE id = ? AND status = 'queue'")
      .run(id)
    const row = db.prepare('SELECT workspace FROM objectives WHERE id = ?').get(id) as { workspace: string } | undefined
    const enabled = row ? isQueueAutostartEnabledFor(db, row.workspace, env) : false
    return { flagged: info.changes > 0, workspaceEnabled: enabled }
  } catch (err) {
    console.warn(`[queue-autostart] could not flag #${id} for auto-start:`, (err as Error).message)
    return { flagged: false, workspaceEnabled: false }
  }
}

export function isQueueAutostartEnabledFor(db: Database, workspace: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!workspace) return false
  return (
    parseWorkspaceList(readSetting(db, WORKSPACES_KEY)).includes(workspace) ||
    parseWorkspaceList(env.CC_QUEUE_AUTOSTART_WORKSPACES).includes(workspace)
  )
}

/** Card-level view for get_progress: is it on for this workspace, and what is the card waiting on. */
export interface QueueAutostartCardView {
  workspace_enabled: boolean
  requested_at: string | null
  hold: string | null
  blocked_by: number | null
  note: string | null
  autostarted_at: string | null
}

export function queueAutostartCardView(db: Database, obj: Objective, env: NodeJS.ProcessEnv = process.env): QueueAutostartCardView {
  const r = obj as unknown as Record<string, unknown>
  return {
    workspace_enabled: isQueueAutostartEnabledFor(db, obj.workspace, env),
    requested_at: (r.auto_start_requested_at as string | null | undefined) ?? null,
    hold: (r.queue_hold as string | null | undefined) ?? null,
    blocked_by: (r.blocked_by as number | null | undefined) ?? null,
    note: (r.auto_start_note as string | null | undefined) ?? null,
    autostarted_at: (r.autostarted_at as string | null | undefined) ?? null,
  }
}

// ── Hold / blocked_by fields (create + update) ───────────────────────────────

export interface QueueHoldPatch {
  ok: boolean
  /** True when the body carried queue_hold or blocked_by at all. */
  touched: boolean
  /** undefined = unchanged, null = clear. */
  queueHold?: string | null
  blockedBy?: number | null
  error?: string
}

export const QUEUE_HOLD_MAX = 500

/**
 * Validate the optional `queue_hold` / `blocked_by` fields BEFORE any write.
 *  - `queue_hold`: a reason string (≤ 500 chars) holds the card; null or "" clears.
 *  - `blocked_by`: id of a card in the SAME workspace this one waits on (skipped
 *    until that card is `done`); null clears. A missing card and a card in another
 *    workspace get the same error, so the field cannot probe other workspaces.
 */
export function parseQueueHoldPatch(
  db: Database,
  body: Record<string, unknown>,
  ctx: { selfId: number | null; workspace: string },
): QueueHoldPatch {
  const hasHold = Object.prototype.hasOwnProperty.call(body, 'queue_hold')
  const hasBlocked = Object.prototype.hasOwnProperty.call(body, 'blocked_by')
  const out: QueueHoldPatch = { ok: true, touched: hasHold || hasBlocked }
  if (hasHold) {
    const v = body.queue_hold
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) out.queueHold = null
    else if (typeof v === 'string') {
      if (v.trim().length > QUEUE_HOLD_MAX) return { ok: false, touched: true, error: `queue_hold must be at most ${QUEUE_HOLD_MAX} characters` }
      out.queueHold = v.trim()
    } else if (v === true) out.queueHold = 'held'
    else if (v === false) out.queueHold = null
    else return { ok: false, touched: true, error: 'queue_hold must be a string reason, true/false, or null' }
  }
  if (hasBlocked) {
    const v = body.blocked_by
    if (v === null || v === undefined || v === '') out.blockedBy = null
    else {
      const n = Number(v)
      if (!Number.isInteger(n) || n <= 0) return { ok: false, touched: true, error: 'blocked_by must be a card id (positive integer) or null' }
      if (ctx.selfId != null && n === ctx.selfId) return { ok: false, touched: true, error: 'blocked_by cannot point at the card itself' }
      const row = db.prepare('SELECT workspace FROM objectives WHERE id = ? AND deleted_at IS NULL').get(n) as { workspace: string } | undefined
      if (!row || row.workspace !== ctx.workspace) {
        return { ok: false, touched: true, error: `blocked_by #${n} is not a card in workspace '${ctx.workspace}'` }
      }
      out.blockedBy = n
    }
  }
  return out
}

export function applyQueueHoldPatch(db: Database, id: number, patch: QueueHoldPatch): void {
  if (!patch.ok || !patch.touched) return
  if (patch.queueHold !== undefined) db.prepare('UPDATE objectives SET queue_hold = ? WHERE id = ?').run(patch.queueHold, id)
  if (patch.blockedBy !== undefined) db.prepare('UPDATE objectives SET blocked_by = ? WHERE id = ?').run(patch.blockedBy, id)
}
