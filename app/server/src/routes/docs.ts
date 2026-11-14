import { Router, type Response } from 'express'
import fs from 'fs'
import path from 'path'
import { type AuthRequest } from '../middleware/auth.js'
import { sessionFileWorkspace, sessionOrRequireAuth } from '../middleware/session-file-access.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { getDocRoots, getWorkspaceSlugs } from '../services/workspaces.js'
import { searchKnowledge } from '../services/knowledge-search.js'
import { allWorkspaceKbRoots, knowledgeBaseRoot, workspaceKbRoot } from '../services/doc-ingest/kb-paths.js'
import { pathWorkspaceResolver, workspaceOfPath, type PathWorkspace } from '../lib/doc-path-workspace.js'
import { noteKbFileWritten } from '../services/kb-wiki/graph-sync.js'

const router = Router()
// obj 900204: card sessions authenticate with their objective-scoped
// CC_SESSION_TOKEN. No token present → no-op, requireAuth behaves as before.
router.use(sessionOrRequireAuth)

// Admin file access. The Knowledge base page no longer offers these as
// "sources" (obj 720348): the page shows ONE tree, the knowledge base. The
// non-knowledge folders stay readable/writable by absolute path so links and
// agents that already point into them keep working — they are just not part
// of the knowledge base tree (agents/skills live on Agents + Settings, code
// repos on Development).
const ADMIN_READ_ROOTS = [
  '/home/operator/second-brain',
  '/home/operator/ai-workspace',
  '/home/operator/projects',
]

const ADMIN_WRITE_ROOTS = [
  '/home/operator/second-brain',
  '/home/operator/ai-workspace',
  '/home/operator/projects',
]

/**
 * Admins also reach the knowledge base itself (wherever it lives on this
 * install) and every workspace's own doc roots that sit outside the fixed
 * list — on a client install that is where imported knowledge-base notes live
 * (/app/data/knowledge-base/<ws>, obj 719936). The fixed list is kept as-is
 * (auth must not depend on which folders exist on this host); only the extra
 * roots are existence-gated.
 */
function adminRoots(fixed: string[], kind: 'read' | 'write'): string[] {
  const roots = [...fixed]
  const add = (r: string) => { if (!resolveUnder(roots, r) && fs.existsSync(r)) roots.push(r) }
  add(knowledgeBaseRoot())
  for (const slug of getWorkspaceSlugs()) {
    for (const r of getDocRoots(slug)[kind]) add(r)
    try { add(workspaceKbRoot(slug)) } catch { /* bad slug */ }
  }
  return roots
}

/** The doc roots of ONE workspace: its configured roots plus its KB folder. */
function workspaceRoots(workspace: string, kind: 'read' | 'write'): string[] {
  const roots: string[] = [...getDocRoots(workspace)[kind]]
  try {
    const kb = workspaceKbRoot(workspace)
    if (!resolveUnder(roots, kb) && fs.existsSync(kb)) roots.push(kb)
  } catch { /* bad slug */ }
  return roots
}

/** A member's workspace roots plus the workspace's own knowledge folder. */
function memberRoots(req: AuthRequest, kind: 'read' | 'write'): string[] {
  const roots: string[] = []
  for (const uw of getUserWorkspaces(req.user!.id)) {
    roots.push(...getDocRoots(uw.workspace)[kind])
    try {
      const kb = workspaceKbRoot(uw.workspace)
      if (!resolveUnder(roots, kb) && fs.existsSync(kb)) roots.push(kb)
    } catch { /* bad slug */ }
  }
  return roots
}

/**
 * obj 900204 — a card session is confined to its OWN objective's workspace,
 * whatever the acting user could otherwise see, and never gets the admin roots.
 */
function getReadRoots(req: AuthRequest): string[] {
  const ws = sessionFileWorkspace(req)
  if (ws) return workspaceRoots(ws, 'read')
  if (req.user!.role === 'admin') return adminRoots(ADMIN_READ_ROOTS, 'read')
  return memberRoots(req, 'read')
}

function getWriteRoots(req: AuthRequest): string[] {
  const ws = sessionFileWorkspace(req)
  if (ws) return workspaceRoots(ws, 'write')
  if (req.user!.role === 'admin') return adminRoots(ADMIN_WRITE_ROOTS, 'write')
  return memberRoots(req, 'write')
}

/**
 * obj 900021 — the workspace allowlist of the caller's named agent key, or null
 * when nothing extra applies (cookie/JWT user, unscoped key, card session — a
 * card session is already confined to its own workspace by obj 900204).
 *
 * An admin's key is limited by ITS list too: the admin roots are the whole
 * vault, so without this a key minted for [example, operationkit] could read and
 * write every other workspace's notes through /api/docs and MCP write_doc.
 */
