/**
 * Agent-key webhooks (obj 719278) — wake the managing bot when a card it
 * created or started changes status, so it can stop polling get_changes.
 *
 * No new event system: the dispatcher tails `objective_events`, the same
 * trigger-fed table GET /api/agent/changes reads, so every pathway (UI, API,
 * state-poller, auto-merge) is covered without touching the UPDATE sites.
 *
 *   enqueue tick:  objective_events (id > cursor)
 *                  ⋈ objectives.agent_key_id ⋈ agent_key_webhooks (enabled, key live)
 *                  → map kind → filter → INSERT OR IGNORE agent_webhook_deliveries
 *   deliver tick:  due pending rows → signed POST (10s timeout) → delivered |
 *                  retry with backoff | failed after MAX_ATTEMPTS
 *
 * Both run on their own timer, never inside a card's write path: a slow or dead
 * receiver can delay only its own deliveries, never a status move.
 *
 * needs_agent (obj 900214; opened to every key in obj 900270): instead of one POST
 * per change, the enqueue tick classifies the card's CURRENT state (classifyNeed —
 * same conditions as get_attention) and wakes once per CARD need: when the card
 * starts needing an agent, or escalates to a more urgent need. Status flicker
 * (queue → working → ai_review, a summary update, a PR link) never wakes it. The
 * need state is per card (agent_webhook_card_need_state), not per key, so one need
 * is one delivery however many keys could see it. Any key may opt in — the old
 * label allowlist is gone — but the usual gates still apply: the key must be live,
 * the webhook enabled and subscribed, and the card must be one the key filed or
 * started AND inside the key's workspace scope. The payload carries the card's
 * owner_bot (null = unowned) so one shared webhook can route the wake.
 *
 * Egress (obj 900270, covers #900244): every send resolves the host, refuses any
 * non-public answer, pins the connection to the checked address and never follows
 * a redirect — see webhook-egress.ts.
 *
 * The sender key lives in the Secrets store (user scope, CC_AGENT_WEBHOOK_KEY_<id>)
 * and is excluded from session envs and the broker (isServerOnlySecretKey). It is
 * decrypted only here, at send time, and is never logged or returned.
 */
import crypto from 'crypto'
import net from 'net'
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'
import {
  SERVER_ONLY_SECRET_PREFIX,
  deleteSecret,
  getSecret,
  getSecretValue,
  setSecret,
  type SecretScope,
} from './secrets-store.js'
import {
  AGENT_WEBHOOK_EVENTS,
  DEFAULT_AGENT_WEBHOOK_EVENTS,
  type AgentWebhookConfig,
  type AgentWebhookDelivery,
  type AgentWebhookEvent,
  type AgentWebhookPayload,
  type AgentNeed,
  type AgentNeedKind,
} from '@operationkit/shared'
import { isBlockedAddress, pinnedHttpsPost, resolveWebhookDestination, type PinnedPostInit } from './webhook-egress.js'

export const CURSOR_SETTING = 'agent_webhook_cursor'
export const MAX_ATTEMPTS = 5
/** Wait before attempt 2..5 → 1 + 4 + 10 + 15 = 30 min from first try to last. */
export const RETRY_BACKOFF_MS = [60_000, 4 * 60_000, 10 * 60_000, 15 * 60_000]
export const REQUEST_TIMEOUT_MS = 10_000
export const TICK_MS = 5_000
const ENQUEUE_BATCH = 500
const DELIVER_BATCH = 20
/** A row being sent is leased this far ahead so an overlapping tick skips it. */
const LEASE_MS = 60_000

export const SIGNATURE_HEADER = 'X-CC-Signature'
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'host', 'user-agent', 'connection', 'transfer-encoding'])

// ── Fetch seam (tests) ───────────────────────────────────────────────────────

/**
 * The transport. Called only AFTER resolveWebhookDestination accepted the host;
 * `init.address` is the validated IP the connection must use. The default pins
 * the socket to it (no second DNS lookup) and never follows redirects. Tests swap
 * the transport only — the DNS check above it always runs.
 */
