/**
 * Stall watchdog (obj 900372) — a card in `working` whose session does nothing.
 *
 * Incident: #900228 (your-org) sat in `working` from ~09:33 to ~10:12 ET on
 * 2026-11-09 with no steps, output or commits until a human restarted it. The bots
 * watching it had no signal. Root cause write-up:
 * docs/incidents/2026-11-09-900228-working-stall.md. In short, `getSessionState`
 * reports `working` for as long as the tmux session / jail container exists and the
 * transcript's last typed event is not a `result` — so a process that spawned and
 * then hung before (or between) model events is indistinguishable from a busy one.
 * The only existing nets were a 30-min websocket-only `session_stuck` broadcast
 * (no DB row, no bot wake) and the 90-min idle force-route to review, and
 * `objectives.last_activity_at` only moved when a session ENDED, so it could not
 * show a stall to anyone reading the API.
 *
 * What this module adds, all on one 60s tick inside the state poller:
 *
 *  1. A LIVE heartbeat: `last_activity_at` advances (forward-only, ISO) to the
 *     transcript's last write for every working card, so a bot can see "nothing
 *     happened for 25 min" in a single get_objective / list_objectives read.
 *  2. Detection: a working card is STALLED when, for N minutes (setting
 *     `stall_watchdog_minutes`, default 10):
 *       - never_spawned      it has no session id, or no process and no CLI event ever;
 *       - died_silently      its process is gone but the card is still `working`;
 *       - hung_startup       its process is alive but has written no CLI event since spawn;
 *       - hung_no_heartbeat  its process is alive, had output, and has written nothing since.
 *     A tool call in flight (an assistant tool_use with no tool_result yet) gets the
 *     longer `stall_watchdog_inflight_minutes` (default 30) so a long build or test
 *     run is not mistaken for a hang. Cards with pending background work
 *     (ScheduleWakeup / async Agent / Monitor), a scheduled 529 retry, an arena
 *     cohort, or `delegate_mode` are exempt — their idleness is by design.
 *  3. ONE automatic restart per stall episode, with a recorded reason
 *     (`session_starts.reason = 'stall_watchdog'`, an activity_log milestone and
 *     `objectives.stall_restarts`). The counter only resets when something OTHER
 *     than the watchdog starts the card (a human, a bot, a follow-up) — so
 *     restart → stall → restart can never loop.
 *  4. On the next stall (or if the restart itself fails) the card is FLAGGED:
 *     `stalled_at` + `stall_reason` are set (→ `objective_events` kind `stalled` via
 *     trigger → GET /api/agent/changes + a `needs_agent` webhook of kind `stalled`
 *     to the owner bot / General), a high-severity alert lands in the
 *     AlertBell, and an activity_log row records it. The hung process is left
 *     running for inspection; the existing 90-min force-route still applies.
 *
 * Kill switch: `settings.stall_watchdog_enabled = '0'`. Restart-off (flag only):
 * `settings.stall_watchdog_max_restarts = '0'`. Env `CC_STALL_WATCHDOG_MINUTES`
 * wins over the setting for the threshold. All settings are read at point of use.
 */
import fs from 'fs'
import path from 'path'
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'

// ── Config ───────────────────────────────────────────────────────────────────

export const STALL_START_REASON = 'stall_watchdog'
export const DEFAULT_STALL_MINUTES = 10
export const DEFAULT_INFLIGHT_MINUTES = 30
export const DEFAULT_MAX_AUTO_RESTARTS = 1
export const STALL_TICK_INTERVAL_MS = 60_000

export interface StallConfig {
  enabled: boolean
  thresholdMs: number
  inflightThresholdMs: number
  maxAutoRestarts: number
}

function readSetting(db: Database.Database, key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  } catch {
    return undefined
  }
}

function positiveNumber(raw: string | undefined, fallback: number, allowZero = false): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  if (n < 0 || (!allowZero && n === 0)) return fallback
  return n
}

