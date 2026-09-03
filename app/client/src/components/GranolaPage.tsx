import { useState, useEffect, useCallback, useRef } from 'react'
import { useFileDrop } from '../hooks/useFileDrop'
import { useAuth } from '../context/AuthContext'
import { api, ApiError } from '../lib/api'
import { MarkdownEditor } from './MarkdownEditor'
import {
  PageContainer,
  PageHeader,
  Card,
  Button,
  Badge,
  Tabs,
  EmptyState,
  Skeleton,
  Alert,
  useConfirm,
  cn,
} from './ui'
import type { TabItem } from './ui'

// One-click copy with a transient "Copied!" confirmation. Copies the given text
// (the post body — not the frontmatter) so Mike can paste straight into LinkedIn.
function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        // Fallback for non-secure contexts where the async clipboard API is absent.
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }, [text])
  return (
    <Button size="sm" variant="secondary" onClick={copy} className={cn(copied && 'text-signal-verify')}>
      {copied ? 'Copied!' : label}
    </Button>
  )
}

// Browsers usually set file.type for video; fall back to extension when they don't. The
// backend only accepts the hook-videos bucket's allowlist (mp4 / mov / webm / m4v).
function inferVideoType(file: File): string {
  if (file.type) return file.type
  const ext = file.name.toLowerCase().split('.').pop()
  if (ext === 'mp4') return 'video/mp4'
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'm4v') return 'video/x-m4v'
  return 'video/mp4'
}

