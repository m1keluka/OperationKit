import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAuth } from '../../context/AuthContext'
import { useFileDrop, filesFromClipboard } from '../../hooks/useFileDrop'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { Alert, Button, EmptyState, IconButton, Skeleton, SkeletonText, cn, useConfirm } from '../ui'
import { ThinkingIndicator } from '../design/primitives'
import { AgentAvatar, AssistantBubble, CardChip, DraftCard, ErrorLine, ToolLine, UserBubble } from './ChatItems'
import { AgentInfoPanel } from './AgentInfoPanel'
import { collectImages, humanSize, toWireImages, type PendingImage } from './attachments'
import { BotSettingsPanel } from './BotSettingsPanel'
import {
  ACCEPTED_IMAGE_TYPES,
  COLOUR_CLASSES,
  PROVIDER_LABELS,
  type AgentsResponse,
  type ChatAgentInfo,
  type ChatCard,
  type ChatDraft,
  type ChatMessage,
  type ChatThread,
  type ThreadResponse,
  type ThreadsResponse,
} from './types'

/* Built-in bot chat (obj 719987; user-facing terminology renamed to "bot" in
   obj 900327).
   Pick a bot on the left (a list on its own screen on mobile), then talk to it
   in ONE ongoing conversation. Every reply says which AI answered. Email and
   calendar actions arrive as drafts with your own Send button; bigger jobs
   arrive as board-card chips that update while the card runs.

   TERMINOLOGY (obj 900327, extended by obj 900370) — the nouns are NOT
   interchangeable:
     - a BOT is the durable identity defined by one agent file. It is created by
       adding that file on the server, never from this page.
     - the MAIN CONVERSATION is the ongoing message history between you and one
       bot. There is exactly one per bot, it starts implicitly with your first
       message, and "Clear conversation" empties it WITHOUT deleting the bot.
     - a SIDE THREAD is an extra, named conversation beside the main one: its own
       history, its own context, and it runs CONCURRENTLY — you can set one off
       and keep talking in the main conversation while it works. Closing a side
       thread archives that lane and leaves the main conversation untouched.
   So this page still has no "New bot" control, because it creates no bots. The
   identifiers below (agent*, ChatAgentInfo, /agent-chat, the agent_chat_*
   tables, the agents/ folder) are the UNCHANGED technical names - only what a
   person reads was renamed. */

const OPEN_CARD = new Set(['planning', 'queue', 'working', 'ai_review'])

export function suggestionsFor(a: ChatAgentInfo): string[] {
  // A bot file that lists its own example prompts (obj 900672) knows best.
  if (a.example_prompts?.length) return a.example_prompts
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

// ── bot list ──

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
    <nav aria-label="Bots" className="flex h-full flex-col">
      <div className="px-4 pb-2 pt-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-fg-0">Bots</h1>
        <p className="mt-0.5 text-[12.5px] text-fg-2">One ongoing conversation with each bot.</p>
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
            {data.demo ? 'Demo bot is on — turn it off' : 'Turn on the demo bot (sample inbox + calendar)'}
          </button>
        </div>
      )}
    </nav>
  )
}

// ── the lane strip: main conversation + side threads (obj 900370) ──

