/**
 * Read-only, workspace-scoped file access policy for the public /api/files
 * surface (obj 715485). Bots can find and pull NON-markdown files (pptx, pdf,
 * key, images, spreadsheets…) on the VPS without SSH.
 *
 * Everything that decides "may this caller see this byte?" lives here so the
 * route stays thin and the policy is unit-testable on its own:
 *
 *   1. Root allowlist  — only paths under a configured root are ever reachable
 *                        (default-deny). Roots and paths are compared AFTER
 *                        realpath, so `..` and escaping symlinks are rejected.
 *   2. Denylist        — secrets/system paths are refused even inside a root.
 *   3. Workspace scope — admins see every root; a member sees only their
 *                        workspaces' subtrees plus the explicitly shared ones.
 *
 *   4. System roots    — (obj 715532) an explicit allowlist of service configs,
 *                        logs and crontabs. Text only (binaries need a per-root
 *                        allowlist), every byte redacted on the way out, `.env*`
 *                        served names-only. See getSystemRoots().
 *
 * Config (env, read on every call so tests and ops can flip it without code):
 *   CC_FILE_ROOTS          JSON [{id, path, kind}] — kind ∈ vault | uploads | admin
 *   CC_SYSTEM_FILE_ROOTS   JSON [{id, path, workspaces?, include?, binary_allow?, max_depth?}]
 *   CC_FILES_MAX_REDACT_BYTES  cap on a redacted (system) read (default 10 MB)
 *   CC_FILE_SHARED_PATHS   comma list of shared subtrees (visible to every member)
 *   CC_FILES_MAX_DOWNLOAD_BYTES  download size cap (default 200 MB)
 */
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { redactEnvFile, redactText } from './secret-redaction.js'

export type RootKind = 'vault' | 'uploads' | 'admin'

export interface FileRoot {
  id: string
  path: string
  /**
   * vault   — workspace subtrees are `<root>/workspaces/<slug>/`.
   * uploads — per-objective dirs `<root>/<objectiveId>/`; workspace = the objective's.
   * admin   — whole root is admin-only.
   */
  kind: RootKind
}

export const DEFAULT_FILE_ROOTS: FileRoot[] = [
  { id: 'vault', path: '/home/operator/second-brain', kind: 'vault' },
  { id: 'uploads', path: '/app/data/uploads', kind: 'uploads' },
]

export const DEFAULT_SHARED_PATHS = ['/home/operator/second-brain/shared']

export const DEFAULT_MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

export function getFileRoots(): FileRoot[] {
  const raw = process.env.CC_FILE_ROOTS
  if (!raw) return DEFAULT_FILE_ROOTS
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return DEFAULT_FILE_ROOTS
    return parsed
      .filter((r): r is FileRoot =>
        !!r && typeof r.id === 'string' && typeof r.path === 'string' && path.isAbsolute(r.path) &&
        ['vault', 'uploads', 'admin'].includes(r.kind))
  } catch {
    // A malformed override must not silently widen access — fall back to the
    // narrow built-in defaults rather than to "everything".
    return DEFAULT_FILE_ROOTS
  }
}

export function getSharedPaths(): string[] {
  const raw = process.env.CC_FILE_SHARED_PATHS
  if (raw === undefined) return DEFAULT_SHARED_PATHS
  return raw.split(',').map(s => s.trim()).filter(s => path.isAbsolute(s))
}

// ── System roots (obj 715532) ───────────────────────────────────────────────

export interface SystemRoot {
  id: string
  path: string
  /** Workspaces whose members may read this root. Empty/absent = admin only. */
  workspaces?: string[]
  /** Basename globs; when set, only matching files under the root are visible. */
  include?: string[]
  /** Extensions (no dot) of binary files that may be served raw. Default none. */
  binary_allow?: string[]
  /** Walk depth cap for search (default MAX_DEPTH). */
  max_depth?: number
}

/**
 * Built-in defaults: only paths the server container can actually see today.
 * Host-only paths (/etc/caddy, /etc/systemd/system, /var/spool/cron/crontabs,
 * /var/log) need a read-only mount + a CC_SYSTEM_FILE_ROOTS entry — see the PR.
 * A root whose path does not exist is silently skipped.
 */
