/**
 * Which ONE workspace owns a knowledge-base / doc path? (obj 900021)
 *
 * ## The bug
 *
 * `/api/docs/*` (and the MCP tools that forward to it — `write_doc`,
 * `read_file`, `list_folders`, `search`) authorised a path against the CALLER's
 * doc roots only. For an admin's named agent key those are the admin roots —
 * the whole vault — so a key minted for `[example, operationkit]` could write
 * `workspaces/your-org/zz.md`. Board calls and `/api/files` already honoured
 * the key's workspace list; the doc routes never looked at it.
 *
 * ## The rule
 *
 * The doc routes now resolve the target path to a workspace slug and require
 * that slug to be on the key. Resolution fails CLOSED:
 *
 *   - the path is canonicalised first (`path.resolve` + realpath of the nearest
 *     existing ancestor), so `..` and a symlink that leaves a folder are judged
 *     by where the bytes really are;
 *   - evidence of ownership is (a) a workspace's own knowledge folder (both
 *     layouts + its `vault_path`), (b) a doc root configured on exactly that
 *     workspace, and (c) every `workspaces/<slug>/` folder segment below the
 *     root the path sits in;
 *   - a root SHARED by several workspaces, or one that CONTAINS another
 *     workspace's knowledge folder (the vault root, `~/projects`), is a
 *     container and proves nothing;
 *   - exactly one owner → that workspace. None → `outside_workspace`. Several
 *     (e.g. the nested-name spoof `workspaces/example/x/workspaces/operationkit/n.md`)
 *     → `ambiguous`. Both are refused for a scoped key.
 */
import fs from 'fs'
import path from 'path'
import { getDocRoots, getWorkspaceSlugs } from '../services/workspaces.js'
import { workspaceKbRoot } from '../services/doc-ingest/kb-paths.js'
import { knowledgeBaseRoot } from './knowledge-base-root.js'
import { isValidWorkspaceSlug, workspaceScopeRoots } from './kb-workspace-scope.js'

export type PathWorkspace =
  | { ok: true; workspace: string; path: string }
  | { ok: false; reason: 'outside_workspace' | 'ambiguous'; workspaces: string[] }

/**
 * realpath of `p`, or of its nearest existing ancestor with the missing tail
 * re-appended, so a not-yet-created file resolves through its real parent.
 */
export function canonicalPath(p: string): string | null {
  if (!p || p.includes('\0')) return null
  let cur = path.resolve(p)
  const tail: string[] = []
  for (let i = 0; i < 128; i++) {
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

function under(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
}

interface Index {
  /** slug → canonical roots that belong to it (KB folders + configured doc roots). */
  roots: Map<string, Set<string>>
  /** Every workspace knowledge folder, canonical. */
  kbFolders: { slug: string; root: string }[]
  /** The knowledge base root, canonical. */
  kbRoot: string | null
}

function buildIndex(): Index {
  const roots = new Map<string, Set<string>>()
  const kbFolders: { slug: string; root: string }[] = []
  const kbRoot = canonicalPath(knowledgeBaseRoot())
  for (const slug of getWorkspaceSlugs({ includeArchived: true })) {
    if (!isValidWorkspaceSlug(slug)) continue
    const set = new Set<string>()
    const kb = new Set<string>()
    for (const r of workspaceScopeRoots(slug)) kb.add(r)
    try { kb.add(workspaceKbRoot(slug)) } catch { /* bad slug */ }
    for (const r of kb) {
      const c = canonicalPath(r)
      if (c) { set.add(c); kbFolders.push({ slug, root: c }) }
    }
    const doc = getDocRoots(slug)
    for (const r of [...doc.read, ...doc.write]) {
      const c = canonicalPath(r)
      if (c) set.add(c)
    }
    roots.set(slug, set)
  }
  return { roots, kbFolders, kbRoot }
}

function resolveWith(index: Index, requested: string): PathWorkspace {
  const target = canonicalPath(requested)
  if (!target) return { ok: false, reason: 'outside_workspace', workspaces: [] }

  const owners = new Set<string>()
  // Roots the target sits in; the shallowest one anchors the segment scan (c).
  const containing: string[] = []
  if (index.kbRoot && under(target, index.kbRoot)) containing.push(index.kbRoot)

  for (const [slug, set] of index.roots) {
    for (const r of set) {
      if (!under(target, r)) continue
      containing.push(r)
      const shared = [...index.roots].some(([other, s]) => other !== slug && s.has(r))
      const containsOther = index.kbFolders.some(k => k.slug !== slug && under(k.root, r))
      if (shared || containsOther) continue // a container, not ownership evidence
      owners.add(slug)
    }
  }

  if (containing.length > 0) {
    // (c) every `workspaces/<slug>` folder below the shallowest containing root.
    const anchor = containing.reduce((a, b) => (b.length < a.length ? b : a))
    const segs = path.relative(anchor, target).split(path.sep).filter(Boolean)
    let isDir = false
    // codeql[js/path-injection] -- target is realpath-canonicalised and only reached when it sits under a configured workspace root (containing.length > 0); stat only, no read/write
    try { isDir = fs.statSync(target).isDirectory() } catch { /* not yet created */ }
    for (let i = 0; i + 1 < segs.length; i++) {
      if (segs[i] !== 'workspaces') continue
      const isLast = i + 1 === segs.length - 1
      if (isLast && !isDir) continue // `workspaces/notes.md` is a file, not a folder
      owners.add(segs[i + 1])
    }
  }

  const list = [...owners].sort()
  if (list.length === 1) return { ok: true, workspace: list[0], path: target }
  return { ok: false, reason: list.length === 0 ? 'outside_workspace' : 'ambiguous', workspaces: list }
}

/** Resolve one path. Builds the workspace index on every call. */
export function workspaceOfPath(requested: string): PathWorkspace {
  return resolveWith(buildIndex(), requested)
}

/** A resolver that reuses one index — for filtering a list of search hits. */
export function pathWorkspaceResolver(): (requested: string) => PathWorkspace {
  const index = buildIndex()
  return (requested: string) => resolveWith(index, requested)
}

/** Is `requested` inside exactly one workspace, and is that workspace in `allow`? */
export function pathAllowedForWorkspaces(
  requested: string,
  allow: readonly string[],
  resolve: (p: string) => PathWorkspace = workspaceOfPath,
): PathWorkspace & { allowed: boolean } {
  const r = resolve(requested)
  return { ...r, allowed: r.ok && allow.includes(r.workspace) }
}
