// Knowledge Base Setup (obj 900556) — served at /knowledge/setup.
// One page, three states: upload files → watch the run → read the summary.
// Server: app/server/src/routes/kb-setup.ts. The data source is injectable
// (`fixture` / `api`) so the harness and tests render it without a server.
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import {
  CheckCircle2, Circle, Copy, Equal, FileUp, FolderUp, HelpCircle, Loader2, MinusCircle, Pause, Play, ShieldAlert,
  Sparkles, UploadCloud, XCircle,
} from 'lucide-react'
import {
  Alert, Badge, Button, Card, CardBody, CardHeader, CopyButton, PageContainer, PageHeader, Skeleton, SkeletonText, cn,
} from '../ui'
import { useWorkspaces } from '../../hooks/useWorkspaces'
import { useNavigate } from '../../context/nav'
import {
  SECTIONS, createKbSetupApi, filesFromDataTransfer, formatBytes, formatUsd, isConflict, pickedFromInput,
  processedCount, sectionLabel, uploadInBatches,
  type ItemStatus, type KbSetupApi, type OpenQuestion, type PageChange, type PickedFile, type Run, type RunItem,
  type SetupStatus,
} from '../../lib/kbSetup'
import { fixtureApi, type KbSetupFixture } from './KbSetupPage.fixture'

const POLL_MS = 2000

type View = 'loading' | 'upload' | 'progress' | 'summary'

export interface KbSetupPageProps {
  workspace: string
  /** Render from fixture data instead of the server (harness). */
  fixture?: KbSetupFixture
  /** Inject a data source directly (tests). Wins over `fixture`. */
  api?: KbSetupApi
  /** Polling interval while a run is going (tests shorten it). */
  pollMs?: number
}

export function KbSetupPage({ workspace, fixture, api, pollMs }: KbSetupPageProps) {
  const injected = useMemo(() => api ?? (fixture ? fixtureApi(fixture) : null), [api, fixture])
  if (injected) return <KbSetupView workspace={workspace} kb={injected} pollMs={pollMs} />
  return <ServerKbSetup workspace={workspace} pollMs={pollMs} />
}

/** Live page: the setup is per workspace, so "All" falls back to a picker. */
function ServerKbSetup({ workspace, pollMs }: { workspace: string; pollMs?: number }) {
  const { slugs, labelOf, loading } = useWorkspaces()
  const [picked, setPicked] = useState('')
  const fixed = workspace && workspace !== 'all' ? workspace : ''
  const ws = fixed || picked || slugs[0] || ''
  const kb = useMemo(() => (ws ? createKbSetupApi(ws) : null), [ws])

  if (!kb) {
    return (
      <PageContainer>
        <Intro />
        {loading ? <Skeleton className="h-40 w-full" /> : <Alert tone="amber" title="No workspace">You need access to a workspace to set up its knowledge base.</Alert>}
      </PageContainer>
    )
  }
  const picker = !fixed && slugs.length > 1 ? (
    <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
      Workspace
      <select
        value={ws}
        onChange={e => setPicked(e.target.value)}
        className="h-8 rounded-md border border-line bg-surface-1 px-2 text-[12.5px] text-fg-0"
      >
        {slugs.map(s => <option key={s} value={s}>{labelOf(s)}</option>)}
      </select>
    </label>
  ) : null
  return <KbSetupView key={ws} workspace={ws} kb={kb} pollMs={pollMs} picker={picker} />
}

function Intro({ actions }: { actions?: ReactNode }) {
  return (
    <PageHeader
      title="Set up your knowledge base"
      breadcrumbs={[{ label: 'Knowledge base', href: '/knowledge' }, { label: 'Setup' }]}
      description="Drop in your existing documents, spreadsheets, decks and notes. The setup agent reads each one and files what it finds into people, companies, projects, decisions, processes, products and a glossary."
      actions={actions}
    />
  )
}

