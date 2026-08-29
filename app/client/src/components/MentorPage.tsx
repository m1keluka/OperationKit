import { useCallback, useEffect, useState } from 'react'
import { useMentorThreads, useMentorOutput } from '../hooks/useMentorThreads'
import { useAssistantConfig } from '../hooks/useAssistantConfig'
import { ThreadList } from './mentor/ThreadList'
import { ThreadDrawer } from './mentor/ThreadDrawer'
import { MessageList } from './mentor/MessageList'
import { MessageComposer, type ComposerAttachment } from './mentor/MessageComposer'

const TITLE_MAX = 60

function deriveTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= TITLE_MAX) return trimmed
  return trimmed.slice(0, TITLE_MAX - 1).trimEnd() + '…'
}

export function MentorPage() {
  const {
    threads,
    loading: threadsLoading,
    error: threadsError,
    refresh: refreshThreads,
    createThread,
    updateThread,
    archiveThread,
    deleteThread,
  } = useMentorThreads()

  const [activeThreadId, setActiveThreadId] = useState<number | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [composerValue, setComposerValue] = useState('')
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)

  const { messages, state, loading: outputLoading, sendMessage, stopSession } = useMentorOutput(activeThreadId)

  // The user's configured assistant name; resolved once here and passed down.
  // Falls back to 'Assistant' while loading or when the name is unset.
  const { config: assistantConfig } = useAssistantConfig()
  const assistantName = assistantConfig?.persona.displayName?.trim() || 'Assistant'

  // Auto-select most recent thread on first load.
  useEffect(() => {
    if (activeThreadId === null && threads.length > 0 && !threadsLoading) {
      setActiveThreadId(threads[0].id)
    }
  }, [threads, threadsLoading, activeThreadId])

  // If the active thread vanishes (deleted/archived), clear selection.
  useEffect(() => {
    if (activeThreadId !== null && !threads.some(t => t.id === activeThreadId)) {
      setActiveThreadId(null)
    }
  }, [threads, activeThreadId])

  const handleSelectThread = useCallback((id: number) => {
    setActiveThreadId(id)
    setDrawerOpen(false)
    setSendError(null)
    setPendingUser(null)
    setComposerValue('')
    setAttachments([])
    setAttachmentError(null)
  }, [])

  const handleNewThread = useCallback(async () => {
    try {
      const created = await createThread({ title: 'New thread' })
      setActiveThreadId(created.id)
      setDrawerOpen(false)
      setSendError(null)
      setPendingUser(null)
      setComposerValue('')
      setAttachments([])
      setAttachmentError(null)
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'failed to create thread')
    }
  }, [createThread])

  const handleRename = useCallback(async (id: number, title: string) => {
    await updateThread(id, { title })
  }, [updateThread])

  const handlePin = useCallback(async (id: number, pinned: boolean) => {
    await updateThread(id, { pinned })
    await refreshThreads()
  }, [updateThread, refreshThreads])

  const handleArchive = useCallback(async (id: number) => {
    await archiveThread(id)
  }, [archiveThread])

  const handleDelete = useCallback(async (id: number) => {
    await deleteThread(id)
  }, [deleteThread])

  const handleMarkDone = useCallback(async (id: number, done: boolean) => {
    await updateThread(id, { done })
  }, [updateThread])

  const performSend = useCallback(async (text: string, paths: string[]) => {
    if (activeThreadId === null) return
    const isFirstMessage = messages.length === 0
    setPendingUser(text)
    setSending(true)
    setSendError(null)
    try {
      await sendMessage(text, paths)
      setComposerValue('')
      setAttachments([])
      setAttachmentError(null)
      // Don't clear pendingUser yet — the next /output poll picks up the
      // followup event from the JSONL log and the GroupedMessages render
      // takes over. We clear it in a useEffect below when messages catch up.
      if (isFirstMessage) {
        const derived = deriveTitle(text)
        const current = threads.find(t => t.id === activeThreadId)
        const isUntitled = !current || current.title === 'New thread' || current.title === 'Untitled'
        if (isUntitled && derived) {
          try { await updateThread(activeThreadId, { title: derived }) } catch {}
        }
      }
      void refreshThreads()
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'send failed')
      setComposerValue(text)
      setPendingUser(null)
    } finally {
      setSending(false)
    }
  }, [activeThreadId, messages.length, sendMessage, threads, updateThread, refreshThreads])

  // Clear pendingUser once the followup shows up in the live transcript.
  // Server appends an "Attached files:" block, so use startsWith rather than equality.
  useEffect(() => {
    if (!pendingUser) return
    const needle = pendingUser.trim()
    const found = messages.some(m => m.type === 'followup' && (m.text || '').trim().startsWith(needle))
    if (found) setPendingUser(null)
  }, [messages, pendingUser])

  const handleAttachFiles = useCallback(async (files: FileList) => {
    if (activeThreadId === null) return
    setUploading(true)
    setAttachmentError(null)
    try {
      const form = new FormData()
      for (const f of Array.from(files)) form.append('files', f)
      // Raw fetch required for multipart/form-data uploads — api client sets JSON content-type
      const res = await fetch(`/api/mentor/threads/${activeThreadId}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      if (!res.ok) {
        let msg = `${res.status}`
        try {
          const body = await res.json() as { error?: string }
          if (body?.error) msg = body.error
        } catch {}
        throw new Error(msg)
      }
      const data = await res.json() as { files: ComposerAttachment[] }
      setAttachments(prev => [...prev, ...(data.files || [])])
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : 'upload failed')
    } finally {
      setUploading(false)
    }
  }, [activeThreadId])

  const handleRemoveAttachment = useCallback((path: string) => {
    setAttachments(prev => prev.filter(a => a.path !== path))
  }, [])

  const handleSubmit = useCallback(() => {
    const text = composerValue.trim()
    if (!text || activeThreadId === null) return
    void performSend(text, attachments.map(a => a.path))
  }, [composerValue, activeThreadId, performSend, attachments])

  const handleRetry = useCallback(() => {
    if (composerValue.trim()) {
      void performSend(composerValue.trim(), attachments.map(a => a.path))
    }
  }, [composerValue, performSend, attachments])

  const handleStop = useCallback(async () => {
    if (activeThreadId === null) return
    if (!window.confirm(`Stop this ${assistantName} session? The thread is preserved; the next message will start a fresh session (without the live process context).`)) return
    try {
      await stopSession()
      void refreshThreads()
    } catch {}
  }, [activeThreadId, stopSession, refreshThreads, assistantName])

  // Prefill the composer from a welcome-state quick-start chip. Creates a fresh
  // thread first when none is selected so the prefilled text has somewhere to go.
  const handleQuickAction = useCallback(async (prompt: string) => {
    if (activeThreadId === null) {
      try {
        const created = await createThread({ title: 'New thread' })
        setActiveThreadId(created.id)
        setDrawerOpen(false)
        setSendError(null)
        setPendingUser(null)
        setAttachments([])
        setAttachmentError(null)
        setComposerValue(prompt)
      } catch (err) {
        setSendError(err instanceof Error ? err.message : 'failed to create thread')
      }
    } else {
      setComposerValue(prompt)
    }
  }, [activeThreadId, createThread])

  const activeThread = threads.find(t => t.id === activeThreadId)
  const sessionAlive = state === 'working' || state === 'review'

  return (
    <div className="relative flex h-full flex-col bg-surface-0">
      {/* Slim top bar — recents + new chat, centered title */}
      <header className="flex items-center gap-2 border-b border-line bg-surface-1 px-3 py-2">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open recent chats"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-fg-2 transition-colors duration-fast hover:bg-surface-2 hover:text-fg-0"
        >
          <MenuIcon className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1 truncate text-center font-display text-sm font-semibold tracking-[-0.01em] text-fg-0">
          {activeThread?.title ?? assistantName}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {sessionAlive && activeThread && (
            <>
              <StateBadge state={state} />
              <button
                onClick={handleStop}
                className="hidden rounded-md border border-signal-alarm/30 bg-signal-alarm/10 px-2 py-1 text-[11px] text-signal-alarm transition-colors hover:bg-signal-alarm/20 sm:inline-block"
              >
                Stop
              </button>
            </>
          )}
          <button
            onClick={handleNewThread}
            aria-label="New chat"
            title="New chat"
            className="grid h-9 w-9 place-items-center rounded-md text-accent-hover transition-colors duration-fast hover:bg-[var(--accent-tint)] hover:text-accent"
          >
            <NewChatIcon className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* Conversation — centered focused column */}
      <div className="min-h-0 flex-1">
        <MessageList
          key={activeThreadId ?? 'welcome'}
          messages={messages}
          state={state}
          loading={activeThreadId !== null && outputLoading}
          pendingUser={pendingUser}
          errorMessage={sendError}
          onRetry={composerValue.trim() ? handleRetry : undefined}
          assistantName={assistantName}
          onPickStarter={handleQuickAction}
        />
      </div>

      <MessageComposer
        value={composerValue}
        onChange={setComposerValue}
        onSubmit={handleSubmit}
        sending={sending}
        disabled={activeThreadId === null}
        placeholder={activeThreadId === null ? 'Start a new chat or pick a quick start above…' : undefined}
        attachments={attachments}
        onAttachFiles={activeThreadId !== null ? handleAttachFiles : undefined}
        onRemoveAttachment={handleRemoveAttachment}
        attachmentError={attachmentError}
        uploading={uploading}
      />

      {/* Recents slide-over */}
      <ThreadDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <ThreadList
          threads={threads}
          activeThreadId={activeThreadId}
          activeThreadState={state}
          sending={sending}
          loading={threadsLoading}
          error={threadsError}
          onSelect={handleSelectThread}
          onNewThread={handleNewThread}
          onRename={handleRename}
          onPin={handlePin}
          onArchive={handleArchive}
          onDelete={handleDelete}
          onMarkDone={handleMarkDone}
        />
      </ThreadDrawer>
    </div>
  )
}

function StateBadge({ state }: { state: 'idle' | 'working' | 'review' }) {
  if (state === 'working') {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm border border-status-working/30 bg-status-working/10 px-1.5 py-0.5 text-[11px] font-medium text-status-working">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-working" />
        working
      </span>
    )
  }
  if (state === 'review') {
    return <span className="rounded-sm border border-signal-verify/30 bg-signal-verify/10 px-1.5 py-0.5 text-[11px] font-medium text-signal-verify">ready</span>
  }
  return null
}

function MenuIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  )
}

function NewChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  )
}