/** Settings are read on every tick, so a change needs no restart. */
export function resolveStallConfig(db: Database.Database, env: NodeJS.ProcessEnv = process.env): StallConfig {
  const minutes = positiveNumber(env.CC_STALL_WATCHDOG_MINUTES ?? readSetting(db, 'stall_watchdog_minutes'), DEFAULT_STALL_MINUTES)
  const inflight = positiveNumber(readSetting(db, 'stall_watchdog_inflight_minutes'), DEFAULT_INFLIGHT_MINUTES)
  const maxRestarts = Math.floor(positiveNumber(readSetting(db, 'stall_watchdog_max_restarts'), DEFAULT_MAX_AUTO_RESTARTS, true))
  return {
    enabled: readSetting(db, 'stall_watchdog_enabled') !== '0',
    thresholdMs: minutes * 60_000,
    inflightThresholdMs: Math.max(inflight, minutes) * 60_000,
    // Hard ceiling: the brief is "restart once". A setting can turn restarts off
    // (0) but can never turn the watchdog into a restart loop.
    maxAutoRestarts: Math.min(maxRestarts, DEFAULT_MAX_AUTO_RESTARTS),
  }
}

// ── Transcript probe ─────────────────────────────────────────────────────────

/** Lines the SERVER writes into a transcript — not evidence the CLI did anything. */
const SERVER_LINE_TYPES = new Set(['prompt', 'followup', 'warning', 'error', 'chain_reset', 'system_note'])
/** Server lines that open a new spawn segment. */
const SEGMENT_MARKERS = new Set(['prompt', 'followup'])

export type StallPhase = 'no_cli_output' | 'init_only' | 'model_active'

export interface TranscriptProbe {
  exists: boolean
  /** mtime of the transcript (any write = heartbeat), epoch ms. */
  lastWriteMs: number | null
  /** Typed CLI events after the last spawn-segment marker. */
  cliEventsSinceSpawn: number
  phase: StallPhase
  /** The newest CLI step is a tool_use with no tool_result yet. */
  toolInFlight: boolean
}

const EMPTY_PROBE: TranscriptProbe = { exists: false, lastWriteMs: null, cliEventsSinceSpawn: 0, phase: 'no_cli_output', toolInFlight: false }

function contentHas(msg: unknown, blockType: string): boolean {
  const content = (msg as { content?: unknown } | undefined)?.content
  return Array.isArray(content) && content.some(b => (b as { type?: string } | null)?.type === blockType)
}

/**
 * Pure: classify transcript lines (oldest → newest). Exported for tests.
 * The segment starts after the LAST `prompt` / `followup` line, which the server
 * writes at every spawn/respawn; a tail that cut the marker off counts everything.
 */
export function analyzeTranscriptLines(lines: string[]): Omit<TranscriptProbe, 'exists' | 'lastWriteMs'> {
  const events: Array<Record<string, unknown>> = []
  for (const raw of lines) {
    const t = raw.trim()
    if (!t) continue
    let ev: Record<string, unknown>
    try { ev = JSON.parse(t) } catch { continue }
    const type = typeof ev.type === 'string' ? ev.type : ''
    if (!type) continue
    if (SEGMENT_MARKERS.has(type)) { events.length = 0; continue }
    if (SERVER_LINE_TYPES.has(type)) continue
    events.push(ev)
  }
  let modelActive = false
  for (const ev of events) {
    if (ev.type !== 'system') { modelActive = true; break }
  }
  let toolInFlight = false
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'stream_event' || ev.type === 'system' || ev.type === 'rate_limit_event') continue
    if (ev.type === 'assistant') { toolInFlight = contentHas(ev.message, 'tool_use'); break }
    // user (tool_result), result, or any engine-specific step → nothing pending
    break
  }
  return {
    cliEventsSinceSpawn: events.length,
    phase: events.length === 0 ? 'no_cli_output' : modelActive ? 'model_active' : 'init_only',
    toolInFlight,
  }
}

const PROBE_TAIL_BYTES = 256_000