export const DEFAULT_SYSTEM_ROOTS: SystemRoot[] = [
  { id: 'cc-config', path: '/home/operator/projects/operationkit/config' },
  {
    id: 'service-configs',
    path: '/home/operator/projects',
    include: [
      'docker-compose*.yml', 'docker-compose*.yaml', 'compose*.yml', 'compose*.yaml', 'Dockerfile*',
      'Caddyfile*', '*.caddy', 'nginx*.conf', '*.service', '*.timer', '*.path', '*.socket',
      'crontab*', '*.cron', '.env*',
    ],
    max_depth: 3,
  },
  { id: 'cc-logs', path: '/app/data/logs' },
  { id: 'crontabs', path: '/var/spool/cron/crontabs' },
]

export function getSystemRoots(): SystemRoot[] {
  const raw = process.env.CC_SYSTEM_FILE_ROOTS
  if (raw === undefined) return DEFAULT_SYSTEM_ROOTS
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r): r is SystemRoot =>
      !!r && typeof r.id === 'string' && typeof r.path === 'string' && path.isAbsolute(r.path) &&
      (r.workspaces === undefined || (Array.isArray(r.workspaces) && r.workspaces.every((w: unknown) => typeof w === 'string'))) &&
      (r.include === undefined || (Array.isArray(r.include) && r.include.every((g: unknown) => typeof g === 'string'))) &&
      (r.binary_allow === undefined || (Array.isArray(r.binary_allow) && r.binary_allow.every((g: unknown) => typeof g === 'string'))))
  } catch {
    // Malformed override → NO system roots (default-deny), never the defaults.
    return []
  }
}

export const DEFAULT_MAX_REDACT_BYTES = 10 * 1024 * 1024

export function getMaxRedactBytes(): number {
  const n = Number(process.env.CC_FILES_MAX_REDACT_BYTES)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_REDACT_BYTES
}

export function getMaxDownloadBytes(): number {
  const n = Number(process.env.CC_FILES_MAX_DOWNLOAD_BYTES)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_DOWNLOAD_BYTES
}

// ── Denylist ────────────────────────────────────────────────────────────────

/** Any path segment equal to one of these is refused (dirs AND files). */
const DENY_SEGMENTS = new Set([
  '.ssh', '.git', '.gnupg', '.aws', '.docker', '.kube', '.azure', '.config',
  'node_modules', '.claude-auth', '.secrets',
])

/** Absolute prefixes that are never served, even if a root is misconfigured over them. */
const DENY_PREFIXES = ['/etc', '/root', '/proc', '/sys', '/dev', '/var/run', '/run', '/boot']

const DENY_NAME_PATTERNS: RegExp[] = [
  /^\.env/i,                                  // .env, .env.local, .envrc
  /\.pem$/i, /\.p12$/i, /\.pfx$/i, /\.jks$/i, /\.keystore$/i, /\.kdbx$/i, /\.ppk$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,             // id_rsa, id_rsa.pub, id_ed25519…
  /^authorized_keys$/i, /^known_hosts$/i,
  /\.(db|sqlite|sqlite3|db-wal|db-shm|db-journal)$/i, // DB files (incl. WAL/SHM)
  /credential/i, /secret/i, /token/i, /passw(or)?d/i,
  /^\.netrc$/i, /^\.npmrc$/i, /^\.pgpass$/i, /^\.htpasswd$/i,
  /^\.secrets-master-key$/i,
]

/**
 * Under a SYSTEM root `/etc` is reachable (that is the point), but these never
 * are — not even with redaction: auth databases, host keys, TLS private keys.
 */
const SYSTEM_DENY_PREFIXES = [
  '/proc', '/sys', '/dev', '/root', '/boot', '/var/run', '/run',
  '/etc/shadow', '/etc/gshadow', '/etc/shadow-', '/etc/gshadow-', '/etc/sudoers', '/etc/sudoers.d',
  '/etc/ssh', '/etc/ssl/private', '/etc/letsencrypt', '/var/lib/docker', '/var/lib/postgresql',
]

/** The name denylist minus `.env*`, which system roots serve names-only instead. */
const SYSTEM_DENY_NAME_PATTERNS = DENY_NAME_PATTERNS.filter(re => re.source !== '^\\.env')

