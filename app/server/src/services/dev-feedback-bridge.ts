/**
 * dev_feedback ↔ CC-objective bridge (obj 711117 W4).
 *
 * Bridges the example2 platform's dev_feedback table with Command Center board
 * objectives, running two idempotent passes every tick:
 *
 * PASS A — INTAKE:
 *   GET <PLATFORM_BASE>/api/internal/dev-feedback/pending → for each item,
 *   create a CC objective (if one doesn't already exist keyed by the
 *   dev_feedback UUID) then POST sync { id, cc_objective_id, kanban_status:'working' }.
 *
 * PASS B — STATUS PUSH:
 *   Query all CC objectives tagged with a dev_feedback_uuid, map their
 *   current CC status to the kanban vocabulary, and POST sync when the
 *   mapped value differs from what the platform currently knows.
 *
 * CC status → kanban mapping (binding):
 *   planning | queue | working | ai_review  → 'working'
 *   review                                  → 'waiting' (+ fix_summary + pr_url)
 *   done                                    → 'done'
 *   cancelled                               → no change (logged, skipped)
 *
 * Idempotency guards:
 *   - Intake: objectives.dev_feedback_uuid UNIQUE index prevents duplicates
 *     even when the process crashes between objective creation and sync POST.
 *     On the next run the pending endpoint returns only rows with
 *     cc_objective_id IS NULL; if the objective was created but sync failed,
 *     the bridge re-detects via the UUID lookup and re-tries the sync POST.
 *   - Status push: only POSTs when the mapped status differs from the last
 *     known kanban_status stored on the CC objective row; the platform sync
 *     endpoint is idempotent regardless.
 *
 * Config:
 *   EXAMPLE2_PLATFORM_BASE_URL  — base URL of the example2 platform (e.g. https://app.example2.ai)
 *   EXAMPLE2_INTERNAL_API_SECRET — shared secret for x-internal-secret header
 *   DEV_FEEDBACK_BRIDGE_TICK_MS — poll cadence in ms (default 120_000 = 2 min)
 *   DEV_FEEDBACK_BRIDGE_ENABLED — set to 'false' to disable (default enabled)
 *
 * Loud failures: any missing config or HTTP error is logged at error level with
 * the full detail; no exception is ever silently swallowed.
 */

import { getDb } from '../db/index.js'
import { broadcast } from '../ws/index.js'

const PORT = parseInt(process.env.PORT || '3002', 10)

// ── Config validation ────────────────────────────────────────────────────────

/** Validate required env vars. Returns an error string if any are missing, null if OK. */
export function validateConfig(env: NodeJS.ProcessEnv = process.env): string | null {
  const missing: string[] = []
  if (!env.EXAMPLE2_PLATFORM_BASE_URL) missing.push('EXAMPLE2_PLATFORM_BASE_URL')
  if (!env.EXAMPLE2_INTERNAL_API_SECRET) missing.push('EXAMPLE2_INTERNAL_API_SECRET')
  if (missing.length > 0) {
    return `[dev-feedback-bridge] MISSING required env vars: ${missing.join(', ')}. Bridge is disabled until they are set.`
  }
  return null
}

// ── Status mapping (pure, testable) ──────────────────────────────────────────

export type CcStatus = 'planning' | 'queue' | 'working' | 'ai_review' | 'review' | 'done' | 'cancelled'
export type KanbanStatus = 'working' | 'waiting' | 'done'

/**
 * Map a CC objective status to the platform kanban vocabulary.
 * Returns null for 'cancelled' (no status change should be sent).
 */
export function mapCcStatusToKanban(ccStatus: CcStatus): KanbanStatus | null {
  switch (ccStatus) {
    case 'planning':
    case 'queue':
    case 'working':
    case 'ai_review':
      return 'working'
    case 'review':
      return 'waiting'
    case 'done':
      return 'done'
    case 'cancelled':
      return null
    default: {
      const _exhaust: never = ccStatus
      console.warn(`[dev-feedback-bridge] unknown CC status '${String(_exhaust)}' — skipping`)
      return null
    }
  }
}

// ── Platform API helpers ──────────────────────────────────────────────────────

interface PendingItem {
  id: string
  type: 'bug' | 'feature'
  title: string
  description: string | null
  steps_to_repro: string | null
  expected_behavior: string | null
  actual_behavior: string | null
  page_url: string | null
  severity: string | null
  screenshot_path: string | null
  screenshot_url: string | null
  route: string | null
  created_at: string
}

