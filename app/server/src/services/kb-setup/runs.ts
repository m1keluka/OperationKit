import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type Database from 'better-sqlite3'
import { parseOrganizeReply, safeFileName, MAX_PROMPT_CHARS } from '../doc-ingest/ingest.js'
import { ensureKbFolders } from '../doc-ingest/ingest.js'
import {
  FOLDER_FOR, loadEntityIndex, parseNote, slugify, writeOrganized, type Entity, type EntityType, type OrganizedDocument,
} from '../doc-ingest/notes.js'
import type { LlmCall } from '../doc-ingest/llm.js'
import { STATE_DIR, ensureKbGitignore } from '../kb-wiki/paths.js'
import { appendLog, compileWiki } from '../kb-wiki/wiki.js'
import { extractForSetup, setupKindFor, skipReason } from './extract.js'
import { redactSecrets, describeFindings, type SecretFinding } from './secrets.js'
import { CATEGORY_HINT, classifyFile, foldGlossary, sectionFor, type FileCategory, type SectionKey } from './taxonomy.js'
import {
  cleanQuestions, closeQuestionItem, detectAmbiguousNames, ensureAnchorCard, fileQuestions, mergeQuestions, questionId,
  type OpenQuestion,
} from './questions.js'

/**
 * Knowledge Base Setup runs (obj 900556).
 *
 *   UI upload (files + folders) ─┐
 *   host drop into <kb>/intake/ ─┴→ intake/<relative path>
 *        → run created: files move to .kb-wiki/kb-setup/staging/<run>/   (new drops can't race the run)
 *        → per file, one at a time:
 *            same bytes as a file already done   → "unchanged" / "duplicate" (no AI call)
 *            extract text (extract.ts)            → secrets redacted + flagged (secrets.ts)
 *            classify (taxonomy.ts)               → a hint for the AI
 *            AI files it into notes               → existing note types + tags (taxonomy.ts)
 *            write / merge notes                  → doc-ingest writeOrganized(), one "## From:" section per file
 *        → compile the wiki (index, backlinks, graph), log it, collect open questions
 *        → open questions → the decision queue (questions.ts)
 *
 * State lives on disk under .kb-wiki/kb-setup/ so a restart resumes the run
 * where it stopped, and the LEDGER (one row per relative path: sha256, source
 * note, pages) is what makes re-runs idempotent: an unchanged file is never
 * read twice, and a changed file replaces only its own sections.
 *
 * Workspace isolation: every path here is under ONE workspace's knowledge-base
 * root, resolved by the caller from an authorized workspace slug.
 */

// ── Paths ────────────────────────────────────────────────────────────────────

export const INTAKE_DIR = 'intake'
export const SETUP_STATE_DIR = `${STATE_DIR}/kb-setup`
const LEDGER = `${SETUP_STATE_DIR}/ledger.json`
const QUESTIONS = `${SETUP_STATE_DIR}/questions.json`
const RUNS_DIR = `${SETUP_STATE_DIR}/runs`
const STAGING_DIR = `${SETUP_STATE_DIR}/staging`

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SETUP_PROMPT_FILE = path.join(HERE, 'prompt.md')
/** Built-in sample folder for "Try with sample files" (also the e2e fixture). */
export const SAMPLE_INTAKE_DIR = path.join(HERE, 'sample-intake')

/** One upload request / one intake folder never adds more than this many files to a run. */
export const MAX_FILES_PER_RUN = 2000
export const MAX_FILE_BYTES = 50 * 1024 * 1024
/** Folder depth kept from an upload's relative path. */
const MAX_DEPTH = 8

// ── Types ────────────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'paused' | 'done' | 'failed'
export type ItemStatus = 'pending' | 'working' | 'done' | 'unchanged' | 'duplicate' | 'skipped' | 'failed'

export interface PageChange { rel: string; title: string; section: SectionKey; created: boolean }

export interface RunItem {
  /** Relative path as dropped ("Clients/Acme/contract.pdf"). Unique within a run. */
  path: string
  bytes: number
  status: ItemStatus
  sha256?: string
  category?: FileCategory
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
  /** Where the ceiling came from: `workspace:<slug>`, `global`, or `none`. */
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
  /** Estimated list-price value of the AI calls (advisory — see job-accounting). */
  est_cost_usd: number
  elapsed_ms: number
  ceiling: RunCeiling
  ignore_ceiling?: boolean
  summary?: RunSummary
  anchor_card?: number
}

export type RunListing = Omit<Run, 'items'>

interface LedgerRow {
  id: string
  sha256: string
  source_note?: string
  original?: string
  pages: string[]
  run: string
  done_at: string
}

