import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { isRetroEnabled, isRetroLive, runDailyRetro } from './daily-retro.js'
import {
  SESSION_MINING_MIN_RECURRENCE,
  SESSION_MINING_LOOKBACK_DAYS,
  SESSION_MINING_SENTINEL,
} from '../config.js'

const SECOND_BRAIN = '/home/operator/second-brain'
const MINION_DIR = '/home/operator/ai-workspace/scripts/minions'

const CHECK_INTERVAL_MS = 60 * 1000 // Check every minute for time-of-day triggers

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let lastFullRunDate: string | null = null // YYYY-MM-DD of last full run
let lastLightRunHour: number | null = null // Hour (0-23) of last light run

interface DreamCycleResult {
  phase: string
  results: Record<string, unknown>
  duration_ms: number
}

/**
 * Start the dream cycle scheduler.
 * - Full run daily at 3 AM UTC (all phases including health)
 * - Light run hourly (blockers phase only — keeps blocker state fresh)
 *
 * Controlled by DREAM_CYCLE_ENABLED env var (default: true).
 */
export function startDreamCycleScheduler(): void {
  const enabled = process.env.DREAM_CYCLE_ENABLED !== 'false'
  if (!enabled) {
    console.log('[dream-cycle] Scheduler disabled via DREAM_CYCLE_ENABLED=false')
    return
  }

  if (schedulerTimer) return

  schedulerTimer = setInterval(() => {
    const now = new Date()
    const utcHour = now.getUTCHours()
    const utcDateStr = now.toISOString().slice(0, 10)

    // Full run at 3 AM UTC, once per day
    if (utcHour === 3 && lastFullRunDate !== utcDateStr) {
      lastFullRunDate = utcDateStr
      lastLightRunHour = utcHour // Skip the light run this hour
      const start = Date.now()
      runDreamCycle('all')
        .then(results => {
          const elapsed = Date.now() - start
          console.log(`[dream-cycle] Scheduled run (full) completed in ${elapsed}ms — ${results.length} phases`)
        })
        .catch(err => {
          console.error('[dream-cycle] Scheduled full run failed:', err)
        })
      return
    }

    // Light run every hour (blockers only), skip the hour we did a full run
    if (lastLightRunHour !== utcHour) {
      lastLightRunHour = utcHour
      const start = Date.now()
      runDreamCycle('blockers')
        .then(results => {
          const elapsed = Date.now() - start
          console.log(`[dream-cycle] Scheduled run (light) completed in ${elapsed}ms`)
        })
        .catch(err => {
          console.error('[dream-cycle] Scheduled light run failed:', err)
        })
    }
  }, CHECK_INTERVAL_MS)

  console.log('[dream-cycle] Scheduler started — full daily at 03:00 UTC, light hourly')
}

export function stopDreamCycleScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    console.log('[dream-cycle] Scheduler stopped')
  }
}

/**
 * Full-run phase order. EXPORTED because the order is load-bearing, not
 * cosmetic (obj 705052):
 *   • 'retro' runs AFTER 'mining' so it reads that run's freshly-updated
 *     session_intel.blockers and objective_learnings.
 *   • 'retro' runs BEFORE 'cleanup', which DELETEs session_events — the rows
 *     the retro detector's D6 escalation signal reads. Swapping those two
 *     silently blinds the detector, which is why dream-cycle.retro.test.ts
 *     asserts this array rather than trusting a comment.
 */
export const DREAM_CYCLE_PHASES = ['blockers', 'rollup', 'mining', 'retro', 'cleanup', 'index', 'health'] as const

/**
 * Dream Cycle: Periodic consolidation of session intelligence.
 * Inspired by GBrain's nightly consolidation — sweeps, compiles, reconciles.
 */
