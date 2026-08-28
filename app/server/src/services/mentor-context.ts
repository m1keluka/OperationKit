import fs from 'fs'
import path from 'path'

// Live state + recent vault delta, assembled into a single block that gets
// prepended to the first user turn whenever a mentor subprocess is spawned.
// Persona itself lives in mentor-workspace/CLAUDE.md and is loaded by Claude
// Code natively — we don't duplicate it here.

/**
 * Call Claude Haiku to summarize a conversation for compaction.
 * Returns the summary text, or null if the call fails (non-fatal).
 */
export async function callHaikuSummarizer(prompt: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!res.ok) return null
    const data = await res.json() as { content?: Array<{ type: string; text?: string }> }
    return data.content?.find(b => b.type === 'text')?.text?.trim() || null
  } catch {
    return null
  }
}

const VAULT_ROOT = '/home/operator/second-brain'
const DEFAULT_DELTA_DAYS = 14
const DEFAULT_DELTA_MAX_FILES = 30
const DEFAULT_DELTA_BYTES_PER_FILE = 500
const ACTIVE_FILE_MAX_BYTES = 8000
const MAX_OPEN_TASKS = 50

export interface SessionContextOptions {
  vaultRoot?: string
  vaultDeltaDays?: number
  vaultDeltaMaxFiles?: number
  vaultDeltaBytesPerFile?: number
  /**
   * Restrict workspace iteration to these slugs. `null`/`undefined` =
   * scan every workspace (admin-equivalent). An array filters to just those
   * names; `'personal'` must be explicitly present for the personal vault to
   * be included. Empty array = nothing scanned (members with no memberships).
   */
  allowedWorkspaces?: string[] | null
}

interface VaultFile {
  path: string
  mtime: number
  title: string
  body: string
}

function readSafe(p: string): string | null {
  try { return fs.readFileSync(p, 'utf-8') } catch { return null }
}

function stripFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  if (!content.startsWith('---\n')) return { frontmatter: {}, body: content }
  const end = content.indexOf('\n---\n', 4)
  if (end === -1) return { frontmatter: {}, body: content }
  const fm: Record<string, string> = {}
  for (const line of content.slice(4, end).split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return { frontmatter: fm, body: content.slice(end + 5) }
}

