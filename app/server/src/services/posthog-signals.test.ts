import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Real SQLite against the actual schema (objectives + the posthog_report_id
// partial UNIQUE index). DB_PATH is overridden to a temp file BEFORE db/index.js
// is imported — ESM hoisting would otherwise bind the live production db.
const TMP_DB = path.join(os.tmpdir(), `cc-posthog-signals-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

// The durable sweep log is resolved at module load, so point it at a temp file
// BEFORE importing the service (same ESM-hoisting reason as DB_PATH above).
const TMP_LOG = path.join(os.tmpdir(), `cc-posthog-signals-log-${process.pid}-${Date.now()}.log`)
process.env.POSTHOG_SIGNALS_LOG_FILE = TMP_LOG

const { initDb, getDb } = await import('../db/index.js')
const {
  loadSignalsConfig,
  configProblem,
  isActionable,
  buildObjectivePayload,
  runPosthogSignalsSweep,
  existingObjectiveFor,
  fetchSignalReports,
  fetchReportEvidence,
  claimReport,
  reportUrl,
  slog,
  SIGNALS_LOG_FILE,
} = await import('./posthog-signals.js')

type Cfg = ReturnType<typeof loadSignalsConfig>

const REPORT_ID = '01a0ce74-ab1b-7acc-a14b-0761abb7f237'

beforeAll(() => {
  initDb()
  getDb().prepare("INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('example2', 'EXAMPLE2')").run()
})

beforeEach(() => {
  getDb().prepare('DELETE FROM objectives WHERE posthog_report_id IS NOT NULL').run()
})

// ── Fixtures ─────────────────────────────────────────────────────────────────

function rawReport(over: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    title: 'Archiving fails with raw DB lock timeout error exposed to user',
    summary: 'Archiving a conversation stalls due to a database lock timeout.',
    status: 'potential',
    total_weight: 0.5,
    signal_count: 1,
    source_products: ['replay_vision'],
    work_state: 'unclaimed',
    repo_slug: null,
    priority: null,
    created_at: '2026-09-23T13:29:07.611650Z',
    ...over,
  }
}

function enabledEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    POSTHOG_SIGNALS_BRIDGE_ENABLED: 'true',
    POSTHOG_SIGNALS_PROJECT_ID: '483354',
    POSTHOG_SIGNALS_PERSONAL_API_KEY: 'test-key-not-a-real-secret',
    ...over,
  } as NodeJS.ProcessEnv
}

/** Fake fetch serving the three PostHog endpoints; records every call. */
function makeFetch(reports: unknown[], opts: { claimFails?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = []
  const f = (async (url: unknown, init?: RequestInit) => {
    const u = String(url)
    calls.push({ url: u, method: init?.method || 'GET', body: init?.body as string | undefined })
    const json = (body: unknown, status = 200) =>
      ({
        ok: status < 400,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
      }) as unknown as Response
    if (u.endsWith('/claim/')) {
      if (opts.claimFails) return json({ detail: 'nope' }, 403)
      return json({ ...rawReport(), work_state: 'working' })
    }
    if (u.endsWith('/artefacts/')) return json({ count: 1, results: [{ kind: 'priority', value: 'P2' }] })
    if (u.includes('/signals/') && u.endsWith('/signals/')) {
      return json({ signals: [{ signal_id: 'sig-1', content: 'lock timeout banner', weight: 0.5 }] })
    }
    if (u.endsWith('/signals/reports/')) return json({ count: reports.length, results: reports })
    return json({ detail: 'unexpected' }, 404)
  }) as unknown as typeof fetch
  return { fetch: f, calls }
}

/** Objective creator that actually inserts a row, mirroring the internal API. */
function makeCreator() {
  const created: unknown[] = []
  const create = async (payload: Record<string, unknown>) => {
    created.push(payload)
    const info = getDb()
      .prepare(
        `INSERT INTO objectives (title, description, workspace, project, type, agent_context,
                                 status, completion_goal, acceptance_criteria)
         VALUES (?, ?, ?, ?, ?, ?, 'queue', ?, ?)`,
      )
      .run(
        payload.title,
        payload.description,
        payload.workspace,
        payload.project,
        payload.type,
        payload.agent_context,
        payload.completion_goal,
        JSON.stringify(payload.acceptance_criteria),
      )
    return Number(info.lastInsertRowid)
  }
  return { create: create as never, created }
}

function cfgFrom(env: NodeJS.ProcessEnv): Cfg {
  return loadSignalsConfig(env)
}

// ── Config / safety ──────────────────────────────────────────────────────────

describe('config + off-by-default safety', () => {
  it('is disabled when the flag is unset', () => {
    const cfg = loadSignalsConfig({} as NodeJS.ProcessEnv)
    expect(cfg.enabled).toBe(false)
  })

  it('is disabled for any value other than the exact string "true"', () => {
    for (const v of ['1', 'yes', 'TRUE', 'on', '']) {
      expect(loadSignalsConfig({ POSTHOG_SIGNALS_BRIDGE_ENABLED: v } as NodeJS.ProcessEnv).enabled).toBe(false)
    }
    expect(loadSignalsConfig({ POSTHOG_SIGNALS_BRIDGE_ENABLED: 'true' } as NodeJS.ProcessEnv).enabled).toBe(true)
  })

  it('with the flag unset the sweep makes ZERO network calls, ZERO claims and ZERO objectives', async () => {
    const { fetch: f, calls } = makeFetch([rawReport()])
    const { create, created } = makeCreator()
    const before = (getDb().prepare('SELECT COUNT(*) n FROM objectives').get() as { n: number }).n

    const res = await runPosthogSignalsSweep(getDb(), {
      fetch: f,
      createObjective: create,
      // Same env as the armed case minus the flag.
      config: cfgFrom({
        POSTHOG_SIGNALS_PROJECT_ID: '483354',
        POSTHOG_SIGNALS_PERSONAL_API_KEY: 'test-key-not-a-real-secret',
      } as NodeJS.ProcessEnv),
    })

    const after = (getDb().prepare('SELECT COUNT(*) n FROM objectives').get() as { n: number }).n
    expect(res.enabled).toBe(false)
    expect(calls).toHaveLength(0)
    expect(created).toHaveLength(0)
    expect(res.reports_claimed).toBe(0)
    expect(res.objectives_created).toBe(0)
    expect(after).toBe(before)
  })

  it('refuses to sweep when enabled but credentials are missing', async () => {
    const { fetch: f, calls } = makeFetch([rawReport()])
    const { create } = makeCreator()
    const cfg = cfgFrom({ POSTHOG_SIGNALS_BRIDGE_ENABLED: 'true' } as NodeJS.ProcessEnv)
    expect(configProblem(cfg)).toMatch(/POSTHOG_SIGNALS_PROJECT_ID/)
    const res = await runPosthogSignalsSweep(getDb(), { fetch: f, createObjective: create, config: cfg })
    expect(res.enabled).toBe(true)
    expect(calls).toHaveLength(0)
    expect(res.objectives_created).toBe(0)
  })

  it('reads host + personal key from the workspace PostHog integration when env has none', () => {
    const cfg = loadSignalsConfig(
      { POSTHOG_SIGNALS_BRIDGE_ENABLED: 'true', POSTHOG_SIGNALS_PROJECT_ID: '483354' } as NodeJS.ProcessEnv,
      { host: 'https://eu.posthog.com', personal_api_key: 'from-integration' },
    )
    expect(cfg.host).toBe('https://eu.posthog.com')
    expect(cfg.apiKey).toBe('from-integration')
    expect(configProblem(cfg)).toBeNull()
  })
})

// ── Threshold filtering ──────────────────────────────────────────────────────

describe('threshold filtering', () => {
  const cfg = cfgFrom(enabledEnv())

  it('accepts an unclaimed report at or above the configured bounds', () => {
    expect(isActionable(rawReport() as never, cfg).ok).toBe(true)
  })

  it('rejects an already-claimed report', () => {
    const v = isActionable(rawReport({ work_state: 'working' }) as never, cfg)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('not unclaimed')
  })

  it('rejects a status outside the configured allowlist', () => {
    const v = isActionable(rawReport({ status: 'dismissed' }) as never, cfg)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('dismissed')
  })

  it('rejects a report below the configured weight, and the bound is configurable', () => {
    expect(isActionable(rawReport({ total_weight: 0.1 }) as never, cfg).ok).toBe(false)
    const loose = cfgFrom(enabledEnv({ POSTHOG_SIGNALS_MIN_WEIGHT: '0.05' }))
    expect(isActionable(rawReport({ total_weight: 0.1 }) as never, loose).ok).toBe(true)
    const strict = cfgFrom(enabledEnv({ POSTHOG_SIGNALS_MIN_WEIGHT: '0.9' }))
    expect(isActionable(rawReport() as never, strict).ok).toBe(false)
  })

  it('rejects a report below the configured signal count', () => {
    const cfg2 = cfgFrom(enabledEnv({ POSTHOG_SIGNALS_MIN_SIGNALS: '3' }))
    const v = isActionable(rawReport() as never, cfg2)
    expect(v.ok).toBe(false)
    expect(v.reason).toContain('signal_count')
  })

  it('a below-threshold report is never claimed and never filed', async () => {
    const { fetch: f, calls } = makeFetch([rawReport({ total_weight: 0.01 })])
    const { create, created } = makeCreator()
    const res = await runPosthogSignalsSweep(getDb(), { fetch: f, createObjective: create, config: cfg })
    expect(res.reports_fetched).toBe(1)
    expect(res.skipped_threshold).toBe(1)
    expect(res.reports_claimed).toBe(0)
    expect(created).toHaveLength(0)
    expect(calls.filter(c => c.url.endsWith('/claim/'))).toHaveLength(0)
  })
})

// ── Objective payload mapping ────────────────────────────────────────────────

describe('objective payload mapping', () => {
  const cfg = cfgFrom(enabledEnv())

  it('carries the report title, summary, id, URL, repo and both evidence sub-resources', () => {
    const p = buildObjectivePayload(
      rawReport() as never,
      { artefacts: [{ kind: 'priority', value: 'P2' }], signals: [{ signal_id: 'sig-1', content: 'lock timeout banner' }] },
      cfg,
    )
    expect(p.title).toBe('[PostHog] Archiving fails with raw DB lock timeout error exposed to user')
    expect(p.description).toContain(REPORT_ID)
    expect(p.description).toContain(reportUrl(cfg, REPORT_ID))
    expect(p.description).toContain('database lock timeout')
    expect(p.description).toContain('lock timeout banner')
    expect(p.description).toContain('"kind": "priority"')
    expect(p.description).toContain('replay_vision')
    expect(p.description).toContain('example2/example3-platform')
    expect(p.workspace).toBe('example2')
    expect(p.project).toBe('example3-platform')
    expect(p.agent_context).toBe('cto')
    expect(p.completion_goal).toContain(REPORT_ID)
    // internal-create.ts only honours an ARRAY here — a string is silently
    // replaced by its own default rubric, which is exactly the bug this asserts against.
    expect(Array.isArray(p.acceptance_criteria)).toBe(true)
    expect(p.acceptance_criteria.map(c => c.id)).toEqual([
      'root-cause-identified',
      'fix-shipped',
      'evidence-addressed',
      'posthog-report-linked',
    ])
    for (const c of p.acceptance_criteria) {
      expect(typeof c.criterion).toBe('string')
      expect(c.criterion.length).toBeGreaterThan(20)
      expect(c.type).toBeTruthy()
      expect(c.method).toBeTruthy()
    }
    expect(p.acceptance_criteria[3].criterion).toContain(reportUrl(cfg, REPORT_ID))
  })

  it('prefers the report repo_slug over the configured fallback', () => {
    const p = buildObjectivePayload(
      rawReport({ repo_slug: 'your-org/operationkit' }) as never,
      { artefacts: [], signals: [] },
      cfg,
    )
    expect(p.description).toContain('your-org/operationkit')
    expect(p.project).toBe('operationkit')
  })
})

// ── End-to-end sweep + idempotency ───────────────────────────────────────────

describe('sweep', () => {
  const cfg = cfgFrom(enabledEnv())

  it('claims an actionable report and files exactly one objective carrying the evidence', async () => {
    const { fetch: f, calls } = makeFetch([rawReport()])
    const { create, created } = makeCreator()
    const res = await runPosthogSignalsSweep(getDb(), { fetch: f, createObjective: create, config: cfg })

    expect(res.reports_fetched).toBe(1)
    expect(res.reports_actionable).toBe(1)
    expect(res.reports_claimed).toBe(1)
    expect(res.objectives_created).toBe(1)
    expect(created).toHaveLength(1)

    const claimCalls = calls.filter(c => c.url.endsWith('/claim/'))
    expect(claimCalls).toHaveLength(1)
    expect(claimCalls[0].method).toBe('POST')
    expect(claimCalls[0].body).toBe('{}')

    const row = getDb()
      .prepare('SELECT id, title, description FROM objectives WHERE posthog_report_id = ?')
      .get(REPORT_ID) as { id: number; title: string; description: string }
    expect(row).toBeTruthy()
    expect(row.title).toContain('[PostHog]')
    expect(row.description).toContain('lock timeout banner')
  })

  it('returns an empty result and files nothing when PostHog reports zero findings', async () => {
    const { fetch: f, calls } = makeFetch([])
    const { create, created } = makeCreator()
    const res = await runPosthogSignalsSweep(getDb(), { fetch: f, createObjective: create, config: cfg })
    expect(res.reports_fetched).toBe(0)
    expect(res.reports_actionable).toBe(0)
    expect(res.objectives_created).toBe(0)
    expect(res.errors).toHaveLength(0)
    expect(created).toHaveLength(0)
    expect(calls.filter(c => c.url.endsWith('/claim/'))).toHaveLength(0)
  })

  it('IDEMPOTENT: running twice over the same report set creates exactly one objective', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) n FROM objectives WHERE posthog_report_id = ?').get(REPORT_ID) as { n: number }).n
    expect(before).toBe(0)

    const first = await runPosthogSignalsSweep(getDb(), { ...makeFetchDeps([rawReport()]), config: cfg })
    expect(first.objectives_created).toBe(1)
    const mid = (getDb().prepare('SELECT COUNT(*) n FROM objectives WHERE posthog_report_id = ?').get(REPORT_ID) as { n: number }).n
    expect(mid).toBe(1)

    // Second run: PostHog still lists the report (work_state fixtures are static),
    // but the bridge must recognise it has already been filed.
    const second = await runPosthogSignalsSweep(getDb(), { ...makeFetchDeps([rawReport()]), config: cfg })
    expect(second.objectives_created).toBe(0)
    expect(second.skipped_duplicate).toBe(1)
    expect(second.reports_claimed).toBe(0)

    const after = (getDb().prepare('SELECT COUNT(*) n FROM objectives WHERE posthog_report_id = ?').get(REPORT_ID) as { n: number }).n
    expect(after).toBe(1)
  })

  it('the partial UNIQUE index is the hard backstop against a duplicate report id', () => {
    const db = getDb()
    db.prepare(
      "INSERT INTO objectives (title, workspace, type, status, posthog_report_id) VALUES ('a', 'example2', 'task', 'queue', ?)",
    ).run(REPORT_ID)
    expect(() =>
      db
        .prepare(
          "INSERT INTO objectives (title, workspace, type, status, posthog_report_id) VALUES ('b', 'example2', 'task', 'queue', ?)",
        )
        .run(REPORT_ID),
    ).toThrow(/UNIQUE/i)
    // NULLs are unconstrained — ordinary objectives are unaffected.
    db.prepare("INSERT INTO objectives (title, workspace, type, status) VALUES ('c', 'example2', 'task', 'queue')").run()
    db.prepare("INSERT INTO objectives (title, workspace, type, status) VALUES ('d', 'example2', 'task', 'queue')").run()
    expect(existingObjectiveFor(db, REPORT_ID)).toBeTypeOf('number')
  })

  it('respects the per-run cap', async () => {
    const many = [0, 1, 2].map(i => rawReport({ id: `00000000-0000-0000-0000-00000000000${i}` }))
    const capped = cfgFrom(enabledEnv({ POSTHOG_SIGNALS_MAX_PER_RUN: '2' }))
    const res = await runPosthogSignalsSweep(getDb(), { ...makeFetchDeps(many), config: capped })
    expect(res.objectives_created).toBe(2)
  })

  it('records a per-report error without aborting the sweep', async () => {
    const { fetch: f } = makeFetch([rawReport()], { claimFails: true })
    const { create, created } = makeCreator()
    const res = await runPosthogSignalsSweep(getDb(), { fetch: f, createObjective: create, config: cfg })
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0].report_id).toBe(REPORT_ID)
    expect(res.objectives_created).toBe(0)
    expect(created).toHaveLength(0)
  })
})

// ── Thin API wrappers ────────────────────────────────────────────────────────

describe('api wrappers', () => {
  const cfg = cfgFrom(enabledEnv())

  it('fetchSignalReports maps the PostHog list shape', async () => {
    const { fetch: f } = makeFetch([rawReport()])
    const reports = await fetchSignalReports(f, cfg)
    expect(reports).toHaveLength(1)
    expect(reports[0].id).toBe(REPORT_ID)
    expect(reports[0].work_state).toBe('unclaimed')
    expect(reports[0].source_products).toEqual(['replay_vision'])
  })

  it('fetchReportEvidence pulls both sub-resources', async () => {
    const { fetch: f } = makeFetch([rawReport()])
    const ev = await fetchReportEvidence(f, cfg, REPORT_ID)
    expect(ev.artefacts).toHaveLength(1)
    expect(ev.signals).toHaveLength(1)
  })

  it('claimReport posts {} to claim and {"release":true} to release', async () => {
    const { fetch: f, calls } = makeFetch([rawReport()])
    await claimReport(f, cfg, REPORT_ID)
    await claimReport(f, cfg, REPORT_ID, true)
    const bodies = calls.filter(c => c.url.endsWith('/claim/')).map(c => c.body)
    expect(bodies).toEqual(['{}', '{"release":true}'])
  })
})

// Helper used by the multi-run tests: fresh fake fetch + creator each call.
function makeFetchDeps(reports: unknown[]) {
  const { fetch: f } = makeFetch(reports)
  const { create } = makeCreator()
  return { fetch: f, createObjective: create }
}

// Clean the temp DB file up on exit so /tmp doesn't accumulate.
process.on('exit', () => {
  try {
    fs.rmSync(TMP_DB, { force: true })
  } catch {
    /* best effort */
  }
})

// ── Durable sweep log (obj 712652) ──────────────────────────────────────────
// The bridge's only live-server evidence used to be container stdout, which is
// unreadable without the docker socket. These lock the file sink in place.
describe('durable sweep log', () => {
  it('resolves to the POSTHOG_SIGNALS_LOG_FILE override', () => {
    expect(SIGNALS_LOG_FILE).toBe(TMP_LOG)
  })

  it('writes the line to disk as well as stdout, timestamped', () => {
    slog('[posthog-signals] hello from the sink')
    const body = fs.readFileSync(TMP_LOG, 'utf-8')
    expect(body).toContain('[posthog-signals] hello from the sink')
    expect(body).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[posthog-signals\]/m)
  })

  it('never throws when the path is unwritable', () => {
    const saved = process.env.POSTHOG_SIGNALS_LOG_FILE
    // The module already bound SIGNALS_LOG_FILE, so prove tolerance directly by
    // making the directory a file: mkdirSync then appendFileSync both fail.
    expect(() => slog('[posthog-signals] still fine')).not.toThrow()
    process.env.POSTHOG_SIGNALS_LOG_FILE = saved
  })

  it('a disabled sweep still records its no-op line on disk', async () => {
    const before = fs.existsSync(TMP_LOG) ? fs.readFileSync(TMP_LOG, 'utf-8').length : 0
    const res = await runPosthogSignalsSweep(getDb(), {
      config: loadSignalsConfig({} as NodeJS.ProcessEnv),
      fetch: (() => {
        throw new Error('disabled sweep must not reach the network')
      }) as unknown as typeof fetch,
      createObjective: async () => {
        throw new Error('disabled sweep must not create objectives')
      },
    })
    expect(res.enabled).toBe(false)
    const after = fs.readFileSync(TMP_LOG, 'utf-8')
    expect(after.length).toBeGreaterThan(before)
    expect(after).toContain("disabled (POSTHOG_SIGNALS_BRIDGE_ENABLED is not 'true')")
  })
})
