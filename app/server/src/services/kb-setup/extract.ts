import path from 'path'
import { decodeXmlEntities, extractDocument, extractText, kindForFile, type Extracted } from '../doc-ingest/extract.js'
import { readZip } from '../doc-ingest/zip.js'

/**
 * File reading for Knowledge Base Setup (obj 900556).
 *
 * Reuses document ingest's zero-dependency readers (Excel, CSV, PDF, Word,
 * text, captions) and adds the three other shapes a "dump of my old folders"
 * always contains: slide decks (.pptx), saved web pages (.html) and JSON
 * exports (chat/CRM exports). Everything runs on this server.
 */

export const SETUP_EXTRA_EXTENSIONS = ['.pptx', '.html', '.htm', '.json', '.markdown'] as const

export type SetupKind = Extracted['kind'] | 'slides' | 'html' | 'json'

export interface SetupExtracted extends Omit<Extracted, 'kind'> { kind: SetupKind }

/** Files we never try to read: they carry no knowledge, or need their own importer. */
const SKIP_REASONS: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|\/)\.(git|svn|hg|DS_Store|idea|vscode)(\/|$)/i, reason: 'system or tool folder' },
  { re: /(^|\/)(node_modules|__pycache__|\.venv|venv)(\/|$)/i, reason: 'code dependencies folder' },
  { re: /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|credentials(\.json)?|secrets?\.(json|ya?ml|txt))$/i, reason: 'looks like a credentials file — not imported; keep it in your password manager' },
  { re: /\.zip$/i, reason: 'zip archive — unzip it first, or use Import chats & calls for a Claude / ChatGPT export' },
  { re: /\.(png|jpe?g|gif|webp|heic|svg|bmp|tiff?)$/i, reason: 'image — pictures are not read yet' },
  { re: /\.(mp3|m4a|wav|mp4|mov|webm|ogg)$/i, reason: 'audio/video — upload the transcript (.vtt, .srt, .txt or .docx) instead' },
  { re: /\.(xls|doc|ppt)$/i, reason: 'old Office format — open it and Save As .xlsx / .docx / .pptx' },
]

/** Why a file is skipped, or null when it can be read. */
export function skipReason(relPath: string): string | null {
  const p = relPath.replace(/\\/g, '/')
  for (const s of SKIP_REASONS) if (s.re.test(p)) return s.reason
  if (!setupKindFor(p)) return `can't read ${path.extname(p) || 'files without an extension'} files yet`
  return null
}

export function setupKindFor(name: string): SetupKind | null {
  const ext = path.extname(name).toLowerCase()
  if (ext === '.pptx') return 'slides'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.json') return 'json'
  if (ext === '.markdown') return 'text'
  return kindForFile(name)
}

/** Text of every slide, in order, with its notes. */
export function extractPptx(buf: Buffer): SetupExtracted {
  const files = readZip(buf)
  const slideNo = (n: string) => Number(n.match(/(\d+)\.xml$/)?.[1] ?? 0)
  const slides = [...files.keys()].filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b))
  const textOf = (xml: string) => {
    const paras = xml.split(/<\/a:p>/).map(p => [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => decodeXmlEntities(m[1])).join('')).map(s => s.trim()).filter(Boolean)
    return paras
  }
  const parts: string[] = []
  for (const s of slides) {
    const n = slideNo(s)
    const paras = textOf(files.get(s)!.toString('utf8'))
    const notes = files.get(`ppt/notesSlides/notesSlide${n}.xml`)
    const noteParas = notes ? textOf(notes.toString('utf8')).filter(p => !/^\d+$/.test(p)) : []
    parts.push(`## Slide ${n}${paras[0] ? `: ${paras[0]}` : ''}`, '', ...paras.slice(1).map(p => `- ${p}`))
    if (noteParas.length) parts.push('', `Speaker notes: ${noteParas.join(' ')}`)
    parts.push('')
  }
  const warnings = slides.length ? [] : ['No slides were found in this deck.']
  return { kind: 'slides', markdown: parts.join('\n').trim(), pages: slides.length, warnings }
}

/** Visible text of a saved web page: scripts/styles dropped, headings and list items kept. */
export function extractHtml(buf: Buffer): SetupExtracted {
  const html = buf.toString('utf8')
  const md = html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n${'#'.repeat(Number(n))} ${t}\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
  const text = decodeXmlEntities(md.replace(/&nbsp;/g, ' ')).split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] ?? '') !== '').join('\n').trim()
  return { kind: 'html', markdown: text, warnings: text ? [] : ['No readable text in this page.'] }
}

/** JSON exports: pretty-printed, so the AI sees the structure (a CRM export, a chat log). */
export function extractJson(buf: Buffer): SetupExtracted {
  const raw = buf.toString('utf8')
  try {
    return { kind: 'json', markdown: '```json\n' + JSON.stringify(JSON.parse(raw), null, 1) + '\n```', warnings: [] }
  } catch {
    return { kind: 'json', markdown: raw, warnings: ['This file is not valid JSON; it was read as plain text.'] }
  }
}

export function extractForSetup(name: string, buf: Buffer): SetupExtracted {
  const kind = setupKindFor(name)
  if (kind === 'slides') return extractPptx(buf)
  if (kind === 'html') return extractHtml(buf)
  if (kind === 'json') return extractJson(buf)
  if (path.extname(name).toLowerCase() === '.markdown') return extractText('x.md', buf)
  return extractDocument(name, buf)
}
