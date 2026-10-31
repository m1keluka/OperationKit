import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const requeueAllImports = vi.fn((_kb: string) => 3)
vi.mock('./imports.js', () => ({ requeueAllImports: (kb: string) => requeueAllImports(kb) }))

const { rebuildWiki } = await import('./rebuild.js')
const { readManifest } = await import('../doc-ingest/ingest.js')

let kb: string
beforeEach(() => { kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwiki-rb-')); requeueAllImports.mockClear() })
afterEach(() => { fs.rmSync(kb, { recursive: true, force: true }) })

function put(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(kb, rel)), { recursive: true })
  fs.writeFileSync(path.join(kb, rel), text)
}
const exists = (rel: string) => fs.existsSync(path.join(kb, rel))

describe('rebuildWiki', () => {
  it('moves compiled pages to the trash, keeps raw + answers, requeues documents and imports', () => {
    const gen = (by: string, body: string) => `---\ntitle: x\ngenerated_by: ${by}\n---\n${body}\n`
    put('organizations/greenway-growers.md', gen('document-ingest', '# Greenway'))
    put('people/rosa-delgado.md', gen('document-ingest', '# Rosa'))
    put('people/my-own-note.md', '---\ntitle: Mine\n---\n# Written by hand — a rebuild must leave it alone')
    put('sources/2026-10-01-list.md', gen('document-ingest', '# list'))
    put('sources/conversations/job1/c0001-x.md', gen('kb-wiki', '# chat'))
    put('sources/files/2026-10-01-list.xlsx', 'original')
    put('sources/inbox/waiting.pdf', 'pending')
    put('raw/chat-exports/job1-export.zip', 'zip')
    put('answers/2026-10-03-q.md', '# q')
    put('notes/mine.md', 'hand-written folder outside the wiki')
    put('sources/_manifest.json', JSON.stringify([
      { id: 'a', file_name: 'list.xlsx', stored: 'sources/files/2026-10-01-list.xlsx', kind: 'spreadsheet', status: 'done', uploaded_at: 'x', finished_at: 'y' },
      { id: 'b', file_name: 'bad.exe', stored: 'z', kind: 'unsupported', status: 'failed', uploaded_at: 'x' },
    ]))

    const now = new Date('2026-10-31T12:00:00.000Z')
    const r = rebuildWiki(kb, { now })
    expect(r).toEqual({ moved: 4, trash: '.kb-wiki/trash/2026-10-31T12-00-00-000Z', docsRequeued: 1, importsRequeued: 3 })
    expect(requeueAllImports).toHaveBeenCalledWith(kb)
    for (const rel of ['organizations/greenway-growers.md', 'people/rosa-delgado.md', 'sources/2026-10-01-list.md', 'sources/conversations/job1/c0001-x.md']) {
      expect(exists(rel)).toBe(false)
      expect(exists(`${r.trash}/${rel}`)).toBe(true)
    }
    for (const rel of ['sources/files/2026-10-01-list.xlsx', 'sources/inbox/waiting.pdf', 'raw/chat-exports/job1-export.zip', 'answers/2026-10-03-q.md', 'notes/mine.md', 'people/my-own-note.md', 'sources/_manifest.json']) {
      expect(exists(rel)).toBe(true)
    }
    expect(readManifest(kb).map(e => e.status)).toEqual(['queued', 'failed'])
    const log = fs.readFileSync(path.join(kb, 'log.md'), 'utf8')
    expect(log).toContain('rebuild | Started rebuilding the wiki: 4 pages set aside, 1 document and 3 conversations queued to be read again')
    expect(fs.readFileSync(path.join(kb, 'index.md'), 'utf8')).toContain('## Answers (1)')
  })
})
