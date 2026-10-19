/**
 * dev_feedback ↔ CC-objective bridge (obj 711117 W4; multi-workspace obj 712905).
 *
 * Bridges each platform's dev_feedback table with Command Center board
 * objectives. The bridge iterates DEV_FEEDBACK_INSTANCES (one per workspace:
 * example2, example-project) and runs two idempotent passes per instance every tick.
 * An instance whose required env is missing is skipped with a log line naming
 * the missing vars — it never blocks the other instances.
 *
 * PASS A — INTAKE:
 *   GET <baseUrl><pendingPath> → for each item,
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
 *   - Intake: objectives (dev_feedback_source, dev_feedback_uuid) UNIQUE index
 *     prevents duplicates. dev_feedback_source is the instance workspace, so a
 *     WS uuid and a EXAMPLE2 uuid can never collide (and Pass B only ever pushes an
 *     instance's own rows back to that instance's platform)
 *     even when the process crashes between objective creation and sync POST.
 *     On the next run the pending endpoint returns only rows with
 *     cc_objective_id IS NULL; if the objective was created but sync failed,
 *     the bridge re-detects via the UUID lookup and re-tries the sync POST.
 *   - Status push: only POSTs when the mapped status differs from the last
 *     known kanban_status stored on the CC objective row; the platform sync
 *     endpoint is idempotent regardless.
 *
 * Config (per instance — see DEV_FEEDBACK_INSTANCES):
 *   example2:
 *     EXAMPLE2_PLATFORM_BASE_URL   — base URL of the example2 platform (e.g. https://app.example2.ai)
 *     EXAMPLE2_INTERNAL_API_SECRET — shared secret for x-internal-secret header
 *   example-project (Supabase edge function `dev-feedback-internal`):
 *     WS_DEV_FEEDBACK_INTERNAL_SECRET — x-internal-secret (== Supabase secret DEV_FEEDBACK_INTERNAL_SECRET)
 *     WS_DEV_FEEDBACK_BASE_URL  — https://<project-ref>.supabase.co/functions/v1/dev-feedback-internal
 *                                 (CC global secret; kept out of source so the OSS publish gate passes)
 *     WS_DEV_FEEDBACK_ANON_KEY  — optional; sent as `Authorization: Bearer` + `apikey`
 *                                 (needed unless the function is deployed --no-verify-jwt)
 *   shared:
 *     DEV_FEEDBACK_BRIDGE_TICK_MS — poll cadence in ms (default 120_000 = 2 min)
 *     DEV_FEEDBACK_BRIDGE_ENABLED — set to 'false' to disable (default enabled)
 *
 * Loud failures: any missing config or HTTP error is logged at error level with
 * the full detail; no exception is ever silently swallowed.
 */

import { getDb } from '../db/index.js'
import { broadcast } from '../ws/index.js'

const PORT = parseInt(process.env.PORT || '3002', 10)

// ── Instances ────────────────────────────────────────────────────────────────

/** One platform the bridge syncs with. Keyed by CC workspace. */
export interface DevFeedbackInstance {
  /** CC workspace for created objectives; also the dev_feedback_source key. */
  workspace: string
  project: string
  agentContext: string
  /** Env var holding the platform base URL (no trailing slash needed). */
  baseUrlEnv: string
  /** Used when baseUrlEnv is unset. Omit to make baseUrlEnv required. */
  defaultBaseUrl?: string
  pendingPath: string
  syncPath: string
  /** Env var holding the x-internal-secret value. Required. */
  secretEnv: string
  /** Optional env var; when set its value is sent as `Authorization: Bearer <v>` and `apikey: <v>`. */
  bearerEnv?: string
  /**
   * Include the dev_feedback `id` in Pass B status pushes. The example2 sync
   * route resolves by cc_objective_id (historic payload kept byte-identical);
   * the WS edge-function contract requires `id`.
   */
  statusPushIncludesId: boolean
}

