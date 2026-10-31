import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { writeZip } from '../doc-ingest/zip.js'
import { ENTITY_TYPES, FOLDER_FOR, loadEntityIndex, type EntityType } from '../doc-ingest/notes.js'
import type { LlmCall } from '../doc-ingest/llm.js'
import { appendLog, compileWiki } from './wiki.js'
import {
  createImport, getImport, listImports, listItems, pauseImport, cancelImport, pickBatch, requeueAllImports, resumeImports,
  sampleImportFiles, selectItems, startImport, whenImportsIdle, parseExtractReply, extractionSystemPrompt,
  type ImportItem,
} from './imports.js'

// The compiled-wiki step is owned by another module; imports only need to call it safely.
vi.mock('./wiki.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./wiki.js')>()),
  compileWiki: vi.fn(() => ({ pages: 0, backlinksUpdated: 0, indexWritten: false })),
  appendLog: vi.fn(),
}))
// No real AI in tests.
vi.mock('./llm.js', () => ({ wikiLlm: () => { throw new Error('tests must pass an llm') } }))
// Spy on the KB scan so the "no rescanning" rule is checked.
vi.mock('../doc-ingest/notes.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../doc-ingest/notes.js')>()
  return { ...actual, loadEntityIndex: vi.fn(actual.loadEntityIndex) }
})

const PERSON = (ENTITY_TYPES as readonly string[]).find(t => /person|people/.test(t)) as EntityType
const ORG = ((ENTITY_TYPES as readonly string[]).find(t => /compan|org/.test(t)) ?? PERSON) as EntityType

let kb: string
const NOW = new Date('2026-10-31T12:00:00Z')

beforeEach(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwiki-imports-'))
  vi.mocked(compileWiki).mockClear()
  vi.mocked(appendLog).mockClear()
  vi.mocked(loadEntityIndex).mockClear()
})
afterEach(async () => {
  await whenImportsIdle(kb)
  fs.rmSync(kb, { recursive: true, force: true })
})

const sha = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex')

interface Stub { llm: LlmCall; prompts: string[] }

/** Reads the conversation keys/titles out of the prompt and answers like the real AI would. */
function stubLlm(opts: { onCall?: (n: number) => void | Promise<void>; unique?: boolean } = {}): Stub {
  const prompts: string[] = []
  const llm: LlmCall = async (_system, prompt) => {
    prompts.push(prompt)
    await opts.onCall?.(prompts.length)
    const convs = [...prompt.matchAll(/=== CONVERSATION (c\d+) ===\nKind: .*\nTitle: (.*)/g)].map(([, key, title]) => {
      if (/cat|formula|quiz/i.test(title)) return { key, skip: true, skip_reason: 'small talk' }
      if (opts.unique) return { key, skip: false, summary: 's', entities: [{ type: PERSON, name: `Person ${key}`, facts: [{ fact: `Said hello in ${key}`, where: 'message 1, You' }] }], decisions: [], todos: [] }
      return {
        key, skip: false, title, summary: `About ${title}.`,
        decisions: [{ decision: `Go ahead with ${title}` /* no where: must still be cited */ }],
        todos: [{ todo: 'Send the numbers', owner: 'Sam Okafor', due: '2026-10-01', where: 'message 2, You', about: [{ type: PERSON, name: 'Sam Okafor' }] }],
        entities: [
          { type: ORG, name: 'Fernleaf Garden Supply', summary: 'A garden centre.', facts: [{ fact: `Talked about ${title}`, where: 'message 1, You' }], related: [{ type: PERSON, name: 'Rosa Delgado' }] },
          { type: PERSON, name: 'Rosa Delgado', facts: [{ fact: 'Owns the garden centre' }] },
          { type: PERSON, name: 'Claude', facts: [{ fact: 'should be dropped', where: 'x' }] },
        ],
      }
    })
    return `Here you go:\n\`\`\`json\n${JSON.stringify({ conversations: convs })}\n\`\`\``
  }
  return { llm, prompts }
}

function tinyClaudeExport(n: number, chars = 20): Buffer {
  const conv = Array.from({ length: n }, (_, i) => ({
    uuid: `u-${i}`,
    name: `Chat ${i + 1}`,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 3600_000).toISOString(),
    chat_messages: [
      { sender: 'human', text: `Question ${i + 1} ${'x'.repeat(chars)}` },
      { sender: 'assistant', text: `Answer ${i + 1}` },
    ],
  }))
  return writeZip([['conversations.json', JSON.stringify(conv)]])
}

