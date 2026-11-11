// Knowledge Base Setup — client types + API wrappers (obj 900556).
// Mirrors app/server/src/services/kb-setup/{runs,questions,taxonomy}.ts and
// app/server/src/routes/kb-setup.ts. Every route takes ?workspace=<slug>.
import { api } from './api'

// ── Types (mirrored from the server) ────────────────────────────────────────

export type SectionKey = 'people' | 'companies' | 'projects' | 'decisions' | 'processes' | 'products' | 'glossary' | 'topics'

export const SECTIONS: ReadonlyArray<{ key: SectionKey; label: string }> = [
  { key: 'people', label: 'People' },
  { key: 'companies', label: 'Companies & clients' },
  { key: 'projects', label: 'Projects' },
  { key: 'decisions', label: 'Decisions' },
  { key: 'processes', label: 'Processes & SOPs' },
  { key: 'products', label: 'Products & services' },
  { key: 'glossary', label: 'Glossary' },
  { key: 'topics', label: 'Other topics' },
]

export function sectionLabel(key: SectionKey | string): string {
  return SECTIONS.find(s => s.key === key)?.label ?? String(key)
}

export type RunStatus = 'running' | 'paused' | 'done' | 'failed'
export type ItemStatus = 'pending' | 'working' | 'done' | 'unchanged' | 'duplicate' | 'skipped' | 'failed'

export interface PageChange { rel: string; title: string; section: SectionKey; created: boolean }
export interface SecretFinding { kind: string; line: number }

export interface RunItem {
  path: string
  bytes: number
  status: ItemStatus
  sha256?: string
  category?: string
  title?: string
  source_note?: string
  original?: string
  pages?: PageChange[]
  duplicate_of?: string
  secrets?: SecretFinding[]
  questions?: string[]
  warnings?: string[]
  error?: string
  skip_reason?: string
  finished_at?: string
}

export interface RunCeiling {
  cost_usd: number | null
  wallclock_ms: number | null
  /** `workspace:<slug>`, `global`, or `none`. */
  source: string
}

export interface RunSummary {
  created: PageChange[]
  updated: PageChange[]
  by_section: Record<SectionKey, { created: number; updated: number }>
  secrets: Array<{ path: string; findings: SecretFinding[] }>
  questions_open: number
}

export interface Run {
  id: string
  workspace: string
  status: RunStatus
  pause_reason?: 'user' | 'ceiling' | 'ai-unavailable'
  error?: string
  created_at: string
  created_by?: string
  started_at?: string
  finished_at?: string
  current?: string
  items: RunItem[]
  counts: Record<ItemStatus, number> & { total: number }
  est_cost_usd: number
  elapsed_ms: number
  ceiling: RunCeiling
  ignore_ceiling?: boolean
  summary?: RunSummary
  anchor_card?: number
}

export type RunListing = Omit<Run, 'items'>

export interface SetupStatus {
  workspace: string
  intake: { files: number; bytes: number; folder: string }
  active: RunListing | null
  last: RunListing | null
  runs: RunListing[]
  pages: Record<SectionKey, number>
  questions_open: number
  step_done: boolean
}

export type QuestionKind = 'ambiguous' | 'conflict' | 'missing' | 'secret'

export interface OpenQuestion {
  id: string
  kind: QuestionKind
  ask: string
  about: Array<{ type: string; name: string }>
  files: string[]
  status: 'open' | 'answered' | 'dismissed'
  answer?: string
  answered_at?: string
  answered_by?: string
  review_item_id?: number
}

export interface UploadResult { saved: string[]; skipped: Array<{ path: string; reason: string }> }

/** A file plus the relative path it was dropped/picked with. */
export interface PickedFile { file: File; path: string }

// ── API ──────────────────────────────────────────────────────────────────────

/** Everything the page needs from the server. Injectable so a harness/test can fake it. */
export interface KbSetupApi {
  status(): Promise<SetupStatus>
  upload(batch: PickedFile[]): Promise<UploadResult>
  sample(): Promise<{ saved: string[] }>
  startRun(): Promise<Run>
  getRun(id: string): Promise<Run>
  pause(id: string): Promise<Run>
  resume(id: string, ignoreCeiling?: boolean): Promise<Run>
  questions(): Promise<{ questions: OpenQuestion[] }>
  answer(qid: string, body: { answer: string } | { dismiss: true }): Promise<OpenQuestion>
}

