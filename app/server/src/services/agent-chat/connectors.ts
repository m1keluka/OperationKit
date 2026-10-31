// ── Email + calendar connectors for chat agents (obj 719987) ──
//
// Agents only ever DRAFT. There is deliberately no "send" tool: a draft is a
// row in agent_chat_drafts that the person sees in the chat with a Send (or
// "Add to calendar") button, and only that click — a separate, cookie-authed
// HTTP call — acts on it.
//
// Today the only backend is the built-in demo (fake inbox + calendar shipped
// in ./demo). A real mailbox/calendar plugs in by implementing MailConnector /
// CalendarConnector and returning it from resolveConnectors().
import fs from 'fs'
import path from 'path'
import { getDb } from '../../db/index.js'
import { DEMO_DIR } from './agent-defs.js'

export interface MailSummary { id: string; from: string; subject: string; received_at: string; unread: boolean; preview: string }
export interface MailMessage extends MailSummary { body: string }
export interface CalendarEvent { id: string; title: string; start: string; end: string; with: string[] }

export interface EmailDraft { to: string; subject: string; body: string; in_reply_to?: string | null }
export interface EventDraft { title: string; start: string; end: string; with: string[]; note?: string | null }

export interface MailConnector {
  id: string
  label: string
  listInbox(limit: number, unreadOnly: boolean): MailSummary[]
  read(id: string): MailMessage | null
  /** Called only from the person's Send click, never from a tool. */
  deliver(draft: EmailDraft): void
}
export interface CalendarConnector {
  id: string
  label: string
  listEvents(fromIso: string, toIso: string): CalendarEvent[]
  /** Called only from the person's "Add to calendar" click, never from a tool. */
  add(draft: EventDraft): void
}

interface DemoInbox { messages: { id: string; hours_ago: number; from: string; subject: string; unread: boolean; body: string }[] }
interface DemoCalendar { events: { id: string; day_offset: number; start: string; minutes: number; title: string; with: string[] }[] }

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DEMO_DIR, file), 'utf8')) as T
}

/** Sample data is stored with relative times so the demo always looks current. */
export function demoMail(now: () => Date = () => new Date()): MailConnector {
  const all = (): MailMessage[] =>
    readJson<DemoInbox>('inbox.json').messages.map(m => ({
      id: m.id,
      from: m.from,
      subject: m.subject,
      unread: m.unread,
      received_at: new Date(now().getTime() - m.hours_ago * 3600_000).toISOString(),
      preview: m.body.replace(/\s+/g, ' ').slice(0, 140),
      body: m.body,
    }))
  return {
    id: 'demo',
    label: 'Demo inbox (sample data)',
    listInbox: (limit, unreadOnly) =>
      all()
        .filter(m => !unreadOnly || m.unread)
        .slice(0, limit)
        .map(({ body: _b, ...s }) => s),
    read: id => all().find(m => m.id === id) ?? null,
    deliver: () => { /* demo: the draft row flips to "sent"; nothing leaves the server */ },
  }
}

export function demoCalendar(now: () => Date = () => new Date()): CalendarConnector {
  const all = (): CalendarEvent[] => {
    const base = now()
    return readJson<DemoCalendar>('calendar.json').events.map(e => {
      const [h, m] = e.start.split(':').map(Number)
      const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + e.day_offset, h, m)
      return { id: e.id, title: e.title, with: e.with, start: start.toISOString(), end: new Date(start.getTime() + e.minutes * 60_000).toISOString() }
    })
  }
  return {
    id: 'demo',
    label: 'Demo calendar (sample data)',
    listEvents: (fromIso, toIso) => {
      const from = Date.parse(fromIso)
      const to = Date.parse(toIso)
      return all().filter(e => Date.parse(e.end) >= from && Date.parse(e.start) <= to)
    },
    add: () => { /* demo: the draft row flips to "added" */ },
  }
}

export interface Connectors { mail: MailConnector | null; calendar: CalendarConnector | null }

export function resolveConnectors(opts: { demo: boolean; now?: () => Date }): Connectors {
  if (opts.demo) return { mail: demoMail(opts.now), calendar: demoCalendar(opts.now) }
  return { mail: null, calendar: null }
}

// ── Drafts ──

export type DraftKind = 'email' | 'event'
export type DraftStatus = 'draft' | 'sent' | 'added' | 'discarded'
export interface DraftRow {
  id: number
  user_id: number
  agent_slug: string
  kind: DraftKind
  connector: string
  payload: EmailDraft | EventDraft
  status: DraftStatus
  created_at: string
  updated_at: string
}

function mapDraft(r: Record<string, unknown>): DraftRow {
  return { ...(r as unknown as DraftRow), payload: JSON.parse(String(r.payload)) }
}

export function createDraft(userId: number, agentSlug: string, kind: DraftKind, connector: string, payload: EmailDraft | EventDraft): DraftRow {
  const db = getDb()
  const info = db
    .prepare('INSERT INTO agent_chat_drafts (user_id, agent_slug, kind, connector, payload) VALUES (?, ?, ?, ?, ?)')
    .run(userId, agentSlug, kind, connector, JSON.stringify(payload))
  return getDraft(Number(info.lastInsertRowid))!
}

export function getDraft(id: number): DraftRow | null {
  const r = getDb().prepare('SELECT * FROM agent_chat_drafts WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? mapDraft(r) : null
}

export function listDrafts(userId: number, agentSlug: string): DraftRow[] {
  return (getDb()
    .prepare('SELECT * FROM agent_chat_drafts WHERE user_id = ? AND agent_slug = ? ORDER BY id')
    .all(userId, agentSlug) as Record<string, unknown>[]).map(mapDraft)
}

export function setDraftStatus(id: number, status: DraftStatus): void {
  getDb().prepare("UPDATE agent_chat_drafts SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id)
}