function readState(id: string): { job: Record<string, unknown>; items: ImportItem[] } {
  const dir = path.join(kb, '.kb-wiki/imports', id)
  return { job: JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')), items: JSON.parse(fs.readFileSync(path.join(dir, 'items.json'), 'utf8')) }
}

function writeState(id: string, job: Record<string, unknown>, items: ImportItem[]): void {
  const dir = path.join(kb, '.kb-wiki/imports', id)
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job))
  fs.writeFileSync(path.join(dir, 'items.json'), JSON.stringify(items))
}

function entityPages(): string[] {
  const out: string[] = []
  for (const folder of Object.values(FOLDER_FOR)) {
    try { for (const n of fs.readdirSync(path.join(kb, folder))) out.push(path.join(kb, folder, n)) } catch { /* none */ }
  }
  return out
}

describe('createImport', () => {
  it('turns the sample files into one job per export plus one for the calls, keeping raw bytes', () => {
    const files = sampleImportFiles()
    expect(files.map(f => f.name)).toEqual([
      'call-2026-09-14-supplier-review.vtt', 'call-2026-09-21-weekly-ops.srt', 'call-2026-09-28-client-walkthrough.json',
      'chatgpt-export-sample.zip', 'claude-export-sample.zip',
    ])
    const jobs = createImport(kb, files, { by: 'rosa', now: NOW })
    expect(jobs.map(j => [j.kind, j.items.length, j.status])).toEqual([
      ['transcripts', 3, 'review'], ['chatgpt-export', 5, 'review'], ['claude-export', 6, 'review'],
    ])
    expect(jobs.map(j => j.id)).toEqual(['2026-10-31-calls', '2026-10-31-chatgpt', '2026-10-31-claude'])
    expect(jobs[2].label).toBe('Claude chats (claude-export-sample.zip)')
    expect(jobs[0].label).toBe('3 call transcripts')
    expect(jobs[0].raw_files).toHaveLength(3)
    expect(jobs[2].raw_files).toEqual(['raw/chat-exports/2026-10-31-claude-claude-export-sample.zip'])
    for (const j of jobs) for (const rel of j.raw_files) {
      const orig = files.find(f => rel.endsWith(f.name))!
      expect(sha(fs.readFileSync(path.join(kb, rel)))).toBe(sha(fs.readFileSync(orig.path)))
    }
    // job.json is metadata only; every chat lives in its own file.
    const { job } = readState('2026-10-31-claude')
    expect(job.items).toBeUndefined()
    expect(job.counts).toMatchObject({ total: 6, selected: 6, pending: 6 })
    expect(fs.readdirSync(path.join(kb, '.kb-wiki/imports/2026-10-31-claude/items')).sort()).toEqual(['c0001.json', 'c0002.json', 'c0003.json', 'c0004.json', 'c0005.json', 'c0006.json'])
    expect(listImports(kb).map(j => j.id)).toHaveLength(3)
    // A second upload the same day gets its own id.
    expect(createImport(kb, [files[4]], { now: NOW })[0].id).toBe('2026-10-31-claude-2')
  })

  it('rejects an unknown file before writing anything', () => {
    expect(() => createImport(kb, [{ name: 'a.vtt', buffer: Buffer.from('WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n<v Ann>hi\n') }, { name: 'pic.png', buffer: Buffer.from('x') }]))
      .toThrow(/pic\.png is not a chat export or call transcript/)
    expect(fs.existsSync(path.join(kb, 'raw'))).toBe(false)
    expect(listImports(kb)).toEqual([])
  })
})

