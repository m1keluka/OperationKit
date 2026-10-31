import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type MouseEvent } from 'react'
import { ArrowLeft, FileSpreadsheet, FileText, FileType2, MessageSquareText, RotateCcw, Sparkles, Upload, X } from 'lucide-react'
import { renderMarkdown } from '../lib/markdown'
import { useWorkspaces } from '../hooks/useWorkspaces'
import {
  Alert, Badge, Button, Card, CardBody, CardHeader, EmptyState, IconButton, Modal, Skeleton, SkeletonText, cn,
} from './ui'
import { SaveAnswerButton } from './kb-wiki/SaveAnswerButton'
import { WikiSection } from './kb-wiki/WikiSection'
import { PageGraph } from './kb-wiki/PageGraph'
import { wikilinksToLinks, type WikiPageSummary } from '../lib/kbWiki'

/* Import files — the Knowledge base page's file import (starter pack
   `knowledge-import`, obj 719936). Upload messy files, watch the librarian
   file them into notes, then ask questions across all of them. Opened from
   DocsPage; server: app/server/src/routes/kb-ingest.ts. */

type FileStatus = 'queued' | 'reading' | 'organizing' | 'done' | 'failed'

interface ImportFile {
  id: string
  file_name: string
  stored: string
  kind: string
  status: FileStatus
  uploaded_at: string
  finished_at?: string
  notes?: string[]
  source_note?: string
  warnings?: string[]
  error?: string
}

interface ImportStatus {
  pack_enabled: boolean
  working?: boolean
  files?: ImportFile[]
  supported?: string[]
  max_upload_mb?: number
  samples?: Array<{ name: string; bytes: number }>
}

interface AskResult {
  question?: string
  answer: string
  sources: Array<{ rel: string; title: string }>
}

const STATUS_LABEL: Record<FileStatus, { label: string; tone: 'neutral' | 'info' | 'verify' | 'alarm' | 'amber' }> = {
  queued: { label: 'Waiting', tone: 'neutral' },
  reading: { label: 'Reading', tone: 'info' },
  organizing: { label: 'Filing notes', tone: 'info' },
  done: { label: 'Done', tone: 'verify' },
  failed: { label: 'Needs attention', tone: 'alarm' },
}

const EXAMPLE_QUESTIONS = [
  'What do we charge for a deep clean, and is that price changing?',
  'What is our cancellation policy? Do the files agree?',
  'What are the steps for onboarding a new client, and who owns each one?',
]

function FileIcon({ kind }: { kind: string }) {
  const cls = 'h-4 w-4 shrink-0 text-fg-2'
  if (kind === 'spreadsheet' || kind === 'csv') return <FileSpreadsheet className={cls} aria-hidden="true" />
  if (kind === 'pdf') return <FileType2 className={cls} aria-hidden="true" />
  return <FileText className={cls} aria-hidden="true" />
}

function noteLabel(rel: string): string {
  const [folder, file] = rel.split('/')
  const name = (file ?? folder).replace(/\.md$/, '').replace(/-/g, ' ')
  return `${name}`
}

function folderOf(rel: string): string {
  return rel.split('/')[0]
}

/** Resolve a relative link inside a note against the note's own path. */
export function resolveRel(fromNote: string, href: string): string {
  const parts = fromNote.split('/').slice(0, -1)
  for (const seg of href.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg && seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '')
}

/** Turn the answer's [[path]] citations into links the viewer can open. */
export function citationsToLinks(answer: string, sources: AskResult['sources']): string {
  const titles = new Map(sources.map(s => [s.rel, s.title]))
  return answer.replace(/\[\[([^\]]+)\]\]/g, (_m, rel: string) => `[${titles.get(rel) ?? noteLabel(rel)}](${rel})`)
}

/** Is file import switched on for this install? (Drives the Knowledge base page's Import button.) */
export function useKnowledgeImportEnabled(): boolean {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let live = true
    fetch('/api/kb-ingest/enabled', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : { pack_enabled: false }))
      .then(b => { if (live) setOn(b.pack_enabled === true) })
      .catch(() => { if (live) setOn(false) })
    return () => { live = false }
  }, [])
  return on
}

