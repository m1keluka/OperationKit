import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import type { Objective, ObjectiveReview, ObjectivePR, SessionIntel } from '@operationkit/shared'
import { AGENT_META, type AgentContext } from '@operationkit/shared'
import type { ConnState } from './ConnStatusPill'
// Lazy: FileEditorOverlay pulls in the heavy BlockNote editor. It only mounts
// when the operator opens a doc to edit — keeping it out of the board/viewer
// chunk shrinks the initial bundle (obj 700585).
const FileEditorOverlay = lazy(() => import('./FileEditorOverlay').then(m => ({ default: m.FileEditorOverlay })))
import { relativeTime } from '../lib/time'
import { api } from '../lib/api'
import { cn } from './ui'
import {
  loadViewerSize, SIZE_KEY,
  type ViewerSize, type SessionViewerProps, type UploadedFile,
} from './session-viewer/types'
import { ViewerHeader } from './session-viewer/ViewerHeader'
import { CorrectionPanel } from './session-viewer/CorrectionPanel'
import { BriefPanel } from './session-viewer/BriefPanel'
import { ThreadPane } from './session-viewer/ThreadPane'
import { Composer } from './session-viewer/Composer'
import { DesignCanvas } from '../preview/DesignCanvas'
import { extractPreviewUrls } from '../preview/designReview'

export type { SessionViewerProps }

