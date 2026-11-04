/**
 * Workspace knowledge-base usage guide injected into the MCP handshake.
 *
 * An install teaches every connected agent when to read and write the knowledge
 * base and the board by dropping a markdown file in each workspace's knowledge
 * folder. The conventional path is `topics/agent-kb-usage-guide.md` (so a vault
 * layout file is `workspaces/<slug>/topics/agent-kb-usage-guide.md`). Nothing
 * is injected when that file is missing: the stock server instructions stay
 * byte-for-byte the same.
 *
 * The path is configurable, per workspace then per install:
 *   1. settings key `mcp_kb_guide_path:<slug>` (value `off` disables that workspace)
 *   2. env `CC_MCP_KB_GUIDE_PATH` (relative path, or `off` to disable the default)
 *   3. `topics/agent-kb-usage-guide.md`
 * An empty or unsafe value (absolute, `..`, not `*.md`) is ignored and the next
 * source applies. The resolved file is read only from inside that workspace's
 * knowledge folder (`vault_path`, else the install's default workspace folder).
 * A symlink that leaves the folder is skipped.
 *
 * Which workspaces are considered is the key's allowlist when it has one, else
 * every workspace for an admin, else the caller's memberships. Archived
 * workspaces are left out. The guide is connection text, not a vault read, so
 * a key without `vault:read` still receives it — do not put secrets in the file.
 */
import fs from 'fs'
import path from 'path'
import { getDb } from '../db/index.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { getWorkspaceSlugs } from './workspaces.js'
import { knowledgeBaseRoot, workspaceKbRoot } from './doc-ingest/kb-paths.js'

export const DEFAULT_KB_GUIDE_REL = 'topics/agent-kb-usage-guide.md'
export const KB_GUIDE_ENV = 'CC_MCP_KB_GUIDE_PATH'
export const KB_GUIDE_SETTING_PREFIX = 'mcp_kb_guide_path:'
export const KB_GUIDE_PROMPT = 'kb_usage_guide'
export const KB_GUIDE_URI_PREFIX = 'operationkit://kb-guide/'

/** Per-workspace cap on the text appended to `initialize` instructions. */
export const KB_GUIDE_PER_WORKSPACE_CHARS = 4_000
/** Cap across every workspace's guide in one `initialize` response. */
export const KB_GUIDE_TOTAL_CHARS = 8_000
/** Hard read cap so a huge file cannot be pulled into the process. */
export const KB_GUIDE_READ_CAP_BYTES = 64 * 1024
/** Explicit prompt/resource reads may be longer than the handshake appendix. */
export const KB_GUIDE_EXPLICIT_CHARS = 20_000

const OFF_VALUES = new Set(['off', 'none', 'disabled', '-'])

export type GuideRel =
  | { kind: 'unset' }
  | { kind: 'off' }
  | { kind: 'path'; rel: string }
  | { kind: 'invalid' }

export interface McpCaller {
  user?: { id: number; role: string }
  agentKey?: { workspaces: string[] | null } | null
}

export interface LoadedGuide {
  workspace: string
  /** Path inside the knowledge base, e.g. workspaces/example/topics/agent-kb-usage-guide.md */
  displayPath: string
  absolutePath: string
  content: string
  fileTruncated: boolean
}

/** Accept only a relative `*.md` path that cannot leave the workspace folder. */
export function normalizeGuideRel(raw: string | undefined | null): GuideRel {
  if (raw == null) return { kind: 'unset' }
  const s = raw.trim()
  if (!s) return { kind: 'unset' }
  if (OFF_VALUES.has(s.toLowerCase())) return { kind: 'off' }
  if (s.includes('\0') || s.length > 240) return { kind: 'invalid' }
  if (path.isAbsolute(s) || path.win32.isAbsolute(s)) return { kind: 'invalid' }
  const parts = s.split(/[/\\]+/).filter(Boolean)
  if (parts.length === 0 || parts.some(p => p === '.' || p === '..')) return { kind: 'invalid' }
  const rel = parts.join('/')
  if (!rel.toLowerCase().endsWith('.md')) return { kind: 'invalid' }
  return { kind: 'path', rel }
}

