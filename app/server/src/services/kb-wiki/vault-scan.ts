import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { isProtectedPath } from './paths.js'
import { kindFor, pageRoots } from './wiki.js'

/**
 * Which markdown files of a workspace's knowledge base the link graph indexes
 * (obj 900815).
 *
 * The graph used to read only the compiled wiki's folders (people/,
 * organizations/, projects/, topics/, sources/, answers/ …). A real vault
 * keeps most of its knowledge elsewhere — decisions/, architecture/, prds/,
 * runbooks/, whatever the team made — so the Graph showed a handful of pages
 * and no connections. Now EVERY markdown file under the workspace's knowledge
 * folder is a node, except:
 *
 *   - raw sources and machine state (`isProtectedPath`: raw/, sources/files/,
 *     sources/inbox/, .kb-wiki/) — the wiki never reads them either;
 *   - anything hidden (a path segment starting with "."), which covers .git,
 *     .env*, .obsidian, .trash …;
 *   - folders and files that hold credentials (`isNeverIndexed`), whatever the
 *     exclude list says — that rule cannot be configured away;
 *   - the configurable exclude list (`kb_graph_exclude` setting, default
 *     `DEFAULT_GRAPH_EXCLUDES`): archives, scratch folders, vendored trees;
 *   - another workspace's knowledge folder nested inside this one (`skipAbs`),
 *     so per-workspace scoping holds even when one workspace's folder is a
 *     parent of another's.
 *
 * Nothing here is install-specific: the walk is relative to whatever folder
 * `workspaceKbRoot()` returns.
 */

/** Folder names (any depth) or KB-relative path prefixes left out unless the operator changes the list. */
export const DEFAULT_GRAPH_EXCLUDES = ['archive', 'archives', '_archive', 'tmp', 'temp', 'node_modules', 'trash'] as const

/** Folder names that hold credentials. Never indexed, at any depth, whatever the exclude list says. */
const SECRET_DIRS = new Set(['secrets', 'secret', 'credentials', 'creds', 'keys', 'private-keys', 'env'])

/**
 * A markdown FILE whose whole name says it is a credential store
 * (`secrets.md`, `credentials.md`, `api-keys.md`, `foo.env.md`, `passwords.md`).
 * Narrow on purpose: a decision doc ABOUT secrets management is knowledge and
 * stays in the graph; only the stem itself being a credential noun is refused.
 */
const SECRET_FILE_RE = /^(?:secrets?|credentials?|creds|passwords?|tokens?|api[-_ ]?keys?|private[-_ ]?keys?|keys|env)$|\.(?:env|secrets?|credentials?)$/i

/** True for a KB-relative path the graph must never read: hidden, raw/state, or a credential store. */
export function isNeverIndexed(rel: string): boolean {
  const r = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!r || isProtectedPath(r)) return true
  const segs = r.split('/')
  if (segs.some(s => !s || s.startsWith('.') || s === '..')) return true
  if (segs.slice(0, -1).some(s => SECRET_DIRS.has(s.toLowerCase()))) return true
  const stem = segs[segs.length - 1].replace(/\.md$/i, '')
  return SECRET_FILE_RE.test(stem)
}

/** Normalise an exclude list: trimmed, no leading "./" or "/", no trailing "/", lowercase, deduped. */
export function normaliseExcludes(list: readonly string[]): string[] {
  const out = new Set<string>()
  for (const raw of list) {
    const e = raw.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '').toLowerCase()
    if (e && !e.split('/').includes('..')) out.add(e)
  }
  return [...out]
}

/** Parse the stored setting (newline- or comma-separated). Missing → the defaults; blank → exclude nothing. */
export function parseExcludeSetting(v: string | null | undefined): string[] {
  if (v == null) return [...DEFAULT_GRAPH_EXCLUDES]
  if (!v.trim()) return []
  return normaliseExcludes(v.split(/[\n,]/))
}

/**
 * True when a KB-relative path matches the exclude list. An entry with no "/"
 * is a folder NAME and matches at any depth (`archive` drops `decisions/archive/x.md`);
 * an entry with a "/" is a KB-relative prefix (`decisions/2024` drops that folder only).
 */
export function isExcluded(rel: string, excludes: readonly string[]): boolean {
  const r = rel.replace(/\\/g, '/').toLowerCase()
  const dirs = r.split('/').slice(0, -1)
  for (const e of excludes) {
    if (!e.includes('/')) { if (dirs.includes(e)) return true }
    else if (r === e || r.startsWith(`${e}/`)) return true
  }
  return false
}