export const EXAMPLE2_INSTANCE: DevFeedbackInstance = {
  workspace: 'example2',
  project: 'example3-platform',
  agentContext: 'cto',
  baseUrlEnv: 'EXAMPLE2_PLATFORM_BASE_URL',
  pendingPath: '/api/internal/dev-feedback/pending',
  syncPath: '/api/internal/dev-feedback/sync',
  secretEnv: 'EXAMPLE2_INTERNAL_API_SECRET',
  statusPushIncludesId: false,
}

export const WEIGHT_SUPPLY_INSTANCE: DevFeedbackInstance = {
  workspace: 'example-project',
  project: 'example-project-platform',
  agentContext: 'cto',
  baseUrlEnv: 'WS_DEV_FEEDBACK_BASE_URL',
  pendingPath: '/pending',
  syncPath: '/sync',
  secretEnv: 'WS_DEV_FEEDBACK_INTERNAL_SECRET',
  bearerEnv: 'WS_DEV_FEEDBACK_ANON_KEY',
  statusPushIncludesId: true,
}

export const DEV_FEEDBACK_INSTANCES: readonly DevFeedbackInstance[] = [EXAMPLE2_INSTANCE, WEIGHT_SUPPLY_INSTANCE]

/** An instance with its env resolved — what the passes actually run against. */
export interface ResolvedInstance {
  def: DevFeedbackInstance
  baseUrl: string
  secret: string
  /** Extra headers (e.g. Supabase anon bearer) sent on every platform request. */
  headers: Record<string, string>
}

/** List the required env vars that are missing for an instance. */
function missingEnv(inst: DevFeedbackInstance, env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = []
  if (!env[inst.baseUrlEnv] && !inst.defaultBaseUrl) missing.push(inst.baseUrlEnv)
  if (!env[inst.secretEnv]) missing.push(inst.secretEnv)
  return missing
}

/** Validate an instance's env. Returns an error string if any are missing, null if OK. */
export function validateInstanceConfig(
  inst: DevFeedbackInstance,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const missing = missingEnv(inst, env)
  if (missing.length > 0) {
    return `[dev-feedback-bridge:${inst.workspace}] MISSING required env vars: ${missing.join(', ')}. Instance skipped until they are set.`
  }
  return null
}

/** Back-compat: validate the example2 instance (pre-712905 signature). */
export function validateConfig(env: NodeJS.ProcessEnv = process.env): string | null {
  return validateInstanceConfig(EXAMPLE2_INSTANCE, env)
}