/** Build the objective description from a pending item, embedding all submission fields. */
export function buildObjectiveDescription(item: PendingItem): string {
  const lines: string[] = []
  if (item.description) lines.push(`**Description:**\n${item.description}`)
  if (item.steps_to_repro) lines.push(`**Steps to Reproduce:**\n${item.steps_to_repro}`)
  if (item.expected_behavior) lines.push(`**Expected Behavior:**\n${item.expected_behavior}`)
  if (item.actual_behavior) lines.push(`**Actual Behavior:**\n${item.actual_behavior}`)
  if (item.page_url) lines.push(`**Page URL:** ${item.page_url}`)
  if (item.route) lines.push(`**Route:** ${item.route}`)
  if (item.severity) lines.push(`**Severity:** ${item.severity}`)
  if (item.screenshot_url) lines.push(`**Screenshot:** ${item.screenshot_url}`)
  lines.push(`\n*Submitted via dev_feedback (id: ${item.id})*`)
  return lines.join('\n\n')
}

/** Fetch pending dev_feedback items from the platform. */
async function fetchPending(baseUrl: string, secret: string): Promise<PendingItem[]> {
  const url = `${baseUrl}/api/internal/dev-feedback/pending`
  const res = await fetch(url, {
    headers: { 'x-internal-secret': secret },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET ${url} → ${res.status}: ${body}`)
  }
  const json = (await res.json()) as { items: PendingItem[] }
  return json.items ?? []
}

/** POST a sync update to the platform. */
async function postSync(
  baseUrl: string,
  secret: string,
  payload: {
    id?: string
    cc_objective_id?: number
    kanban_status?: KanbanStatus
    fix_summary?: string
    pr_url?: string
  },
): Promise<void> {
  const url = `${baseUrl}/api/internal/dev-feedback/sync`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': secret,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`POST ${url} → ${res.status}: ${body}`)
  }
}

// ── Pass A: intake ────────────────────────────────────────────────────────────

/**
 * Create CC objectives for pending dev_feedback items.
 * Idempotent: skips items where an objective already exists (by dev_feedback_uuid).
 * If a prior run created the objective but failed to sync, re-tries the sync POST.
 */
export async function runIntakePass(
  baseUrl: string,
  secret: string,
): Promise<{ created: number; synced: number; skipped: number }> {
  const items = await fetchPending(baseUrl, secret)
  let created = 0
  let synced = 0
  let skipped = 0

  for (const item of items) {
    try {
      const db = getDb()
      // Check for existing objective by UUID (crash-safe idempotency).
      const existing = db
        .prepare(`SELECT id, status FROM objectives WHERE dev_feedback_uuid = ?`)
        .get(item.id) as { id: number; status: string } | undefined

      let objId: number
      if (existing) {
        // Objective exists — platform pending endpoint returned it because sync
        // failed previously (cc_objective_id is still NULL on the platform row).
        // Re-try the sync POST only.
        objId = existing.id
        console.log(`[dev-feedback-bridge] intake: existing objective ${objId} for feedback ${item.id} — re-syncing`)
      } else {
        // Create the CC objective.
        const title = `[${item.type}] ${item.title}`
        const description = buildObjectiveDescription(item)
        const createRes = await fetch(`http://localhost:${PORT}/api/internal/objectives`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify([
            {
              title,
              description,
              workspace: 'example2',
              project: 'example3-platform',
              type: 'task',
              agent_context: 'cto',
            },
          ]),
        })
        if (!createRes.ok) {
          const body = await createRes.text().catch(() => '')
          throw new Error(`create objective → ${createRes.status}: ${body}`)
        }
        const body = (await createRes.json()) as { objectives: Array<{ id: number }> }
        objId = body.objectives[0].id
        // Record the dev_feedback_uuid on the objective immediately — this is
        // the crash-safety anchor. If the sync POST below fails, the next run
        // finds this row and re-tries without creating a duplicate.
        db.prepare(`UPDATE objectives SET dev_feedback_uuid = ? WHERE id = ?`).run(item.id, objId)
        console.log(`[dev-feedback-bridge] intake: created objective ${objId} for feedback ${item.id} (${item.type}: ${item.title})`)
        created++
      }

      // POST sync to mark as 'working' and record the cc_objective_id.
      await postSync(baseUrl, secret, {
        id: item.id,
        cc_objective_id: objId,
        kanban_status: 'working',
      })
      synced++
      console.log(`[dev-feedback-bridge] intake: synced feedback ${item.id} → objective ${objId}`)
    } catch (err) {
      // Never abort the whole pass on a single-item failure.
      console.error(`[dev-feedback-bridge] intake: error processing feedback ${item.id}:`, err)
    }
  }

  return { created, synced, skipped }
}

// ── Pass B: status push ───────────────────────────────────────────────────────

