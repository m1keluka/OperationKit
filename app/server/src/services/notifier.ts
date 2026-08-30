import fs from 'fs'
import { getDb } from '../db/index.js'
import { broadcast } from '../ws/index.js'
import type { Alert, AlertSeverity } from '@operationkit/shared'

export type Severity = AlertSeverity

export interface NotifyArgs {
  severity: Severity
  title: string
  message: string
  source?: string
  dedup_key?: string
  url?: string
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

async function sendEmail(alert: Alert): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.ALERTS_FROM_EMAIL || 'alerts@example.com'
  const to = process.env.ALERTS_TO_EMAIL
  if (!apiKey || !to) {
    console.warn('[notifier] RESEND_API_KEY or ALERTS_TO_EMAIL missing — email skipped:', alert.title)
    return false
  }
  const subject = `${SUBJECT_PREFIX[alert.severity]}${alert.title}`.slice(0, 250)
  const body = [
    alert.message,
    '',
    `Source: ${alert.source}`,
    alert.url ? `Link: ${alert.url}` : null,
    `Time: ${alert.created_at}`,
  ]
    .filter(Boolean)
    .join('\n')

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