interface Ledger {
  files: Record<string, LedgerRow>
  anchor_card?: number | null
}

export interface RunDeps {
  llm: LlmCall
  systemPrompt: string
  db?: Database.Database
  now?: () => Date
  /** Absolute URL (or path) of the setup page, written into the questions card. */
  setupUrl?: string
}

// ── Small file helpers ───────────────────────────────────────────────────────

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2))
  fs.renameSync(tmp, file)
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return fallback }
}

export function readLedger(kb: string): Ledger {
  const l = readJson<Ledger>(path.join(kb, LEDGER), { files: {} })
  return l && typeof l.files === 'object' ? l : { files: {} }
}
function writeLedger(kb: string, l: Ledger): void { writeJsonAtomic(path.join(kb, LEDGER), l) }

export function readQuestions(kb: string): OpenQuestion[] {
  const q = readJson<OpenQuestion[]>(path.join(kb, QUESTIONS), [])
  return Array.isArray(q) ? q : []
}
function writeQuestions(kb: string, q: OpenQuestion[]): void { writeJsonAtomic(path.join(kb, QUESTIONS), q) }

function runFile(kb: string, id: string): string {
  if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error('invalid run id')
  return path.join(kb, RUNS_DIR, `${id}.json`)
}

export function getRun(kb: string, id: string): Run | null {
  return readJson<Run | null>(runFile(kb, id), null)
}

function saveRun(kb: string, run: Run): Run {
  run.counts = countItems(run.items)
  writeJsonAtomic(runFile(kb, run.id), run)
  return run
}

function countItems(items: RunItem[]): Run['counts'] {
  const c = { total: items.length, pending: 0, working: 0, done: 0, unchanged: 0, duplicate: 0, skipped: 0, failed: 0 }
  for (const i of items) c[i.status]++
  return c
}

export function listRuns(kb: string): RunListing[] {
  let names: string[] = []
  try { names = fs.readdirSync(path.join(kb, RUNS_DIR)).filter(n => n.endsWith('.json')) } catch { return [] }
  return names
    .map(n => getRun(kb, n.slice(0, -5)))
    .filter((r): r is Run => !!r)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(({ items: _items, ...rest }) => rest)
}

export function activeRun(kb: string): RunListing | null {
  return listRuns(kb).find(r => r.status === 'running' || r.status === 'paused') ?? null
}

// ── Intake ───────────────────────────────────────────────────────────────────

/**
 * Turn an uploaded relative path ("My Drive/Clients/Acme/Notes.docx") into a
 * safe one under intake/. Every segment goes through safeFileName; "..", "."
 * and empty segments are dropped, so nothing can escape the folder.
 */
export function safeRelPath(raw: string): string | null {
  const segs = String(raw).replace(/\\/g, '/').split('/')
    .map(s => s.trim()).filter(s => s && s !== '.' && s !== '..')
    .map(s => safeFileName(s))
  if (!segs.length) return null
  const kept = segs.length > MAX_DEPTH ? [...segs.slice(0, MAX_DEPTH - 1), segs[segs.length - 1]] : segs
  return kept.join('/')
}

export function intakeRoot(kb: string): string { return path.join(kb, INTAKE_DIR) }

/** Save one uploaded file into intake/. Returns the relative path it was stored under. */
export function addToIntake(kb: string, relPath: string, buf: Buffer): string {
  const rel = safeRelPath(relPath)
  if (!rel) throw new Error(`not a usable file name: ${relPath}`)
  const abs = path.join(intakeRoot(kb), rel)
  if (!abs.startsWith(intakeRoot(kb) + path.sep)) throw new Error('path escapes the intake folder')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buf)
  return rel
}

/** Every file waiting in intake/ (relative paths, sorted), with sizes. Symlinks are ignored. */
export function listIntake(kb: string, limit = MAX_FILES_PER_RUN): Array<{ path: string; bytes: number }> {
  const root = intakeRoot(kb)
  const out: Array<{ path: string; bytes: number }> = []
  const walk = (rel: string, depth: number) => {
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory() && depth < 12) walk(r, depth + 1)
      else if (e.isFile()) out.push({ path: r, bytes: fs.statSync(path.join(root, r)).size })
    }
  }
  walk('', 0)
  return out
}

/** Copy the built-in sample folder into intake/ (the "try it" button and the e2e fixture). */
export function stageSampleIntake(kb: string, from = SAMPLE_INTAKE_DIR): string[] {
  const staged: string[] = []
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(from, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(r)
      else if (e.isFile() && e.name !== 'README.md') staged.push(addToIntake(kb, r, fs.readFileSync(path.join(from, r))))
    }
  }
  walk('')
  return staged
}

