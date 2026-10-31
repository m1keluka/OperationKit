import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { writeZip, readZip } from './zip.js'
import { extractDocument, kindForFile, UnsupportedFileError } from './extract.js'
import { upsertEntityNote, notePathFor, relLink, slugify, loadEntityIndex, sameOrganization, writeOrganized, type Entity, type SourceRef } from './notes.js'
import { applyNameGroups, claimInbox, drainQueue, ingestOne, mergeOrganized, reconcileNames, parseOrganizeReply, readManifest, recoverInterrupted, requeue, splitForOrganize } from './ingest.js'
import { askKnowledgeBase, rankNotes, terms } from './ask.js'
import { createIngestLlm, credentialSource } from './llm.js'

// ── fixtures ────────────────────────────────────────────────────────────────

function xlsx(): Buffer {
  return writeZip([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml', '<workbook><sheets><sheet name="2023 orders" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>'],
    ['xl/sharedStrings.xml', '<sst><si><t>Customer Name</t></si><si><t>Rev ($M)</t></si><si><t>Date</t></si><si><t>Acme &amp; Sons</t></si><si><r><t>Lost</t></r><r><t> - price</t></r></si></sst>'],
    ['xl/styles.xml', '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>12.4</v></c><c r="C2" s="1"><v>45000</v></c><c r="E2" t="s"><v>4</v></c></row>' +
      '<row r="3"/>' +
      '</sheetData></worksheet>'],
    ['xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>free text | with pipe</t></is></c></row></sheetData></worksheet>'],
  ])
}

function docx(): Buffer {
  return writeZip([
    ['word/document.xml', '<w:document><w:body>' +
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Cancellation Policy</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Cancel with </w:t></w:r><w:r><w:t>24 hours notice.</w:t></w:r></w:p>' +
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Criterion</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Range</w:t></w:r></w:p></w:tc></w:tr>' +
      '<w:tr><w:tc><w:p><w:r><w:t>Late fee</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$40</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
      '</w:body></w:document>'],
  ])
}