/** Denylist for paths inside a SYSTEM root. Stricter than "no /etc"; never weaker on keys/DBs/.ssh. */
export function isDeniedSystemPath(absPath: string): boolean {
  const norm = path.resolve(absPath)
  for (const p of SYSTEM_DENY_PREFIXES) {
    if (norm === p || norm.startsWith(p + path.sep)) return true
  }
  const segments = norm.split(path.sep).filter(Boolean)
  for (const seg of segments) {
    if (DENY_SEGMENTS.has(seg)) return true
  }
  const base = segments[segments.length - 1] ?? ''
  if (/^\.env/i.test(base)) {
    // `.env.example` style names are fine; but a key/cert that happens to start
    // with .env is still refused by the shared patterns below.
    return SYSTEM_DENY_NAME_PATTERNS.some(re => re.test(base.replace(/^\.env/i, '')))
  }
  return SYSTEM_DENY_NAME_PATTERNS.some(re => re.test(base))
}

export function isEnvFileName(name: string): boolean {
  return /^\.env/i.test(name) || /\.env$/i.test(name)
}

/** Lexical denylist check over every segment of an absolute (already real) path. */
export function isDeniedPath(absPath: string): boolean {
  const norm = path.resolve(absPath)
  for (const p of DENY_PREFIXES) {
    if (norm === p || norm.startsWith(p + path.sep)) return true
  }
  const segments = norm.split(path.sep).filter(Boolean)
  for (const seg of segments) {
    if (DENY_SEGMENTS.has(seg)) return true
  }
  const base = segments[segments.length - 1] ?? ''
  return DENY_NAME_PATTERNS.some(re => re.test(base))
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

function readHead(absPath: string, n = 64): Buffer {
  const fd = fs.openSync(absPath, 'r')
  try {
    const buf = Buffer.alloc(n)
    const read = fs.readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Content check for things the name alone can't settle:
 *  - `.key` is served ONLY when it is a Keynote package (a ZIP: `PK\x03\x04`).
 *    A PEM/DER private key named `foo.key` is refused.
 *  - Any file whose head is a PEM private-key block is refused whatever its name.
 */
export function isDeniedContent(absPath: string): boolean {
  let head: Buffer
  try {
    head = readHead(absPath)
  } catch {
    return true // unreadable → don't serve
  }
  const ext = path.extname(absPath).toLowerCase()
  if (ext === '.key' && !(head.length >= 4 && head.subarray(0, 4).equals(ZIP_MAGIC))) return true
  const text = head.toString('latin1')
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text)) return true
  if (text.startsWith('-----BEGIN') && /KEY/.test(text)) return true
  return false
}

// ── Scope ───────────────────────────────────────────────────────────────────

export interface ScopeEntry {
  /** realpath of the visible subtree */
  prefix: string
  rootId: string
  /** workspace label for results under this prefix ('shared' / null for admin-wide) */
  workspace: string | null
  /** Set when this entry is a SYSTEM root (redacted, text-only reads). */
  system?: SystemRoot
}

export interface Scope {
  isAdmin: boolean
  entries: ScopeEntry[]
}

function real(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}

/** Workspace of an upload dir `<uploads>/<objectiveId>/…`. */
function uploadsWorkspaceMap(ids: number[]): Map<number, string> {
  const out = new Map<number, string>()
  if (ids.length === 0) return out
  const db = getDb()
  const stmt = db.prepare('SELECT id, workspace FROM objectives WHERE id = ?')
  for (const id of ids) {
    const row = stmt.get(id) as { id: number; workspace: string } | undefined
    if (row) out.set(row.id, row.workspace)
  }
  return out
}

function listUploadObjectiveIds(uploadsReal: string): number[] {
  try {
    return fs.readdirSync(uploadsReal, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
      .map(d => Number(d.name))
  } catch {
    return []
  }
}

/**
 * Build the visible scope for a caller.
 * @param isAdmin     admin sees every configured root.
 * @param workspaces  the caller's workspace memberships.
 * @param only        optional ?workspace= narrowing (already membership-checked).
 */
export function buildScope(isAdmin: boolean, workspaces: string[], only?: string): Scope {
  const entries: ScopeEntry[] = []
  const wsSet = new Set(only ? [only] : workspaces)
  const shared = getSharedPaths().map(real).filter((p): p is string => !!p)

  for (const root of getFileRoots()) {
    const rootReal = real(root.path)
    if (!rootReal || isDeniedPath(rootReal)) continue

    if (isAdmin && !only) {
      entries.push({ prefix: rootReal, rootId: root.id, workspace: null })
      continue
    }
    if (root.kind === 'admin') continue

    if (root.kind === 'vault') {
      for (const ws of wsSet) {
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(ws)) continue
        const sub = real(path.join(rootReal, 'workspaces', ws))
        if (sub && isUnder(sub, rootReal)) entries.push({ prefix: sub, rootId: root.id, workspace: ws })
      }
    } else if (root.kind === 'uploads') {
      const ids = listUploadObjectiveIds(rootReal)
      const wsOf = uploadsWorkspaceMap(ids)
      for (const id of ids) {
        const ws = wsOf.get(id)
        if (!ws || !wsSet.has(ws)) continue
        const sub = real(path.join(rootReal, String(id)))
        if (sub && isUnder(sub, rootReal)) entries.push({ prefix: sub, rootId: root.id, workspace: ws })
      }
    }

    // Explicitly shared subtrees inside this root — visible to every member.
    for (const s of shared) {
      if (isUnder(s, rootReal)) entries.push({ prefix: s, rootId: root.id, workspace: 'shared' })
    }
  }

  // System roots: admin sees all of them; a member only those tagged with one of
  // their workspaces. ?workspace=X narrows both to roots tagged X.
  for (const sys of getSystemRoots()) {
    const rootReal = real(sys.path)
    if (!rootReal || isDeniedSystemPath(rootReal)) continue
    const tagged = (sys.workspaces ?? []).filter(w => wsSet.has(w))
    if (isAdmin && !only) entries.push({ prefix: rootReal, rootId: sys.id, workspace: 'system', system: sys })
    else if (tagged.length) entries.push({ prefix: rootReal, rootId: sys.id, workspace: tagged[0], system: sys })
  }
  return { isAdmin, entries }
}

/** Does `absPath` pass a system root's `include` globs (basename match)? */
function passesInclude(absPath: string, sys: SystemRoot): boolean {
  if (!sys.include || sys.include.length === 0) return true
  const base = path.basename(absPath)
  return sys.include.some(g => globToRegExp(g).test(base))
}

/** The scope entry (longest prefix) a path lexically falls under, before realpath. */
function lexicalEntry(absPath: string, scope: Scope): ScopeEntry | null {
  const norm = path.resolve(absPath)
  let best: ScopeEntry | null = null
  for (const e of scope.entries) {
    if (isUnder(norm, e.prefix) && (!best || e.prefix.length > best.prefix.length)) best = e
  }
  return best
}

function deniedFor(absPath: string, entry: ScopeEntry | null): boolean {
  return entry?.system ? isDeniedSystemPath(absPath) : isDeniedPath(absPath)
}

/** Best workspace label for a path the caller can see (longest matching prefix wins). */
function labelFor(absReal: string, scope: Scope): ScopeEntry | null {
  let best: ScopeEntry | null = null
  for (const e of scope.entries) {
    if (isUnder(absReal, e.prefix) && (!best || e.prefix.length > best.prefix.length)) best = e
  }
  if (!best) return null
  if (best.system) return passesInclude(absReal, best.system) ? best : null
  if (best.workspace !== null) return best
  // Admin-wide entry: derive a label from the layout so results still say which workspace.
  const root = getFileRoots().find(r => r.id === best!.rootId)
  if (root?.kind === 'vault') {
    const rel = path.relative(best.prefix, absReal).split(path.sep)
    if (rel[0] === 'workspaces' && rel[1]) return { ...best, workspace: rel[1] }
    if (rel[0] === 'shared') return { ...best, workspace: 'shared' }
  } else if (root?.kind === 'uploads') {
    const rel = path.relative(best.prefix, absReal).split(path.sep)
    if (/^\d+$/.test(rel[0] ?? '')) {
      const ws = uploadsWorkspaceMap([Number(rel[0])]).get(Number(rel[0]))
      if (ws) return { ...best, workspace: ws }
    }
  }
  return best
}

export type ResolveError = 'bad_path' | 'not_found' | 'forbidden' | 'denied' | 'not_file' | 'binary'

/**
 * How bytes may leave the server:
 *   raw     — streamed as-is (vault/uploads, or an allowlisted system binary)
 *   redact  — system text: known values + patterns replaced
 *   env     — system `.env*`: KEY=[REDACTED], names only
 */
export type ServeMode = 'raw' | 'redact' | 'env'

export interface ResolvedFile {
  path: string
  rootId: string
  workspace: string | null
  stat: fs.Stats
  mode: ServeMode
  system: boolean
}

/** NUL byte in the first 8 KB ⇒ binary. Redaction is impossible on binaries. */
export function looksBinary(absPath: string): boolean {
  try {
    return readHead(absPath, 8192).includes(0)
  } catch {
    return true
  }
}

/**
 * Resolve a caller-supplied path to a servable regular file, or say why not.
 * Order matters: realpath FIRST, so `..` segments and symlinks are judged by
 * where they actually land, never by how the string looks.
 */
export function resolveFile(requested: unknown, scope: Scope): ResolvedFile | { error: ResolveError } {
  if (typeof requested !== 'string' || !requested || requested.includes('\0') || !path.isAbsolute(requested)) {
    return { error: 'bad_path' }
  }
  // Lexical denylist on the requested string too — a denied name is refused
  // before we even touch the filesystem (no existence oracle for secrets).
  // Which denylist applies depends on the root the string claims to be under.
  if (deniedFor(requested, lexicalEntry(requested, scope))) return { error: 'denied' }
  const abs = real(requested)
  if (!abs) return { error: 'not_found' }
  const entry = labelFor(abs, scope)
  if (!entry) return { error: 'forbidden' }
  // Re-judge by where the path REALLY landed (a symlink from a system root into
  // the vault gets vault rules, and vice versa).
  if (deniedFor(abs, entry)) return { error: 'denied' }
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return { error: 'not_found' }
  }
  if (!stat.isFile()) return { error: 'not_file' }
  if (isDeniedContent(abs)) return { error: 'denied' }
  let mode: ServeMode = 'raw'
  if (entry.system) {
    const ext = path.extname(abs).slice(1).toLowerCase()
    if (isEnvFileName(path.basename(abs))) mode = 'env'
    else if (looksBinary(abs)) {
      if (!(entry.system.binary_allow ?? []).map(e => e.toLowerCase().replace(/^\./, '')).includes(ext)) return { error: 'binary' }
      mode = 'raw'
    } else mode = 'redact'
  }
  return { path: abs, rootId: entry.rootId, workspace: entry.workspace, stat, mode, system: !!entry.system }
}

