import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { upsertEntityNote, type Entity } from '../doc-ingest/notes.js'
import { findDuplicates, lastLintRun, parseContradictions, runLint } from './lint.js'
import { scanWiki } from './wiki.js'

let kb: string
beforeEach(() => { kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwiki-lint-')) })
afterEach(() => { fs.rmSync(kb, { recursive: true, force: true }) })

function put(rel: string, text: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(kb, rel)), { recursive: true })
  fs.writeFileSync(path.join(kb, rel), text)
}
const read = (rel: string) => fs.readFileSync(path.join(kb, rel), 'utf8')
const page = (title: string, body: string, extra = '') => `---\ntitle: ${title}\ntype: x\n${extra}updated: 2026-10-20\n---\n# ${title}\n\n${body}\n`

const NOW = new Date('2026-10-31T03:00:00Z')

/** Every file under the protected folders, with its sha256. */
function rawHashes(): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    const abs = path.join(kb, rel)
    if (!fs.existsSync(abs)) return
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(kb, r))).digest('hex')
    }
  }
  for (const d of ['raw', 'sources/files', 'sources/inbox']) walk(d)
  return out
}

function seed(): void {
  put('people/rosa-delgado.md', page('Rosa Delgado', 'Owner. Works with [[organizations/greenway]] and [[Hillcrest]]. Planning the [[Spring Sale]] and [[Loyalty Card]].', 'aliases: [Rosa]\n'))
  put('people/sam-okafor.md', page('Sam Okafor', 'Manager. Reports to [[Rosa]]. Runs the [[spring sale]] and talks to [[Sam]] himself. Also [[people/ghost]].'))
  put('people/sam-okafor-2.md', page('Sam Okafor', 'A second page about Sam, linked from [[Rosa Delgado]].'))
  put('organizations/greenway-growers.md', page('Greenway Growers', 'Supplier of [[Rosa Delgado]].', 'aliases: [Greenway]\n'))
  put('organizations/hillcrest-property-management.md', page('Hillcrest Property Management', 'Client. Contact: [[Sam Okafor]].', 'aliases: [Hillcrest]\n'))
  put('organizations/hillcrest-property.md', page('Hillcrest Property', 'Same client, different name. [[Rosa Delgado]]'))
  put('topics/old-pricing.md', '---\ntitle: Old pricing\ntype: topic\nupdated: 2024-01-01\n---\n# Old pricing\n\nNobody links here.\n')
  put('sources/2026-10-01-list.md', page('Supplier list', 'See [[Greenway Growers]].'))
  put('answers/2026-10-02-q.md', page('Who supplies us?', 'Greenway [[Totally Unknown Thing]]'))
  // Raw sources full of broken links that lint must never touch.
  put('raw/chat-exports/job1-export.zip', Buffer.from([1, 2, 3, 4]))
  put('raw/calls/notes.md', '[[organizations/greenway]] [[Spring Sale]] [[Spring Sale]]\n')
  put('sources/files/2026-10-01-list.xlsx', Buffer.from('original'))
  put('sources/files/readme.md', '[[Spring Sale]] [[organizations/greenway]]\n')
  put('sources/inbox/new.md', '[[Spring Sale]]\n')
}