function pdf(lines: string[]): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map(l => `(${l.replace(/[()\\]/g, m => `\\${m}`)}) Tj 0 -16 Td`).join(' ')} ET`
  const stream = zlib.deflateSync(Buffer.from(content, 'latin1'))
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')]
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  objs.forEach((o, i) => {
    if (o === null) parts.push(Buffer.from(`${i + 1} 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from('\nendstream\nendobj\n'))
    else parts.push(Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`))
  })
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n'))
  return Buffer.concat(parts)
}

// ── extraction ──────────────────────────────────────────────────────────────

describe('extract', () => {
  it('zip round-trips', () => {
    const z = readZip(writeZip([['a.txt', 'hello'], ['dir/b.bin', Buffer.from([1, 2, 3])]]))
    expect(z.get('a.txt')?.toString()).toBe('hello')
    expect([...z.get('dir/b.bin')!]).toEqual([1, 2, 3])
  })

  it('reads every tab of a messy workbook, keeping headers, dates and rich text', () => {
    const ex = extractDocument('Price List.xlsx', xlsx())
    expect(ex.kind).toBe('spreadsheet')
    expect(ex.sheets).toEqual(['2023 orders', 'Notes'])
    expect(ex.markdown).toContain('## Sheet: 2023 orders')
    expect(ex.markdown).toContain('| Customer Name | Rev ($M) | Date |')
    expect(ex.markdown).toContain('Acme & Sons | 12.4 | 2023-03-15 |  | Lost - price')
    expect(ex.markdown).toContain('free text \\| with pipe')
    expect(ex.markdown).toContain('2 non-empty row(s)')
  })

  it('reads CSV with quoted commas and a BOM', () => {
    const ex = extractDocument('x.csv', Buffer.from('﻿Company,Notes\n"Acme, Inc.","said ""no"""\n'))
    expect(ex.markdown).toContain('| Acme, Inc. | said "no" |')
  })

  it('reads Word paragraphs and tables in order', () => {
    const ex = extractDocument('Policy.docx', docx())
    expect(ex.kind).toBe('word')
    const md = ex.markdown
    expect(md).toContain('Cancellation Policy')
    expect(md).toContain('Cancel with 24 hours notice.')
    expect(md.indexOf('Cancel with')).toBeLessThan(md.indexOf('| Late fee | $40 |'))
  })

  it('reads text PDFs with the built-in reader', () => {
    const ex = extractDocument('memo.pdf', pdf(['Customer Policies (2025)', 'Late cancellation fee $40']))
    expect(ex.kind).toBe('pdf')
    expect(ex.markdown).toContain('Customer Policies (2025)')
    expect(ex.markdown).toContain('Late cancellation fee $40')
    expect(ex.warnings).toEqual([])
  })

  it('cleans VTT transcripts down to speaker lines', () => {
    const ex = extractDocument('call.vtt', Buffer.from('WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\n<v Dana>We need 24 hours notice to cancel.</v>\n'))
    expect(ex.markdown).toBe('Dana: We need 24 hours notice to cancel.')
  })

  it('rejects unsupported types with a plain-language fix', () => {
    expect(kindForFile('old.xls')).toBeNull()
    expect(() => extractDocument('old.xls', Buffer.from('x'))).toThrow(UnsupportedFileError)
    expect(() => extractDocument('old.xls', Buffer.from('x'))).toThrow(/Save As/)
  })
})

// ── notes ───────────────────────────────────────────────────────────────────

describe('notes', () => {
  const srcA: SourceRef = { notePath: 'sources/2026-10-30-price-list.md', filePath: 'sources/files/2026-10-30-price-list.xlsx', fileName: 'Price List.xlsx' }
  const srcB: SourceRef = { notePath: 'sources/2026-10-30-call.md', filePath: 'sources/files/2026-10-30-call.txt', fileName: 'call.txt' }
  const acme: Entity = { type: 'organization', name: 'Acme & Sons', summary: 'HVAC supplier.', facts: [{ fact: 'Revenue $12.4M', where: 'tab "2023", row 2' }], related: [{ type: 'person', name: 'Dana Ruiz' }] }

  it('slugs and links', () => {
    expect(slugify('Acme & Sons, LLC')).toBe('acme-and-sons-llc')
    expect(notePathFor('person', 'Dana Ruiz')).toBe('people/dana-ruiz.md')
    expect(relLink('organizations/acme.md', 'sources/files/x.xlsx')).toBe('../sources/files/x.xlsx')
  })

  it('creates a note with frontmatter, related links and a per-source section', () => {
    const n = upsertEntityNote(null, acme, srcA, '2026-10-30')
    expect(n).toMatch(/^---\ntitle: Acme & Sons\ntype: organization\n/)
    expect(n).toContain('sources: [sources/2026-10-30-price-list.md]')
    expect(n).toContain('- [Dana Ruiz](../people/dana-ruiz.md) (person)')
    expect(n).toContain('## From: Price List.xlsx')
    expect(n).toContain('[original file](../sources/files/2026-10-30-price-list.xlsx)')
    expect(n).toContain('- Revenue $12.4M *(tab "2023", row 2)*')
  })

  it('merges a second source without touching the first, and re-ingest replaces only its own section', () => {
    let n = upsertEntityNote(null, acme, srcA, '2026-10-30')
    n = upsertEntityNote(n, { ...acme, name: 'ACME and Sons', facts: [{ fact: 'Founder wants to retire' }] }, srcB, '2026-10-31')
    expect(n).toContain('## From: Price List.xlsx')
    expect(n).toContain('## From: call.txt')
    expect(n).toContain('aliases: [ACME and Sons]')
    expect(n).toContain('sources: [sources/2026-10-30-price-list.md, sources/2026-10-30-call.md]')
    expect(n).toContain('updated: 2026-10-31')
    const again = upsertEntityNote(n, { ...acme, facts: [{ fact: 'Revenue $12.5M (restated)' }] }, srcA, '2026-11-01')
    expect(again).not.toContain('Revenue $12.4M')
    expect(again).toContain('Revenue $12.5M (restated)')
    expect(again).toContain('Founder wants to retire')
    expect(again.match(/## From: Price List.xlsx/g)).toHaveLength(1)
    expect(again.match(/Dana Ruiz/g)).toHaveLength(1)
  })
})

describe('matching and merging', () => {
  it('treats shortened / suffixed organization names as the same organization, but not one-word prefixes', () => {
    expect(sameOrganization('Acme Corp', 'ACME Corporation')).toBe(true)
    expect(sameOrganization('Maple Street Dental', 'Maple Street Dental Group, LLC')).toBe(true)
    expect(sameOrganization('Cobalt Creek HVAC', 'Cobalt Creek Heating & Air Inc.')).toBe(false)
    expect(sameOrganization('Acme', 'Acme Holdings')).toBe(false)
    expect(sameOrganization('Sable River', 'Sable River Landscaping')).toBe(true)
  })

  it('merges entities from one file that land on the same note instead of overwriting', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-merge-'))
    fs.mkdirSync(path.join(kb, 'sources/files'), { recursive: true })
    fs.writeFileSync(path.join(kb, 'sources/files/x.xlsx'), 'x')
    const res = writeOrganized(kb, { id: 'x', fileName: 'x.xlsx', storedRel: 'sources/files/x.xlsx', kind: 'spreadsheet', ingestedAt: '2026-10-30T00:00:00Z' }, {
      entities: [
        { type: 'project', name: 'Project Falcon', facts: [{ fact: 'Kickoff' }], related: [{ type: 'organization', name: 'Maple Street Dental Group, LLC' }] },
        { type: 'organization', name: 'Maple Street Dental', facts: [{ fact: '2023: quote lost' }] },
        { type: 'organization', name: 'Maple Street Dental Group, LLC', facts: [{ fact: '2024: intro call' }, { fact: '2023: quote lost' }] },
      ],
    }, 'md', [])
    expect(res.notes.map(n => n.rel).sort()).toEqual(['organizations/maple-street-dental.md', 'projects/project-falcon.md'])
    const note = fs.readFileSync(path.join(kb, 'organizations/maple-street-dental.md'), 'utf8')
    expect(note).toContain('- 2023: quote lost')
    expect(note).toContain('- 2024: intro call')
    expect(note.match(/2023: quote lost/g)).toHaveLength(1)
    expect(note).toContain('aliases: ["Maple Street Dental Group, LLC"]')
    expect(fs.readFileSync(path.join(kb, 'projects/project-falcon.md'), 'utf8')).toContain('(../organizations/maple-street-dental.md)')
    fs.rmSync(kb, { recursive: true, force: true })
  })

  it('splits big multi-tab spreadsheets into whole-tab parts and merges them back', () => {
    const tab = (n: string) => `## Sheet: ${n}\n\n${'| a | b |\n'.repeat(200)}`
    const ex = { kind: 'spreadsheet' as const, sheets: ['A', 'B', 'C', 'D', 'E'], markdown: ['A', 'B', 'C', 'D', 'E'].map(tab).join('\n\n'), warnings: [] }
    const parts = splitForOrganize(ex)
    expect(parts.length).toBe(4)
    expect(parts.flatMap(p => p.sheets)).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(parts.every(p => p.markdown.startsWith('## Sheet: '))).toBe(true)
    expect(splitForOrganize({ ...ex, markdown: tab('A').slice(0, 500) })).toHaveLength(1)
    expect(splitForOrganize({ kind: 'pdf', markdown: 'x'.repeat(9000), warnings: [] })).toHaveLength(1)
    const m = mergeOrganized([{ title: 'T', summary: 'one.', entities: [{ type: 'topic', name: 'a', facts: [] }] }, { summary: 'two.', entities: [{ type: 'topic', name: 'b', facts: [] }] }])
    expect(m).toEqual({ title: 'T', summary: 'one. two.', entities: [{ type: 'topic', name: 'a', facts: [] }, { type: 'topic', name: 'b', facts: [] }] })
  })
})

