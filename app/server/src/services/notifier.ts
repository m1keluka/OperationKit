import fs from 'fs'
import { getDb } from '../db/index.js'
import { broadcast } from '../ws/index.js'
import type { Alert, AlertSeverity } from '@operationkit/shared'
import { emailConfigured, sendMail } from './mailer/index.js'

export type Severity = AlertSeverity

export interface NotifyArgs {
  severity: Severity
  title: string
  message: string
  source?: string
  dedup_key?: string
  url?: string
  /**
   * Sub-type within a source (obj 900677). The notification type key is
   * `source` or `source:kind`; see NOTIFICATION_TYPES.
   */
  kind?: string
  /**
   * dedup_key of the alert this one resolves (obj 900677). Every UNREAD alert
   * with that key is marked read (acked_by='auto-resolved') first, so a
   * recovery clears the "down" item even though the recovery notice itself is
   * muted by default.
   */
  resolves?: string
}

// ── Notification types (obj 900677) ─────────────────────────────────────────
// Every type the server raises, whether it reaches the bell (and email, for
// high/emergency) by default, and why. The rule: a type is ON only if a human
// has to act and nothing else — the card itself, its owner bot, an automatic
// retry — already covers it. Anything a card already shows, or that clears
// itself, is OFF.
//
// Per-install override, no deploy needed:
//   INSERT OR REPLACE INTO settings (key, value) VALUES ('notify:<key>', '1')  -- on
//   INSERT OR REPLACE INTO settings (key, value) VALUES ('notify:<key>', '0')  -- off
// A key that is not listed (e.g. an external script posting to POST
// /api/alerts) is ON: an unknown source stays visible, never silently dropped.
export interface NotificationType {
  key: string
  defaultOn: boolean
  reason: string
}

export const NOTIFICATION_TYPES: readonly NotificationType[] = [
  // Kept: a human has to do something.
  { key: 'objectives-safety', defaultOn: true, reason: 'The board row count dropped sharply: possible data loss.' },
  { key: 'account-router', defaultOn: true, reason: 'A Claude account needs reconnecting or an admin. Only a human can do it.' },
  { key: 'seat-pool', defaultOn: true, reason: 'A seat credential expired or expires soon. Rotate it before sessions fail.' },
  { key: 'drift-guard', defaultOn: true, reason: 'The live checkout has unbacked edits, is ahead of main, or has been stuck behind main for hours.' },
  { key: 'disk-watchdog', defaultOn: true, reason: 'Disk is low or critically full. Messages start failing.' },
  { key: 'n8n-watchdog', defaultOn: true, reason: 'n8n is down after the auto-restart.' },
  { key: 'preview-health-watchdog', defaultOn: true, reason: 'Every PR preview is dead until the preview tier is fixed.' },
  { key: 'routines', defaultOn: true, reason: 'A routine stopped firing or was auto-paused, so its watchdog is silent.' },
  { key: 'posthog-hot-owner-sync', defaultOn: true, reason: 'The PostHog hot_owner sync failed several runs in a row.' },
  { key: 'disabled-model-rescue', defaultOn: true, reason: 'Open cards point at a disabled model. Someone has to reassign them.' },
  { key: 'ci-green-gate', defaultOn: true, reason: 'A PR hit the CI hold cap and will not be handed back again.' },
  { key: 'pr-health-watchdog', defaultOn: true, reason: 'A red PR has no session left to fix it.' },
  // Cut: the card or a bot already covers it, or it clears itself.
  { key: 'stall-watchdog', defaultOn: false, reason: 'Per card. The card shows the Stalled flag and its owner bot is woken.' },
  { key: 'abnormal-end', defaultOn: false, reason: 'Per card. The card is parked blocked and its owner bot is woken.' },
  { key: 'runner-failure', defaultOn: false, reason: 'Per card. The card is parked in Review with a blocked verdict.' },
  { key: 'state-poller', defaultOn: false, reason: 'Per card. A delegator parked in Review after no-progress wakes; Review shows it.' },
  { key: 'disk-watchdog:warn', defaultOn: false, reason: 'Early warning only. Cleanup runs by itself at 90%, and the low/full alerts stay on.' },
  { key: 'n8n-watchdog:recovered', defaultOn: false, reason: 'A recovery now clears the "n8n is DOWN" item instead of adding a second one.' },
  { key: 'preview-health-watchdog:recovered', defaultOn: false, reason: 'A recovery now clears the "preview tier is DOWN" item instead of adding a second one.' },
]