export async function runDreamCycle(phase: string = 'all'): Promise<DreamCycleResult[]> {
  const results: DreamCycleResult[] = []

  const phases = phase === 'all' ? [...DREAM_CYCLE_PHASES] : [phase]

  for (const p of phases) {
    const start = Date.now()
    let result: Record<string, unknown> = {}

    switch (p) {
      case 'blockers':
        result = resolveBlockers()
        break
      case 'rollup':
        result = rollupOutcomes()
        break
      case 'mining':
        result = mineSessions()
        break
      case 'retro':
        result = await runRetroPhase()
        break
      case 'cleanup':
        result = cleanupStaleData()
        break
      case 'index':
        result = rebuildIndexes()
        break
      case 'health':
        result = computeKnowledgeHealth()
        break
      default:
        result = { error: `Unknown phase: ${p}` }
    }

    results.push({
      phase: p,
      results: result,
      duration_ms: Date.now() - start,
    })
  }

  console.log(`[dream-cycle] Completed ${results.length} phases`)
  return results
}

/**
 * Daily Session Retrospective phase (obj 705052).
 *
 * Gated on `dsr_enabled` (OFF by default) so this is a byte-for-byte no-op in
 * prod until Mike arms it. Wrapped in try/catch — a retro failure must NEVER
 * abort `cleanup`/`index`/`health`, which are the phases that keep the DB from
 * growing unbounded. Objective creation is separately gated on `dsr_live`
 * inside runDailyRetro; with `dsr_enabled=1, dsr_live=0` the full detector +
 * lens gate runs and writes only `dsr_candidates`.
 */
async function runRetroPhase(): Promise<Record<string, unknown>> {
  try {
    const db = getDb()
    if (!isRetroEnabled(db)) {
      console.log('[dream-cycle] retro: disabled (dsr_enabled=0) — skipped')
      return { skipped: 'disabled' }
    }
    const res = await runDailyRetro({ db, mode: isRetroLive(db) ? 'live' : 'shadow' })
    return res as unknown as Record<string, unknown>
  } catch (err) {
    // Deliberately swallowed: the retro is an optional enrichment phase, the
    // phases after it are maintenance the platform depends on.
    console.error('[dream-cycle] retro phase failed (non-fatal):', err)
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Blocker resolution: Check if blockers from session_intel have been resolved
 * by subsequent sessions (same objective moved to done, or no re-report).
 */
function resolveBlockers(): Record<string, unknown> {
  const db = getDb()

  // Find objectives with blockers that are now done
  const resolved = db.prepare(`
    UPDATE session_intel SET blockers = '[]'
    WHERE objective_id IN (
      SELECT id FROM objectives WHERE status = 'done'
    ) AND blockers != '[]'
  `).run()

  // Find blockers where a newer session on the same objective didn't re-report them
  const staleBlockers = db.prepare(`
    SELECT si1.id, si1.session_id, si1.objective_id
    FROM session_intel si1
    WHERE si1.blockers != '[]'
      AND EXISTS (
        SELECT 1 FROM session_intel si2
        WHERE si2.objective_id = si1.objective_id
          AND si2.ended_at > si1.ended_at
          AND si2.blockers = '[]'
          AND si2.extraction_status IN ('parsed', 'summarized')
      )
  `).all() as { id: number; session_id: string; objective_id: number }[]

  for (const row of staleBlockers) {
    db.prepare("UPDATE session_intel SET blockers = '[]' WHERE id = ?").run(row.id)
  }

  // Update has_blockers on objectives
  db.prepare(`
    UPDATE objectives SET has_blockers = 0
    WHERE has_blockers = 1
      AND id NOT IN (
        SELECT DISTINCT objective_id FROM session_intel
        WHERE blockers != '[]'
          AND objective_id IN (SELECT id FROM objectives WHERE status != 'done')
      )
  `).run()

  return {
    done_resolved: resolved.changes,
    stale_resolved: staleBlockers.length,
  }
}

/**
 * Outcome rollup: Aggregate session outcomes into skill registry.
 */
function rollupOutcomes(): Record<string, unknown> {
  const db = getDb()
  const registryPath = '/home/operator/ai-workspace/skills/registry.json'

  // Get skill usage counts from session_intel
  const skillUsage = db.prepare(`
    SELECT skills_used FROM session_intel
    WHERE skills_used != '[]' AND extraction_status IN ('parsed', 'summarized')
  `).all() as { skills_used: string }[]

  const usageCounts: Record<string, number> = {}
  const failureCounts: Record<string, number> = {}

  for (const row of skillUsage) {
    const skills = JSON.parse(row.skills_used) as string[]
    for (const skill of skills) {
      usageCounts[skill] = (usageCounts[skill] || 0) + 1
    }
  }

  // Get failure counts (sessions with outcome = 'failed' that used each skill)
  const failedSessions = db.prepare(`
    SELECT skills_used FROM session_intel
    WHERE outcome = 'failed' AND skills_used != '[]'
  `).all() as { skills_used: string }[]

  for (const row of failedSessions) {
    const skills = JSON.parse(row.skills_used) as string[]
    for (const skill of skills) {
      failureCounts[skill] = (failureCounts[skill] || 0) + 1
    }
  }

  // Update registry.json if it exists
  let registryUpdated = false
  try {
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
      for (const [skillName, skillData] of Object.entries(registry.skills || {})) {
        const skill = skillData as Record<string, unknown>
        if (usageCounts[skillName] !== undefined) {
          skill.usage_count = usageCounts[skillName]
        }
        if (failureCounts[skillName] !== undefined) {
          skill.failure_count = failureCounts[skillName]
          const total = usageCounts[skillName] || 1
          const failRate = failureCounts[skillName] / total
          skill.needs_improvement = failRate > 0.2
        }
      }
      registry.generated_at = new Date().toISOString()
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2))
      registryUpdated = true
    }
  } catch (err) {
    console.error('[dream-cycle] Registry update failed:', err)
  }

  return {
    skills_tracked: Object.keys(usageCounts).length,
    skills_with_failures: Object.keys(failureCounts).length,
    registry_updated: registryUpdated,
  }
}