function readSetting(key: string): string | undefined {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  } catch {
    return undefined
  }
}

/**
 * Relative guide path for one workspace, or null when this workspace is off
 * (or the install default is off and the workspace has no override).
 */
export function guideRelForWorkspace(workspace: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const setting = normalizeGuideRel(readSetting(KB_GUIDE_SETTING_PREFIX + workspace))
  if (setting.kind === 'off') return null
  if (setting.kind === 'path') return setting.rel
  const fromEnv = normalizeGuideRel(env[KB_GUIDE_ENV])
  if (fromEnv.kind === 'off') return null
  if (fromEnv.kind === 'path') return fromEnv.rel
  return DEFAULT_KB_GUIDE_REL
}

/** Read a guide file that stays inside `root` after symlink resolution. */
export function readGuideFile(root: string, rel: string): { absolutePath: string; content: string; fileTruncated: boolean } | null {
  const parsed = normalizeGuideRel(rel)
  if (parsed.kind !== 'path') return null
  let rootReal: string
  try { rootReal = fs.realpathSync(root) } catch { return null }
  const abs = path.resolve(rootReal, parsed.rel)
  if (abs !== rootReal && !abs.startsWith(rootReal + path.sep)) return null
  let real: string
  try { real = fs.realpathSync(abs) } catch { return null }
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return null
  let stat: fs.Stats
  try { stat = fs.statSync(real) } catch { return null }
  if (!stat.isFile() || stat.size === 0) return null
  let fh: number | undefined
  try {
    fh = fs.openSync(real, 'r')
    const toRead = Math.min(stat.size, KB_GUIDE_READ_CAP_BYTES)
    const buf = Buffer.alloc(toRead)
    let off = 0
    while (off < toRead) {
      const n = fs.readSync(fh, buf, off, toRead - off, off)
      if (n <= 0) break
      off += n
    }
    if (buf.subarray(0, off).includes(0)) return null
    let content = buf.subarray(0, off).toString('utf8')
    if (stat.size > KB_GUIDE_READ_CAP_BYTES) content = content.replace(/\uFFFD$/, '')
    content = content.replace(/^\uFEFF/, '').trim()
    if (!content) return null
    return { absolutePath: real, content, fileTruncated: stat.size > KB_GUIDE_READ_CAP_BYTES }
  } catch {
    return null
  } finally {
    if (fh !== undefined) {
      try { fs.closeSync(fh) } catch { /* already gone */ }
    }
  }
}

/** Knowledge-base-relative path when the folder sits inside the KB; otherwise the conventional vault path. */
export function displayPathFor(workspace: string, rel: string, root: string): string {
  try {
    const fromKb = path.relative(knowledgeBaseRoot(), path.resolve(root, rel))
    if (fromKb && !fromKb.startsWith('..') && !path.isAbsolute(fromKb)) {
      return fromKb.split(path.sep).join('/')
    }
  } catch { /* fall through to the conventional path */ }
  return ['workspaces', workspace, rel].join('/')
}

export function kbGuideUri(workspace: string): string {
  return `${KB_GUIDE_URI_PREFIX}${encodeURIComponent(workspace)}`
}

export function workspaceFromKbGuideUri(uri: string): string | null {
  if (!uri.startsWith(KB_GUIDE_URI_PREFIX)) return null
  let slug: string
  try { slug = decodeURIComponent(uri.slice(KB_GUIDE_URI_PREFIX.length)) } catch { return null }
  if (slug.includes('/') || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(slug)) return null
  return slug
}