function keyWorkspaces(req: AuthRequest): string[] | null {
  if (sessionFileWorkspace(req)) return null
  return req.agentKey?.workspaces ?? null
}

/** The 403 body for a path outside the key's workspaces. */
function workspaceDenial(req: AuthRequest, r: PathWorkspace, allow: string[]) {
  const label = req.agentKey?.label ?? 'agent key'
  const error = r.ok
    ? `Workspace not allowed: agent key '${label}' cannot use workspace '${r.workspace}'`
    : r.reason === 'ambiguous'
      ? `Workspace not allowed: this path belongs to more than one workspace (${r.workspaces.join(', ')})`
      : 'Workspace not allowed: this path is not inside a workspace this agent key may use'
  return {
    error,
    code: 'workspace_not_allowed',
    ...(r.ok ? { workspace: r.workspace } : { reason: r.reason }),
    allowed_workspaces: allow,
  }
}

/**
 * Enforce the key's workspace list on one already-root-checked path. Sends the
 * 403 and returns false when the path is not in exactly one allowed workspace.
 */
function enforceKeyWorkspace(req: AuthRequest, res: Response, resolvedPath: string): boolean {
  const allow = keyWorkspaces(req)
  if (!allow) return true
  const r = workspaceOfPath(resolvedPath)
  if (r.ok && allow.includes(r.workspace)) return true
  res.status(403).json(workspaceDenial(req, r, allow))
  return false
}

/** Keep only the paths that resolve to exactly one workspace on the key. */
function filterToKeyWorkspaces<T>(req: AuthRequest, items: T[], pathOf: (t: T) => string): T[] {
  const allow = keyWorkspaces(req)
  if (!allow) return items
  const resolve = pathWorkspaceResolver()
  return items.filter(i => {
    const r = resolve(pathOf(i))
    return r.ok && allow.includes(r.workspace)
  })
}

/** True when `dir` is knowledge: inside the knowledge base or a workspace's knowledge folder. */
function isKnowledgeDir(dir: string, kbRoot: string, wsKbDirs: string[]): boolean {
  return resolveUnder([kbRoot, ...wsKbDirs], dir) !== null
}

/**
 * The folders that make up the ONE knowledge base tree for this caller
 * (obj 720348). Admins: the knowledge base root, plus any workspace knowledge
 * folder that lives outside it (a custom `vault_path`, or an install whose
 * notes predate the move) so nothing stored under an old "source" goes
 * missing. Members: only the knowledge folders among their workspace roots
 * plus their workspaces' own knowledge folders — agent config and code repos
 * are never part of the tree. Nested folders collapse into their parent.
 */
export function knowledgeFolders(req: AuthRequest): string[] {
  const kbRoot = knowledgeBaseRoot()
  const wsKb = allWorkspaceKbRoots().map(w => path.resolve(w.dir))
  let candidates: string[]
  const sessionWs = sessionFileWorkspace(req)
  const keyWs = keyWorkspaces(req)
  if (sessionWs) {
    // obj 900204 — exactly this card's workspace folder. No admin branch, no
    // other membership, no shared sibling folders.
    candidates = allWorkspaceKbRoots().filter(w => w.workspace === sessionWs).map(w => path.resolve(w.dir))
  } else if (keyWs) {
    // obj 900021 — a scoped agent key sees only its workspaces' knowledge
    // folders (intersected with what the owning user may see), never the whole
    // knowledge base root even when the owner is an admin.
    const allow = new Set(keyWs)
    const mine = req.user!.role === 'admin' ? null : new Set(getUserWorkspaces(req.user!.id).map(uw => uw.workspace))
    candidates = filterToKeyWorkspaces(req, allWorkspaceKbRoots()
      .filter(w => allow.has(w.workspace) && (!mine || mine.has(w.workspace)))
      .map(w => path.resolve(w.dir)), d => d)
  } else if (req.user!.role === 'admin') {
    candidates = [kbRoot, ...wsKb]
  } else {
    const mine = new Set(getUserWorkspaces(req.user!.id).map(uw => uw.workspace))
    const myKb = allWorkspaceKbRoots().filter(w => mine.has(w.workspace)).map(w => path.resolve(w.dir))
    const fromRows = [...mine].flatMap(ws => getDocRoots(ws).read).map(r => path.resolve(r))
    candidates = [...myKb, ...fromRows.filter(r => isKnowledgeDir(r, kbRoot, wsKb))]
  }
  const existing = [...new Set(candidates)].filter(d => {
    try { return fs.statSync(d).isDirectory() } catch { return false }
  })
  // Shortest first so a parent swallows its children.
  existing.sort((a, b) => a.length - b.length)
  const out: string[] = []
  for (const d of existing) if (!resolveUnder(out, d)) out.push(d)
  // Keep the knowledge base root first when present.
  return out.sort((a, b) => (a === kbRoot ? -1 : b === kbRoot ? 1 : a.localeCompare(b)))
}

