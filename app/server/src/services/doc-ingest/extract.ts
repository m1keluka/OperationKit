import { execFileSync } from 'child_process'
import path from 'path'
import zlib from 'zlib'
import { readZip } from './zip.js'

/**
 * Document → plain-text/markdown extraction for the document-ingest starter
 * pack (obj 719936).
 *
 * Zero dependencies on purpose: Excel/Word are ZIP+XML (see zip.ts), CSV and
 * transcripts are text, and PDF text is pulled from the content streams with
 * zlib. Everything runs on the client's own server — no file content leaves
 * the box during extraction. `pdftotext` (poppler) is used when installed
 * because it handles exotic font encodings better; otherwise the built-in
 * reader covers ordinary text PDFs (Word/Google/LibreOffice exports).
 *
 * The output is faithful, not clever: every sheet, header row and cell value
 * is kept as found (messy column names included). Making sense of it is the
 * ingest agent's job, and it needs the raw shape to cite the source.
 */

export type DocKind = 'spreadsheet' | 'csv' | 'pdf' | 'word' | 'text'

export interface Extracted {
  kind: DocKind
  /** Markdown rendering of the document content. */
  markdown: string
  /** Sheet names (spreadsheets) — useful for "which tab said this". */
  sheets?: string[]
  pages?: number
  /** Non-fatal notes for the reader, e.g. "PDF had no extractable text". */
  warnings: string[]
}

export const SUPPORTED_EXTENSIONS = ['.xlsx', '.xlsm', '.csv', '.tsv', '.pdf', '.docx', '.txt', '.md', '.vtt', '.srt'] as const

export function kindForFile(name: string): DocKind | null {
  const ext = path.extname(name).toLowerCase()
  if (ext === '.xlsx' || ext === '.xlsm') return 'spreadsheet'
  if (ext === '.csv' || ext === '.tsv') return 'csv'
  if (ext === '.pdf') return 'pdf'
  if (ext === '.docx') return 'word'
  if (ext === '.txt' || ext === '.md' || ext === '.vtt' || ext === '.srt') return 'text'
  return null
}

export class UnsupportedFileError extends Error {}

/** Cap the rows rendered per sheet so one huge export cannot blow up a prompt. */
const MAX_ROWS_PER_SHEET = 2000

export function extractDocument(name: string, buf: Buffer): Extracted {
  const kind = kindForFile(name)
  if (!kind) {
    throw new UnsupportedFileError(
      `Can't read "${path.extname(name) || name}" files yet. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}. ` +
      `Old .xls/.doc files: open them and "Save As" .xlsx/.docx first.`,
    )
  }
  switch (kind) {
    case 'spreadsheet': return extractXlsx(buf)
    case 'csv': return extractCsv(buf, path.extname(name).toLowerCase() === '.tsv' ? '\t' : ',')
    case 'pdf': return extractPdf(buf)
    case 'word': return extractDocx(buf)
    case 'text': return extractText(name, buf)
  }
}

// ── XML helpers (OOXML is regular enough for targeted regexes) ───────────────

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e === 'amp') return '&'
    if (e === 'lt') return '<'
    if (e === 'gt') return '>'
    if (e === 'quot') return '"'
    if (e === 'apos') return "'"
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  })
}

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
  return m ? decodeXmlEntities(m[1]) : undefined
}

/** Concatenate every <t>…</t> (or <w:t>) run inside a fragment. */
function textRuns(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  let out = ''
  for (const m of xml.matchAll(re)) out += decodeXmlEntities(m[1])
  return out
}

function mdCell(v: string): string {
  return v.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim()
}

function mdTable(rows: string[][]): string {
  if (!rows.length) return '_(empty)_'
  const width = Math.max(...rows.map(r => r.length))
  const pad = (r: string[]) => Array.from({ length: width }, (_, i) => mdCell(r[i] ?? ''))
  const [head, ...body] = rows
  const lines = [`| ${pad(head).join(' | ')} |`, `|${' --- |'.repeat(width)}`]
  for (const r of body) lines.push(`| ${pad(r).join(' | ')} |`)
  return lines.join('\n')
}

