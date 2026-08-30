import fs from 'fs'
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { searchKnowledge } from './knowledge-search.js'
import { getCorrectionsForContext } from './corrections.js'
import { SKILLS_REGISTRY, SESSION_MINING_SENTINEL, SESSION_MINING_LOOKBACK_DAYS, SESSION_MINING_MAX_SURFACED, contextTreeFirstEnabled } from '../config.js'
import type { Objective, SessionDecision, SessionBlocker, SessionFollowUp } from '@operationkit/shared'

// QW6 / audit C#5: how far back a blocker stays "active". Older session_intel
// rows age out so the section isn't a graveyard of resolved/abandoned work.
const ACTIVE_BLOCKER_WINDOW_DAYS = 7

// ── Tree-first ordering (P1-2 / gap G8), active only when CONTEXT_TREE_FIRST ──
//
// The relevance tier of a row's objective `o` relative to the objective whose
// spawn context is being built. Lower = closer in the tree. This is the whole
// mechanism: the queries below keep their existing LIMITs and simply ORDER BY
// this tier BEFORE recency, so the tree fills the slots first and the
// platform-wide tier gets only what is left over.
//
//   0 self · 1 sibling (same parent_id) · 2 parent · 3 child · 4 workspace · 5 global
//
// Siblings rank above the parent deliberately: a peer under the same delegator
// is doing work carved out of the same brief, which predicts a file collision or
// a shared blocker far better than the delegator's own coordination sessions do.
// Children rank just below the parent so a delegator sees its own fan-out.
//
// Named params (@self/@parent/@ws) — `@parent` is NULL for a root objective, and
// every comparison against NULL is NULL (never true), so a root simply has no
// sibling/parent tier and falls through to workspace/global. That is correct:
// "both have no parent" is not a relationship (same rule as the P1-3 siblings
// read edge, which returns [] for an orphan rather than the whole top tier).
const TREE_TIER_SQL = `
    CASE
      WHEN o.id = @self THEN 0
      WHEN o.parent_id = @parent THEN 1
      WHEN o.id = @parent THEN 2
      WHEN o.parent_id = @self THEN 3
      WHEN o.workspace = @ws THEN 4
      ELSE 5
    END`

/** Highest tier value that still counts as "inside the tree" (self..child). */
const MAX_TREE_TIER = 3

function treeParams(objective: Objective) {
  return {
    self: objective.id,
    parent: objective.parent_id ?? null,
    ws: objective.workspace,
  }
}

export interface ActiveBlockerRow {
  objective_id: number
  objective_title: string
  agent_context: string | null
  blockers: string
}

/**
 * Active blockers across the current workspace (QW6 / audit C#5).
 *
 * Three fixes over the original query, which leaked every open blocker
 * platform-wide:
 *   (a) recency window  — only the last ACTIVE_BLOCKER_WINDOW_DAYS days, so
 *       stale blockers age out instead of accumulating forever;
 *   (b) workspace predicate — scoped to the objective's workspace so blockers
 *       from unrelated workspaces don't leak into the spawn context;
 *   (c) SELECT o.id as objective_id — the dedup guard (skip the objective's
 *       own blockers, already shown under "Previous Sessions") compares
 *       row.objective_id to objective.id; without the id selected the guard
 *       was dead and never fired.
 */
export function getActiveBlockers(
  db: Database.Database,
  objective: Objective
): ActiveBlockerRow[] {
  if (contextTreeFirstEnabled()) return getActiveBlockersTreeFirst(db, objective)

  const rows = db.prepare(`
    SELECT o.id as objective_id, si.blockers, o.title as objective_title, o.agent_context
    FROM session_intel si
    JOIN objectives o ON si.objective_id = o.id
    WHERE si.blockers != '[]' AND o.status != 'done'
      AND o.workspace = ?
      AND si.ended_at > datetime('now', ?)
      AND si.id = (SELECT MAX(id) FROM session_intel WHERE objective_id = o.id)
    ORDER BY si.ended_at DESC
    LIMIT 10
  `).all(objective.workspace, `-${ACTIVE_BLOCKER_WINDOW_DAYS} days`) as ActiveBlockerRow[]

  // Dedup guard: skip the objective's own blockers — they're already surfaced
  // in the "Previous Sessions on This Objective" section above. This now fires
  // because objective_id is selected (fix (c)).
  return rows.filter(r => r.objective_id !== objective.id)
}