/** Real I/O: stat + tail-read a transcript. Never throws. */
export function probeTranscript(jsonlPath: string | null): TranscriptProbe {
  if (!jsonlPath) return EMPTY_PROBE
  let st: fs.Stats
  try { st = fs.statSync(jsonlPath) } catch { return EMPTY_PROBE }
  let lines: string[] = []
  try {
    const fd = fs.openSync(jsonlPath, 'r')
    try {
      const start = Math.max(0, st.size - PROBE_TAIL_BYTES)
      const buf = Buffer.alloc(st.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      lines = buf.toString('utf-8').split('\n')
    } finally {
      fs.closeSync(fd)
    }
  } catch { /* unreadable → treat as no CLI output */ }
  return { exists: true, lastWriteMs: st.mtimeMs, ...analyzeTranscriptLines(lines) }
}

// ── Decision (pure) ──────────────────────────────────────────────────────────

export type StallClass = 'never_spawned' | 'died_silently' | 'hung_startup' | 'hung_no_heartbeat'

export interface StallInput {
  sessionId: string | null
  /** Process (tmux / jail) is up. Ignored when sessionId is null. */
  alive: boolean
  probe: TranscriptProbe
  /** Start of the CURRENT spawn (epoch ms), if known. */
  spawnStartMs: number | null
  /** Card-level fallback origin (last_start_at / updated_at), epoch ms. */
  fallbackStartMs: number | null
  nowMs: number
  config: StallConfig
  /** Auto-restarts already spent in this stall episode (objectives.stall_restarts). */
  autoRestarts: number
}

export interface StallDecision {
  stalled: boolean
  class: StallClass | null
  idleMs: number
  thresholdMs: number
  action: 'none' | 'restart' | 'flag'
}

export function classifyStall(input: Pick<StallInput, 'sessionId' | 'alive' | 'probe'>): StallClass {
  if (!input.sessionId) return 'never_spawned'
  if (!input.alive) return input.probe.cliEventsSinceSpawn === 0 ? 'never_spawned' : 'died_silently'
  return input.probe.cliEventsSinceSpawn === 0 ? 'hung_startup' : 'hung_no_heartbeat'
}

export function decideStall(input: StallInput): StallDecision {
  const origin = Math.max(input.probe.lastWriteMs ?? 0, input.spawnStartMs ?? 0, input.fallbackStartMs ?? 0)
  const idleMs = origin > 0 ? Math.max(0, input.nowMs - origin) : 0
  const cls = classifyStall(input)
  // A tool call in flight on a live process may legitimately be silent for a while.
  const inflight = cls === 'hung_no_heartbeat' && input.probe.toolInFlight
  const thresholdMs = inflight ? input.config.inflightThresholdMs : input.config.thresholdMs
  if (!input.config.enabled || origin === 0 || idleMs < thresholdMs) {
    return { stalled: false, class: null, idleMs, thresholdMs, action: 'none' }
  }
  const action = input.autoRestarts < input.config.maxAutoRestarts ? 'restart' : 'flag'
  return { stalled: true, class: cls, idleMs, thresholdMs, action }
}

const CLASS_TEXT: Record<StallClass, string> = {
  never_spawned: 'session never started (no process, no output)',
  died_silently: 'session process is gone but the card stayed in working',
  hung_startup: 'session process is up but produced no output since it started',
  hung_no_heartbeat: 'session process is up but has written nothing',
}

/** One line from card/session state only — never transcript text. */
export function describeStall(d: StallDecision, sessionId: string | null, phase: StallPhase): string {
  const mins = Math.round(d.idleMs / 60_000)
  return `${d.class}: ${CLASS_TEXT[d.class!]} — idle ${mins} min (threshold ${Math.round(d.thresholdMs / 60_000)} min), phase ${phase}, session ${sessionId ?? 'none'}`
}

// ── Tick (I/O, dependency-injected for tests) ────────────────────────────────

export interface StallCardRow {
  id: number
  title: string
  status: string
  workspace: string | null
  project: string | null
  session_id: string | null
  delegate_mode: number | null
  last_activity_at: string | null
  last_start_at: string | null
  updated_at: string | null
  stalled_at: string | null
  stall_restarts: number | null
}

export interface StallDeps {
  db: Database.Database
  now: () => number
  config?: StallConfig
  transcriptPath: (sessionId: string) => string | null
  probe: (jsonlPath: string | null) => TranscriptProbe
  isAlive: (sessionId: string) => boolean
  spawnStartMs: (sessionId: string) => number | null
  /** Cards whose idleness is by design (pending wakeup, 529 retry, arena cohort). */
  isExempt: (row: StallCardRow) => boolean
  /** Kill the stalled session and release its leases. */
  stop: (row: StallCardRow) => Promise<void>
  /** Spawn a fresh session; returns the new session id. Throws on failure. */
  start: (objective: Objective) => Promise<string>
  noteStartReason: (objectiveId: number, detail: string) => void
  notify: (row: StallCardRow, reason: string) => void
  broadcast: (objectiveId: number) => void
  log?: (msg: string) => void
}

export interface StallTickResult {
  heartbeats: number
  restarted: number[]
  flagged: number[]
  cleared: number[]
}

/** SQLite `datetime('now')` text or ISO → epoch ms (UTC). */
export function parseDbTime(v: string | null | undefined): number | null {
  if (!v) return null
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v.replace(' ', 'T') : `${v.replace(' ', 'T')}Z`
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : null
}

function logActivity(db: Database.Database, row: StallCardRow, eventType: 'milestone' | 'error', title: string, detail: string, meta: Record<string, unknown>): void {
  try {
    db.prepare(
      'INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(row.project || 'unknown', row.workspace, row.id, row.session_id, eventType, title, detail, JSON.stringify(meta))
  } catch { /* telemetry must never break the tick */ }
}

/**
 * Escalation path: flag a working card `stalled` (visible flag + reason), log a
 * `session_stalled` activity row and fire `deps.notify` (needs_agent wake + alert).
 * Idempotent per episode — returns false if the card is already flagged or left
 * `working`. Exported for reuse by other "session ended abnormally" paths.
 */
export function flagStalled(
  deps: Pick<StallDeps, 'db' | 'now' | 'notify' | 'broadcast' | 'log'>,
  row: StallCardRow,
  reason: string,
  d: StallDecision | null,
): boolean {
  const iso = new Date(deps.now()).toISOString()
  const res = deps.db.prepare(
    "UPDATE objectives SET stalled_at = ?, stall_reason = ? WHERE id = ? AND status = 'working' AND stalled_at IS NULL",
  ).run(iso, reason.slice(0, 500), row.id)
  if (res.changes !== 1) return false
  logActivity(deps.db, row, 'error', 'session_stalled', reason, {
    kind: 'session_stalled', class: d?.class ?? null, idle_ms: d?.idleMs ?? null, auto_restarts: Number(row.stall_restarts) || 0,
  })
  try { deps.notify(row, reason) } catch { /* alert delivery is best-effort */ }
  deps.broadcast(row.id)
  deps.log?.(`[stall-watchdog] #${row.id} FLAGGED stalled — ${reason}`)
  return true
}

/**
 * Once-only auto-restart: durably claims the single attempt (compare-and-set on
 * `stall_restarts`) BEFORE any side effect, records the reason, then stop + start.
 * Returns false without restarting if the attempt was already used; a failed
 * spawn falls through to {@link flagStalled}. Exported for reuse.
 */
export async function restartStalled(deps: StallDeps, row: StallCardRow, d: StallDecision, reason: string): Promise<boolean> {
  const db = deps.db
  // Claim the restart durably BEFORE any side effect: even if the spawn below
  // throws or the server dies mid-restart, the next stall of this episode flags.
  // The cap is enforced HERE as well as in decideStall, so a caller that reuses
  // this path can never restart past it (hard ceiling: DEFAULT_MAX_AUTO_RESTARTS).
  const cap = Math.min((deps.config ?? resolveStallConfig(db)).maxAutoRestarts, DEFAULT_MAX_AUTO_RESTARTS)
  const claim = db.prepare(
    "UPDATE objectives SET stall_restarts = COALESCE(stall_restarts, 0) + 1 WHERE id = ? AND status = 'working' AND COALESCE(stall_restarts, 0) = ? AND COALESCE(stall_restarts, 0) < ?",
  ).run(row.id, Number(row.stall_restarts) || 0, cap)
  if (claim.changes !== 1) return false
  logActivity(db, row, 'milestone', 'stall_auto_restart', `Auto-restarting stalled session (1 attempt): ${reason}`, {
    kind: 'stall_auto_restart', class: d.class, idle_ms: d.idleMs, old_session_id: row.session_id,
  })
  try {
    await deps.stop(row)
    deps.noteStartReason(row.id, reason)
    const fresh = db.prepare('SELECT * FROM objectives WHERE id = ?').get(row.id) as Objective | undefined
    if (!fresh || fresh.status !== 'working') return false
    const newSessionId = await deps.start(fresh)
    db.prepare(
      "UPDATE objectives SET session_id = ?, stall_reason = ?, updated_at = datetime('now') WHERE id = ? AND status = 'working'",
    ).run(newSessionId, `auto-restarted after ${reason}`.slice(0, 500), row.id)
    deps.broadcast(row.id)
    deps.log?.(`[stall-watchdog] #${row.id} auto-restarted: ${row.session_id ?? 'none'} → ${newSessionId} (${d.class})`)
    return true
  } catch (err) {
    const msg = (err as Error)?.message?.split('\n')[0] ?? String(err)
    flagStalled(deps, { ...row, stall_restarts: (Number(row.stall_restarts) || 0) + 1 }, `${reason}; auto-restart failed: ${msg}`.slice(0, 500), d)
    return false
  }
}

/**
 * One watchdog pass over every working card. Never throws per card; a failure on
 * one card is logged and the pass moves on.
 */
export async function runStallWatchdogTick(deps: StallDeps): Promise<StallTickResult> {
  const db = deps.db
  const out: StallTickResult = { heartbeats: 0, restarted: [], flagged: [], cleared: [] }
  const cfg = deps.config ?? resolveStallConfig(db)
  const nowMs = deps.now()

  // A card that left `working` is no longer stalled.
  try {
    db.prepare("UPDATE objectives SET stalled_at = NULL WHERE stalled_at IS NOT NULL AND status != 'working'").run()
  } catch { /* column missing on a pre-migration DB → nothing to clear */ }

  const rows = db.prepare(
    `SELECT id, title, status, workspace, project, session_id, delegate_mode, last_activity_at, last_start_at,
            updated_at, stalled_at, stall_restarts
       FROM objectives
      WHERE status = 'working' AND deleted_at IS NULL`,
  ).all() as StallCardRow[]

  const bumpActivity = db.prepare(
    'UPDATE objectives SET last_activity_at = ? WHERE id = ? AND (last_activity_at IS NULL OR last_activity_at < ?)',
  )

  for (const row of rows) {
    try {
      const jsonl = row.session_id ? deps.transcriptPath(row.session_id) : null
      const probe = deps.probe(jsonl)

      // 1. Live heartbeat — forward-only, same ISO format session-intel writes.
      if (probe.lastWriteMs) {
        const iso = new Date(probe.lastWriteMs).toISOString()
        if (bumpActivity.run(iso, row.id, iso).changes > 0) out.heartbeats++
      }

      if (Number(row.delegate_mode) > 0) continue
      if (deps.isExempt(row)) continue

      const alive = row.session_id ? deps.isAlive(row.session_id) : false
      const decision = decideStall({
        sessionId: row.session_id,
        alive,
        probe,
        spawnStartMs: row.session_id ? deps.spawnStartMs(row.session_id) : null,
        fallbackStartMs: parseDbTime(row.last_start_at) ?? parseDbTime(row.updated_at),
        nowMs,
        config: cfg,
        autoRestarts: Number(row.stall_restarts) || 0,
      })

      // 2. Already flagged: clear on fresh activity, otherwise leave it alone.
      if (row.stalled_at) {
        const flaggedAt = parseDbTime(row.stalled_at) ?? 0
        if (probe.lastWriteMs && probe.lastWriteMs > flaggedAt) {
          db.prepare('UPDATE objectives SET stalled_at = NULL, stall_reason = NULL WHERE id = ?').run(row.id)
          out.cleared.push(row.id)
          deps.broadcast(row.id)
        }
        continue
      }
      if (!decision.stalled) continue

      const reason = describeStall(decision, row.session_id, probe.phase)
      if (decision.action === 'restart') {
        if (await restartStalled(deps, row, decision, reason)) out.restarted.push(row.id)
        else if (db.prepare('SELECT stalled_at FROM objectives WHERE id = ?').pluck().get(row.id)) out.flagged.push(row.id)
      } else if (flagStalled(deps, row, reason, decision)) {
        out.flagged.push(row.id)
      }
    } catch (err) {
      deps.log?.(`[stall-watchdog] #${row.id} check failed: ${(err as Error)?.message ?? err}`)
    }
  }
  return out
}

// ── Production wiring ────────────────────────────────────────────────────────

let lastTickAt = 0
let tickRunning = false

/** Test-only. */
export function __resetStallWatchdogThrottle(): void {
  lastTickAt = 0
  tickRunning = false
}

/**
 * Called from every state-poller pass; self-throttled to STALL_TICK_INTERVAL_MS and
 * non-reentrant (a restart awaits a spawn). Lazily imports the session layer so this
 * module stays unit-testable without tmux/docker.
 */
export async function maybeRunStallWatchdog(nowMs = Date.now()): Promise<StallTickResult | null> {
  // The poller's own suites drive pollActiveSessions with mocked session layers and
  // backdated cards; the watchdog is exercised directly through runStallWatchdogTick
  // (stall-watchdog.test.ts), so the production wiring stays out of those suites.
  if (process.env.VITEST && process.env.CC_STALL_WATCHDOG_IN_TESTS !== '1') return null
  if (tickRunning || nowMs - lastTickAt < STALL_TICK_INTERVAL_MS) return null
  lastTickAt = nowMs
  tickRunning = true
  try {
    const [{ getDb }, tmux, jail, control, registry, mgr, starter, reasons, branchScope, branchLease, sessionLease, arena, notifier, ws, cfg] =
      await Promise.all([
        import('../db/index.js'),
        import('./session-tmux.js'),
        import('./session-jail.js'),
        import('./session-control.js'),
        import('./session-registry.js'),
        import('./session-auto-resume.js'),
        import('./session-start.js'),
        import('./session-start-reasons.js'),
        import('./branch-scope.js'),
        import('./branch-lease.js'),
        import('./session-lease.js'),
        import('./arena-lifecycle.js'),
        import('./notifier.js'),
        import('../ws/index.js'),
        import('../config.js'),
      ])
    const db = getDb()
    const transcriptPath = (sid: string): string => {
      const canonical = registry.activeSessions.get(sid)?.jsonlPath || path.join(cfg.TRANSCRIPT_DIR, `${sid}.jsonl`)
      return jail.jailEnabled() ? tmux.resolveSessionTranscript(canonical, sid) : canonical
    }
    return await runStallWatchdogTick({
      db,
      now: () => Date.now(),
      transcriptPath,
      probe: probeTranscript,
      isAlive: (sid) => tmux.tmuxSessionAlive(registry.activeSessions.get(sid)?.tmuxName || sid),
      spawnStartMs: (sid) => control.getSessionStartedAt(sid),
      isExempt: (row) => {
        if (!row.session_id) return false
        if (arena.hasArenaCohort(row.id)) return true
        if (mgr.isOverloadRetryPending(row.session_id)) return true
        return control.transcriptHasPendingWork(row.session_id).pending
      },
      stop: async (row) => {
        if (row.session_id) await control.stopSession(row.session_id).catch(() => {})
        const fresh = db.prepare('SELECT * FROM objectives WHERE id = ?').get(row.id) as Objective | undefined
        const branch = fresh ? branchScope.deriveBranchName(fresh) : null
        if (branch) { try { branchLease.releaseBranchLease(db, branch) } catch { /* non-fatal */ } }
        try { sessionLease.releaseSessionLeasesForObjective(db, row.id) } catch { /* non-fatal */ }
      },
      start: (objective) => starter.startSession(objective),
      noteStartReason: (id, detail) => reasons.noteStartReason(id, STALL_START_REASON, 'stall-watchdog', detail),
      notify: (row, reason) => {
        notifier.insertAlert({
          severity: 'high',
          source: 'stall-watchdog',
          title: `Card #${row.id} stalled in working`,
          message: `${row.title}\n${reason}\nThe one automatic restart is spent; the card is flagged stalled and its owner bot has been woken (needs_agent kind=stalled).`,
          dedup_key: `stall:${row.id}`,
          url: `/objectives/${row.id}`,
        })
      },
      broadcast: (id) => {
        const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(id)
        if (updated) ws.broadcast({ type: 'objective_updated', payload: updated as never })
      },
      log: (m) => console.warn(m),
    })
  } finally {
    tickRunning = false
  }
}