// Direct browser → Supabase upload via XHR (fetch can't report upload progress). The PUT goes
// to a one-path signed URL (token embedded), so no Supabase service key is ever in the client.
function uploadToSignedUrl(
  putUrl: string,
  file: File,
  contentType: string,
  onProgress: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', putUrl)
    xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`))
    xhr.onerror = () => reject(new Error('Upload network error'))
    xhr.send(file)
  })
}

interface SignResponse {
  ok: boolean
  objectPath: string
  putUrl: string
  publicUrl: string
  contentType: string
}

// One hook doc (one meeting) in the Short-form & Video tab: the talking-point hooks plus raw
// video uploads tied to a specific hook, each with an inline player + copyable shareable URL.
function HookCard({ hook, onUpdated }: { hook: HookDoc; onUpdated: (h: HookDoc) => void }) {
  const [hookIndex, setHookIndex] = useState<number>(hook.hooks.length ? 0 : -1)
  const [label, setLabel] = useState('')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const enc = encodeURIComponent(hook.file)
  const { confirm, confirmDialog } = useConfirm()

  const onFile = useCallback(
    async (file: File) => {
      setUploading(true)
      setError(null)
      setProgress(0)
      try {
        const contentType = inferVideoType(file)
        const sign = await api.post<SignResponse>(`/granola-content/hooks/${enc}/video/sign`, {
          filename: file.name,
          contentType,
          size: file.size,
        })
        await uploadToSignedUrl(sign.putUrl, file, sign.contentType || contentType, setProgress)
        const rec = await api.post<{ ok: boolean; hook: HookDoc }>(
          `/granola-content/hooks/${enc}/video`,
          { path: sign.objectPath, url: sign.publicUrl, hook_index: hookIndex, label, size: file.size },
        )
        onUpdated(rec.hook)
        setLabel('')
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Upload failed')
      } finally {
        setUploading(false)
        setProgress(0)
        if (fileRef.current) fileRef.current.value = ''
      }
    },
    [enc, hookIndex, label, onUpdated],
  )

  const { isDragging, dropProps } = useFileDrop((files) => {
    const f = files[0]
    if (f) void onFile(f)
  }, !uploading)

  const removeVideo = useCallback(
    async (v: VideoMeta) => {
      if (!(await confirm({
        title: 'Remove this video?',
        message: 'It will be deleted from storage.',
        confirmLabel: 'Remove',
        danger: true,
      }))) return
      try {
        const rec = await api.post<{ ok: boolean; hook: HookDoc }>(
          `/granola-content/hooks/${enc}/video/delete`,
          { path: v.path },
        )
        onUpdated(rec.hook)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Delete failed')
      }
    },
    [enc, onUpdated, confirm],
  )

  return (
    <Card className="min-w-0">
      {confirmDialog}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="font-display text-sm font-semibold text-fg-0">{hook.title}</h3>
        <span className="font-mono text-[10px] text-fg-3">{hook.date}</span>
        {hook.videos.length > 0 && (
          <Badge tone="accent" mono>
            {hook.videos.length} video{hook.videos.length > 1 ? 's' : ''}
          </Badge>
        )}
      </div>

      {/* Hook talking points (numbered — the numbers match the "for hook" dropdown) */}
      <ul className="space-y-1.5">
        {hook.hooks.map((h, idx) => (
          <li key={idx} className="flex gap-2 text-sm text-fg-1">
            <span className="select-none font-mono text-[10px] text-fg-3">{idx + 1}.</span>
            <span className="min-w-0">{h}</span>
          </li>
        ))}
      </ul>

      {/* Uploaded videos: inline player + copyable URL + which hook + remove */}
      {hook.videos.length > 0 && (
        <div className="mt-4 space-y-3 border-t border-line-soft pt-3">
          {hook.videos.map(v => (
            <div key={v.path} className="rounded-md border border-line-soft bg-surface-3 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-fg-2">
                <Badge tone="neutral" mono>
                  {v.hook_index >= 0 && hook.hooks[v.hook_index]
                    ? `Hook ${v.hook_index + 1}`
                    : 'Unassigned'}
                </Badge>
                {v.label && <span className="italic">“{v.label}”</span>}
                {v.size > 0 && <span className="font-mono text-fg-3">{formatBytes(v.size)}</span>}
                {v.uploaded_at && (
                  <span className="font-mono text-fg-3">{v.uploaded_at.replace('T', ' ').slice(0, 16)}</span>
                )}
              </div>
              <video controls preload="metadata" src={v.url} className="w-full max-w-lg rounded-md bg-surface-0" />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  readOnly
                  value={v.url}
                  onFocus={e => e.currentTarget.select()}
                  className="min-w-0 flex-1 rounded-md border border-line bg-surface-1 px-2 py-1 font-mono text-[11px] text-fg-2"
                />
                <CopyButton text={v.url} label="Copy URL" />
                <Button size="sm" variant="danger" onClick={() => removeVideo(v)}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Upload control — drop a video on this row or click Upload */}
      <div
        {...dropProps}
        className={`mt-4 flex flex-wrap items-end gap-2 border-t border-line-soft pt-3 ${
          isDragging ? 'rounded-md bg-accent/5 ring-1 ring-accent' : ''
        }`}
      >
        {hook.hooks.length > 0 && (
          <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-fg-3">
            For hook
            <select
              value={hookIndex}
              onChange={e => setHookIndex(Number(e.target.value))}
              className="rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-fg-1 outline-none focus:border-accent"
            >
              {hook.hooks.map((h, idx) => (
                <option key={idx} value={idx}>
                  {idx + 1}. {h.length > 48 ? `${h.slice(0, 48)}…` : h}
                </option>
              ))}
              <option value={-1}>Unassigned (whole doc)</option>
            </select>
          </label>
        )}
        <label className="flex flex-1 flex-col gap-1 font-mono text-[10px] uppercase tracking-wide text-fg-3">
          Label (optional)
          <input
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="e.g. take 2, vertical"
            className="min-w-0 rounded-md border border-line bg-surface-3 px-2 py-1.5 text-xs text-fg-1 outline-none focus:border-accent"
          />
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="video/mp4,video/quicktime,video/webm,video/x-m4v,.mp4,.mov,.webm,.m4v"
          className="hidden"
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
          }}
        />
        <Button
          size="sm"
          variant="primary"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? (progress > 0 ? `Uploading ${progress}%` : 'Uploading…') : isDragging ? 'Drop video here' : 'Upload video'}
        </Button>
      </div>
      {error && (
        <Alert tone="alarm" className="mt-2">
          {error}
        </Alert>
      )}
    </Card>
  )
}

// Admin-only surface for the Granola content engine (personal / holdco content).
// Backend: /api/granola-content/* (requireAuth + requireAdmin). Reads the second-brain
// markdown streams; drives the posting-queue status round-trip + the granola-intake
// session spawn ("Run now" / nightly).

const DRAFT_STATUSES = ['draft', 'ready', 'posted'] as const
type DraftStatus = (typeof DRAFT_STATUSES)[number]
const NEXT_STATUS: Record<DraftStatus, DraftStatus | null> = {
  draft: 'ready',
  ready: 'posted',
  posted: null,
}

interface Draft {
  file: string
  status: string
  type: string
  granola_id: string
  source_note: string
  pillar: string
  topic: string
  belief: string
  hook: string
  date: string
  created_at: string
  self_check: string
  body: string
}
interface VideoMeta {
  path: string
  url: string
  hook_index: number
  label: string
  uploaded_at: string
  size: number
}
interface HookDoc {
  file: string
  granola_id: string
  source_note: string
  date: string
  title: string
  hooks: string[]
  videos: VideoMeta[]
}
interface InboxItem {
  text: string
  date: string
  done: boolean
  granola_id: string
  source: string
}
interface ScheduleInfo {
  exists: boolean
  enabled: boolean
  cron_expr: string | null
  last_run_at: string | null
  workspace: string
}

type Tab = 'queue' | 'hooks' | 'inbox'

// Tab labels + a one-line descriptor so each stream's purpose is unmistakable. The three
// streams are deliberately distinct: written LinkedIn posts vs short-form/video talking points
// vs raw meeting capture.
const TAB_META: Record<Tab, { label: string; descriptor: string }> = {
  queue: {
    label: 'LinkedIn Drafts',
    descriptor: 'Full written posts in Mike’s voice — copy-paste ready for LinkedIn.',
  },
  hooks: {
    label: 'Short-form & Video',
    descriptor: 'Short-form video talking points + raw video uploads to hand to an AI clipper.',
  },
  inbox: {
    label: 'Ideas',
    descriptor: 'A flat, uncategorized list of ideas captured from your meetings. (Action items are now tracked as loops in /loops.)',
  },
}

function formatBytes(n: number): string {
  if (!n) return ''
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

// The stored draft body is the LinkedIn post followed by a `## Hook alternatives`
// reference section (CONTRACT §2b). For one-click paste-into-LinkedIn, copy only
// the post — strip everything from the Hook alternatives heading onward. (The
// inline editor still edits/saves the FULL body, so nothing is lost on disk.)
function postBodyForCopy(body: string): string {
  return body.replace(/\n#+\s*Hook alternatives[\s\S]*$/i, '').trimEnd()
}

// Map a draft status to a Badge tone so the status chip reads consistently with
// the rest of Mission Control (queued → posted progression).
const STATUS_TONE: Record<string, 'info' | 'amber' | 'verify' | 'neutral'> = {
  draft: 'info',
  ready: 'amber',
  posted: 'verify',
}

export function GranolaPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  const [tab, setTab] = useState<Tab>('queue')
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [hooks, setHooks] = useState<HookDoc[]>([])
  const [ideas, setIdeas] = useState<InboxItem[]>([])
  const [schedule, setSchedule] = useState<ScheduleInfo | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | DraftStatus>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  // When set, the expanded draft opens directly in edit mode (one-click Edit from the row).
  const [editFile, setEditFile] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runMsg, setRunMsg] = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [d, h, i, s] = await Promise.all([
        api.get<{ drafts: Draft[] }>('/granola-content/drafts?status=all'),
        api.get<{ hooks: HookDoc[] }>('/granola-content/hooks'),
        api.get<{ ideas: InboxItem[] }>('/granola-content/ideas'),
        api.get<ScheduleInfo>('/granola-content/schedule'),
      ])
      setDrafts(d.drafts)
      setHooks(h.hooks)
      setIdeas(i.ideas)
      setSchedule(s)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load content')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isAdmin) loadAll()
    else setLoading(false)
  }, [isAdmin, loadAll])

  const advanceStatus = useCallback(async (draft: Draft) => {
    const next = NEXT_STATUS[draft.status as DraftStatus]
    if (!next) return
    try {
      const res = await api.patch<{ draft: Draft }>(
        `/granola-content/drafts/${encodeURIComponent(draft.file)}/status`,
        { status: next },
      )
      setDrafts(prev => prev.map(d => (d.file === draft.file ? res.draft : d)))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update status')
    }
  }, [])

  // Persist an edited post body. The backend rewrites only the body region,
  // preserving frontmatter byte-for-byte, and returns the re-parsed draft.
  const saveDraftBody = useCallback(async (draft: Draft, newBody: string) => {
    const res = await api.patch<{ draft: Draft }>(
      `/granola-content/drafts/${encodeURIComponent(draft.file)}/body`,
      { body: newBody },
    )
    setDrafts(prev => prev.map(d => (d.file === draft.file ? res.draft : d)))
    setEditFile(null)
  }, [])

  // One-click Edit from a draft row: expand the card AND drop straight into edit mode.
  const editDraft = useCallback((draft: Draft) => {
    setExpanded(draft.file)
    setEditFile(draft.file)
  }, [])

  // Replace a single hook doc in state after a video is added/removed.
  const updateHook = useCallback((hook: HookDoc) => {
    setHooks(prev => prev.map(h => (h.file === hook.file ? hook : h)))
  }, [])

  const runNow = useCallback(async () => {
    setRunning(true)
    setRunMsg(null)
    setError(null)
    try {
      const res = await api.post<{ ok: boolean; objective_id?: number; reason?: string }>(
        '/granola-content/run',
      )
      setRunMsg(
        res.ok
          ? `Intake session spawned${res.objective_id ? ` (objective #${res.objective_id})` : ''}. New content appears here once it finishes.`
          : `Could not start: ${res.reason || 'unknown'}`,
      )
      // Refresh schedule so last_run_at updates.
      api.get<ScheduleInfo>('/granola-content/schedule').then(setSchedule).catch(() => {})
    } catch (e) {
      const msg = e instanceof ApiError && e.status === 409 ? 'A run is already queued/active.' : e instanceof Error ? e.message : 'Run failed'
      setError(msg)
    } finally {
      setRunning(false)
    }
  }, [])

  if (!isAdmin) {
    return (
      <PageContainer>
        <EmptyState
          title="Access denied"
          description="This surface is admin-only."
        />
      </PageContainer>
    )
  }

  const filteredDrafts = statusFilter === 'all' ? drafts : drafts.filter(d => d.status === statusFilter)
  const counts = {
    all: drafts.length,
    draft: drafts.filter(d => d.status === 'draft').length,
    ready: drafts.filter(d => d.status === 'ready').length,
    posted: drafts.filter(d => d.status === 'posted').length,
  }

  const tabItems: TabItem[] = [
    { key: 'queue', label: TAB_META.queue.label, count: counts.all },
    { key: 'hooks', label: TAB_META.hooks.label, count: hooks.length },
    { key: 'inbox', label: TAB_META.inbox.label, count: ideas.length },
  ]

  return (
    <PageContainer>
      <PageHeader
        title="Content"
        description="personal content streams — LinkedIn drafts, short-form & video, ideas."
        actions={
          <>
            {schedule && (
              <span className="mr-1 hidden text-right font-mono text-[11px] text-fg-3 sm:block">
                Nightly{' '}
                <span className={schedule.enabled ? 'text-signal-verify' : 'text-fg-3'}>
                  {schedule.exists ? (schedule.enabled ? `on · ${schedule.cron_expr} UTC` : 'off') : 'not set'}
                </span>
                {schedule.last_run_at && (
                  <span className="block text-fg-3">last {schedule.last_run_at.replace('T', ' ').slice(0, 16)}</span>
                )}
              </span>
            )}
            <Button variant="secondary" size="sm" onClick={loadAll}>
              Refresh
            </Button>
            <Button variant="primary" size="sm" onClick={runNow} disabled={running}>
              {running ? 'Starting…' : 'Run now'}
            </Button>
          </>
        }
      />

      {runMsg && (
        <Alert tone="info" className="mb-3">
          {runMsg}
        </Alert>
      )}
      {error && (
        <Alert tone="alarm" className="mb-3">
          {error}
        </Alert>
      )}

      {/* Tabs */}
      <Tabs items={tabItems} value={tab} onChange={k => setTab(k as Tab)} className="mb-2" />
      {/* One-line descriptor for the active stream */}
      <p className="mb-4 text-[13px] leading-relaxed text-fg-2">{TAB_META[tab].descriptor}</p>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Skeleton className="h-4 w-14" />
                <Skeleton className="h-4 w-20" />
              </div>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-full" />
            </Card>
          ))}
        </div>
      ) : tab === 'queue' ? (
        <>
          {/* Status filter */}
          <div className="mb-4 flex flex-wrap gap-2">
            {(['all', 'draft', 'ready', 'posted'] as const).map(f => (
              <Button
                key={f}
                size="sm"
                variant={statusFilter === f ? 'primary' : 'secondary'}
                onClick={() => setStatusFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)} ({counts[f]})
              </Button>
            ))}
          </div>

          {filteredDrafts.length === 0 ? (
            <EmptyState
              title="No drafts in this view"
              description="Adjust the status filter, or run an intake session to generate new drafts."
            />
          ) : (
            <ul className="space-y-3">
              {filteredDrafts.map(d => {
                const next = NEXT_STATUS[d.status as DraftStatus]
                const isOpen = expanded === d.file
                return (
                  <li key={d.file}>
                    <Card className="min-w-0">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 flex-1">
                          <div className="mb-1.5 flex flex-wrap items-center gap-2">
                            <Badge tone={STATUS_TONE[d.status] || 'neutral'}>{d.status}</Badge>
                            {d.pillar && <Badge tone="neutral">{d.pillar}</Badge>}
                            {d.type === 'linkedin-carousel' && <Badge tone="accent">Carousel</Badge>}
                            <span className="font-mono text-[10px] text-fg-3">{d.date}</span>
                          </div>
                          <h3 className="break-words font-display text-sm font-semibold text-fg-0">
                            {d.topic || d.file}
                          </h3>
                          <p className="mt-1 line-clamp-2 text-xs text-fg-2">{d.hook}</p>
                        </div>
                        <div className="flex flex-wrap gap-2 sm:w-auto sm:flex-shrink-0 sm:flex-col">
                          {next && (
                            <Button size="sm" variant="primary" onClick={() => advanceStatus(d)}>
                              Mark {next}
                            </Button>
                          )}
                          <CopyButton text={postBodyForCopy(d.body)} />
                          <Button size="sm" variant="secondary" onClick={() => editDraft(d)}>
                            Edit
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setEditFile(null)
                              setExpanded(isOpen ? null : d.file)
                            }}
                          >
                            {isOpen ? 'Hide' : 'Read'}
                          </Button>
                        </div>
                      </div>
                      {isOpen && (
                        <div className="mt-3 border-t border-line-soft pt-3">
                          {d.belief && (
                            <p className="mb-2 text-xs italic text-fg-2">
                              <span className="not-italic text-fg-3">Belief: </span>
                              {d.belief}
                            </p>
                          )}
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="font-mono text-[10px] uppercase tracking-wide text-fg-3">Post body</span>
                            <CopyButton text={postBodyForCopy(d.body)} label="Copy post" />
                          </div>
                          <MarkdownEditor
                            // Remount when entering/leaving one-click edit so `startEditing` re-applies.
                            key={editFile === d.file ? 'edit' : 'read'}
                            value={d.body}
                            startEditing={editFile === d.file}
                            onSave={next => saveDraftBody(d, next)}
                          />
                          {d.self_check && (
                            <p className="mt-3 font-mono text-[10px] text-fg-3">self-check: {d.self_check}</p>
                          )}
                        </div>
                      )}
                    </Card>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ) : tab === 'hooks' ? (
        hooks.length === 0 ? (
          <EmptyState
            title="No hooks yet"
            description="Short-form talking points appear here after an intake session runs."
          />
        ) : (
          <ul className="space-y-3">
            {hooks.map(h => (
              <li key={h.file}>
                <HookCard hook={h} onUpdated={updateHook} />
              </li>
            ))}
          </ul>
        )
      ) : (
        // inbox tab — ideas only (flat, uncategorized list)
        ideas.length === 0 ? (
          <EmptyState
            title="No ideas captured"
            description="Ideas surfaced from your meetings will collect here."
          />
        ) : (
          <ul className="space-y-2">
            {ideas.map((it, idx) => (
              <li key={idx}>
                <Card className="flex flex-wrap items-baseline gap-2 py-3">
                  <span className="min-w-0 flex-1 text-sm text-fg-1">{it.text}</span>
                  {it.date && <span className="font-mono text-[10px] text-fg-3">{it.date}</span>}
                </Card>
              </li>
            ))}
          </ul>
        )
      )}
    </PageContainer>
  )
}