describe('selection', () => {
  it('filters by text, date and length, and selects by filter', () => {
    const [job] = createImport(kb, [{ name: 'claude.zip', path: path.join(path.dirname(sampleImportFiles()[0].path), 'claude-export-sample.zip') }], { now: NOW })
    expect(listItems(kb, job.id, { q: 'hillcrest' }).items.map(i => i.title)).toEqual(['Hillcrest maintenance contract pricing'])
    expect(listItems(kb, job.id, { q: 'marcus bell' }).total).toBe(1) // matches the preview
    expect(listItems(kb, job.id, { from: '2026-05-01', to: '2026-05-31' }).items.map(i => i.title)).toEqual(['Bookkeeping month-end checklist', 'Summer staff rota'])
    expect(listItems(kb, job.id, { min_messages: 5 }).total).toBe(2)
    expect(listItems(kb, job.id, { limit: 2, offset: 4 }).items.map(i => i.key)).toEqual(['c0005', 'c0006'])

    const r = selectItems(kb, job.id, { all_matching: { to: '2026-04-30' }, selected: false })
    expect(r.changed).toBe(2)
    expect(r.counts.selected).toBe(4)
    selectItems(kb, job.id, { keys: ['c0006'], selected: false })
    expect(getImport(kb, job.id).counts.selected).toBe(3)
  })

  it('imports only the ticked chats', async () => {
    const [job] = createImport(kb, [{ name: 'claude.zip', buffer: fs.readFileSync(sampleImportFiles().find(f => f.name.startsWith('claude'))!.path) }], { now: NOW })
    selectItems(kb, job.id, { all_matching: { from: '2026-05-01' }, selected: false })
    const s = stubLlm()
    startImport(kb, job.id, { llm: s.llm, now: () => NOW })
    await whenImportsIdle(kb)
    const done = getImport(kb, job.id)
    expect(done.status).toBe('done')
    expect(done.items.filter(i => i.status === 'done').map(i => i.title)).toEqual(['Spring opening plan', 'Hillcrest maintenance contract pricing'])
    expect(done.items.filter(i => i.status === 'pending')).toHaveLength(4)
    expect(s.prompts.join('\n')).not.toMatch(/Summer staff rota/)
    expect(() => startImport(kb, job.id, { llm: s.llm })).toThrow(/already been imported/)
  })
})

