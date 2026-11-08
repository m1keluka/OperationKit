/**
 * The ONE guarded path from a bot conversation to a board job (obj 900323).
 *
 * Gates G1-G4 and G12 all live here, because they are all the same decision:
 * *may this message become a card, and if so, exactly one card?*
 *
 * Order matters, and each step answers a question the next one may not re-ask:
 *
 *  1. **Authorize** (`bot-authorization.ts`) — person × bot × workspace, all
 *     supplied and all validated. Never inferred from a key label.
 *  2. **Idempotency** — `(thread_user_id, thread_agent_slug, idempotency_key)`
 *     is UNIQUE. A retried tool call, a double-submitted message and a provider
 *     that replays the same tool_use id all return the SAME card id with
 *     `reused: true`. This is exact-match replay protection, which the title
 *     guard below cannot provide.
 *  3. **Duplicate guard** — the existing `lib/objective-dedupe.ts` window, reused
 *     rather than reimplemented, so a bot that asks the same thing in different
 *     words-but-same-title does not open a second card. `force` overrides, and
 *     the refusal is recorded through the existing `recordDedupe` telemetry.
 *  4. **Job mode** — `read_only` only. The MVP ships no write mode at all; the
 *     column has a CHECK constraint so a future mode is a migration, not a typo.
 *  5. **Start decision** (`bot-job-start.ts`) — a bounded auto-start requires an
 *     EXPLICIT finite ceiling. No ceiling → the card is filed in `queue` with
 *     `start_mode = 'manual'`. Filing is not starting.
 *
 * The card is a perfectly ordinary board card. Nothing here is a parallel board:
 * it writes `objectives` + `agent_chat_cards` exactly as the existing chat tool
 * does, and adds ONE row (`bot_job_origins`) recording who asked and from where.
 */
import type { Database } from 'better-sqlite3'
import { getInitialStatus } from '@operationkit/shared'
import { depthForParent } from '../../lib/objective-depth.js'
import { findOpenDuplicate, isDuplicateGuardEnabled, recordDedupe } from '../../lib/objective-dedupe.js'
import { authorizeBotJob, type AuthorizeRefusal, type BotJobPrincipal } from './bot-authorization.js'
import { claimBotJobSession, decideBotJobStart, type StartDecision } from './bot-job-start.js'

/** The only job mode the MVP supports. Read-only is the whole security story. */
export const MVP_JOB_MODE = 'read_only' as const

export interface BotJobOrigin {
  objective_id: number
  thread_user_id: number
  thread_agent_slug: string
  owner_bot: string
  owner_user_id: number
  workspace: string
  job_mode: string
  idempotency_key: string
  start_mode: string
  created_at: string
}

export interface CreateBotJobInput {
  userId: number
  agentSlug: string
  ownerBot: unknown
  workspace: unknown
  title: string
  description: string
  /** Caller-stable key. A retry MUST reuse it; that is what makes G2 work. */
  idempotencyKey: string
  /** Who filled the card in (defaults to the requesting person). */
  agentContext?: string
  /** Skip the title duplicate guard (never skips idempotency). */
  force?: boolean
  now?: Date
}

export type CreateBotJobResult =
  | { ok: true; objectiveId: number; status: string; reused: boolean; reason: 'created' | 'idempotent_replay'; start: StartDecision; origin: BotJobOrigin }
  | { ok: false; code: AuthorizeRefusal | 'duplicate' | 'invalid'; error: string; existingId?: number }

