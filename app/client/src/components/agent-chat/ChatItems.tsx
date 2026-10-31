import { useState } from 'react'
import { Badge, Button, cn } from '../ui'
import { StatusDot } from '../design/primitives'
import { renderMarkdown } from '../../lib/markdown'
import {
  COLOUR_CLASSES,
  type ChatAgentInfo,
  type ChatCard,
  type ChatDraft,
  type ChatMessage,
  type EmailDraftPayload,
  type EventDraftPayload,
} from './types'

/* Pieces of one agent conversation (obj 719987): avatar, bubbles, the inline
   activity line for each tool call, draft cards with the person's Send button,
   and the live status chip for a board card the agent filed. */

export function AgentAvatar({ agent, size = 'md' }: { agent: Pick<ChatAgentInfo, 'avatar' | 'colour' | 'name'>; size?: 'sm' | 'md' | 'lg' }) {
  const dim = size === 'lg' ? 'h-12 w-12 text-[17px]' : size === 'sm' ? 'h-7 w-7 text-[11px]' : 'h-9 w-9 text-[13px]'
  return (
    <span
      aria-hidden="true"
      className={cn('grid shrink-0 place-items-center rounded-lg border font-display font-semibold tracking-[-0.02em]', dim, COLOUR_CLASSES[agent.colour].tile)}
    >
      {agent.avatar}
    </span>
  )
}

function time(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function UserBubble({ m }: { m: ChatMessage }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg rounded-br-sm border border-line bg-surface-3 px-3.5 py-2.5 text-[14px] leading-relaxed text-fg-0 sm:max-w-[70%]">
        <p className="whitespace-pre-wrap break-words">{m.content}</p>
        <p className="mt-1 text-right text-[11px] text-fg-2">{time(m.created_at)}</p>
      </div>
    </div>
  )
}

export function AssistantBubble({ m, agent }: { m: ChatMessage; agent: ChatAgentInfo }) {
  const by = m.meta?.provider_label ?? m.provider ?? 'unknown'
  return (
    <div className="flex items-start gap-2.5">
      <AgentAvatar agent={agent} size="sm" />
      <div className="min-w-0 max-w-[90%] sm:max-w-[75%]">
        <div className="rounded-lg rounded-tl-sm border border-line-soft bg-surface-1 px-3.5 py-2.5">
          <div className="cc-prose break-words text-[14px]" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 px-1 text-[11px] text-fg-2" data-testid="answered-by">
          <span>Answered by <span className="font-medium text-fg-1">{by}</span></span>
          {m.model && <span className="font-mono text-fg-2">· {m.model}</span>}
          <span>· {time(m.created_at)}</span>
        </p>
      </div>
    </div>
  )
}

export function ErrorLine({ m }: { m: ChatMessage }) {
  return (
    <div role="alert" className="mx-auto max-w-[90%] rounded-md border border-signal-alarm/30 bg-signal-alarm/10 px-3 py-2 text-[13px] text-fg-0">
      <span className="font-medium text-signal-alarm">Couldn't answer. </span>
      {m.content}
    </div>
  )
}

const TOOL_ICON: Record<string, string> = {
  email: 'M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75',
  calendar: 'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5',
  board: 'M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v12a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18V6ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v6A2.25 2.25 0 0 1 18 14.25h-2.25a2.25 2.25 0 0 1-2.25-2.25V6Z',
  knowledge: 'M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z',
}

function toolFamily(name: string | null): keyof typeof TOOL_ICON {
  if (!name) return 'knowledge'
  if (name.startsWith('email')) return 'email'
  if (name.startsWith('calendar')) return 'calendar'
  if (name.endsWith('objective') || name.endsWith('objectives')) return 'board'
  return 'knowledge'
}

export function ToolLine({ m }: { m: ChatMessage }) {
  const failed = m.meta?.ok === false
  return (
    <div className={cn('ml-9 flex items-center gap-2 text-[12px]', failed ? 'text-signal-amber' : 'text-fg-2')}>
      <svg className="h-3.5 w-3.5 shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.6} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d={TOOL_ICON[toolFamily(m.tool_name)]} />
      </svg>
      <span className="min-w-0 break-words">{m.content}</span>
    </div>
  )
}

const DRAFT_DONE: Record<ChatDraft['status'], { label: string; tone: 'verify' | 'neutral' | 'amber' }> = {
  draft: { label: 'Draft — not sent', tone: 'amber' },
  sent: { label: 'Sent by you', tone: 'verify' },
  added: { label: 'Added by you', tone: 'verify' },
  discarded: { label: 'Discarded', tone: 'neutral' },
}