/** Workspaces whose guide this caller may see. Order is not significant. */
export function workspaceSlugsForMcp(caller: McpCaller): string[] {
  let known: Set<string>
  try { known = new Set(getWorkspaceSlugs()) } catch { return [] }
  const allow = caller.agentKey?.workspaces
  if (allow) return allow.filter(s => known.has(s))
  if (caller.user?.role === 'admin') return [...known]
  if (!caller.user) return []
  try {
    return getUserWorkspaces(caller.user.id).map(w => w.workspace).filter(s => known.has(s))
  } catch {
    return []
  }
}

/** Guides that exist for these workspaces. Missing files are skipped. Never throws. */
export function loadKbGuides(workspaces: string[], env: NodeJS.ProcessEnv = process.env): LoadedGuide[] {
  const out: LoadedGuide[] = []
  const seen = new Set<string>()
  for (const workspace of [...workspaces].sort((a, b) => a.localeCompare(b))) {
    if (!workspace || seen.has(workspace)) continue
    seen.add(workspace)
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(workspace)) continue
    try {
      const rel = guideRelForWorkspace(workspace, env)
      if (!rel) continue
      const root = workspaceKbRoot(workspace, env)
      const file = readGuideFile(root, rel)
      if (!file) continue
      out.push({
        workspace,
        displayPath: displayPathFor(workspace, rel, root),
        absolutePath: file.absolutePath,
        content: file.content,
        fileTruncated: file.fileTruncated,
      })
    } catch {
      // One bad workspace must not drop the handshake or the other guides.
    }
  }
  return out
}

function clipAtBoundary(text: string, max: number): string {
  if (text.length <= max) return text
  const slice = text.slice(0, max)
  const nl = slice.lastIndexOf('\n')
  const cut = nl >= Math.floor(max * 0.6) ? slice.slice(0, nl) : slice
  return cut.trimEnd()
}

export function clipGuideText(
  content: string,
  max: number,
  absolutePath: string,
  alreadyTruncated: boolean,
): { text: string; truncated: boolean } {
  const note = `\n… [truncated — read the rest with read_file: ${absolutePath}]`
  if (!alreadyTruncated && content.length <= max) return { text: content, truncated: false }
  if (max <= note.length + 1) return { text: content.slice(0, Math.max(0, max)), truncated: true }
  return { text: `${clipAtBoundary(content, max - note.length)}${note}`, truncated: true }
}

/**
 * Appendix for `initialize` instructions. Empty string when there is nothing
 * to add, so a caller can concatenate it onto the stock text.
 */
export function formatKbGuideBlock(
  guides: LoadedGuide[],
  limits: { perGuide?: number; total?: number } = {},
): string {
  if (guides.length === 0) return ''
  const perGuide = limits.perGuide ?? KB_GUIDE_PER_WORKSPACE_CHARS
  const total = limits.total ?? KB_GUIDE_TOTAL_CHARS
  const header = 'Knowledge-base usage guide for the workspace(s) this key can access. Follow it: when to read and when to write the knowledge base and the board, and what never to write.'
  const sections: string[] = []
  const skipped: LoadedGuide[] = []
  let used = header.length
  for (const g of guides) {
    const title = `### ${g.workspace}\n${g.displayPath}`
    const room = total - used - title.length - 2
    if (room < 40) {
      skipped.push(g)
      continue
    }
    const clipped = clipGuideText(g.content, Math.min(perGuide, room), g.absolutePath, g.fileTruncated)
    const section = `${title}\n${clipped.text}`
    sections.push(section)
    used += section.length + 2
  }
  if (skipped.length > 0) {
    const shown = skipped.slice(0, 8)
    const lines = shown.map(g => `- ${g.displayPath} (read_file ${g.absolutePath})`)
    if (skipped.length > shown.length) lines.push(`- and ${skipped.length - shown.length} more`)
    sections.push(`Not inlined (context cap). Read with read_file:\n${lines.join('\n')}`)
  }
  if (sections.length === 0) return ''
  return `\n\n${header}\n\n${sections.join('\n\n')}`
}