describe('reconciling names across parallel parts', () => {
  const doc = {
    entities: [
      { type: 'organization' as const, name: 'Cobalt Creek HVAC', facts: [{ fact: '2019: quote lost' }] },
      { type: 'organization' as const, name: 'Cobalt Creek Heating & Air Inc.', facts: [{ fact: '2023: signed' }] },
      { type: 'project' as const, name: 'Cobalt 2023', facts: [], related: [{ type: 'organization' as const, name: 'Cobalt Creek HVAC' }] },
    ],
  }
  it('renames group members to the existing KB name, else the longest, keeping the old name as an alias', () => {
    const out = applyNameGroups(doc, [{ type: 'organization', names: ['Cobalt Creek HVAC', 'Cobalt Creek Heating & Air Inc.'] }], [])
    expect(out.entities.map(e => e.name)).toEqual(['Cobalt Creek Heating & Air Inc.', 'Cobalt Creek Heating & Air Inc.', 'Cobalt 2023'])
    expect(out.entities[0].aliases).toEqual(['Cobalt Creek HVAC'])
    expect(out.entities[2].related?.[0].name).toBe('Cobalt Creek Heating & Air Inc.')
    const pref = applyNameGroups(doc, [{ type: 'organization', names: ['Cobalt Creek HVAC', 'Cobalt Creek Heating & Air Inc.'] }], ['organization: Cobalt Creek HVAC'])
    expect(pref.entities[1].name).toBe('Cobalt Creek HVAC')
  })
  it('asks the AI once and survives a bad reply', async () => {
    const asked: string[] = []
    const out = await reconcileNames(doc, [], async (_s, p) => { asked.push(p); return '{"same":[{"type":"organization","names":["Cobalt Creek HVAC","Cobalt Creek Heating & Air Inc."]}]}' })
    expect(asked[0]).toContain('- organization: Cobalt Creek HVAC')
    expect(new Set(out.entities.filter(e => e.type === 'organization').map(e => e.name)).size).toBe(1)
    expect(await reconcileNames(doc, [], async () => 'nope')).toBe(doc)
  })
})