export function KbSetupView({
  workspace, kb, pollMs = POLL_MS, picker,
}: { workspace: string; kb: KbSetupApi; pollMs?: number; picker?: ReactNode }) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [view, setView] = useState<View>('loading')
  const [runId, setRunId] = useState<string | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [questions, setQuestions] = useState<OpenQuestion[] | null>(null)
  /** "Set up more files" wins over showing the last finished run. */
  const wantUpload = useRef(false)

  const loadStatus = useCallback(async () => {
    try {
      const s = await kb.status()
      setStatus(s)
      setError(null)
      if (s.active) { setRunId(s.active.id); setView('progress') }
      else if (s.last && !wantUpload.current) { setRunId(s.last.id); setView('summary') }
      else setView('upload')
      return s
    } catch (e) {
      setError((e as Error).message)
      setView(v => (v === 'loading' ? 'upload' : v))
      return null
    }
  }, [kb])

  const loadQuestions = useCallback(async () => {
    try { setQuestions((await kb.questions()).questions) } catch { setQuestions([]) }
  }, [kb])

  useEffect(() => { void loadStatus() }, [loadStatus])

  // Fetch the run being shown.
  useEffect(() => {
    if (!runId || view === 'upload' || view === 'loading') return
    let live = true
    kb.getRun(runId).then(r => { if (live) setRun(r) }).catch(e => { if (live) setError((e as Error).message) })
    return () => { live = false }
  }, [kb, runId, view])

  // Poll while it runs; when it finishes, move to the summary.
  const running = view === 'progress' && run?.id === runId && run?.status === 'running'
  useEffect(() => {
    if (!running || !runId) return
    const t = setInterval(() => {
      kb.getRun(runId).then(r => {
        setRun(r)
        if (r.status === 'done') { wantUpload.current = false; void loadStatus() }
      }).catch(() => { /* keep the last good view; the next tick retries */ })
    }, pollMs)
    return () => clearInterval(t)
  }, [running, runId, kb, pollMs, loadStatus])

  useEffect(() => { if (view === 'summary') void loadQuestions() }, [view, loadQuestions])

  const onStarted = (r: Run) => { setRun(r); setRunId(r.id); setView('progress'); wantUpload.current = false }
  const showRun = (id: string) => { setRun(null); setRunId(id); setView('progress') }
  const setUpMore = () => { wantUpload.current = true; setRun(null); setView('upload'); void loadStatus() }

  const shown = run && run.id === runId ? run : null

  return (
    <PageContainer>
      <Intro actions={<>
        {picker}
        {view === 'summary' && (
          <Button variant="primary" onClick={setUpMore} leftIcon={<UploadCloud className="h-4 w-4" aria-hidden="true" />}>
            Set up more files
          </Button>
        )}
      </>} />
      {error && <Alert tone="alarm" title="Something went wrong" className="mb-4">{error}</Alert>}

      {view === 'loading' && (
        <div className="space-y-3" aria-label="Loading"><Skeleton className="h-48 w-full" /><SkeletonText lines={3} /></div>
      )}
      {view === 'upload' && (
        <UploadState kb={kb} status={status} onReload={loadStatus} onStarted={onStarted} onActive={showRun} />
      )}
      {view === 'progress' && (
        shown ? <ProgressState kb={kb} run={shown} onChange={setRun} onBack={setUpMore} />
          : <Skeleton className="h-64 w-full" />
      )}
      {view === 'summary' && (
        shown ? <SummaryState run={shown} questions={questions} kb={kb} onAnswered={loadQuestions} />
          : <Skeleton className="h-64 w-full" />
      )}
      <p className="sr-only">Workspace {workspace}</p>
    </PageContainer>
  )
}

// ── Upload ───────────────────────────────────────────────────────────────────

const READ_KINDS = ['Docs and PDFs', 'Word (.docx)', 'Excel and CSV', 'Slides (.pptx)', 'Notes (.txt, .md)', 'Transcripts (.vtt, .srt)', 'Web pages (.html)', 'JSON exports']
const SKIP_KINDS = ['Images', 'Audio and video', 'Zip files', 'Credential files (.env, keys)']

