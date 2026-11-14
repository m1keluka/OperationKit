/**
 * The ONE human decision queue — durable review items (obj 900367, Stage 1).
 *
 * §4.1/§4.3 of `architecture/2026-11-08-accountable-leads-and-decision-queue.md`.
 *
 * This is a DURABLE object, not a recomputed attention view. That distinction is
 * the whole design: a view can show you what needs attention, but it cannot hold
 * a snooze, cannot carry a decision + its audit trail, cannot express "this
 * decision depends on that one", and — most importantly — cannot be WITHDRAWN.
 * Withdrawal is what stops the review pile growing: when a card resolves itself
 * (the blocker clears, CI goes green, the human merges the PR), the item leaves
 * the queue *with a reason* instead of waiting for someone to notice it is moot.
 *
 * Boundaries this module does NOT cross (§7, non-negotiable):
 *   - It never performs the decided action. `decideReviewItem` RECORDS a human's
 *     choice; executing it is the caller's job, under the caller's own gate.
 *   - It grants no authority. An `approve` row here is not an approval
 *     fingerprint (§7.2, Stage 2) and must not be treated as one.
 *   - It never fabricates evidence. See bindEvidence / describeEvidence.
 */
import type Database from 'better-sqlite3'
import { initAccountabilitySchema, REVIEW_ITEM_KINDS, REVIEW_ITEM_STATES, LIVE_REVIEW_ITEM_STATES } from '../db/schema/accountability.js'

export class ReviewItemError extends Error {}

export type ReviewItemKind = (typeof REVIEW_ITEM_KINDS)[number]
export type ReviewItemState = (typeof REVIEW_ITEM_STATES)[number]

/** Typed choices (§4.1) — what makes batch review and spoken decisions possible. */
export type DecisionChoice = 'approve' | 'changes' | 'reject' | 'snooze'
export type DecisionChannel = 'ui' | 'voice' | 'keyboard' | 'api'

export interface ReviewItem {
  id: number
  workspace: string
  objective_id: number
  lead: string | null
  kind: ReviewItemKind
  ask: string
  options: string[]
  dedupe_key: string
  created_from_event_id: string | null
  state: ReviewItemState
  depends_on_item_id: number | null
  snooze_until: string | null
  first_seen_at: string | null
  decision_choice: DecisionChoice | null
  decision_note: string | null
  decision_by: string | null
  decision_at: string | null
  decision_channel: DecisionChannel | null
  decision_token: string | null
  withdrawn_reason: string | null
  /** Who must act (obj 900795): `human:<user>` / `agent:<bot>`. NULL = the human queue. */
  routed_to: string | null
  created_at: string
  updated_at: string
}

interface ReviewItemRow extends Omit<ReviewItem, 'options'> {
  options: string | null
}

export interface CreateReviewItemInput {
  workspace: string
  objective_id: number
  kind: ReviewItemKind
  ask: string
  /** Stable among LIVE items, e.g. `card:900303:signoff`. Defaults to `card:<id>:<kind>`. */
  dedupe_key?: string
  /** The deterministic source-event id. Supplying it makes creation idempotent. */
  created_from_event_id?: string | null
  lead?: string | null
  options?: DecisionChoice[]
  depends_on_item_id?: number | null
  actor?: string
  /**
   * Who must act on it (obj 900795), typed like `waiting_on`: `human:<user>` or
   * `agent:<bot slug>`. Omitted/null = the human queue, exactly as before. When
   * an existing live item is re-surfaced with a DIFFERENT routing, it is
   * re-routed in place and the change is audited (`rerouted`).
   */
  routed_to?: string | null
}

const ROUTED_TO = /^(human|agent)(:[a-z0-9][a-z0-9_.@-]{0,79})?$/i

function routedTo(v: string | null | undefined): string | null {
  if (v == null) return null
  const t = v.trim()
  if (!t) return null
  if (!ROUTED_TO.test(t)) throw new ReviewItemError('routed_to must be human[:<user>] or agent[:<bot slug>]')
  return t
}

