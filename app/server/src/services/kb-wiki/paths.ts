import fs from 'fs'
import path from 'path'

/**
 * Where the compiled wiki keeps things inside one workspace's knowledge base
 * (obj 720117). The layout follows the "LLM wiki" pattern: raw sources are
 * never edited, the wiki is compiled from them, and an index + log sit on top.
 *
 *   raw/                         untouched originals of chat exports and calls
 *   sources/files/               untouched originals of uploaded documents (doc-ingest)
 *   sources/*.md                 readable copy of each uploaded document
 *   sources/conversations/<job>/ readable copy of each imported chat or call
 *   <entity folders>/            one page per person / company / topic … (doc-ingest types)
 *   answers/                     Ask answers someone chose to keep
 *   index.md · log.md · lint-report.md   maintained automatically
 *   .kb-wiki/                    machine state (import jobs, lint state, trash)
 */
export const RAW_DIR = 'raw'
export const RAW_CHATS_DIR = 'raw/chat-exports'
export const RAW_CALLS_DIR = 'raw/calls'
/** Document originals written by doc-ingest. Treated as raw: never edited, never deleted. */
export const RAW_DOC_FILES_DIR = 'sources/files'
export const CONVERSATION_SOURCES_DIR = 'sources/conversations'
export const ANSWERS_DIR = 'answers'
export const INDEX_PAGE = 'index.md'
export const LOG_PAGE = 'log.md'
export const LINT_REPORT_PAGE = 'lint-report.md'
export const STATE_DIR = '.kb-wiki'
export const IMPORTS_STATE_DIR = '.kb-wiki/imports'
export const TRASH_DIR = '.kb-wiki/trash'

/** Folders the wiki compiler never walks or writes: raw sources, machine state, the upload inbox. */
export const NEVER_TOUCH = [RAW_DIR, RAW_DOC_FILES_DIR, STATE_DIR, 'sources/inbox'] as const

/** Marker in the frontmatter of pages this module generates (index, log, report, stubs, answers). */
export const GENERATED_BY = 'kb-wiki'

/** True when a KB-relative path is a raw source or machine state (lint/rebuild must not touch it). */
export function isProtectedPath(rel: string): boolean {
  const r = rel.replace(/\\/g, '/').replace(/^\.\//, '')
  return NEVER_TOUCH.some(p => r === p || r.startsWith(`${p}/`))
}

/**
 * The KB can sit inside a notes vault that is itself a git repo. Chat exports
 * hold private conversations (and sometimes pasted keys) and can be hundreds
 * of MB, so keep the originals and machine state out of git. Only appends.
 */
export function ensureKbGitignore(kbRoot: string): void {
  const file = path.join(kbRoot, '.gitignore')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { /* none yet */ }
  const have = new Set(text.split(/\r?\n/).map(l => l.trim()))
  const missing = [`${RAW_DIR}/`, `${STATE_DIR}/`].filter(l => !have.has(l) && !have.has(l.slice(0, -1)) && !have.has(`/${l}`))
  if (!missing.length) return
  fs.mkdirSync(kbRoot, { recursive: true })
  fs.writeFileSync(file, `${text}${text && !text.endsWith('\n') ? '\n' : ''}# Knowledge base: original chat/call exports and import state stay on this server only\n${missing.join('\n')}\n`)
}
