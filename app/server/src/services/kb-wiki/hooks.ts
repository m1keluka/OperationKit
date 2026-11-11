import fs from 'fs'
import path from 'path'
import { readManifest } from '../doc-ingest/ingest.js'
import { ENTITY_TYPES, FOLDER_FOR } from '../doc-ingest/notes.js'
import { ANSWERS_DIR, CONVERSATION_SOURCES_DIR, STATE_DIR } from './paths.js'
import { appendLog, compileWiki, topicFolder } from './wiki.js'

/**
 * The two places document ingest (#596) calls into the wiki (obj 720117).
 * Kept in this module so doc-ingest only gains one line per hook.
 */

const LOGGED_DOCS = `${STATE_DIR}/logged-docs.json`

function readLogged(kbRoot: string): Record<string, string> {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(kbRoot, LOGGED_DOCS), 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, string> : {}
  } catch { return {} }
}

/**
 * After the document queue drains: log each file finished since the last call
 * (keyed by id + finish time, so a re-read is logged again) and recompile.
 */
export function afterDocIngest(kbRoot: string, now: Date = new Date()): { logged: number } {
  const logged = readLogged(kbRoot)
  let n = 0
  for (const e of readManifest(kbRoot)) {
    if ((e.status !== 'done' && e.status !== 'failed') || !e.finished_at || logged[e.id] === e.finished_at) continue
    if (e.status === 'done') {
      const pages = [...(e.source_note ? [e.source_note] : []), ...(e.notes ?? [])]
      appendLog(kbRoot, { kind: 'ingest', title: `Read "${e.file_name}" (${pages.length} page${pages.length === 1 ? '' : 's'})`, pages, when: new Date(e.finished_at) })
    } else {
      appendLog(kbRoot, { kind: 'ingest', title: `Could not read "${e.file_name}": ${e.error ?? 'unknown problem'}`, when: new Date(e.finished_at) })
    }
    logged[e.id] = e.finished_at
    n++
  }
  if (n) {
    const file = path.join(kbRoot, LOGGED_DOCS)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(logged, null, 2))
  }
  compileWiki(kbRoot, { now })
  return { logged: n }
}

/** Extra folders "Ask" should read besides the entity folders and sources/: saved answers, imported conversations, lint's topic pages. */
export function extraNoteDirs(kbRoot: string): string[] {
  const out: string[] = []
  const add = (rel: string) => { if (fs.existsSync(path.join(kbRoot, rel))) out.push(rel) }
  const walk = (rel: string) => {
    let ents: fs.Dirent[]
    try { ents = fs.readdirSync(path.join(kbRoot, rel), { withFileTypes: true }) } catch { return }
    out.push(rel)
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) walk(`${rel}/${e.name}`)
  }
  add(ANSWERS_DIR)
  if (!ENTITY_TYPES.some(t => FOLDER_FOR[t] === topicFolder())) add(topicFolder())
  walk(CONVERSATION_SOURCES_DIR)
  return out
}