// ── pipeline ────────────────────────────────────────────────────────────────

describe('ingest pipeline', () => {
  let kb: string
  beforeEach(() => { kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-')) })
  afterEach(() => { fs.rmSync(kb, { recursive: true, force: true }) })

  const reply = (name: string, aliases: string[] = []) => JSON.stringify({
    title: 'Price list',
    summary: 'All prices.',
    entities: [
      { type: 'organization', name, aliases, facts: [{ fact: 'Revenue $12.4M', where: 'row 2' }], related: [{ type: 'project', name: 'Project Falcon' }] },
      { type: 'project', name: 'Project Falcon', facts: [{ fact: 'Lost on price' }] },
      { type: 'bogus', name: 'ignored', facts: [] },
    ],
  })

  it('inbox → stored original → notes + source note, merging aliases across files', async () => {
    fs.mkdirSync(path.join(kb, 'sources/inbox'), { recursive: true })
    fs.writeFileSync(path.join(kb, 'sources/inbox/prices.csv'), 'Customer,Price\nAcme Corp,12.4\n')
    fs.writeFileSync(path.join(kb, 'sources/inbox/z-old.xls'), 'x')
    const prompts: string[] = []
    // Call 1: first sighting. Call 2: the AI reuses the existing name and
    // records the new spelling as an alias. Call 3: the AI uses the alias —
    // the writer still merges into the one note.
    const replies = [reply('Acme Corp'), reply('Acme Corp', ['ACME Corporation']), reply('ACME Corporation')]
    const llm = async (_sys: string, p: string) => { prompts.push(p); return `Here you go:\n\`\`\`json\n${replies[prompts.length - 1]}\n\`\`\`` }

    const added = claimInbox(kb, new Date('2026-10-30T10:00:00Z'), 'tester')
    expect(added.map(e => [e.status, e.kind])).toEqual([['queued', 'csv'], ['failed', 'unsupported']])
    expect(fs.existsSync(path.join(kb, 'sources/files/2026-10-30-prices.csv'))).toBe(true)
    expect(fs.existsSync(path.join(kb, 'sources/inbox/prices.csv'))).toBe(false)

    await drainQueue(kb, { llm, systemPrompt: 'sys' })
    const done = readManifest(kb).find(e => e.kind === 'csv')!
    expect(done.status).toBe('done')
    expect(done.notes).toEqual(['organizations/acme-corp.md', 'projects/project-falcon.md'])
    expect(done.source_note).toBe('sources/2026-10-30-prices.md')
    expect(prompts[0]).toContain('| Acme Corp | 12.4 |')
    const src = fs.readFileSync(path.join(kb, 'sources/2026-10-30-prices.md'), 'utf8')
    expect(src).toContain('Original file: [prices.csv](files/2026-10-30-prices.csv)')
    expect(src).toMatch(/sha256: [0-9a-f]{64}/)
    expect(src).toContain('- [acme corp](../organizations/acme-corp.md)'.replace('acme corp', 'acme-corp'))

    fs.writeFileSync(path.join(kb, 'sources/inbox/call.txt'), 'Dana: ACME Corporation wants to sell.')
    fs.writeFileSync(path.join(kb, 'sources/inbox/memo.md'), 'ACME Corporation memo')
    claimInbox(kb, new Date('2026-10-30T11:00:00Z'))
    await drainQueue(kb, { llm, systemPrompt: 'sys' })
    expect(prompts[1]).toContain('- organization: Acme Corp')
    const idx = loadEntityIndex(kb)
    expect(idx.all.filter(e => e.type === 'organization')).toHaveLength(1)
    const note = fs.readFileSync(path.join(kb, 'organizations/acme-corp.md'), 'utf8')
    expect(note).toContain('## From: prices.csv')
    expect(note).toContain('## From: call.txt')
    expect(note).toContain('## From: memo.md')
    expect(note).toContain('aliases: [ACME Corporation]')
  })

  it('records AI failures on the file and can retry; restart recovery requeues', async () => {
    fs.mkdirSync(path.join(kb, 'sources/inbox'), { recursive: true })
    fs.writeFileSync(path.join(kb, 'sources/inbox/a.txt'), 'hello world')
    const [e] = claimInbox(kb)
    const bad = await ingestOne(kb, e.id, { llm: async () => 'sorry, no JSON', systemPrompt: '' })
    expect(bad?.status).toBe('failed')
    expect(bad?.error).toMatch(/no JSON/)
    expect(requeue(kb, e.id)?.status).toBe('queued')
    const entries = readManifest(kb)
    entries[0].status = 'organizing'
    fs.writeFileSync(path.join(kb, 'sources/_manifest.json'), JSON.stringify(entries))
    expect(recoverInterrupted(kb)).toBe(1)
    expect(readManifest(kb)[0].status).toBe('queued')
  })

  it('parses the first balanced JSON object even with braces inside strings', () => {
    const doc = parseOrganizeReply('note {"entities":[{"type":"topic","name":"a {b}","facts":[]}]} trailing {x}')
    expect(doc.entities[0].name).toBe('a {b}')
    expect(() => parseOrganizeReply('{"title":"x"}')).toThrow(/entities/)
    expect(parseOrganizeReply('Tabs {2019} and {"a":1} then {"entities":[]}').entities).toEqual([])
    expect(() => parseOrganizeReply('no json')).toThrow(/no JSON/)
  })
})

// ── ask ─────────────────────────────────────────────────────────────────────

describe('ask', () => {
  let kb: string
  beforeEach(() => {
    kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ask-'))
    fs.mkdirSync(path.join(kb, 'organizations'), { recursive: true })
    fs.mkdirSync(path.join(kb, 'topics'), { recursive: true })
    fs.writeFileSync(path.join(kb, 'organizations/maple-street.md'), '---\ntitle: Maple Street Dental\n---\n# Maple Street Dental\nWeekly evening clean, price $180.')
    fs.writeFileSync(path.join(kb, 'topics/commercial-pricing.md'), '---\ntitle: Commercial pricing\n---\nCommercial price $150-250 a visit.')
  })
  afterEach(() => { fs.rmSync(kb, { recursive: true, force: true }) })

  it('ranks by title and body hits, dropping stop words', () => {
    expect(terms('What is the price for Maple Street?')).toEqual(['price', 'maple', 'street'])
    const hits = rankNotes([
      { rel: 'organizations/maple-street.md', title: 'Maple Street Dental', text: 'price $180' },
      { rel: 'topics/commercial-pricing.md', title: 'Commercial pricing', text: 'price $150-250' },
      { rel: 'topics/other.md', title: 'Other', text: 'nothing' },
    ], 'Maple Street price')
    expect(hits.map(h => h.rel)).toEqual(['organizations/maple-street.md', 'topics/commercial-pricing.md'])
  })

  it('answers from the matching notes only and returns the cited sources', async () => {
    let sent = ''
    const res = await askKnowledgeBase(kb, 'Maple Street price?', async (_s, p) => { sent = p; return 'The price is $180 [[organizations/maple-street.md]].' }, 'sys')
    expect(sent).toContain('===== NOTE: organizations/maple-street.md =====')
    expect(res.sources).toEqual([{ rel: 'organizations/maple-street.md', title: 'Maple Street Dental' }])
  })

  it('does not call the AI when nothing matches', async () => {
    const res = await askKnowledgeBase(kb, 'zebra quokka', async () => { throw new Error('should not be called') }, 'sys')
    expect(res.sources).toEqual([])
    expect(res.answer).toMatch(/Nothing in the uploaded files/)
  })
})

// ── AI credentials ──────────────────────────────────────────────────────────

describe('ingest llm', () => {
  it('prefers the install token, then an API key, then the account pool', () => {
    expect(credentialSource({ SESSION_JAIL_CLAUDE_OAUTH_TOKEN: 't', SESSION_JAIL_ANTHROPIC_API_KEY: 'k' })).toBe('oauth-token')
    expect(credentialSource({ SESSION_JAIL_ANTHROPIC_API_KEY: 'k' })).toBe('api-key')
    expect(credentialSource({})).toBe('account-pool')
  })

  it('calls the Messages API with the install key', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"entities":[]}' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const llm = createIngestLlm({ env: { SESSION_JAIL_ANTHROPIC_API_KEY: 'sk-test' }, fetchImpl })
    expect(await llm('sys', 'prompt')).toBe('{"entities":[]}')
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages')
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe('sk-test')
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ model: 'claude-sonnet-5', system: 'sys' })
  })

  it('explains plainly when no AI account is connected', async () => {
    const llm = createIngestLlm({ env: {}, pick: () => null })
    await expect(llm('s', 'p')).rejects.toThrow(/No AI account is connected/)
  })
})
