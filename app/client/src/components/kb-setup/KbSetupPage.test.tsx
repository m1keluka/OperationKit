// @vitest-environment jsdom
//
// Knowledge Base Setup page (obj 900556): the three states rendered from the
// Lumen & Lark fixture, answering a question, and the pure upload helpers
// (folder traversal + batching). Fake data only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KbSetupPage } from './KbSetupPage'
import { KB_SETUP_STEP, KbSetupStep } from './KbSetupStep'
import {
  FIXTURE_PROGRESS, FIXTURE_SUMMARY, FIXTURE_UPLOAD, fixtureApi, type KbSetupFixture,
} from './KbSetupPage.fixture'
import {
  batchFiles, createKbSetupApi, uploadInBatches, walkEntry, type EntryLike, type KbSetupApi, type PickedFile,
} from '../../lib/kbSetup'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function flush() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  }
}

function spyApi(fixture: KbSetupFixture): KbSetupApi {
  const base = fixtureApi(fixture)
  return {
    status: vi.fn(base.status),
    upload: vi.fn(base.upload),
    sample: vi.fn(base.sample),
    startRun: vi.fn(base.startRun),
    getRun: vi.fn(base.getRun),
    pause: vi.fn(base.pause),
    resume: vi.fn(base.resume),
    questions: vi.fn(base.questions),
    answer: vi.fn(base.answer),
  }
}