const TYPE_BY_KEY = new Map(NOTIFICATION_TYPES.map(t => [t.key, t]))

/** `source:kind` when a kind is given, else `source`. */
export function notificationTypeKey(args: Pick<NotifyArgs, 'source' | 'kind'>): string {
  const source = args.source ?? 'unknown'
  return args.kind ? `${source}:${args.kind}` : source
}

function readTypeOverride(key: string): boolean | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(`notify:${key}`) as { value: string } | undefined
    if (row?.value === '1') return true
    if (row?.value === '0') return false
  } catch { /* no settings table yet / test shim: use the default */ }
  return null
}

/**
 * Whether a notification type is delivered. A `source:kind` key with no entry
 * of its own falls back to its `source`, so turning a source off also silences
 * all of its kinds.
 */
export function isNotificationTypeEnabled(key: string): boolean {
  const override = readTypeOverride(key)
  if (override !== null) return override
  const own = TYPE_BY_KEY.get(key)
  if (own) return own.defaultOn
  const colon = key.indexOf(':')
  if (colon > 0) return isNotificationTypeEnabled(key.slice(0, colon))
  return true
}

/** Mark every unread alert with this dedup_key read. Never throws. */
function autoResolve(dedupKey: string): void {
  try {
    const db = getDb()
    const ids = db.prepare('SELECT id FROM alerts WHERE dedup_key = ? AND acked_at IS NULL').all(dedupKey) as { id: number }[]
    if (ids.length === 0) return
    db.prepare("UPDATE alerts SET acked_at = datetime('now'), acked_by = 'auto-resolved' WHERE dedup_key = ? AND acked_at IS NULL").run(dedupKey)
    for (const { id } of ids) broadcast({ type: 'alert_acked', payload: { id } })
  } catch { /* best-effort */ }
}

/**
 * A condition that is still unread is not raised again. Before obj 900677 the
 * only dedup was a 10-minute in-memory window, so a condition that lasted a
 * day (drift, an expiring seat, a stopped routine) added a new row every ten
 * minutes and again after every restart. Never throws.
 */
function hasUnreadWithKey(dedupKey: string): boolean {
  try {
    return !!getDb().prepare('SELECT 1 FROM alerts WHERE dedup_key = ? AND acked_at IS NULL LIMIT 1').get(dedupKey)
  } catch {
    return false
  }
}

const RESEND_API = 'https://api.resend.com/emails'
const MSG_LIMIT = 4000
const TITLE_LIMIT = 250
const DEFAULT_DEDUP_TTL_MS = 10 * 60 * 1000
const SUBJECT_PREFIX: Record<Severity, string> = {
  normal: '',
  high: '[HIGH] ',
  emergency: '[EMERGENCY] ',
}

const dedupCache = new Map<string, number>()

function emailEnabled(): boolean {
  return process.env.ALERTS_ENABLED !== 'false'
}

function isDuplicate(key: string, ttlMs: number): boolean {
  const now = Date.now()
  for (const [k, ts] of dedupCache) {
    if (now - ts > ttlMs) dedupCache.delete(k)
  }
  const last = dedupCache.get(key)
  if (last !== undefined && now - last < ttlMs) return true
  dedupCache.set(key, now)
  return false
}

function rowToAlert(row: Record<string, unknown>): Alert {
  return {
    id: row.id as number,
    severity: row.severity as AlertSeverity,
    source: row.source as string,
    title: row.title as string,
    message: row.message as string,
    dedup_key: (row.dedup_key as string | null) ?? null,
    url: (row.url as string | null) ?? null,
    email_sent_at: (row.email_sent_at as string | null) ?? null,
    acked_at: (row.acked_at as string | null) ?? null,
    acked_by: (row.acked_by as string | null) ?? null,
    created_at: row.created_at as string,
  }
}