describe('runLint', () => {
  it('fixes safe things, lists the rest, never touches raw sources', async () => {
    seed()
    const before = rawHashes()
    const r = await runLint(kb, { llm: null, now: NOW, staleDays: 180, aiPages: 0 })
    expect(rawHashes()).toEqual(before)

    // Broken link with one obvious target: rewritten in place.
    expect(read('people/rosa-delgado.md')).toContain('[[organizations/greenway-growers|organizations/greenway]]')
    expect(r.fixed).toContainEqual(expect.objectContaining({ kind: 'broken_link', page: 'people/rosa-delgado.md', pages: ['organizations/greenway-growers.md'] }))

    // Mentioned from 2 pages with no page → stub started; mentioned once → listed.
    expect(r.fixed).toContainEqual(expect.objectContaining({ kind: 'missing_topic', page: 'topics/spring-sale.md' }))
    const stub = read('topics/spring-sale.md')
    expect(stub).toContain('generated_by: kb-wiki')
    expect(stub).toContain('## Mentioned in\n\n- [[people/rosa-delgado|Rosa Delgado]]\n- [[people/sam-okafor|Sam Okafor]]')
    expect(fs.existsSync(path.join(kb, 'topics/loyalty-card.md'))).toBe(false)
    const brokenLeft = r.needs_human.filter(i => i.kind === 'broken_link').map(i => i.detail)
    expect(brokenLeft.some(d => d.includes('"Loyalty Card"'))).toBe(true)
    expect(brokenLeft.some(d => d.includes('"people/ghost"'))).toBe(true)
    expect(brokenLeft.some(d => d.includes('"Totally Unknown Thing"'))).toBe(true)
    // A name only one page mentions never gets a stub.
    expect(brokenLeft.every(d => !d.includes('Spring Sale'))).toBe(true)

    // Orphans: entity pages nothing links to (sources/answers never count as orphans).
    const orphans = r.needs_human.filter(i => i.kind === 'orphan').map(i => i.page)
    expect(orphans).toContain('topics/old-pricing.md')
    expect(orphans).toContain('people/sam-okafor-2.md')
    expect(orphans).not.toContain('sources/2026-10-01-list.md')
    expect(orphans).not.toContain('answers/2026-10-02-q.md')
    expect(orphans).not.toContain('topics/spring-sale.md')

    // Duplicates: same title, and the shortened company name.
    const dups = r.needs_human.filter(i => i.kind === 'duplicate').map(i => [...i.pages!].sort())
    expect(dups).toContainEqual(['people/sam-okafor-2.md', 'people/sam-okafor.md'])
    expect(dups).toContainEqual(['organizations/hillcrest-property-management.md', 'organizations/hillcrest-property.md'])

    // Stale.
    expect(r.needs_human).toContainEqual(expect.objectContaining({ kind: 'stale', page: 'topics/old-pricing.md' }))
    expect(r.notes).toContain('The AI check for facts that disagree is turned off.')

    // Report, state, log, compiled backlinks.
    expect(read('lint-report.md')).toMatch(/^---\ntitle: Wiki cleanup report\ntype: lint-report\ngenerated_by: kb-wiki/)
    expect(read('lint-report.md')).toContain('## Needs a look')
    expect(lastLintRun(kb)).toBe(NOW.toISOString())
    expect(read('log.md')).toContain(`lint | Cleanup: fixed ${r.fixed.length}, ${r.needs_human.length} need a look`)
    expect(read('organizations/greenway-growers.md')).toContain('[[people/rosa-delgado|Rosa Delgado]]')
    expect(read('index.md')).toContain('[[topics/spring-sale|Spring Sale]]')

    // A second run has nothing left to fix, and still leaves raw alone.
    const again = await runLint(kb, { llm: null, now: NOW, staleDays: 180, aiPages: 0 })
    expect(again.fixed).toEqual([])
    expect(rawHashes()).toEqual(before)
  })

  it('asks the AI about pages with ≥2 sources, lists contradictions, never edits them', async () => {
    const src = (n: string) => ({ notePath: `sources/${n}.md`, filePath: `sources/files/${n}.pdf`, fileName: `${n}.pdf` })
    const e = (fact: string): Entity => ({ type: 'organization', name: 'Greenway Growers', facts: [{ fact }] })
    let text = upsertEntityNote(null, e('Delivers on Tuesdays'), src('a'), '2026-10-01')
    text = upsertEntityNote(text, e('Delivers on Fridays'), src('b'), '2026-10-02')
    put('organizations/greenway-growers.md', text)
    put('people/rosa-delgado.md', page('Rosa Delgado', '[[Greenway Growers]]'))
    const before = read('organizations/greenway-growers.md')
    const calls: string[] = []
    const llm = async (_s: string, p: string) => {
      calls.push(p)
      return 'Here you go: {"contradictions":[{"page":"organizations/greenway-growers.md","detail":"a.pdf says Tuesdays, b.pdf says Fridays."},{"page":"people/elsewhere.md","detail":"not in batch"}]}'
    }
    const r = await runLint(kb, { llm, now: NOW, staleDays: 180, aiPages: 15 })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('===== PAGE: organizations/greenway-growers.md =====')
    expect(calls[0]).not.toContain('people/rosa-delgado.md =====')
    expect(r.needs_human.filter(i => i.kind === 'contradiction')).toEqual([{ kind: 'contradiction', page: 'organizations/greenway-growers.md', detail: 'a.pdf says Tuesdays, b.pdf says Fridays.' }])
    expect(r.stats.ai_pages_checked).toBe(1)
    // Only the compiled backlinks block may differ.
    expect(read('organizations/greenway-growers.md').split('<!-- kb-wiki:backlinks -->')[0].trimEnd()).toBe(before.trimEnd())
  })

  it('asks the AI for duplicates the name rules miss, same kind only, report-only', async () => {
    put('projects/hillcrest-contract.md', page('Hillcrest contract', 'Signed in September.'))
    put('projects/hillcrest-grounds-maintenance-contract.md', page('Hillcrest grounds maintenance contract', 'Twelve months, six sites. [[projects/hillcrest-contract]]'))
    put('people/tom-whitfield.md', page('Tom Whitfield', 'Account rep. [[projects/hillcrest-contract]]'))
    put('people/tom.md', page('Tom', 'Rep at the supplier. [[people/tom-whitfield]]'))
    const prompts: string[] = []
    const llm = async (sys: string, p: string) => {
      prompts.push(p)
      if (!sys.includes('SAME real thing')) return '{"contradictions":[]}'
      return '{"duplicates":[["projects/hillcrest-contract.md","projects/hillcrest-grounds-maintenance-contract.md"],["people/tom.md","projects/hillcrest-contract.md"],["people/tom.md","people/nobody.md"]]}'
    }
    const before = read('projects/hillcrest-contract.md')
    const r = await runLint(kb, { llm, now: NOW, staleDays: 180, aiPages: 15 })
    const dups = r.needs_human.filter(i => i.kind === 'duplicate')
    expect(dups).toHaveLength(1)
    expect(dups[0].pages).toEqual(['projects/hillcrest-contract.md', 'projects/hillcrest-grounds-maintenance-contract.md'])
    expect(dups[0].detail).toContain('Hillcrest contract, Hillcrest grounds maintenance contract')
    expect(prompts.some(p => p.includes('people/tom.md | person | Tom'))).toBe(true)
    expect(read('projects/hillcrest-contract.md').split('<!-- kb-wiki:backlinks -->')[0].trimEnd()).toBe(before.trimEnd())
    // AI check off → no AI call at all.
    prompts.length = 0
    await runLint(kb, { llm, now: NOW, staleDays: 180, aiPages: 0 })
    expect(prompts).toHaveLength(0)
  })

  it('skips the AI check gracefully when the AI fails or is missing', async () => {
    const src = (n: string) => ({ notePath: `sources/${n}.md`, filePath: `sources/files/${n}.pdf`, fileName: `${n}.pdf` })
    const e: Entity = { type: 'person', name: 'Priya Nair', facts: [{ fact: 'Bookkeeper' }] }
    put('people/priya-nair.md', upsertEntityNote(upsertEntityNote(null, e, src('a'), '2026-10-01'), e, src('b'), '2026-10-01'))
    const failing = await runLint(kb, { llm: async () => { throw new Error('AI is busy') }, now: NOW, staleDays: 180, aiPages: 5 })
    expect(failing.notes.some(n => n.includes('AI is busy'))).toBe(true)
    const none = await runLint(kb, { llm: null, now: NOW, staleDays: 180, aiPages: 5 })
    expect(none.notes).toContain('The AI check for facts that disagree was skipped because no AI is set up.')
    const garbled = await runLint(kb, { llm: async () => 'no json here', now: NOW, staleDays: 180, aiPages: 5 })
    expect(garbled.notes.some(n => n.includes('unreadable reply'))).toBe(true)
  })

  it('leaves a hand-written lint-report.md alone', async () => {
    put('lint-report.md', '# mine\n')
    await runLint(kb, { llm: null, now: NOW, staleDays: 180, aiPages: 0 })
    expect(read('lint-report.md')).toBe('# mine\n')
    expect(read('wiki-lint-report.md')).toContain('Everything looks tidy.')
  })
})

