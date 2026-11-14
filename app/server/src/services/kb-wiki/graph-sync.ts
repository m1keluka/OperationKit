import fs from 'fs'
import path from 'path'
import { getDb } from '../../db/index.js'
import { getWorkspaceSlugs } from '../workspaces.js'
import { workspaceKbRoot } from '../doc-ingest/kb-paths.js'
import { reindexGraphFile, syncGraph, type FileReindexResult, type GraphSyncResult } from './graph.js'
import type { VaultScanOptions } from './vault-scan.js'

/**
 * Glue between the link graph and the installed workspaces (obj 900815):
 * which folder each workspace's graph reads, which nested folders belong to
 * someone else, and the incremental reindex every write path calls.
 */

function kbRoots(): Array<{ workspace: string; root: string }> {
  const out: Array<{ workspace: string; root: string }> = []
  for (const ws of getWorkspaceSlugs({ includeArchived: true })) {
    try { out.push({ workspace: ws, root: path.resolve(workspaceKbRoot(ws)) }) } catch { /* bad slug */ }
  }
  return out
}

const inside = (child: string, parent: string) => child.startsWith(`${parent}${path.sep}`)

/** Real path when it exists (a symlinked vault), else the resolved path. */
function real(p: string): string {
  try { return fs.realpathSync(p) } catch { return path.resolve(p) }
}

/** The workspace whose knowledge base lives at `kbRoot`, if any. */
export function workspaceForKbRoot(kbRoot: string): string | null {
  const want = path.resolve(kbRoot)
  return kbRoots().find(r => r.root === want)?.workspace ?? null
}

/**
 * Scan options for one workspace's graph: another workspace's knowledge
 * folder nested INSIDE this one is never walked, so one workspace's graph can
 * never show another's pages (per-workspace scoping), whatever the folder layout.
 */
export function graphScanOptions(workspace: string): VaultScanOptions {
  let root: string
  try { root = path.resolve(workspaceKbRoot(workspace)) } catch { return {} }
  const skipAbs = kbRoots().filter(r => r.workspace !== workspace && inside(r.root, root)).map(r => r.root)
  return skipAbs.length ? { skipAbs } : {}
}

/** Bring one workspace's graph tables up to date with its files (re-reads only what changed). */
export function syncWorkspaceGraph(workspace: string, opts: { force?: boolean } = {}): GraphSyncResult {
  return syncGraph(getDb(), workspace, workspaceKbRoot(workspace), { ...graphScanOptions(workspace), ...opts })
}

/**
 * A markdown file at `absPath` was just written or deleted. Reindex it in the
 * graph of the ONE workspace whose knowledge folder holds it (the deepest
 * match, so a nested workspace owns its own files). No-op for a path outside
 * every knowledge folder. Never throws: the file is the source of truth and
 * the next graph read catches up from the signature anyway.
 */
export function noteKbFileWritten(absPath: string): (FileReindexResult & { workspace: string }) | null {
  try {
    if (!absPath.toLowerCase().endsWith('.md')) return null
    // The file may just have been deleted: canonicalise its folder, keep its name.
    const abs = path.join(real(path.dirname(path.resolve(absPath))), path.basename(absPath))
    const owner = kbRoots()
      .map(r => ({ ...r, real: real(r.root) }))
      .filter(r => inside(abs, r.real))
      .sort((a, b) => b.real.length - a.real.length)[0]
    if (!owner) return null
    const rel = path.relative(owner.real, abs).split(path.sep).join('/')
    const r = reindexGraphFile(getDb(), owner.workspace, owner.root, rel, graphScanOptions(owner.workspace))
    return { ...r, workspace: owner.workspace }
  } catch (err) {
    console.warn(`[kb-graph] reindex after write failed: ${(err as Error).message}`)
    return null
  }
}