function UploadState({
  kb, status, onReload, onStarted, onActive,
}: {
  kb: KbSetupApi
  status: SetupStatus | null
  onReload: () => Promise<SetupStatus | null>
  onStarted: (r: Run) => void
  onActive: (id: string) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null)
  const [busy, setBusy] = useState<'upload' | 'sample' | 'start' | null>(null)
  const [msg, setMsg] = useState<{ tone: 'verify' | 'amber' | 'alarm'; title: string; body?: ReactNode } | null>(null)
  const filesInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  // React has no typed prop for these; set them on the element.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '')
    folderInput.current?.setAttribute('directory', '')
  }, [])

  const send = async (files: PickedFile[]) => {
    if (!files.length) return
    setBusy('upload')
    setMsg(null)
    try {
      const r = await uploadInBatches(kb, files, (sent, total) => setProgress({ sent, total }))
      setMsg({
        tone: r.skipped.length ? 'amber' : 'verify',
        title: `Added ${r.saved.length} ${r.saved.length === 1 ? 'file' : 'files'}`,
        body: r.skipped.length ? (
          <ul className="mt-1 space-y-0.5">
            {r.skipped.map(s => <li key={s.path}><span className="font-mono text-[12px]">{s.path}</span> — {s.reason}</li>)}
          </ul>
        ) : undefined,
      })
      await onReload()
    } catch (e) {
      setMsg({ tone: 'alarm', title: 'Upload stopped', body: (e as Error).message })
      await onReload()
    } finally {
      setBusy(null)
      setProgress(null)
      if (filesInput.current) filesInput.current.value = ''
      if (folderInput.current) folderInput.current.value = ''
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    // Entries must be read synchronously inside the handler.
    const pending = filesFromDataTransfer(e.dataTransfer)
    void pending.then(send).catch(err => setMsg({ tone: 'alarm', title: 'Could not read the dropped folder', body: (err as Error).message }))
  }

  const addSamples = async () => {
    setBusy('sample')
    setMsg(null)
    try {
      const r = await kb.sample()
      setMsg({ tone: 'verify', title: `Added ${r.saved.length} sample files`, body: 'They are from a made-up design studio. Press Start setup to see what the agent does with them.' })
      await onReload()
    } catch (e) {
      setMsg({ tone: 'alarm', title: 'Could not add the sample files', body: (e as Error).message })
    } finally { setBusy(null) }
  }

  const start = async () => {
    setBusy('start')
    setMsg(null)
    try {
      onStarted(await kb.startRun())
    } catch (e) {
      if (isConflict(e)) {
        const s = await onReload()
        if (s?.active) { onActive(s.active.id); return }
      }
      setMsg({ tone: 'alarm', title: 'Could not start setup', body: (e as Error).message })
    } finally { setBusy(null) }
  }

  const waiting = Number(status?.intake.files ?? 0)
  const pct = progress && progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-4">
        <div
          data-testid="kb-dropzone"
          onDragOver={e => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            'flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-4 py-10 text-center transition-colors sm:py-14',
            dragOver ? 'border-accent bg-[var(--accent-tint)]' : 'border-line-strong bg-surface-1',
          )}
        >
          <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-3 text-fg-1">
            <UploadCloud className="h-6 w-6" aria-hidden="true" />
          </div>
          <div>
            <p className="font-display text-[16px] font-semibold text-fg-0">Drop files or whole folders here</p>
            <p className="mt-1 text-[13px] text-fg-2">Folders keep their structure. Up to 50 MB per file.</p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => filesInput.current?.click()} disabled={!!busy} leftIcon={<FileUp className="h-4 w-4" aria-hidden="true" />}>
              Choose files
            </Button>
            <Button onClick={() => folderInput.current?.click()} disabled={!!busy} leftIcon={<FolderUp className="h-4 w-4" aria-hidden="true" />}>
              Choose folder
            </Button>
          </div>
          <input ref={filesInput} type="file" multiple hidden aria-label="Choose files"
            onChange={e => { if (e.target.files) void send(pickedFromInput(e.target.files)) }} />
          <input ref={folderInput} type="file" multiple hidden aria-label="Choose folder"
            onChange={e => { if (e.target.files) void send(pickedFromInput(e.target.files)) }} />
        </div>

        {progress && (
          <div aria-label="Upload progress">
            <div className="mb-1 flex justify-between text-[12.5px] text-fg-2">
              <span>Uploading…</span>
              <span className="font-mono">{progress.sent} / {progress.total} files</span>
            </div>
            <ProgressBar pct={pct} />
          </div>
        )}
        {msg && <Alert tone={msg.tone} title={msg.title}>{msg.body}</Alert>}

        <Card>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[12px] font-mono uppercase tracking-[0.12em] text-fg-3">Waiting to be read</p>
              {status ? (
                <p className="mt-0.5 font-display text-[20px] font-semibold text-fg-0" data-testid="intake-count">
                  {waiting} {waiting === 1 ? 'file' : 'files'}
                  <span className="ml-2 text-[13px] font-normal text-fg-2">{formatBytes(Number(status.intake.bytes))}</span>
                </p>
              ) : <Skeleton className="mt-1 h-6 w-32" />}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" onClick={addSamples} loading={busy === 'sample'} disabled={!!busy && busy !== 'sample'}
                leftIcon={<Sparkles className="h-4 w-4" aria-hidden="true" />}>
                Try with sample files
              </Button>
              <Button variant="primary" onClick={start} loading={busy === 'start'} disabled={waiting === 0 || (!!busy && busy !== 'start')}>
                Start setup
              </Button>
            </div>
          </div>
          {status?.intake.folder && (
            <div className="mt-3 border-t border-line-soft pt-3">
              <div className="flex min-w-0 items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-sm bg-surface-1 px-2 py-1 font-mono text-[12px] text-fg-1" title={status.intake.folder}>
                  {status.intake.folder}
                </code>
                <CopyButton value={status.intake.folder} label="Copy path" />
              </div>
              <p className="mt-1 text-[12px] text-fg-3">or copy files into this folder on the server</p>
            </div>
          )}
        </Card>
      </div>

      <Card inset className="h-fit">
        <CardHeader title="What gets read" />
        <CardBody className="space-y-4 text-[13px]">
          <ul className="space-y-1.5">
            {READ_KINDS.map(k => (
              <li key={k} className="flex items-center gap-2 text-fg-1">
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-signal-verify" aria-hidden="true" />{k}
              </li>
            ))}
          </ul>
          <div>
            <p className="mb-1.5 text-[12px] font-mono uppercase tracking-[0.12em] text-fg-3">Skipped</p>
            <ul className="space-y-1.5">
              {SKIP_KINDS.map(k => (
                <li key={k} className="flex items-center gap-2 text-fg-2">
                  <MinusCircle className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />{k}
                </li>
              ))}
            </ul>
          </div>
          <p className="flex gap-2 rounded-md bg-surface-1 p-2.5 text-[12.5px] text-fg-2">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-amber" aria-hidden="true" />
            Passwords and API keys found inside files are removed before anything is read, and flagged so you can change them.
          </p>
        </CardBody>
      </Card>
    </div>
  )
}

