// Fixture data for the Knowledge Base Setup page (obj 900556): a run over the
// files of a fictional small brand & web design studio, "Lumen & Lark Studio".
// Same entity names as the server's sample-intake folder. Used by the harness
// (app/client/harness/kb-setup.tsx) and the tests. Fake data only.
import type {
  KbSetupApi, OpenQuestion, PageChange, Run, RunItem, RunListing, SectionKey, SetupStatus,
} from '../../lib/kbSetup'

export interface KbSetupFixture {
  status: SetupStatus
  /** Runs by id (the active one and/or the last finished one). */
  runs: Record<string, Run>
  questions: OpenQuestion[]
}

const WS = 'lumen-lark'
const T0 = '2026-11-11T09:14:00Z'

const page = (folder: string, slug: string, title: string, section: SectionKey, created = true): PageChange => ({
  rel: `${folder}/${slug}.md`, title, section, created,
})

const P = {
  maya: page('people', 'maya-lindqvist', 'Maya Lindqvist', 'people', false),
  theo: page('people', 'theo-okonkwo', 'Theo Okonkwo', 'people'),
  priya: page('people', 'priya-raman', 'Priya Raman', 'people'),
  sam: page('people', 'sam-whitaker', 'Sam Whitaker', 'people'),
  harbor: page('organizations', 'harbor-bakery', 'Harbor Bakery', 'companies', false),
  pinecrest: page('organizations', 'pinecrest-dental', 'Pinecrest Dental', 'companies'),
  copperline: page('organizations', 'copperline-print', 'Copperline Print', 'companies'),
  harborSite: page('projects', 'harbor-bakery-website', 'Harbor Bakery website', 'projects'),
  rebrand: page('projects', 'pinecrest-dental-rebrand', 'Pinecrest Dental rebrand', 'projects'),
  monthly: page('topics', 'move-invoicing-to-monthly', 'Move invoicing to monthly', 'decisions'),
  retainers: page('topics', 'stop-fixed-price-retainers', 'Stop fixed-price retainers', 'decisions'),
  onboarding: page('topics', 'client-onboarding', 'Client onboarding', 'processes', false),
  invoicing: page('topics', 'invoicing', 'Invoicing', 'processes'),
  starter: page('products', 'brand-starter', 'Brand Starter', 'products'),
  build: page('products', 'website-build', 'Website Build', 'products'),
  care: page('products', 'care-plan', 'Care Plan', 'products'),
  glossary: page('topics', 'glossary', 'Glossary', 'glossary'),
  norms: page('topics', 'studio-working-hours', 'Studio working hours', 'topics'),
}

const KB = 1024
const done = (path: string, bytes: number, pages: PageChange[], extra: Partial<RunItem> = {}): RunItem => ({
  path, bytes, status: 'done', pages, finished_at: T0, ...extra,
})

/** 21 files across the studio's folders, in the order the run reads them. */
export const FIXTURE_ITEMS: RunItem[] = [
  done('Company/About Lumen & Lark.docx', 48 * KB, [P.maya, P.theo, P.priya]),
  done('Company/Team roster.xlsx', 22 * KB, [P.maya, P.theo, P.priya]),
  done('Clients/Harbor Bakery/Proposal - Harbor Bakery website.pdf', 412 * KB, [P.harbor, P.harborSite, P.build, P.sam]),
  done('Clients/Harbor Bakery/Kickoff notes.md', 6 * KB, [P.harborSite, P.sam], { questions: ['q-sam'] }),
  done('Clients/Pinecrest Dental/Rebrand brief.docx', 96 * KB, [P.pinecrest, P.rebrand, P.starter]),
  done('Clients/Pinecrest Dental/Signed contract.pdf', 288 * KB, [P.pinecrest, P.rebrand], { questions: ['q-rebrand-price'] }),
  done('Clients/Copperline Print/Supplier price list.csv', 9 * KB, [P.copperline]),
  done('Processes/Client onboarding.md', 11 * KB, [P.onboarding, P.priya]),
  done('Processes/Invoicing SOP.docx', 41 * KB, [P.invoicing], { secrets: [{ kind: 'stripe-key', line: 14 }] }),
  done('Decisions/2026-03 Move invoicing to monthly.md', 4 * KB, [P.monthly, P.invoicing]),
  done('Decisions/Stop fixed-price retainers.txt', 3 * KB, [P.retainers, P.care], { questions: ['q-care-plan'] }),
  done('Meetings/2026-09-12 Weekly sync.vtt', 58 * KB, [P.harborSite, P.rebrand, P.theo]),
  done('Meetings/Pinecrest check-in.srt', 37 * KB, [P.rebrand, P.pinecrest]),
  done('Products/Services and pricing.pptx', 1_840 * KB, [P.starter, P.build, P.care]),
  done('Exports/slack-general.json', 730 * KB, [P.norms, P.maya], { secrets: [{ kind: 'openai-key', line: 212 }, { kind: 'password', line: 488 }] }),
  done('Notes/Glossary.md', 5 * KB, [P.glossary]),
  { path: 'Notes/Old to-do list.txt', bytes: 2 * KB, status: 'unchanged', finished_at: T0 },
  { path: 'Misc/Copy of Services and pricing.pptx', bytes: 1_840 * KB, status: 'duplicate', duplicate_of: 'Products/Services and pricing.pptx', finished_at: T0 },
  { path: 'Misc/Logo final.png', bytes: 620 * KB, status: 'skipped', skip_reason: 'Images are not read', finished_at: T0 },
  { path: 'Misc/Brand assets.zip', bytes: 18_400 * KB, status: 'skipped', skip_reason: 'Zip archives are not opened — unzip and add the files inside', finished_at: T0 },
  { path: 'Misc/Budget 2025.xlsx', bytes: 64 * KB, status: 'failed', error: 'The workbook is password-protected', finished_at: T0 },
]