/**
 * Tree-first variant of {@link getActiveBlockers} (P1-2 / G8, CONTEXT_TREE_FIRST).
 *
 * Same recency window, same LIMIT, same own-objective dedup. Two differences:
 *   (1) ORDER BY tier, ended_at DESC — siblings/parent/children come first and
 *       the workspace tier fills only the remaining slots;
 *   (2) the workspace predicate becomes `workspace = @ws OR <in the tree>`, so a
 *       relative that lives in another workspace is not silently dropped. It is a
 *       strict superset of the OFF-path row set, re-ordered.
 *
 * Note there is no tier-5 (global) row here at all: the ON path stays
 * workspace-bounded exactly like the OFF path, because a blocker from an
 * unrelated workspace was already judged noise by QW6 / audit C#5 (fix (b)).
 * Tree-first re-orders what is already in scope; it does not re-open that leak.
 */
function getActiveBlockersTreeFirst(
  db: Database.Database,
  objective: Objective
): ActiveBlockerRow[] {
  const rows = db.prepare(`
    SELECT o.id as objective_id, si.blockers, o.title as objective_title, o.agent_context,
           ${TREE_TIER_SQL} as tree_tier
    FROM session_intel si
    JOIN objectives o ON si.objective_id = o.id
    WHERE si.blockers != '[]' AND o.status != 'done'
      AND (o.workspace = @ws OR ${TREE_TIER_SQL} <= ${MAX_TREE_TIER})
      AND si.ended_at > datetime('now', @window)
      AND si.id = (SELECT MAX(id) FROM session_intel WHERE objective_id = o.id)
    ORDER BY tree_tier ASC, si.ended_at DESC
    LIMIT 10
  `).all({ ...treeParams(objective), window: `-${ACTIVE_BLOCKER_WINDOW_DAYS} days` }) as ActiveBlockerRow[]

  return rows.filter(r => r.objective_id !== objective.id)
}

export interface RecentFileOpRow {
  file_path: string
  operation: string
  session_id: string
  objective_title: string
}

// How far back a file op from INSIDE the tree stays interesting, when
// CONTEXT_TREE_FIRST is on. The global tier keeps its 24h window: a stranger's
// edit is only worth knowing about while it is hot, whereas a sibling's edit to
// a file in your brief is worth knowing about for the life of the delegation.
const TREE_FILE_OPS_WINDOW_DAYS = 7

/**
 * Files created/modified by OTHER sessions, for the "Recently Modified Files"
 * conflict section.
 *
 * Default (CONTEXT_TREE_FIRST off): the original query, verbatim — last 24h,
 * ordered by recency, LIMIT 10, no filter on the objective tree. This is the gap
 * (G8): a worker under a delegator gets ten unrelated file ops and zero sibling
 * context, because recency alone carries no information about relevance.
 *
 * Tree-first (CONTEXT_TREE_FIRST on): same LIMIT 10, ordered by tree tier before
 * recency, so siblings/parent/children fill the slots first and platform-wide
 * rows take only what is left. Rows inside the tree also get a wider recency
 * window (see TREE_FILE_OPS_WINDOW_DAYS).
 */
export function getRecentFileOps(
  db: Database.Database,
  objective: Objective
): RecentFileOpRow[] {
  if (!contextTreeFirstEnabled()) {
    return db.prepare(`
      SELECT sfo.file_path, sfo.operation, sfo.session_id, o.title as objective_title
      FROM session_file_ops sfo
      JOIN session_intel si ON sfo.session_id = si.session_id
      JOIN objectives o ON sfo.objective_id = o.id
      WHERE sfo.objective_id != ?
        AND sfo.operation IN ('create', 'modify')
        AND sfo.timestamp > datetime('now', '-24 hours')
      ORDER BY sfo.timestamp DESC
      LIMIT 10
    `).all(objective.id) as unknown as RecentFileOpRow[]
  }

  return db.prepare(`
    SELECT sfo.file_path, sfo.operation, sfo.session_id, o.title as objective_title,
           ${TREE_TIER_SQL} as tree_tier
    FROM session_file_ops sfo
    JOIN session_intel si ON sfo.session_id = si.session_id
    JOIN objectives o ON sfo.objective_id = o.id
    WHERE sfo.objective_id != @self
      AND sfo.operation IN ('create', 'modify')
      AND (
        sfo.timestamp > datetime('now', '-24 hours')
        OR (${TREE_TIER_SQL} <= ${MAX_TREE_TIER} AND sfo.timestamp > datetime('now', @treeWindow))
      )
    ORDER BY tree_tier ASC, sfo.timestamp DESC
    LIMIT 10
  `).all({ ...treeParams(objective), treeWindow: `-${TREE_FILE_OPS_WINDOW_DAYS} days` }) as unknown as RecentFileOpRow[]
}