/**
 * Read a system file for serving, redacted. `tailBytes` reads only the end of
 * the file (logs) and drops the first partial line so a secret is never cut
 * in half past the redactor.
 */
export function readRedacted(file: ResolvedFile, opts: { tailBytes?: number; maxBytes?: number } = {}): { text: string; count: number; truncatedHead: boolean } {
  const size = file.stat.size
  let start = 0
  if (opts.tailBytes && opts.tailBytes < size) start = size - opts.tailBytes
  const len = Math.min(size - start, opts.maxBytes ?? size)
  const fd = fs.openSync(file.path, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, start)
  } finally {
    fs.closeSync(fd)
  }
  let raw = buf.toString('utf-8')
  if (start > 0) {
    const nl = raw.indexOf('\n')
    raw = nl >= 0 ? raw.slice(nl + 1) : ''
  }
  if (opts.maxBytes !== undefined && start + len < size) {
    // Preview: never end mid-line for the same reason.
    const nl = raw.lastIndexOf('\n')
    raw = nl >= 0 ? raw.slice(0, nl + 1) : ''
  }
  const r = file.mode === 'env' ? redactEnvFile(raw) : redactText(raw)
  return { text: r.text, count: r.count, truncatedHead: start > 0 }
}

/** Is a directory/file path inside the caller's scope (after realpath)? */
export function inScope(absPath: string, scope: Scope): boolean {
  const r = real(absPath)
  return !!r && labelFor(r, scope) !== null
}