type FetchLike = (url: string, init: PinnedPostInit) => Promise<{ status: number }>
let fetchImpl: FetchLike = pinnedHttpsPost
export function setAgentWebhookFetch(f: FetchLike | null): void {
  fetchImpl = f ?? pinnedHttpsPost
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function secretNameFor(keyId: number): string {
  return `${SERVER_ONLY_SECRET_PREFIX}${keyId}`
}

function scopeFor(userId: number): SecretScope {
  return { scopeType: 'user', userId }
}

export function cardUrl(objectiveId: number): string {
  const base = (process.env.CC_PUBLIC_URL || 'https://cc.example.com').replace(/\/+$/, '')
  return `${base}/o/${objectiveId}`
}

/** HMAC-SHA256 of the exact body bytes, hex, `sha256=` prefixed (GitHub style). */
export function signBody(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

/** Receiver-side check, exported for tests and the docs example. */
export function verifySignature(secret: string, body: string, header: string | undefined | null): boolean {
  if (!header) return false
  const want = Buffer.from(signBody(secret, body))
  const got = Buffer.from(header)
  return want.length === got.length && crypto.timingSafeEqual(want, got)
}

export interface MappedEvent {
  event: AgentWebhookEvent
  from_status?: string
  verdict?: string
}

/** objective_events row → webhook event. null = not something a bot is woken for. */
export function mapChange(kind: string, from: string | null, to: string | null): MappedEvent | null {
  switch (kind) {
    case 'created':
      return { event: 'created' }
    case 'status': {
      const base = from ? { from_status: from } : {}
      if (to === 'working') return { event: 'working', ...base }
      if (to === 'review') return { event: 'entered_review', ...base }
      if (to === 'done') return { event: 'done', ...base }
      if (to === 'cancelled') return { event: 'cancelled', ...base }
      return { event: 'status_changed', ...base }
    }
    case 'verdict':
      if (to === 'fail') return { event: 'failed', verdict: to }
      if (to === 'blocked') return { event: 'stalled', verdict: to }
      return { event: 'ai_review', verdict: to ?? undefined }
    case 'needs_secret':
      return { event: 'needs_secret' }
    case 'blocked':
      return { event: 'stalled' }
    case 'pr':
      if (to === 'merged') return { event: 'merged' }
      if (to === 'closed') return { event: 'pr_closed' }
      return from == null ? { event: 'pr_opened' } : null
    default:
      return null
  }
}

function parseEvents(raw: string | null): AgentWebhookEvent[] {
  try {
    const v = JSON.parse(raw ?? '')
    if (Array.isArray(v)) return AGENT_WEBHOOK_EVENTS.filter(e => v.includes(e))
  } catch { /* fall through */ }
  return [...DEFAULT_AGENT_WEBHOOK_EVENTS]
}

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  // obj 900270: IP literals also go through the send-time policy (CGNAT, TEST-NETs,
  // multicast, NAT64/6to4, mapped IPv6 …). Additive — nothing below is relaxed.
  if (net.isIP(h) && isBlockedAddress(h)) return true
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (net.isIPv6(h)) return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80') || h.startsWith('::ffff:')
  return false
}

/** https only, public host — the server sits next to localhost-only routes. */
export function validateWebhookUrl(raw: unknown): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'url is required' }
  if (raw.length > 2000) return { ok: false, error: 'url is too long' }
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return { ok: false, error: 'url is not a valid URL' }
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'url must use https://' }
  if (u.username || u.password) return { ok: false, error: 'url must not embed credentials — use the sender key' }
  if (isPrivateHost(u.hostname)) return { ok: false, error: 'url must point at a public host' }
  return { ok: true, url: u.toString() }
}

// ── Config (Settings → Agent keys → Webhook) ─────────────────────────────────

interface WebhookRow {
  key_id: number
  user_id: number
  url: string
  header_name: string
  header_prefix: string
  events: string
  enabled: number
  created_at: string
  updated_at: string
}

interface KeyRow { id: number; user_id: number; label: string; revoked_at: string | null; workspaces: string | null }

function ownKey(db: Database.Database, userId: number, keyId: number): KeyRow | null {
  return (db.prepare('SELECT id, user_id, label, revoked_at, workspaces FROM agent_api_keys WHERE id = ? AND user_id = ?')
    .get(keyId, userId) as KeyRow | undefined) ?? null
}

