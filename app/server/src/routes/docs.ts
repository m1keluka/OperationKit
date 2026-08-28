import { Router } from 'express'
import fs from 'fs'
import path from 'path'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { getDocRoots } from '../services/workspaces.js'
import { searchKnowledge } from '../services/knowledge-search.js'

const router = Router()
router.use(requireAuth)

// Admin roots — full access
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

function getReadRoots(req: AuthRequest): string[] {
  if (req.user!.role === 'admin') return ADMIN_READ_ROOTS
  const userWs = getUserWorkspaces(req.user!.id)
  const roots: string[] = []
  for (const uw of userWs) {
    roots.push(...getDocRoots(uw.workspace).read)
  }
  return roots
}

function getWriteRoots(req: AuthRequest): string[] {
  if (req.user!.role === 'admin') return ADMIN_WRITE_ROOTS
  const userWs = getUserWorkspaces(req.user!.id)
  const roots: string[] = []
  for (const uw of userWs) {
    roots.push(...getDocRoots(uw.workspace).write)
  }
  return roots
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

// GET /api/docs/tree?root=/home/operator/second-brain
router.get('/tree', (req: AuthRequest, res) => {
  const readRoots = getReadRoots(req)
  const writeRoots = getWriteRoots(req)

  if (readRoots.length === 0) {
    res.status(403).json({ error: 'No doc access for your account' })
    return
  }

  const root = (req.query.root as string) || readRoots[0]
  const resolved = resolveUnder(readRoots, root)
  if (!resolved) {
    res.status(403).json({ error: 'Root not allowed' })
    return
  }
  try {
    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'Root is not a directory' })
      return
    }
  } catch {
    res.status(404).json({ error: 'Root not found' })
    return
  }
  const tree = buildTree(resolved)
  res.json({ root: resolved, roots: readRoots, writeRoots, tree })
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