function ensureSetupGitignore(kb: string): void {
  ensureKbGitignore(kb)
  const file = path.join(kb, '.gitignore')
  const text = fs.readFileSync(file, 'utf8')
  if (!text.split(/\r?\n/).some(l => l.trim() === `${INTAKE_DIR}/` || l.trim() === `/${INTAKE_DIR}/`)) {
    fs.writeFileSync(file, `${text}${text.endsWith('\n') ? '' : '\n'}# Knowledge base setup drop folder: raw files are read, then moved out\n${INTAKE_DIR}/\n`)
  }
}

// ── Ceiling (inherited, never invented) ──────────────────────────────────────

function readSetting(db: Database.Database | undefined, key: string): string | null {
  if (!db) return null
  try { return (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null } catch { return null }
}

function finite(v: string | null): number | null {
  const n = v === null ? NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * The run's budget, inherited the same way a board job's is
 * (`job-accounting.resolveConfiguredCeiling`): workspace settings first, then
 * global. A `kb_setup_*` setting, when present, is more specific still. No
 * numeric default is invented: "none" is reported as such.
 */
export function resolveRunCeiling(db: Database.Database | undefined, workspace: string): RunCeiling {
  const layers: Array<[string, string, string]> = [
    [`kb_setup_cost_ceiling_usd:${workspace}`, `kb_setup_wallclock_ceiling_ms:${workspace}`, `kb-setup:${workspace}`],
    ['kb_setup_cost_ceiling_usd', 'kb_setup_wallclock_ceiling_ms', 'kb-setup'],
    [`job_cost_ceiling_usd:${workspace}`, `job_wallclock_ceiling_ms:${workspace}`, `workspace:${workspace}`],
    ['job_cost_ceiling_usd', 'job_wallclock_ceiling_ms', 'global'],
  ]
  for (const [c, w, source] of layers) {
    const cost = finite(readSetting(db, c))
    const ms = finite(readSetting(db, w))
    if (cost !== null || ms !== null) return { cost_usd: cost, wallclock_ms: ms, source }
  }
  return { cost_usd: null, wallclock_ms: null, source: 'none' }
}

/** List-price estimate of one call: ~4 characters per token, Sonnet-class pricing. */
export function estimateCostUsd(promptChars: number, replyChars: number): number {
  return (promptChars / 4) * 3e-6 + (replyChars / 4) * 15e-6
}

export function overCeiling(run: Pick<Run, 'ceiling' | 'est_cost_usd' | 'elapsed_ms' | 'ignore_ceiling'>): boolean {
  if (run.ignore_ceiling) return false
  const c = run.ceiling
  return (c.cost_usd !== null && run.est_cost_usd >= c.cost_usd) || (c.wallclock_ms !== null && run.elapsed_ms >= c.wallclock_ms)
}

// ── Create / pause / resume ──────────────────────────────────────────────────

function newRunId(kb: string, now: Date): string {
  const base = `run-${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-').toLowerCase()}`
  let id = base
  for (let i = 2; fs.existsSync(runFile(kb, id)); i++) id = `${base}-${i}`
  return id
}

export class RunConflictError extends Error {}

/**
 * Start a run over everything in intake/. Files move to the run's staging
 * folder first, so a person can keep dropping files for the NEXT run while
 * this one works. Throws RunConflictError when a run is already active.
 */
export function createRun(kb: string, workspace: string, opts: { by?: string; db?: Database.Database; now?: Date } = {}): Run {
  const now = opts.now ?? new Date()
  if (activeRun(kb)) throw new RunConflictError('A knowledge base setup run is already in progress — pause or wait for it first.')
  const files = listIntake(kb)
  if (!files.length) throw new Error('The intake folder is empty — upload files or drop them into the intake folder first.')
  ensureKbFolders(kb)
  ensureSetupGitignore(kb)
  const id = newRunId(kb, now)
  const stage = path.join(kb, STAGING_DIR, id)
  for (const f of files) {
    const to = path.join(stage, f.path)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(path.join(intakeRoot(kb), f.path), to)
  }
  pruneEmptyDirs(intakeRoot(kb))
  const items = orderForDedupe(files.map(f => ({ path: f.path, bytes: f.bytes, status: 'pending' as const })), p => {
    try { return sha256(fs.readFileSync(path.join(stage, p))) } catch { return p }
  })
  const run: Run = {
    id, workspace, status: 'running', created_at: now.toISOString(), created_by: opts.by, items,
    counts: countItems(items), est_cost_usd: 0, elapsed_ms: 0, ceiling: resolveRunCeiling(opts.db, workspace),
  }
  return saveRun(kb, run)
}

function pruneEmptyDirs(root: string): void {
  const walk = (dir: string): boolean => {
    let ents: fs.Dirent[] = []
    try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return false }
    let empty = true
    for (const e of ents) {
      if (e.isDirectory() && walk(path.join(dir, e.name))) { try { fs.rmdirSync(path.join(dir, e.name)) } catch { empty = false } } else empty = false
    }
    return empty
  }
  walk(root)
}

const COPY_LIKE = /(^|\/)(copy of |copia de |kopie van )|[ _-]copy( \d+)?(\.[^./]+)?$| \(\d+\)(\.[^./]+)?$/i

/**
 * Processing order: alphabetical, except that when several files have the
 * SAME bytes, the one that does not look like a copy ("Copy of …", "… (1)",
 * "… copy") goes first — so it becomes the source and the copies are marked
 * duplicates of it, not the other way round.
 */
export function orderForDedupe<T extends { path: string }>(items: T[], hashOf: (p: string) => string): T[] {
  const hashes = new Map(items.map(i => [i.path, hashOf(i.path)]))
  const rank = (i: T) => (COPY_LIKE.test(i.path) ? 1 : 0)
  const canonical = new Map<string, T>()
  for (const i of [...items].sort((a, b) => rank(a) - rank(b) || a.path.length - b.path.length || a.path.localeCompare(b.path))) {
    const h = hashes.get(i.path)!
    if (!canonical.has(h)) canonical.set(h, i)
  }
  const isCopy = (i: T) => canonical.get(hashes.get(i.path)!) !== i
  return [...items.filter(i => !isCopy(i)), ...items.filter(isCopy)]
}

export function pauseRun(kb: string, id: string): Run {
  const run = getRun(kb, id)
  if (!run) throw new Error('No such run')
  if (run.status === 'running') { run.status = 'paused'; run.pause_reason = 'user' }
  return saveRun(kb, run)
}

/** Mark a run running again (the caller starts the worker). `ignoreCeiling` lets it go past its budget once the person says so. */
export function resumeRun(kb: string, id: string, opts: { ignoreCeiling?: boolean; db?: Database.Database } = {}): Run {
  const run = getRun(kb, id)
  if (!run) throw new Error('No such run')
  if (run.status !== 'paused' && run.status !== 'failed') return run
  run.status = 'running'
  run.pause_reason = undefined
  run.error = undefined
  run.ceiling = resolveRunCeiling(opts.db, run.workspace)
  if (opts.ignoreCeiling) run.ignore_ceiling = true
  for (const i of run.items) if (i.status === 'working') i.status = 'pending'
  return saveRun(kb, run)
}

/** After a restart: an item left 'working' was interrupted — put it back. Returns true when there is work to resume. */
export function recoverRun(kb: string, id: string): boolean {
  const run = getRun(kb, id)
  if (!run || run.status !== 'running') return false
  let n = 0
  for (const i of run.items) if (i.status === 'working') { i.status = 'pending'; n++ }
  if (n) saveRun(kb, run)
  return true
}

// ── One file ─────────────────────────────────────────────────────────────────

function sha256(buf: Buffer): string { return crypto.createHash('sha256').update(buf).digest('hex') }

/** Stable source id per relative path: the path's slug, suffixed only on a collision with another path. */
export function sourceIdFor(ledger: Ledger, relPath: string): string {
  if (ledger.files[relPath]) return ledger.files[relPath].id
  const ext = path.posix.extname(relPath)
  const base = `setup-${slugify(relPath.slice(0, relPath.length - ext.length)).slice(0, 90)}`
  const taken = new Set(Object.values(ledger.files).map(r => r.id))
  let id = base
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`
  return id
}

export function buildSetupPrompt(relPath: string, category: FileCategory, kind: string, markdown: string, existingNames: string[], meta: { sheets?: string[]; pages?: number }): { prompt: string; truncated: boolean } {
  const truncated = markdown.length > MAX_PROMPT_CHARS
  const content = truncated ? markdown.slice(0, MAX_PROMPT_CHARS) : markdown
  const known = existingNames.slice(0, 500)
  const prompt = [
    `FILE: ${relPath}`,
    `FOLDER: ${path.posix.dirname(relPath) === '.' ? '(top level)' : path.posix.dirname(relPath)}`,
    `TYPE: ${kind}${meta.sheets?.length ? ` (tabs: ${meta.sheets.join(', ')})` : ''}${meta.pages ? ` (${meta.pages} pages/slides)` : ''}`,
    `LOOKS LIKE: ${category} — ${CATEGORY_HINT[category]}`,
    '',
    known.length
      ? `NOTES THAT ALREADY EXIST (reuse these exact names for the same thing):\n${known.map(n => `- ${n}`).join('\n')}`
      : 'The knowledge base is empty so far.',
    '',
    truncated ? `NOTE: the file is long; only the first ${MAX_PROMPT_CHARS} characters are included.\n` : '',
    '<<<FILE CONTENT',
    content,
    'FILE CONTENT>>>',
    '',
    'Return ONLY the JSON object described in your instructions.',
  ].join('\n')
  return { prompt, truncated }
}

/** Drop the section a file wrote into a note (used when a changed file no longer mentions that note). */
export function removeSourceSection(text: string, relPath: string, sourceNote: string): string {
  const heading = `## From: ${relPath}`
  const start = text.indexOf(`\n${heading}\n`)
  let out = text
  if (start >= 0) {
    const next = text.indexOf('\n## ', start + heading.length + 1)
    out = text.slice(0, start) + (next >= 0 ? text.slice(next) : '\n')
  }
  return out.replace(/^(sources: \[)(.*)(\])$/m, (_m, a: string, list: string, b: string) => {
    const kept = list.split(',').map(s => s.trim()).filter(s => s && s.replace(/^"|"$/g, '') !== sourceNote)
    return `${a}${kept.join(', ')}${b}`
  }).replace(/\n{3,}/g, '\n\n')
}

function titleOfNote(kb: string, rel: string): string {
  try { return parseNote(fs.readFileSync(path.join(kb, rel), 'utf8')).fm?.title || path.posix.basename(rel, '.md') } catch { return path.posix.basename(rel, '.md') }
}

function tagsOfNote(kb: string, rel: string): string[] {
  try { return parseNote(fs.readFileSync(path.join(kb, rel), 'utf8')).fm?.tags ?? [] } catch { return [] }
}

function typeOfRel(rel: string): EntityType | 'topic' {
  const top = rel.split('/')[0]
  return (Object.entries(FOLDER_FOR).find(([, f]) => f === top)?.[0] as EntityType | undefined) ?? 'topic'
}

/** Add the category tag + the original path to a source note document ingest just wrote. */
function decorateSourceNote(kb: string, sourceNote: string, relPath: string, category: FileCategory, secrets: SecretFinding[]): void {
  const abs = path.join(kb, sourceNote)
  let text = fs.readFileSync(abs, 'utf8')
  text = text.replace(/^tags: \[source\]$/m, `tags: [source, ${category}]`)
  text = text.replace(/^generated_by: document-ingest$/m, `original_path: ${JSON.stringify(relPath)}\ngenerated_by: kb-setup`)
  if (secrets.length) {
    text = text.replace(/\n## Content \(as extracted\)\n/, `\n## Secrets removed\n\n${describeFindings(secrets)} were found in this file and replaced with [REDACTED]. The original file was NOT kept; rotate these credentials.\n\n## Content (as extracted)\n`)
  }
  fs.writeFileSync(abs, text)
}

interface ItemOutcome { item: RunItem; cost: number; aiFailed?: boolean }

async function processItem(kb: string, run: Run, item: RunItem, deps: RunDeps): Promise<ItemOutcome> {
  const now = deps.now ?? (() => new Date())
  const staged = path.join(kb, STAGING_DIR, run.id, item.path)
  const done = (patch: Partial<RunItem>, cost = 0, aiFailed = false): ItemOutcome => {
    try { fs.rmSync(staged, { force: true }) } catch { /* already gone */ }
    return { item: { ...item, ...patch, finished_at: now().toISOString() }, cost, aiFailed }
  }
  if (!fs.existsSync(staged)) return done({ status: 'failed', error: 'The file was removed before it could be read.' })

  const why = skipReason(item.path)
  if (why) return done({ status: 'skipped', skip_reason: why })
  if (item.bytes > MAX_FILE_BYTES) return done({ status: 'skipped', skip_reason: `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB` })

  const buf = fs.readFileSync(staged)
  const hash = sha256(buf)
  const ledger = readLedger(kb)
  const prev = ledger.files[item.path]
  if (prev && prev.sha256 === hash) return done({ status: 'unchanged', sha256: hash, source_note: prev.source_note })
  const twin = Object.entries(ledger.files).find(([p, r]) => p !== item.path && r.sha256 === hash)
  if (twin) return done({ status: 'duplicate', sha256: hash, duplicate_of: twin[0], source_note: twin[1].source_note })

  // Read + scrub. The AI and the knowledge base only ever see the redacted text.
  const ex = extractForSetup(item.path, buf)
  const { text: markdown, findings } = redactSecrets(ex.markdown)
  const warnings = [...ex.warnings]
  if (!markdown.trim()) return done({ status: 'failed', sha256: hash, warnings, error: warnings[0] ?? 'No text could be read from this file.' })
  const category = classifyFile(item.path, markdown)

  const index = loadEntityIndex(kb)
  const existing = index.all.map(e => `${e.type}: ${e.name}`)
  const { prompt, truncated } = buildSetupPrompt(item.path, category, ex.kind, markdown, existing, { sheets: ex.sheets, pages: ex.pages })
  if (truncated) warnings.push(`Very long file — only the first ${MAX_PROMPT_CHARS.toLocaleString('en-US')} characters were organized; the full text is in the readable copy.`)

  let reply: string
  let doc: OrganizedDocument & { questions?: unknown }
  let cost = 0
  try {
    reply = await deps.llm(deps.systemPrompt, prompt)
    cost += estimateCostUsd(prompt.length + deps.systemPrompt.length, reply.length)
    try {
      doc = parseOrganizeReply(reply)
    } catch {
      const retry = `${prompt}\n\nIMPORTANT: your previous reply was not usable. Reply with ONLY the JSON object {"title": …, "summary": …, "entities": [ … ], "questions": [ … ]}.`
      reply = await deps.llm(deps.systemPrompt, retry)
      cost += estimateCostUsd(retry.length + deps.systemPrompt.length, reply.length)
      doc = parseOrganizeReply(reply)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // An AI outage is not this file's fault: leave it pending so a resume retries it.
    const outage = /too long|unavailable|rate|limit|credential|sign.?in|ECONN|spawn|exited/i.test(msg) && !/JSON|entities/.test(msg)
    if (outage) return { item: { ...item, status: 'pending', error: msg }, cost, aiFailed: true }
    return done({ status: 'failed', sha256: hash, error: msg }, cost)
  }

  // Never let the AI reintroduce a secret it was not shown — scrub the reply's facts too.
  const entities: Entity[] = foldGlossary((doc.entities ?? []).map(e => ({
    ...e,
    facts: Array.isArray(e.facts) ? e.facts.map(f => ({ ...f, fact: typeof f?.fact === 'string' ? redactSecrets(f.fact).text : '' })) : [],
    summary: typeof e.summary === 'string' ? redactSecrets(e.summary).text : e.summary,
  })))

  // Store the original — unless it held a secret, in which case only a redacted copy is kept.
  const id = sourceIdFor(ledger, item.path)
  const ext = path.posix.extname(item.path).toLowerCase()
  const textual = ['text', 'csv', 'html', 'json'].includes(setupKindFor(item.path) ?? '')
  const originalRel = findings.length
    ? `sources/files/${id}.redacted${textual ? ext || '.txt' : '.md'}`
    : `sources/files/${id}${ext}`
  fs.mkdirSync(path.join(kb, 'sources/files'), { recursive: true })
  for (const old of [prev?.original].filter((p): p is string => !!p && p !== originalRel)) { try { fs.rmSync(path.join(kb, old), { force: true }) } catch { /* gone */ } }
  fs.writeFileSync(path.join(kb, originalRel), findings.length ? (textual ? redactSecrets(buf.toString('utf8')).text : markdown) : buf)
  if (findings.length) warnings.push(`${describeFindings(findings)} removed; the original file was not kept.`)

  const before = new Set(index.all.map(e => e.rel))
  const res = writeOrganized(
    kb,
    { id, fileName: item.path, storedRel: originalRel, kind: ex.kind, ingestedAt: now().toISOString() },
    { title: doc.title, summary: doc.summary, entities },
    markdown,
    warnings,
  )
  decorateSourceNote(kb, res.sourceNoteRel, item.path, category, findings)

  // A changed file that no longer mentions a note gives up its section there.
  const nowPages = new Set(res.notes.map(n => n.rel))
  for (const rel of prev?.pages ?? []) {
    if (nowPages.has(rel)) continue
    const abs = path.join(kb, rel)
    if (fs.existsSync(abs)) fs.writeFileSync(abs, removeSourceSection(fs.readFileSync(abs, 'utf8'), item.path, res.sourceNoteRel))
  }

  const pages: PageChange[] = [...nowPages].map(rel => {
    const tags = tagsOfNote(kb, rel)
    return { rel, title: titleOfNote(kb, rel), section: sectionFor(typeOfRel(rel), tags), created: !before.has(rel) }
  })
  const questions = cleanQuestions((doc as { questions?: unknown }).questions, item.path)
  if (findings.length) {
    const ask = `Rotate the credentials found in "${item.path}" (${findings.map(f => f.kind).filter((k, i, a) => a.indexOf(k) === i).join(', ')}) — they were removed from the knowledge base, but whoever had the file has them.`
    questions.push({ id: questionId('secret', ask, []), kind: 'secret', ask, about: [], files: [item.path], status: 'open' })
  }
  if (questions.length) writeQuestions(kb, mergeQuestions(readQuestions(kb), questions))

  const l2 = readLedger(kb)
  l2.files[item.path] = { id, sha256: hash, source_note: res.sourceNoteRel, original: originalRel, pages: [...nowPages], run: run.id, done_at: now().toISOString() }
  writeLedger(kb, l2)

  return done({
    status: 'done', sha256: hash, category, title: doc.title?.trim() || item.path, source_note: res.sourceNoteRel, original: originalRel,
    pages, secrets: findings.length ? findings : undefined, questions: questions.map(q => q.id), warnings: warnings.length ? warnings : undefined,
  }, cost)
}

// ── Worker ───────────────────────────────────────────────────────────────────

const workers = new Map<string, Promise<void>>()

/** Start (or join) the worker for this knowledge base. One run at a time per KB, one file at a time. */
export function runWorker(kb: string, id: string, deps: RunDeps): Promise<void> {
  const existing = workers.get(kb)
  if (existing) return existing
  const p = workLoop(kb, id, deps).catch(err => {
    const run = getRun(kb, id)
    if (run) { run.status = 'failed'; run.error = err instanceof Error ? err.message : String(err); saveRun(kb, run) }
  }).finally(() => { workers.delete(kb) })
  workers.set(kb, p)
  return p
}

export function isRunning(kb: string): boolean { return workers.has(kb) }

async function workLoop(kb: string, id: string, deps: RunDeps): Promise<void> {
  const now = deps.now ?? (() => new Date())
  {
    const run = getRun(kb, id)
    if (!run || run.status !== 'running') return
    if (!run.started_at) { run.started_at = now().toISOString(); saveRun(kb, run) }
  }
  for (;;) {
    const run = getRun(kb, id)
    if (!run || run.status !== 'running') return
    if (overCeiling(run)) {
      run.status = 'paused'; run.pause_reason = 'ceiling'; run.current = undefined
      saveRun(kb, run)
      appendLog(kb, { kind: 'ingest', title: `Knowledge base setup paused at its budget (${run.ceiling.source}): ${run.counts.pending} file(s) left` })
      return
    }
    const idx = run.items.findIndex(i => i.status === 'pending')
    if (idx < 0) break
    run.items[idx] = { ...run.items[idx], status: 'working', error: undefined }
    run.current = run.items[idx].path
    saveRun(kb, run)

    const t0 = Date.now()
    const out = await processItem(kb, run, run.items[idx], deps)
    const after = getRun(kb, id) ?? run
    after.items[idx] = out.item
    after.est_cost_usd = Math.round((after.est_cost_usd + out.cost) * 1e6) / 1e6
    after.elapsed_ms += Date.now() - t0
    after.current = undefined
    if (out.aiFailed) {
      after.status = 'paused'; after.pause_reason = 'ai-unavailable'; after.error = out.item.error
      saveRun(kb, after)
      return
    }
    saveRun(kb, after)
  }
  finishRun(kb, id, deps)
}

/** Compile the wiki, log the run, collect questions, file them, write the summary. */
export function finishRun(kb: string, id: string, deps: Pick<RunDeps, 'db' | 'now' | 'setupUrl'>): Run | null {
  const now = deps.now ?? (() => new Date())
  const run = getRun(kb, id)
  if (!run) return null
  try { compileWiki(kb, { now: now() }) } catch (err) { console.warn(`[kb-setup] compile: ${(err as Error).message}`) }

  // Created vs updated across the whole run: a page created by an early file
  // and extended by a later one is still "created".
  const created = new Map<string, PageChange>()
  const updated = new Map<string, PageChange>()
  for (const it of run.items) for (const p of it.pages ?? []) {
    if (p.created) { created.set(p.rel, p); updated.delete(p.rel) } else if (!created.has(p.rel)) updated.set(p.rel, p)
  }
  // Re-read titles/sections at the end (a later file may have added a tag).
  const fresh = (p: PageChange): PageChange => ({ ...p, title: titleOfNote(kb, p.rel), section: sectionFor(typeOfRel(p.rel), tagsOfNote(kb, p.rel)) })
  const createdList = [...created.values()].map(fresh).sort((a, b) => a.rel.localeCompare(b.rel))
  const updatedList = [...updated.values()].map(fresh).sort((a, b) => a.rel.localeCompare(b.rel))
  const bySection = Object.fromEntries(['people', 'companies', 'projects', 'decisions', 'processes', 'products', 'glossary', 'topics'].map(k => [k, { created: 0, updated: 0 }])) as RunSummary['by_section']
  for (const p of createdList) bySection[p.section].created++
  for (const p of updatedList) bySection[p.section].updated++

  // Questions: the AI's, plus names the merge would not join.
  let questions = mergeQuestions(readQuestions(kb), detectAmbiguousNames(loadEntityIndex(kb).all))
  const ledger = readLedger(kb)
  if (deps.db) {
    const open = questions.filter(q => q.status === 'open')
    if (open.length) {
      try {
        const anchor = ensureAnchorCard({ db: deps.db, workspace: run.workspace, previousAnchor: ledger.anchor_card, setupUrl: deps.setupUrl ?? '/knowledge/setup' }, open.length)
        questions = fileQuestions(deps.db, run.workspace, anchor, questions)
        run.anchor_card = anchor
        const l = readLedger(kb); l.anchor_card = anchor; writeLedger(kb, l)
      } catch (err) {
        console.warn(`[kb-setup] could not file questions to the decision queue: ${(err as Error).message}`)
      }
    }
  }
  writeQuestions(kb, questions)

  run.summary = {
    created: createdList,
    updated: updatedList,
    by_section: bySection,
    secrets: run.items.filter(i => i.secrets?.length).map(i => ({ path: i.path, findings: i.secrets! })),
    questions_open: questions.filter(q => q.status === 'open').length,
  }
  run.status = 'done'
  run.finished_at = now().toISOString()
  run.current = undefined
  saveRun(kb, run)
  try { fs.rmSync(path.join(kb, STAGING_DIR, run.id), { recursive: true, force: true }) } catch { /* nothing staged */ }

  const c = run.counts
  appendLog(kb, {
    kind: 'ingest',
    title: `Knowledge base setup: ${c.done} file(s) read, ${createdList.length} page(s) created, ${updatedList.length} updated`
      + `${c.unchanged ? `, ${c.unchanged} unchanged` : ''}${c.duplicate ? `, ${c.duplicate} duplicate(s)` : ''}${c.skipped ? `, ${c.skipped} skipped` : ''}${c.failed ? `, ${c.failed} failed` : ''}`
      + `${run.summary.secrets.length ? `; secrets removed from ${run.summary.secrets.length} file(s)` : ''}${run.summary.questions_open ? `; ${run.summary.questions_open} open question(s)` : ''}`,
    pages: [...createdList, ...updatedList].map(p => p.rel),
    when: now(),
  })
  return run
}

// ── Answering questions ──────────────────────────────────────────────────────

export function answerQuestion(kb: string, qid: string, input: { answer?: string; dismiss?: boolean; by: string; db?: Database.Database; now?: Date }): OpenQuestion {
  const qs = readQuestions(kb)
  const q = qs.find(x => x.id === qid)
  if (!q) throw new Error('No such question')
  if (input.dismiss) q.status = 'dismissed'
  else {
    const a = (input.answer ?? '').trim()
    if (!a) throw new Error('An answer is required (or dismiss the question).')
    q.status = 'answered'
    q.answer = a.slice(0, 2000)
  }
  q.answered_at = (input.now ?? new Date()).toISOString()
  q.answered_by = input.by
  writeQuestions(kb, qs)
  if (input.db) {
    try { closeQuestionItem(input.db, q, input.by) } catch (err) { console.warn(`[kb-setup] decision queue: ${(err as Error).message}`) }
  }
  return q
}

// ── Overview for the UI / onboarding step ────────────────────────────────────

export interface SetupOverview {
  intake: { files: number; bytes: number; folder: string }
  active: RunListing | null
  last: RunListing | null
  runs: RunListing[]
  pages: Record<SectionKey, number>
  questions_open: number
  /** The onboarding step is done once a run finished and wrote at least one page. */
  step_done: boolean
}

export function setupOverview(kb: string): SetupOverview {
  const intake = listIntake(kb)
  const runs = listRuns(kb)
  const pages = Object.fromEntries(['people', 'companies', 'projects', 'decisions', 'processes', 'products', 'glossary', 'topics'].map(k => [k, 0])) as Record<SectionKey, number>
  for (const e of loadEntityIndex(kb).all) pages[sectionFor(e.type, tagsOfNote(kb, e.rel))]++
  const last = runs.find(r => r.status === 'done') ?? null
  return {
    intake: { files: intake.length, bytes: intake.reduce((s, f) => s + f.bytes, 0), folder: intakeRoot(kb) },
    active: runs.find(r => r.status === 'running' || r.status === 'paused') ?? null,
    last,
    runs: runs.slice(0, 20),
    pages,
    questions_open: readQuestions(kb).filter(q => q.status === 'open').length,
    step_done: !!last && ((last.summary?.created.length ?? 0) + (last.summary?.updated.length ?? 0) > 0 || runs.some(r => r.status === 'done' && (r.counts.done > 0))),
  }
}