function toConfig(row: WebhookRow): AgentWebhookConfig {
  const name = secretNameFor(row.key_id)
  return {
    key_id: row.key_id,
    url: row.url,
    header_name: row.header_name,
    header_prefix: row.header_prefix,
    events: parseEvents(row.events),
    enabled: !!row.enabled,
    has_secret: !!getSecret(scopeFor(row.user_id), name),
    secret_name: name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

export function getWebhookConfig(userId: number, keyId: number): Result<AgentWebhookConfig | null> {
  const db = getDb()
  if (!ownKey(db, userId, keyId)) return { ok: false, status: 404, error: 'Agent key not found' }
  const row = db.prepare('SELECT * FROM agent_key_webhooks WHERE key_id = ?').get(keyId) as WebhookRow | undefined
  return { ok: true, value: row ? toConfig(row) : null }
}

export interface SaveWebhookInput {
  url?: unknown
  header_name?: unknown
  header_prefix?: unknown
  events?: unknown
  enabled?: unknown
  /** Write-only. Omit to keep the stored key. */
  secret?: unknown
}

export function saveWebhookConfig(userId: number, keyId: number, input: SaveWebhookInput): Result<AgentWebhookConfig> {
  const db = getDb()
  const key = ownKey(db, userId, keyId)
  if (!key) return { ok: false, status: 404, error: 'Agent key not found' }
  if (key.revoked_at) return { ok: false, status: 409, error: 'Agent key is revoked' }
  const existing = db.prepare('SELECT * FROM agent_key_webhooks WHERE key_id = ?').get(keyId) as WebhookRow | undefined

  const url = validateWebhookUrl(input.url ?? existing?.url)
  if (!url.ok) return { ok: false, status: 400, error: url.error }

  const headerName = input.header_name === undefined ? (existing?.header_name ?? 'Authorization') : input.header_name
  if (typeof headerName !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(headerName.trim())) {
    return { ok: false, status: 400, error: 'header_name must be 1-64 letters, digits or dashes' }
  }
  const hn = headerName.trim()
  if (RESERVED_HEADERS.has(hn.toLowerCase()) || hn.toLowerCase().startsWith('x-cc-')) {
    return { ok: false, status: 400, error: `header_name ${hn} is reserved` }
  }

  const headerPrefix = input.header_prefix === undefined
    ? (existing?.header_prefix ?? (hn.toLowerCase() === 'authorization' ? 'Bearer ' : ''))
    : input.header_prefix
  if (typeof headerPrefix !== 'string' || headerPrefix.length > 32 || /[\r\n]/.test(headerPrefix)) {
    return { ok: false, status: 400, error: 'header_prefix must be at most 32 characters on one line' }
  }

  let events: AgentWebhookEvent[]
  if (input.events === undefined) {
    events = existing ? parseEvents(existing.events) : [...DEFAULT_AGENT_WEBHOOK_EVENTS]
  } else if (Array.isArray(input.events)) {
    const bad = input.events.filter(e => !(AGENT_WEBHOOK_EVENTS as readonly unknown[]).includes(e))
    if (bad.length) return { ok: false, status: 400, error: `unknown event(s): ${bad.map(String).join(', ')}` }
    events = AGENT_WEBHOOK_EVENTS.filter(e => (input.events as unknown[]).includes(e))
    if (!events.length) return { ok: false, status: 400, error: 'pick at least one event' }
  } else {
    return { ok: false, status: 400, error: 'events must be an array' }
  }

  const enabled = input.enabled === undefined ? (existing ? !!existing.enabled : true) : input.enabled
  if (typeof enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled must be true or false' }

  const name = secretNameFor(keyId)
  if (input.secret !== undefined && input.secret !== null && input.secret !== '') {
    if (typeof input.secret !== 'string' || input.secret.length < 8 || input.secret.length > 512 || /[\r\n]/.test(input.secret)) {
      return { ok: false, status: 400, error: 'sender key must be 8-512 characters on one line' }
    }
  } else if (!getSecret(scopeFor(userId), name)) {
    return { ok: false, status: 400, error: 'sender key is required the first time' }
  }

  if (typeof input.secret === 'string' && input.secret) {
    setSecret({ scope: scopeFor(userId), key: name, value: input.secret, actorUserId: userId, via: `agent key #${keyId} webhook` })
  }
  db.prepare(
    `INSERT INTO agent_key_webhooks (key_id, user_id, url, header_name, header_prefix, events, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key_id) DO UPDATE SET url = excluded.url, header_name = excluded.header_name,
       header_prefix = excluded.header_prefix, events = excluded.events, enabled = excluded.enabled,
       updated_at = datetime('now')`,
  ).run(keyId, userId, url.url, hn, headerPrefix, JSON.stringify(events), enabled ? 1 : 0)
  const row = db.prepare('SELECT * FROM agent_key_webhooks WHERE key_id = ?').get(keyId) as WebhookRow
  return { ok: true, value: toConfig(row) }
}

export function deleteWebhookConfig(userId: number, keyId: number): Result<true> {
  const db = getDb()
  if (!ownKey(db, userId, keyId)) return { ok: false, status: 404, error: 'Agent key not found' }
  db.prepare('DELETE FROM agent_key_webhooks WHERE key_id = ?').run(keyId)
  db.prepare('DELETE FROM agent_webhook_need_state WHERE key_id = ?').run(keyId)
  db.prepare('DELETE FROM agent_webhook_card_need_state WHERE key_id = ?').run(keyId)
  db.prepare("UPDATE agent_webhook_deliveries SET status = 'failed', last_error = 'webhook removed', next_attempt_at = NULL WHERE key_id = ? AND status = 'pending'").run(keyId)
  deleteSecret(scopeFor(userId), secretNameFor(keyId), userId)
  return { ok: true, value: true }
}

export function listDeliveries(userId: number, keyId: number, limit = 50): Result<AgentWebhookDelivery[]> {
  const db = getDb()
  if (!ownKey(db, userId, keyId)) return { ok: false, status: 404, error: 'Agent key not found' }
  const rows = db.prepare(
    `SELECT id, event_id, event, objective_id, status, attempts, last_status_code, last_error, next_attempt_at, created_at, delivered_at
       FROM agent_webhook_deliveries WHERE key_id = ? ORDER BY id DESC LIMIT ?`,
  ).all(keyId, Math.min(Math.max(limit, 1), 200)) as AgentWebhookDelivery[]
  return { ok: true, value: rows }
}

// ── Enqueue: objective_events → outbox ───────────────────────────────────────

interface EventJoinRow {
  id: number
  objective_id: number
  kind: string
  from_value: string | null
  to_value: string | null
  detail: string | null
  created_at: string
  title: string | null
  status: string | null
  workspace: string | null
  pr_url: string | null
  has_blockers: number | null
  ai_review_verdict: string | null
  blocked_reason: string | null
  needs_secret: string | null
  deleted_at: string | null
  owner_bot: string | null
  key_id: number
  key_label: string
  key_workspaces: string | null
  /** Key owner's role; 'admin' sees every workspace. */
  owner_role: string | null
  /** 1 when the key owner is a member of the card's CURRENT workspace. */
  owner_member: number
  events: string
}

/**
 * Is this card inside the key's authorized scope right now? Same two gates the
 * REST surface applies to a key: its own workspace allowlist (NULL = all of the
 * owner's) AND the owner's membership (an admin owner sees every workspace). A
 * card moved out of scope after the key filed it is never disclosed.
 */
export function cardInKeyScope(row: Pick<EventJoinRow, 'workspace' | 'key_workspaces' | 'owner_role' | 'owner_member'>): boolean {
  if (row.key_workspaces) {
    let allow: unknown = null
    try { allow = JSON.parse(row.key_workspaces) } catch { allow = [] }
    if (!Array.isArray(allow) || !allow.includes(row.workspace)) return false
  }
  if (row.owner_role === 'admin') return true
  return Number(row.owner_member) > 0
}

function sqliteNow(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '')
}

function toIso(sqliteTs: string): string {
  return /Z$|[+-]\d\d:?\d\d$/.test(sqliteTs) ? sqliteTs : `${sqliteTs.replace(' ', 'T')}Z`
}

export function buildPayload(row: EventJoinRow, mapped: MappedEvent): Omit<AgentWebhookPayload, 'sent_at'> {
  const prUrl = row.kind === 'pr' && row.detail ? row.detail : row.pr_url
  const payload: Omit<AgentWebhookPayload, 'sent_at'> = {
    event_id: `cc_evt_${row.id}_k${row.key_id}`,
    event: mapped.event,
    objective: {
      id: row.objective_id,
      workspace: row.workspace,
      title: row.title ? row.title.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
      status: row.status,
      pr_url: prUrl ?? null,
      url: cardUrl(row.objective_id),
    },
    occurred_at: toIso(row.created_at),
    agent_key: { id: row.key_id, label: row.key_label },
    // obj 900270: the owning bot rides on every card event (null = unowned).
    owner_bot: row.owner_bot ?? null,
  }
  if (mapped.from_status) payload.from_status = mapped.from_status
  if (mapped.verdict) payload.verdict = mapped.verdict
  return payload
}

// ── needs_agent (obj 900214 pilot) ───────────────────────────────────────────

export interface NeedCardState {
  status: string | null
  has_blockers: number | null
  ai_review_verdict: string | null
  blocked_reason?: string | null
  needs_secret: string | null
  deleted_at?: string | null
}

/** Most urgent first — a later kind never re-wakes over an earlier one. */
export const NEED_ORDER: AgentNeedKind[] = ['needs_secret', 'failed_review', 'blocked', 'review']

/** Pending secret NAMES only (never the worker's free-text reason, never a value). */
function secretNames(raw: string | null): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v)
      ? v.filter(x => x && typeof x.name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(x.name)).map(x => x.name as string)
      : []
  } catch {
    return []
  }
}

