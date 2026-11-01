import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { getDocRoots, getWorkspaceSlugs } from '../services/workspaces.js'
import { searchKnowledge } from '../services/knowledge-search.js'
import { allWorkspaceKbRoots, knowledgeBaseRoot, workspaceKbRoot } from '../services/doc-ingest/kb-paths.js'

const router = Router()
router.use(requireAuth)

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

function getReadRoots(req: AuthRequest): string[] {
  if (req.user!.role === 'admin') return adminRoots(ADMIN_READ_ROOTS, 'read')
  return memberRoots(req, 'read')
}

function getWriteRoots(req: AuthRequest): string[] {
  if (req.user!.role === 'admin') return adminRoots(ADMIN_WRITE_ROOTS, 'write')
  return memberRoots(req, 'write')
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
  if (req.user!.role === 'admin') {
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

function resolveUnder(roots: string[], requested: string): string | null {
  if (!requested) return null
  // Normalise: reject NUL bytes and absolute path traversal trickery handled by realpath
  if (requested.includes('\0')) return null
  let resolved: string
  try {
    resolved = path.resolve(requested)
  } catch {
    return null
  }
  for (const root of roots) {
    const rootResolved = path.resolve(root)
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
  const hits = searchKnowledge(q, workspace)
    .filter(h => resolveUnder(readRoots, h.path) !== null)
    .slice(0, limit)
  res.json({ results: hits })
})

// GET /api/docs/tree — the ONE knowledge base tree (obj 720348). There is no
// source picker: with no `root` the response is the whole knowledge base the
// caller can see. `root` (MCP list_folders) narrows to one folder INSIDE it.
// `roots` is kept for older clients and always lists just the knowledge folders.
router.get('/tree', (req: AuthRequest, res) => {
  const readRoots = getReadRoots(req)
  const writeRoots = getWriteRoots(req)

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
  const { path: filePath, content } = req.body as { path?: string; content?: string }
  if (!filePath || typeof content !== 'string') {
    res.status(400).json({ error: 'path and content required' })
    return
  }
  const resolved = resolveUnder(writeRoots, filePath)
  if (!resolved) {
    res.status(403).json({ error: 'Path not allowed for writes' })
    return
  }
  if (!resolved.toLowerCase().endsWith('.md')) {
    res.status(400).json({ error: 'Only .md files may be written' })
    return
  }
  try {
    const dir = path.dirname(resolved)
    if (!fs.existsSync(dir)) {
      res.status(404).json({ error: 'Parent directory does not exist' })
      return
    }
    fs.writeFileSync(resolved, content, 'utf-8')
    const stat = fs.statSync(resolved)
    res.json({ ok: true, path: resolved, size: stat.size, modifiedAt: stat.mtime.toISOString() })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Write failed'
    res.status(500).json({ error: message })
  }
})

export default router