/** Display name for a knowledge folder: its path inside the knowledge base, else its last segment. */
function folderLabel(dir: string, kbRoot: string): string {
  if (dir === kbRoot) return 'Knowledge base'
  const rel = path.relative(kbRoot, dir)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/')
  return path.basename(dir)
}

const EXCLUDE_DIRS = new Set(['.git', 'node_modules', '.obsidian', 'dist', '.next', '.cache', '.vite'])

/**
 * realpath of `p`, or of its nearest existing ancestor with the missing tail
 * re-appended (so a not-yet-created file still resolves through its real
 * parent). Returns null if nothing on the path can be resolved.
 */
function realDeep(p: string): string | null {
  let cur = p
  const tail: string[] = []
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync(cur), ...tail.reverse())
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return null
      tail.push(path.basename(cur))
      cur = parent
    }
  }
  return null
}

/**
 * Is `requested` inside one of `roots`? Returns the canonical absolute path.
 *
 * obj 900204 — this used to compare `path.resolve()` output only, which the
 * comment above it claimed was "traversal trickery handled by realpath". It was
 * not: a SYMLINK placed inside a doc root (`<ws>/notes/x.md -> /etc/passwd`, or
 * a linked directory) resolved lexically inside the root and was then read or
 * WRITTEN through. Harmless-ish while every caller was a logged-in human; a
 * real escape now that card sessions reach this router. Both sides are
 * realpath'd — matching what services/file-access.ts already does for
 * /api/files — so a link that leaves the root is rejected.
 */
function resolveUnder(roots: string[], requested: string): string | null {
  if (!requested) return null
  if (requested.includes('\0')) return null
  const resolved = realDeep(path.resolve(requested))
  if (!resolved) return null
  for (const root of roots) {
    const rootResolved = realDeep(path.resolve(root))
    if (!rootResolved) continue
    if (resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)) {
      return resolved
    }
  }
  return null
}

interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

function buildTree(dir: string, depth = 0): TreeNode[] {
  if (depth > 8) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: TreeNode[] = []
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue
    if (entry.name.startsWith('.') && entry.isDirectory()) continue // hide hidden dirs
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const children = buildTree(full, depth + 1)
      // Skip empty dirs to keep the tree compact
      if (children.length === 0) continue
      nodes.push({ name: entry.name, path: full, type: 'dir', children })
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      nodes.push({ name: entry.name, path: full, type: 'file' })
    }
  }
  // Dirs first, then files; alphabetical within group
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

// GET /api/docs/search?q=&workspace=
// Agent/KB path: same retrieval CC sessions use at spawn (FTS5, grep fallback).
router.get('/search', (req: AuthRequest, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (!q) {
    res.status(400).json({ error: 'q is required' })
    return
  }
  const readRoots = getReadRoots(req)
  if (readRoots.length === 0) {
    res.status(403).json({ error: 'No doc access for your account' })
    return
  }
  const workspace = typeof req.query.workspace === 'string' && req.query.workspace !== 'all'
    ? req.query.workspace.trim()
    : undefined
  const rawLimit = parseInt(String(req.query.limit ?? ''), 10)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 20) : 8
  const keyWs = keyWorkspaces(req)
  if (keyWs && workspace && !keyWs.includes(workspace)) {
    res.status(403).json({ error: `Workspace not allowed: agent key '${req.agentKey?.label ?? 'agent key'}' cannot use workspace '${workspace}'`, code: 'workspace_not_allowed', workspace, allowed_workspaces: keyWs })
    return
  }
  // obj 900021: a scoped key's hits must each resolve to one of its workspaces.
  const hits = filterToKeyWorkspaces(
    req,
    searchKnowledge(q, workspace).filter(h => resolveUnder(readRoots, h.path) !== null),
    h => h.path,
  ).slice(0, limit)
  res.json({ results: hits })
})