export function KnowledgeImportPanel({ workspace, onClose }: { workspace: string; onClose: () => void }) {
  const { slugs, labelOf } = useWorkspaces()
  const [ws, setWs] = useState<string>('')
  const [status, setStatus] = useState<ImportStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [question, setQuestion] = useState('')
  const [asking, setAsking] = useState(false)
  const [answer, setAnswer] = useState<AskResult | null>(null)
  const [askError, setAskError] = useState<string | null>(null)
  const [openNote, setOpenNote] = useState<{ path: string; content: string } | null>(null)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [wikiPages, setWikiPages] = useState<WikiPageSummary[]>([])
  const [wikiKey, setWikiKey] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)

  // Board selection wins when it names one workspace; otherwise the first one this user has.
  useEffect(() => {
    if (workspace && workspace !== 'all') setWs(workspace)
    else if (!ws && slugs.length) setWs(slugs[0])
  }, [workspace, slugs, ws])

  const q = `workspace=${encodeURIComponent(ws)}`

  const load = useCallback(async () => {
    if (!ws) return
    try {
      const r = await fetch(`/api/kb-ingest/status?${q}`, { credentials: 'include' })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
      setStatus(body)
      setLoadError(null)
    } catch (e) {
      setLoadError((e as Error).message)
    }
  }, [ws, q])

  useEffect(() => { setStatus(null); void load() }, [load])

  const files = useMemo(() => status?.files ?? [], [status])
  const busy = files.some(f => f.status === 'queued' || f.status === 'reading' || f.status === 'organizing')

  // Poll while anything is in flight.
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => { void load() }, 3000)
    return () => clearInterval(t)
  }, [busy, load])

  const upload = async (list: FileList | File[]) => {
    const arr = Array.from(list)
    if (!arr.length) return
    setUploading(true)
    setUploadError(null)
    try {
      const fd = new FormData()
      for (const f of arr) fd.append('files', f)
      const r = await fetch(`/api/kb-ingest/upload?${q}`, { method: 'POST', credentials: 'include', body: fd })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error ?? `Upload failed (HTTP ${r.status})`)
      await load()
    } catch (e) {
      setUploadError((e as Error).message)
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const addSamples = async () => {
    setUploading(true)
    setUploadError(null)
    try {
      const r = await fetch(`/api/kb-ingest/samples?${q}`, { method: 'POST', credentials: 'include' })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
      await load()
    } catch (e) {
      setUploadError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const retry = async (id: string) => {
    await fetch(`/api/kb-ingest/files/${encodeURIComponent(id)}/retry?${q}`, { method: 'POST', credentials: 'include' })
    await load()
  }

  const ask = async (e?: FormEvent, text?: string) => {
    e?.preventDefault()
    const qText = (text ?? question).trim()
    if (!qText) return
    if (text) setQuestion(text)
    setAsking(true)
    setAskError(null)
    setAnswer(null)
    try {
      const r = await fetch('/api/kb-ingest/ask', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace: ws, question: qText }),
      })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
      setAnswer({ ...body, question: qText })
    } catch (err) {
      setAskError((err as Error).message)
    } finally {
      setAsking(false)
    }
  }

  const viewNote = async (rel: string) => {
    setNoteError(null)
    try {
      const r = await fetch(`/api/kb-ingest/note?${q}&path=${encodeURIComponent(rel)}`, { credentials: 'include' })
      const body = await r.json()
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
      setOpenNote(body)
    } catch (e) {
      setNoteError((e as Error).message)
    }
  }

  /** Links inside rendered notes/answers: open notes in the viewer, download originals. */
  const onProseClick = (from: string) => (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href')
    if (!a || !href || /^[a-z]+:/i.test(href)) return
    e.preventDefault()
    const rel = from ? resolveRel(from, href) : href
    if (rel.startsWith('sources/files/')) {
      window.open(`/api/kb-ingest/original?${q}&path=${encodeURIComponent(rel)}`, '_blank', 'noopener')
    } else if (rel.endsWith('.md')) {
      void viewNote(rel)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files)
  }

  const noteCount = useMemo(() => new Set(files.flatMap(f => f.notes ?? [])).size, [files])
  // Imported chats and calls make wiki pages without an imported file, so either one makes Ask usable.
  const hasKnowledge = noteCount > 0 || wikiPages.length > 0

  const wsPicker = slugs.length > 1 && workspace === 'all' ? (
    <label className="flex items-center gap-2 text-[12.5px] text-fg-2">
      Workspace
      <select
        value={ws}
        onChange={e => setWs(e.target.value)}
        className="min-h-[44px] rounded-md border border-line bg-surface-1 px-2 text-[13px] text-fg-0 transition-colors duration-fast hover:border-line-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[36px]"
      >
        {slugs.map(s => <option key={s} value={s}>{labelOf(s)}</option>)}
      </select>
    </label>
  ) : null

  return (
    <div className="flex-1 overflow-y-auto bg-surface-0">
      <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-2xl">
            <h1 className="text-[20px] font-semibold tracking-tight text-fg-0">Import files</h1>
            <p className="mt-1 text-[13.5px] leading-relaxed text-fg-2">
              Add spreadsheets, PDFs, Word documents and meeting transcripts. The librarian reads each one on this server and files it into knowledge-base notes — one per organization, person, project, product and topic — with links back to the original.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {wsPicker}
            <Button variant="ghost" onClick={onClose} leftIcon={<ArrowLeft className="h-4 w-4" aria-hidden="true" />}>
              Back to notes
            </Button>
          </div>
        </div>

        {status && !status.pack_enabled && (
          <EmptyState
            title="File import is switched off"
            description="An admin can switch it on with the starter pack “knowledge-import”. See the pack's README for the one-line command."
          />
        )}

        {loadError && <Alert tone="alarm" title="Couldn't load your imported files" className="mb-4">{loadError}</Alert>}

        {status?.pack_enabled !== false && <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* ── Ask ── */}
          <Card className="self-start">
            <CardHeader eyebrow="Ask" title="Ask about your files" />
            <CardBody>
              <form onSubmit={e => { void ask(e) }} className="flex flex-col gap-3">
                <label htmlFor="import-question" className="sr-only">Question</label>
                <textarea
                  id="import-question"
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void ask() }}
                  rows={3}
                  maxLength={2000}
                  placeholder="e.g. What did we decide about pricing at the last team meeting?"
                  className="w-full resize-y rounded-md border border-line bg-surface-1 px-3 py-2.5 text-[14px] leading-relaxed text-fg-0 placeholder:text-fg-3 transition-colors duration-fast hover:border-line-strong focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[12px] text-fg-3">Answers use only your uploaded files, with links to where each fact came from.</span>
                  <Button type="submit" variant="primary" loading={asking} disabled={!question.trim() || !hasKnowledge} leftIcon={<MessageSquareText className="h-4 w-4" aria-hidden="true" />}>
                    Ask
                  </Button>
                </div>
              </form>

              {!hasKnowledge && !asking && (
                <p className="mt-4 text-[13px] text-fg-2">Upload a file first — questions work once the librarian has filed some notes.</p>
              )}

              {hasKnowledge && !answer && !asking && !askError && (
                <div className="mt-4 flex flex-col gap-2">
                  <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-fg-3">Try</span>
                  {EXAMPLE_QUESTIONS.map(t => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => { void ask(undefined, t) }}
                      className="min-h-[44px] rounded-md border border-line-soft bg-surface-1 px-3 py-2 text-left text-[13px] text-fg-1 transition-all duration-fast hover:-translate-y-px hover:border-line-strong hover:bg-surface-2 hover:text-fg-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      {t}
                    </button>
                  ))}
                </div>
              )}

              {asking && (
                <div className="mt-5" aria-live="polite" aria-busy="true">
                  <span className="sr-only">Reading your notes…</span>
                  <SkeletonText lines={5} />
                </div>
              )}
              {askError && <Alert tone="alarm" title="Couldn't answer that" className="mt-4">{askError}</Alert>}
              {answer && (
                <div className="mt-5 border-t border-line-soft pt-4" aria-live="polite">
                  <div
                    className="cc-prose break-words text-[14px]"
                    onClick={onProseClick('')}
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(citationsToLinks(answer.answer, answer.sources)) }}
                  />
                  {answer.sources.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {answer.sources.map(s => (
                        <button
                          key={s.rel}
                          type="button"
                          onClick={() => { void viewNote(s.rel) }}
                          className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-line bg-surface-1 px-3 text-[12.5px] text-fg-1 transition-all duration-fast hover:border-line-strong hover:bg-surface-2 hover:text-fg-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[32px]"
                        >
                          <span className="font-mono text-[10.5px] uppercase text-fg-3">{folderOf(s.rel)}</span>
                          {s.title}
                        </button>
                      ))}
                    </div>
                  )}
                  <SaveAnswerButton workspace={ws} question={answer.question ?? question} answer={answer.answer} sources={answer.sources} onOpen={rel => { void viewNote(rel) }} onSaved={() => setWikiKey(k => k + 1)} />
                </div>
              )}
            </CardBody>
          </Card>

          {/* ── Files ── */}
          <Card className="self-start">
            <CardHeader
              eyebrow="Files"
              title={status ? `${files.length} file${files.length === 1 ? '' : 's'} · ${noteCount} note${noteCount === 1 ? '' : 's'}` : 'Files'}
              actions={busy ? <Badge tone="info">Working…</Badge> : undefined}
            />
            <CardBody className="flex flex-col gap-4">
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
                <div className="text-[13px] text-fg-1">Drop files here, or</div>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  accept={(status?.supported ?? []).join(',')}
                  className="sr-only"
                  id="import-upload"
                  onChange={e => { if (e.target.files) void upload(e.target.files) }}
                />
                <Button variant="primary" loading={uploading} onClick={() => fileInput.current?.click()} disabled={!ws}>
                  Choose files
                </Button>
                <div className="text-[11.5px] text-fg-3">
                  Excel, CSV, PDF, Word, transcripts (.txt, .vtt) · up to {status?.max_upload_mb ?? 50} MB each · files stay on this server
                </div>
              </div>

              {uploadError && <Alert tone="alarm" title="Upload failed">{uploadError}</Alert>}

              {!status && !loadError && (
                <div className="flex flex-col gap-2" aria-busy="true">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              )}

              {status && files.length === 0 && (
                <EmptyState
                  compact
                  icon={<Sparkles className="h-5 w-5" aria-hidden="true" />}
                  title="No files yet"
                  description={status.samples?.length ? 'Upload your own, or load the demo set from a made-up cleaning company: a messy price-list spreadsheet, a policy PDF, a meeting transcript and a Word how-to.' : 'Upload a file to get started.'}
                  action={status.samples?.length ? (
                    <Button onClick={() => { void addSamples() }} loading={uploading}>Add the {status.samples.length} sample files</Button>
                  ) : undefined}
                />
              )}

              {files.length > 0 && (
                <ul className="flex flex-col divide-y divide-line-soft">
                  {files.map(f => (
                    <li key={f.id} className="flex flex-col gap-2 py-3">
                      <div className="flex items-start gap-2.5">
                        <FileIcon kind={f.kind} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13.5px] font-medium text-fg-0" title={f.file_name}>{f.file_name}</div>
                          <div className="text-[11.5px] text-fg-3">{new Date(f.uploaded_at).toLocaleString()}</div>
                        </div>
                        <Badge tone={STATUS_LABEL[f.status].tone}>{STATUS_LABEL[f.status].label}</Badge>
                      </div>
                      {f.status === 'failed' && f.error && (
                        <div className="flex items-start justify-between gap-2 pl-6">
                          <p className="text-[12.5px] text-signal-alarm">{f.error}</p>
                          {f.kind !== 'unsupported' && (
                            <Button size="sm" variant="ghost" leftIcon={<RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => { void retry(f.id) }}>
                              Try again
                            </Button>
                          )}
                        </div>
                      )}
                      {f.status === 'done' && (
                        <div className="flex flex-wrap gap-1.5 pl-6">
                          {f.source_note && (
                            <button
                              type="button"
                              onClick={() => { void viewNote(f.source_note!) }}
                              className="min-h-[44px] rounded-md border border-line bg-surface-1 px-2.5 text-[12px] text-fg-1 transition-all duration-fast hover:border-line-strong hover:bg-surface-2 hover:text-fg-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[28px]"
                            >
                              Readable copy
                            </button>
                          )}
                          {(f.notes ?? []).map(n => (
                            <button
                              key={n}
                              type="button"
                              onClick={() => { void viewNote(n) }}
                              className="inline-flex min-h-[44px] items-center gap-1 rounded-md border border-line-soft bg-surface-2 px-2.5 text-[12px] capitalize text-fg-1 transition-all duration-fast hover:border-line-strong hover:bg-surface-3 hover:text-fg-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[28px]"
                            >
                              <span className="font-mono text-[10px] uppercase text-fg-3">{folderOf(n)}</span>
                              {noteLabel(n)}
                            </button>
                          ))}
                        </div>
                      )}
                      {f.status === 'done' && (f.warnings ?? []).length > 0 && (
                        <p className="pl-6 text-[12px] text-signal-amber">{f.warnings!.join(' ')}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>}

        {ws && status?.pack_enabled !== false && <WikiSection workspace={ws} onOpenNote={rel => { void viewNote(rel) }} onPages={setWikiPages} refreshKey={wikiKey + files.filter(f => f.status === 'done').length} />}

        {noteError && <Alert tone="alarm" title="Couldn't open that note" className="mt-4">{noteError}</Alert>}

        <Modal open={!!openNote} onClose={() => setOpenNote(null)} labelledBy="import-note-title" panelClassName="max-w-3xl w-full">
          {openNote && (
            <div className="flex max-h-[85vh] flex-col">
              <div className="flex items-center justify-between gap-3 border-b border-line-soft px-5 py-3">
                <div id="import-note-title" className="min-w-0 truncate font-mono text-[12px] text-fg-2">{openNote.path}</div>
                <IconButton label="Close" onClick={() => setOpenNote(null)}><X className="h-4 w-4" aria-hidden="true" /></IconButton>
              </div>
              <div className="overflow-y-auto">
                <div
                  className="cc-prose break-words px-5 py-4 text-[14px]"
                  onClick={onProseClick(openNote.path)}
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(wikilinksToLinks(stripFrontmatter(openNote.content), openNote.path, wikiPages)) }}
                />
                {ws && status?.pack_enabled !== false && <PageGraph workspace={ws} rel={openNote.path} onOpenNote={rel => { void viewNote(rel) }} />}
              </div>
            </div>
          )}
        </Modal>
      </div>
    </div>
  )
}