// ── Types / MIME ────────────────────────────────────────────────────────────

export const MIME_BY_EXT: Record<string, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  key: 'application/vnd.apple.keynote',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pages: 'application/vnd.apple.pages',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  numbers: 'application/vnd.apple.numbers',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  odt: 'application/vnd.oasis.opendocument.text',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  zip: 'application/zip',
}

/** `?type=` groups → extension sets. A bare extension also works as a type. */
export const TYPE_GROUPS: Record<string, string[]> = {
  presentation: ['pptx', 'ppt', 'key', 'odp'],
  document: ['pdf', 'docx', 'doc', 'pages', 'odt', 'rtf', 'txt'],
  spreadsheet: ['xlsx', 'xls', 'numbers', 'ods', 'csv', 'tsv'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'tif', 'tiff', 'bmp'],
  video: ['mp4', 'mov'],
  audio: ['mp3', 'm4a', 'wav'],
  archive: ['zip'],
}

export function mimeFor(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface SearchFilters {
  q?: string
  glob?: string
  exts?: Set<string>
  pathPrefix?: string
  modifiedAfter?: number
  modifiedBefore?: number
  /** Walk system roots too (obj 715532). Off by default so #533 searches are unchanged. */
  includeSystem?: boolean
  /** Restrict to these root ids. Naming a system root implies includeSystem for it. */
  rootIds?: Set<string>
  /** Case-insensitive content match over the REDACTED text of system files. */
  content?: string
}

export interface FileSnippet {
  line: number
  text: string
}

export interface FileHit {
  path: string
  name: string
  size: number
  mime: string
  mtime: string
  workspace: string | null
  root: string
  /** true when reads of this file are redacted server-side (system roots). */
  redacted?: boolean
  /** Content matches, already redacted (only with `content`). */
  snippets?: FileSnippet[]
}

const CONTENT_SEARCH_MAX_BYTES = 2 * 1024 * 1024
const MAX_SNIPPETS = 3
const SNIPPET_CHARS = 240

/**
 * Content search runs on the REDACTED text, never the raw bytes: matching raw
 * content would let a caller confirm a guessed secret value by whether a file
 * hits ("search oracle"), even though the snippet itself is redacted.
 */
function contentSnippets(file: ResolvedFile, needle: string): FileSnippet[] {
  if (file.stat.size > CONTENT_SEARCH_MAX_BYTES) return []
  const { text } = readRedacted(file)
  const lower = needle.toLowerCase()
  const out: FileSnippet[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && out.length < MAX_SNIPPETS; i++) {
    if (lines[i].toLowerCase().includes(lower)) out.push({ line: i + 1, text: lines[i].slice(0, SNIPPET_CHARS) })
  }
  return out
}

const WALK_SKIP_DIRS = new Set(['.obsidian', '.cache', '.trash', 'dist', '.next', '.vite'])
const MAX_DEPTH = 16
const MAX_ENTRIES_SCANNED = 100_000

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${esc}$`, 'i')
}

/**
 * Walk the caller's scope and collect matching regular files.
 * Symlinked DIRECTORIES are never followed (loops / escapes); a symlinked FILE
 * is kept only if its realpath lands inside the caller's scope.
 */
export function searchFiles(scope: Scope, f: SearchFilters): { hits: FileHit[]; truncated: boolean } {
  const q = f.q?.toLowerCase()
  const globRe = f.glob ? globToRegExp(f.glob) : null
  let prefixReal: string | null = null
  if (f.pathPrefix) {
    prefixReal = real(f.pathPrefix)
    if (!prefixReal) return { hits: [], truncated: false }
  }

  // Start points: each scope entry, narrowed to the prefix when one is given.
  const starts: ScopeEntry[] = []
  for (const e of scope.entries) {
    if (f.rootIds && !f.rootIds.has(e.rootId)) continue
    if (e.system && !f.includeSystem && !f.rootIds?.has(e.rootId)) continue
    // Content search is a system-root feature (redacted text); other roots hold binaries.
    if (f.content && !e.system) continue
    if (!prefixReal) starts.push(e)
    else if (isUnder(prefixReal, e.prefix)) starts.push({ ...e, prefix: prefixReal })
    else if (isUnder(e.prefix, prefixReal)) starts.push(e)
  }
  // Drop starts nested inside another start so nothing is walked twice.
  starts.sort((a, b) => a.prefix.length - b.prefix.length)
  const roots: ScopeEntry[] = []
  for (const s of starts) {
    // A system root with include globs / a depth cap does not fully cover a
    // nested root, so only collapse into an unrestricted outer start.
    if (!roots.some(r => isUnder(s.prefix, r.prefix) && !r.system?.include && !r.system?.max_depth)) roots.push(s)
  }

  const hits: FileHit[] = []
  const seen = new Set<string>()
  let scanned = 0
  let truncated = false

  const consider = (abs: string, name: string) => {
    if (seen.has(abs)) return
    if (q && !name.toLowerCase().includes(q)) return
    if (globRe && !globRe.test(name)) return
    if (f.exts && !f.exts.has(path.extname(name).slice(1).toLowerCase())) return
    const lex = labelFor(abs, scope)
    if (!lex || deniedFor(abs, lex)) return
    if (lex.system && f.rootIds && !f.rootIds.has(lex.rootId)) return
    if (lex.system && !f.includeSystem && !f.rootIds?.has(lex.rootId)) return
    if (f.content && !lex.system) return
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      return
    }
    if (!st.isFile()) return
    const m = st.mtimeMs
    if (f.modifiedAfter !== undefined && m < f.modifiedAfter) return
    if (f.modifiedBefore !== undefined && m > f.modifiedBefore) return
    if (path.extname(name).toLowerCase() === '.key' && isDeniedContent(abs)) return
    const entry = lex
    let snippets: FileSnippet[] | undefined
    if (entry.system) {
      // Same gate as download: unservable binaries and PEM-headed files never list.
      const resolved = resolveFile(abs, scope)
      if ('error' in resolved) return
      if (f.content) {
        if (resolved.mode === 'raw') return
        snippets = contentSnippets(resolved, f.content)
        if (snippets.length === 0) return
      }
    }
    seen.add(abs)
    hits.push({
      path: abs,
      name,
      size: st.size,
      mime: mimeFor(name),
      mtime: st.mtime.toISOString(),
      workspace: entry.workspace,
      root: entry.rootId,
      ...(entry.system ? { redacted: true } : {}),
      ...(snippets ? { snippets } : {}),
    })
  }

  const walk = (dir: string, depth: number, maxDepth: number) => {
    if (depth > maxDepth || truncated) return
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (++scanned > MAX_ENTRIES_SCANNED) {
        truncated = true
        return
      }
      const full = path.join(dir, d.name)
      if (d.isSymbolicLink()) {
        const target = real(full)
        if (!target) continue
        // Escaping symlinks are dropped; in-scope symlinked files are reported
        // at their real path. Symlinked dirs are never descended.
        if (!labelFor(target, scope)) continue
        try {
          if (fs.statSync(target).isFile()) consider(target, path.basename(target))
        } catch { /* dangling */ }
        continue
      }
      if (d.isDirectory()) {
        if (DENY_SEGMENTS.has(d.name) || WALK_SKIP_DIRS.has(d.name)) continue
        walk(full, depth + 1, maxDepth)
      } else if (d.isFile()) {
        consider(full, d.name)
      }
    }
  }

  for (const r of roots) {
    if (deniedFor(r.prefix, r)) continue
    walk(r.prefix, 0, r.system?.max_depth ?? MAX_DEPTH)
  }
  hits.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : a.path.localeCompare(b.path)))
  return { hits, truncated }
}

// ── Rate limit ──────────────────────────────────────────────────────────────

const buckets = new Map<string, { count: number; resetAt: number }>()

/** Fixed-window limiter, in-memory per process. Returns retry-after seconds when blocked. */
export function rateLimit(key: string, limit: number, windowMs = 60_000, now = Date.now()): number | null {
  const b = buckets.get(key)
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return null
  }
  if (b.count >= limit) return Math.max(1, Math.ceil((b.resetAt - now) / 1000))
  b.count++
  return null
}

export function resetRateLimits(): void {
  buckets.clear()
}