function fmtRange(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  if (Number.isNaN(s.getTime())) return start
  const day = s.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
  const t = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${day}, ${t(s)}–${Number.isNaN(e.getTime()) ? '' : t(e)}`
}

const fieldCls =
  'w-full rounded-md border border-line bg-surface-0 px-3 py-2 text-[14px] text-fg-0 placeholder:text-fg-3 transition-colors duration-fast hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30'

export function DraftCard({
  draft,
  onSend,
  onDiscard,
  onSave,
}: {
  draft: ChatDraft
  onSend: (d: ChatDraft) => Promise<void>
  onDiscard: (d: ChatDraft) => Promise<void>
  onSave: (d: ChatDraft, patch: Record<string, string>) => Promise<void>
}) {
  const [busy, setBusy] = useState<'send' | 'discard' | 'save' | null>(null)
  const [editing, setEditing] = useState(false)
  const isEmail = draft.kind === 'email'
  const p = draft.payload
  const [body, setBody] = useState(isEmail ? (p as EmailDraftPayload).body : '')
  const open = draft.status === 'draft'
  const st = DRAFT_DONE[draft.status]

  const run = async (kind: 'send' | 'discard' | 'save', fn: () => Promise<void>) => {
    setBusy(kind)
    try {
      await fn()
      if (kind === 'save') setEditing(false)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      aria-label={isEmail ? 'Email draft' : 'Calendar draft'}
      className={cn('ml-9 max-w-[560px] rounded-lg border bg-surface-2 transition-colors duration-base', open ? 'border-line-strong' : 'border-line-soft opacity-80')}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line-soft px-3.5 py-2">
        <span className="text-[12px] font-semibold uppercase tracking-[0.04em] text-fg-1">{isEmail ? 'Email draft' : 'Calendar draft'}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
      </header>
      <div className="space-y-1.5 px-3.5 py-3 text-[13.5px]">
        {isEmail ? (
          <>
            <p className="text-fg-2">To <span className="text-fg-0">{(p as EmailDraftPayload).to}</span></p>
            <p className="text-fg-2">Subject <span className="font-medium text-fg-0">{(p as EmailDraftPayload).subject}</span></p>
            {editing ? (
              <textarea
                aria-label="Email body"
                className={cn(fieldCls, 'mt-1 min-h-[160px] resize-y leading-relaxed')}
                value={body}
                onChange={e => setBody(e.target.value)}
              />
            ) : (
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-line-soft bg-surface-1 px-3 py-2 leading-relaxed text-fg-0">{(p as EmailDraftPayload).body}</p>
            )}
          </>
        ) : (
          <>
            <p className="font-medium text-fg-0">{(p as EventDraftPayload).title}</p>
            <p className="text-fg-1">{fmtRange((p as EventDraftPayload).start, (p as EventDraftPayload).end)}</p>
            {(p as EventDraftPayload).with.length > 0 && <p className="text-fg-2">With {(p as EventDraftPayload).with.join(', ')}</p>}
            {(p as EventDraftPayload).note && <p className="text-fg-2">{(p as EventDraftPayload).note}</p>}
          </>
        )}
        {draft.connector === 'demo' && <p className="pt-1 text-[11.5px] text-fg-2">Demo account — sample data, nothing leaves the server.</p>}
      </div>
      {open && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3.5 py-2.5">
          {editing ? (
            <>
              <Button variant="primary" loading={busy === 'save'} onClick={() => run('save', () => onSave(draft, { body }))}>Save changes</Button>
              <Button variant="ghost" disabled={!!busy} onClick={() => { setEditing(false); setBody((p as EmailDraftPayload).body) }}>Cancel</Button>
            </>
          ) : (
            <>
              <Button variant="primary" loading={busy === 'send'} disabled={!!busy && busy !== 'send'} onClick={() => run('send', () => onSend(draft))}>
                {isEmail ? 'Send' : 'Add to calendar'}
              </Button>
              {isEmail && <Button variant="secondary" disabled={!!busy} onClick={() => setEditing(true)}>Edit</Button>}
              <Button variant="ghost" loading={busy === 'discard'} disabled={!!busy && busy !== 'discard'} onClick={() => run('discard', () => onDiscard(draft))}>Discard</Button>
            </>
          )}
        </footer>
      )}
    </section>
  )
}

// Plain-language card states for business owners (the board's own labels are terse).
const CARD_STATE: Record<ChatCard['status'], string> = {
  planning: 'Being planned',
  queue: 'Waiting to start',
  working: 'In progress',
  ai_review: 'Being checked',
  review: 'Ready for your review',
  done: 'Done',
  cancelled: 'Cancelled',
}

export function CardChip({ card }: { card: ChatCard }) {
  return (
    <a
      href={card.url}
      className="group ml-9 flex max-w-[560px] items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 transition-all duration-fast hover:-translate-y-px hover:border-line-strong hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <StatusDot status={card.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-fg-0">
          <span className="font-mono text-fg-2">#{card.id}</span> {card.title}
        </span>
        <span className="block text-[12px] text-fg-2">On the board · {CARD_STATE[card.status] ?? card.status}</span>
      </span>
      <span className="text-[12px] font-medium text-fg-1 transition-colors duration-fast group-hover:text-accent-hover">Open →</span>
    </a>
  )
}
