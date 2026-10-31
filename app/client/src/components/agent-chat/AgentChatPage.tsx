import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { Alert, Button, EmptyState, IconButton, Skeleton, SkeletonText, cn, useConfirm } from '../ui'
import { ThinkingIndicator } from '../design/primitives'
import { AgentAvatar, AssistantBubble, CardChip, DraftCard, ErrorLine, ToolLine, UserBubble } from './ChatItems'
import {
  COLOUR_CLASSES,
  PROVIDER_LABELS,
  type AgentsResponse,
  type ChatAgentInfo,
  type ChatCard,
  type ChatDraft,
  type ChatMessage,
  type ThreadResponse,
} from './types'

/* Built-in agent chat (obj 719987).
   Pick an agent on the left (a list on its own screen on mobile), then talk
   to it in ONE ongoing chat. Every reply says which AI answered. Email and
   calendar actions arrive as drafts with your own Send button; bigger jobs
   arrive as board-card chips that update while the card runs. */

const OPEN_CARD = new Set(['planning', 'queue', 'working', 'ai_review'])

function suggestionsFor(a: ChatAgentInfo): string[] {
  const has = (t: string) => a.tools.includes(t)
  // The demo knows its made-up people; a real agent gets generic openers.
  if (a.source === 'demo') {
    return [
      ...(has('email') ? ["What's in my inbox?", 'Reply to Priya'] : []),
      ...(has('calendar') ? ['Move the meeting with Priya to Friday'] : []),
      ...(has('create_objective') ? ['Prepare a website quote for Elena'] : []),
    ].slice(0, 4)
  }
  return [
    ...(has('email') ? ['What needs a reply today?'] : []),
    ...(has('calendar') ? ["What's on my calendar this week?"] : []),
    ...(has('search') ? ['What do my notes say about this week?'] : []),
    ...(has('create_objective') ? ['Put a task on the board for the team'] : []),
  ].slice(0, 3)
}

// ── agent list ──

