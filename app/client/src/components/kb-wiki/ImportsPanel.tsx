import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { ChevronDown, ChevronUp, MessagesSquare, Pause, Play, Sparkles, Upload, X } from 'lucide-react'
import {
  IMPORT_ACCEPT, JOB_KIND_LABEL, importProgress, shortDate,
  type ImportJobStatus, type ImportJobSummary,
} from '../../lib/kbWiki'
import { Alert, Badge, Button, EmptyState, Skeleton, cn, useConfirm } from '../ui'
import { ImportChooser } from './ImportChooser'
import { wikiApi, wsQuery } from './wikiApi'

const JOB_STATUS: Record<ImportJobStatus, { label: string; tone: 'neutral' | 'info' | 'verify' | 'alarm' | 'amber' }> = {
  review: { label: 'Choose what to import', tone: 'amber' },
  running: { label: 'Importing', tone: 'info' },
  paused: { label: 'Paused', tone: 'neutral' },
  done: { label: 'Done', tone: 'verify' },
  failed: { label: 'Needs attention', tone: 'alarm' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
}

/* ImportsPanel (obj 720117) — bring Claude / ChatGPT chat exports and call
   transcripts into the wiki. Upload → choose which chats → background import
   with progress, pause, resume and cancel. Polls every 3s while working. */
export function ImportsPanel({
  workspace,
  onOpenNote,
  onChanged,
}: {
  workspace: string
  onOpenNote: (rel: string) => void
  /** Called when imported pages may have changed (so the wiki list can refresh). */
  onChanged: () => void
}) {
  const [jobs, setJobs] = useState<ImportJobSummary[] | null>(null)
  const [working, setWorking] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [openJob, setOpenJob] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const lastDone = useRef<number | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const load = useCallback(async () => {
    if (!workspace) return
    try {
      const b = await wikiApi<{ imports: ImportJobSummary[]; working: boolean }>(`/imports?${wsQuery(workspace)}`)
      setJobs(b.imports)
      setWorking(b.working)
      setLoadError(null)
      const done = b.imports.reduce((n, j) => n + j.counts.done, 0)
      if (lastDone.current !== null && done !== lastDone.current) onChanged()
      lastDone.current = done
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [workspace, onChanged])

  useEffect(() => { setJobs(null); lastDone.current = null; void load() }, [load])

  const active = working || (jobs ?? []).some(j => j.status === 'running')
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => { void load() }, 3000)
    return () => clearInterval(t)
  }, [active, load])

  const afterCreate = async (created: ImportJobSummary[]) => {
    await load()
    if (created[0]) setOpenJob(created[0].id)
  }

  const upload = async (list: FileList | File[]) => {
    const arr = Array.from(list)
    if (!arr.length) return
    setUploading(true)
    setUploadError(null)
    try {
      const fd = new FormData()
      for (const f of arr) fd.append('files', f)
      const b = await wikiApi<{ jobs: ImportJobSummary[] }>(`/imports?${wsQuery(workspace)}`, { method: 'POST', body: fd })
      await afterCreate(b.jobs ?? [])
    } catch (e) {
      setUploadError((e as Error).message)
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const trySamples = async () => {
    setUploading(true)
    setUploadError(null)
    try {
      const b = await wikiApi<{ jobs: ImportJobSummary[] }>(`/imports/samples?${wsQuery(workspace)}`, { method: 'POST' })
      await afterCreate(b.jobs ?? [])
    } catch (e) {
      setUploadError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const act = async (job: ImportJobSummary, action: 'start' | 'pause' | 'cancel') => {
    if (action === 'cancel' && !(await confirm({
      title: 'Stop this import?',
      message: 'Chats already imported stay in the wiki, and your original file is kept. The rest will not be read.',
      confirmLabel: 'Stop import',
      cancelLabel: 'Keep going',
      danger: true,
    }))) return
    setBusy(`${job.id}:${action}`)
    setActionError(null)
    try {
      await wikiApi(`/imports/${encodeURIComponent(job.id)}/${action}?${wsQuery(workspace)}`, { method: 'POST', json: { workspace } })
      await load()
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files)
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-center transition-colors duration-base',
          dragOver ? 'border-accent bg-[var(--accent-tint)]' : 'border-line bg-surface-1',
        )}
      >
        <Upload className="h-5 w-5 text-fg-2" aria-hidden="true" />
        <div className="max-w-[56ch] text-[13px] text-fg-1">
          Drop a Claude or ChatGPT export (.zip) or call transcripts here, or
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept={IMPORT_ACCEPT}
          className="sr-only"
          id="kb-wiki-import-upload"
          onChange={e => { if (e.target.files) void upload(e.target.files) }}
        />
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" loading={uploading} onClick={() => fileInput.current?.click()} disabled={!workspace}>
            Choose files
          </Button>
          <Button variant="secondary" onClick={() => { void trySamples() }} disabled={!workspace || uploading} leftIcon={<Sparkles className="h-4 w-4" aria-hidden="true" />}>
            Try with sample data
          </Button>
        </div>
        <div className="max-w-[60ch] text-[11.5px] leading-relaxed text-fg-3">
          Chat exports (.zip from Claude or ChatGPT “Export data”) · call transcripts (.vtt, .srt, .txt, .docx, .json, .md) ·
          you choose which chats get read · your original files are kept untouched on this server
        </div>
      </div>

      {uploadError && <Alert tone="alarm" title="Couldn't import that">{uploadError}</Alert>}
      {loadError && <Alert tone="alarm" title="Couldn't load your imports">{loadError}</Alert>}
      {actionError && <Alert tone="alarm" title="Something went wrong">{actionError}</Alert>}

      {!jobs && !loadError && (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      )}

      {jobs && jobs.length === 0 && (
        <EmptyState
          compact
          icon={<MessagesSquare className="h-5 w-5" aria-hidden="true" />}
          title="No chats or calls imported yet"
          description="Your past AI chats and meeting transcripts hold decisions, people and to-dos. Import them and they become wiki pages with links back to the exact message."
        />
      )}

      {jobs && jobs.length > 0 && (
        <ul className="flex flex-col divide-y divide-line-soft">
          {jobs.map(job => {
            const st = JOB_STATUS[job.status]
            const p = importProgress(job.counts)
            const open = openJob === job.id
            const isBusy = (a: string) => busy === `${job.id}:${a}`
            return (
              <li key={job.id} className="flex flex-col gap-2.5 py-3">
                <div className="flex items-start gap-2.5">
                  <MessagesSquare className="mt-0.5 h-4 w-4 shrink-0 text-fg-2" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-fg-0" title={job.label}>{job.label}</div>
                    <div className="text-[11.5px] text-fg-3">
                      {JOB_KIND_LABEL[job.kind]} · {job.counts.total} {job.kind === 'transcripts' ? 'call' : 'chat'}{job.counts.total === 1 ? '' : 's'} · added {shortDate(job.created_at)}
                    </div>
                  </div>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </div>

                {job.status !== 'review' && p.of > 0 && (
                  <div className="flex flex-col gap-1 pl-6">
                    <div
                      className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={p.of}
                      aria-valuenow={p.finished}
                      aria-label={`${p.finished} of ${p.of} processed`}
                    >
                      <div
                        className={cn('h-full rounded-full transition-[width] duration-slow ease-out', job.status === 'failed' ? 'bg-signal-alarm' : job.status === 'done' ? 'bg-signal-verify' : 'bg-accent')}
                        style={{ width: `${p.pct}%` }}
                      />
                    </div>
                    <div className="text-[12px] text-fg-2">
                      {p.finished} of {p.of} processed
                      {job.counts.done > 0 && ` · ${job.counts.done} imported`}
                      {job.counts.skipped > 0 && ` · ${job.counts.skipped} skipped as small talk`}
                      {job.counts.failed > 0 && <span className="text-signal-alarm"> · {job.counts.failed} failed</span>}
                    </div>
                  </div>
                )}

                {job.status === 'failed' && job.error && <p className="pl-6 text-[12.5px] text-signal-alarm">{job.error}</p>}

                <div className="flex flex-wrap gap-1.5 pl-6">
                  {job.status === 'running' && (
                    <Button size="sm" variant="secondary" className="min-h-[44px] sm:min-h-[32px]" loading={isBusy('pause')} onClick={() => { void act(job, 'pause') }}
                      leftIcon={<Pause className="h-3.5 w-3.5" aria-hidden="true" />}>
                      Pause
                    </Button>
                  )}
                  {(job.status === 'paused' || job.status === 'failed') && (
                    <Button size="sm" variant="secondary" className="min-h-[44px] sm:min-h-[32px]" loading={isBusy('start')} onClick={() => { void act(job, 'start') }}
                      leftIcon={<Play className="h-3.5 w-3.5" aria-hidden="true" />}>
                      {job.status === 'failed' ? 'Try again' : 'Resume'}
                    </Button>
                  )}
                  {job.status !== 'cancelled' && (
                    <Button size="sm" variant="ghost" className="min-h-[44px] sm:min-h-[32px]" onClick={() => setOpenJob(open ? null : job.id)}
                      leftIcon={open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
                      aria-expanded={open}>
                      {open ? 'Hide list' : job.status === 'review' ? 'Choose chats' : 'See chats'}
                    </Button>
                  )}
                  {(job.status === 'review' || job.status === 'running' || job.status === 'paused') && (
                    <Button size="sm" variant="danger" className="min-h-[44px] sm:min-h-[32px]" loading={isBusy('cancel')} onClick={() => { void act(job, 'cancel') }}
                      leftIcon={<X className="h-3.5 w-3.5" aria-hidden="true" />}>
                      Cancel
                    </Button>
                  )}
                </div>

                {open && (
                  <ImportChooser workspace={workspace} job={job} onJobChanged={() => { void load() }} onOpenNote={onOpenNote} />
                )}
              </li>
            )
          })}
        </ul>
      )}
      {confirmDialog}
    </div>
  )
}