/** Resolve an instance's env, or null when required env is missing. */
export function resolveInstance(
  inst: DevFeedbackInstance,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedInstance | null {
  if (missingEnv(inst, env).length > 0) return null
  const headers: Record<string, string> = {}
  const bearer = inst.bearerEnv ? env[inst.bearerEnv] : undefined
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`
    headers.apikey = bearer
  }
  return {
    def: inst,
    baseUrl: (env[inst.baseUrlEnv] || inst.defaultBaseUrl!).replace(/\/$/, ''),
    secret: env[inst.secretEnv]!,
    headers,
  }
}

/** Accept the legacy (baseUrl, secret) call shape → example2 instance. */
function toResolved(target: string | ResolvedInstance, secret?: string): ResolvedInstance {
  if (typeof target !== 'string') return target
  return { def: EXAMPLE2_INSTANCE, baseUrl: target, secret: secret ?? '', headers: {} }
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
  screenshot_path?: string | null
  screenshot_url: string | null
  route?: string | null
  /** WS contract only. */
  submitter_name?: string | null
  submitter_email?: string | null
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
  if (item.submitter_name || item.submitter_email) {
    const who = [item.submitter_name, item.submitter_email ? `<${item.submitter_email}>` : null].filter(Boolean).join(' ')
    lines.push(`**Submitted by:** ${who}`)
  }
  lines.push(`\n*Submitted via dev_feedback (id: ${item.id})*`)
  return lines.join('\n\n')
}

/** Fetch pending dev_feedback items from the platform. */
async function fetchPending(inst: ResolvedInstance): Promise<PendingItem[]> {
  const url = `${inst.baseUrl}${inst.def.pendingPath}`
  const res = await fetch(url, {
    headers: { ...inst.headers, 'x-internal-secret': inst.secret },
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
  inst: ResolvedInstance,
  payload: {
    id?: string
    cc_objective_id?: number
    kanban_status?: KanbanStatus
    fix_summary?: string
    pr_url?: string
  },
): Promise<void> {
  const url = `${inst.baseUrl}${inst.def.syncPath}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...inst.headers,
      'Content-Type': 'application/json',
      'x-internal-secret': inst.secret,
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
  target: string | ResolvedInstance,
  secret?: string,
): Promise<{ created: number; synced: number; skipped: number }> {
  const inst = toResolved(target, secret)
  const { workspace } = inst.def
  const items = await fetchPending(inst)
  let created = 0
  let synced = 0
  let skipped = 0

  for (const item of items) {
    try {
      const db = getDb()
      // Check for existing objective by UUID (crash-safe idempotency).
      const existing = db
        .prepare(`SELECT id, status FROM objectives WHERE dev_feedback_source = ? AND dev_feedback_uuid = ?`)
        .get(workspace, item.id) as { id: number; status: string } | undefined

      let objId: number
      if (existing) {
        // Objective exists — platform pending endpoint returned it because sync
        // failed previously (cc_objective_id is still NULL on the platform row).
        // Re-try the sync POST only.
        objId = existing.id
        console.log(`[dev-feedback-bridge:${workspace}] intake: existing objective ${objId} for feedback ${item.id} — re-syncing`)
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
              workspace,
              project: inst.def.project,
              type: 'task',
              agent_context: inst.def.agentContext,
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
        db.prepare(`UPDATE objectives SET dev_feedback_uuid = ?, dev_feedback_source = ? WHERE id = ?`).run(item.id, workspace, objId)
        console.log(`[dev-feedback-bridge:${workspace}] intake: created objective ${objId} for feedback ${item.id} (${item.type}: ${item.title})`)
        created++
      }

      // POST sync to mark as 'working' and record the cc_objective_id.
      await postSync(inst, {
        id: item.id,
        cc_objective_id: objId,
        kanban_status: 'working',
      })
      synced++
      console.log(`[dev-feedback-bridge:${workspace}] intake: synced feedback ${item.id} → objective ${objId}`)
    } catch (err) {
      // Never abort the whole pass on a single-item failure.
      console.error(`[dev-feedback-bridge:${workspace}] intake: error processing feedback ${item.id}:`, err)
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
  target: string | ResolvedInstance,
  secret?: string,
): Promise<{ pushed: number; skipped: number; errors: number }> {
  const inst = toResolved(target, secret)
  const { workspace } = inst.def
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, status, dev_feedback_uuid, last_session_summary, pr_url, last_known_kanban_status
       FROM objectives
       WHERE dev_feedback_uuid IS NOT NULL AND dev_feedback_source = ?`,
    )
    .all(workspace) as BridgedObjective[]

  let pushed = 0
  let skipped = 0
  let errors = 0

  for (const row of rows) {
    try {
      const kanban = mapCcStatusToKanban(row.status)
      if (kanban === null) {
        // cancelled — log and skip, do not change the platform card.
        console.log(`[dev-feedback-bridge:${workspace}] status-push: objective ${row.id} is cancelled — leaving platform card unchanged`)
        skipped++
        continue
      }

      // Only push when the mapped status differs from last known.
      if (row.last_known_kanban_status === kanban) {
        skipped++
        continue
      }

      const payload: Parameters<typeof postSync>[1] = {
        cc_objective_id: row.id,
        kanban_status: kanban,
      }
      if (inst.def.statusPushIncludesId) payload.id = row.dev_feedback_uuid
      if (kanban === 'waiting') {
        // Include fix context so the downstream email can show the fix overview.
        if (row.last_session_summary) payload.fix_summary = row.last_session_summary
        if (row.pr_url) payload.pr_url = row.pr_url
      }

      await postSync(inst, payload)
      // Record the pushed status so the next tick is a no-op if nothing changed.
      db.prepare(`UPDATE objectives SET last_known_kanban_status = ? WHERE id = ?`).run(kanban, row.id)
      console.log(`[dev-feedback-bridge:${workspace}] status-push: objective ${row.id} (${row.dev_feedback_uuid}) → ${kanban}`)
      pushed++
    } catch (err) {
      console.error(`[dev-feedback-bridge:${workspace}] status-push: error for objective ${row.id}:`, err)
      errors++
    }
  }

  return { pushed, skipped, errors }
}

// ── Full bridge run ───────────────────────────────────────────────────────────

export interface InstanceRunResult {
  workspace: string
  status: 'ran' | 'skipped' | 'error'
  summary: string
  missingEnv?: string[]
  error?: string
}

export interface BridgeRunResult {
  /** false iff any instance errored (a skipped instance is not an error). */
  ok: boolean
  summary: string
  instances: InstanceRunResult[]
}

/** Run both passes for one instance. Never throws — failures land in the result. */
async function runInstanceOnce(inst: DevFeedbackInstance, env: NodeJS.ProcessEnv): Promise<InstanceRunResult> {
  const resolved = resolveInstance(inst, env)
  if (!resolved) {
    const summary = validateInstanceConfig(inst, env)!
    console.log(summary)
    return { workspace: inst.workspace, status: 'skipped', summary, missingEnv: missingEnv(inst, env) }
  }
  try {
    const intakeResult = await runIntakePass(resolved)
    const pushResult = await runStatusPushPass(resolved)
    const summary = `[dev-feedback-bridge:${inst.workspace}] run complete — intake: ${intakeResult.created} created, ${intakeResult.synced} synced; status-push: ${pushResult.pushed} pushed, ${pushResult.skipped} skipped, ${pushResult.errors} errors`
    console.log(summary)
    return { workspace: inst.workspace, status: 'ran', summary }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const summary = `[dev-feedback-bridge:${inst.workspace}] run FAILED — ${message}`
    console.error(summary)
    return { workspace: inst.workspace, status: 'error', summary, error: message }
  }
}

/**
 * Run every instance (or only `opts.workspace`). Instances run sequentially so
 * their SQLite writes and localhost objective-creates never interleave.
 * Throws on an unknown workspace name.
 */
export async function runDevFeedbackBridge(
  env: NodeJS.ProcessEnv = process.env,
  opts: { workspace?: string; instances?: readonly DevFeedbackInstance[] } = {},
): Promise<BridgeRunResult> {
  const all = opts.instances ?? DEV_FEEDBACK_INSTANCES
  const selected = opts.workspace ? all.filter((i) => i.workspace === opts.workspace) : all
  if (opts.workspace && selected.length === 0) {
    throw new Error(`unknown dev-feedback workspace '${opts.workspace}' (known: ${all.map((i) => i.workspace).join(', ')})`)
  }
  const instances: InstanceRunResult[] = []
  for (const inst of selected) instances.push(await runInstanceOnce(inst, env))
  return {
    ok: instances.every((r) => r.status !== 'error'),
    summary: instances.map((r) => r.summary).join('\n'),
    instances,
  }
}

/** Run both passes once for every instance. Returns the summary log line(s). */
export async function runDevFeedbackBridgeOnce(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return (await runDevFeedbackBridge(env)).summary
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

  for (const inst of DEV_FEEDBACK_INSTANCES) {
    const configErr = validateInstanceConfig(inst)
    // Log but don't crash the server — env vars might be set later via secrets hydration.
    if (configErr) console.log(`[dev-feedback-bridge] startup: ${configErr}`)
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
