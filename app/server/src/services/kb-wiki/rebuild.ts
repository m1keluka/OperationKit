import fs from 'fs'
import path from 'path'
import { readManifest, requeue } from '../doc-ingest/ingest.js'
import { CONVERSATION_SOURCES_DIR, TRASH_DIR, isProtectedPath } from './paths.js'
import { requeueAllImports } from './imports.js'
import { appendLog, compileWiki, pageRoots } from './wiki.js'

/**
 * "Rebuild the wiki from the original files" (obj 720117). Compiled pages are
 * moved to .kb-wiki/trash/<time>/ — never deleted, so a bad rebuild can be
 * undone by hand — then every document and imported chat is queued to be read
 * again. Raw originals and saved answers stay where they are. The caller
 * restarts the document queue and the import worker.
 */

export interface RebuildResult {
  /** Files moved into the trash folder. */
  moved: number
  /** KB-relative trash folder this rebuild used. */
  trash: string
  docsRequeued: number
  importsRequeued: number
}

function countFiles(abs: string): number {
  let n = 0
  let ents: fs.Dirent[]
  try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { return 0 }
  for (const e of ents) n += e.isDirectory() ? countFiles(path.join(abs, e.name)) : 1
  return n
}

/** True for pages this app wrote (doc-ingest or kb-wiki) — a hand-written note never has the marker. */
function isGeneratedPage(abs: string): boolean {
  try {
    const head = fs.readFileSync(abs, 'utf8').slice(0, 4000)
    const fm = head.match(/^---\n([\s\S]*?)\n---/)
    return !!fm && /^generated_by:\s*(document-ingest|kb-wiki)\s*$/m.test(fm[1])
  } catch { return false }
}

function walkMd(kbRoot: string, rel: string, out: string[]): void {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(path.join(kbRoot, rel), { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const r = `${rel}/${e.name}`
    if (isProtectedPath(r)) continue
    if (e.isDirectory()) walkMd(kbRoot, r, out)
    else if (e.isFile() && e.name.endsWith('.md') && isGeneratedPage(path.join(kbRoot, r))) out.push(r)
  }
}

/**
 * KB-relative files a rebuild moves: the GENERATED pages in the entity/topic
 * folders, the readable copies under sources/ and imported conversations. The
 * KB may live inside someone's own notes vault, so a page without the
 * generated_by marker (written by hand, or by an agent's write_doc) stays put.
 */
export function compiledPaths(kbRoot: string): string[] {
  const out: string[] = []
  for (const root of pageRoots()) {
    if (root === 'answers') continue
    if (root === 'sources') {
      try {
        for (const e of fs.readdirSync(path.join(kbRoot, 'sources'), { withFileTypes: true })) {
          if (e.isFile() && e.name.endsWith('.md') && isGeneratedPage(path.join(kbRoot, 'sources', e.name))) out.push(`sources/${e.name}`)
        }
      } catch { /* no sources yet */ }
      continue
    }
    walkMd(kbRoot, root, out)
  }
  walkMd(kbRoot, CONVERSATION_SOURCES_DIR, out)
  return [...new Set(out)].filter(r => !isProtectedPath(r))
}

export function rebuildWiki(kbRoot: string, opts: { now?: Date } = {}): RebuildResult {
  const now = opts.now ?? new Date()
  const trash = `${TRASH_DIR}/${now.toISOString().replace(/[:.]/g, '-')}`
  let moved = 0
  for (const rel of compiledPaths(kbRoot)) {
    const from = path.join(kbRoot, rel)
    const to = path.join(kbRoot, trash, rel)
    moved += fs.statSync(from).isDirectory() ? countFiles(from) : 1
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
  }

  let docsRequeued = 0
  for (const e of readManifest(kbRoot)) if (requeue(kbRoot, e.id)) docsRequeued++
  const importsRequeued = requeueAllImports(kbRoot)

  compileWiki(kbRoot, { now })
  appendLog(kbRoot, {
    kind: 'rebuild',
    title: `Started rebuilding the wiki: ${moved} page${moved === 1 ? '' : 's'} set aside, ${docsRequeued} document${docsRequeued === 1 ? '' : 's'} and ${importsRequeued} conversation${importsRequeued === 1 ? '' : 's'} queued to be read again`,
    when: now,
  })
  return { moved, trash, docsRequeued, importsRequeued }
}
