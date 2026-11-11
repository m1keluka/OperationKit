// ── "Demo" provider: a scripted stand-in for an AI (obj 719987) ──
//
// Lets the built-in chat be demonstrated on an install with NO AI account. It
// is honest about what it is (the UI labels every reply "Demo (no AI
// account)") and it drives the agent's REAL tools — the same inbox reads,
// drafts, to-do writes and board cards a real model would make — by matching
// a handful of plain requests:
//   what's in my inbox · reply to <name> · what's on my calendar
//   move/schedule a meeting with <name> · what's on my to-do list
//   add <task> to my to-do list · <ask for real work> → board card · how are my cards doing
import type { OAIToolCall } from '../llm-gateway/translate.js'
import type { CompletionRequest, CompletionResult } from './providers.js'

type Json = Record<string, unknown>

function textOf(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(p => (p && typeof p === 'object' && 'text' in p ? String((p as Json).text ?? '') : '')).join('')
  return ''
}

let seq = 0
function call(name: string, args: Json): CompletionResult {
  const c: OAIToolCall = { id: `demo-${Date.now().toString(36)}-${++seq}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
  return { content: null, toolCalls: [c] }
}
const say = (content: string): CompletionResult => ({ content, toolCalls: [] })

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function firstName(from: string): string {
  return from.replace(/<.*>/, '').trim().split(/\s+/)[0] || 'there'
}
function emailOf(from: string): string {
  return from.match(/<([^>]+)>/)?.[1] ?? from
}

const NAME_STOP = new Set(['i', 'me', 'my', 'the', 'a', 'an', 'to', 'for', 'with', 'and', 'about', 'please', 'reply', 'draft', 'email', 'meeting', 'move', 'schedule', 'book', 'invite', 'their', 'them', 'his', 'her', 'can', 'you', 'could', 'set', 'up'])

function mentionedNames(text: string): string[] {
  return text.toLowerCase().split(/[^a-z']+/).filter(w => w.length > 2 && !NAME_STOP.has(w))
}

function titleFrom(text: string): string {
  const t = text.replace(/^(please|can you|could you|ok|okay)[\s,]+/i, '').replace(/[.?!]+$/, '').trim()
  const short = t.length > 90 ? `${t.slice(0, 87)}…` : t
  return short.charAt(0).toUpperCase() + short.slice(1)
}

function nextWeekdayAt(hour: number, from = new Date()): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1, hour, 0)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return d
}

export function demoReply(req: CompletionRequest): CompletionResult {
  const { messages, agent } = req
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { lastUser = i; break }
  const userText = lastUser >= 0 ? textOf(messages[lastUser].content) : ''
  const q = userText.toLowerCase()
  const turn = messages.slice(lastUser + 1)
  // Tool results of THIS turn, keyed by function name (latest wins).
  const called = new Map<string, Json>()
  const names = new Map<string, string>()
  for (const m of turn) {
    if (m.role === 'assistant') for (const c of m.tool_calls ?? []) names.set(c.id, c.function.name)
    if (m.role === 'tool') {
      let v: Json = {}
      try { v = JSON.parse(textOf(m.content)) as Json } catch { v = { error: textOf(m.content) } }
      called.set(names.get(m.tool_call_id ?? '') ?? m.name ?? '', v)
    }
  }
  const has = (tool: string) => agent.tools.includes(tool)
  const folder = agent.knowledge_folders[0] ?? ''
  const todoPath = folder ? `${folder}/todo.md` : 'todo.md'
  const errorOf = (v: Json | undefined) => (v && typeof v.error === 'string' ? v.error : null)
  for (const v of called.values()) {
    const e = errorOf(v)
    if (e) return say(`I couldn't do that: ${e}`)
  }

  // ── card status ──
  if (has('list_objectives') && /\b(status|progress|how('s| is| are)|update)\b/.test(q) && /\bcards?\b|\bboard\b|\bjobs?\b/.test(q)) {
    const r = called.get('list_objectives')
    if (!r) return call('list_objectives', {})
    const cards = (r.cards as Json[]) ?? []
    if (cards.length === 0) return say('This chat has not put anything on the board yet.')
    return say(['Here is where your board cards stand:', '', ...cards.map(c => `- **#${c.id} ${c.title}** — ${String(c.status).replace('_', ' ')}`)].join('\n'))
  }

  // ── reply to an email ──
  if (has('email') && /\b(reply|respond|write back|answer)\b/.test(q)) {
    const inbox = called.get('email_list_inbox')
    if (!inbox) return call('email_list_inbox', { limit: 20 })
    const msgs = (inbox.messages as Json[]) ?? []
    const words = mentionedNames(q)
    const target = msgs.find(m => words.some(w => String(m.from).toLowerCase().includes(w) || String(m.subject).toLowerCase().includes(w)))
      ?? msgs.find(m => m.unread)
    if (!target) return say('I could not find an email to reply to. Which one do you mean?')
    const full = called.get('email_read')
    if (!full) return call('email_read', { id: target.id })
    const draft = called.get('email_create_draft')
    if (!draft) {
      const name = firstName(String(full.from))
      const body = /move|reschedul/i.test(String(full.body))
        ? `Hi ${name},\n\nNo problem at all — Friday morning works. Shall we say 10:00? I'll send an updated invite.\n\nBest,\nJordan`
        : /quote|timeline/i.test(String(full.body))
          ? `Hi ${name},\n\nThanks for reaching out! A website with class booking for two locations typically runs 6–8 weeks. I'll send a detailed quote by Friday — could you share a couple of sites you like in the meantime?\n\nBest,\nJordan`
          : `Hi ${name},\n\nThanks for this — I'll take a look and come back to you by Wednesday.\n\nBest,\nJordan`
      return call('email_create_draft', { to: emailOf(String(full.from)), subject: `Re: ${full.subject}`, body, in_reply_to: full.id })
    }
    return say(`I've drafted a reply to **${firstName(String(full.from))}** about "${full.subject}". It's below — read it over and press **Send** when you're happy. Nothing goes out until you do.`)
  }

  // ── schedule / move a meeting ──
  if (has('calendar') && /\b(schedule|book|move|reschedule|invite|set up)\b/.test(q)) {
    const cal = called.get('calendar_list_events')
    if (!cal) return call('calendar_list_events', {})
    const events = (cal.events as Json[]) ?? []
    const words = mentionedNames(q)
    // Moving: the furthest-out matching meeting (today's has usually started).
    const matches = events.filter(e => words.some(w => String(e.title).toLowerCase().includes(w) || ((e.with as string[]) ?? []).some(p => p.toLowerCase().includes(w))))
    const existing = matches.sort((a, b) => Date.parse(String(b.start)) - Date.parse(String(a.start)))[0]
    const drafted = called.get('calendar_draft_event')
    if (!drafted) {
      const start = /friday/.test(q) ? (() => { const d = nextWeekdayAt(10); while (d.getDay() !== 5) d.setDate(d.getDate() + 1); return d })() : nextWeekdayAt(10)
      const end = new Date(start.getTime() + 45 * 60_000)
      const title = existing ? String(existing.title) : titleFrom(userText)
      return call('calendar_draft_event', { title, start: start.toISOString(), end: end.toISOString(), with: (existing?.with as string[]) ?? [], note: existing ? `Moved from ${fmtTime(String(existing.start))}` : null })
    }
    return say(`I've drafted the invite${existing ? ` for **${existing.title}**` : ''}. Check the time below and press **Add to calendar** to confirm — I haven't changed your calendar.`)
  }

  // ── inbox ──
  if (has('email') && /\b(inbox|e-?mails?|mail|unread|messages)\b/.test(q)) {
    const inbox = called.get('email_list_inbox')
    if (!inbox) return call('email_list_inbox', { unread_only: true, limit: 10 })
    const msgs = (inbox.messages as Json[]) ?? []
    if (msgs.length === 0) return say('Your inbox is clear — no unread email.')
    return say([
      `You have **${msgs.length} unread**:`,
      '',
      ...msgs.map(m => `- **${firstName(String(m.from))}** — ${m.subject}`),
      '',
      'Want me to draft a reply to any of them? Say "reply to Priya", for example.',
    ].join('\n'))
  }

  // ── calendar ──
  if (has('calendar') && /\b(calendar|agenda|today|tomorrow|this week|meetings?|schedule)\b/.test(q)) {
    const cal = called.get('calendar_list_events')
    if (!cal) return call('calendar_list_events', {})
    const events = (cal.events as Json[]) ?? []
    if (events.length === 0) return say('Nothing on your calendar for the next 7 days.')
    return say(['Coming up in the next 7 days:', '', ...events.map(e => `- **${fmtTime(String(e.start))}** — ${e.title}`)].join('\n'))
  }

  // ── add to to-do ──
  const addMatch = userText.match(/\b(?:add|remember|remind me(?: to)?)\s+(.+?)(?:\s+(?:to|on)\s+my\s+(?:to-?do|list|tasks).*)?$/i)
  if (has('write_doc') && has('read_file') && addMatch && /\b(to-?do|list|tasks?|remember|remind)\b/.test(q)) {
    const cur = called.get('read_file')
    if (!cur) return call('read_file', { path: todoPath })
    const saved = called.get('write_doc')
    const item = addMatch[1].replace(/^(to\s+)/i, '').replace(/[.?!]+$/, '')
    if (!saved) return call('write_doc', { path: todoPath, content: `${String(cur.content ?? '').replace(/\s*$/, '')}\n- [ ] ${item}\n` })
    return say(`Added to your to-do list: **${item}**.`)
  }

  // ── read to-do ──
  if (has('read_file') && /\b(to-?do|tasks?|priorit(y|ies)|what should i)\b/.test(q)) {
    const cur = called.get('read_file')
    if (!cur) return call('read_file', { path: todoPath })
    const open = String(cur.content ?? '').split('\n').filter(l => /^\s*- \[ \]/.test(l)).map(l => l.replace(/^\s*- \[ \]\s*/, ''))
    if (open.length === 0) return say('Your to-do list is all done.')
    return say(['Open on your to-do list:', '', ...open.map(o => `- ${o}`)].join('\n'))
  }

  // ── hand real work to the board ──
  if (has('create_objective') && /\b(build|create|make|prepare|research|write up|report|proposal|quote|website|spreadsheet|analy[sz]e|put .* on the board|card)\b/.test(q)) {
    const made = called.get('create_objective')
    if (!made) return call('create_objective', { title: titleFrom(userText), description: `Requested in chat:\n\n> ${userText}` })
    return say(`That's a bigger job, so I've put it on the board as **card #${made.id}**. The team's coding tools will pick it up; you can follow its status right here in this chat.`)
  }

  const can: string[] = []
  if (has('email')) can.push('check your inbox and draft replies ("what\'s in my inbox?", "reply to Priya")')
  if (has('calendar')) can.push('read your calendar and draft invites ("what\'s on this week?", "move the meeting with Priya to Friday")')
  if (has('read_file')) can.push('keep your to-do list ("what\'s on my to-do list?", "add call the printer to my to-do list")')
  if (has('create_objective')) can.push('hand bigger jobs to the board ("prepare a website quote for Elena")')
  return say([
    `I'm the demo version of ${agent.name} — no AI account is connected, so I understand a few set requests. I can:`,
    '',
    ...can.map(c => `- ${c}`),
  ].join('\n'))
}