export function insertAlert(args: NotifyArgs): Alert | null {
  if (args.resolves) autoResolve(args.resolves)
  const typeKey = notificationTypeKey(args)
  if (!isNotificationTypeEnabled(typeKey)) {
    console.log(`[notifier] muted (${typeKey}): ${args.title.slice(0, 120)}`)
    return null
  }
  if (args.dedup_key && hasUnreadWithKey(args.dedup_key)) {
    return null
  }
  if (args.dedup_key && isDuplicate(args.dedup_key, DEFAULT_DEDUP_TTL_MS)) {
    return null
  }
  const db = getDb()
  const result = db
    .prepare(
      `INSERT INTO alerts (severity, source, title, message, dedup_key, url)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      args.severity,
      args.source ?? 'unknown',
      args.title.slice(0, TITLE_LIMIT),
      args.message.slice(0, MSG_LIMIT),
      args.dedup_key ?? null,
      args.url ?? null,
    )
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
  return rowToAlert(row)
}

function alertBody(alert: Alert): string {
  return [
    alert.message,
    '',
    `Source: ${alert.source}`,
    alert.url ? `Link: ${alert.url}` : null,
    `Time: ${alert.created_at}`,
  ]
    .filter(Boolean)
    .join('\n')
}

async function sendEmail(alert: Alert): Promise<boolean> {
  const to = process.env.ALERTS_TO_EMAIL
  const subject = `${SUBJECT_PREFIX[alert.severity]}${alert.title}`.slice(0, 250)
  // obj 900497: an install with its own sender (Settings → Email) sends alerts
  // through it. The legacy RESEND_API_KEY path below stays for installs that
  // configured alerts that way and have not set up the mailer.
  if (to && emailConfigured()) {
    const result = await sendMail({ to, subject, text: alertBody(alert) })
    return result.ok
  }
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.ALERTS_FROM_EMAIL || 'alerts@example.com'
  if (!apiKey || !to) {
    console.warn('[notifier] RESEND_API_KEY or ALERTS_TO_EMAIL missing — email skipped:', alert.title)
    return false
  }
  const body = alertBody(alert)

  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text: body }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[notifier] Resend returned ${res.status}: ${text}`)
      return false
    }
    return true
  } catch (err) {
    console.warn('[notifier] Resend fetch failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function notify(args: NotifyArgs): Promise<void> {
  try {
    const alert = insertAlert(args)
    if (!alert) return

    broadcast({ type: 'alert', payload: alert })

    if (alert.severity !== 'normal' && emailEnabled()) {
      const sent = await sendEmail(alert)
      if (sent) {
        try {
          getDb()
            .prepare("UPDATE alerts SET email_sent_at = datetime('now') WHERE id = ?")
            .run(alert.id)
        } catch (err) {
          console.warn('[notifier] failed to mark email_sent_at:', err instanceof Error ? err.message : err)
        }
      }
    }
  } catch (err) {
    console.warn('[notifier] failed:', err instanceof Error ? err.message : err)
  }
}

export function _resetDedupForTests(): void {
  dedupCache.clear()
}

// ── Telegram escalation ──────────────────────────────────────────────────────
// Investigation finding (2026-06-12): there is no "hermes" service or container
// on this host. The Telegram bridge is the `example-assistant` container — a grammY
// bot using long-polling with NO exposed ports and NO localhost HTTP API, so
// there is no POST-able localhost send path. Its credentials, however, live at
// /home/operator/projects/example-assistant/.env (the projects dir is mounted into this
// container), and the Telegram Bot API is directly callable with native fetch.
// So the working send path is: read TELEGRAM_BOT_TOKEN + TELEGRAM_USER_ID from
// that file and POST to api.telegram.org/bot<token>/sendMessage. If the file is
// missing or the send fails, callers degrade gracefully — the needs-human
// warning event in the DB/SessionViewer is the fallback surface.
const TELEGRAM_ENV_PATH = '/home/operator/projects/example-assistant/.env'

function readTelegramCreds(): { token: string; chatId: string } | null {
  try {
    const content = fs.readFileSync(TELEGRAM_ENV_PATH, 'utf-8')
    const get = (key: string): string | null => {
      const m = content.match(new RegExp(`^${key}=(.+)$`, 'm'))
      if (!m) return null
      return m[1].trim().replace(/^["']|["']$/g, '') || null
    }
    const token = get('TELEGRAM_BOT_TOKEN')
    const chatId = get('TELEGRAM_USER_ID')
    if (!token || !chatId) return null
    return { token, chatId }
  } catch {
    return null
  }
}

export async function sendTelegram(text: string): Promise<boolean> {
  const creds = readTelegramCreds()
  if (!creds) {
    console.warn('[notifier] Telegram creds unavailable (example-assistant .env unreadable) — send skipped')
    return false
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${creds.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: creds.chatId, text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[notifier] Telegram send failed: ${res.status} ${body.slice(0, 200)}`)
      return false
    }
    return true
  } catch (err) {
    console.warn('[notifier] Telegram send error:', err instanceof Error ? err.message : err)
    return false
  }
}