/**
 * Does this card need its managing agent right now, and why? Same conditions as
 * get_attention (lib/agent-control.ts classify) minus the time-based `stuck`, plus
 * a reviewer-blocked card in review counts as blocked. The `why` is built from
 * card state only — no description, summary, findings or transcript text.
 */
export function classifyNeed(c: NeedCardState): AgentNeed | null {
  if (c.deleted_at) return null
  if (c.status !== 'working' && c.status !== 'ai_review' && c.status !== 'review') return null
  const secrets = secretNames(c.needs_secret)
  if (secrets.length) {
    return { kind: 'needs_secret', category: 'mike_decision', why: `Worker is waiting on a secret only Operator can supply: ${secrets.slice(0, 5).join(', ')}` }
  }
  if (c.status === 'review' && c.ai_review_verdict === 'fail') {
    return { kind: 'failed_review', category: 'waiting_on_agent', why: 'AI review failed: reopen it with the fixes, or take it to Operator' }
  }
  const reviewerBlocked = c.status === 'review' && c.ai_review_verdict === 'blocked'
  if (reviewerBlocked || ((c.status === 'working' || c.status === 'review') && Number(c.has_blockers) > 0)) {
    const why = reviewerBlocked
      ? `Reviewer could not verify it${c.blocked_reason ? ` (${c.blocked_reason})` : ''}: route it or get a Operator decision`
      : 'Worker raised a blocker: route it or get a Operator decision'
    return { kind: 'blocked', category: 'blocked', why }
  }
  if (c.status === 'review') {
    const lead = c.ai_review_verdict === 'pass' ? 'AI review passed' : 'Waiting in review'
    return { kind: 'review', category: 'mike_decision', why: `${lead}: needs Operator's accept, or a reopen` }
  }
  return null
}