function AgentList({
  data,
  active,
  onPick,
  isAdmin,
  onDemo,
  demoBusy,
}: {
  data: AgentsResponse
  active: string | null
  onPick: (slug: string) => void
  isAdmin: boolean
  onDemo: (on: boolean) => void
  demoBusy: boolean
}) {
  return (
    <nav aria-label="Agents" className="flex h-full flex-col">
      <div className="px-4 pb-2 pt-4">
        <h1 className="font-display text-[18px] font-semibold tracking-[-0.02em] text-fg-0">Chat</h1>
        <p className="mt-0.5 text-[12.5px] text-fg-2">One ongoing chat with each agent.</p>
      </div>
      <ul className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
        {data.agents.map(a => {
          const on = a.slug === active
          return (
            <li key={a.slug}>
              <button
                onClick={() => onPick(a.slug)}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'flex min-h-[56px] w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all duration-fast',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  on ? 'border-line-strong bg-surface-3' : 'border-transparent hover:border-line hover:bg-surface-2',
                )}
              >
                <AgentAvatar agent={a} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-fg-0">{a.name}</span>
                  <span className="block truncate text-[12px] text-fg-2">{a.description || 'No description'}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {isAdmin && (
        <div className="border-t border-line-soft px-4 py-3">
          <button
            onClick={() => onDemo(!data.demo)}
            disabled={demoBusy}
            className="min-h-[44px] w-full rounded-md px-2 text-left text-[12.5px] text-fg-2 transition-colors duration-fast hover:bg-surface-2 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-45"
          >
            {data.demo ? 'Demo agent is on — turn it off' : 'Turn on the demo agent (sample inbox + calendar)'}
          </button>
        </div>
      )}
    </nav>
  )
}

// ── one conversation ──

function Conversation({ agent, onBack }: { agent: ChatAgentInfo; onBack: () => void }) {
  const [thread, setThread] = useState<ThreadResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const { confirm, confirmDialog } = useConfirm()
  const base = `/agent-chat/agents/${encodeURIComponent(agent.slug)}`

  const load = useCallback(async () => {
    try {
      setThread(await api.get<ThreadResponse>(`${base}/messages`))
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load this chat')
    }
  }, [base])

  useEffect(() => {
    setThread(null)
    setText('')
    setSendError(null)
    void load()
  }, [load])

  // Board cards keep moving after the chat ends: refresh while any is still open.
  const openCards = thread?.cards.some(c => OPEN_CARD.has(c.status)) ?? false
  useEffect(() => {
    if (!openCards) return
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [openCards, load])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [thread?.messages.length, pending])

  const send = async (raw: string) => {
    const msg = raw.trim()
    if (!msg || pending) return
    setPending(msg)
    setText('')
    setSendError(null)
    try {
      const r = await api.post<ThreadResponse>(`${base}/messages`, { text: msg }, { timeoutMs: 240_000 })
      setThread(t => mergeThread(t, r))
    } catch (e) {
      setText(msg)
      setSendError(e instanceof Error ? e.message : 'Message not sent')
    } finally {
      setPending(null)
      input.current?.focus()
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send(text)
    }
  }

  const updateDraft = (d: ChatDraft) => setThread(t => (t ? { ...t, drafts: t.drafts.map(x => (x.id === d.id ? d : x)) } : t))
  const draftAction = async (path: string, body?: unknown, method: 'post' | 'put' = 'post') => {
    setSendError(null)
    try {
      const r = method === 'put' ? await api.put<{ draft: ChatDraft }>(path, body) : await api.post<{ draft: ChatDraft }>(path, body)
      updateDraft(r.draft)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'That did not work')
    }
  }

  const clear = async () => {
    if (!(await confirm({ title: `Clear your chat with ${agent.name}?`, message: 'The messages are deleted from this server. Board cards and saved notes stay.', confirmLabel: 'Clear chat', danger: true }))) return
    await api.del(`${base}/messages`)
    await load()
  }

  const drafts = useMemo(() => new Map((thread?.drafts ?? []).map(d => [d.id, d])), [thread?.drafts])
  const cards = useMemo(() => new Map((thread?.cards ?? []).map(c => [c.id, c])), [thread?.cards])
  const answeredBy = `${PROVIDER_LABELS[agent.answered_by.id]}${agent.answered_by.model ? ` · ${agent.answered_by.model}` : ''}`

  return (
    <section aria-label={`Chat with ${agent.name}`} className="flex h-full min-w-0 flex-col">
      <header className="flex items-center gap-2 border-b border-line bg-surface-1 px-2 py-2 sm:px-4">
        <IconButton label="All agents" onClick={onBack} className="md:hidden">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
          </svg>
        </IconButton>
        <AgentAvatar agent={agent} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">{agent.name}</h2>
          <p className="truncate text-[11.5px] text-fg-2">
            Answers with <span className="text-fg-1">{answeredBy}</span>
            {agent.version && <span> · v{agent.version}</span>}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void clear()} disabled={!thread?.messages.length || !!pending} className="min-h-[44px] sm:min-h-0">
          Clear
        </Button>
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto overflow-x-clip px-3 py-4 sm:px-6" aria-live="polite">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3">
          {loadError && <Alert tone="alarm">{loadError}</Alert>}
          {!thread && !loadError && (
            <div className="space-y-4" aria-label="Loading chat">
              <div className="flex items-start gap-2.5"><Skeleton className="h-7 w-7 rounded-lg" /><SkeletonText lines={2} className="flex-1" /></div>
              <div className="flex justify-end"><Skeleton className="h-10 w-1/2 rounded-lg" /></div>
              <div className="flex items-start gap-2.5"><Skeleton className="h-7 w-7 rounded-lg" /><SkeletonText lines={3} className="flex-1" /></div>
            </div>
          )}
          {thread && thread.messages.length === 0 && !pending && (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <AgentAvatar agent={agent} size="lg" />
              <div className="space-y-1">
                <p className="font-display text-[16px] font-semibold text-fg-0">Start a chat with {agent.name}</p>
                <p className="mx-auto max-w-[46ch] text-[13px] leading-relaxed text-fg-2">{agent.description}</p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {suggestionsFor(agent).map(s => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="min-h-[44px] rounded-full border border-line bg-surface-1 px-4 text-[13px] text-fg-1 transition-all duration-fast hover:-translate-y-px hover:border-line-strong hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    {s}
                  </button>
                ))}
              </div>
              {agent.source === 'demo' && <p className="text-[12px] text-fg-2">Demo agent: the inbox, calendar and notes are made-up sample data.</p>}
            </div>
          )}
          {thread?.messages.map(m => (
            <MessageRow
              key={m.id}
              m={m}
              agent={agent}
              draft={m.meta?.draft_id ? drafts.get(m.meta.draft_id) : undefined}
              card={m.tool_name === 'create_objective' && m.meta?.objective_id ? cards.get(m.meta.objective_id) : undefined}
              onSend={d => draftAction(`/agent-chat/drafts/${d.id}/send`)}
              onDiscard={d => draftAction(`/agent-chat/drafts/${d.id}/discard`)}
              onSave={(d, patch) => draftAction(`/agent-chat/drafts/${d.id}`, patch, 'put')}
            />
          ))}
          {pending && (
            <>
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-lg rounded-br-sm border border-line bg-surface-3 px-3.5 py-2.5 text-[14px] text-fg-0 sm:max-w-[70%]">
                  <p className="whitespace-pre-wrap break-words">{pending}</p>
                </div>
              </div>
              <div className="flex items-center gap-2.5">
                <AgentAvatar agent={agent} size="sm" />
                <ThinkingIndicator label={`${agent.name} is working…`} tone="fg-2" />
              </div>
            </>
          )}
        </div>
      </div>

      <form
        className="border-t border-line bg-surface-1 px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 sm:px-6"
        onSubmit={e => { e.preventDefault(); void send(text) }}
      >
        <div className="mx-auto max-w-[760px]">
          {sendError && <p role="alert" className="mb-2 text-[12.5px] text-signal-alarm">{sendError}</p>}
          <div className="flex items-end gap-2">
            <label htmlFor="agent-chat-input" className="sr-only">Message {agent.name}</label>
            <textarea
              id="agent-chat-input"
              ref={input}
              rows={1}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={onKey}
              placeholder="Write a message"
              disabled={!!pending}
              className="max-h-40 min-h-[44px] flex-1 resize-none rounded-lg border border-line bg-surface-0 px-3.5 py-2.5 text-[16px] text-fg-0 placeholder:text-fg-3 transition-colors duration-fast hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60 sm:text-[14px]"
            />
            <Button type="submit" variant="primary" loading={!!pending} disabled={!text.trim()} className="min-h-[44px] sm:min-h-[44px]">
              Send
            </Button>
          </div>
          <p className="mt-1.5 hidden text-[11px] text-fg-2 sm:block">Enter to send · Shift+Enter for a new line · Email and calendar are always drafts until you press Send.</p>
        </div>
      </form>
      {confirmDialog}
    </section>
  )
}