function countsOf(items: RunItem[]): Run['counts'] {
  const c = { pending: 0, working: 0, done: 0, unchanged: 0, duplicate: 0, skipped: 0, failed: 0, total: items.length }
  for (const i of items) c[i.status]++
  return c
}

function summaryOf(items: RunItem[]): NonNullable<Run['summary']> {
  const seen = new Map<string, PageChange>()
  for (const i of items) for (const p of i.pages ?? []) if (!seen.has(p.rel)) seen.set(p.rel, p)
  const all = [...seen.values()]
  const by_section = Object.fromEntries(
    (['people', 'companies', 'projects', 'decisions', 'processes', 'products', 'glossary', 'topics'] as SectionKey[])
      .map(k => [k, { created: 0, updated: 0 }]),
  ) as Record<SectionKey, { created: number; updated: number }>
  for (const p of all) by_section[p.section][p.created ? 'created' : 'updated']++
  return {
    created: all.filter(p => p.created),
    updated: all.filter(p => !p.created),
    by_section,
    secrets: items.filter(i => i.secrets?.length).map(i => ({ path: i.path, findings: i.secrets! })),
    questions_open: 3,
  }
}

const CEILING = { cost_usd: 5, wallclock_ms: 60 * 60 * 1000, source: 'workspace:lumen-lark' }

export const FIXTURE_DONE_RUN: Run = {
  id: 'run-20261111-0914',
  workspace: WS,
  status: 'done',
  created_at: T0,
  created_by: 'maya',
  started_at: T0,
  finished_at: '2026-11-11T09:31:42Z',
  items: FIXTURE_ITEMS,
  counts: countsOf(FIXTURE_ITEMS),
  est_cost_usd: 1.84,
  elapsed_ms: 17 * 60 * 1000 + 42_000,
  ceiling: CEILING,
  summary: summaryOf(FIXTURE_ITEMS),
  anchor_card: 900612,
}

/** The same run caught part-way: 11 files finished, one being read, the rest waiting. */
const progressItems: RunItem[] = FIXTURE_ITEMS.map((it, i) => {
  if (i < 9) return it
  if (i === 9) return { path: it.path, bytes: it.bytes, status: 'working' }
  if (i === 18 || i === 19) return it // skipped files are settled up front
  return { path: it.path, bytes: it.bytes, status: 'pending' }
})

export const FIXTURE_ACTIVE_RUN: Run = {
  ...FIXTURE_DONE_RUN,
  id: 'run-20261111-1002',
  status: 'running',
  finished_at: undefined,
  current: FIXTURE_ITEMS[9].path,
  items: progressItems,
  counts: countsOf(progressItems),
  est_cost_usd: 0.78,
  elapsed_ms: 6 * 60 * 1000 + 12_000,
  summary: undefined,
}

export const FIXTURE_QUESTIONS: OpenQuestion[] = [
  {
    id: 'q-sam', kind: 'ambiguous', status: 'open',
    ask: 'The kickoff notes mention "Sam" signing off the homepage. Is that Sam Whitaker, the owner of Harbor Bakery, or someone else?',
    about: [{ type: 'person', name: 'Sam' }, { type: 'person', name: 'Sam Whitaker' }],
    files: ['Clients/Harbor Bakery/Kickoff notes.md'],
  },
  {
    id: 'q-rebrand-price', kind: 'conflict', status: 'open',
    ask: 'The Pinecrest Dental rebrand is $14,500 in the signed contract but $12,800 in the rebrand brief. Which price is right?',
    about: [{ type: 'project', name: 'Pinecrest Dental rebrand' }],
    files: ['Clients/Pinecrest Dental/Signed contract.pdf', 'Clients/Pinecrest Dental/Rebrand brief.docx'],
  },
  {
    id: 'q-care-plan', kind: 'missing', status: 'open',
    ask: 'Retainers are being replaced by the Care Plan, but no file says what the Care Plan costs per month. What is the price?',
    about: [{ type: 'product', name: 'Care Plan' }],
    files: ['Decisions/Stop fixed-price retainers.txt'],
  },
]