/** Error carrying the HTTP status (409 = a run is already active). */
export class KbSetupError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function statusOf(err: unknown): number {
  const s = (err as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : 0
}

export function isConflict(err: unknown): boolean {
  return statusOf(err) === 409
}

export function createKbSetupApi(workspace: string): KbSetupApi {
  const q = `workspace=${encodeURIComponent(workspace)}`
  const base = '/kb-setup'
  return {
    status: () => api.get<SetupStatus>(`${base}/status?${q}`),
    async upload(batch) {
      // Multipart: let the browser set the boundary, so no JSON content-type here.
      const fd = new FormData()
      for (const f of batch) fd.append('files', f.file, f.file.name)
      fd.append('paths', JSON.stringify(batch.map(f => f.path)))
      const r = await fetch(`/api${base}/upload?${q}`, { method: 'POST', credentials: 'include', body: fd })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new KbSetupError(r.status, body.error ?? `Upload failed (HTTP ${r.status})`)
      return body as UploadResult
    },
    sample: () => api.post<{ saved: string[] }>(`${base}/sample?${q}`),
    startRun: () => api.post<Run>(`${base}/runs?${q}`),
    getRun: id => api.get<Run>(`${base}/runs/${encodeURIComponent(id)}?${q}`),
    pause: id => api.post<Run>(`${base}/runs/${encodeURIComponent(id)}/pause?${q}`),
    resume: (id, ignoreCeiling) =>
      api.post<Run>(`${base}/runs/${encodeURIComponent(id)}/resume?${q}`, ignoreCeiling ? { ignore_ceiling: true } : {}),
    questions: () => api.get<{ questions: OpenQuestion[] }>(`${base}/questions?${q}`),
    answer: (qid, body) => api.post<OpenQuestion>(`${base}/questions/${encodeURIComponent(qid)}?${q}`, body),
  }
}

// ── Upload helpers ───────────────────────────────────────────────────────────

/** The server takes at most this many files per upload request. */
export const MAX_FILES_PER_UPLOAD = 50

export function batchFiles<T>(files: readonly T[], size = MAX_FILES_PER_UPLOAD): T[][] {
  const n = Math.max(1, Math.floor(size))
  const out: T[][] = []
  for (let i = 0; i < files.length; i += n) out.push(files.slice(i, i + n))
  return out
}

/** Files from an <input> (webkitdirectory gives webkitRelativePath; plain picks don't). */
export function pickedFromInput(list: FileList | readonly File[]): PickedFile[] {
  return Array.from(list).map(file => ({ file, path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name }))
}

/** Minimal shape of the File and Directory Entries API we rely on (easy to fake in tests). */
export interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (ok: (f: File) => void, fail?: (e: unknown) => void) => void
  createReader?: () => { readEntries: (ok: (entries: EntryLike[]) => void, fail?: (e: unknown) => void) => void }
}

/** Recursively collect the files under one entry, keeping each file's relative path. */
export async function walkEntry(entry: EntryLike, prefix = ''): Promise<PickedFile[]> {
  const rel = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail))
    return [{ file, path: rel }]
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader()
    const children: EntryLike[] = []
    // readEntries hands back at most ~100 entries per call — keep reading until empty.
    for (;;) {
      const chunk = await new Promise<EntryLike[]>((ok, fail) => reader.readEntries(ok, fail))
      if (!chunk.length) break
      children.push(...chunk)
    }
    const out: PickedFile[] = []
    for (const c of children) out.push(...(await walkEntry(c, rel)))
    return out
  }
  return []
}

/**
 * Files from a drop. Entries must be taken synchronously inside the drop
 * handler (the DataTransfer is emptied once the handler returns), so call this
 * directly from onDrop and only await the result.
 */
export function filesFromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const entries: EntryLike[] = []
  const loose: File[] = []
  const items = dt.items ? Array.from(dt.items) : []
  for (const item of items) {
    if (item.kind !== 'file') continue
    const entry = typeof item.webkitGetAsEntry === 'function' ? (item.webkitGetAsEntry() as EntryLike | null) : null
    if (entry) entries.push(entry)
    else { const f = item.getAsFile(); if (f) loose.push(f) }
  }
  if (!items.length && dt.files?.length) loose.push(...Array.from(dt.files))
  return (async () => {
    const out: PickedFile[] = loose.map(file => ({ file, path: file.name }))
    for (const e of entries) out.push(...(await walkEntry(e)))
    return out
  })()
}

/** Upload in batches; reports files sent so far after each batch. */
export async function uploadInBatches(
  kb: Pick<KbSetupApi, 'upload'>,
  files: readonly PickedFile[],
  onProgress?: (sent: number, total: number) => void,
): Promise<UploadResult> {
  const result: UploadResult = { saved: [], skipped: [] }
  let sent = 0
  onProgress?.(0, files.length)
  for (const batch of batchFiles(files)) {
    const r = await kb.upload(batch)
    result.saved.push(...(r.saved ?? []))
    result.skipped.push(...(r.skipped ?? []))
    sent += batch.length
    onProgress?.(sent, files.length)
  }
  return result
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 KB'
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatUsd(n: number | null | undefined): string {
  const v = Number(n ?? 0)
  return v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`
}

/** Files the run has finished with, whatever the outcome. */
export function processedCount(counts: Run['counts']): number {
  return Number(counts.done ?? 0) + Number(counts.unchanged ?? 0) + Number(counts.duplicate ?? 0)
    + Number(counts.skipped ?? 0) + Number(counts.failed ?? 0)
}