/**
 * Session mining: distill recurring failure modes across objectives into durable
 * lessons. This is the promotion tier of the outer loop — session_intel/session_events
 * are a closed cross-session memory, but until now nothing turned a failure that
 * recurs across MANY objectives into a platform-wide rule. We scan two failure
 * signals cross-objective:
 *   - normalized blocker/error descriptions from session_events  → 'gotcha'
 *   - skills that co-occur with failed sessions                  → 'pattern'
 * Any signal recurring across >= SESSION_MINING_MIN_RECURRENCE distinct objectives
 * is promoted into objective_learnings (the previously-unused pattern/gotcha slots),
 * tagged with the SESSION_MINING_SENTINEL session id so context-builder can surface
 * it at spawn time. Idempotent: each run replaces the prior mined rows (mirrors the
 * compaction-summary replace pattern in prompt-builder), so the table never
 * accumulates stale lessons.
 */
function mineSessions(): Record<string, unknown> {
  const db = getDb()
  const sinceClause = `datetime('now', '-${SESSION_MINING_LOOKBACK_DAYS} days')`

  // Normalize a free-text failure description into a stable grouping key:
  // lowercase, collapse whitespace, drop trailing punctuation, cap length so
  // near-identical reports (differing only in IDs/paths tails) still group.
  const normalize = (text: string): string =>
    text.toLowerCase().replace(/\s+/g, ' ').replace(/[.;:,\s]+$/, '').trim().slice(0, 120)

  // ── a. Recurring blocker/error descriptions (→ gotcha) ──
  // Group normalized descriptions across objectives; a description that bites
  // >= MIN_RECURRENCE distinct objectives is a platform-wide gotcha.
  const failureEvents = db.prepare(`
    SELECT description, objective_id, created_at
    FROM session_events
    WHERE event_type IN ('blocker', 'error')
      AND created_at > ${sinceClause}
  `).all() as { description: string; objective_id: number; created_at: string }[]

  interface Group {
    sample: string
    objectives: Set<number>
    count: number
    latestObjective: number
    latestAt: string
  }
  const gotchaGroups = new Map<string, Group>()
  for (const ev of failureEvents) {
    if (!ev.description) continue
    const key = normalize(ev.description)
    if (!key) continue
    let g = gotchaGroups.get(key)
    if (!g) {
      g = { sample: ev.description.trim(), objectives: new Set(), count: 0, latestObjective: ev.objective_id, latestAt: ev.created_at }
      gotchaGroups.set(key, g)
    }
    g.objectives.add(ev.objective_id)
    g.count++
    if (ev.created_at >= g.latestAt) {
      g.latestAt = ev.created_at
      g.latestObjective = ev.objective_id
    }
  }

  // ── b. Skills correlated with failed sessions (→ pattern) ──
  // A skill used by failed/blocked sessions across >= MIN_RECURRENCE distinct
  // objectives is a usage pattern worth flagging before relying on it again.
  const failedSessions = db.prepare(`
    SELECT skills_used, objective_id, ended_at
    FROM session_intel
    WHERE outcome IN ('failed', 'blocked')
      AND skills_used != '[]'
      AND ended_at > ${sinceClause}
  `).all() as { skills_used: string; objective_id: number; ended_at: string }[]

  const patternGroups = new Map<string, Group>()
  for (const row of failedSessions) {
    let skills: string[] = []
    try { skills = JSON.parse(row.skills_used) as string[] } catch { continue }
    for (const skill of skills) {
      if (!skill) continue
      let g = patternGroups.get(skill)
      if (!g) {
        g = { sample: skill, objectives: new Set(), count: 0, latestObjective: row.objective_id, latestAt: row.ended_at }
        patternGroups.set(skill, g)
      }
      g.objectives.add(row.objective_id)
      g.count++
      if (row.ended_at >= g.latestAt) {
        g.latestAt = row.ended_at
        g.latestObjective = row.objective_id
      }
    }
  }

  // ── Promote: replace prior mined rows, then insert this run's recurring lessons ──
  const insert = db.prepare(`
    INSERT INTO objective_learnings (objective_id, session_id, content, learning_type)
    VALUES (?, ?, ?, ?)
  `)
  const objectiveExists = db.prepare('SELECT 1 FROM objectives WHERE id = ?')

  const promote = db.transaction(() => {
    db.prepare('DELETE FROM objective_learnings WHERE session_id = ?').run(SESSION_MINING_SENTINEL)

    let gotchas = 0
    let patterns = 0

    for (const g of gotchaGroups.values()) {
      if (g.objectives.size < SESSION_MINING_MIN_RECURRENCE) continue
      // FK is NOT NULL → anchor to a live objective that exhibited the failure.
      if (!objectiveExists.get(g.latestObjective)) continue
      const content = `Recurring failure across ${g.objectives.size} objectives (${g.count} occurrences): ${g.sample}`
      insert.run(g.latestObjective, SESSION_MINING_SENTINEL, content, 'gotcha')
      gotchas++
    }

    for (const g of patternGroups.values()) {
      if (g.objectives.size < SESSION_MINING_MIN_RECURRENCE) continue
      if (!objectiveExists.get(g.latestObjective)) continue
      const content = `Skill "${g.sample}" co-occurred with failed/blocked sessions across ${g.objectives.size} objectives — verify its preconditions before relying on it.`
      insert.run(g.latestObjective, SESSION_MINING_SENTINEL, content, 'pattern')
      patterns++
    }

    return { gotchas, patterns }
  })

  let promoted = { gotchas: 0, patterns: 0 }
  try {
    promoted = promote()
  } catch (err) {
    console.error('[dream-cycle] Session mining promotion failed:', err)
  }

  console.log(`[dream-cycle] Session mining: ${promoted.gotchas} gotchas + ${promoted.patterns} patterns promoted (from ${gotchaGroups.size} blocker groups, ${patternGroups.size} skill groups)`)

  return {
    blocker_groups: gotchaGroups.size,
    skill_groups: patternGroups.size,
    gotchas_promoted: promoted.gotchas,
    patterns_promoted: promoted.patterns,
  }
}