/** e.g. "review · AI review fail · blocker". */
export function statusSummary(c: NeedCardState): string {
  const parts = [c.status ?? 'unknown']
  if (c.ai_review_verdict) parts.push(`AI review ${c.ai_review_verdict}`)
  if (Number(c.has_blockers) > 0) parts.push('blocker')
  const n = secretNames(c.needs_secret).length
  if (n) parts.push(`${n} secret${n === 1 ? '' : 's'} requested`)
  return parts.join(' · ')
}

/** "Grok: General" → "General". */
function agentName(label: string): string {
  return label.replace(/^grok:\s*/i, '').trim() || label
}

/**
 * How the one-line `summary` names who the card is waiting on (obj 900309).
 *
 * The agent KEY is a shared connection — every bot files through it — so the key's
 * label says who sent the request, never who owns the card. Naming it as the owner
 * on an unowned card manufactured ownership metadata out of an authentication
 * artefact: a reader (or a routing bot) could not tell "owned by X" from "filed
 * through X's key and owned by nobody", and the two demand opposite handling.
 *
 * Owned   → name the owner bot.
 * Unowned → say so, explicitly, and name the fallback route (the General),
 *           so the receiving router has the same information the server has.
 *
 * owner_bot is also carried RAW on the payload (null when unowned), so a router
 * never has to parse this sentence — it is for humans and for logs.
 */
export function needRecipientLabel(ownerBot: string | null | undefined): string {
  const owner = (ownerBot ?? '').trim()
  return owner ? agentName(owner) : 'an agent (unowned — routed to the General)'
}

export function buildNeedPayload(row: EventJoinRow, need: AgentNeed): Omit<AgentWebhookPayload, 'sent_at'> {
  const base = buildPayload(row, { event: 'needs_agent' })
  const status = statusSummary(row)
  return {
    ...base,
    event_id: `cc_need_${row.id}_k${row.key_id}`,
    need,
    status_summary: status,
    // Owned card → name the owner bot; unowned → say unowned. NEVER the key label.
    summary: `Card #${row.objective_id}${row.workspace ? ` (${row.workspace})` : ''} needs ${needRecipientLabel(row.owner_bot)}: ${need.why}. Status: ${status}.`,
  }
}

// ── Actionable completion (obj 900309) ───────────────────────────────────────

/**
 * The completion needs are TERMINAL, so they are deduped by a stable per-card
 * event_id rather than by the escalation ladder in agent_webhook_card_need_state.
 *
 * Why not the ladder: classifyNeed() returns null for a card that is `done`, and a
 * null need CLEARS the ladder row. Pushing a terminal kind through it would mean a
 * card that is reopened and finishes again re-wakes, and a late event on the same
 * card could re-insert the same need. A deterministic event_id, de-duplicated by the
 * existing UNIQUE index on agent_webhook_deliveries(event_id), makes the wake
 * at-most-once for the card's whole life, per key, for free and across restarts.
 */
export function completionEventId(kind: 'completed' | 'pr_merged', objectiveId: number, keyId: number): string {
  return `cc_${kind}_${objectiveId}_k${keyId}`
}

export interface CompletionSource {
  kind: string
  from_value: string | null
  to_value: string | null
  deleted_at?: string | null
}

/**
 * Did this event complete the card in a way its owning agent must act on?
 *
 * Two cases, and the exclusions matter as much as the inclusions:
 *
 *  - **`completed`** — a move to `done` whose PREVIOUS status was not `review`.
 *    A child card's reviewer PASS writes `done` directly (mustRouteToHumanReview()
 *    is false whenever parent_id is set), so the card never enters `review` and
 *    never produces a `review` need: it finished, correctly, and silently. That is
 *    the exact path card #900303 took on 2026-11-08 — it went `done` at 09:45 ET
 *    with its owner never told.
 *    A card that WAS in `review` is excluded by design: `review` already woke the
 *    owner (need kind `review`), and the move out of it is Operator signing off. Operator's
 *    human-done semantics are untouched, and no card is routed through a fake
 *    `review` just to manufacture a notification.
 *
 *  - **`pr_merged`** — the card's PR reached `merged`. The deliverable shipped,
 *    which is the other thing an owning agent is waiting to hear. This rides on the
 *    objective_prs state transition, so it is only as reliable as the merge
 *    recording — which is precisely why obj 900309 fixes that first.
 *
 * Everything else returns null. In particular `cancelled` is NOT a completion (it is
 * already its own subscribable event), and a `pr` event moving to `closed` is not
 * either — nothing shipped.
 */
export function classifyCompletion(ev: CompletionSource): AgentNeed | null {
  if (ev.deleted_at) return null
  if (ev.kind === 'status' && ev.to_value === 'done' && ev.from_value !== 'review') {
    return {
      kind: 'completed',
      category: 'completed',
      why: 'Finished and signed off without passing through Needs You — read the result and close out your side',
    }
  }
  if (ev.kind === 'pr' && ev.to_value === 'merged') {
    return {
      kind: 'pr_merged',
      category: 'completed',
      why: 'Its pull request merged — the change has shipped',
    }
  }
  return null
}