describe('helpers', () => {
  it('parseContradictions keeps only pages in the batch', () => {
    expect(parseContradictions('{"contradictions":[{"page":"a.md","detail":" x "},{"page":"b.md","detail":"y"},{"page":"a.md"}]}', new Set(['a.md'])))
      .toEqual([{ page: 'a.md', detail: 'x' }])
    expect(() => parseContradictions('nope', new Set())).toThrow()
  })

  it('findDuplicates groups only within a kind', () => {
    put('people/acme.md', page('Acme', ''))
    put('organizations/acme.md', page('Acme', ''))
    put('organizations/acme-corp.md', page('ACME Corporation', ''))
    const groups = findDuplicates(scanWiki(kb)).map(g => g.map(p => p.rel).sort())
    expect(groups).toEqual([['organizations/acme-corp.md', 'organizations/acme.md']])
  })
})

describe('short-name links', () => {
  it('fixes [[Greenway]] when exactly one page name starts with it, lists it when several do', async () => {
    put('organizations/greenway-growers.md', page('Greenway Growers', 'Supplier.'))
    put('people/sam-okafor.md', page('Sam Okafor', 'Checks [[Greenway]] deliveries and the [[Hill]] sites.'))
    put('organizations/hill-farm.md', page('Hill Farm', 'One.'))
    put('organizations/hill-top.md', page('Hill Top', 'Two.'))
    const r = await runLint(kb, { llm: null, now: NOW, staleDays: 180, aiPages: 0 })
    expect(read('people/sam-okafor.md')).toContain('[[organizations/greenway-growers|Greenway]]')
    expect(r.fixed.some(i => i.kind === 'broken_link' && i.pages?.[0] === 'organizations/greenway-growers.md')).toBe(true)
    expect(r.needs_human.some(i => i.kind === 'broken_link' && i.detail.includes('"Hill"'))).toBe(true)
  })
})