interface BridgedObjective {
  id: number
  status: CcStatus
  dev_feedback_uuid: string
  last_session_summary: string | null
  pr_url: string | null
  last_known_kanban_status: string | null
}

/**
 * Push CC objective status changes back to the platform for all bridged items.
 * Only POSTs when the mapped kanban status differs from what the platform knows.
 */
export async function runStatusPushPass(
  baseUrl: string,
  secret: string,
): Promise<{ pushed: number; skipped: number; errors: number }> {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, status, dev_feedback_uuid, last_session_summary, pr_url, last_known_kanban_status
       FROM objectives
       WHERE dev_feedback_uuid IS NOT NULL`,
    )
    .all() as BridgedObjective[]

  let pushed = 0
  let skipped = 0
  let errors = 0

  for (const row of rows) {
    try {
      const kanban = mapCcStatusToKanban(row.status)
      if (kanban === null) {
        // cancelled — log and skip, do not change the platform card.
        console.log(`[dev-feedback-bridge] status-push: objective ${row.id} is cancelled — leaving platform card unchanged`)
        skipped++
        continue
      }

      // Only push when the mapped status differs from last known.
      if (row.last_known_kanban_status === kanban) {
        skipped++
        continue
      }

      const payload: Parameters<typeof postSync>[2] = {
        cc_objective_id: row.id,
        kanban_status: kanban,
      }
      if (kanban === 'waiting') {
        // Include fix context so the downstream email can show the fix overview.
        if (row.last_session_summary) payload.fix_summary = row.last_session_summary
        if (row.pr_url) payload.pr_url = row.pr_url
      }

      await postSync(baseUrl, secret, payload)
      // Record the pushed status so the next tick is a no-op if nothing changed.
      db.prepare(`UPDATE objectives SET last_known_kanban_status = ? WHERE id = ?`).run(kanban, row.id)
      console.log(`[dev-feedback-bridge] status-push: objective ${row.id} (${row.dev_feedback_uuid}) → ${kanban}`)
      pushed++
    } catch (err) {
      console.error(`[dev-feedback-bridge] status-push: error for objective ${row.id}:`, err)
      errors++
    }
  }

  return { pushed, skipped, errors }
}

// ── Full bridge run ───────────────────────────────────────────────────────────

/** Run both passes once. Returns a summary log line. */
export async function runDevFeedbackBridgeOnce(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const configErr = validateConfig(env)
  if (configErr) {
    console.error(configErr)
    return configErr
  }

  const baseUrl = env.EXAMPLE2_PLATFORM_BASE_URL!.replace(/\/$/, '')
  const secret = env.EXAMPLE2_INTERNAL_API_SECRET!

  const intakeResult = await runIntakePass(baseUrl, secret)
  const pushResult = await runStatusPushPass(baseUrl, secret)

  const summary = `[dev-feedback-bridge] run complete — intake: ${intakeResult.created} created, ${intakeResult.synced} synced; status-push: ${pushResult.pushed} pushed, ${pushResult.skipped} skipped, ${pushResult.errors} errors`
  console.log(summary)
  return summary
}

// ── Scheduler ────────────────────────────────────────────────────────────────

const DEFAULT_TICK_MS = 2 * 60 * 1000 // 2 minutes

let timer: ReturnType<typeof setInterval> | null = null

export function startDevFeedbackBridge(): void {
  if (process.env.DEV_FEEDBACK_BRIDGE_ENABLED === 'false') {
    console.log('[dev-feedback-bridge] disabled via DEV_FEEDBACK_BRIDGE_ENABLED=false')
    return
  }
  if (timer) return

  const tickMs = parseInt(process.env.DEV_FEEDBACK_BRIDGE_TICK_MS || '', 10)
  const resolvedTickMs = Number.isInteger(tickMs) && tickMs > 0 ? tickMs : DEFAULT_TICK_MS

  const configErr = validateConfig()
  if (configErr) {
    // Log loud but don't crash the server — env vars might be set later via secrets hydration.
    console.error(`[dev-feedback-bridge] startup: ${configErr}`)
  }

  console.log(`[dev-feedback-bridge] starting, tick every ${resolvedTickMs / 1000}s`)

  // Run immediately on startup, then on interval.
  runDevFeedbackBridgeOnce().catch((err) => {
    console.error('[dev-feedback-bridge] boot tick error:', err)
  })

  timer = setInterval(() => {
    runDevFeedbackBridgeOnce().catch((err) => {
      console.error('[dev-feedback-bridge] tick error:', err)
    })
  }, resolvedTickMs)
  timer.unref()
}

export function stopDevFeedbackBridge(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