/**
 * A completion wake, shaped EXACTLY like a `needs_agent` delivery.
 *
 * This is deliberate and is the whole reason the event name is not new: the Chief of
 * Staff routine only understands `needs_agent`-shaped bodies, so a new top-level
 * event name would have been delivered and then dropped on the floor. A receiver that
 * ignores `need.kind` sees a well-formed needs_agent it can route on `owner_bot`
 * alone; a receiver that reads `need.kind` gets the finer signal. Opt-in is preserved
 * — only a webhook subscribed to `needs_agent` is ever sent one.
 */
export function buildCompletionPayload(row: EventJoinRow, need: AgentNeed): Omit<AgentWebhookPayload, 'sent_at'> {
  const base = buildPayload(row, { event: 'needs_agent' })
  const status = statusSummary(row)
  const what = need.kind === 'pr_merged' ? 'merged' : 'completed'
  return {
    ...base,
    event_id: completionEventId(need.kind as 'completed' | 'pr_merged', row.objective_id, row.key_id),
    need,
    status_summary: status,
    summary: `Card #${row.objective_id}${row.workspace ? ` (${row.workspace})` : ''} ${what} — ${needRecipientLabel(row.owner_bot)}: ${need.why}. Status: ${status}.`,
  }
}

function readCursor(db: Database.Database): number | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CURSOR_SETTING) as { value: string } | undefined
  if (!row) return null
  const n = Number(row.value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function writeCursor(db: Database.Database, v: number): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(CURSOR_SETTING, String(v))
}

/**
 * Move new objective_events into the outbox. First run anchors the cursor at
 * the current head — turning the feature on never replays 30 days of history.
 * Returns how many deliveries were queued.
 */