export interface VaultScanOptions {
  /** Exclude list (already normalised); defaults to DEFAULT_GRAPH_EXCLUDES. */
  excludes?: readonly string[]
  /** Absolute folders inside the KB never to enter (other workspaces' knowledge folders). */
  skipAbs?: readonly string[]
  /** Hard cap on files, so a mis-pointed root (a whole home dir) cannot stall the server. */
  maxFiles?: number
}

export const MAX_VAULT_FILES = 20_000

export interface VaultFile { rel: string; size: number; mtimeMs: number }

/**
 * Every indexable markdown file under `kbRoot`, sorted by path, with size and
 * modified time (the signature and the parse cache key). Symlinked folders are
 * followed only when they resolve INSIDE `kbRoot`; nothing outside is read.
 */
export function listVaultMarkdown(kbRoot: string, opts: VaultScanOptions = {}): VaultFile[] {
  const excludes = opts.excludes ?? DEFAULT_GRAPH_EXCLUDES
  const max = opts.maxFiles ?? MAX_VAULT_FILES
  let rootReal: string
  try { rootReal = fs.realpathSync(kbRoot) } catch { return [] }
  const skip = new Set<string>()
  for (const s of opts.skipAbs ?? []) {
    try { skip.add(fs.realpathSync(s)) } catch { skip.add(path.resolve(s)) }
  }
  const out: VaultFile[] = []
  const seenDirs = new Set<string>()
  const inside = (real: string) => real === rootReal || real.startsWith(`${rootReal}${path.sep}`)

  const walk = (rel: string) => {
    if (out.length >= max) return
    const abs = rel ? path.join(kbRoot, rel) : kbRoot
    let real: string
    try { real = fs.realpathSync(abs) } catch { return }
    if (!inside(real) || seenDirs.has(real) || (rel && skip.has(real))) return
    seenDirs.add(real)
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { return }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of ents) {
      if (out.length >= max) return
      if (e.name.startsWith('.')) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (e.isSymbolicLink()) {
        try {
          const target = fs.realpathSync(path.join(kbRoot, r))
          if (!inside(target)) continue
          const st = fs.statSync(target)
          isDir = st.isDirectory()
          isFile = st.isFile()
        } catch { continue }
      }
      if (isDir) {
        if (isNeverIndexed(`${r}/x.md`) || isExcluded(`${r}/x.md`, excludes)) continue
        walk(r)
      } else if (isFile && e.name.toLowerCase().endsWith('.md')) {
        if (isNeverIndexed(r) || isExcluded(r, excludes)) continue
        try {
          const st = fs.statSync(path.join(kbRoot, r))
          out.push({ rel: r, size: st.size, mtimeMs: st.mtimeMs })
        } catch { /* vanished */ }
      }
    }
  }
  walk('')
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** Content signature over a listing + the options that shaped it. No file is read. */
export function vaultSignature(files: readonly VaultFile[], opts: VaultScanOptions = {}): string {
  const h = crypto.createHash('sha1')
  h.update(`v2\0${(opts.excludes ?? DEFAULT_GRAPH_EXCLUDES).join(',')}\0${[...(opts.skipAbs ?? [])].sort().join(',')}\n`)
  for (const f of files) h.update(`${f.rel}\0${f.size}\0${f.mtimeMs}\n`)
  return h.digest('hex')
}

/** "decisions" → "decision", "prds" → "prd", "policies" → "policy", "Run Books" → "run-book". */
export function singularKind(folder: string): string {
  let k = folder.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!k) return 'note'
  if (/[^aeiou]ies$/.test(k)) k = `${k.slice(0, -3)}y`
  else if (/(ss|us|is)$/.test(k)) { /* "process", "status", "analysis" stay */ }
  else if (/(x|ch|sh|ss)es$/.test(k)) k = k.slice(0, -2)
  else if (k.length > 3 && k.endsWith('s')) k = k.slice(0, -1)
  return k
}

/**
 * Graph node kind for a KB-relative path. Pages in the compiled wiki's own
 * folders keep the wiki's kind (person, organization, project, source,
 * answer …). Any other top-level folder names its own kind, singular
 * (decisions/ → decision, audits/ → audit, prds/ → prd, runbooks/ → runbook).
 * A file at the top of the knowledge folder is a `note`.
 */
export function graphKindFor(rel: string): string {
  const segs = rel.replace(/\\/g, '/').split('/')
  if (segs.length < 2) return 'note'
  if (pageRoots().includes(segs[0])) return kindFor(rel)
  return singularKind(segs[0])
}