/**
 * Cleanup stale data: Remove old session_file_ops, purge extraction failures.
 */
function cleanupStaleData(): Record<string, unknown> {
  const db = getDb()

  // Remove file ops older than 30 days
  const fileOps = db.prepare(
    "DELETE FROM session_file_ops WHERE timestamp < datetime('now', '-30 days')"
  ).run()

  // Remove session events older than 90 days
  const events = db.prepare(
    "DELETE FROM session_events WHERE created_at < datetime('now', '-90 days')"
  ).run()

  return {
    file_ops_deleted: fileOps.changes,
    events_deleted: events.changes,
  }
}

/**
 * Rebuild second-brain indexes from source frontmatter.
 */
function rebuildIndexes(): Record<string, unknown> {
  const indexScript = path.join(MINION_DIR, 'index-rebuild.sh')

  if (!fs.existsSync(indexScript)) {
    return { status: 'skipped', reason: 'index-rebuild.sh not found' }
  }

  try {
    const output = execSync(`bash ${indexScript}`, {
      timeout: 120000,
      encoding: 'utf-8',
      env: { ...process.env, SECOND_BRAIN },
    })
    return { status: 'completed', output: output.slice(0, 500) }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : 'Unknown error' }
  }
}

/**
 * Knowledge health scoring: Computes metrics on the quality and freshness of
 * session intelligence data. Runs during the daily full cycle.
 */