describe('KbSetupPage', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function mount(api: KbSetupApi) {
    await act(async () => { root.render(<KbSetupPage workspace="lumen-lark" api={api} pollMs={60_000} />) })
    await flush()
  }

  const button = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === label) as HTMLButtonElement | undefined

  it('renders the upload state with the intake count and folder', async () => {
    await mount(spyApi(FIXTURE_UPLOAD))
    expect(container.querySelector('[data-testid="kb-dropzone"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="intake-count"]')?.textContent).toContain('21 files')
    expect(container.textContent).toContain('or copy files into this folder on the server')
    expect(container.textContent).toContain('/lumen-lark/intake')
    expect(button('Choose files')).toBeTruthy()
    expect(button('Choose folder')).toBeTruthy()
    expect(button('Try with sample files')).toBeTruthy()
    expect(button('Start setup')?.disabled).toBe(false)
    expect(container.querySelector('input[aria-label="Choose folder"]')?.hasAttribute('webkitdirectory')).toBe(true)
  })

  it('Start setup moves to the progress view', async () => {
    const api = spyApi(FIXTURE_UPLOAD)
    await mount(api)
    await act(async () => { button('Start setup')!.click() })
    await flush()
    expect(api.startRun).toHaveBeenCalledTimes(1)
    expect(button('Pause')).toBeTruthy()
  })

  it('renders progress with counts, cost and a Pause button', async () => {
    const api = spyApi(FIXTURE_PROGRESS)
    await mount(api)
    expect(container.querySelector('[data-testid="run-progress"]')?.textContent).toContain('of 21 files')
    // 9 filed + 2 skipped are finished.
    expect(container.querySelector('[data-testid="run-progress"]')?.textContent?.startsWith('11')).toBe(true)
    const counts = container.querySelector('[aria-label="File counts"]')!.textContent!
    expect(counts).toContain('Filed 9')
    expect(counts).toContain('Skipped 2')
    expect(counts).toContain('Waiting 9')
    expect(container.textContent).toContain('Estimated cost')
    expect(container.textContent).toContain('$5.00 ceiling')
    expect(container.textContent).toContain('Reading Decisions/2026-03 Move invoicing to monthly.md')
    expect(container.querySelectorAll('[aria-label="Files in this run"] li')).toHaveLength(21)
    await act(async () => { button('Pause')!.click() })
    await flush()
    expect(api.pause).toHaveBeenCalledWith('run-20261111-1002')
    expect(button('Resume')).toBeTruthy()
  })

  it('shows the ceiling explanation and continues past budget', async () => {
    const fx = structuredClone(FIXTURE_PROGRESS)
    const run = fx.runs['run-20261111-1002']
    run.status = 'paused'
    run.pause_reason = 'ceiling'
    fx.status.active = { ...fx.status.active!, status: 'paused', pause_reason: 'ceiling' }
    const api = spyApi(fx)
    await mount(api)
    expect(container.textContent).toContain('Paused at the budget ceiling')
    await act(async () => { button('Continue past budget')!.click() })
    await flush()
    expect(api.resume).toHaveBeenCalledWith('run-20261111-1002', true)
  })

  it('says when no ceiling is set', async () => {
    const fx = structuredClone(FIXTURE_PROGRESS)
    fx.runs['run-20261111-1002'].ceiling = { cost_usd: null, wallclock_ms: null, source: 'none' }
    await mount(spyApi(fx))
    expect(container.textContent).toContain('No budget ceiling set')
  })

  it('renders the summary: section counts, secrets alert and open questions', async () => {
    await mount(spyApi(FIXTURE_SUMMARY))
    const grid = container.querySelector('[data-testid="section-grid"]')!
    expect(grid.querySelectorAll('[data-section]')).toHaveLength(8)
    expect(grid.querySelector('[data-section="people"]')!.textContent).toContain('3 new')
    expect(grid.querySelector('[data-section="people"]')!.textContent).toContain('1 updated')
    expect(grid.querySelector('[data-section="products"]')!.textContent).toContain('3 new')
    expect(grid.querySelector('[data-section="glossary"]')!.textContent).toContain('1 new')
    const totals = container.querySelector('[aria-label="Run totals"]')!.textContent!
    expect(totals).toContain('Files read16')
    expect(container.textContent).toContain('Secrets removed from 2 files')
    const secrets = container.querySelector('[data-testid="secrets-list"]')!.textContent!
    expect(secrets).toContain('Processes/Invoicing SOP.docx')
    expect(secrets).toContain('stripe-key on line 14')
    expect(container.querySelectorAll('[data-testid="open-question"]')).toHaveLength(3)
    expect(container.textContent).toContain('decision queue')
    expect(container.textContent).toContain('The workbook is password-protected')
    expect(container.textContent).toContain('Harbor Bakery website')
    expect(button('Set up more files')).toBeTruthy()
  })

  it('answering a question calls the API and drops it from the list', async () => {
    const api = spyApi(FIXTURE_SUMMARY)
    await mount(api)
    const first = container.querySelector('[data-testid="open-question"]')!
    const box = first.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(box, 'Yes, Sam Whitaker')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = Array.from(first.querySelectorAll('button')).find(b => b.textContent === 'Save answer')!
    await act(async () => { save.click() })
    await flush()
    expect(api.answer).toHaveBeenCalledWith('q-sam', { answer: 'Yes, Sam Whitaker' })
    expect(container.querySelectorAll('[data-testid="open-question"]')).toHaveLength(2)

    const next = container.querySelector('[data-testid="open-question"]')!
    const dismiss = Array.from(next.querySelectorAll('button')).find(b => b.textContent === 'Dismiss')!
    await act(async () => { dismiss.click() })
    await flush()
    expect(api.answer).toHaveBeenCalledWith('q-rebrand-price', { dismiss: true })
  })

  it('"Set up more files" returns to the upload state', async () => {
    await mount(spyApi(FIXTURE_SUMMARY))
    await act(async () => { button('Set up more files')!.click() })
    await flush()
    expect(container.querySelector('[data-testid="kb-dropzone"]')).toBeTruthy()
  })
})