function LaneStrip({
  threads,
  lane,
  maxOpen,
  busy,
  onPick,
  onOpen,
}: {
  threads: ChatThread[]
  lane: number | null
  maxOpen: number
  busy: boolean
  onPick: (id: number | null) => void
  onOpen: () => void
}) {
  // No side threads yet: one button, no strip. The main conversation keeps
  // looking exactly like it did before this feature existed.
  const atCap = maxOpen > 0 && threads.length >= maxOpen
  const pill = (on: boolean) =>
    cn(
      'min-h-[36px] shrink-0 whitespace-nowrap rounded-full border px-3 text-[12.5px] transition-all duration-fast',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
      on ? 'border-line-strong bg-surface-3 text-fg-0' : 'border-line bg-surface-1 text-fg-2 hover:border-line-strong hover:text-fg-0',
    )
  return (
    <div
      role="tablist"
      aria-label="Conversations with this bot"
      className="flex items-center gap-2 overflow-x-auto border-b border-line-soft bg-surface-1 px-2 py-1.5 sm:px-4"
    >
      <button role="tab" aria-selected={lane === null} onClick={() => onPick(null)} className={pill(lane === null)}>
        Main
      </button>
      {threads.map(t => (
        <button key={t.id} role="tab" aria-selected={lane === t.id} onClick={() => onPick(t.id)} className={pill(lane === t.id)}>
          {t.pinned && <span aria-hidden="true">★ </span>}
          {t.title}
          {t.message_count > 0 && <span className="ml-1 text-fg-3">{t.message_count}</span>}
        </button>
      ))}
      <button
        onClick={onOpen}
        disabled={busy || atCap}
        title={atCap ? `${maxOpen} open side threads is the limit for one bot — close one first` : 'Open a side thread that runs beside this conversation'}
        className={cn(pill(false), 'disabled:opacity-45')}
      >
        + Side thread
      </button>
    </div>
  )
}

// ── one lane of one bot: the main conversation, or one side thread ──