function trimmed(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

export function getJobOrigin(db: Database, objectiveId: number): BotJobOrigin | null {
  return (db.prepare('SELECT * FROM bot_job_origins WHERE objective_id = ?').get(objectiveId) as BotJobOrigin | undefined) ?? null
}

export function findJobByIdempotency(db: Database, userId: number, agentSlug: string, key: string): BotJobOrigin | null {
  return (
    (db
      .prepare('SELECT * FROM bot_job_origins WHERE thread_user_id = ? AND thread_agent_slug = ? AND idempotency_key = ?')
      .get(userId, agentSlug, key) as BotJobOrigin | undefined) ?? null
  )
}

/** Every job this thread filed, newest first. The thread's own view of its work. */
export function listThreadJobs(db: Database, userId: number, agentSlug: string, limit = 20): (BotJobOrigin & { title: string; status: string })[] {
  return db
    .prepare(
      `SELECT g.*, o.title, o.status
         FROM bot_job_origins g JOIN objectives o ON o.id = g.objective_id
        WHERE g.thread_user_id = ? AND g.thread_agent_slug = ?
        ORDER BY g.objective_id DESC LIMIT ?`,
    )
    .all(userId, agentSlug, limit) as (BotJobOrigin & { title: string; status: string })[]
}

export function createBotJob(db: Database, input: CreateBotJobInput): CreateBotJobResult {
  const title = trimmed(input.title, 200)
  if (!title) return { ok: false, code: 'invalid', error: 'title is required' }
  const idempotencyKey = trimmed(input.idempotencyKey, 200)
  if (!idempotencyKey) {
    return { ok: false, code: 'invalid', error: 'idempotency_key is required — a bot job must be replay-safe by construction, not by hoping the caller never retries.' }
  }

  const auth = authorizeBotJob(db, {
    userId: input.userId,
    agentSlug: input.agentSlug,
    ownerBot: input.ownerBot,
    workspace: input.workspace,
  })
  if (!auth.ok) return { ok: false, code: auth.code, error: auth.error }
  const principal: BotJobPrincipal = auth.principal

  // (2) Exact replay. Checked BEFORE the title guard so a retry is a quiet
  // success rather than a "duplicate" refusal the caller has to interpret.
  const replay = findJobByIdempotency(db, principal.userId, principal.agentSlug, idempotencyKey)
  if (replay) {
    const row = db.prepare('SELECT status FROM objectives WHERE id = ?').get(replay.objective_id) as { status: string } | undefined
    return {
      ok: true,
      objectiveId: replay.objective_id,
      status: row?.status ?? 'unknown',
      reused: true,
      reason: 'idempotent_replay',
      start: { allowed: false, mode: replay.start_mode === 'auto' ? 'auto' : 'manual', code: 'replay', reason: 'Existing job returned unchanged; no second start.' },
      origin: replay,
    }
  }

  // (3) Same-title guard, reusing the board's own rules.
  if (!input.force && isDuplicateGuardEnabled(db)) {
    const twin = findOpenDuplicate(db, { title, workspace: principal.workspace, now: input.now })
    if (twin) {
      recordDedupe({ event: 'duplicate_refused', existingId: twin.id, title, workspace: principal.workspace, source: 'bot_job create' })
      return {
        ok: false,
        code: 'duplicate',
        error: `An open card with this title already exists in ${principal.workspace} (#${twin.id}, ${twin.status}). Follow it up instead of filing a second one, or pass force to file anyway.`,
        existingId: twin.id,
      }
    }
  }

  const body = [
    trimmed(input.description, 20_000),
    '',
    `— Filed from the ${principal.bot.name} conversation by ${principal.username}. Results go back to that same conversation.`,
    `— Job mode: ${MVP_JOB_MODE}. This job may READ; it may not send, post, purchase or delete.`,
  ].join('\n')

  const created = db.transaction((): { id: number; status: string } => {
    const status = getInitialStatus('task')
    const info = db
      .prepare(
        `INSERT INTO objectives (title, description, agent_context, workspace, category, depth, assigned_user_id, created_by, type, status, origin, owner_bot)
         VALUES (?, ?, ?, ?, 'general', ?, ?, ?, 'task', ?, 'agent_chat', ?)`,
      )
      .run(
        title,
        body,
        trimmed(input.agentContext, 60) || principal.agentSlug,
        principal.workspace,
        depthForParent(db, null),
        principal.userId,
        principal.userId,
        status,
        principal.bot.id,
      )
    const id = Number(info.lastInsertRowid)
    // The thread linkage the existing chat UI already reads.
    db.prepare('INSERT OR IGNORE INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, ?)').run(id, principal.userId, principal.agentSlug)
    db.prepare(
      `INSERT INTO bot_job_origins (objective_id, thread_user_id, thread_agent_slug, owner_bot, owner_user_id, workspace, job_mode, idempotency_key, start_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
    ).run(id, principal.userId, principal.agentSlug, principal.bot.id, principal.userId, principal.workspace, MVP_JOB_MODE, idempotencyKey)
    return { id, status }
  })()

  // (5) Filing is not starting. The start decision is recorded on the origin row
  // so "why is this card sitting in queue" has an answer a person can read.
  const start = decideBotJobStart(db, { objectiveId: created.id, workspace: principal.workspace })
  db.prepare('UPDATE bot_job_origins SET start_mode = ? WHERE objective_id = ?').run(start.allowed ? 'auto' : 'manual', created.id)

  return {
    ok: true,
    objectiveId: created.id,
    status: created.status,
    reused: false,
    reason: 'created',
    start,
    origin: getJobOrigin(db, created.id)!,
  }
}

// ── follow-up (gate G9) ──────────────────────────────────────────────────────
//
// "Do it for Q3 too" in the same conversation must reach the SAME job. Two
// failure modes it has to avoid, and they pull in opposite directions:
//
//   - file a second card (the board fills with near-duplicates and the person
//     now has two places to look), or
//   - spawn a second worker on the one card (two sessions, one branch, and the
//     reaper kills whichever one it finds second — losing its work).
//
// So the follow-up resolves to an EXISTING job and then takes the SAME
// `obj:<id>` identity lease every other spawn path takes. A live holder means
// ATTACH — hand the message to the running worker. A dead holder means the
// lease is taken over and the job resumes in place. Neither branch creates
// anything.

export type FollowUpAction = 'attach' | 'resume'

export type FollowUpResult =
  | { ok: true; objectiveId: number; action: FollowUpAction; sessionId: string; reason: string }
  | { ok: false; code: 'unknown_job' | 'not_your_thread' | 'terminal' | 'invalid'; error: string }

export interface FollowUpInput {
  userId: number
  agentSlug: string
  objectiveId: number
  message: string
  /** The session id the caller would spawn if nothing were running. */
  sessionId: string
  isAlive: (sessionId: string) => boolean
}

export function followUpBotJob(db: Database, input: FollowUpInput): FollowUpResult {
  if (!input.message?.trim()) return { ok: false, code: 'invalid', error: 'A follow-up needs a message.' }
  const origin = getJobOrigin(db, input.objectiveId)
  if (!origin) return { ok: false, code: 'unknown_job', error: `Card #${input.objectiveId} was not filed as a bot job.` }
  // The thread is the authorization. A different conversation — even the same
  // person with a different bot — is not this job's thread.
  if (origin.thread_user_id !== input.userId || origin.thread_agent_slug !== input.agentSlug) {
    return { ok: false, code: 'not_your_thread', error: `Card #${input.objectiveId} belongs to a different conversation.` }
  }
  const row = db.prepare('SELECT status FROM objectives WHERE id = ?').get(input.objectiveId) as { status: string } | undefined
  if (!row) return { ok: false, code: 'unknown_job', error: `Card #${input.objectiveId} no longer exists.` }
  if (row.status === 'cancelled') {
    return { ok: false, code: 'terminal', error: `Card #${input.objectiveId} was cancelled. File a new job rather than reviving it.` }
  }

  const claim = claimBotJobSession(db, input.objectiveId, input.sessionId, input.isAlive)
  return claim.outcome === 'attach'
    ? { ok: true, objectiveId: input.objectiveId, action: 'attach', sessionId: claim.sessionId, reason: `A worker is already live on #${input.objectiveId}; the follow-up goes to it. No second card, no second worker.` }
    : { ok: true, objectiveId: input.objectiveId, action: 'resume', sessionId: claim.sessionId, reason: `No live worker on #${input.objectiveId}; it resumes in place under the same card.` }
}