function computeKnowledgeHealth(): Record<string, unknown> {
  const db = getDb()

  // Ensure table exists (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      decision_freshness REAL,
      followup_completion REAL,
      blocker_persistence REAL,
      capture_gap_rate REAL,
      overall_score REAL,
      details TEXT
    )
  `)

  // ── a. Decision freshness ──
  // Decisions older than 30 days that haven't been superseded by a newer decision
  // on the same objective are "stale".
  const totalDecisions = (db.prepare(
    "SELECT COUNT(*) as n FROM session_events WHERE event_type = 'decision'"
  ).get() as { n: number }).n

  const staleDecisions = (db.prepare(`
    SELECT COUNT(*) as n FROM session_events se
    WHERE se.event_type = 'decision'
      AND se.created_at < datetime('now', '-30 days')
      AND NOT EXISTS (
        SELECT 1 FROM session_events se2
        WHERE se2.objective_id = se.objective_id
          AND se2.event_type = 'decision'
          AND se2.created_at > se.created_at
      )
  `).get() as { n: number }).n

  const freshDecisions = totalDecisions - staleDecisions
  const decisionFreshness = totalDecisions > 0 ? (freshDecisions / totalDecisions) * 100 : 100

  // ── b. Follow-up completion rate ──
  // A follow_up is "completed" if a subsequent session exists on the same objective
  // after the follow_up was created.
  const totalFollowUps = (db.prepare(
    "SELECT COUNT(*) as n FROM session_events WHERE event_type = 'follow_up'"
  ).get() as { n: number }).n

  const completedFollowUps = (db.prepare(`
    SELECT COUNT(*) as n FROM session_events se
    WHERE se.event_type = 'follow_up'
      AND EXISTS (
        SELECT 1 FROM session_intel si
        WHERE si.objective_id = se.objective_id
          AND si.started_at > se.created_at
      )
  `).get() as { n: number }).n

  const followupCompletion = totalFollowUps > 0 ? (completedFollowUps / totalFollowUps) * 100 : 100

  // ── c. Blocker persistence ──
  // Blockers that appear in 3+ sessions on the same objective (same description text)
  // are "stuck". Score is inverse of stuck count, capped at 100.
  const stuckBlockers = db.prepare(`
    SELECT se.description, se.objective_id, COUNT(DISTINCT se.session_id) as session_count
    FROM session_events se
    WHERE se.event_type = 'blocker'
    GROUP BY se.objective_id, se.description
    HAVING session_count >= 3
  `).all() as { description: string; objective_id: number; session_count: number }[]

  const stuckCount = stuckBlockers.length
  // Score: 100 when no stuck blockers, decreasing by 10 per stuck blocker, min 0
  const blockerPersistence = Math.max(0, 100 - stuckCount * 10)

  // ── d. Capture gap rate ──
  // Count sessions that have capture_gap milestones vs total sessions.
  const totalSessions = (db.prepare(
    "SELECT COUNT(*) as n FROM session_intel WHERE extraction_status IN ('parsed', 'summarized')"
  ).get() as { n: number }).n

  const sessionsWithGaps = (db.prepare(`
    SELECT COUNT(DISTINCT se.session_id) as n
    FROM session_events se
    WHERE se.event_type = 'milestone'
      AND se.metadata LIKE '%capture_gap%'
  `).get() as { n: number }).n

  const sessionsWithoutGaps = totalSessions - sessionsWithGaps
  const captureGapRate = totalSessions > 0 ? (sessionsWithoutGaps / totalSessions) * 100 : 100

  // ── e. Overall health: weighted average ──
  const overall = (
    decisionFreshness * 0.25 +
    followupCompletion * 0.30 +
    blockerPersistence * 0.20 +
    captureGapRate * 0.25
  )

  const details = {
    decisions: { total: totalDecisions, stale: staleDecisions, fresh: freshDecisions },
    follow_ups: { total: totalFollowUps, completed: completedFollowUps },
    blockers: { stuck_count: stuckCount, stuck_items: stuckBlockers.slice(0, 10) },
    capture_gaps: { total_sessions: totalSessions, sessions_with_gaps: sessionsWithGaps },
  }

  // Store in knowledge_health table
  db.prepare(`
    INSERT INTO knowledge_health (decision_freshness, followup_completion, blocker_persistence, capture_gap_rate, overall_score, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    Math.round(decisionFreshness * 100) / 100,
    Math.round(followupCompletion * 100) / 100,
    Math.round(blockerPersistence * 100) / 100,
    Math.round(captureGapRate * 100) / 100,
    Math.round(overall * 100) / 100,
    JSON.stringify(details),
  )

  console.log(`[dream-cycle] Knowledge health: overall=${overall.toFixed(1)}% (decisions=${decisionFreshness.toFixed(0)}% followups=${followupCompletion.toFixed(0)}% blockers=${blockerPersistence.toFixed(0)}% gaps=${captureGapRate.toFixed(0)}%)`)

  return {
    decision_freshness: Math.round(decisionFreshness * 100) / 100,
    followup_completion: Math.round(followupCompletion * 100) / 100,
    blocker_persistence: Math.round(blockerPersistence * 100) / 100,
    capture_gap_rate: Math.round(captureGapRate * 100) / 100,
    overall_score: Math.round(overall * 100) / 100,
    details,
  }
}

/**
 * Get knowledge health scores: latest + last 7 daily scores for trend.
 */
export function getKnowledgeHealth(): { latest: Record<string, unknown> | null; trend: Record<string, unknown>[] } {
  const db = getDb()

  // Ensure table exists so this doesn't blow up before first health run
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computed_at TEXT NOT NULL DEFAULT (datetime('now')),
      decision_freshness REAL,
      followup_completion REAL,
      blocker_persistence REAL,
      capture_gap_rate REAL,
      overall_score REAL,
      details TEXT
    )
  `)

  const latest = db.prepare(
    'SELECT * FROM knowledge_health ORDER BY computed_at DESC LIMIT 1'
  ).get() as Record<string, unknown> | undefined

  const trend = db.prepare(
    'SELECT * FROM knowledge_health ORDER BY computed_at DESC LIMIT 7'
  ).all() as Record<string, unknown>[]

  // Parse details JSON for convenience
  const parseRow = (row: Record<string, unknown>) => {
    if (row && typeof row.details === 'string') {
      try { row.details = JSON.parse(row.details as string) } catch {}
    }
    return row
  }

  return {
    latest: latest ? parseRow(latest) : null,
    trend: trend.map(parseRow),
  }
}