// ── Progress ─────────────────────────────────────────────────────────────────

function ProgressBar({ pct, tone = 'accent' }: { pct: number; tone?: 'accent' | 'amber' }) {
  const v = Math.max(0, Math.min(100, pct))
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full transition-[width] duration-300', tone === 'amber' ? 'bg-signal-amber' : 'bg-accent')} style={{ width: `${v}%` }} />
    </div>
  )
}

const ITEM_META: Record<ItemStatus, { label: string; tone: 'neutral' | 'info' | 'verify' | 'amber' | 'alarm'; icon: ReactNode }> = {
  pending: { label: 'Waiting', tone: 'neutral', icon: <Circle className="h-4 w-4 text-fg-3" aria-hidden="true" /> },
  working: { label: 'Reading', tone: 'info', icon: <Loader2 className="cc-spin h-4 w-4 text-status-working" aria-hidden="true" /> },
  done: { label: 'Filed', tone: 'verify', icon: <CheckCircle2 className="h-4 w-4 text-signal-verify" aria-hidden="true" /> },
  unchanged: { label: 'Unchanged', tone: 'neutral', icon: <Equal className="h-4 w-4 text-fg-2" aria-hidden="true" /> },
  duplicate: { label: 'Duplicate', tone: 'neutral', icon: <Copy className="h-4 w-4 text-fg-2" aria-hidden="true" /> },
  skipped: { label: 'Skipped', tone: 'amber', icon: <MinusCircle className="h-4 w-4 text-signal-amber" aria-hidden="true" /> },
  failed: { label: 'Failed', tone: 'alarm', icon: <XCircle className="h-4 w-4 text-signal-alarm" aria-hidden="true" /> },
}