export function SessionViewer({
  objective: initialObjective,
  onClose,
  onChangeStatus,
  chrome = 'drawer',
  onOpenInNewTab,
  onDesignModeChange,
  onEdit,
}: SessionViewerProps) {
  const [objective, setObjective] = useState(initialObjective)
  // Sync if parent updates the objective (e.g. via WebSocket). MERGE rather than
  // replace: the board LIST is now slim (obj 700512) and omits heavy text fields
  // (description, approved_plan, ai_review_findings, last_session_summary), so a
  // live WS payload lacks those keys — a straight replace would blank the detail
  // we hydrate below. Spreading over `prev` keeps hydrated heavy fields while
  // still applying live scalar updates (status, verdict, cost, …).
  useEffect(() => { setObjective(prev => ({ ...prev, ...initialObjective })) }, [initialObjective])
  // Hydrate the FULL row (heavy text included) from the per-objective endpoint —
  // the board card only carried the slim projection. Merge so live updates win
  // on the fields they carry and the detail fills in the rest.
  useEffect(() => {
    let cancelled = false
    api.get<Objective>(`/objectives/${initialObjective.id}`)
      .then(full => { if (!cancelled) setObjective(prev => ({ ...prev, ...full })) })
      .catch(() => {}) // detail is best-effort; the slim card data still renders
    return () => { cancelled = true }
  }, [initialObjective.id])
  // The thread is rendered by <ThreadTimeline> from ?view=timeline. We keep a
  // small "thread has content" flag (driven by its onContentChange callback) so
  // the empty-state / activity indicators behave as before.
  const [threadHasContent, setThreadHasContent] = useState(false)
  // Live-stream connection state bubbled up from ThreadTimeline (SSE open /
  // connecting / poll fallback) — backs the header connection pill.
  const [connState, setConnState] = useState<ConnState>('connecting')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // Optimistic echo of the just-sent follow-up. The real message surfaces as a
  // `divider`/`followup` segment on the next ThreadTimeline poll (~2s), so until
  // then we render this right-aligned bubble immediately. Cleared once a poll
  // cycle completes after the send reconciles it (OK-13).
  const [pendingEcho, setPendingEcho] = useState<string | null>(null)
  const [attachedFiles, setAttachedFiles] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [showBrief, setShowBrief] = useState(false)
  const [showDesign, setShowDesign] = useState(false)
  const [designUrl, setDesignUrl] = useState('')
  // AI Review iteration rows (per-criterion results + screenshots). Fetched from
  // GET /objectives/:id/reviews; the latest row backs the per-criterion table.
  const [reviews, setReviews] = useState<ObjectiveReview[]>([])
  const [prs, setPrs] = useState<ObjectivePR[]>([])
  // Per-session intel rows (obj-2387) — back the skills / sub-agents surface.
  const [intel, setIntel] = useState<SessionIntel[]>([])
  const [editingDocPath, setEditingDocPath] = useState<string | null>(null)
  const [interrupting, setInterrupting] = useState(false)
  // ST5 human mistake-labeling surface
  const [showCorrection, setShowCorrection] = useState(false)
  const [correctionText, setCorrectionText] = useState('')
  const [submittingCorrection, setSubmittingCorrection] = useState(false)
  const [correctionError, setCorrectionError] = useState<string | null>(null)
  const [correctionSaved, setCorrectionSaved] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const prevContentVerRef = useRef(0)
  // Pinned to the newest message: true on open (so the chat lands on the most
  // recent message, not the oldest) and while the user is following a live
  // thread; released when they scroll up to read earlier messages.
  const pinnedToBottomRef = useRef(true)
  // Bumped by ThreadTimeline whenever its rendered content grows, so the
  // auto-scroll effect can react without owning the message array.
  const [contentVer, setContentVer] = useState(0)
  // Desktop drawer size — half-screen right drawer vs full-width. Persisted so
  // the choice sticks across reopen. No-op on mobile (always full-screen sheet).
  const [size, setSize] = useState<ViewerSize>(loadViewerSize)
  const toggleSize = useCallback(() => {
    setSize(prev => {
      const next = prev === 'full' ? 'half' : 'full'
      try { localStorage.setItem(SIZE_KEY, next) } catch {}
      return next
    })
  }, [])
  const isFull = size === 'full'

  // Reset per-objective UI state when the objective changes.
  useEffect(() => {
    setThreadHasContent(false)
    setConnState('connecting')
    prevContentVerRef.current = 0
    setContentVer(0)
    setReviews([])
    setPendingEcho(null)
    setSending(false)
    setSendError(null)
    setShowDesign(false)
    onDesignModeChange?.(false)
    setDesignUrl('')
    pinnedToBottomRef.current = true // a freshly opened chat starts at the newest message
  }, [initialObjective.id])

  // Fetch the AI Review iteration rows so we can surface per-criterion results
  // and screenshots. Refetch when the verdict changes (a new iteration landed).
  useEffect(() => {
    let cancelled = false
    api.get<ObjectiveReview[]>(`/objectives/${objective.id}/reviews`)
      .then(rows => { if (!cancelled) setReviews(rows) })
      .catch(() => { if (!cancelled) setReviews([]) })
    return () => { cancelled = true }
  }, [objective.id, objective.ai_review_verdict])

  // Fetch the per-objective PR log (obj 2300). Refetch when the latest-PR pointer
  // changes (a new PR was reported) or the status moves (a merge/close may have
  // freshened a row's state).
  useEffect(() => {
    let cancelled = false
    api.get<ObjectivePR[]>(`/objectives/${objective.id}/prs`)
      .then(rows => { if (!cancelled) setPrs(rows) })
      .catch(() => { if (!cancelled) setPrs([]) })
    return () => { cancelled = true }
  }, [objective.id, objective.pr_number, objective.pr_url, objective.status])

  // Fetch per-session intel (skills + sub-agent personas invoked). Refetch when
  // a session ends (session_count bumps) or status moves, so a running session's
  // activity surfaces as soon as it's extracted (obj-2387).
  useEffect(() => {
    let cancelled = false
    api.get<SessionIntel[]>(`/objectives/${objective.id}/intel`)
      .then(rows => { if (!cancelled) setIntel(Array.isArray(rows) ? rows : []) })
      .catch(() => { if (!cancelled) setIntel([]) })
    return () => { cancelled = true }
  }, [objective.id, objective.session_count, objective.status])

  useEffect(() => {
    const el = messageRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [message])
  const isActive = objective.status === 'working'

  // Aggregate session activity across every recorded session for this objective
  // (obj-2387). `agents_invoked` excludes the primary agent_context — the badge
  // already shows that — so the strip surfaces only the *additional* personas the
  // session adopted via the routing table.
  const uniq = (xs: string[][]) => Array.from(new Set(xs.flat())).filter(Boolean).sort()
  const skillsInvoked = uniq(intel.map(i => i.skills_used || []))
  const subagentPersonas = uniq(intel.map(i => i.agents_invoked || []))
    .filter(a => a !== objective.agent_context)
  const subagentWorkers = uniq(intel.map(i => i.subagents_spawned || []))
  const hasActivity = skillsInvoked.length > 0 || subagentPersonas.length > 0 || subagentWorkers.length > 0
  const agentLabel = (slug: string) => AGENT_META[slug as AgentContext]?.label || slug

  // Keyboard: Esc closes; `f` toggles fullscreen (ignored while typing so it
  // doesn't swallow the letter in the composer / correction fields).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'f' || e.key === 'F') {
        const t = e.target as HTMLElement | null
        const tag = t?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return
        e.preventDefault()
        if (onOpenInNewTab) onOpenInNewTab()
        else toggleSize()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, toggleSize, onOpenInNewTab])

  // ThreadTimeline polls ?view=timeline itself; it bubbles server-detected
  // status changes (poller-driven) up here so the header + input stay in sync.
  const handleStatus = useCallback((status: string) => {
    setObjective(prev => prev.status === status ? prev : { ...prev, status: status as typeof prev.status })
  }, [])

  // ThreadTimeline calls this whenever its rendered content grows (new segment,
  // expanded gap, trailing-gap activity) so the auto-scroll effect can react.
  const handleContentChange = useCallback(() => {
    setThreadHasContent(true)
    setContentVer(v => v + 1)
  }, [])

  const handleEchoLanded = useCallback(() => setPendingEcho(null), [])

  // ThreadTimeline reports its live-stream connection state so the header pill
  // reflects Live / Connecting / Offline.
  const handleConnState = useCallback((s: ConnState) => setConnState(s), [])

  // Copy button handler for code blocks (event delegation)
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    function handleClick(e: MouseEvent) {
      const btn = (e.target as HTMLElement).closest('[data-copy-code]') as HTMLElement | null
      if (!btn) return
      const codeEl = btn.parentElement?.querySelector('code')
      if (!codeEl) return
      navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
        btn.textContent = 'Copied!'
        setTimeout(() => { btn.textContent = 'Copy' }, 1500)
      })
    }
    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [])

  // Clickable doc-path handler (event delegation)
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
  }, [])

  // Track whether the user is pinned to the bottom. Released when they scroll up
  // to read earlier messages, re-engaged when they return to the bottom. A
  // programmatic scroll-to-bottom also fires this and correctly keeps us pinned.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Keep the view on the newest message while pinned — this is what makes a
  // freshly opened chat land on the most recent message instead of the oldest,
  // and what follows a live thread along. Deferred to requestAnimationFrame so
  // the scroll is measured AFTER the new content (markdown, segments) lays out;
  // doing it synchronously was why the initial scroll missed the bottom.
  useEffect(() => {
    if (contentVer <= prevContentVerRef.current) { prevContentVerRef.current = contentVer; return }
    prevContentVerRef.current = contentVer
    if (!pinnedToBottomRef.current) return
    const pin = () => {
      const el = scrollRef.current
      if (el && pinnedToBottomRef.current) el.scrollTop = el.scrollHeight
    }
    pin()
    requestAnimationFrame(pin)
  }, [contentVer])

  // Bulletproofing for the "open at the newest message" pin: heavy markdown
  // (katex/mermaid/code highlighting) and images lay out asynchronously AFTER
  // React commits and after the rAF above, which can leave the view stranded
  // above the bottom — a contentVer tick never fires for that late growth. A
  // ResizeObserver on the scrolled content snaps back to the bottom on every
  // height change, but only while the user is still pinned (scrolled to bottom).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const stick = () => { if (pinnedToBottomRef.current) el.scrollTop = el.scrollHeight }
    const ro = new ResizeObserver(stick)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => ro.disconnect()
    // Re-attach once real thread content exists (the observed child swaps from
    // the empty-state placeholder to the ThreadTimeline root).
  }, [initialObjective.id, threadHasContent])

  async function handleUpload(fileList: FileList) {
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
        console.error('Upload failed')
      }
    } catch {}
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleSendMessage(override?: string) {
    const outgoing = (override ?? message).trim()
    if ((!outgoing && attachedFiles.length === 0) || sending) return
    // Capture before the await so a failed send can preserve the typed text
    // (OK-14). Draft state is cleared ONLY after the send resolves successfully.
    const draft = override ? message : outgoing
    const sentBody = outgoing || message
    const draftFiles = attachedFiles
    const sentText = (override ?? sentBody) || '(see attached files)'
    setSending(true)
    setSendError(null)
    // Optimistic echo — render the user's bubble instantly instead of waiting for
    // the next timeline poll (OK-13). Removed again if the send fails.
    setPendingEcho(sentText)
    // Clear the input optimistically so the textbox empties the instant Send is
    // pressed, instead of staying full until the (slow, respawn-bound) POST
    // resolves 3-5s later (obj 700253). Restored from `draft`/`draftFiles` on
    // failure so a failed send still preserves the typed text (OK-14).
    // Design-canvas Send passes `override` and must not wipe a typed composer draft.
    if (!override) {
      setMessage('')
      setAttachedFiles([])
    }
    // Flip to `working` now so the thinking indicator appears immediately rather
    // than after the POST returns — the session is being (re)spawned regardless.
    handleStatus('working')
    try {
      const body: Record<string, unknown> = { message: sentText }
      if (draftFiles.length > 0) {
        body.filePaths = draftFiles.map(f => f.path)
      }
      await api.post(`/objectives/${objective.id}/message`, body, { timeoutMs: 20_000 })
      // The follow-up surfaces as a `divider` segment on the next timeline poll.
      setSending(false)
      return true
    } catch (e) {
      // Send failed — drop the optimistic echo and restore the draft + files so
      // the user can retry without retyping.
      setPendingEcho(null)
      setMessage(draft)
      setAttachedFiles(draftFiles)
      setSendError(e instanceof Error ? e.message : 'Network error — message not sent')
      setSending(false)
      return false
    }
  }

  async function handleStop() {
    if (interrupting) return
    setInterrupting(true)
    try {
      // Hard stop: kills the session and parks the objective in review. Unlike
      // the old /interrupt (Ctrl+C only), this works even when the session is
      // already dead/stuck (e.g. a usage-limit hit) and actually moves the card.
      await api.post(`/objectives/${objective.id}/stop`)
    } catch {}
    setTimeout(() => setInterrupting(false), 2000)
  }

  // ST5: submit a human correction ("this session got X wrong"). It becomes a
  // high-priority gotcha injected into the next spawn's context for this
  // objective.
  async function submitCorrection() {
    const label = correctionText.trim()
    if (!label || submittingCorrection) return
    setSubmittingCorrection(true)
    setCorrectionError(null)
    try {
      await api.post(`/objectives/${objective.id}/corrections`, { label })
      setCorrectionText('')
      setCorrectionSaved(true)
      setShowCorrection(false)
      setTimeout(() => setCorrectionSaved(false), 3000)
    } catch (err) {
      setCorrectionError(err instanceof Error ? err.message : 'Failed to submit correction')
    } finally {
      setSubmittingCorrection(false)
    }
  }

  function removeFile(index: number) {
    setAttachedFiles(prev => prev.filter((_, i) => i !== index))
  }

  const inputDisabled = !isActive && objective.status !== 'review'

  const time = relativeTime(objective.updated_at)

  const isPage = chrome === 'page'
  const isDialog = chrome === 'dialog'
  const seedUrls = extractPreviewUrls(objective.pr_url, objective.last_session_summary, objective.description)
  useEffect(() => {
    if (designUrl || seedUrls.length === 0) return
    setDesignUrl(seedUrls[0])
  }, [designUrl, seedUrls])

  return (
    <>
      {/* Backdrop — scrim behind the half-screen layout (mobile bottom-sheet AND
          desktop right-drawer). Fullscreen covers the viewport edge-to-edge, so no
          scrim there. Tap to dismiss. Page chrome fills its parent (no overlay). */}
      {!isPage && (
        <div
          className={cn(
            'fixed inset-0 z-40 bg-surface-0/70 transition-opacity duration-200',
            isDialog ? 'block' : isFull ? 'hidden' : 'block',
          )}
          onClick={onClose}
          aria-hidden="true"
        />
      )}
      <div
        role="dialog"
        aria-modal={!isPage}
        className={cn(
          'flex flex-col bg-surface-1',
          isPage && 'relative h-full min-h-0 w-full',
          isDialog && (showDesign
            ? 'cc-pop-in fixed inset-x-3 top-[4vh] z-50 h-[min(920px,92vh)] min-h-0 overflow-hidden rounded-2xl border border-line shadow-float sm:inset-x-auto sm:left-1/2 sm:w-[min(1280px,calc(100vw-32px))] sm:-translate-x-1/2'
            : 'cc-pop-in fixed inset-x-3 top-[8vh] z-50 h-[min(840px,84vh)] min-h-0 overflow-hidden rounded-2xl border border-line shadow-float sm:inset-x-auto sm:left-1/2 sm:w-[min(920px,calc(100vw-48px))] sm:-translate-x-1/2'),
          !isPage && !isDialog && 'cc-drawer-in fixed inset-x-0 z-50 sm:inset-y-0 sm:left-auto sm:right-0 sm:h-auto sm:rounded-none sm:border-t-0 sm:border-l sm:border-line motion-safe:sm:transition-[width] motion-safe:sm:duration-300 motion-safe:sm:ease-out',
          !isPage && !isDialog && (isFull
            ? 'top-0 bottom-0 sm:w-screen'
            : 'bottom-0 top-auto h-[80vh] rounded-t-2xl border-t border-line sm:w-[min(820px,100vw)] sm:shadow-drawer'),
        )}
      >
      {/* Quiet meta-line header (§09). On mobile the action buttons reflow to
          a full-width row below the title (obj 700281) — only the window
          controls stay pinned top-right. Desktop keeps everything inline. */}
      <ViewerHeader
        objective={objective}
        isActive={isActive}
        connState={connState}
        time={time}
        hasActivity={hasActivity}
        skillsInvoked={skillsInvoked}
        subagentPersonas={subagentPersonas}
        subagentWorkers={subagentWorkers}
        agentLabel={agentLabel}
        showBrief={showBrief}
        setShowBrief={setShowBrief}
        showDesign={showDesign}
        setShowDesign={v => {
          setShowDesign(v)
          if (v) setShowBrief(false)
          onDesignModeChange?.(v)
        }}
        showCorrection={showCorrection}
        setShowCorrection={setShowCorrection}
        setCorrectionError={setCorrectionError}
        correctionSaved={correctionSaved}
        onChangeStatus={onChangeStatus}
        isFull={isFull}
        toggleSize={toggleSize}
        onClose={onClose}
        onOpenInNewTab={onOpenInNewTab}
        hideSizeToggle={isPage}
        onEdit={onEdit}
      />

      {/* ST5 — Flag mistake: human correction surface */}
      {showCorrection && (
        <CorrectionPanel
          correctionText={correctionText}
          setCorrectionText={setCorrectionText}
          correctionError={correctionError}
          setCorrectionError={setCorrectionError}
          setShowCorrection={setShowCorrection}
          submitCorrection={submitCorrection}
          submittingCorrection={submittingCorrection}
        />
      )}

      {/* Objective Brief — collapsible */}
      {showBrief && (
        <BriefPanel objective={objective} reviews={reviews} prs={prs} />
      )}

      {showDesign ? (
        <div className="cc-design-split min-h-0 flex-1">
          <div className="cc-design-split-canvas">
            <DesignCanvas
              url={designUrl}
              onUrl={setDesignUrl}
              seedUrls={seedUrls}
            />
          </div>
          <div className="cc-design-split-thread">
            <ThreadPane
              scrollRef={scrollRef}
              threadHasContent={threadHasContent}
              isActive={isActive}
              objectiveId={objective.id}
              status={objective.status}
              onStatus={handleStatus}
              onContentChange={handleContentChange}
              onConnState={handleConnState}
              pendingEcho={pendingEcho}
              onEchoLanded={handleEchoLanded}
            />
            <Composer
              attachedFiles={attachedFiles}
              removeFile={removeFile}
              sendError={sendError}
              setSendError={setSendError}
              fileInputRef={fileInputRef}
              handleUpload={handleUpload}
              uploading={uploading}
              message={message}
              setMessage={setMessage}
              messageRef={messageRef}
              handleSendMessage={() => { void handleSendMessage() }}
              inputDisabled={inputDisabled}
              isActive={isActive}
              handleStop={handleStop}
              interrupting={interrupting}
              sending={sending}
            />
          </div>
        </div>
      ) : (
        <>
          <ThreadPane
            scrollRef={scrollRef}
            threadHasContent={threadHasContent}
            isActive={isActive}
            objectiveId={objective.id}
            status={objective.status}
            onStatus={handleStatus}
            onContentChange={handleContentChange}
            onConnState={handleConnState}
            pendingEcho={pendingEcho}
            onEchoLanded={handleEchoLanded}
          />
          <Composer
            attachedFiles={attachedFiles}
            removeFile={removeFile}
            sendError={sendError}
            setSendError={setSendError}
            fileInputRef={fileInputRef}
            handleUpload={handleUpload}
            uploading={uploading}
            message={message}
            setMessage={setMessage}
            messageRef={messageRef}
            handleSendMessage={() => { void handleSendMessage() }}
            inputDisabled={inputDisabled}
            isActive={isActive}
            handleStop={handleStop}
            interrupting={interrupting}
            sending={sending}
          />
        </>
      )}

      {/* File editor overlay (lazy — BlockNote chunk loads on first edit) */}
      {editingDocPath && (
        <Suspense fallback={null}>
          <FileEditorOverlay filePath={editingDocPath} onClose={() => setEditingDocPath(null)} />
        </Suspense>
      )}
      </div>
    </>
  )
}
