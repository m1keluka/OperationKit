/**
 * Owner-pasted secrets in card chat (obj 718944, case added 10/27).
 *
 * When the VERIFIED owner pastes a credential into a card chat, refusing it as
 * "exposed" helps nobody: the value has already crossed the wire. Instead the
 * server, before anything is stored or sent to the session:
 *   1. moves the value into the secrets store at the card's WORKSPACE scope,
 *      under the name the owner gave (or the one the card is waiting on),
 *   2. replaces it everywhere downstream (jsonl, session text, logs) with
 *      `[REDACTED:<NAME>]`,
 *   3. records a non-blocking "rotate later" flag (secret_rotation_flags),
 *   4. clears that name from the card's needs_secret list.
 * The session can then use it through the broker immediately (the broker reads
 * the store live) and as $NAME once its follow-up respawn rebuilds the env.
 *
 * Only ever called for a verified owner with settings.session_secret_access on;
 * an agent/API post is never captured into the store (that would let a bot
 * write secrets). Its credentials are still scrubbed by redactForStorage.
 *
 * How a value gets its NAME, in order:
 *   a. explicit `NAME=value` / `NAME: value` / `NAME is value` with an
 *      UPPER_SNAKE secret-ish name;
 *   b. a high-confidence key shape (sk-…, ghp_…, xoxb-…) → the card's single
 *      pending needs_secret name, else that vendor's conventional name;
 *   c. one bare token-shaped string while the card waits on exactly ONE secret
 *      → that name. (Never guessed otherwise.)
 */