function mergeThread(t: ThreadResponse | null, r: ThreadResponse): ThreadResponse {
  const prev = t ?? { messages: [], drafts: [], cards: [] }
  const byId = <T extends { id: number }>(a: T[], b: T[]) => [...new Map([...a, ...b].map(x => [x.id, x])).values()]
  return { messages: byId(prev.messages, r.messages), drafts: byId(prev.drafts, r.drafts), cards: byId(prev.cards, r.cards) }
}

function MessageRow({
  m,
  agent,
  draft,
  card,
  onSend,
  onDiscard,
  onSave,
}: {
  m: ChatMessage
  agent: ChatAgentInfo
  draft?: ChatDraft
  card?: ChatCard
  onSend: (d: ChatDraft) => Promise<void>
  onDiscard: (d: ChatDraft) => Promise<void>
  onSave: (d: ChatDraft, patch: Record<string, string>) => Promise<void>
}) {
  if (m.role === 'user') return <UserBubble m={m} />
  if (m.role === 'assistant') return <AssistantBubble m={m} agent={agent} />
  if (m.role === 'error') return <ErrorLine m={m} />
  return (
    <>
      <ToolLine m={m} />
      {draft && <DraftCard draft={draft} onSend={onSend} onDiscard={onDiscard} onSave={onSave} />}
      {card && <CardChip card={card} />}
    </>
  )
}

// ── page ──

export function AgentChatPage() {
  const { slug } = useParams<{ slug?: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [data, setData] = useState<AgentsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [demoBusy, setDemoBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.get<AgentsResponse>('/agent-chat/agents'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load agents')
    }
  }, [])
  useEffect(() => { void load() }, [load])

  const setDemo = async (on: boolean) => {
    setDemoBusy(true)
    try {
      await api.put('/agent-chat/settings', { demo: on })
      await load()
      if (on) navigate('/chat/demo-assistant')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the demo setting')
    } finally {
      setDemoBusy(false)
    }
  }

  const active = data?.agents.find(a => a.slug === slug) ?? null
  const pick = (s: string) => navigate(`/chat/${s}`)

  if (error && !data) {
    return <div className="p-6"><Alert tone="alarm">{error}</Alert></div>
  }
  if (!data) {
    return (
      <div className="flex h-full" aria-label="Loading agents">
        <div className="w-full space-y-2 p-4 md:w-[300px] md:border-r md:border-line">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
        </div>
      </div>
    )
  }

  if (data.agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <EmptyState
          icon={<span className={cn('grid h-full w-full place-items-center rounded-lg border font-display text-[13px] font-semibold', COLOUR_CLASSES.green.tile)}>AI</span>}
          title="No chat agents yet"
          description={
            isAdmin
              ? 'Agents are one file each in the agents folder (see the Agent chat guide). Or try the demo: a personal assistant with a made-up inbox and calendar.'
              : 'Your administrator has not added any chat agents yet.'
          }
          action={isAdmin ? <Button variant="primary" loading={demoBusy} onClick={() => void setDemo(true)}>Turn on the demo agent</Button> : undefined}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 bg-surface-0">
      <aside className={cn('h-full w-full shrink-0 border-line bg-surface-1 md:block md:w-[300px] md:border-r', active ? 'hidden' : 'block')}>
        <AgentList data={data} active={active?.slug ?? null} onPick={pick} isAdmin={isAdmin} onDemo={on => void setDemo(on)} demoBusy={demoBusy} />
      </aside>
      <main className={cn('h-full min-w-0 flex-1', active ? 'block' : 'hidden md:block')}>
        {active ? (
          <Conversation key={active.slug} agent={active} onBack={() => navigate('/chat')} />
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            <EmptyState
              title={slug ? `No agent called "${slug}"` : 'Pick an agent'}
              description="Each agent keeps one ongoing chat with you. History is stored on this server only."
              compact
            />
          </div>
        )}
      </main>
    </div>
  )
}
