/**
 * Knowledge Base Setup — unit tests for classification, tagging, secret
 * redaction, questions and merge helpers (obj 900556). The fixture-folder
 * end-to-end run is in kb-setup.e2e.test.ts.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { mergeTags, upsertEntityNote, type Entity } from '../doc-ingest/notes.js'
import { writeZip } from '../doc-ingest/zip.js'
import { classifyFile, foldGlossary, normalizeTag, sectionFor, tagsFor, SECTIONS } from './taxonomy.js'
import { redactSecrets, describeFindings } from './secrets.js'
import { extractHtml, extractJson, extractPptx, skipReason } from './extract.js'
import { cleanQuestions, detectAmbiguousNames, mergeQuestions, questionId } from './questions.js'
import {
  addToIntake, createRun, estimateCostUsd, listIntake, orderForDedupe, overCeiling, pauseRun, removeSourceSection, resolveRunCeiling,
  resumeRun, safeRelPath, sourceIdFor, RunConflictError,
} from './runs.js'

const e = (type: Entity['type'], name: string, tags?: string[]): Entity => ({ type, name, facts: [], tags })

describe('taxonomy: sections on the existing structure', () => {
  it('maps the eight sections onto the five existing note types', () => {
    expect(SECTIONS.map(s => `${s.key}=${s.type}${s.tag ? `+${s.tag}` : ''}`)).toEqual([
      'people=person', 'companies=organization', 'projects=project', 'decisions=topic+decision',
      'processes=topic+process', 'products=product', 'glossary=topic+glossary', 'topics=topic',
    ])
  })

  it('normalizes AI tags to the controlled vocabulary per type', () => {
    expect(normalizeTag('organization', 'Customer')).toBe('client')
    expect(normalizeTag('organization', 'vendor')).toBe('supplier')
    expect(normalizeTag('topic', 'SOP')).toBe('process')
    expect(normalizeTag('topic', 'How-To')).toBe('process')
    expect(normalizeTag('topic', 'decisions')).toBe('decision')
    expect(normalizeTag('person', 'staff')).toBe('team')
    expect(normalizeTag('person', 'founder')).toBe('owner')
    expect(normalizeTag('project', 'planned')).toBe('proposed')
    // A tag from another type's vocabulary has no place here.
    expect(normalizeTag('person', 'client')).toBeNull()
    expect(normalizeTag('organization', 'process')).toBeNull()
    expect(normalizeTag('topic', 'misc stuff')).toBeNull()
  })

  it('infers the obvious topic tag from the name when the AI forgot', () => {
    expect(tagsFor(e('topic', 'SOP - Refunds'))).toEqual(['process'])
    expect(tagsFor(e('topic', 'Website launch checklist'))).toEqual(['process'])
    expect(tagsFor(e('topic', 'How we price rush jobs'))).toEqual(['process'])
    expect(tagsFor(e('topic', 'Decision: drop the Tuesday standup'))).toEqual(['decision'])
    expect(tagsFor(e('topic', 'Refund policy'))).toEqual(['policy'])
    expect(tagsFor(e('topic', 'Glossary'))).toEqual(['glossary'])
    expect(tagsFor(e('topic', 'Q3 offsite'))).toEqual([])
    // Explicit tags win and are not doubled.
    expect(tagsFor(e('topic', 'Onboarding checklist', ['decision']))).toEqual(['decision'])
    expect(tagsFor(e('organization', 'Acme', ['customer', 'client', 'nonsense']))).toEqual(['client'])
  })

  it('puts a note in the right section from type + tags', () => {
    expect(sectionFor('person', ['team'])).toBe('people')
    expect(sectionFor('organization', ['client'])).toBe('companies')
    expect(sectionFor('topic', ['decision'])).toBe('decisions')
    expect(sectionFor('topic', ['policy'])).toBe('processes')
    expect(sectionFor('topic', ['process'])).toBe('processes')
    expect(sectionFor('topic', ['glossary'])).toBe('glossary')
    expect(sectionFor('topic', [])).toBe('topics')
    expect(sectionFor('product', ['service'])).toBe('products')
  })

  it('folds glossary terms onto one Glossary page', () => {
    const out = foldGlossary([
      { ...e('topic', 'NPS', ['acronym']), summary: 'Net promoter score.', facts: [{ fact: 'Net promoter score.', where: 'line 2' }] },
      { ...e('topic', 'Runway', ['term']), summary: 'Months of cash left.', facts: [{ fact: 'Months of cash left.' }, { fact: 'Reviewed monthly.' }] },
      e('person', 'Ada Park', ['staff']),
    ])
    expect(out.map(x => `${x.type}:${x.name}`)).toEqual(['topic:Glossary', 'person:Ada Park'])
    expect(out[0].tags).toEqual(['glossary'])
    expect(out[0].facts.map(f => f.fact)).toEqual(['**NPS** — Net promoter score.', '**Runway** — Months of cash left.', 'Runway: Reviewed monthly.'])
    expect(out[0].facts[0].where).toBe('line 2')
    expect(out[1].tags).toEqual(['team'])
  })

  it('classifies files by name, then folder, then content', () => {
    expect(classifyFile('Team meeting 2026-03-09.txt')).toBe('meeting-notes')
    expect(classifyFile('recording.vtt')).toBe('meeting-notes')
    expect(classifyFile('SOPs/Refunds.md')).toBe('process')
    expect(classifyFile('Ops/How to close the month.docx')).toBe('process')
    expect(classifyFile('Decisions log.md')).toBe('decision-log')
    expect(classifyFile('Clients/Acme/MSA signed.pdf')).toBe('contract')
    expect(classifyFile('Price list 2026.xlsx')).toBe('price-list')
    expect(classifyFile('exports/customers.csv')).toBe('contact-list')
    expect(classifyFile('Sales/Q3 pitch.pptx')).toBe('proposal')
    expect(classifyFile('deck.pptx')).toBe('proposal')
    expect(classifyFile('Glossary.txt')).toBe('glossary')
    expect(classifyFile('slack-export.json')).toBe('chat-export')
    expect(classifyFile('notes/untitled.md', 'Attendees: Ana, Bo\nAgenda: budget')).toBe('meeting-notes')
    expect(classifyFile('misc/2026-01.md', '# Decisions\n- go')).toBe('decision-log')
    expect(classifyFile('misc/random.md', 'hello')).toBe('notes')
    expect(classifyFile('Clients/Acme/Statement of work - website.docx')).toBe('contract')
    expect(classifyFile('Clients/Acme/Email thread - scope change.txt')).toBe('correspondence')
    expect(classifyFile('Products/Service packages.pdf')).toBe('price-list')
    // A "Clients" folder says what files are about, not that each is a contact list.
    expect(classifyFile('Clients/Acme/notes.md')).toBe('notes')
    expect(classifyFile('Clients/Client list.xlsx')).toBe('contact-list')
  })
})

describe('frontmatter tag merge (doc-ingest notes)', () => {
  it('unions tags, keeps order, normalizes case', () => {
    expect(mergeTags(['organization'], ['Client', 'client', ' supplier '])).toEqual(['organization', 'client', 'supplier'])
    expect(mergeTags(['person'])).toEqual(['person'])
  })

  it('adds tags to a new note and merges them into an existing one without touching other sections', () => {
    const src = (n: string) => ({ notePath: `sources/${n}.md`, filePath: `sources/files/${n}.csv`, fileName: `${n}.csv` })
    const first = upsertEntityNote(null, { type: 'organization', name: 'Acme', facts: [{ fact: 'Customer since 2020.' }], tags: ['client'] }, src('a'), '2026-01-01')
    expect(first).toMatch(/^tags: \[organization, client\]$/m)
    const second = upsertEntityNote(first, { type: 'organization', name: 'Acme', facts: [{ fact: 'Also resells our kits.' }], tags: ['partner'] }, src('b'), '2026-01-02')
    expect(second).toMatch(/^tags: \[organization, client, partner\]$/m)
    expect(second).toContain('## From: a.csv')
    expect(second).toContain('## From: b.csv')
    // Re-ingesting a source replaces its own section only.
    const third = upsertEntityNote(second, { type: 'organization', name: 'Acme', facts: [{ fact: 'Customer since 2019.' }] }, src('a'), '2026-01-03')
    expect(third).toContain('Customer since 2019.')
    expect(third).not.toContain('Customer since 2020.')
    expect(third.match(/## From: a\.csv/g)).toHaveLength(1)
    expect(third).toMatch(/^tags: \[organization, client, partner\]$/m)
  })

  it('removes one file\'s section and its source entry, leaving the rest', () => {
    const src = (n: string) => ({ notePath: `sources/${n}.md`, filePath: `sources/files/${n}.csv`, fileName: `${n}.csv` })
    let note = upsertEntityNote(null, { type: 'product', name: 'Kit', facts: [{ fact: 'From a.' }] }, src('a'), '2026-01-01')
    note = upsertEntityNote(note, { type: 'product', name: 'Kit', facts: [{ fact: 'From b.' }] }, src('b'), '2026-01-01')
    const out = removeSourceSection(note, 'a.csv', 'sources/a.md')
    expect(out).not.toContain('## From: a.csv')
    expect(out).not.toContain('From a.')
    expect(out).toContain('## From: b.csv')
    expect(out).toMatch(/^sources: \[sources\/b\.md\]$/m)
  })
})

describe('secret redaction', () => {
  // Fixtures are assembled from fragments so no committed line is credential-shaped.
  const j = (...p: string[]) => p.join('')
  const OPENAI = j('sk-', 'proj-', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')
  const GH = j('gh', 'p_', 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5z')
  const AWS = j('AK', 'IA', 'Z7XQ4TRV2NWLP3MK')
  const STRIPE = j('sk_', 'live_', 'Zq8Wv7Ux6Ty5Sr4Qp3On2Ml')
  const PEM = j('-----BEGIN ', 'RSA PRIVATE KEY-----\nMIIEow', 'IBAAKCAQEA\n-----END RSA ', 'PRIVATE KEY-----')

  it('replaces vendor-shaped keys and records kind + line, never the value', () => {
    const text = ['# Setup', `key: ${OPENAI}`, `token ${GH}`, `aws ${AWS}`, `stripe ${STRIPE}`, PEM].join('\n')
    const r = redactSecrets(text)
    for (const v of [OPENAI, GH, AWS, STRIPE, 'MIIEow']) expect(r.text).not.toContain(v)
    expect(r.text).toContain('[REDACTED:openai-key]')
    expect(r.text).toContain('[REDACTED:private-key]')
    expect(r.findings).toEqual([
      { kind: 'openai-key', line: 2 }, { kind: 'github-token', line: 3 }, { kind: 'aws-access-key', line: 4 },
      { kind: 'stripe-key', line: 5 }, { kind: 'private-key', line: 6 },
    ])
    expect(JSON.stringify(r.findings)).not.toContain(OPENAI.slice(8))
    expect(describeFindings(r.findings)).toBe('5 secrets (openai-key on line 2, github-token on line 3, aws-access-key on line 4, stripe-key on line 5, private-key on line 6)')
  })

  it('catches NAME=value credentials and passwords in connection strings', () => {
    const pw = j('Hunter', '22', '!x')
    const r = redactSecrets([`DB_PASSWORD=${pw}`, `"api_key": "${j('a8f', '3k2', '9zq1')}"`, `postgres://app:${pw}@db.internal:5432/main`].join('\n'))
    expect(r.text).not.toContain(pw)
    expect(r.text).toContain('DB_PASSWORD=[REDACTED:credential]')
    expect(r.text).toContain('postgres://app:[REDACTED:url-password]@db.internal')
    expect(r.findings.map(f => f.kind).sort()).toEqual(['credential', 'credential', 'url-password'])
  })

  it('leaves prose and placeholders alone, and is idempotent', () => {
    const prose = 'Reset your password: ask Priya.\nPASSWORD=changeme\napi_key: <your key here>\nTOKEN=${API_TOKEN}\nThe secret to good bread is time.'
    expect(redactSecrets(prose)).toEqual({ text: prose, findings: [] })
    const once = redactSecrets(`OPENAI_API_KEY=${OPENAI}`).text
    expect(redactSecrets(once)).toEqual({ text: once, findings: [] })
  })
})

describe('extraction for the extra file types', () => {
  it('reads slide decks with speaker notes', () => {
    const slide = (t: string[]) => `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${t.map(x => `<a:p><a:r><a:t>${x}</a:t></a:r></a:p>`).join('')}</p:spTree></p:cSld></p:sld>`
    const buf = writeZip([
      ['ppt/slides/slide2.xml', slide(['Pricing', 'Basic: $10'])],
      ['ppt/slides/slide1.xml', slide(['Welcome &amp; intro', 'Agenda'])],
      ['ppt/notesSlides/notesSlide2.xml', slide(['Mention the discount', '2'])],
    ])
    const r = extractPptx(buf)
    expect(r.pages).toBe(2)
    expect(r.markdown).toBe('## Slide 1: Welcome & intro\n\n- Agenda\n\n## Slide 2: Pricing\n\n- Basic: $10\n\nSpeaker notes: Mention the discount')
  })

  it('reads the visible text of a web page', () => {
    const r = extractHtml(Buffer.from('<html><head><title>x</title><style>p{}</style></head><body><h2>Hours</h2><p>Mon&nbsp;&amp; Tue</p><script>evil()</script><ul><li>9-5</li></ul></body></html>'))
    expect(r.markdown).toContain('## Hours')
    expect(r.markdown).toContain('Mon & Tue')
    expect(r.markdown).toContain('- 9-5')
    expect(r.markdown).not.toContain('evil')
  })

  it('pretty-prints JSON and tolerates bad JSON', () => {
    expect(extractJson(Buffer.from('{"a":[1]}')).markdown).toContain('"a": [')
    expect(extractJson(Buffer.from('{oops')).warnings[0]).toMatch(/not valid JSON/)
  })

  it('skips what it cannot or must not read', () => {
    expect(skipReason('photos/team.JPG')).toMatch(/image/)
    expect(skipReason('backup.zip')).toMatch(/zip/)
    expect(skipReason('app/.env')).toMatch(/credentials/)
    expect(skipReason('keys/server.pem')).toMatch(/credentials/)
    expect(skipReason('proj/node_modules/x/readme.md')).toMatch(/dependencies/)
    expect(skipReason('.git/config')).toMatch(/system/)
    expect(skipReason('old.doc')).toMatch(/Save As/)
    expect(skipReason('Makefile')).toMatch(/without an extension/)
    expect(skipReason('notes.md')).toBeNull()
    expect(skipReason('deck.pptx')).toBeNull()
  })
})

describe('open questions', () => {
  it('cleans the AI list and gives each question a stable id', () => {
    const qs = cleanQuestions([
      { kind: 'conflict', ask: 'Is the price $10 or $12', about: [{ type: 'product', name: 'Kit' }] },
      { kind: 'weird', ask: 'Who is "the new guy"?' },
      { ask: '' }, null, 'x',
      { kind: 'conflict', ask: 'Price $10 vs $12?', about: [{ type: 'product', name: 'kit' }] }, // same question, other words
    ], 'a.md')
    expect(qs).toHaveLength(2)
    expect(qs[0]).toMatchObject({ kind: 'conflict', ask: 'Is the price $10 or $12?', files: ['a.md'], status: 'open' })
    expect(qs[1].kind).toBe('ambiguous')
    expect(questionId('conflict', 'x', [{ type: 'product', name: 'Kit' }])).toBe(qs[0].id)
  })

  it('finds names the merge would not join, but not ones already linked', () => {
    const idx = [
      { type: 'person' as const, name: 'Sam', aliases: [], rel: 'people/sam.md' },
      { type: 'person' as const, name: 'Sam Okafor', aliases: [], rel: 'people/sam-okafor.md' },
      { type: 'person' as const, name: 'Sam Reyes', aliases: [], rel: 'people/sam-reyes.md' },
      { type: 'person' as const, name: 'Ana', aliases: [], rel: 'people/ana.md' },
      { type: 'person' as const, name: 'Ana Lima', aliases: ['Ana'], rel: 'people/ana-lima.md' },
      { type: 'organization' as const, name: 'Greenway', aliases: [], rel: 'organizations/greenway.md' },
      { type: 'organization' as const, name: 'Greenway Growers', aliases: [], rel: 'organizations/greenway-growers.md' },
      { type: 'organization' as const, name: 'Acme Corp', aliases: [], rel: 'organizations/acme-corp.md' },
    ]
    const asks = detectAmbiguousNames(idx).map(q => q.ask)
    expect(asks).toEqual([
      'Which person is "Sam": Sam Okafor, Sam Reyes, or someone else?',
      'Is "Greenway" the same organization as "Greenway Growers"?',
    ])
  })

  it('never re-opens an answered question and collects new file references', () => {
    const [q] = cleanQuestions([{ kind: 'missing', ask: 'Who is the new supplier?' }], 'a.md')
    const answered = { ...q, status: 'answered' as const, answer: 'Copperline' }
    const merged = mergeQuestions([answered], cleanQuestions([{ kind: 'missing', ask: 'Who is the new supplier?' }], 'b.md'))
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ status: 'answered', answer: 'Copperline', files: ['a.md', 'b.md'] })
  })
})

describe('intake, ordering and budget', () => {
  it('keeps upload paths inside the intake folder', () => {
    expect(safeRelPath('My Drive/Clients/Acme/notes.md')).toBe('My Drive/Clients/Acme/notes.md')
    expect(safeRelPath('../../etc/passwd')).toBe('etc/passwd')
    expect(safeRelPath('/abs/./x.md')).toBe('abs/x.md')
    expect(safeRelPath('a\\b\\c.txt')).toBe('a/b/c.txt')
    expect(safeRelPath('a/b:c*?.txt')).toBe('a/b_c_.txt')
    expect(safeRelPath('..')).toBeNull()
    expect(safeRelPath('1/2/3/4/5/6/7/8/9/10/deep.md')).toBe('1/2/3/4/5/6/7/deep.md')
  })

  it('processes the original before its copies', () => {
    const items = ['Notes/Copy of SOP.md', 'Notes/SOP (1).md', 'SOP.md', 'a.md'].map(p => ({ path: p }))
    const hash = (p: string) => (p === 'a.md' ? 'h2' : 'h1')
    expect(orderForDedupe(items, hash).map(i => i.path)).toEqual(['SOP.md', 'a.md', 'Notes/Copy of SOP.md', 'Notes/SOP (1).md'])
  })

  it('gives each path a stable source id, suffixed only on a collision', () => {
    const ledger = { files: { 'a/b.md': { id: 'setup-a-b', sha256: 'x', pages: [], run: 'r', done_at: '' } } }
    expect(sourceIdFor(ledger, 'a/b.md')).toBe('setup-a-b')
    expect(sourceIdFor(ledger, 'a-b.txt')).toBe('setup-a-b-2')
    expect(sourceIdFor(ledger, 'Clients/Acme Co/Notes.docx')).toBe('setup-clients-acme-co-notes')
  })

  it('inherits the budget ceiling (kb_setup → workspace → global) and never invents one', () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
    expect(resolveRunCeiling(db, 'acme')).toEqual({ cost_usd: null, wallclock_ms: null, source: 'none' })
    db.prepare("INSERT INTO settings VALUES ('job_cost_ceiling_usd', '20')").run()
    expect(resolveRunCeiling(db, 'acme')).toEqual({ cost_usd: 20, wallclock_ms: null, source: 'global' })
    db.prepare("INSERT INTO settings VALUES ('job_wallclock_ceiling_ms:acme', '600000')").run()
    expect(resolveRunCeiling(db, 'acme')).toEqual({ cost_usd: null, wallclock_ms: 600000, source: 'workspace:acme' })
    db.prepare("INSERT INTO settings VALUES ('kb_setup_cost_ceiling_usd:acme', '3')").run()
    expect(resolveRunCeiling(db, 'acme')).toEqual({ cost_usd: 3, wallclock_ms: null, source: 'kb-setup:acme' })
    expect(resolveRunCeiling(undefined, 'acme').source).toBe('none')
  })

  it('stops at the ceiling unless the person said to go on', () => {
    const ceiling = { cost_usd: 1, wallclock_ms: 60_000, source: 'global' }
    expect(overCeiling({ ceiling, est_cost_usd: 0.5, elapsed_ms: 1000 })).toBe(false)
    expect(overCeiling({ ceiling, est_cost_usd: 1, elapsed_ms: 1000 })).toBe(true)
    expect(overCeiling({ ceiling, est_cost_usd: 0, elapsed_ms: 60_000 })).toBe(true)
    expect(overCeiling({ ceiling, est_cost_usd: 9, elapsed_ms: 1, ignore_ceiling: true })).toBe(false)
    expect(overCeiling({ ceiling: { cost_usd: null, wallclock_ms: null, source: 'none' }, est_cost_usd: 99, elapsed_ms: 1e9 })).toBe(false)
    expect(estimateCostUsd(4_000_000, 0)).toBeCloseTo(3)
  })

  it('one active run per knowledge base; pause/resume round-trip', () => {
    const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-unit-'))
    try {
      expect(() => createRun(kb, 'acme')).toThrow(/empty/)
      addToIntake(kb, 'x/a.md', Buffer.from('# A'))
      const run = createRun(kb, 'acme')
      expect(listIntake(kb)).toEqual([])
      addToIntake(kb, 'b.md', Buffer.from('# B'))
      expect(() => createRun(kb, 'acme')).toThrow(RunConflictError)
      expect(pauseRun(kb, run.id)).toMatchObject({ status: 'paused', pause_reason: 'user' })
      expect(() => createRun(kb, 'acme')).toThrow(RunConflictError)
      expect(resumeRun(kb, run.id, { ignoreCeiling: true })).toMatchObject({ status: 'running', ignore_ceiling: true })
    } finally { fs.rmSync(kb, { recursive: true, force: true }) }
  })
})