// GET /api/docs/tree — the ONE knowledge base tree (obj 720348). There is no
// source picker: with no `root` the response is the whole knowledge base the
// caller can see. `root` (MCP list_folders) narrows to one folder INSIDE it.
// `roots` is kept for older clients and always lists just the knowledge folders.
router.get('/tree', (req: AuthRequest, res) => {
  const readRoots = getReadRoots(req)
  // obj 900021: advertise only the write roots inside the key's workspaces.
  const writeRoots = filterToKeyWorkspaces(req, getWriteRoots(req), r => r)

  if (readRoots.length === 0) {
    res.status(403).json({ error: 'No doc access for your account' })
    return
  }

  const kbRoot = knowledgeBaseRoot()
  const folders = knowledgeFolders(req)
  const folderList = folders.map(f => ({ path: f, label: folderLabel(f, kbRoot) }))
  const requested = typeof req.query.root === 'string' && req.query.root ? req.query.root : null

  if (requested) {
    const resolved = resolveUnder(folders, requested)
    if (!resolved) {
      res.status(403).json({ error: 'Not inside the knowledge base' })
      return
    }
    if (!enforceKeyWorkspace(req, res, resolved)) return
    try {
      if (!fs.statSync(resolved).isDirectory()) {
        res.status(400).json({ error: 'Root is not a directory' })
        return
      }
    } catch {
      res.status(404).json({ error: 'Root not found' })
      return
    }
    res.json({ root: resolved, label: folderLabel(resolved, kbRoot), roots: folders, folders: folderList, writeRoots, tree: buildTree(resolved) })
    return
  }

  // One folder → its contents are the tree. Several (a member with a
  // workspace + shared folder, or a workspace folder outside the KB root) →
  // each becomes a top-level folder of the same tree.
  const tree: TreeNode[] = folders.length === 1
    ? buildTree(folders[0])
    : folders.map(f => ({ name: folderLabel(f, kbRoot), path: f, type: 'dir' as const, children: buildTree(f) }))
  const root = folders.length === 1 ? folders[0] : kbRoot
  res.json({ root, label: 'Knowledge base', roots: folders, folders: folderList, writeRoots, tree })
})

// GET /api/docs/file?path=/home/operator/second-brain/foo.md
router.get('/file', (req: AuthRequest, res) => {
  const readRoots = getReadRoots(req)
  const writeRoots = getWriteRoots(req)
  const filePath = req.query.path as string
  const resolved = resolveUnder(readRoots, filePath)
  if (!resolved) {
    res.status(403).json({ error: 'Path not allowed' })
    return
  }
  // obj 900021: checked before stat, so a denied path is no existence oracle.
  if (!enforceKeyWorkspace(req, res, resolved)) return
  try {
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) {
      res.status(400).json({ error: 'Not a file' })
      return
    }
    const content = fs.readFileSync(resolved, 'utf-8')
    let writable = resolveUnder(writeRoots, resolved) !== null
    if (writable) {
      // Verify the FS itself accepts writes (bind mounts may be :ro)
      try {
        fs.accessSync(resolved, fs.constants.W_OK)
      } catch {
        writable = false
      }
    }
    res.json({
      path: resolved,
      content,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      writable,
    })
  } catch {
    res.status(404).json({ error: 'File not found' })
  }
})

// PUT /api/docs/file  body: { path, content }
router.put('/file', (req: AuthRequest, res) => {
  const writeRoots = getWriteRoots(req)
  const { path: filePath, content, create_dirs: createDirs } = req.body as {
    path?: string
    content?: string
    /** obj 900204: create missing parents INSIDE the write root. A card doing
     *  vault capture is usually the first writer of `<ws>/decisions/`. */
    create_dirs?: boolean
  }
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content required' })
    return
  }
  const resolved = resolveUnder(writeRoots, filePath)
  if (!resolved) {
    res.status(403).json({ error: 'Path not allowed for writes' })
    return
  }
  // obj 900021: the agent key's workspace list applies to every write — an
  // admin's key included. Checked before any mkdir/write.
  if (!enforceKeyWorkspace(req, res, resolved)) return
  if (!resolved.toLowerCase().endsWith('.md')) {
    res.status(400).json({ error: 'Only .md files may be written' })
    return
  }
  try {
    const dir = path.dirname(resolved)
    if (!fs.existsSync(dir)) {
      // `resolved` is already proven to be inside a write root, so creating the
      // intermediate directories cannot widen where the write lands.
      if (!createDirs) {
        res.status(404).json({ error: 'Parent directory does not exist', code: 'no_parent_dir', hint: 'pass create_dirs: true to create it' })
        return
      }
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(resolved, content, 'utf-8')
    const stat = fs.statSync(resolved)
    res.json({ ok: true, path: resolved, size: stat.size, modifiedAt: stat.mtime.toISOString() })
    // obj 900815: a plain write (the editor, MCP write_doc, a card session) reindexes that
    // one page in its workspace's link graph — after the response, so the save never waits.
    setImmediate(() => { noteKbFileWritten(resolved) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Write failed'
    res.status(500).json({ error: message })
  }
})

export default router