function ProgressState({
  kb, run, onChange, onBack,
}: { kb: KbSetupApi; run: Run; onChange: (r: Run) => void; onBack: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const total = Number(run.counts.total) || run.items.length
  const finished = processedCount(run.counts)
  const pct = total > 0 ? Math.round((finished / total) * 100) : 0
  const ceiling = run.ceiling
  const noCeiling = !ceiling || ceiling.source === 'none' || ceiling.cost_usd == null


  const act = async (fn: () => Promise<Run>) => {
    setBusy(true); setErr(null)
    try { onChange(await fn()) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const chips: Array<[ItemStatus, number]> = (['done', 'working', 'pending', 'unchanged', 'duplicate', 'skipped', 'failed'] as ItemStatus[])
    .map(s => [s, Number(run.counts[s] ?? 0)] as [ItemStatus, number])
    .filter(([, n]) => n > 0)

  return (
    <div className="space-y-4">
      <Card inset>
        <CardHeader
          eyebrow={run.status === 'paused' ? 'Paused' : run.status === 'failed' ? 'Stopped' : 'Working'}
          title="Reading your files"
          actions={run.status === 'running' ? (
            <Button size="sm" onClick={() => act(() => kb.pause(run.id))} loading={busy} leftIcon={<Pause className="h-3.5 w-3.5" aria-hidden="true" />}>Pause</Button>
          ) : run.status === 'paused' && run.pause_reason !== 'ceiling' ? (
            <Button size="sm" variant="primary" onClick={() => act(() => kb.resume(run.id))} loading={busy} leftIcon={<Play className="h-3.5 w-3.5" aria-hidden="true" />}>Resume</Button>
          ) : run.status === 'failed' ? (
            <Button size="sm" onClick={onBack}>Back to upload</Button>
          ) : undefined}
        />
        <CardBody className="space-y-4">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="font-display text-[22px] font-semibold text-fg-0" data-testid="run-progress">
                {finished} <span className="text-[14px] font-normal text-fg-2">of {total} files</span>
              </span>
              <span className="font-mono text-[12.5px] text-fg-2">{pct}%</span>
            </div>
            <ProgressBar pct={pct} tone={run.status === 'paused' ? 'amber' : 'accent'} />
            {run.current && run.status === 'running' && (
              <p className="mt-2 truncate text-[12.5px] text-fg-2">
                Reading <span className="font-mono text-fg-1">{run.current}</span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5" aria-label="File counts">
            {chips.map(([s, n]) => (
              <Badge key={s} tone={ITEM_META[s].tone}>{ITEM_META[s].label} {n}</Badge>
            ))}
          </div>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-surface-1 px-3 py-2 text-[13px]">
            <span className="text-fg-2">Estimated cost</span>
            <span className="font-mono font-medium text-fg-0">{formatUsd(run.est_cost_usd)}</span>
            {noCeiling ? (
              <span className="text-fg-3">· No budget ceiling set</span>
            ) : (
              <span className="text-fg-3">
                of {formatUsd(ceiling.cost_usd)} ceiling
                <span className="ml-1">({ceiling.source === 'global' ? 'install-wide' : 'this workspace'})</span>
              </span>
            )}
          </div>
          {run.status === 'paused' && run.pause_reason === 'ceiling' && (
            <Alert tone="amber" title="Paused at the budget ceiling">
              <p>This run has used its estimated budget. Nothing is lost — files already read stay filed. Continue if you want it to finish the remaining {total - finished} files.</p>
              <Button className="mt-2" size="sm" variant="primary" loading={busy} onClick={() => act(() => kb.resume(run.id, true))}>
                Continue past budget
              </Button>
            </Alert>
          )}
          {run.status === 'paused' && run.pause_reason === 'ai-unavailable' && (
            <Alert tone="amber" title="Paused — the AI is not reachable">Try Resume in a few minutes.</Alert>
          )}
          {run.status === 'failed' && <Alert tone="alarm" title="The run stopped">{run.error ?? 'Something went wrong.'}</Alert>}
          {err && <Alert tone="alarm" title="That did not work">{err}</Alert>}
        </CardBody>
      </Card>

      <Card inset>
        <CardHeader title="Files" eyebrow={`${run.items.length} in this run`} />
        <ul className="max-h-[420px] divide-y divide-line-soft overflow-y-auto" aria-label="Files in this run">
          {run.items.map(it => <FileRow key={it.path} item={it} />)}
        </ul>
      </Card>
    </div>
  )
}

function FileRow({ item }: { item: RunItem }) {
  const m = ITEM_META[item.status]
  const note = item.status === 'skipped' ? item.skip_reason
    : item.status === 'failed' ? item.error
    : item.status === 'duplicate' && item.duplicate_of ? `Same as ${item.duplicate_of}`
    : item.status === 'done' && item.pages?.length ? `${item.pages.length} ${item.pages.length === 1 ? 'page' : 'pages'}`
    : undefined
  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <span className="shrink-0" title={m.label}>{m.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[12.5px] text-fg-0" title={item.path}>{item.path}</p>
        {note && <p className="truncate text-[12px] text-fg-3">{note}</p>}
      </div>
      {!!item.secrets?.length && <Badge tone="amber"><ShieldAlert className="h-3 w-3" aria-hidden="true" />Secret removed</Badge>}
      <span className="hidden shrink-0 text-[12px] text-fg-3 sm:inline">{formatBytes(item.bytes)}</span>
    </li>
  )
}

// ── Summary ──────────────────────────────────────────────────────────────────

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'alarm' | 'amber' }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
      <p className="text-[12px] text-fg-2">{label}</p>
      <p className={cn('font-display text-[24px] font-semibold leading-tight',
        tone === 'alarm' && value > 0 ? 'text-signal-alarm' : tone === 'amber' && value > 0 ? 'text-signal-amber' : 'text-fg-0')}>
        {value}
      </p>
    </div>
  )
}

function PageList({ title, pages }: { title: string; pages: PageChange[] }) {
  const navigate = useNavigate()
  return (
    <Card inset>
      <CardHeader title={title} eyebrow={`${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`} />
      {pages.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-fg-3">None this time.</p>
      ) : (
        <ul className="max-h-[360px] divide-y divide-line-soft overflow-y-auto">
          {pages.map(p => (
            <li key={p.rel} className="flex items-center gap-2 px-4 py-2">
              <div className="min-w-0 flex-1">
                <a
                  href="/knowledge"
                  onClick={e => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); navigate('/knowledge') } }}
                  className="block truncate text-[13px] font-medium text-fg-0 hover:text-accent-hover"
                >
                  {p.title}
                </a>
                <p className="truncate font-mono text-[12px] text-fg-3">{p.rel}</p>
              </div>
              <Badge>{sectionLabel(p.section)}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function SummaryState({
  run, questions, kb, onAnswered,
}: { run: Run; questions: OpenQuestion[] | null; kb: KbSetupApi; onAnswered: () => Promise<void> }) {
  const s = run.summary
  const created = s?.created ?? []
  const updated = s?.updated ?? []
  const c = run.counts
  const troubles = run.items.filter(i => i.status === 'skipped' || i.status === 'failed')
  const secrets = s?.secrets ?? []

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Run totals">
        <Stat label="Files read" value={Number(c.done)} />
        <Stat label="Pages created" value={created.length} />
        <Stat label="Pages updated" value={updated.length} />
        <Stat label="Unchanged or duplicate" value={Number(c.unchanged) + Number(c.duplicate)} />
        <Stat label="Skipped" value={Number(c.skipped)} tone="amber" />
        <Stat label="Failed" value={Number(c.failed)} tone="alarm" />
      </div>

      {secrets.length > 0 && (
        <Alert
          tone="alarm"
          title={`Secrets removed from ${secrets.length} ${secrets.length === 1 ? 'file' : 'files'}`}
          // The kit's border-signal-alarm/30 tint is not generated (var() colors take no alpha), so mix it here.
          className="border-[color:color-mix(in_srgb,var(--ok-alarm)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--ok-alarm)_8%,transparent)]"
        >
          <p>These were taken out before the files were read and are not in your knowledge base. Change them where they are used — they were sitting in plain files.</p>
          <ul className="mt-1.5 space-y-1" data-testid="secrets-list">
            {secrets.map(x => (
              <li key={x.path}>
                <span className="font-mono text-[12px] text-fg-1">{x.path}</span>
                <span className="text-fg-3"> — </span>
                {x.findings.map(f => `${f.kind} on line ${f.line}`).join(', ')}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Card inset>
        <CardHeader title="Where things went" eyebrow={run.finished_at ? `Finished ${new Date(run.finished_at).toLocaleString()}` : undefined} />
        <div className="grid grid-cols-2 gap-px bg-line-soft sm:grid-cols-4" data-testid="section-grid">
          {SECTIONS.map(sec => {
            const v = s?.by_section?.[sec.key] ?? { created: 0, updated: 0 }
            const any = Number(v.created) + Number(v.updated) > 0
            return (
              <div key={sec.key} className="bg-surface-2 px-4 py-3" data-section={sec.key}>
                <p className={cn('text-[13px] font-medium', any ? 'text-fg-0' : 'text-fg-3')}>{sec.label}</p>
                <p className="mt-1 text-[12.5px] text-fg-2">
                  <span className={cn('font-mono', Number(v.created) > 0 && 'text-signal-verify')}>{Number(v.created)} new</span>
                  <span className="text-fg-3"> · </span>
                  <span className="font-mono">{Number(v.updated)} updated</span>
                </p>
              </div>
            )
          })}
        </div>
      </Card>

      <QuestionsPanel questions={questions} kb={kb} onAnswered={onAnswered} />

      <div className="grid gap-4 lg:grid-cols-2">
        <PageList title="Pages created" pages={created} />
        <PageList title="Pages updated" pages={updated} />
      </div>

      {troubles.length > 0 && (
        <Card inset>
          <CardHeader title="Skipped or failed" eyebrow={`${troubles.length} ${troubles.length === 1 ? 'file' : 'files'}`} />
          <ul className="divide-y divide-line-soft">{troubles.map(it => <FileRow key={it.path} item={it} />)}</ul>
        </Card>
      )}
    </div>
  )
}

const KIND_LABEL: Record<OpenQuestion['kind'], string> = {
  ambiguous: 'Who is this?', conflict: 'Files disagree', missing: 'Missing detail', secret: 'Secret found',
}

function QuestionsPanel({ questions, kb, onAnswered }: { questions: OpenQuestion[] | null; kb: KbSetupApi; onAnswered: () => Promise<void> }) {
  const open = (questions ?? []).filter(q => q.status === 'open')
  return (
    <Card inset>
      <CardHeader
        title="Open questions"
        eyebrow={questions ? `${open.length} to answer` : 'Loading'}
        actions={<HelpCircle className="h-4 w-4 text-fg-3" aria-hidden="true" />}
      />
      <CardBody className="space-y-3">
        <p className="text-[12.5px] text-fg-2">The agent was not sure about these. Your answers go into the knowledge base. They are also in your decision queue.</p>
        {questions === null ? <SkeletonText lines={3} /> : open.length === 0 ? (
          <p className="text-[13px] text-fg-3">Nothing to answer right now.</p>
        ) : open.map(q => <QuestionRow key={q.id} q={q} kb={kb} onAnswered={onAnswered} />)}
      </CardBody>
    </Card>
  )
}

function QuestionRow({ q, kb, onAnswered }: { q: OpenQuestion; kb: KbSetupApi; onAnswered: () => Promise<void> }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'save' | 'dismiss' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const send = async (body: { answer: string } | { dismiss: true }, which: 'save' | 'dismiss') => {
    setBusy(which); setErr(null)
    try { await kb.answer(q.id, body); await onAnswered() } catch (e) { setErr((e as Error).message) } finally { setBusy(null) }
  }
  const id = `kbq-${q.id}`
  return (
    <div className="rounded-md border border-line bg-surface-1 p-3" data-testid="open-question">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <Badge tone={q.kind === 'conflict' ? 'amber' : q.kind === 'secret' ? 'alarm' : 'info'}>{KIND_LABEL[q.kind] ?? q.kind}</Badge>
        {q.files.slice(0, 2).map(f => <span key={f} className="truncate font-mono text-[12px] text-fg-3">{f}</span>)}
      </div>
      <label htmlFor={id} className="block text-[13.5px] leading-snug text-fg-0">{q.ask}</label>
      <textarea
        id={id}
        value={text}
        onChange={e => setText(e.target.value)}
        rows={2}
        placeholder="Your answer"
        className="mt-2 w-full resize-y rounded-md border border-line bg-surface-0 px-2.5 py-1.5 text-[13px] text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="primary" disabled={!text.trim() || !!busy} loading={busy === 'save'}
          onClick={() => send({ answer: text.trim() }, 'save')}>Save answer</Button>
        <Button size="sm" variant="ghost" disabled={!!busy} loading={busy === 'dismiss'}
          onClick={() => send({ dismiss: true }, 'dismiss')}>Dismiss</Button>
      </div>
      {err && <p className="mt-1.5 text-[12px] text-signal-alarm">{err}</p>}
    </div>
  )
}