// ── Excel (.xlsx) ────────────────────────────────────────────────────────────

/** Built-in Excel number formats that are dates. */
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57])

function colIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** Excel serial date (1900 system) → YYYY-MM-DD. */
export function excelSerialToIso(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000)
  return new Date(ms).toISOString().slice(0, 10)
}

function resolveZipPath(base: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = base.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.') parts.push(seg)
  }
  return parts.join('/')
}

export function extractXlsx(buf: Buffer): Extracted {
  const zip = readZip(buf)
  const get = (p: string) => zip.get(p)?.toString('utf8')
  const workbook = get('xl/workbook.xml')
  if (!workbook) throw new UnsupportedFileError('This file is not an Excel workbook (no xl/workbook.xml).')

  const shared: string[] = []
  const sst = get('xl/sharedStrings.xml')
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(textRuns(m[1], 't'))

  // Which style indexes are dates: cellXfs[i].numFmtId → built-in or custom date format.
  const dateStyles = new Set<number>()
  const styles = get('xl/styles.xml')
  if (styles) {
    const customDate = new Set<number>()
    for (const m of styles.matchAll(/<numFmt\s[^>]*>/g)) {
      const id = Number(attr(m[0], 'numFmtId'))
      const code = (attr(m[0], 'formatCode') ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase()
      if (/[dy]/.test(code) || /m{1,4}.*[dy]|[dy].*m/.test(code)) customDate.add(id)
    }
    const xfs = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? ''
    let i = 0
    for (const m of xfs.matchAll(/<xf\s[^>]*?\/?>/g)) {
      const id = Number(attr(m[0], 'numFmtId') ?? 0)
      if (BUILTIN_DATE_FMTS.has(id) || customDate.has(id)) dateStyles.add(i)
      i++
    }
  }

  const rels = new Map<string, string>()
  for (const m of (get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attr(m[0], 'Id')
    const target = attr(m[0], 'Target')
    if (id && target) rels.set(id, resolveZipPath('xl/workbook.xml', target))
  }

  const sheets: string[] = []
  const sections: string[] = []
  const warnings: string[] = []
  for (const m of workbook.matchAll(/<sheet\s[^>]*>/g)) {
    const name = attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`
    const rid = attr(m[0], 'r:id')
    const xml = rid ? get(rels.get(rid) ?? '') : undefined
    sheets.push(name)
    if (!xml) { sections.push(`## Sheet: ${name}\n\n_(could not read this sheet)_`); continue }

    const rows: string[][] = []
    let truncated = 0
    for (const rm of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const row: string[] = []
      for (const cm of (rm[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const head = cm[1]
        const body = cm[2] ?? ''
        const ref = attr(head, 'r')
        const t = attr(head, 't')
        const s = Number(attr(head, 's') ?? -1)
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
        let val = ''
        if (t === 's') val = shared[Number(v)] ?? ''
        else if (t === 'inlineStr') val = textRuns(body, 't')
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE'
        else if (v !== undefined) {
          val = decodeXmlEntities(v)
          const num = Number(val)
          if (t !== 'str' && t !== 'e' && dateStyles.has(s) && Number.isFinite(num)) val = excelSerialToIso(num)
        }
        const idx = ref ? colIndex(ref) : row.length
        while (row.length < idx) row.push('')
        row[idx] = val
      }
      if (row.every(c => c.trim() === '')) continue
      if (rows.length >= MAX_ROWS_PER_SHEET) { truncated++; continue }
      rows.push(row)
    }
    if (truncated) warnings.push(`Sheet "${name}": showing first ${MAX_ROWS_PER_SHEET} rows, ${truncated} more not shown.`)
    sections.push(`## Sheet: ${name}\n\n${rows.length} non-empty row(s).\n\n${mdTable(rows)}`)
  }
  return { kind: 'spreadsheet', sheets, markdown: sections.join('\n\n'), warnings }
}

// ── CSV / TSV ────────────────────────────────────────────────────────────────

export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === delim) { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      rows.push(row); row = []
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows.filter(r => r.some(c => c.trim() !== ''))
}

function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  const s = buf.toString('utf8')
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function extractCsv(buf: Buffer, delim: string): Extracted {
  const rows = parseDelimited(decodeText(buf), delim)
  const warnings: string[] = []
  const shown = rows.slice(0, MAX_ROWS_PER_SHEET)
  if (rows.length > shown.length) warnings.push(`Showing first ${MAX_ROWS_PER_SHEET} rows, ${rows.length - shown.length} more not shown.`)
  return { kind: 'csv', markdown: `${rows.length} non-empty row(s).\n\n${mdTable(shown)}`, warnings }
}

// ── Word (.docx) ─────────────────────────────────────────────────────────────

function docxParagraph(p: string): string {
  // Tabs and breaks inside a run become spaces/newlines; text lives in <w:t>.
  const text = decodeXmlEntities(
    p.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n')
      .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, '\u0000$1\u0001')
      .replace(/[^\u0000\u0001]*?(?:\u0000([\s\S]*?)\u0001|$)/g, (_, t) => t ?? '')
  ).replace(/[\t ]+/g, ' ').trim()
  if (!text) return ''
  const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? ''
  const h = style.match(/^(?:Heading|heading)\s?(\d)$/)?.[1] ?? (/^Title$/i.test(style) ? '1' : undefined)
  if (h) return `${'#'.repeat(Math.min(6, Number(h) + 1))} ${text}`
  if (/<w:numPr>/.test(p) || /List/i.test(style)) return `- ${text}`
  return text
}

export function extractDocx(buf: Buffer): Extracted {
  const zip = readZip(buf)
  const doc = zip.get('word/document.xml')?.toString('utf8')
  if (!doc) throw new UnsupportedFileError('This file is not a Word document (no word/document.xml).')
  const body = doc.match(/<w:body>([\s\S]*)<\/w:body>/)?.[1] ?? doc
  const blocks: string[] = []
  // Walk top-level tables and paragraphs in document order.
  for (const m of body.matchAll(/<w:tbl>([\s\S]*?)<\/w:tbl>|<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)) {
    if (m[1] !== undefined) {
      const rows: string[][] = []
      for (const tr of m[1].matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
        const cells: string[] = []
        for (const tc of tr[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
          cells.push([...tc[1].matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map(pm => docxParagraph(pm[1] ?? '')).filter(Boolean).join(' / '))
        }
        rows.push(cells)
      }
      blocks.push(mdTable(rows))
    } else {
      const para = docxParagraph(m[2] ?? '')
      if (para) blocks.push(para)
    }
  }
  return { kind: 'word', markdown: blocks.join('\n\n'), warnings: [] }
}

// ── PDF ──────────────────────────────────────────────────────────────────────

function pdftotextAvailable(): boolean {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function decodePdfLiteral(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_, e: string) => {
    if (e === 'n') return '\n'
    if (e === 'r') return '\r'
    if (e === 't') return '\t'
    if (e === 'b' || e === 'f') return ''
    if (e === '(' || e === ')' || e === '\\') return e
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return '' // escaped line break = continuation
  })
}

function decodePdfHex(h: string): string {
  const clean = h.replace(/\s+/g, '')
  const bytes = Buffer.from(clean.length % 2 ? clean + '0' : clean, 'hex')
  // UTF-16BE with BOM, otherwise single-byte.
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return bytes.subarray(2).swap16().toString('utf16le')
  return bytes.toString('latin1')
}

/** Pull text out of one decoded content stream (BT … ET text objects). */
export function pdfContentToText(content: string): string {
  let out = ''
  const tokenRe = /\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\[[^\]]*\]|-?\d*\.?\d+|\/[^\s/<>[\]()]+|[A-Za-z'"*]+/g
  const stack: string[] = []
  for (const m of content.matchAll(tokenRe)) {
    const tok = m[0]
    if (/^[A-Za-z'"*]+$/.test(tok) && !tok.startsWith('/')) {
      switch (tok) {
        case 'Tj': case "'": case '"': {
          const s = stack[stack.length - 1] ?? ''
          if (tok !== 'Tj') out += '\n'
          out += s
          break
        }
        case 'TJ': {
          const arr = stack[stack.length - 1] ?? ''
          for (const part of arr.matchAll(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|-?\d*\.?\d+/g)) {
            const p = part[0]
            if (p.startsWith('(')) out += decodePdfLiteral(p.slice(1, -1))
            else if (p.startsWith('<')) out += decodePdfHex(p.slice(1, -1))
            else if (Number(p) < -200) out += ' ' // big negative kern = word gap
          }
          break
        }
        case 'Td': case 'TD': {
          const ty = Number(stack[stack.length - 1])
          out += ty !== 0 ? '\n' : ' '
          break
        }
        case 'T*': case 'Tm': out += '\n'; break
        case 'ET': out += '\n'; break
      }
      stack.length = 0
      continue
    }
    if (tok.startsWith('(')) stack.push(decodePdfLiteral(tok.slice(1, -1)))
    else if (tok.startsWith('<')) stack.push(decodePdfHex(tok.slice(1, -1)))
    else stack.push(tok)
  }
  return out
}

export function extractPdfBuiltin(buf: Buffer): { text: string; pages: number } {
  const raw = buf.toString('latin1')
  const pages = (raw.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
  const parts: string[] = []
  const streamRe = /<<((?:[^<>]|<<(?:[^<>]|<<[^<>]*>>)*>>|<[^<>]*>)*)>>\s*stream\r?\n/g
  for (const m of raw.matchAll(streamRe)) {
    const dict = m[1]
    if (/\/Subtype\s*\/(Image|XML)|\/Type\s*\/(XObject|Metadata|XRef|ObjStm)|\/Length1|\/FontFile/.test(dict)) continue
    const start = (m.index ?? 0) + m[0].length
    const lenMatch = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/)
    const end = lenMatch ? start + Number(lenMatch[1]) : raw.indexOf('endstream', start)
    if (end <= start) continue
    let data = buf.subarray(start, end)
    if (/\/FlateDecode/.test(dict)) {
      try { data = zlib.inflateSync(data) } catch {
        try { data = zlib.inflateRawSync(data.subarray(2)) } catch { continue }
      }
    } else if (/\/Filter/.test(dict)) continue // other filters (DCT, LZW…) aren't text
    const text = pdfContentToText(data.toString('latin1'))
    if (text.trim()) parts.push(text)
  }
  const text = parts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return { text, pages }
}

export function extractPdf(buf: Buffer): Extracted {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new UnsupportedFileError('This file is not a PDF.')
  const warnings: string[] = []
  let text = ''
  let pages = 0
  if (pdftotextAvailable()) {
    try {
      text = execFileSync('pdftotext', ['-layout', '-q', '-', '-'], { input: buf, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }).toString('utf8')
      pages = (text.match(/\f/g) ?? []).length || 0
      text = text.replace(/\f/g, '\n\n').trim()
    } catch { text = '' }
  }
  if (!text) {
    const r = extractPdfBuiltin(buf)
    text = r.text
    pages = r.pages
  }
  if (!text.trim() || !/[A-Za-z]{3,}/.test(text)) {
    warnings.push('No readable text found in this PDF. It may be a scanned image — ask for the original document or an OCR\'d copy.')
    text = ''
  }
  return { kind: 'pdf', markdown: text, pages, warnings }
}

// ── Transcripts and plain text ───────────────────────────────────────────────

export function extractText(name: string, buf: Buffer): Extracted {
  let text = decodeText(buf)
  const ext = path.extname(name).toLowerCase()
  if (ext === '.vtt' || ext === '.srt') {
    // Drop cue numbers, timestamps and the WEBVTT header; keep speaker lines.
    text = text
      .split(/\r?\n/)
      .filter(l => !/^(WEBVTT|NOTE\b|\d+$|\d{1,2}:\d{2}(:\d{2})?[.,]\d{3}\s*-->)/.test(l.trim()))
      .map(l => l.replace(/<v\s+([^>]+)>/g, '$1: ').replace(/<\/?[^>]+>/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
  }
  return { kind: 'text', markdown: text.trim(), warnings: [] }
}