/**
 * Skills the dream-cycle rollup flagged `needs_improvement` (failure rate > 20%)
 * in registry.json, scoped to a given agent role. The flag was written but never
 * read until now — this is the consumer. Never throws (returns [] on any failure)
 * so a missing/garbled registry can't break spawn-context assembly.
 */
function flaggedSkillsForAgent(agentContext: string): string[] {
  try {
    const registry = JSON.parse(fs.readFileSync(SKILLS_REGISTRY, 'utf-8'))
    const skills = (registry.skills || {}) as Record<string, Record<string, unknown>>
    const lines: string[] = []
    for (const [name, data] of Object.entries(skills)) {
      if (!data.needs_improvement) continue
      const agents = (data.agents as string[] | undefined) || []
      if (!agents.includes(agentContext)) continue
      const usage = (data.usage_count as number) || 0
      const failures = (data.failure_count as number) || 0
      const rate = usage > 0 ? Math.round((failures / usage) * 100) : 0
      lines.push(`- ⚠ ${name}: ${rate}% failure rate (${failures}/${usage} uses) — verify its steps and preconditions before relying on it.`)
    }
    return lines
  } catch {
    return []
  }
}

/**
 * Assemble cross-session context for injection into a new session's prompt.
 * Queries session_intel, session_events, and session_file_ops to build
 * a compact context package (~500-2000 tokens) that gives the agent awareness
 * of prior work, active blockers, related decisions, and file conflicts.
 */