import type { NeedsSecretItem, Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { PATTERN_RULES, SECRET_NAME_RE as SECRETISH_NAME, isPlausibleSecretValue } from './secret-redaction.js'
import { setSecret } from './secrets-store.js'
import { logActivity } from '../routes/feed.js'

export interface PastedSecret {
  name: string
  value: string
  how: 'named' | 'shape' | 'pending'
}

export interface DetectResult {
  text: string
  found: PastedSecret[]
}

const UPPER_SNAKE = /^[A-Z][A-Z0-9_]{1,63}$/
const ASSIGN = /\b([A-Z][A-Z0-9_]{2,63})(\s*(?:=|:|\s+is)\s*)(["'`]?)([^\s"'`]{8,})\3/g
const NOT_A_VALUE = /^(\[REDACTED|\$|\{\{|<|%|\*{3})|^(changeme|example|placeholder|xxx+)$/i

/** Conventional store names for shapes that identify their vendor. */
const FAMILY_NAME: Record<string, string> = {
  OPENAI_KEY: 'OPENAI_API_KEY',
  ANTHROPIC_KEY: 'ANTHROPIC_API_KEY',
  STRIPE_KEY: 'STRIPE_SECRET_KEY',
  GITHUB_TOKEN: 'GITHUB_TOKEN',
  SLACK_TOKEN: 'SLACK_BOT_TOKEN',
  GOOGLE_API_KEY: 'GOOGLE_API_KEY',
  SUPABASE_KEY: 'SUPABASE_SECRET_KEY',
}

const BARE_TOKEN = /(?<![\w[/.:@-])([A-Za-z0-9][A-Za-z0-9_-]{23,})(?![\w/.@-])/g

function looksLikeToken(s: string): boolean {
  if (!/\d/.test(s) || !/[A-Za-z]/.test(s)) return false
  if (/^[0-9a-f]+$/i.test(s)) return false // git SHAs, hex ids
  if (/^cc-\d+-\d+$/.test(s)) return false // session ids
  return true
}

/** Pure: find owner-pasted credentials, name them, and redact them in `text`. */
export function detectPastedSecrets(text: string, pending: NeedsSecretItem[] = []): DetectResult {
  const found: PastedSecret[] = []
  const take = (name: string, value: string, how: PastedSecret['how']) => {
    const prior = found.find(f => f.value === value)
    if (prior) return `[REDACTED:${prior.name}]`
    found.push({ name, value, how })
    return `[REDACTED:${name}]`
  }

  // a. explicit NAME=value
  let out = text.replace(ASSIGN, (m, name: string, sep: string, q: string, value: string) => {
    if (!UPPER_SNAKE.test(name) || !SECRETISH_NAME.test(name)) return m
    if (NOT_A_VALUE.test(value) || !isPlausibleSecretValue(value)) return m
    return `${name}${sep}${q}${take(name, value, 'named')}${q}`
  })

  // b. vendor-identifying shapes
  const single = pending.length === 1 ? pending[0].name : null
  for (const rule of PATTERN_RULES) {
    if (!rule.high || rule.replace) continue
    const fallback = FAMILY_NAME[rule.family]
    if (!single && !fallback) continue
    rule.re.lastIndex = 0
    out = out.replace(rule.re, m => (m.startsWith('[REDACTED') ? m : take(single ?? fallback!, m, 'shape')))
  }

  // c. one bare token while the card waits on exactly one secret
  if (single && !found.some(f => f.name === single)) {
    const candidates = [...out.matchAll(BARE_TOKEN)].map(m => m[1]).filter(looksLikeToken)
    if (candidates.length === 1) {
      const value = candidates[0]
      out = out.split(value).join(take(single, value, 'pending'))
    }
  }
  // Any further occurrence of a captured value (pasted twice, quoted back) too.
  for (const f of found) out = out.split(f.value).join(`[REDACTED:${f.name}]`)
  return { text: out, found }
}

export interface CaptureResult {
  text: string
  captured: string[]
}

/**
 * Impure: store each detected value at the card's workspace scope, flag it for
 * rotation, clear it from needs_secret, and return the redacted message.
 * A store failure leaves that value redacted but uncaptured (never echoed).
 */
export function captureOwnerPastedSecrets(
  objective: Objective,
  message: string,
  actor: { id: number; username: string },
): CaptureResult {
  const db = getDb()
  const pending = parseNeedsSecretRaw((objective as unknown as { needs_secret?: unknown }).needs_secret)
  const { text, found } = detectPastedSecrets(message, pending)
  if (found.length === 0) return { text: message, captured: [] }

  const workspace = objective.workspace || 'example'
  const captured: string[] = []
  for (const f of found) {
    try {
      setSecret({ scope: { scopeType: 'workspace', workspace }, key: f.name, value: f.value, actorUserId: actor.id })
      db.prepare(
        'INSERT INTO secret_rotation_flags (workspace, key, objective_id, source, flagged_by) VALUES (?, ?, ?, ?, ?)',
      ).run(workspace, f.name, objective.id, 'pasted_in_chat', actor.username)
      captured.push(f.name)
    } catch (err) {
      console.error('[chat-secret-capture] store write failed', err instanceof Error ? err.name : 'unknown')
    }
  }
  if (captured.length) {
    const remaining = pending.filter(p => !captured.includes(p.name))
    if (remaining.length !== pending.length) {
      db.prepare("UPDATE objectives SET needs_secret = ?, updated_at = datetime('now') WHERE id = ?")
        .run(remaining.length ? JSON.stringify(remaining) : null, objective.id)
    }
    logActivity({
      project: objective.project || 'operationkit',
      workspace,
      objective_id: objective.id,
      event_type: 'milestone',
      title: `Secret${captured.length > 1 ? 's' : ''} saved from chat: ${captured.join(', ')} (workspace ${workspace}) — flagged to rotate later`,
      metadata: { secret_names: captured, scope: `workspace:${workspace}`, by: actor.username, source: 'pasted_in_chat' },
    })
  }
  const note = captured.length
    ? `\n\n[Command Center: ${captured.join(', ')} saved to the ${workspace} secrets store from this message and flagged to rotate later. ` +
      `Use ${captured.map(n => `$${n}`).join(', ')} (after this restart) or {{secret:NAME}} via the broker now. This is NOT an exposure to refuse over — the owner chose to paste it; do not ask for it again.]`
    : ''
  return { text: text + note, captured }
}

function parseNeedsSecretRaw(raw: unknown): NeedsSecretItem[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter(x => x && typeof x.name === 'string') : []
  } catch {
    return []
  }
}

export interface RotationFlag {
  id: number
  workspace: string
  key: string
  objective_id: number | null
  source: string
  flagged_by: string | null
  created_at: string
  resolved_at: string | null
}

export function listRotationFlags(opts: { includeResolved?: boolean } = {}): RotationFlag[] {
  return getDb()
    .prepare(
      `SELECT id, workspace, key, objective_id, source, flagged_by, created_at, resolved_at
         FROM secret_rotation_flags ${opts.includeResolved ? '' : 'WHERE resolved_at IS NULL'}
        ORDER BY created_at DESC, id DESC LIMIT 200`,
    )
    .all() as RotationFlag[]
}

export function resolveRotationFlag(id: number): boolean {
  return getDb().prepare("UPDATE secret_rotation_flags SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL").run(id).changes > 0
}
