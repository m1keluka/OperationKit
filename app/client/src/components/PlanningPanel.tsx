import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { Paperclip } from 'lucide-react'
import type { Objective, SessionMessage } from '@command-center/shared'
import { api } from '../lib/api'
import { filesFromClipboard, useFileDrop } from '../hooks/useFileDrop'
import { GroupedMessages } from './SessionMessages'
import { FileEditorOverlay } from './FileEditorOverlay'

interface PlanningPanelProps {
  objective: Objective
  onClose: () => void
  onApproved: (updated: Objective) => void
}

interface UploadedFile {
  originalName: string
  path: string
  size: number
  mimetype: string
}

/**
 * Q&A panel for the planning stage. Spawns a planner sub-session, polls it for
 * output, and lets the user iterate until they approve the plan. On approval
 * the objective transitions to queue with `approved_plan` populated.
 */
export function PlanningPanel({ objective: initialObjective, onClose, onApproved }: PlanningPanelProps) {
  const [objective, setObjective] = useState(initialObjective)
  useEffect(() => setObjective(initialObjective), [initialObjective])

  const [messages, setMessages] = useState<SessionMessage[]>([])
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approving, setApproving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [editingDocPath, setEditingDocPath] = useState<string | null>(null)
  const [attachedFiles, setAttachedFiles] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const messageCountRef = useRef(0)
  const fetchingRef = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Reset incremental state when objective changes
  useEffect(() => {
    setMessages([])
    messageCountRef.current = 0
    setAttachedFiles([])
  }, [initialObjective.id])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [message])

  // If the objective has no planning_session_id yet, offer a Start button.
  const sessionStarted = !!objective.planning_session_id

  const fetchMessages = useCallback(async () => {
    if (!sessionStarted || fetchingRef.current) return
    fetchingRef.current = true
    try {
      const after = messageCountRef.current
      const path = after > 0
        ? `/objectives/${objective.id}/planning/messages?after=${after}`
        : `/objectives/${objective.id}/planning/messages`
      const data = await api.get<{ messages: SessionMessage[]; total?: number; status?: string }>(path)
      // Race guard: if handleSend's optimistic-add bumped messageCountRef
      // while we were awaiting, applying this payload would duplicate the
      // followup the optimistic block already appended. Drop it; next tick
      // fetches cleanly from the new offset.
      if (messageCountRef.current !== after) return
      const newMessages = data.messages || []
      const total = data.total ?? newMessages.length
      if (after > 0 && newMessages.length > 0) {
        setMessages(prev => [...prev, ...newMessages])
      } else if (after === 0) {
        setMessages(newMessages)
      }
      messageCountRef.current = total
    } catch {}
    fetchingRef.current = false
  }, [objective.id, sessionStarted])

  useEffect(() => {
    if (!sessionStarted) return
    fetchMessages()
    const interval = setInterval(fetchMessages, 2500)
    return () => clearInterval(interval)
  }, [fetchMessages, sessionStarted])

  // Auto-scroll on new messages
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages.length])

  // Clickable doc-path handler (event delegation) — mirrors SessionViewer so
  // markdown file links in planner messages open the editor overlay.
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    function handleDocClick(e: MouseEvent) {
      const link = (e.target as HTMLElement).closest('[data-doc-path]') as HTMLElement | null
      if (!link) return
      e.preventDefault()
      const docPath = link.getAttribute('data-doc-path')
      if (docPath) setEditingDocPath(docPath)
    }
    container.addEventListener('click', handleDocClick)
    return () => container.removeEventListener('click', handleDocClick)
  }, [sessionStarted])

  async function handleStart() {
    if (starting) return
    setStarting(true)
    setError(null)
    try {
      const data = await api.post<{ session_id: string }>(`/objectives/${objective.id}/planning/start`, {})
      setObjective(prev => ({ ...prev, planning_session_id: data.session_id }))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start planner')
    }
    setStarting(false)
  }

  async function handleUpload(fileList: FileList) {
    if (fileList.length === 0) return
    setUploading(true)
    const formData = new FormData()
    for (const file of Array.from(fileList)) {
      formData.append('files', file)
    }
    try {
      // Raw fetch required for multipart/form-data uploads — api client sets JSON content-type
      const res = await fetch(`/api/objectives/${objective.id}/upload`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
      if (res.ok) {
        const data = await res.json()
        setAttachedFiles(prev => [...prev, ...data.files])
      } else {
        setError('Upload failed')
      }
    } catch {
      setError('Upload failed — network error')
    }
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  function removeFile(index: number) {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index))
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  }

  const { isDragging, dropProps } = useFileDrop(handleUpload, !uploading && !sending)

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (uploading || sending) return
    const files = filesFromClipboard(e)
    if (!files) return
    e.preventDefault()
    void handleUpload(files)
  }

  async function handleSend() {
    if ((!message.trim() && attachedFiles.length === 0) || sending) return
    const text = message.trim() || '(see attached files)'
    setSending(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { message: text }
      if (attachedFiles.length > 0) {
        body.filePaths = attachedFiles.map(f => f.path)
      }
      await api.post(`/objectives/${objective.id}/planning/message`, body)
      setMessage('')
      setAttachedFiles([])
      const optimistic: SessionMessage = { type: 'followup', text, timestamp: new Date().toISOString() }
      setMessages(prev => [...prev, optimistic])
      messageCountRef.current += 1
      setTimeout(() => fetchMessages(), 500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send')
    }
    setSending(false)
  }

  async function handleApprove() {
    if (approving) return
    setApproving(true)
    setError(null)
    try {
      const updated = await api.post<Objective>(`/objectives/${objective.id}/planning/approve`, {})
      onApproved(updated)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed — does the planner have a <plan>…</plan> block in its latest response?')
    }
    setApproving(false)
  }

  async function handleCancel() {
    if (!confirm('Cancel planning? The conversation is preserved; you can resume by re-opening planning.')) return
    try {
      await api.post(`/objectives/${objective.id}/planning/cancel`, {})
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancel failed')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3 bg-surface-raised">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded bg-status-planning/20 text-status-planning border border-status-planning/30 px-1.5 py-0.5 text-[10px] font-semibold">PLANNING</span>
            <h3 className="text-sm font-medium text-white truncate">{objective.title}</h3>
          </div>
          {objective.planning_session_id && (
            <div className="text-[10px] text-gray-600 font-mono truncate mt-0.5">{objective.planning_session_id}</div>
          )}
        </div>
        <div className="flex items-center gap-2 ml-3">
          {sessionStarted && (
            <>
              <button
                onClick={handleApprove}
                disabled={approving}
                className="rounded-lg bg-emerald-600 hover:bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {approving ? 'Approving...' : 'Approve Plan'}
              </button>
              <button
                onClick={handleCancel}
                className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-gray-400 border border-border hover:text-white hover:border-border-hover"
              >
                Cancel Planning
              </button>
            </>
          )}
          <button
            onClick={onClose}
            className="rounded-lg p-2 text-gray-500 hover:text-gray-300 hover:bg-surface-overlay"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {!sessionStarted && (
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="max-w-md text-center space-y-4">
            <p className="text-sm text-gray-400">
              This is a Project-type objective, so it starts in the planning stage. A read-only planner sub-session will ask you clarifying questions, then emit a plan you approve. Approving the plan starts the worker — you do not click Start again.
            </p>
            <button
              onClick={handleStart}
              disabled={starting}
              className="rounded-md bg-status-planning/90 hover:bg-status-planning px-4 py-2 text-sm font-medium text-surface-0 disabled:opacity-50 transition-colors duration-fast ease-out"
            >
              {starting ? 'Starting planner...' : 'Start Planning'}
            </button>
            <div>
              <button
                onClick={async () => {
                  try {
                    await api.patch(`/objectives/${objective.id}/status`, { status: 'queue' })
                    onClose()
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Skip failed')
                  }
                }}
                className="text-xs text-gray-500 hover:text-gray-300 underline"
              >
                Skip planning, send straight to queue
              </button>
            </div>
            {error && (
              <div className="rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
            )}
          </div>
        </div>
      )}

      {sessionStarted && (
        <>
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="max-w-4xl mx-auto px-3 py-4 space-y-2">
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center gap-3 mt-16">
                  <div className="flex items-center gap-1.5">
                    <span className="cc-think-dot text-status-planning" />
                    <span className="cc-think-dot text-status-planning" />
                    <span className="cc-think-dot text-status-planning" />
                  </div>
                  <div className="text-sm text-fg-2">Planner is loading context...</div>
                </div>
              )}
              <GroupedMessages messages={messages} />
            </div>
          </div>

          <div className="border-t border-border bg-surface-raised">
            <div className="max-w-4xl mx-auto px-3 pt-2 pb-3">
              <div className="mb-2 rounded bg-surface px-3 py-1.5 text-[11px] text-gray-500 border border-border/60 flex items-center gap-2">
                <span className="text-emerald-400">●</span>
                <span>Planner is read-only. Click <span className="text-emerald-400 font-medium">Approve Plan</span> to lock the plan and start the worker.</span>
              </div>
              {error && (
                <div className="mb-2 rounded bg-red-500/10 px-3 py-1.5 text-xs text-red-400 flex items-center justify-between">
                  <span>{error}</span>
                  <button onClick={() => setError(null)} className="ml-2 text-red-400/60 hover:text-red-400">&times;</button>
                </div>
              )}
              {/* Attached files chips */}
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {attachedFiles.map((f, i) => {
                    const isImage = f.mimetype.startsWith('image/')
                    return (
                      <span key={i} className="inline-flex items-center gap-1.5 rounded-md bg-surface-overlay border border-border px-2 py-1 text-xs text-gray-300">
                        <span>{isImage ? '🖼️' : '📄'}</span>
                        <span className="truncate max-w-[150px]">{f.originalName}</span>
                        <span className="text-gray-600">{formatFileSize(f.size)}</span>
                        <button onClick={() => removeFile(i)} className="text-gray-500 hover:text-red-400 ml-0.5">&times;</button>
                      </span>
                    )
                  })}
                </div>
              )}
              <div
                {...dropProps}
                className={`flex items-end gap-2 rounded-lg border bg-surface px-2 py-1.5 transition-colors ${isDragging ? 'border-accent border-dashed bg-accent/5' : 'border-border focus-within:border-accent'}`}
              >
                {/* Hidden file input */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={e => e.target.files && handleUpload(e.target.files)}
                />
                {/* Attach button */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading || sending}
                  className="mb-1 shrink-0 rounded p-1 text-gray-500 hover:text-accent disabled:opacity-40 transition-colors"
                  title="Attach files"
                >
                  <Paperclip className={`h-4 w-4 ${uploading ? 'animate-pulse' : ''}`} />
                </button>
                <textarea
                  ref={textareaRef}
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      handleSend()
                    }
                  }}
                  onPaste={handlePaste}
                  placeholder={isDragging ? 'Drop files to attach…' : "Answer the planner's questions, or say 'approve' to lock the plan..."}
                  rows={1}
                  className="flex-1 resize-none bg-transparent py-1.5 text-base sm:text-sm text-white placeholder-gray-600 focus:outline-none font-mono"
                />
                <button
                  onClick={handleSend}
                  disabled={(!message.trim() && attachedFiles.length === 0) || sending}
                  className="mb-1 shrink-0 rounded-md bg-accent px-3 py-1 text-sm font-medium text-white disabled:opacity-40"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {editingDocPath && (
        <FileEditorOverlay filePath={editingDocPath} onClose={() => setEditingDocPath(null)} />
      )}
    </div>
  )
}