const listing = (r: Run): RunListing => {
  const { items: _items, ...rest } = r
  return rest
}

const PAGES: Record<SectionKey, number> = {
  people: 4, companies: 3, projects: 2, decisions: 2, processes: 2, products: 3, glossary: 1, topics: 1,
}

/** Upload state: nothing has run yet, a few files are already waiting in intake/. */
export const FIXTURE_UPLOAD: KbSetupFixture = {
  status: {
    workspace: WS,
    intake: { files: 21, bytes: 23_400 * KB, folder: '/app/data/knowledge-base/lumen-lark/intake' },
    active: null, last: null, runs: [],
    pages: { people: 0, companies: 0, projects: 0, decisions: 0, processes: 0, products: 0, glossary: 0, topics: 0 },
    questions_open: 0,
    step_done: false,
  },
  runs: {},
  questions: [],
}

export const FIXTURE_PROGRESS: KbSetupFixture = {
  status: {
    ...FIXTURE_UPLOAD.status,
    intake: { ...FIXTURE_UPLOAD.status.intake, files: 0, bytes: 0 },
    active: listing(FIXTURE_ACTIVE_RUN),
    runs: [listing(FIXTURE_ACTIVE_RUN)],
  },
  runs: { [FIXTURE_ACTIVE_RUN.id]: FIXTURE_ACTIVE_RUN },
  questions: [],
}

export const FIXTURE_SUMMARY: KbSetupFixture = {
  status: {
    ...FIXTURE_UPLOAD.status,
    intake: { ...FIXTURE_UPLOAD.status.intake, files: 0, bytes: 0 },
    last: listing(FIXTURE_DONE_RUN),
    runs: [listing(FIXTURE_DONE_RUN)],
    pages: PAGES,
    questions_open: 3,
    step_done: true,
  },
  runs: { [FIXTURE_DONE_RUN.id]: FIXTURE_DONE_RUN },
  questions: FIXTURE_QUESTIONS,
}

/** An in-memory KbSetupApi over a fixture — no server. Writes mutate a private copy. */
export function fixtureApi(fixture: KbSetupFixture): KbSetupApi {
  const state: KbSetupFixture = structuredClone(fixture)
  const delay = <T,>(v: T) => new Promise<T>(ok => setTimeout(() => ok(structuredClone(v)), 0))
  const runOr404 = (id: string) => {
    const r = state.runs[id]
    if (!r) return Promise.reject(Object.assign(new Error('No such run'), { status: 404 }))
    return delay(r)
  }
  return {
    status: () => delay(state.status),
    upload: async batch => {
      state.status.intake.files += batch.length
      state.status.intake.bytes += batch.reduce((s, f) => s + f.file.size, 0)
      return delay({ saved: batch.map(f => f.path), skipped: [] })
    },
    sample: async () => {
      state.status.intake.files += 21
      state.status.intake.bytes += 23_400 * KB
      return delay({ saved: FIXTURE_ITEMS.map(i => i.path) })
    },
    startRun: async () => {
      if (state.status.active) return Promise.reject(Object.assign(new Error('A setup run is already active'), { status: 409 }))
      state.runs[FIXTURE_ACTIVE_RUN.id] = structuredClone(FIXTURE_ACTIVE_RUN)
      state.status.active = listing(FIXTURE_ACTIVE_RUN)
      return delay(FIXTURE_ACTIVE_RUN)
    },
    getRun: id => runOr404(id),
    pause: async id => {
      const r = state.runs[id]
      if (r) { r.status = 'paused'; r.pause_reason = 'user' }
      return runOr404(id)
    },
    resume: async id => {
      const r = state.runs[id]
      if (r) { r.status = 'running'; r.pause_reason = undefined }
      return runOr404(id)
    },
    questions: () => delay({ questions: state.questions }),
    answer: async (qid, body) => {
      const q = state.questions.find(x => x.id === qid)
      if (!q) return Promise.reject(Object.assign(new Error('No such question'), { status: 404 }))
      if ('dismiss' in body) q.status = 'dismissed'
      else { q.status = 'answered'; q.answer = body.answer; q.answered_by = 'maya'; q.answered_at = new Date().toISOString() }
      return delay(q)
    },
  }
}