describe('running an import', () => {
  it('imports the samples: small talk skipped, pages cited, raw untouched, wiki compiled and logged', async () => {
    const files = sampleImportFiles()
    const before = new Map(files.map(f => [f.name, sha(fs.readFileSync(f.path))]))
    const jobs = createImport(kb, files, { now: NOW })
    const s = stubLlm()
    for (const j of jobs) startImport(kb, j.id, { llm: s.llm, now: () => NOW })
    await whenImportsIdle(kb)

    const claude = getImport(kb, '2026-10-31-claude')
    expect(claude.status).toBe('done')
    expect(claude.counts).toMatchObject({ done: 4, skipped: 2, failed: 0, queued: 0 })
    expect(claude.items.find(i => i.title === 'Names for the shop cat')).toMatchObject({ status: 'skipped', skip_reason: 'small talk' })
    const gpt = getImport(kb, '2026-10-31-chatgpt')
    expect(gpt.counts).toMatchObject({ done: 4, skipped: 1 })
    expect(getImport(kb, '2026-10-31-calls').counts).toMatchObject({ done: 3 })

    // Batching: 6 + 5 + 3 small chats → one AI call per job.
    expect(s.prompts).toHaveLength(3)
    expect(extractionSystemPrompt()).toMatch(/small talk/)

    // Readable copies.
    const spring = claude.items.find(i => i.title === 'Spring opening plan')!
    expect(spring.source_note).toBe('sources/conversations/2026-10-31-claude/c0001-spring-opening-plan.md')
    const note = fs.readFileSync(path.join(kb, spring.source_note!), 'utf8')
    expect(note).toMatch(/^---\ntitle: Spring opening plan\ntype: source\norigin: claude\ndate: 2026-02-03\n/)
    expect(note).toMatch(/generated_by: kb-wiki/)
    expect(note).toMatch(/raw_file: raw\/chat-exports\/2026-10-31-claude-claude-export-sample.zip/)
    expect(note).toMatch(/## Decisions\n\n- Go ahead with Spring opening plan \*\(whole chat\)\*/)
    expect(note).toMatch(/## To-dos\n\n- Send the numbers — Sam Okafor, due 2026-10-01 \*\(message 2, You\)\*/)
    expect(note).toMatch(/## Pages made from this conversation\n\n- \[\[/)
    expect(note).toMatch(/## Conversation\n\n\*\*1\. You\*\*/)
    const gptNote = fs.readFileSync(path.join(kb, gpt.items[0].source_note!), 'utf8')
    expect(gptNote).not.toMatch(/OLD BRANCH/)
    expect(fs.existsSync(path.join(kb, 'sources/conversations/2026-10-31-claude'))).toBe(true)
    expect(fs.readdirSync(path.join(kb, 'sources/conversations/2026-10-31-claude'))).toHaveLength(4) // skipped chats get no page

    // Entity pages: one per entity across every source, assistant never an entity, every fact cited.
    const pages = entityPages()
    expect(pages.map(p => path.basename(p)).sort()).toEqual(['fernleaf-garden-supply.md', 'rosa-delgado.md', 'sam-okafor.md'])
    const org = fs.readFileSync(pages.find(p => p.endsWith('fernleaf-garden-supply.md'))!, 'utf8')
    expect(org).toMatch(/## From: Claude chat: Spring opening plan \(2026-02-03\)/)
    expect(org).toMatch(/## From: ChatGPT chat: Greenway Growers late deliveries \(2026-03-24\)/)
    expect(org).toMatch(/## From: Call: call-2026-09-14-supplier-review \(2026-09-14\)/)
    expect(org).toMatch(/- Decision: Go ahead with Spring opening plan \*\(whole chat\)\*/)
    const sam = fs.readFileSync(pages.find(p => p.endsWith('sam-okafor.md'))!, 'utf8')
    expect(sam).toMatch(/- To-do: Send the numbers — Sam Okafor, due 2026-10-01 \*\(message 2, You\)\*/)
    let factLines = 0
    for (const p of pages) {
      for (const sec of fs.readFileSync(p, 'utf8').split(/^## /m).filter(x => x.startsWith('From: '))) {
        for (const line of sec.split('\n').filter(l => l.startsWith('- '))) {
          factLines++
          expect(line).toMatch(/ \*\([^)]+\)\*$/)
        }
      }
    }
    expect(factLines).toBeGreaterThan(20)

    // Raw files are byte-identical after processing.
    for (const j of listImports(kb)) for (const rel of j.raw_files) {
      const name = files.find(f => rel.endsWith(f.name))!.name
      expect(sha(fs.readFileSync(path.join(kb, rel)))).toBe(before.get(name))
    }

    expect(vi.mocked(compileWiki)).toHaveBeenCalled()
    const titles = vi.mocked(appendLog).mock.calls.map(c => c[1].title)
    expect(titles).toContain('Imported 4 of 6 chats from Claude chats (claude-export-sample.zip) (2 skipped as small talk)')
    expect(titles).toContain('Imported 3 of 3 calls from 3 call transcripts (0 skipped as small talk)')
    expect(vi.mocked(appendLog).mock.calls.every(c => c[1].kind === 'import')).toBe(true)
  })

  it('never fails because the wiki compile or log throws', async () => {
    vi.mocked(compileWiki).mockImplementationOnce(() => { throw new Error('not implemented') })
    vi.mocked(appendLog).mockImplementationOnce(() => { throw new Error('not implemented') })
    const [job] = createImport(kb, [{ name: 'x.zip', buffer: tinyClaudeExport(3) }], { now: NOW })
    startImport(kb, job.id, { llm: stubLlm().llm })
    await whenImportsIdle(kb)
    expect(getImport(kb, job.id)).toMatchObject({ status: 'done', counts: { done: 3 } })
  })

  it('re-asks once when the reply is not JSON, and re-importing replaces a chat\'s own section', async () => {
    const good = stubLlm()
    let n = 0
    const llm: LlmCall = async (s, p) => (++n === 1 ? 'Sorry, I cannot do that.' : good.llm(s, p))
    const [job] = createImport(kb, [{ name: 'x.zip', buffer: tinyClaudeExport(2) }], { now: NOW })
    startImport(kb, job.id, { llm })
    await whenImportsIdle(kb)
    expect(n).toBe(2)
    expect(getImport(kb, job.id).counts.done).toBe(2)

    const org = () => fs.readFileSync(entityPages().find(p => p.endsWith('fernleaf-garden-supply.md'))!, 'utf8')
    expect(requeueAllImports(kb)).toBe(2)
    expect(getImport(kb, job.id).status).toBe('running')
    resumeImports(kb, { llm: good.llm })
    await whenImportsIdle(kb)
    expect(org().match(/## From: /g)).toHaveLength(2)
    for (const fact of ['Talked about Chat 1', 'Decision: Go ahead with Chat 2']) expect(org().split(fact)).toHaveLength(2)
  })

  it('cuts a very long chat into parts and merges them into one source note', async () => {
    const big = writeZip([['conversations.json', JSON.stringify([{
      uuid: 'big', name: 'Huge planning chat', created_at: '2026-01-01T00:00:00Z',
      chat_messages: ['a', 'b', 'c'].map(ch => ({ sender: 'human', text: ch.repeat(50_000) })),
    }])]])
    const [job] = createImport(kb, [{ name: 'big.zip', buffer: big }], { now: NOW })
    const s = stubLlm()
    startImport(kb, job.id, { llm: s.llm })
    await whenImportsIdle(kb)
    expect(s.prompts).toHaveLength(3)
    expect(s.prompts[0]).toMatch(/PART 1 of 3/)
    expect(s.prompts.every(p => p.length < 110_000)).toBe(true)
    const it0 = getImport(kb, job.id).items[0]
    expect(it0.status).toBe('done')
    const note = fs.readFileSync(path.join(kb, it0.source_note!), 'utf8')
    expect(note.match(/- Go ahead with Huge planning chat/g)).toHaveLength(3) // one decision per part, merged
  })

  it('pause finishes the batch in flight, then resume picks up where it stopped', async () => {
    const [job] = createImport(kb, [{ name: 'x.zip', buffer: tinyClaudeExport(40) }], { now: NOW })
    const s = stubLlm({ onCall: n => { if (n === 2) pauseImport(kb, job.id) } })
    startImport(kb, job.id, { llm: s.llm })
    await whenImportsIdle(kb)
    let j = getImport(kb, job.id)
    expect(j.status).toBe('paused')
    expect(j.counts).toMatchObject({ done: 16, queued: 24, working: 0 })
    expect(s.prompts).toHaveLength(2)
    expect(vi.mocked(appendLog).mock.calls.at(-1)![1].title).toBe('Imported 16 of 40 chats from Claude chats (x.zip) (0 skipped as small talk) — paused')

    startImport(kb, job.id, { llm: s.llm })
    await whenImportsIdle(kb)
    j = getImport(kb, job.id)
    expect(j.status).toBe('done')
    expect(j.counts.done).toBe(40)
    expect(s.prompts).toHaveLength(5)
    // Every chat was sent to the AI exactly once.
    const keys = s.prompts.flatMap(p => [...p.matchAll(/=== CONVERSATION (c\d+) ===/g)].map(m => m[1]))
    expect(keys).toHaveLength(40)
    expect(new Set(keys).size).toBe(40)
  })

  it('a restart mid-batch (items left "working") resumes without redoing finished chats', async () => {
    const [job] = createImport(kb, [{ name: 'x.zip', buffer: tinyClaudeExport(20) }], { now: NOW })
    // Simulate the state a crash leaves behind: first batch done, second batch working.
    const { job: meta, items } = readState(job.id)
    items.forEach((it, i) => { it.status = i < 8 ? 'done' : i < 16 ? 'working' : 'queued' })
    writeState(job.id, { ...meta, status: 'running' }, items)

    const s = stubLlm()
    expect(resumeImports(kb, { llm: s.llm })).toBe(1)
    expect(readState(job.id).items.filter(i => i.status === 'working')).toHaveLength(0)
    await whenImportsIdle(kb)
    const j = getImport(kb, job.id)
    expect(j.status).toBe('done')
    expect(j.counts.done).toBe(20)
    expect(s.prompts).toHaveLength(2)
    const keys = s.prompts.flatMap(p => [...p.matchAll(/=== CONVERSATION (c\d+) ===/g)].map(m => m[1]))
    expect(keys).toEqual(Array.from({ length: 12 }, (_, i) => `c${String(i + 9).padStart(4, '0')}`))
  })

  it('cancel un-queues the rest and keeps the raw upload', async () => {
    const [job] = createImport(kb, [{ name: 'x.zip', buffer: tinyClaudeExport(20) }], { now: NOW })
    const s = stubLlm({ onCall: n => { if (n === 1) cancelImport(kb, job.id) } })
    startImport(kb, job.id, { llm: s.llm })
    await whenImportsIdle(kb)
    const j = getImport(kb, job.id)
    expect(j.status).toBe('cancelled')
    expect(j.counts).toMatchObject({ done: 8, pending: 12, queued: 0 })
    expect(fs.existsSync(path.join(kb, j.raw_files[0]))).toBe(true)
  })

  it('stops a job after repeated AI failures, with a plain error', async () => {
    const [job] = createImport(kb, [{ name: 'x.zip', buffer: tinyClaudeExport(40) }], { now: NOW })
    let calls = 0
    startImport(kb, job.id, { llm: async () => { calls++; throw new Error('No AI account is connected.') } })
    await whenImportsIdle(kb)
    const j = getImport(kb, job.id)
    expect(j.status).toBe('failed')
    expect(j.error).toMatch(/No AI account is connected/)
    expect(j.counts).toMatchObject({ failed: 24, queued: 16 })
    expect(calls).toBe(3)
    // Starting again retries the failed ones.
    const s = stubLlm()
    startImport(kb, job.id, { llm: s.llm })
    await whenImportsIdle(kb)
    expect(getImport(kb, job.id).counts.done).toBe(40)
  })

  it('a large export (2,000 chats) uses a bounded number of AI calls and scans the KB once', async () => {
    const [job] = createImport(kb, [{ name: 'big.zip', buffer: tinyClaudeExport(2000) }], { now: NOW })
    expect(job.items).toHaveLength(2000)
    vi.mocked(loadEntityIndex).mockClear()
    const s = stubLlm({ unique: true })
    startImport(kb, job.id, { llm: s.llm })
    await whenImportsIdle(kb)
    const j = getImport(kb, job.id)
    expect(j.counts.done).toBe(2000)
    expect(s.prompts).toHaveLength(250) // 8 chats per call
    expect(vi.mocked(loadEntityIndex)).toHaveBeenCalledTimes(1)
    // Compiled periodically (every 10 batches) plus once at the end — not per chat.
    const compiles = vi.mocked(compileWiki).mock.calls.length
    expect(compiles).toBeGreaterThanOrEqual(25)
    expect(compiles).toBeLessThanOrEqual(27)
    expect(fs.statSync(path.join(kb, '.kb-wiki/imports', job.id, 'job.json')).size).toBeLessThan(2000)
  }, 60_000)
})

describe('helpers', () => {
  it('pickBatch: ≤ 8 chats, ≤ 40k chars, a big one alone', () => {
    const mk = (chars: number, i: number): ImportItem => ({ key: `c${i}`, title: '', participants: [], message_count: 1, chars, preview: '', selected: true, status: 'queued' })
    expect(pickBatch(Array.from({ length: 20 }, (_, i) => mk(100, i)))).toHaveLength(8)
    expect(pickBatch([mk(30_000, 1), mk(15_000, 2)])).toHaveLength(1)
    expect(pickBatch([mk(90_000, 1), mk(10, 2)])).toHaveLength(1)
    expect(pickBatch([mk(10, 1), mk(90_000, 2)])).toHaveLength(1)
  })
  it('parseExtractReply tolerates chatter and drops malformed rows', () => {
    const r = parseExtractReply('ok {"note": 1} then {"conversations": [{"key": "c0001", "skip": true, "skip_reason": "jokes"}, {"nokey": 1}, {"key": "c0002", "decisions": [{"decision": "x"}, {}]}]}')
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ key: 'c0001', skip: true, skip_reason: 'jokes' })
    expect(r[1].decisions).toEqual([{ decision: 'x', where: undefined, about: [] }])
    expect(() => parseExtractReply('nothing here')).toThrow(/no JSON/)
  })
  it('the extraction prompt is generic and lists the knowledge base\'s own types', () => {
    const p = extractionSystemPrompt()
    for (const t of ENTITY_TYPES) expect(p).toContain(`"${t}"`)
    expect(p).not.toMatch(/private equity|example/i)
  })
})

describe('displayTitle', () => {
  it('prefers the AI title only when the parsed one is a file name or untitled', async () => {
    const { displayTitle } = await import('./imports.js')
    expect(displayTitle('call-2026-09-21-weekly-ops', 'Weekly ops call')).toBe('Weekly ops call')
    expect(displayTitle('Untitled chat', 'Mower budget')).toBe('Mower budget')
    expect(displayTitle('Spring opening plan', 'Something else')).toBe('Spring opening plan')
    expect(displayTitle('call-2026-09-21-weekly-ops', '')).toBe('call-2026-09-21-weekly-ops')
  })
})

describe('keeping raw exports out of git', () => {
  it('adds raw/ and .kb-wiki/ to the KB .gitignore once, keeping what was there', async () => {
    const os = await import('os')
    const { ensureKbGitignore } = await import('./paths.js')
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwiki-gi-'))
    fs.writeFileSync(path.join(kb, '.gitignore'), '_import/')
    ensureKbGitignore(kb)
    ensureKbGitignore(kb)
    const text = fs.readFileSync(path.join(kb, '.gitignore'), 'utf8')
    expect(text.startsWith('_import/\n')).toBe(true)
    expect(text.match(/^raw\/$/gm)).toHaveLength(1)
    expect(text.match(/^\.kb-wiki\/$/gm)).toHaveLength(1)
  })
})