const DEFAULT_OPTIONS: DecisionChoice[] = ['approve', 'changes', 'reject', 'snooze']
const MAX_ASK = 400
const MAX_NOTE = 2000

const ready = new WeakSet<object>()
function ensure(db: Database.Database): void {
  if (ready.has(db)) return
  initAccountabilitySchema(db)
  ready.add(db)
}

function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

function toItem(row: ReviewItemRow): ReviewItem {
  let options: string[] = []
  try {
    const parsed = row.options ? JSON.parse(row.options) : []
    if (Array.isArray(parsed)) options = parsed.filter((o) => typeof o === 'string')
  } catch {
    /* corrupt row → no options rather than a throw on read */
  }
  return { ...row, options: options as DecisionChoice[] }
}

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new ReviewItemError(`${field} is required`)
  const t = v.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

function audit(db: Database.Database, itemId: number, event: string, actor: string | null, detail: string | null): void {
  db.prepare('INSERT INTO review_item_events (review_item_id, event, actor, detail) VALUES (?, ?, ?, ?)')
    .run(itemId, event, actor, detail)
}

export function getReviewItem(db: Database.Database, id: number): ReviewItem | null {
  ensure(db)
  const row = db.prepare('SELECT * FROM review_items WHERE id = ?').get(id) as ReviewItemRow | undefined
  return row ? toItem(row) : null
}

export function listReviewItemEvents(db: Database.Database, itemId: number): { event: string; actor: string | null; detail: string | null; created_at: string }[] {
  ensure(db)
  return db.prepare('SELECT event, actor, detail, created_at FROM review_item_events WHERE review_item_id = ? ORDER BY id')
    .all(itemId) as { event: string; actor: string | null; detail: string | null; created_at: string }[]
}

/**
 * Create a review item, IDEMPOTENTLY.
 *
 * Two independent de-duplication keys, because they answer different questions:
 *
 *   `created_from_event_id` — "have I already handled THIS event?" A replayed
 *     webhook, a double-fired trigger, or a done→reopen→done cycle re-delivering
 *     the same source event must UPDATE the existing item, never add a second
 *     one (A5). Returned with `created: false`.
 *
 *   `dedupe_key` — "is this same QUESTION already in front of the human?" A card
 *     that escalates through four states in a minute must collapse to one item,
 *     even though each escalation is a genuinely distinct event (A16). The
 *     existing live item wins and is re-surfaced rather than duplicated.
 *
 * Both are enforced by UNIQUE indexes as well as by the lookups below, so two
 * concurrent writers cannot slip a duplicate past the read-then-write window.
 */
