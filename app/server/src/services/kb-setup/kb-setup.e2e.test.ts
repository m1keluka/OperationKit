/**
 * Knowledge Base Setup — fixture folder end to end (obj 900556).
 *
 * Runs the REAL engine (intake → staging → extract → redact → classify →
 * write/merge → compile → questions → decision queue) over the ~20-file
 * sample folder (src/services/kb-setup/sample-intake, built by
 * src/scripts/make-kb-setup-sample.ts), with the AI replaced by the canned
 * replies in fixtures/kb-setup/llm-replies.json. Then it prints the resulting
 * knowledge-base tree and asserts its shape.
 *
 * Two files are added at run time instead of being committed, so the repo's
 * OSS secret scan never sees a credential-shaped string: a notes file with a
 * fake API key + password, and a `.env`.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseNote } from '../doc-ingest/notes.js'
import { getReviewItem, listReviewItems } from '../review-items.js'
import {
  SAMPLE_INTAKE_DIR, SETUP_PROMPT_FILE, addToIntake, answerQuestion, createRun, getRun, listIntake, readLedger, readQuestions, runWorker,
  setupOverview, stageSampleIntake, type Run,
} from './runs.js'
const setupSystemPrompt = () => fs.readFileSync(SETUP_PROMPT_FILE, 'utf8')

const REPLIES = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../fixtures/kb-setup/llm-replies.json'), 'utf8')) as Record<string, unknown>

// Built from fragments so no committed line looks like a credential.
const FAKE_KEY = ['sk', 'proj', 'kbsetupFIXTURE', '0123456789abcdefghij0123456789'].join('-')
const FAKE_PW = ['Fixture', 'Pass', '2026', '!x'].join('')
const SECRET_NOTES = [
  '# Server setup notes',
  '',
  'Client sites are hosted on one shared server, backed up nightly.',
  `OPENAI_API_KEY=${FAKE_KEY}`,
  `DB_PASSWORD=${FAKE_PW}`,
  '',
].join('\n')

const calls: string[] = []
const stubLlm = async (system: string, prompt: string): Promise<string> => {
  expect(system).toContain('Knowledge Base Setup agent')
  const file = prompt.match(/^FILE: (.*)$/m)?.[1] ?? ''
  calls.push(file)
  // The AI must never see a secret.
  expect(prompt).not.toContain(FAKE_KEY)
  expect(prompt).not.toContain(FAKE_PW)
  const reply = REPLIES[file]
  if (!reply) throw new Error(`no canned reply for ${file}`)
  return '```json\n' + JSON.stringify(reply) + '\n```'
}

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE objectives (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queue', agent_context TEXT NOT NULL DEFAULT 'general', workspace TEXT, category TEXT, origin TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`)
  return db
}

function tree(kb: string): string[] {
  const out: string[] = []
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(kb, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.name.startsWith('.')) continue
      if (e.isDirectory()) walk(r)
      else out.push(r)
    }
  }
  walk('')
  return out
}

const read = (kb: string, rel: string) => fs.readFileSync(path.join(kb, rel), 'utf8')
const tagsOf = (kb: string, rel: string) => parseNote(read(kb, rel)).fm?.tags ?? []

let kb: string
let db: Database.Database
let run: Run

beforeAll(async () => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-e2e-'))
  db = makeDb()
  db.prepare("INSERT INTO settings (key, value) VALUES ('job_cost_ceiling_usd:acme', '5')").run()
  const staged = stageSampleIntake(kb)
  addToIntake(kb, 'Notes/Server setup notes.md', Buffer.from(SECRET_NOTES))
  // A host drop straight into the intake folder (the upload route refuses credential files at the door).
  fs.writeFileSync(path.join(kb, 'intake/Misc/.env'), `API_TOKEN=${FAKE_KEY}\n`)
  expect(staged.length).toBe(21) // README.md in the sample folder is not staged
  expect(listIntake(kb)).toHaveLength(23)

  run = createRun(kb, 'acme', { by: 'tester', db })
  await runWorker(kb, run.id, { llm: stubLlm, systemPrompt: setupSystemPrompt(), db, setupUrl: 'https://kb.example/knowledge/setup' })
  run = getRun(kb, run.id)!
})

afterAll(() => { fs.rmSync(kb, { recursive: true, force: true }) })

describe('fixture folder → knowledge base', () => {
  it('reads every readable file once and skips/dedupes the rest', () => {
    console.log('\nResulting knowledge-base tree:\n' + tree(kb).map(l => `  ${l}`).join('\n'))
    expect(run.status).toBe('done')
    expect(run.counts).toMatchObject({ total: 23, done: 19, duplicate: 1, skipped: 3, failed: 0, pending: 0 })
    expect(run.ceiling).toMatchObject({ cost_usd: 5, source: 'workspace:acme' })
    expect(run.est_cost_usd).toBeGreaterThan(0)
    const by = Object.fromEntries(run.items.map(i => [i.path, i]))
    expect(by['Notes/Copy of SOP - Client onboarding.md']).toMatchObject({ status: 'duplicate', duplicate_of: 'Processes/SOP - Client onboarding.md' })
    expect(by['Misc/studio-logo.png'].skip_reason).toMatch(/image/)
    expect(by['Misc/old-site-backup.zip'].skip_reason).toMatch(/zip/)
    expect(by['Misc/.env'].skip_reason).toMatch(/credentials/)
    expect(calls).toHaveLength(19)
    expect(listIntake(kb)).toHaveLength(0) // intake emptied, staging cleaned
    expect(fs.existsSync(path.join(kb, '.kb-wiki/kb-setup/staging', run.id))).toBe(false)
  })

  it('builds the expected tree on the existing structure (no parallel folders)', () => {
    const t = tree(kb)
    for (const p of [
      'people/maya-lindqvist.md', 'people/theo-okonkwo.md', 'people/priya-raman.md', 'people/jonas-feld.md',
      'people/sam-whitaker.md', 'people/sam.md', 'people/lena-ortiz.md',
      'organizations/harbor-bakery.md', 'organizations/pinecrest-dental.md', 'organizations/copperline-print.md',
      'organizations/lumen-and-lark-studio.md', 'organizations/oak-and-ember-cafe.md',
      'projects/harbor-bakery-website.md', 'projects/pinecrest-dental-rebrand.md',
      'products/brand-starter.md', 'products/website-build.md', 'products/care-plan.md', 'products/signage-add-on.md',
      'topics/client-onboarding.md', 'topics/invoicing.md', 'topics/stop-fixed-price-retainers.md',
      'topics/move-invoicing-to-monthly.md', 'topics/glossary.md', 'topics/website-launch-checklist.md',
      'index.md', 'log.md',
    ]) expect(t, p).toContain(p)
    // Glossary terms are gathered on ONE page, not a page per acronym.
    expect(t).not.toContain('topics/pm.md')
    expect(t).not.toContain('topics/discovery.md')
    // Only the existing top-level folders are used.
    const tops = new Set(t.map(p => p.split('/')[0]).filter(p => p.includes('.') === false))
    expect([...tops].sort()).toEqual(['organizations', 'people', 'products', 'projects', 'sources', 'topics'])
    // "Dr. Lena Ortiz" in the email merged into Lena Ortiz instead of a second page.
    expect(t).not.toContain('people/dr-lena-ortiz.md')
  })

  it('tags notes with the controlled vocabulary', () => {
    expect(tagsOf(kb, 'organizations/harbor-bakery.md')).toEqual(['organization', 'client'])          // "customer" → client
    expect(tagsOf(kb, 'organizations/copperline-print.md')).toEqual(['organization', 'supplier'])     // "vendor" → supplier
    expect(tagsOf(kb, 'topics/client-onboarding.md')).toEqual(['topic', 'process'])                    // "sop" → process
    expect(tagsOf(kb, 'topics/move-invoicing-to-monthly.md')).toEqual(['topic', 'decision'])          // "decisions" → decision
    expect(tagsOf(kb, 'topics/website-launch-checklist.md')).toEqual(['topic', 'process'])            // inferred from the name
    expect(tagsOf(kb, 'topics/glossary.md')).toEqual(['topic', 'glossary'])
    expect(tagsOf(kb, 'people/maya-lindqvist.md')).toEqual(['person', 'owner', 'team'])               // "founder" → owner, merged across files
    expect(tagsOf(kb, 'people/jonas-feld.md')).toEqual(['person'])                                    // "contractor" has no place → dropped
    expect(tagsOf(kb, 'projects/pinecrest-dental-rebrand.md')).toEqual(['project', 'proposed'])      // "planned" → proposed
  })

  it('merges what several files say into one page, with a source link per file', () => {
    const care = read(kb, 'products/care-plan.md')
    for (const f of ['Company/Glossary.txt', 'Meetings/Weekly team meeting 2026-03-09.txt', 'Products/Price list 2026.csv', 'Products/Service packages.pdf']) {
      expect(care).toContain(`## From: ${f}`)
    }
    expect(care).toMatch(/\[Products\/Price list 2026\.csv \(readable copy\)\]\(\.\.\/sources\/setup-products-price-list-2026\.md\)/)
    expect(care).toContain('[original file](../sources/files/setup-products-price-list-2026.csv)')
    const fm = parseNote(care).fm!
    expect(fm.sources.length).toBe(4)
    // Related list + wiki backlinks.
    const bakery = read(kb, 'organizations/harbor-bakery.md')
    expect(bakery).toMatch(/## Related[\s\S]*\[Sam Whitaker\]\(\.\.\/people\/sam-whitaker\.md\) \(person\) — contact/)
    expect(bakery).toContain('## Backlinks')
    const glossary = read(kb, 'topics/glossary.md')
    expect(glossary).toContain('**PM** — Project manager (Priya).')
    expect(glossary).toContain('**Handoff pack** — ')
    // Source note: category tag + original path.
    const src = read(kb, 'sources/setup-processes-sop-client-onboarding.md')
    expect(src).toMatch(/^tags: \[source, process\]$/m)
    expect(src).toContain('original_path: "Processes/SOP - Client onboarding.md"')
  })

  it('never stores a secret: redacted before the AI, in the copy, and the original is not kept', () => {
    const item = run.items.find(i => i.path === 'Notes/Server setup notes.md')!
    expect(item.secrets?.map(s => s.kind).sort()).toEqual(['credential', 'openai-key'])
    expect(item.original).toBe('sources/files/setup-notes-server-setup-notes.redacted.md')
    const all = tree(kb).map(rel => read(kb, rel)).join('\n')
    expect(all).not.toContain(FAKE_KEY)
    expect(all).not.toContain(FAKE_PW)
    expect(read(kb, item.source_note!)).toContain('## Secrets removed')
    expect(run.summary!.secrets).toEqual([{ path: 'Notes/Server setup notes.md', findings: item.secrets }])
    expect(fs.readFileSync(path.join(kb, '.gitignore'), 'utf8')).toMatch(/^intake\/$/m)
  })

  it('reports created vs updated pages by section', () => {
    const s = run.summary!
    expect(s.created.length).toBeGreaterThanOrEqual(25)
    expect(s.updated).toEqual([]) // first run: everything is new
    expect(s.by_section.people.created).toBe(7)
    expect(s.by_section.companies.created).toBe(5)
    expect(s.by_section.projects.created).toBe(2)
    expect(s.by_section.decisions.created).toBe(3)
    expect(s.by_section.processes.created).toBe(4)
    expect(s.by_section.glossary.created).toBe(1)
    expect(setupOverview(kb)).toMatchObject({ step_done: true, intake: { files: 0 }, active: null })
  })

  it('files open questions in the decision queue instead of guessing', () => {
    const qs = readQuestions(kb)
    const kinds = qs.map(q => q.kind).sort()
    expect(kinds).toEqual(['ambiguous', 'conflict', 'secret'])
    const sam = qs.find(q => q.kind === 'ambiguous')!
    expect(sam.files).toContain('Clients/Harbor Bakery/Kickoff call 2026-03-02.vtt') // AI + detector agreed → one question
    const card = db.prepare('SELECT * FROM objectives WHERE id = ?').get(run.anchor_card) as { title: string; status: string; origin: string; workspace: string; description: string }
    expect(card).toMatchObject({ title: 'Knowledge base setup: answer 3 open questions', status: 'queue', origin: 'kb-setup', workspace: 'acme' })
    expect(card.description).toContain('https://kb.example/knowledge/setup')
    const items = listReviewItems(db, { workspace: 'acme' })
    expect(items.map(i => i.kind).sort()).toEqual(['decision', 'input_needed', 'input_needed'])
    expect(qs.every(q => q.review_item_id)).toBe(true)
  })

  it('a re-run is idempotent: unchanged files are not re-read, nothing is duplicated', async () => {
    const before = new Map(tree(kb).filter(p => !/^(index|log)\.md$/.test(p)).map(p => [p, read(kb, p)]))
    answerQuestion(kb, readQuestions(kb).find(q => q.kind === 'conflict')!.id, { answer: '$150 for existing clients, $180 for new ones.', by: 'tester', db })
    stageSampleIntake(kb)
    calls.length = 0
    const r2 = createRun(kb, 'acme', { by: 'tester', db })
    await runWorker(kb, r2.id, { llm: stubLlm, systemPrompt: setupSystemPrompt(), db })
    const done = getRun(kb, r2.id)!
    expect(calls).toEqual([])
    expect(done.counts).toMatchObject({ unchanged: 18, duplicate: 1, skipped: 2, done: 0 })
    for (const [p, text] of before) {
      if (p.startsWith('sources/')) expect(read(kb, p), p).toBe(text)
      else expect(read(kb, p).replace(/\n## Backlinks[\s\S]*$/, ''), p).toBe(text.replace(/\n## Backlinks[\s\S]*$/, ''))
    }
    // The answered question stays answered, and its queue item is decided.
    const qs = readQuestions(kb)
    expect(qs.filter(q => q.status === 'open')).toHaveLength(2)
    const conflict = qs.find(q => q.kind === 'conflict')!
    expect(conflict).toMatchObject({ status: 'answered', answered_by: 'tester' })
    expect(getReviewItem(db, conflict.review_item_id!)).toMatchObject({ state: 'decided', decision_choice: 'approve', decision_note: '$150 for existing clients, $180 for new ones.' })
    expect(listReviewItems(db, { workspace: 'acme' })).toHaveLength(2) // the other two are still live, not duplicated
  })

  it('a changed file replaces only its own sections', async () => {
    const changed = fs.readFileSync(path.join(SAMPLE_INTAKE_DIR, 'Products/Price list 2026.csv'), 'utf8').replace('Care Plan,180', 'Care Plan,195')
    addToIntake(kb, 'Products/Price list 2026.csv', Buffer.from(changed))
    REPLIES['Products/Price list 2026.csv'] = {
      title: 'Price list 2026', summary: 'Updated prices.',
      entities: [{ type: 'product', name: 'Care Plan', tags: ['service'], facts: [{ fact: '$195 monthly.', where: 'row 4' }] }],
    }
    calls.length = 0
    const r3 = createRun(kb, 'acme', { by: 'tester', db })
    await runWorker(kb, r3.id, { llm: stubLlm, systemPrompt: setupSystemPrompt(), db })
    expect(calls).toEqual(['Products/Price list 2026.csv'])
    const done = getRun(kb, r3.id)!
    expect(done.summary!.updated.map(p => p.rel).sort()).toEqual(['products/care-plan.md'])
    const care = read(kb, 'products/care-plan.md')
    expect(care).toContain('$195 monthly.')
    expect(care).not.toContain('$180 monthly: hosting')
    expect(care.match(/## From: Products\/Price list 2026\.csv/g)).toHaveLength(1)
    // Pages this file no longer mentions lose its section (and only its section).
    const website = read(kb, 'products/website-build.md')
    expect(website).not.toContain('## From: Products/Price list 2026.csv')
    expect(website).toContain('## From: Products/Service packages.pdf')
    expect(readLedger(kb).files['Products/Price list 2026.csv'].pages).toEqual(['products/care-plan.md'])
  })
})
