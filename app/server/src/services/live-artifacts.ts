/**
 * Live artifacts (obj 715699) — read-only, mid-run access to a card's objective
 * memory directory (`<OBJECTIVE_MEMORY_ROOT>/<id>/`): progress files, partial
 * outputs (`live/`, `work/`, …) and ARTIFACT.md.
 *
 * Masked by construction:
 *  - `NOTES.md` (the worker's private scratch). The same one-directional mask the
 *    AI reviewer gets (obj 707060): downstream readers see the deliverable and the
 *    partial outputs, never the worker's opinion of itself.
 *  - dotfiles/dot-dirs, symlinks (never followed), anything resolving outside the
 *    card's directory.
 * Text is served through `redactLive`; binaries are listed but not served.
 */
import fs from 'fs'
import path from 'path'
import { redactLive } from './live-redaction.js'

export const DEFAULT_MEMORY_ROOT = '/home/operator/ai-workspace/objective-memory'
export const SCRATCH_FILE = 'NOTES.md'
const MAX_LIST_ENTRIES = 500
const MAX_DEPTH = 6
export const MAX_READ_BYTES = 1_000_000
const BINARY_SNIFF_BYTES = 8192

export function memoryRoot(): string {
  // CC_OBJECTIVE_MEMORY_ROOT is the override prompt-builder-blocks already honours.
  return process.env.OBJECTIVE_MEMORY_ROOT || process.env.CC_OBJECTIVE_MEMORY_ROOT || DEFAULT_MEMORY_ROOT
}

export function objectiveMemoryDir(objectiveId: number): string {
  return path.join(memoryRoot(), String(objectiveId))
}

export interface ArtifactEntry {
  path: string
  size: number
  modified_at: string
  kind: 'text' | 'binary'
}

export class ArtifactError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

function sniff(file: string): 'text' | 'binary' {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES)
    const n = fs.readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0)
    return isBinary(buf.subarray(0, n)) ? 'binary' : 'text'
  } finally {
    fs.closeSync(fd)
  }
}

function hidden(name: string, isTop: boolean): boolean {
  return name.startsWith('.') || (isTop && name === SCRATCH_FILE)
}

export function listArtifacts(objectiveId: number): { entries: ArtifactEntry[]; truncated: boolean } {
  const base = objectiveMemoryDir(objectiveId)
  const entries: ArtifactEntry[] = []
  let truncated = false
  let baseStat: fs.Stats
  try { baseStat = fs.lstatSync(base) } catch { return { entries, truncated } }
  if (!baseStat.isDirectory()) return { entries, truncated }

  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > MAX_DEPTH) return
    let names: string[]
    try { names = fs.readdirSync(dir).sort() } catch { return }
    for (const name of names) {
      if (hidden(name, depth === 0)) continue
      const abs = path.join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      let st: fs.Stats
      try { st = fs.lstatSync(abs) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { walk(abs, relPath, depth + 1); continue }
      if (!st.isFile()) continue
      if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return }
      let kind: 'text' | 'binary' = 'text'
      try { kind = sniff(abs) } catch { continue }
      entries.push({ path: relPath, size: st.size, modified_at: st.mtime.toISOString(), kind })
    }
  }
  walk(base, '', 0)
  return { entries, truncated }
}

/** Resolve a caller-supplied relative path safely inside the card dir. Throws ArtifactError. */
export function resolveArtifactPath(objectiveId: number, relPath: unknown): string {
  if (typeof relPath !== 'string' || !relPath.trim()) throw new ArtifactError('path is required', 400)
  if (relPath.includes('\0') || path.isAbsolute(relPath) || relPath.includes('\\')) throw new ArtifactError('invalid path', 400)
  const segments = relPath.split('/').filter(s => s !== '' && s !== '.')
  if (segments.length === 0 || segments.some(s => s === '..')) throw new ArtifactError('invalid path', 400)
  if (segments.some(s => s.startsWith('.'))) throw new ArtifactError('not found', 404)
  if (segments.length === 1 && segments[0] === SCRATCH_FILE) {
    throw new ArtifactError(`${SCRATCH_FILE} is the worker's private scratch and is not served; read ARTIFACT.md or live/ outputs instead`, 403)
  }
  const base = objectiveMemoryDir(objectiveId)
  // Refuse symlinks at every level — never follow one out of the card dir.
  let cur = base
  for (const seg of segments) {
    cur = path.join(cur, seg)
    let st: fs.Stats
    try { st = fs.lstatSync(cur) } catch { throw new ArtifactError('not found', 404) }
    if (st.isSymbolicLink()) throw new ArtifactError('not found', 404)
  }
  const real = fs.realpathSync(cur)
  const realBase = fs.realpathSync(base)
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new ArtifactError('not found', 404)
  if (!fs.statSync(real).isFile()) throw new ArtifactError('not a file', 400)
  return real
}

export interface ArtifactRead {
  path: string
  size: number
  modified_at: string
  offset: number
  bytes: number
  truncated: boolean
  redaction_count: number
  content: string
}

export function readArtifact(
  objectiveId: number,
  relPath: unknown,
  opts: { offset?: number; maxBytes?: number; tailBytes?: number } = {},
): ArtifactRead {
  const abs = resolveArtifactPath(objectiveId, relPath)
  const st = fs.statSync(abs)
  const max = Math.max(1, Math.min(opts.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES))
  let offset = Math.max(0, opts.offset ?? 0)
  if (opts.tailBytes && opts.tailBytes > 0) offset = Math.max(0, st.size - Math.min(opts.tailBytes, MAX_READ_BYTES))
  const length = Math.max(0, Math.min(max, st.size - offset))
  const fd = fs.openSync(abs, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, offset)
  } finally {
    fs.closeSync(fd)
  }
  if (sniff(abs) === 'binary' || isBinary(buf)) throw new ArtifactError('binary file — listed but not served', 415)
  const { text, count } = redactLive(buf.toString('utf8'))
  return {
    path: (relPath as string).split('/').filter(s => s && s !== '.').join('/'),
    size: st.size,
    modified_at: st.mtime.toISOString(),
    offset,
    bytes: length,
    truncated: offset + length < st.size,
    redaction_count: count,
    content: text,
  }
}