export function enqueueAgentWebhookEvents(db: Database.Database = getDb(), now = new Date()): number {
  return db.transaction((): number => {
    const head = (db.prepare('SELECT COALESCE(MAX(id), 0) AS head FROM objective_events').get() as { head: number }).head
    const cursor = readCursor(db)
    if (cursor === null) {
      writeCursor(db, head)
      return 0
    }
    if (head <= cursor) return 0

    const rows = db.prepare(
      `SELECT e.id, e.objective_id, e.kind, e.from_value, e.to_value, e.detail, e.created_at,
              o.title, o.status, o.workspace, o.pr_url,
              o.has_blockers, o.ai_review_verdict, o.blocked_reason, o.needs_secret, o.deleted_at, o.owner_bot,
              k.id AS key_id, k.label AS key_label, k.workspaces AS key_workspaces, w.events,
              u.role AS owner_role,
              EXISTS (SELECT 1 FROM user_workspaces uw WHERE uw.user_id = k.user_id AND uw.workspace = o.workspace) AS owner_member
         FROM objective_events e
         JOIN objectives o ON o.id = e.objective_id
         JOIN agent_key_webhooks w ON w.key_id = o.agent_key_id AND w.enabled = 1
         JOIN agent_api_keys k ON k.id = w.key_id AND k.revoked_at IS NULL
         LEFT JOIN users u ON u.id = k.user_id
        WHERE e.id > ? AND e.id <= ?
        ORDER BY e.id ASC
        LIMIT ?`,
    ).all(cursor, head, ENQUEUE_BATCH + 1) as EventJoinRow[]

    const hasMore = rows.length > ENQUEUE_BATCH
    const page = hasMore ? rows.slice(0, ENQUEUE_BATCH) : rows
    const insert = db.prepare(
      `INSERT OR IGNORE INTO agent_webhook_deliveries (event_id, key_id, objective_id, source_event_id, event, payload, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    // Per CARD, not per key (obj 900270): one need → one delivery, even if the
    // card's attribution moves or several keys could otherwise see it.
    const getNeed = db.prepare('SELECT kind FROM agent_webhook_card_need_state WHERE objective_id = ?')
    const clearNeed = db.prepare('DELETE FROM agent_webhook_card_need_state WHERE objective_id = ?')
    const setNeed = db.prepare(
      `INSERT INTO agent_webhook_card_need_state (objective_id, kind, key_id) VALUES (?, ?, ?)
       ON CONFLICT(objective_id) DO UPDATE SET kind = excluded.kind, key_id = excluded.key_id, updated_at = datetime('now')`,
    )
    /**
     * One wake per card need. Evaluated on the card's state NOW (not the event's), so a
     * burst of moves inside one tick collapses to a single decision. Wake when the
     * card starts needing the agent or escalates (NEED_ORDER); a de-escalation only
     * records the new kind; leaving the needing states re-arms the next wake.
     */
    const enqueueNeed = (row: EventJoinRow): number => {
      const need = classifyNeed(row)
      const prev = (getNeed.get(row.objective_id) as { kind: AgentNeedKind } | undefined)?.kind
      if (!need) {
        if (prev) clearNeed.run(row.objective_id)
        return 0
      }
      if (prev === need.kind) return 0
      setNeed.run(row.objective_id, need.kind, row.key_id)
      if (prev && NEED_ORDER.indexOf(need.kind) > NEED_ORDER.indexOf(prev)) return 0
      const payload = buildNeedPayload(row, need)
      return insert.run(payload.event_id, row.key_id, row.objective_id, row.id, 'needs_agent', JSON.stringify(payload), sqliteNow(now)).changes
    }
    /**
     * A completion wake (obj 900309). Separate from enqueueNeed on purpose: the
     * need ladder is for OPEN cards and is cleared by a terminal status, so a
     * completion cannot ride it. Dedupe is the deterministic event_id against the
     * UNIQUE index on agent_webhook_deliveries(event_id) — INSERT OR IGNORE makes a
     * second done/merge event for the same card a silent no-op, so a reopen→done
     * cycle, a replayed PR state transition, or two keys racing the same tick
     * cannot produce a duplicate. Returns rows queued (0 or 1).
     */
    const enqueueCompletion = (row: EventJoinRow): number => {
      const need = classifyCompletion({
        kind: row.kind,
        from_value: row.from_value,
        to_value: row.to_value,
        deleted_at: row.deleted_at,
      })
      if (!need) return 0
      const payload = buildCompletionPayload(row, need)
      return insert.run(payload.event_id, row.key_id, row.objective_id, row.id, 'needs_agent', JSON.stringify(payload), sqliteNow(now)).changes
    }
    let queued = 0
    for (const row of page) {
      // A key is never told about a card outside its scope (e.g. the card was moved
      // after the key created it, or the owner lost the workspace).
      if (!cardInKeyScope(row)) continue
      const subscribed = parseEvents(row.events)
      const mapped = mapChange(row.kind, row.from_value, row.to_value)
      if (mapped && subscribed.includes(mapped.event)) {
        const payload = buildPayload(row, mapped)
        const r = insert.run(payload.event_id, row.key_id, row.objective_id, row.id, mapped.event, JSON.stringify(payload), sqliteNow(now))
        queued += r.changes
      }
      if (subscribed.includes('needs_agent')) {
        queued += enqueueNeed(row)
        queued += enqueueCompletion(row)
      }
    }
    writeCursor(db, hasMore ? page[page.length - 1].id : head)
    return queued
  })()
}

// ── Deliver ──────────────────────────────────────────────────────────────────

interface DeliveryRow {
  id: number
  event_id: string
  key_id: number
  event: string
  payload: string
  attempts: number
}

interface SendTarget { url: string; header_name: string; header_prefix: string; user_id: number }

interface SendOutcome { ok: boolean; status: number | null; error: string | null }

/** One signed POST. Never throws; the error text never contains the key. */
async function sendOnce(target: SendTarget, secret: string, body: string, meta: { event: string; event_id: string; attempt: number }): Promise<SendOutcome> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'CommandCenter-Webhooks/1',
    'X-CC-Event': meta.event,
    'X-CC-Event-Id': meta.event_id,
    'X-CC-Delivery-Attempt': String(meta.attempt),
    [SIGNATURE_HEADER]: signBody(secret, body),
    [target.header_name]: `${target.header_prefix}${secret}`,
  }
  // obj 900270 / #900244: resolve + validate the destination NOW, every attempt.
  // A refused host is a normal failed attempt (retried, then failed) — no request
  // is made and the key is never sent.
  const dest = await resolveWebhookDestination(target.url)
  if (!dest.ok) return { ok: false, status: null, error: dest.error }
  try {
    const res = await fetchImpl(target.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'manual',
      address: dest.address,
      family: dest.family,
      addresses: dest.addresses,
    })
    const ok = res.status >= 200 && res.status < 300
    return { ok, status: res.status, error: ok ? null : `HTTP ${res.status}` }
  } catch (err) {
    const e = err as Error
    const msg = e.name === 'TimeoutError' || e.name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT_MS / 1000}s` : (e.message || 'request failed')
    return { ok: false, status: null, error: msg.split(secret).join('[REDACTED]').slice(0, 300) }
  }
}

function loadTarget(db: Database.Database, keyId: number): (SendTarget & { enabled: number; revoked_at: string | null }) | null {
  return (db.prepare(
    `SELECT w.url, w.header_name, w.header_prefix, w.user_id, w.enabled, k.revoked_at
       FROM agent_key_webhooks w JOIN agent_api_keys k ON k.id = w.key_id WHERE w.key_id = ?`,
  ).get(keyId) as (SendTarget & { enabled: number; revoked_at: string | null }) | undefined) ?? null
}

/** Send every due pending delivery (bounded batch). Returns rows attempted. */
export async function deliverDueAgentWebhooks(db: Database.Database = getDb(), now = new Date()): Promise<number> {
  const nowTs = sqliteNow(now)
  const due = db.prepare(
    `SELECT id, event_id, key_id, event, payload, attempts FROM agent_webhook_deliveries
      WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id ASC LIMIT ?`,
  ).all(nowTs, DELIVER_BATCH) as DeliveryRow[]
  if (!due.length) return 0

  // Lease first so an overlapping tick never double-sends.
  const lease = db.prepare('UPDATE agent_webhook_deliveries SET next_attempt_at = ? WHERE id = ?')
  const leaseTs = sqliteNow(new Date(now.getTime() + LEASE_MS))
  for (const d of due) lease.run(leaseTs, d.id)

  const finish = db.prepare(
    `UPDATE agent_webhook_deliveries SET status = ?, attempts = ?, last_status_code = ?, last_error = ?,
       next_attempt_at = ?, delivered_at = CASE WHEN ? = 'delivered' THEN datetime('now') ELSE delivered_at END
     WHERE id = ?`,
  )

  await Promise.all(due.map(async d => {
    const attempt = d.attempts + 1
    const target = loadTarget(db, d.key_id)
    if (!target || !target.enabled || target.revoked_at) {
      finish.run('failed', d.attempts, null, !target ? 'webhook removed' : target.revoked_at ? 'agent key revoked' : 'webhook disabled', null, 'failed', d.id)
      return
    }
    const secret = getSecretValue(scopeFor(target.user_id), secretNameFor(d.key_id), target.user_id)
    let outcome: SendOutcome
    if (!secret) {
      outcome = { ok: false, status: null, error: 'no sender key stored' }
    } else {
      const body = JSON.stringify({ ...JSON.parse(d.payload), sent_at: new Date().toISOString() })
      outcome = await sendOnce(target, secret, body, { event: d.event, event_id: d.event_id, attempt })
    }
    if (outcome.ok) {
      finish.run('delivered', attempt, outcome.status, null, null, 'delivered', d.id)
    } else if (attempt >= MAX_ATTEMPTS) {
      finish.run('failed', attempt, outcome.status, outcome.error, null, 'failed', d.id)
    } else {
      const next = sqliteNow(new Date(now.getTime() + RETRY_BACKOFF_MS[attempt - 1]))
      finish.run('pending', attempt, outcome.status, outcome.error, next, 'pending', d.id)
    }
  }))
  return due.length
}

// ── Test event (Settings button) ─────────────────────────────────────────────

export async function sendTestEvent(userId: number, keyId: number): Promise<Result<{ delivered: boolean; status_code: number | null; error: string | null; event_id: string }>> {
  const db = getDb()
  const key = ownKey(db, userId, keyId)
  if (!key) return { ok: false, status: 404, error: 'Agent key not found' }
  const target = loadTarget(db, keyId)
  if (!target) return { ok: false, status: 404, error: 'Save a webhook for this key first' }
  const secret = getSecretValue(scopeFor(userId), secretNameFor(keyId), userId)
  if (!secret) return { ok: false, status: 400, error: 'No sender key stored for this webhook' }

  const eventId = `cc_test_${crypto.randomUUID()}`
  const nowIso = new Date().toISOString()
  const cfg = db.prepare('SELECT events FROM agent_key_webhooks WHERE key_id = ?').get(keyId) as { events: string } | undefined
  const payload: AgentWebhookPayload = parseEvents(cfg?.events ?? null).includes('needs_agent')
    ? {
        event_id: eventId,
        event: 'needs_agent',
        test: true,
        objective: { id: 0, workspace: null, title: 'Test event from Command Center', status: 'review', pr_url: null, url: cardUrl(0) },
        need: { kind: 'review', category: 'mike_decision', why: 'Test only: nothing needs you. A real wake says why the card needs you' },
        status_summary: 'review',
        summary: `Test from Command Center: card wakes for ${agentName(key.label)} are connected. Nothing to do.`,
        occurred_at: nowIso,
        sent_at: nowIso,
        agent_key: { id: key.id, label: key.label },
        owner_bot: null,
      }
    : {
        event_id: eventId,
        event: 'entered_review',
        test: true,
        objective: { id: 0, workspace: null, title: 'Test event from Command Center', status: 'review', pr_url: null, url: cardUrl(0) },
        from_status: 'working',
        occurred_at: nowIso,
        sent_at: nowIso,
        agent_key: { id: key.id, label: key.label },
      }
  const body = JSON.stringify(payload)
  const outcome = await sendOnce(target, secret, body, { event: payload.event, event_id: eventId, attempt: 1 })
  db.prepare(
    `INSERT INTO agent_webhook_deliveries (event_id, key_id, objective_id, event, payload, status, attempts, last_status_code, last_error, delivered_at)
     VALUES (?, ?, NULL, ?, ?, ?, 1, ?, ?, CASE WHEN ? = 'delivered' THEN datetime('now') END)`,
  ).run(eventId, keyId, payload.event, body, outcome.ok ? 'delivered' : 'failed', outcome.status, outcome.error, outcome.ok ? 'delivered' : 'failed')
  return { ok: true, value: { delivered: outcome.ok, status_code: outcome.status, error: outcome.error, event_id: eventId } }
}

// ── Timer ────────────────────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null
let running = false

export async function agentWebhookTick(): Promise<void> {
  if (running) return
  running = true
  try {
    enqueueAgentWebhookEvents()
    await deliverDueAgentWebhooks()
  } catch (err) {
    console.error('[agent-webhooks] tick failed:', (err as Error).message)
  } finally {
    running = false
  }
}

export function startAgentWebhooks(): void {
  if (timer) return
  timer = setInterval(() => { void agentWebhookTick() }, TICK_MS)
  timer.unref?.()
}