export function createReviewItem(
  db: Database.Database,
  input: CreateReviewItemInput,
  now: Date = new Date(),
): { item: ReviewItem; created: boolean } {
  ensure(db)
  const workspace = text(input.workspace, 'workspace', 80)
  const kind = input.kind
  if (!(REVIEW_ITEM_KINDS as readonly string[]).includes(kind)) {
    throw new ReviewItemError(`kind must be one of: ${REVIEW_ITEM_KINDS.join(', ')}`)
  }
  if (!Number.isInteger(input.objective_id) || input.objective_id <= 0) {
    throw new ReviewItemError('objective_id must be a positive integer')
  }
  const ask = text(input.ask, 'ask', MAX_ASK)
  const dedupeKey = (input.dedupe_key ?? `card:${input.objective_id}:${kind}`).trim()
  const eventId = input.created_from_event_id?.trim() || null
  const options = (input.options ?? DEFAULT_OPTIONS).filter((o) => DEFAULT_OPTIONS.includes(o))
  const actor = input.actor ?? 'server'
  const route = routedTo(input.routed_to)
  // Re-route a live item whose target changed (e.g. the owning bot stopped
  // waking, so the flag must now go to a human). Only when the caller routes.
  const reroute = (row: ReviewItemRow): void => {
    if (input.routed_to === undefined || (row.routed_to ?? null) === route) return
    db.prepare('UPDATE review_items SET routed_to = ?, updated_at = ? WHERE id = ?').run(route, nowIso(now), row.id)
    audit(db, row.id, 'rerouted', actor, `${row.routed_to ?? 'human queue'} -> ${route ?? 'human queue'}`)
  }

  const tx = db.transaction((): { item: ReviewItem; created: boolean } => {
    // Same source event → the item already exists. Refresh the mutable framing
    // (ask/options/lead/dependency) so a corrected replay improves the item, but
    // NEVER resurrect a decided item: a human already answered this, and
    // re-opening it on a redelivered event is how a queue starts re-asking
    // settled questions.
    if (eventId) {
      const existing = db.prepare('SELECT * FROM review_items WHERE created_from_event_id = ?').get(eventId) as ReviewItemRow | undefined
      if (existing) {
        if ((LIVE_REVIEW_ITEM_STATES as readonly string[]).includes(existing.state)) {
          db.prepare(`UPDATE review_items SET ask = ?, options = ?, lead = COALESCE(?, lead),
                        depends_on_item_id = COALESCE(?, depends_on_item_id), updated_at = ?
                      WHERE id = ?`)
            .run(ask, JSON.stringify(options), input.lead ?? null, input.depends_on_item_id ?? null, nowIso(now), existing.id)
          audit(db, existing.id, 'replayed', actor, `event ${eventId} re-delivered; item updated in place`)
          reroute(existing)
        } else {
          audit(db, existing.id, 'replayed', actor, `event ${eventId} re-delivered after state=${existing.state}; ignored`)
        }
        return { item: getReviewItem(db, existing.id)!, created: false }
      }
    }

    // Same question already live → re-surface it, do not stack a second ask.
    const live = db.prepare(
      `SELECT * FROM review_items WHERE dedupe_key = ? AND state IN ('open','snoozed','waiting_on_dependency')`,
    ).get(dedupeKey) as ReviewItemRow | undefined
    if (live) {
      audit(db, live.id, 'escalated', actor, eventId ? `collapsed event ${eventId} into live item` : 'duplicate ask collapsed')
      db.prepare('UPDATE review_items SET updated_at = ? WHERE id = ?').run(nowIso(now), live.id)
      reroute(live)
      return { item: getReviewItem(db, live.id)!, created: false }
    }

    // A dependency that is not yet decided parks the item out of the main queue
    // (§4.2: a dependency-blocked item never outranks its blocker).
    const dep = input.depends_on_item_id ?? null
    let state: ReviewItemState = 'open'
    if (dep !== null) {
      const blocker = db.prepare('SELECT state FROM review_items WHERE id = ?').get(dep) as { state: string } | undefined
      if (!blocker) throw new ReviewItemError(`depends_on_item_id ${dep} does not exist`)
      if ((LIVE_REVIEW_ITEM_STATES as readonly string[]).includes(blocker.state)) state = 'waiting_on_dependency'
    }

    const info = db.prepare(
      `INSERT INTO review_items (workspace, objective_id, lead, kind, ask, options, dedupe_key,
                                 created_from_event_id, state, depends_on_item_id, routed_to, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(workspace, input.objective_id, input.lead ?? null, kind, ask, JSON.stringify(options), dedupeKey, eventId, state, dep, route, nowIso(now), nowIso(now))
    const id = Number(info.lastInsertRowid)
    audit(db, id, 'created', actor, eventId ? `from event ${eventId}` : 'filed directly')
    return { item: getReviewItem(db, id)!, created: true }
  })
  return tx()
}

/** Record that a human has SEEN the item (§3.5: "a human saw it" is its own fact). */
export function markSeen(db: Database.Database, id: number, actor: string, now: Date = new Date()): ReviewItem {
  ensure(db)
  const item = getReviewItem(db, id)
  if (!item) throw new ReviewItemError(`review item ${id} not found`)
  if (item.first_seen_at) return item
  db.prepare('UPDATE review_items SET first_seen_at = ?, updated_at = ? WHERE id = ?').run(nowIso(now), nowIso(now), id)
  audit(db, id, 'surfaced', actor, null)
  return getReviewItem(db, id)!
}

/**
 * Snooze an item until a wall-clock time. A snoozed item is ABSENT from the
 * queue until `snooze_until` passes (A8) — it is not decided, not withdrawn, and
 * it comes back by itself. `until` must be in the future: a past snooze is
 * indistinguishable from "do nothing", and silently accepting it would let a
 * caller believe work was deferred when it was not.
 */
export function snoozeReviewItem(
  db: Database.Database,
  id: number,
  until: string,
  actor: string,
  now: Date = new Date(),
): ReviewItem {
  ensure(db)
  const item = getReviewItem(db, id)
  if (!item) throw new ReviewItemError(`review item ${id} not found`)
  if (!(LIVE_REVIEW_ITEM_STATES as readonly string[]).includes(item.state)) {
    throw new ReviewItemError(`cannot snooze an item in state ${item.state}`)
  }
  const t = Date.parse(until)
  if (!Number.isFinite(t)) throw new ReviewItemError('snooze_until must be an ISO timestamp')
  if (t <= now.getTime()) throw new ReviewItemError('snooze_until must be in the future')
  db.prepare("UPDATE review_items SET state = 'snoozed', snooze_until = ?, updated_at = ? WHERE id = ?")
    .run(new Date(t).toISOString(), nowIso(now), id)
  audit(db, id, 'snoozed', actor, `until ${new Date(t).toISOString()}`)
  return getReviewItem(db, id)!
}

/** Wake every snoozed item whose time has come. Returns the ids re-opened. */
export function wakeSnoozed(db: Database.Database, now: Date = new Date()): number[] {
  ensure(db)
  const due = db.prepare("SELECT id FROM review_items WHERE state = 'snoozed' AND snooze_until IS NOT NULL AND snooze_until <= ?")
    .all(nowIso(now)) as { id: number }[]
  for (const { id } of due) {
    db.prepare("UPDATE review_items SET state = 'open', snooze_until = NULL, updated_at = ? WHERE id = ?").run(nowIso(now), id)
    audit(db, id, 'surfaced', 'server', 'snooze expired')
  }
  return due.map((d) => d.id)
}

export interface DecideInput {
  choice: DecisionChoice
  by: string
  note?: string | null
  channel?: DecisionChannel
  /** Idempotency key for the decision itself — a double-tap must apply once (A9). */
  token?: string | null
  /** Must be true for an `approve` on an `approval`-kind item. See below. */
  verified_owner?: boolean
}

/**
 * RECORD a human's decision. This does not execute anything.
 *
 * Two rules are enforced here rather than left to callers:
 *
 * 1. **Replay applies once (A9).** A flaky mobile connection double-submits the
 *    same `token`; the second call returns the FIRST decision unchanged, writes
 *    no second audit row, and reports `replayed: true`. Enforced by a UNIQUE
 *    index, so two concurrent submits cannot both win.
 *
 * 2. **Approval is identity-bound (§7.3).** Only a VERIFIED owner — a
 *    cookie-authenticated admin typing in the UI — may `approve` an
 *    `approval`-kind item. An agent relay, a bearer token, an API key, a voice
 *    transcript and a learned preference are all NOT approval. `changes` and
 *    `reject` are ordinary feedback and carry no such gate: they authorize
 *    nothing, which is exactly why they are safe to accept from any channel.
 *    A spoken token is never sufficient for an approval, so `voice` + `approve`
 *    is refused on an approval item even if the caller claims verification.
 */
export function decideReviewItem(
  db: Database.Database,
  id: number,
  input: DecideInput,
  now: Date = new Date(),
): { item: ReviewItem; replayed: boolean } {
  ensure(db)
  const token = input.token?.trim() || null
  if (token) {
    const prior = db.prepare('SELECT * FROM review_items WHERE decision_token = ?').get(token) as ReviewItemRow | undefined
    if (prior) {
      if (prior.id !== id) throw new ReviewItemError('decision_token belongs to a different review item')
      return { item: toItem(prior), replayed: true }
    }
  }
  const item = getReviewItem(db, id)
  if (!item) throw new ReviewItemError(`review item ${id} not found`)
  if (item.state === 'decided') {
    // No token to match on, but the question is already answered. Refuse rather
    // than overwrite — a second answer to a settled question is a bug upstream.
    throw new ReviewItemError(`review item ${id} is already decided`)
  }
  if (!(LIVE_REVIEW_ITEM_STATES as readonly string[]).includes(item.state)) {
    throw new ReviewItemError(`cannot decide an item in state ${item.state}`)
  }
  const choice = input.choice
  if (!DEFAULT_OPTIONS.includes(choice)) throw new ReviewItemError(`choice must be one of: ${DEFAULT_OPTIONS.join(', ')}`)
  if (item.options.length && !item.options.includes(choice)) {
    throw new ReviewItemError(`choice ${choice} is not offered on this item`)
  }
  const channel: DecisionChannel = input.channel ?? 'ui'
  if (choice === 'approve' && item.kind === 'approval') {
    if (!input.verified_owner) throw new ReviewItemError('approval requires a VERIFIED owner (cookie-authenticated admin in the UI)')
    if (channel === 'voice') throw new ReviewItemError('voice is an input method, not an identity: an approval cannot be granted by voice')
    if (describeEvidence(db, id).approve_enabled === false) {
      throw new ReviewItemError('approval is disabled on an item with no verified evidence')
    }
  }
  const by = text(input.by, 'by', 120)
  const note = input.note == null ? null : text(input.note, 'note', MAX_NOTE)

  db.prepare(
    `UPDATE review_items SET state = 'decided', decision_choice = ?, decision_note = ?, decision_by = ?,
                             decision_at = ?, decision_channel = ?, decision_token = ?, updated_at = ?
     WHERE id = ?`,
  ).run(choice, note, by, nowIso(now), channel, token, nowIso(now), id)
  audit(db, id, 'decided', by, `${choice}${note ? `: ${note}` : ''} via ${channel}`)
  releaseDependents(db, id, now)
  return { item: getReviewItem(db, id)!, replayed: false }
}

/**
 * Withdraw an item because the thing it asked about resolved itself.
 *
 * This is the counterweight to "decide", and the reason the queue does not grow
 * without bound. A blocker that clears, CI that goes green, a worker that
 * finishes, a human who merges the PR — none of those need a decision any more,
 * so the item leaves the queue carrying the reason it became moot. A withdrawn
 * item is never silently deleted: the row and its audit trail stay, so "why did
 * this disappear from my queue" is always answerable.
 */
export function withdrawReviewItem(
  db: Database.Database,
  id: number,
  reason: string,
  actor = 'server',
  now: Date = new Date(),
): ReviewItem {
  ensure(db)
  const item = getReviewItem(db, id)
  if (!item) throw new ReviewItemError(`review item ${id} not found`)
  if (!(LIVE_REVIEW_ITEM_STATES as readonly string[]).includes(item.state)) return item
  const why = text(reason, 'reason', 300)
  db.prepare("UPDATE review_items SET state = 'withdrawn', withdrawn_reason = ?, updated_at = ? WHERE id = ?")
    .run(why, nowIso(now), id)
  audit(db, id, 'withdrawn', actor, why)
  releaseDependents(db, id, now)
  return getReviewItem(db, id)!
}

/** A blocker left the live set → anything parked behind it re-enters the queue. */
function releaseDependents(db: Database.Database, blockerId: number, now: Date): void {
  const parked = db.prepare("SELECT id FROM review_items WHERE depends_on_item_id = ? AND state = 'waiting_on_dependency'")
    .all(blockerId) as { id: number }[]
  for (const { id } of parked) {
    db.prepare("UPDATE review_items SET state = 'open', updated_at = ? WHERE id = ?").run(nowIso(now), id)
    audit(db, id, 'surfaced', 'server', `dependency ${blockerId} resolved`)
  }
}

/**
 * Withdraw every live item for a card that has reached a terminal state.
 *
 * `delivered_merged` is the case the design calls out explicitly (§4.1, and the
 * generalised form of queued card 718941): a human merging the PR **is** the
 * sign-off for a PR-carrying card, so the sign-off item withdraws itself rather
 * than sitting in the queue asking for a decision that has already been made by
 * a different gesture.
 *
 * `kinds` narrows which items withdraw. A merge answers a `signoff`; it does NOT
 * answer an unrelated `input_needed` on the same card, so callers pass the kinds
 * their event actually resolves instead of clearing the card wholesale.
 */
export function withdrawForTerminal(
  db: Database.Database,
  objectiveId: number,
  terminalReason: string,
  opts: { kinds?: ReviewItemKind[]; actor?: string } = {},
  now: Date = new Date(),
): ReviewItem[] {
  ensure(db)
  const kinds = opts.kinds ?? ['signoff', 'approval', 'decision', 'input_needed', 'failure', 'proposal']
  const placeholders = kinds.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT id FROM review_items
     WHERE objective_id = ? AND state IN ('open','snoozed','waiting_on_dependency') AND kind IN (${placeholders})`,
  ).all(objectiveId, ...kinds) as { id: number }[]
  return rows.map((r) => withdrawReviewItem(db, r.id, `card reached terminal state: ${terminalReason}`, opts.actor ?? 'server', now))
}

// ── §4.3 Evidence ───────────────────────────────────────────────────────────

export interface EvidenceInput {
  objective_id: number
  /** The session the artefact was produced in. Required — see schema comment. */
  session_id: string
  /** The commit the run was on. Required. */
  commit_sha: string
  captured_at?: string
  /** What produced it, e.g. `playwright-mcp`, `vitest`, `gh`. */
  tool: string
  /** `screenshot` | `log` | `diff` | `smoke_walkthrough` | … */
  kind: string
  /** Repo-relative path or URL. */
  ref: string
  caption?: string | null
}

export interface BoundEvidence extends EvidenceInput {
  id: number
  captured_at: string
  created_at: string
}

/**
 * Bind a real artefact to an item.
 *
 * Refuses anything without BOTH a session id and a commit sha. This is the
 * no-fabricated-demos rule as code: an artefact that cannot be tied to a run and
 * a diff proves nothing about the change being decided on, so it is not stored
 * as weak evidence — it is rejected, and the item keeps saying it has none.
 * A `commit_sha` must look like a git object id for the same reason; a
 * placeholder like "latest" is not a commit and would make the binding a lie.
 *
 * Re-binding the same (ref, commit_sha) is a no-op, so a replayed capture does
 * not inflate the apparent weight of the proof.
 */
export function bindEvidence(db: Database.Database, itemId: number, input: EvidenceInput, now: Date = new Date()): BoundEvidence {
  ensure(db)
  const item = getReviewItem(db, itemId)
  if (!item) throw new ReviewItemError(`review item ${itemId} not found`)
  const sessionId = text(input.session_id, 'session_id', 120)
  const commit = text(input.commit_sha, 'commit_sha', 64)
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new ReviewItemError('commit_sha must be a git object id (7-40 hex chars) — evidence must bind to a real commit')
  }
  const ref = text(input.ref, 'ref', 500)
  const tool = text(input.tool, 'tool', 80)
  const kind = text(input.kind, 'kind', 60)
  const capturedAt = input.captured_at?.trim() || nowIso(now)
  if (!Number.isFinite(Date.parse(capturedAt))) throw new ReviewItemError('captured_at must be an ISO timestamp')

  const existing = db.prepare('SELECT * FROM review_item_evidence WHERE review_item_id = ? AND ref = ? AND commit_sha = ?')
    .get(itemId, ref, commit) as BoundEvidence | undefined
  if (existing) return existing

  const info = db.prepare(
    `INSERT INTO review_item_evidence (review_item_id, objective_id, session_id, commit_sha, captured_at, tool, kind, ref, caption)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(itemId, input.objective_id, sessionId, commit, capturedAt, tool, kind, ref, input.caption ?? null)
  audit(db, itemId, 'evidence_bound', 'server', `${kind} ${ref} @ ${commit.slice(0, 7)} (session ${sessionId})`)
  return db.prepare('SELECT * FROM review_item_evidence WHERE id = ?').get(Number(info.lastInsertRowid)) as BoundEvidence
}

export interface EvidenceSummary {
  items: BoundEvidence[]
  /** Human-readable, and deliberately blunt when there is nothing. */
  label: string
  /** False whenever there is no bound evidence — the UI disables `approve` (A7). */
  approve_enabled: boolean
}

/**
 * Describe an item's evidence — including, loudly, its absence.
 *
 * An item with no bound artefact renders `No verified evidence (…)` and its
 * approve affordance is DISABLED. Batch-approve is expected to skip such items
 * and say that it skipped them. Nothing here ever invents a screenshot, a
 * mock-up or a described screenshot to fill the gap: the honest answer to "show
 * me the proof" is sometimes "there is none", and saying so is the feature.
 */
export function describeEvidence(db: Database.Database, itemId: number): EvidenceSummary {
  ensure(db)
  const items = db.prepare('SELECT * FROM review_item_evidence WHERE review_item_id = ? ORDER BY id')
    .all(itemId) as BoundEvidence[]
  if (!items.length) {
    return {
      items: [],
      label: 'No verified evidence (no artifact was bound to a session and commit for this item)',
      approve_enabled: false,
    }
  }
  const commits = [...new Set(items.map((e) => e.commit_sha.slice(0, 7)))]
  return {
    items,
    label: `${items.length} verified artifact${items.length === 1 ? '' : 's'} bound to commit${commits.length === 1 ? '' : 's'} ${commits.join(', ')}`,
    approve_enabled: true,
  }
}

export interface ListReviewItemsOptions {
  workspace?: string
  objective_id?: number
  states?: ReviewItemState[]
  /**
   * Routing filter (obj 900795). `'human'` = the human queue (NULL or any
   * `human:*`); any other value is an exact match, e.g. `agent:sales-bot`.
   */
  routed_to?: string
  /** Only items whose dedupe_key starts with this prefix, e.g. `supervisor:`. */
  dedupe_prefix?: string
  limit?: number
}

/**
 * List items. Defaults to the LIVE queue minus anything currently snoozed or
 * parked behind a dependency — i.e. what a person could actually act on now.
 * `workspace` is applied as a FILTER, never a ranking preference (obj 900321's
 * discipline): a caller scoped to one workspace must not see another's items at
 * any rank.
 */
export function listReviewItems(db: Database.Database, opts: ListReviewItemsOptions = {}, now: Date = new Date()): ReviewItem[] {
  ensure(db)
  const where: string[] = []
  const params: unknown[] = []
  if (opts.workspace) {
    where.push('workspace = ?')
    params.push(opts.workspace)
  }
  if (opts.objective_id != null) {
    where.push('objective_id = ?')
    params.push(opts.objective_id)
  }
  if (opts.routed_to === 'human') {
    where.push("(routed_to IS NULL OR routed_to = 'human' OR routed_to LIKE 'human:%')")
  } else if (opts.routed_to) {
    where.push('routed_to = ?')
    params.push(opts.routed_to)
  }
  if (opts.dedupe_prefix) {
    where.push('substr(dedupe_key, 1, ?) = ?')
    params.push(opts.dedupe_prefix.length, opts.dedupe_prefix)
  }
  const states = opts.states ?? ['open']
  where.push(`state IN (${states.map(() => '?').join(',')})`)
  params.push(...states)
  // A snoozed item is absent until its time comes, even when a caller asks for
  // snoozed states explicitly — the queue answers "what can I act on", and a
  // live snooze is the human's own instruction not to show it yet.
  const sql = `SELECT * FROM review_items WHERE ${where.join(' AND ')}
               AND (snooze_until IS NULL OR snooze_until <= ?)
               ORDER BY id DESC LIMIT ?`
  params.push(nowIso(now), Math.min(Math.max(opts.limit ?? 200, 1), 500))
  return (db.prepare(sql).all(...params) as ReviewItemRow[]).map(toItem)
}

/**
 * NOTE on the shape of this module: every function takes the `Database` handle
 * explicitly and nothing here imports `getDb`. That is deliberate — it keeps the
 * queue testable against a throwaway in-memory DB without dragging in the whole
 * server object graph (`db/index.js` transitively loads native modules), and it
 * makes each call site state which database it is writing to. Callers that want
 * the process DB call `getDb()` themselves, as the routes already do.
 */