export function buildContext(objective: Objective): string {
  const db = getDb()
  const sections: string[] = []

  // 1. Previous sessions on this objective
  const priorSessions = db.prepare(`
    SELECT session_id, summary, outcome, decisions, follow_ups, blockers, ended_at, duration_ms, total_cost_usd
    FROM session_intel
    WHERE objective_id = ? AND extraction_status IN ('parsed', 'summarized')
    ORDER BY ended_at DESC
    LIMIT 3
  `).all(objective.id) as Record<string, unknown>[]

  if (priorSessions.length > 0) {
    const lines = ['### Previous Sessions on This Objective']
    for (const s of priorSessions) {
      const date = (s.ended_at as string || '').slice(0, 10)
      const summary = s.summary || 'No summary available'
      const outcome = s.outcome || 'unknown'
      lines.push(`- [${date}] ${summary} (outcome: ${outcome})`)

      // Show follow-ups from prior sessions
      const followUps = JSON.parse((s.follow_ups as string) || '[]') as SessionFollowUp[]
      for (const fu of followUps.slice(0, 3)) {
        lines.push(`  - Follow-up needed: ${fu.task} (${fu.priority})`)
      }

      // Show unresolved blockers
      const blockers = JSON.parse((s.blockers as string) || '[]') as SessionBlocker[]
      for (const b of blockers) {
        lines.push(`  - Blocker: ${b.description} (${b.severity})`)
      }
    }
    sections.push(lines.join('\n'))
  }

  // 1b. Human corrections (ST5) — HIGHEST priority. A human has explicitly
  // labeled prior work on this objective (or a sibling objective of the same
  // agent role in this workspace) as wrong. Surface it first, before the agent
  // does anything, so the mistake is not repeated. Self-suppresses when none.
  const corrections = getCorrectionsForContext({
    objectiveId: objective.id,
    workspace: objective.workspace ?? null,
    agentContext: objective.agent_context ?? null,
  })
  if (corrections.length > 0) {
    const lines = ['### ⚠ Human Corrections (HIGH PRIORITY — do not repeat these mistakes)']
    for (const c of corrections) {
      const date = (c.created_at || '').slice(0, 10)
      const scope = c.objective_id === objective.id ? 'this objective' : `${c.workspace}/${c.agent_context}`
      lines.push(`- [${date}] (${scope}) ${c.label}`)
    }
    sections.push(lines.join('\n'))
  }

  // 2. Knowledge Gaps — flag what the agent does NOT know
  const gapLines: string[] = []

  if (priorSessions.length === 0) {
    gapLines.push('- No prior sessions — this is a fresh objective with no learned context.')
  } else {
    // Check if last session failed or was blocked
    const lastOutcome = priorSessions[0].outcome as string | null
    if (lastOutcome === 'failed' || lastOutcome === 'blocked') {
      gapLines.push(`- ⚠ Last session ${lastOutcome}. Review the summary above before proceeding.`)
    }

    // Persistent blockers: same blocker description across 2+ sessions
    const blockerCounts = new Map<string, number>()
    for (const s of priorSessions) {
      const blockers = JSON.parse((s.blockers as string) || '[]') as SessionBlocker[]
      for (const b of blockers) {
        blockerCounts.set(b.description, (blockerCounts.get(b.description) || 0) + 1)
      }
    }
    for (const [desc, count] of blockerCounts) {
      if (count >= 2) {
        gapLines.push(`- ⚠ Recurring blocker (appeared in ${count} sessions): ${desc}`)
      }
    }
  }

  // Stale follow-ups: created >7 days ago with no subsequent session
  const staleFollowUps = db.prepare(`
    SELECT se.description, se.created_at
    FROM session_events se
    WHERE se.objective_id = ?
      AND se.event_type = 'follow_up'
      AND se.created_at < datetime('now', '-7 days')
      AND NOT EXISTS (
        SELECT 1 FROM session_intel si
        WHERE si.objective_id = se.objective_id
          AND si.started_at > se.created_at
      )
    ORDER BY se.created_at DESC
    LIMIT 3
  `).all(objective.id) as Record<string, unknown>[]

  for (const fu of staleFollowUps) {
    const date = (fu.created_at as string || '').slice(0, 10)
    gapLines.push(`- Pending follow-up from ${date}: ${fu.description} — never actioned.`)
  }

  if (gapLines.length > 0) {
    sections.push(['### Knowledge Gaps', ...gapLines].join('\n'))
  }

  // 3. Active blockers across the current workspace (QW6 / audit C#5):
  // recency-windowed, workspace-scoped, own-objective deduped.
  const activeBlockers = getActiveBlockers(db, objective)

  const blockerLines: string[] = []
  for (const row of activeBlockers) {
    const blockers = JSON.parse((row.blockers as string) || '[]') as SessionBlocker[]
    for (const b of blockers) {
      blockerLines.push(`- [${b.severity}] ${b.description} (from "${row.objective_title}" / ${row.agent_context})`)
    }
  }
  if (blockerLines.length > 0) {
    sections.push(['### Active Blockers Across System', ...blockerLines.slice(0, 5)].join('\n'))
  }

  // 4. Recent decisions from same workspace or agent_context (last 48h)
  const recentDecisions = db.prepare(`
    SELECT se.description, se.metadata, o.title as objective_title, o.agent_context
    FROM session_events se
    JOIN objectives o ON se.objective_id = o.id
    WHERE se.event_type = 'decision'
      AND se.objective_id != ?
      AND se.created_at > datetime('now', '-48 hours')
      AND (o.workspace = ? OR o.agent_context = ?)
    ORDER BY se.created_at DESC
    LIMIT 5
  `).all(objective.id, objective.workspace, objective.agent_context) as Record<string, unknown>[]

  if (recentDecisions.length > 0) {
    const lines = ['### Recent Related Decisions']
    for (const d of recentDecisions) {
      const meta = d.metadata ? JSON.parse(d.metadata as string) as { rationale?: string } : {}
      const rationale = meta.rationale ? ` (rationale: ${meta.rationale})` : ''
      lines.push(`- ${d.agent_context}: ${d.description}${rationale}`)
    }
    sections.push(lines.join('\n'))
  }

  // 5. Cross-workspace context
  // 5a. Decisions from other workspaces by the same agent role (last 24h)
  if (objective.agent_context) {
    const crossWsDecisions = db.prepare(`
      SELECT se.description, se.metadata, o.title as objective_title, o.workspace
      FROM session_events se
      JOIN objectives o ON se.objective_id = o.id
      WHERE se.event_type = 'decision'
        AND se.objective_id != ?
        AND se.created_at > datetime('now', '-24 hours')
        AND o.agent_context = ?
        AND o.workspace != ?
      ORDER BY se.created_at DESC
      LIMIT 3
    `).all(objective.id, objective.agent_context, objective.workspace) as Record<string, unknown>[]

    if (crossWsDecisions.length > 0) {
      const lines = ['### Decisions from Other Workspaces (same agent role)']
      for (const d of crossWsDecisions) {
        const meta = d.metadata ? JSON.parse(d.metadata as string) as { rationale?: string } : {}
        const rationale = meta.rationale ? ` (rationale: ${meta.rationale})` : ''
        lines.push(`- [${d.workspace}] ${d.description}${rationale}`)
      }
      sections.push(lines.join('\n'))
    }
  }

  // 5b. Cross-agent blockers that mention this objective's project
  if (objective.project) {
    const projectBlockers = db.prepare(`
      SELECT se.description, o.title as objective_title, o.agent_context
      FROM session_events se
      JOIN objectives o ON se.objective_id = o.id
      WHERE se.event_type = 'blocker'
        AND se.objective_id != ?
        AND se.created_at > datetime('now', '-7 days')
        AND se.description LIKE ?
      ORDER BY se.created_at DESC
      LIMIT 3
    `).all(objective.id, `%${objective.project}%`) as Record<string, unknown>[]

    if (projectBlockers.length > 0) {
      const lines = ['### Cross-Agent Blockers Mentioning This Project']
      for (const b of projectBlockers) {
        lines.push(`- ${b.agent_context}: ${b.description} (from "${b.objective_title}")`)
      }
      sections.push(lines.join('\n'))
    }
  }

  // 6. File conflicts — files modified by other sessions in last 24h
  const recentFileOps = getRecentFileOps(db, objective)

  if (recentFileOps.length > 0) {
    const lines = ['### Recently Modified Files (by other sessions)']
    const seen = new Set<string>()
    for (const op of recentFileOps) {
      const key = op.file_path
      if (seen.has(key)) continue
      seen.add(key)
      lines.push(`- ${key} (${op.operation} by "${op.objective_title}")`)
    }
    sections.push(lines.join('\n'))
  }

  // 7. Knowledge-base hits from the second-brain vault (never throws; [] on failure)
  const kbHits = searchKnowledge(`${objective.title} ${objective.description || ''}`, objective.workspace)
  if (kbHits.length > 0) {
    const lines = ['### Knowledge Base Hits (second-brain vault)']
    lines.push('_Deeper search mid-session: use the Grep tool over `/home/operator/second-brain`, or `~/second-brain/scripts/kb_search --workspace=<ws> "<query>"` where ripgrep is available._')
    for (const h of kbHits) {
      lines.push(`- **${h.path}**`)
      lines.push(`  > ${h.snippet}`)
    }
    sections.push(lines.join('\n'))
  }

  // 8. Recurring failure modes — DELIBERATELY PLATFORM-WIDE, and deliberately
  // NOT tree-ordered by CONTEXT_TREE_FIRST (P1-2 explicitly carves this section
  // out). Unlike blockers and file ops, these rows are not per-objective facts at
  // all: the miner only promotes a signal to a lesson once it has recurred across
  // several DISTINCT objectives (SESSION_MINING_MIN_RECURRENCE), so they are
  // stored under a single sentinel session with no objective_id to rank against.
  // Their whole value is that they generalise past the tree.
  //
  // Lessons the dream-cycle session
  // miner distilled from failures recurring across many objectives. Stored under
  // the mining sentinel session as pattern/gotcha learnings; recency-bounded (the
  // miner regenerates them each cycle) and capped. Self-suppresses when empty.
  const minedLessons = db.prepare(`
    SELECT content, learning_type
    FROM objective_learnings
    WHERE session_id = ?
      AND learning_type IN ('pattern', 'gotcha')
      AND created_at > datetime('now', '-${SESSION_MINING_LOOKBACK_DAYS} days')
    ORDER BY created_at DESC
    LIMIT ${SESSION_MINING_MAX_SURFACED}
  `).all(SESSION_MINING_SENTINEL) as { content: string; learning_type: string }[]

  if (minedLessons.length > 0) {
    const lines = ['### Recurring Failure Modes (platform-wide)']
    for (const l of minedLessons) {
      lines.push(`- ⚠ [${l.learning_type}] ${l.content}`)
    }
    sections.push(lines.join('\n'))
  }

  // 9. Skills flagged for improvement — the dream-cycle rollup marks skills whose
  // failure rate exceeds the threshold; surface those relevant to this agent role
  // so the session treats them with extra care. Self-suppresses when none.
  const flaggedSkills = flaggedSkillsForAgent(objective.agent_context)
  if (flaggedSkills.length > 0) {
    sections.push(['### Skills Flagged for Improvement', ...flaggedSkills].join('\n'))
  }

  if (sections.length === 0) return ''

  return '## Session Context (auto-assembled)\n\n' + sections.join('\n\n')
}