function Conversation({
  agent,
  onBack,
  initialText = '',
  meta,
  isAdmin = false,
  onAgentChanged,
}: {
  agent: ChatAgentInfo
  onBack: () => void
  initialText?: string
  /** The bot list's install-wide data: tool catalog, model suggestions, web status (obj 900671). */
  meta?: AgentsResponse
  isAdmin?: boolean
  onAgentChanged?: (a: ChatAgentInfo) => void
}) {
  const [thread, setThread] = useState<ThreadResponse | null>(null)
  // obj 900671: the bot's settings panel (model, provider, tools) on its own page.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The "i" panel (obj 900672): how to use this bot + example prompts.
  const [infoOpen, setInfoOpen] = useState(false)
  // A deep link (/chat/<slug>?prompt=…) pre-fills the box once; it never sends.
  // Captured at mount and applied by a mount-only effect declared AFTER the
  // reset effect below, so it survives StrictMode's double effect run and a
  // later lane switch still starts with an empty box.
  const prefill = useRef(initialText)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [text, setText] = useState('')
  // The long placeholder wrapped and was clipped in the one-line box at phone width (QA obj 900621).
  const narrow = useMediaQuery('(max-width: 639px)')
  const [images, setImages] = useState<PendingImage[]>([])
  const [pending, setPending] = useState<{ text: string; images: PendingImage[] } | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  // null = the main conversation; a number = that side thread (obj 900370).
  const [lane, setLane] = useState<number | null>(null)
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [maxOpen, setMaxOpen] = useState(0)
  const [laneBusy, setLaneBusy] = useState(false)
  // null = not renaming; a string = the name being edited in the header.
  const [renameTo, setRenameTo] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const { confirm, confirmDialog } = useConfirm()
  const base = `/agent-chat/agents/${encodeURIComponent(agent.slug)}`
  // Omitting thread_id is what asks for the main conversation, server-side.
  const laneQuery = lane === null ? '' : `?thread_id=${lane}`
  const activeThread = threads.find(t => t.id === lane) ?? null

  const load = useCallback(async () => {
    try {
      setThread(await api.get<ThreadResponse>(`${base}/messages${laneQuery}`))
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load this conversation')
    }
  }, [base, laneQuery])

  // The strip is ADDITIVE: a server that does not answer it (or answers it with
  // something unexpected) must leave the conversation working, not blank the
  // page. So both the failure and the shape are handled here.
  const loadThreads = useCallback(async () => {
    try {
      const r = await api.get<ThreadsResponse>(`${base}/threads`)
      setThreads(Array.isArray(r?.threads) ? r.threads : [])
      setMaxOpen(typeof r?.max_open === 'number' ? r.max_open : 0)
    } catch {
      /* leave the strip as it is */
    }
  }, [base])

  useEffect(() => { void loadThreads() }, [loadThreads])

  useEffect(() => {
    setThread(null)
    setText('')
    setImages([])
    setSendError(null)
    void load()
  }, [load])

  useEffect(() => {
    if (prefill.current) setText(prefill.current)
  }, [])

  const openLane = async () => {
    setLaneBusy(true)
    setSendError(null)
    try {
      const r = await api.post<{ thread: ChatThread }>(`${base}/threads`, { title: `Side thread ${threads.length + 1}` })
      setThreads(cur => [r.thread, ...cur])
      setLane(r.thread.id)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not open a side thread')
    } finally {
      setLaneBusy(false)
    }
  }

  const renameLane = async (t: ChatThread, next: string) => {
    setRenameTo(null)
    if (next.trim() === '' || next === t.title) return
    try {
      const r = await api.patch<{ thread: ChatThread }>(`${base}/threads/${t.id}`, { title: next })
      setThreads(cur => cur.map(x => (x.id === r.thread.id ? r.thread : x)))
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not rename this side thread')
    }
  }

  // "Close" is archive, not delete: the lane's own messages are kept, and the
  // main conversation is not read or written at all.
  const closeLane = async (t: ChatThread) => {
    if (
      !(await confirm({
        title: `Close the side thread "${t.title}"?`,
        message: 'It stops showing here and its messages are kept. Your main conversation with this bot is not changed.',
        confirmLabel: 'Close side thread',
      }))
    )
      return
    try {
      await api.patch(`${base}/threads/${t.id}`, { archived: true })
      setThreads(cur => cur.filter(x => x.id !== t.id))
      setLane(null)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not close this side thread')
    }
  }

  // Leaving a lane abandons a half-typed rename rather than carrying it over.
  useEffect(() => { setRenameTo(null) }, [lane])

  // Paste / drop / attach all end up here (obj 900157).
  const addFiles = useCallback(async (files: ArrayLike<File>) => {
    const r = await collectImages(files, images.length)
    if (r.images.length) setImages(cur => [...cur, ...r.images].slice(0, 4))
    setSendError(r.error)
  }, [images.length])

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromClipboard(e)
    if (!files) return
    // Only swallow the paste when it really is an image, so pasting text (which
    // can also carry a file on some platforms) still types into the box.
    if (!Array.from(files).some(f => (f.type || '').startsWith('image/'))) return
    e.preventDefault()
    void addFiles(files)
  }

  const { isDragging, dropProps } = useFileDrop(f => void addFiles(f), !pending)

  // Board cards keep moving after the chat ends: refresh while any is still open.
  // Board cards keep moving after the conversation ends: refresh while any is still open.
  const openCards = thread?.cards.some(c => OPEN_CARD.has(c.status)) ?? false
  useEffect(() => {
    if (!openCards) return
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [openCards, load])

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }, [thread?.messages.length, pending])

  const send = async (raw: string, attached: PendingImage[] = images) => {
    const msg = raw.trim()
    // A screenshot on its own is a message: send when there is text OR an image.
    if ((!msg && attached.length === 0) || pending) return
    setPending({ text: msg, images: attached })
    setText('')
    setImages([])
    setSendError(null)
    try {
      const r = await api.post<ThreadResponse>(
        `${base}/messages`,
        { text: msg, ...(lane === null ? {} : { thread_id: lane }), ...(attached.length ? { images: toWireImages(attached) } : {}) },
        { timeoutMs: 240_000 },
      )
      setThread(t => mergeThread(t, r))
      // The strip shows per-lane message counts and ordering by last activity.
      void loadThreads()
    } catch (e) {
      setText(msg)
      setImages(attached)
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
    if (
      !(await confirm({
        title: activeThread ? `Clear the side thread "${activeThread.title}"?` : `Clear your conversation with ${agent.name}?`,
        // Clearing empties ONE lane. It does NOT delete the bot - the bot is its
        // agent file on the server and stays exactly as it is - and clearing a
        // side thread never touches the main conversation.
        message: activeThread
          ? `Only this side thread's messages are deleted. Your main conversation with ${agent.name} is not changed.`
          : `The messages are deleted from this server. ${agent.name} itself is not deleted — only this conversation is emptied. Side threads, board cards and saved notes stay.`,
        confirmLabel: activeThread ? 'Clear side thread' : 'Clear conversation',
        danger: true,
      }))
    )
      return
    await api.del(`${base}/messages${laneQuery}`)
    await load()
    void loadThreads()
  }

  const drafts = useMemo(() => new Map((thread?.drafts ?? []).map(d => [d.id, d])), [thread?.drafts])
  const cards = useMemo(() => new Map((thread?.cards ?? []).map(c => [c.id, c])), [thread?.cards])
  const answeredBy = `${PROVIDER_LABELS[agent.answered_by.id]}${agent.answered_by.model ? ` · ${agent.answered_by.model}` : ''}`

  return (
    <section aria-label={`Conversation with ${agent.name}`} className="flex h-full min-w-0 flex-col">
      <header className="flex items-center gap-2 border-b border-line bg-surface-1 px-2 py-2 sm:px-4">
        <IconButton label="All bots" onClick={onBack} className="md:hidden">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
          </svg>
        </IconButton>
        <AgentAvatar agent={agent} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">{agent.name}</h2>
          <p className="truncate text-[12px] text-fg-2">
            Answers with <span className="text-fg-1">{answeredBy}</span>
            {agent.version && <span> · v{agent.version}</span>}
            {/* Named only in a side thread: the main conversation is the unlabelled default. */}
            {activeThread && <span> · side thread <span className="text-fg-1">{activeThread.title}</span></span>}
          </p>
        </div>
        {activeThread && renameTo !== null && (
          <form
            className="flex items-center gap-1"
            onSubmit={e => { e.preventDefault(); void renameLane(activeThread, renameTo) }}
          >
            <label htmlFor="side-thread-name" className="sr-only">Name of this side thread</label>
            <input
              id="side-thread-name"
              autoFocus
              value={renameTo}
              onChange={e => setRenameTo(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setRenameTo(null) }}
              className="min-h-[36px] w-40 rounded-md border border-line bg-surface-0 px-2 text-[13px] text-fg-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <Button type="submit" variant="ghost" size="sm">Save</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRenameTo(null)}>Cancel</Button>
          </form>
        )}
        {activeThread && renameTo === null && (
          <>
            <Button variant="ghost" size="sm" onClick={() => setRenameTo(activeThread.title)} className="min-h-[44px] sm:min-h-0">
              Rename
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Close the side thread "${activeThread.title}" (your main conversation is kept)`}
              onClick={() => void closeLane(activeThread)}
              className="min-h-[44px] sm:min-h-0"
            >
              Close
            </Button>
          </>
        )}
        {meta?.tool_catalog && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={settingsOpen}
            aria-label={`${settingsOpen ? 'Hide' : 'Show'} settings for ${agent.name} (model and tools)`}
            onClick={() => setSettingsOpen(o => !o)}
            className="min-h-[44px] sm:min-h-0"
          >
            Settings
          </Button>
        )}
        <IconButton
          label={infoOpen ? `Hide how to use ${agent.name}` : `How to use ${agent.name}: info and example prompts`}
          aria-expanded={infoOpen}
          aria-controls="agent-info-panel"
          onClick={() => setInfoOpen(o => !o)}
          className={cn(infoOpen && 'bg-surface-3 text-fg-0')}
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z" />
          </svg>
        </IconButton>
        <Button
          variant="ghost"
          size="sm"
          aria-label={
            activeThread
              ? `Clear this side thread (your main conversation with ${agent.name} is kept)`
              : `Clear this conversation with ${agent.name} (the bot is kept)`
          }
          onClick={() => void clear()}
          disabled={!thread?.messages.length || !!pending}
          className="min-h-[44px] sm:min-h-0"
        >
          {activeThread ? 'Clear side thread' : 'Clear conversation'}
        </Button>
      </header>

      {settingsOpen && meta?.tool_catalog && (
        <BotSettingsPanel
          agent={agent}
          meta={meta}
          isAdmin={isAdmin}
          onSaved={a => onAgentChanged?.(a)}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {infoOpen && (
        <AgentInfoPanel
          id="agent-info-panel"
          agent={agent}
          prompts={suggestionsFor(agent)}
          onClose={() => setInfoOpen(false)}
          onUsePrompt={p => {
            setText(p)
            setInfoOpen(false)
            input.current?.focus()
          }}
        />
      )}

      <LaneStrip threads={threads} lane={lane} maxOpen={maxOpen} busy={laneBusy} onPick={setLane} onOpen={() => void openLane()} />

      <div ref={scroller} className="flex-1 overflow-y-auto overflow-x-clip px-3 py-4 sm:px-6" aria-live="polite">
        <div className="mx-auto flex max-w-[760px] flex-col gap-3">
          {loadError && <Alert tone="alarm">{loadError}</Alert>}
          {!thread && !loadError && (
            <div className="space-y-4" aria-label="Loading conversation">
              <div className="flex items-start gap-2.5"><Skeleton className="h-7 w-7 rounded-lg" /><SkeletonText lines={2} className="flex-1" /></div>
              <div className="flex justify-end"><Skeleton className="h-10 w-1/2 rounded-lg" /></div>
              <div className="flex items-start gap-2.5"><Skeleton className="h-7 w-7 rounded-lg" /><SkeletonText lines={3} className="flex-1" /></div>
            </div>
          )}
          {thread && thread.messages.length === 0 && !pending && (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <AgentAvatar agent={agent} size="lg" />
              <div className="space-y-1">
                <p className="font-display text-[16px] font-semibold text-fg-0">
                  {activeThread ? `"${activeThread.title}" is empty` : `Start a conversation with ${agent.name}`}
                </p>
                <p className="mx-auto max-w-[46ch] text-[13px] leading-relaxed text-fg-2">
                  {activeThread
                    ? `A side thread has its own history and its own context — ${agent.name} sees only what you say here, and it keeps working while you use the main conversation.`
                    : agent.description}
                </p>
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
              {!activeThread && (
                <button
                  type="button"
                  onClick={() => setInfoOpen(true)}
                  className="text-[12.5px] text-accent-hover underline-offset-2 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  How to use {agent.name}
                </button>
              )}
              {agent.source === 'demo' && <p className="text-[12px] text-fg-2">Demo bot: the inbox, calendar and notes are made-up sample data.</p>}
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
                  {pending.images.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {pending.images.map(i => (
                        <img key={i.key} src={i.dataUrl} alt={i.name} className="max-h-40 rounded-md border border-line-soft" />
                      ))}
                    </div>
                  )}
                  {pending.text && <p className="whitespace-pre-wrap break-words">{pending.text}</p>}
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
        className={cn(
          'border-t border-line bg-surface-1 px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 transition-colors duration-fast sm:px-6',
          isDragging && 'bg-accent/5 ring-1 ring-inset ring-accent/40',
        )}
        onSubmit={e => { e.preventDefault(); void send(text) }}
        {...dropProps}
      >
        <div className="mx-auto max-w-[760px]">
          {sendError && <p role="alert" className="mb-2 text-[12.5px] text-signal-alarm">{sendError}</p>}
          {isDragging && <p className="mb-2 text-[12.5px] text-accent">Drop the image to attach it</p>}
          {images.length > 0 && (
            <ul aria-label="Attached images" className="mb-2 flex flex-wrap gap-2">
              {images.map(i => (
                <li key={i.key} className="relative">
                  <img src={i.dataUrl} alt={i.name} title={`${i.name} · ${humanSize(i.size)}`} className="h-16 w-16 rounded-md border border-line object-cover" />
                  <button
                    type="button"
                    aria-label={`Remove ${i.name}`}
                    onClick={() => setImages(cur => cur.filter(x => x.key !== i.key))}
                    className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-line bg-surface-0 text-[12px] leading-none text-fg-1 transition-colors duration-fast hover:border-line-strong hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={filePicker}
              type="file"
              accept={ACCEPTED_IMAGE_TYPES.join(',')}
              multiple
              className="hidden"
              data-testid="agent-chat-file-input"
              onChange={e => {
                const files = e.target.files
                if (files && files.length) void addFiles(files)
                e.target.value = ''
              }}
            />
            <IconButton type="button" label="Attach an image" onClick={() => filePicker.current?.click()} disabled={!!pending}>
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13" />
              </svg>
            </IconButton>
            <label htmlFor="agent-chat-input" className="sr-only">Message {agent.name}</label>
            <textarea
              id="agent-chat-input"
              ref={input}
              rows={1}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={onKey}
              onPaste={onPaste}
              placeholder={narrow ? 'Write a message…' : activeThread ? `Write a message in "${activeThread.title}"` : 'Write a message, or paste a screenshot'}
              disabled={!!pending}
              className="max-h-40 min-h-[44px] flex-1 resize-none rounded-lg border border-line bg-surface-0 px-3.5 py-2.5 text-[16px] text-fg-0 placeholder:text-fg-3 transition-colors duration-fast hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60 sm:text-[14px]"
            />
            <Button type="submit" variant="primary" loading={!!pending} disabled={!text.trim() && images.length === 0} className="min-h-[44px] sm:min-h-[44px]">
              Send
            </Button>
          </div>
          <p className="mt-1.5 hidden text-[12px] text-fg-2 sm:block">Enter to send · Shift+Enter for a new line · paste, drop or attach a screenshot · Email and calendar are always drafts until you press Send.</p>
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
  // ?prompt= pre-fills the message box (obj 900672) — e.g. the Agents page's
  // "Ask the Dev bot" links. Read once, then dropped from the URL
  // so a reload does not put it back.
  const [params, setParams] = useSearchParams()
  const pendingPrompt = useRef<{ slug: string; text: string } | null>(null)
  const promptParam = params.get('prompt')
  if (promptParam && slug) pendingPrompt.current = { slug, text: promptParam.slice(0, 2000) }
  useEffect(() => {
    if (!params.has('prompt')) return
    setParams(p => {
      const next = new URLSearchParams(p)
      next.delete('prompt')
      return next
    }, { replace: true })
  }, [params, setParams])
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
      setError(e instanceof Error ? e.message : 'Could not load bots')
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
  // The conversation read the prompt when it mounted; forget it so coming back
  // to this bot later does not type it in again.
  useEffect(() => {
    if (active && pendingPrompt.current?.slug === active.slug) pendingPrompt.current = null
  }, [active])
  const pick = (s: string) => navigate(`/chat/${s}`)

  if (error && !data) {
    return <div className="p-6"><Alert tone="alarm">{error}</Alert></div>
  }
  if (!data) {
    return (
      <div className="flex h-full" aria-label="Loading bots">
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
          title="No bots yet"
          description={
            isAdmin
              ? 'A bot is one file in the agents folder on the server — this page does not create one (see the Bots guide). Or try the demo: a personal assistant bot with a made-up inbox and calendar.'
              : 'Your administrator has not added any bots yet.'
          }
          action={isAdmin ? <Button variant="primary" loading={demoBusy} onClick={() => void setDemo(true)}>Turn on the demo bot</Button> : undefined}
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
          <Conversation
            key={active.slug}
            agent={active}
            onBack={() => navigate('/chat')}
            initialText={pendingPrompt.current?.slug === active.slug ? pendingPrompt.current.text : ''}
            meta={data}
            isAdmin={isAdmin}
            onAgentChanged={a =>
              setData(d => (d ? { ...d, agents: d.agents.map(x => (x.slug === a.slug ? { ...x, ...a } : x)) } : d))
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            <EmptyState
              title={slug ? `No bot called "${slug}"` : 'Pick a bot'}
              description="Each bot keeps one ongoing conversation with you — opening a bot reopens that conversation, it does not create a new bot. History is stored on this server only."
              compact
            />
          </div>
        )}
      </main>
    </div>
  )
}