describe('KbSetupStep', () => {
  it('exports the step definition and renders the done tick', async () => {
    expect(KB_SETUP_STEP).toMatchObject({ id: 'knowledge_base', href: '/knowledge/setup' })
    const el = document.createElement('div')
    const r = createRoot(el)
    await act(async () => { r.render(<KbSetupStep done />) })
    expect(el.textContent).toContain('Step 4')
    expect(el.textContent).toContain('Set up your knowledge base')
    expect(el.querySelector('[aria-label="Done"]')).toBeTruthy()
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/knowledge/setup')
    act(() => r.unmount())
  })
})

describe('createKbSetupApi', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('posts answers and ceiling overrides to the workspace-scoped routes', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createKbSetupApi('lumen-lark')
    await api.answer('q-sam', { answer: 'Sam Whitaker' })
    await api.resume('run-1', true)
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls[0][0]).toBe('/api/kb-setup/questions/q-sam?workspace=lumen-lark')
    expect(calls[0][1].method).toBe('POST')
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ answer: 'Sam Whitaker' })
    expect(calls[1][0]).toBe('/api/kb-setup/runs/run-1/resume?workspace=lumen-lark')
    expect(JSON.parse(String(calls[1][1].body))).toEqual({ ignore_ceiling: true })
  })

  it('uploads multipart with files + a JSON paths array in the same order', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ saved: ['a'], skipped: [] }), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const api = createKbSetupApi('lumen-lark')
    await api.upload([
      { file: new File(['x'], 'a.md'), path: 'Notes/a.md' },
      { file: new File(['y'], 'b.csv'), path: 'Exports/b.csv' },
    ])
    const [url, init] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]
    expect(url).toBe('/api/kb-setup/upload?workspace=lumen-lark')
    const fd = init.body as FormData
    expect(fd.getAll('files')).toHaveLength(2)
    expect(JSON.parse(String(fd.get('paths')))).toEqual(['Notes/a.md', 'Exports/b.csv'])
  })
})

describe('upload helpers', () => {
  it('batchFiles splits into chunks of at most 50', () => {
    const xs = Array.from({ length: 123 }, (_, i) => i)
    const b = batchFiles(xs)
    expect(b.map(c => c.length)).toEqual([50, 50, 23])
    expect(b.flat()).toEqual(xs)
    expect(batchFiles([])).toEqual([])
  })

  it('walkEntry traverses folders, keeps relative paths and reads every readEntries chunk', async () => {
    const file = (name: string): EntryLike => ({
      isFile: true, isDirectory: false, name, file: ok => ok(new File([name], name)),
    })
    const dir = (name: string, chunks: EntryLike[][]): EntryLike => ({
      isFile: false, isDirectory: true, name,
      createReader: () => {
        let i = 0
        return { readEntries: ok => ok(chunks[i++] ?? []) }
      },
    })
    const tree = dir('Lumen', [
      [file('About.docx'), dir('Clients', [[dir('Harbor Bakery', [[file('Proposal.pdf')], [file('Kickoff.md')]])]])],
      [file('Glossary.md')],
    ])
    const out = await walkEntry(tree)
    expect(out.map(f => f.path)).toEqual([
      'Lumen/About.docx',
      'Lumen/Clients/Harbor Bakery/Proposal.pdf',
      'Lumen/Clients/Harbor Bakery/Kickoff.md',
      'Lumen/Glossary.md',
    ])
  })

  it('uploadInBatches reports progress per batch and merges results', async () => {
    const files: PickedFile[] = Array.from({ length: 120 }, (_, i) => ({ file: new File(['x'], `f${i}.md`), path: `d/f${i}.md` }))
    const upload = vi.fn(async (b: PickedFile[]) => ({ saved: b.map(f => f.path), skipped: [] }))
    const seen: Array<[number, number]> = []
    const r = await uploadInBatches({ upload }, files, (s, t) => seen.push([s, t]))
    expect(upload).toHaveBeenCalledTimes(3)
    expect(seen).toEqual([[0, 120], [50, 120], [100, 120], [120, 120]])
    expect(r.saved).toHaveLength(120)
  })
})