function deriveTitle(filePath: string, frontmatter: Record<string, string>, body: string): string {
  if (frontmatter.title) return frontmatter.title
  const h1 = body.match(/^#\s+(.+)$/m)
  if (h1) return h1[1].trim()
  return path.basename(filePath, '.md')
}

function workspaceAllowed(slug: string, allowed: string[] | null | undefined): boolean {
  if (allowed == null) return true
  return allowed.includes(slug)
}

export function getActiveStateBlock(
  opts: { vaultRoot?: string; allowedWorkspaces?: string[] | null } = {},
): string {
  const root = opts.vaultRoot ?? VAULT_ROOT
  const sources: { label: string; file: string }[] = []
  if (workspaceAllowed('personal', opts.allowedWorkspaces)) {
    sources.push({ label: 'Personal', file: path.join(root, 'personal/active.md') })
  }
  const wsDir = path.join(root, 'workspaces')
  try {
    for (const ws of fs.readdirSync(wsDir).sort()) {
      if (!workspaceAllowed(ws, opts.allowedWorkspaces)) continue
      const f = path.join(wsDir, ws, 'active.md')
      if (fs.existsSync(f)) sources.push({ label: `Workspace: ${ws}`, file: f })
    }
  } catch {}

  const parts: string[] = []
  for (const { label, file } of sources) {
    const raw = readSafe(file)
    if (!raw) continue
    const { body } = stripFrontmatter(raw)
    const trimmed = body.trim().slice(0, ACTIVE_FILE_MAX_BYTES)
    if (trimmed) parts.push(`### ${label}\n${trimmed}`)
  }
  return parts.join('\n\n')
}

export function getVaultDeltaBlock(opts: SessionContextOptions = {}): string {
  const root = opts.vaultRoot ?? VAULT_ROOT
  const days = opts.vaultDeltaDays ?? DEFAULT_DELTA_DAYS
  const maxFiles = opts.vaultDeltaMaxFiles ?? DEFAULT_DELTA_MAX_FILES
  const bytesPerFile = opts.vaultDeltaBytesPerFile ?? DEFAULT_DELTA_BYTES_PER_FILE
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000

  const dirs: string[] = []
  const tryAdd = (p: string) => {
    try { if (fs.statSync(p).isDirectory()) dirs.push(p) } catch {}
  }
  if (workspaceAllowed('personal', opts.allowedWorkspaces)) {
    tryAdd(path.join(root, 'personal/decisions'))
    tryAdd(path.join(root, 'personal/insights'))
  }
  try {
    for (const ws of fs.readdirSync(path.join(root, 'workspaces'))) {
      if (!workspaceAllowed(ws, opts.allowedWorkspaces)) continue
      tryAdd(path.join(root, 'workspaces', ws, 'decisions'))
      tryAdd(path.join(root, 'workspaces', ws, 'insights'))
    }
  } catch {}

  const files: VaultFile[] = []
  for (const dir of dirs) {
    let entries: string[]
    try { entries = fs.readdirSync(dir) } catch { continue }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue
      const full = path.join(dir, name)
      let st: fs.Stats
      try { st = fs.statSync(full) } catch { continue }
      if (!st.isFile() || st.mtimeMs < cutoff) continue
      const raw = readSafe(full)
      if (!raw) continue
      const { frontmatter, body } = stripFrontmatter(raw)
      const title = deriveTitle(full, frontmatter, body)
      const trimmedBody = body.trim().slice(0, bytesPerFile)
      files.push({ path: full, mtime: st.mtimeMs, title, body: trimmedBody })
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const kept = files.slice(0, maxFiles)

  return kept
    .map(f => {
      const rel = path.relative(root, f.path)
      return `### ${f.title}\n_${rel}_\n\n${f.body}`
    })
    .join('\n\n---\n\n')
}

interface TaskEntry {
  workspace: string
  title: string
  dueDate: string | null
  priority: number | null
  status: string
  filePath: string
}

export function getOpenTasksBlock(
  opts: { vaultRoot?: string; allowedWorkspaces?: string[] | null } = {},
): string {
  const root = opts.vaultRoot ?? VAULT_ROOT
  const entries: TaskEntry[] = []

  const readTaskDir = (dir: string, workspace: string) => {
    let names: string[]
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names) {
      if (!name.endsWith('.md')) continue
      const full = path.join(dir, name)
      const raw = readSafe(full)
      if (!raw) continue
      const { frontmatter } = stripFrontmatter(raw)
      const status = frontmatter.status ?? ''
      if (status !== 'todo' && status !== 'in-progress') continue
      const title = frontmatter.title ?? path.basename(full, '.md')
      const dueDate = frontmatter.due_date ?? frontmatter.due ?? null
      const priorityRaw = frontmatter.priority ? Number(frontmatter.priority) : null
      const priority = priorityRaw !== null && !Number.isNaN(priorityRaw) ? priorityRaw : null
      entries.push({ workspace, title, dueDate, status, priority, filePath: full })
    }
  }

  if (workspaceAllowed('personal', opts.allowedWorkspaces)) {
    readTaskDir(path.join(root, 'personal/tasks'), 'personal')
  }
  try {
    for (const ws of fs.readdirSync(path.join(root, 'workspaces')).sort()) {
      if (!workspaceAllowed(ws, opts.allowedWorkspaces)) continue
      readTaskDir(path.join(root, 'workspaces', ws, 'tasks'), ws)
    }
  } catch {}

  entries.sort((a, b) => {
    if (a.dueDate && !b.dueDate) return -1
    if (!a.dueDate && b.dueDate) return 1
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1
    const pa = a.priority ?? 999
    const pb = b.priority ?? 999
    return pa - pb
  })

  const capped = entries.slice(0, MAX_OPEN_TASKS)
  if (capped.length === 0) return ''

  return capped.map(e => {
    const duePart = e.dueDate ? ` — due ${e.dueDate}` : ''
    const priPart = e.priority !== null ? ` (priority ${e.priority})` : ''
    return `- [${e.workspace}] ${e.title}${duePart}${priPart} [${e.status}]  _${e.filePath}_`
  }).join('\n')
}

export function buildSessionContext(opts: SessionContextOptions = {}): string {
  const active = getActiveStateBlock(opts)
  const openTasks = getOpenTasksBlock(opts)
  const delta = getVaultDeltaBlock(opts)
  const days = opts.vaultDeltaDays ?? DEFAULT_DELTA_DAYS
  const today = new Date().toISOString().slice(0, 10)
  const sections: string[] = [
    `Session context, fresh as of ${today}. Persona is loaded from CLAUDE.md. Use this as starting context — grep the vault for anything deeper.`,
  ]
  if (active) sections.push(`## Active State (snapshot)\n\n${active}`)
  if (openTasks) sections.push(`## Open Tasks (cross-workspace, status=todo|in-progress)\n\n${openTasks}`)
  if (delta) sections.push(`## Recent Decisions & Insights (last ${days} days, headers + first paragraph)\n\n${delta}`)
  return sections.join('\n\n')
}
