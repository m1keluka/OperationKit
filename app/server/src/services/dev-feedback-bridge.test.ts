/**
 * Unit tests for the dev_feedback ↔ CC-objective bridge (obj 711117 W4).
 *
 * Tests cover:
 *  - Status mapping (all CC states → kanban)
 *  - Idempotency guards (no duplicate objectives on double-run)
 *  - 'waiting' carries fix_summary and pr_url
 *  - Missing config produces loud validated error
 *  - Intake pass: creates objective + syncs, skips on duplicate UUID
 *  - Status push: pushes changed status, skips unchanged, logs 'cancelled'
 *  - Multi-instance (obj 712905): example2 regression (same env/paths/payloads),
 *    example-project instance against the dev-feedback-internal contract, per-source
 *    uuid scoping, missing-env skip, ?workspace filter, per-instance error isolation
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-devfb-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  mapCcStatusToKanban,
  validateConfig,
  buildObjectiveDescription,
  runIntakePass,
  runStatusPushPass,
  runDevFeedbackBridgeOnce,
  runDevFeedbackBridge,
  resolveInstance,
  DEV_FEEDBACK_INSTANCES,
  EXAMPLE2_INSTANCE,
  WEIGHT_SUPPLY_INSTANCE,
} = await import('./dev-feedback-bridge.js')

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* noop */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  const db = getDb()
  // Clean up any objectives created during tests.
  db.exec("DELETE FROM objectives WHERE dev_feedback_uuid IS NOT NULL")
  db.exec("DELETE FROM objectives WHERE title LIKE '[bug]%' OR title LIKE '[feature]%'")
})

// ── Status mapping ────────────────────────────────────────────────────────────

describe('mapCcStatusToKanban', () => {
  it('maps planning → working', () => {
    expect(mapCcStatusToKanban('planning')).toBe('working')
  })
  it('maps queue → working', () => {
    expect(mapCcStatusToKanban('queue')).toBe('working')
  })
  it('maps working → working', () => {
    expect(mapCcStatusToKanban('working')).toBe('working')
  })
  it('maps ai_review → working', () => {
    expect(mapCcStatusToKanban('ai_review')).toBe('working')
  })
  it('maps review → waiting', () => {
    expect(mapCcStatusToKanban('review')).toBe('waiting')
  })
  it('maps done → done', () => {
    expect(mapCcStatusToKanban('done')).toBe('done')
  })
  it('maps cancelled → null (no change)', () => {
    expect(mapCcStatusToKanban('cancelled')).toBeNull()
  })
})

// ── Config validation ─────────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('returns null when both vars are set', () => {
    expect(validateConfig({
      EXAMPLE2_PLATFORM_BASE_URL: 'https://app.example2.ai',
      EXAMPLE2_INTERNAL_API_SECRET: 'secret123',
    })).toBeNull()
  })
  it('returns error string when EXAMPLE2_PLATFORM_BASE_URL is missing', () => {
    const err = validateConfig({ EXAMPLE2_INTERNAL_API_SECRET: 'secret123' })
    expect(err).toContain('EXAMPLE2_PLATFORM_BASE_URL')
    expect(typeof err).toBe('string')
  })
  it('returns error string when EXAMPLE2_INTERNAL_API_SECRET is missing', () => {
    const err = validateConfig({ EXAMPLE2_PLATFORM_BASE_URL: 'https://app.example2.ai' })
    expect(err).toContain('EXAMPLE2_INTERNAL_API_SECRET')
    expect(typeof err).toBe('string')
  })
  it('returns error string when both are missing', () => {
    const err = validateConfig({})
    expect(err).toContain('EXAMPLE2_PLATFORM_BASE_URL')
    expect(err).toContain('EXAMPLE2_INTERNAL_API_SECRET')
  })
})

// ── buildObjectiveDescription ─────────────────────────────────────────────────

describe('buildObjectiveDescription', () => {
  it('embeds all non-null fields', () => {
    const desc = buildObjectiveDescription({
      id: 'abc-123',
      type: 'bug',
      title: 'Test bug',
      description: 'Something broke',
      steps_to_repro: '1. Click X',
      expected_behavior: 'Should work',
      actual_behavior: 'Crashes',
      page_url: 'https://app.example2.ai/dashboard',
      severity: 'high',
      screenshot_path: 'screenshots/abc.png',
      screenshot_url: 'https://cdn.example.com/abc.png',
      route: '/dashboard',
      created_at: '2026-09-15T00:00:00Z',
    })
    expect(desc).toContain('Something broke')
    expect(desc).toContain('1. Click X')
    expect(desc).toContain('Should work')
    expect(desc).toContain('Crashes')
    expect(desc).toContain('https://app.example2.ai/dashboard')
    expect(desc).toContain('high')
    expect(desc).toContain('https://cdn.example.com/abc.png')
    expect(desc).toContain('abc-123')
  })
  it('omits null fields gracefully', () => {
    const desc = buildObjectiveDescription({
      id: 'xyz',
      type: 'feature',
      title: 'Request',
      description: null,
      steps_to_repro: null,
      expected_behavior: null,
      actual_behavior: null,
      page_url: null,
      severity: null,
      screenshot_path: null,
      screenshot_url: null,
      route: null,
      created_at: '2026-09-15T00:00:00Z',
    })
    expect(desc).toContain('xyz')
    expect(desc).not.toContain('undefined')
    expect(desc).not.toContain('null')
  })
})

// ── runDevFeedbackBridgeOnce — missing config → loud error ───────────────────

describe('runDevFeedbackBridgeOnce', () => {
  it('returns a loud error string when config is missing', async () => {
    const result = await runDevFeedbackBridgeOnce({})
    expect(result).toContain('MISSING required env vars')
    expect(result).toContain('EXAMPLE2_PLATFORM_BASE_URL')
  })
})

// ── Intake pass with mocked fetch ─────────────────────────────────────────────

const MOCK_ITEM = {
  id: 'feedback-uuid-001',
  type: 'bug' as const,
  title: 'Login button broken',
  description: 'Clicking login does nothing',
  steps_to_repro: '1. Go to /login\n2. Click Login',
  expected_behavior: 'Redirects to dashboard',
  actual_behavior: 'Nothing happens',
  page_url: 'https://app.example2.ai/login',
  severity: 'high',
  screenshot_path: null,
  screenshot_url: null,
  route: '/login',
  created_at: '2026-09-15T10:00:00Z',
}

function makeFetchMock(pendingItems: typeof MOCK_ITEM[], syncResponses?: Record<string, object>) {
  return vi.fn(async (url: string, opts?: RequestInit) => {
    const u = url.toString()
    if (u.endsWith('/pending')) {
      return {
        ok: true,
        json: async () => ({ items: pendingItems }),
        text: async () => '',
      } as unknown as Response
    }
    if (u.endsWith('/sync')) {
      const body = JSON.parse((opts?.body as string) ?? '{}')
      const resp = syncResponses?.[body.id ?? String(body.cc_objective_id)] ?? { ok: true, id: body.id, kanban_status: body.kanban_status }
      return {
        ok: true,
        json: async () => resp,
        text: async () => JSON.stringify(resp),
      } as unknown as Response
    }
    // localhost objective creation
    if (u.includes('/api/internal/objectives')) {
      const db = getDb()
      const items = JSON.parse((opts?.body as string) ?? '[]') as Array<{ title: string; description?: string; workspace?: string; project?: string; agent_context?: string; type?: string }>
      const created: Array<{ id: number }> = []
      for (const item of items) {
        const result = db.prepare(
          `INSERT INTO objectives (title, description, workspace, project, agent_context, type, status)
           VALUES (?, ?, ?, ?, ?, ?, 'queue') RETURNING id`,
        ).get(item.title, item.description ?? null, item.workspace ?? 'example2', item.project ?? null, item.agent_context ?? 'cto', item.type ?? 'task') as { id: number }
        created.push({ id: result.id })
      }
      const responseBody = { created: created.length, objectives: created, blocked: 0, blocked_details: [], started: 0 }
      return {
        ok: true,
        json: async () => responseBody,
        text: async () => JSON.stringify(responseBody),
      } as unknown as Response
    }
    throw new Error(`Unexpected fetch: ${u}`)
  })
}

describe('runIntakePass', () => {
  it('creates an objective and syncs for a pending item', async () => {
    const mockFetch = makeFetchMock([MOCK_ITEM])
    vi.stubGlobal('fetch', mockFetch)
    try {
      const result = await runIntakePass('https://app.example2.ai', 'secret')
      expect(result.created).toBe(1)
      expect(result.synced).toBe(1)

      // Objective exists with the dev_feedback_uuid
      const db = getDb()
      const obj = db.prepare(`SELECT id, dev_feedback_uuid FROM objectives WHERE dev_feedback_uuid = ?`).get(MOCK_ITEM.id) as { id: number; dev_feedback_uuid: string } | undefined
      expect(obj).toBeDefined()
      expect(obj?.dev_feedback_uuid).toBe(MOCK_ITEM.id)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not create a duplicate when run twice (idempotency)', async () => {
    // First run: pending has the item
    const fetchFirst = makeFetchMock([MOCK_ITEM])
    vi.stubGlobal('fetch', fetchFirst)
    await runIntakePass('https://app.example2.ai', 'secret')
    vi.unstubAllGlobals()

    // Second run: pending returns EMPTY (platform marks cc_objective_id after sync)
    const fetchSecond = makeFetchMock([])
    vi.stubGlobal('fetch', fetchSecond)
    try {
      const result = await runIntakePass('https://app.example2.ai', 'secret')
      expect(result.created).toBe(0)
      expect(result.synced).toBe(0)

      // Still exactly one objective with this UUID
      const db = getDb()
      const count = (db.prepare(`SELECT COUNT(*) as n FROM objectives WHERE dev_feedback_uuid = ?`).get(MOCK_ITEM.id) as { n: number }).n
      expect(count).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('re-syncs if objective exists but sync previously failed (uuid present, pending still returns it)', async () => {
    // Simulate: objective already exists with this UUID (from a prior crashed run)
    const db = getDb()
    const existing = db.prepare(
      `INSERT INTO objectives (title, dev_feedback_uuid, dev_feedback_source, workspace, project, agent_context, type, status)
       VALUES ('[bug] Login button broken', ?, 'example2', 'example2', 'example3-platform', 'cto', 'task', 'queue') RETURNING id`,
    ).get(MOCK_ITEM.id) as { id: number }

    // Platform still returns the item as pending (cc_objective_id was never set)
    const mockFetch = makeFetchMock([MOCK_ITEM])
    vi.stubGlobal('fetch', mockFetch)
    try {
      const result = await runIntakePass('https://app.example2.ai', 'secret')
      // No new objective created, but sync was attempted
      expect(result.created).toBe(0)
      expect(result.synced).toBe(1)
    } finally {
      vi.unstubAllGlobals()
      db.prepare(`DELETE FROM objectives WHERE id = ?`).run(existing.id)
    }
  })
})

// ── Status push pass ──────────────────────────────────────────────────────────

describe('runStatusPushPass', () => {
  it('pushes status when it has changed', async () => {
    const db = getDb()
    // Insert a bridged objective in 'review' status (→ should push 'waiting')
    const obj = db.prepare(
      `INSERT INTO objectives (title, dev_feedback_uuid, dev_feedback_source, workspace, project, status, last_session_summary, pr_url, last_known_kanban_status)
       VALUES ('[bug] Status push test', 'push-test-uuid-001', 'example2', 'example2', 'example3-platform', 'review', 'Fixed the login bug', 'https://github.com/EXAMPLE2/example3-platform/pull/999', 'working') RETURNING id`,
    ).get() as { id: number }

    const syncCalls: object[] = []
    const mockFetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.toString().endsWith('/sync')) {
        syncCalls.push(JSON.parse((opts?.body as string) ?? '{}'))
        return { ok: true, json: async () => ({ ok: true }), text: async () => '' } as unknown as Response
      }
      throw new Error(`Unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', mockFetch)

    try {
      const result = await runStatusPushPass('https://app.example2.ai', 'secret')
      expect(result.pushed).toBeGreaterThanOrEqual(1)

      // The sync call should have kanban_status='waiting' and include fix_summary and pr_url
      const call = syncCalls.find((c: any) => c.cc_objective_id === obj.id) as any
      expect(call).toBeDefined()
      expect(call.kanban_status).toBe('waiting')
      expect(call.fix_summary).toBe('Fixed the login bug')
      expect(call.pr_url).toBe('https://github.com/EXAMPLE2/example3-platform/pull/999')

      // last_known_kanban_status updated
      const updated = db.prepare(`SELECT last_known_kanban_status FROM objectives WHERE id = ?`).get(obj.id) as { last_known_kanban_status: string }
      expect(updated.last_known_kanban_status).toBe('waiting')
    } finally {
      vi.unstubAllGlobals()
      db.prepare(`DELETE FROM objectives WHERE id = ?`).run(obj.id)
    }
  })

  it('skips when status has not changed', async () => {
    const db = getDb()
    const obj = db.prepare(
      `INSERT INTO objectives (title, dev_feedback_uuid, dev_feedback_source, workspace, project, status, last_known_kanban_status)
       VALUES ('[bug] No-change test', 'nochange-uuid-001', 'example2', 'example2', 'example3-platform', 'working', 'working') RETURNING id`,
    ).get() as { id: number }

    const mockFetch = vi.fn(async () => {
      throw new Error('Should not call fetch when status unchanged')
    })
    vi.stubGlobal('fetch', mockFetch)
    try {
      const result = await runStatusPushPass('https://app.example2.ai', 'secret')
      // Our objective should have been skipped (not an error)
      expect(mockFetch).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      db.prepare(`DELETE FROM objectives WHERE id = ?`).run(obj.id)
    }
  })

  it('skips cancelled objectives without pushing', async () => {
    const db = getDb()
    const obj = db.prepare(
      `INSERT INTO objectives (title, dev_feedback_uuid, dev_feedback_source, workspace, project, status, last_known_kanban_status)
       VALUES ('[bug] Cancelled test', 'cancelled-uuid-001', 'example2', 'example2', 'example3-platform', 'cancelled', 'working') RETURNING id`,
    ).get() as { id: number }

    const mockFetch = vi.fn(async () => {
      throw new Error('Should not call fetch for cancelled objectives')
    })
    vi.stubGlobal('fetch', mockFetch)
    try {
      const result = await runStatusPushPass('https://app.example2.ai', 'secret')
      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.skipped).toBeGreaterThanOrEqual(1)
    } finally {
      vi.unstubAllGlobals()
      db.prepare(`DELETE FROM objectives WHERE id = ?`).run(obj.id)
    }
  })

  it('waiting status includes fix_summary and pr_url when available', async () => {
    const db = getDb()
    const obj = db.prepare(
      `INSERT INTO objectives (title, dev_feedback_uuid, dev_feedback_source, workspace, project, status, last_session_summary, pr_url, last_known_kanban_status)
       VALUES ('[bug] Waiting payload test', 'waiting-payload-uuid', 'example2', 'example2', 'example3-platform', 'review', 'Summary of fix', 'https://github.com/EXAMPLE2/example3-platform/pull/123', null) RETURNING id`,
    ).get() as { id: number }

    const syncPayloads: object[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      syncPayloads.push(JSON.parse((opts?.body as string) ?? '{}'))
      return { ok: true, json: async () => ({ ok: true }), text: async () => '' } as unknown as Response
    }))

    try {
      await runStatusPushPass('https://app.example2.ai', 'secret')
      const payload = syncPayloads.find((p: any) => p.cc_objective_id === obj.id) as any
      expect(payload.kanban_status).toBe('waiting')
      expect(payload.fix_summary).toBe('Summary of fix')
      expect(payload.pr_url).toBe('https://github.com/EXAMPLE2/example3-platform/pull/123')
    } finally {
      vi.unstubAllGlobals()
      db.prepare(`DELETE FROM objectives WHERE id = ?`).run(obj.id)
    }
  })
})

// ── Multi-instance (obj 712905) ───────────────────────────────────────────────

const WS_BASE = 'https://ws-project.test/functions/v1/dev-feedback-internal'

const WS_ITEM = {
  id: '5b0e6f0c-1111-4a4a-9c9c-000000000001',
  type: 'bug' as const,
  title: 'Checkout total wrong',
  description: 'Total ignores shipping',
  steps_to_repro: '1. Add item\n2. Checkout',
  expected_behavior: 'Total includes shipping',
  actual_behavior: 'Shipping missing',
  page_url: 'https://app.weightsupply.com/checkout',
  severity: 'high',
  submitter_name: 'Test Admin',
  submitter_email: 'test-admin@weightsupply.com',
  screenshot_url: 'https://ws-project.test/storage/v1/object/sign/x.png?token=t',
  created_at: '2026-09-26T10:00:00Z',
}

interface Call { url: string; method: string; headers: Record<string, string>; body: any }

/**
 * Fetch mock that serves BOTH platforms: pending per base URL, records every
 * call, and implements the localhost objective-create endpoint.
 */
function makeMultiFetch(pending: Record<string, object[]>, failPending: string[] = []) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, opts?: RequestInit) => {
    const u = url.toString()
    const call: Call = {
      url: u,
      method: opts?.method ?? 'GET',
      headers: (opts?.headers ?? {}) as Record<string, string>,
      body: opts?.body ? JSON.parse(opts.body as string) : undefined,
    }
    if (u.includes('/api/internal/objectives') && u.startsWith('http://localhost')) {
      const db = getDb()
      const created: Array<{ id: number }> = []
      for (const item of call.body as Array<{ title: string; description?: string; workspace: string; project: string; agent_context: string; type: string }>) {
        created.push(db.prepare(
          `INSERT INTO objectives (title, description, workspace, project, agent_context, type, status)
           VALUES (?, ?, ?, ?, ?, ?, 'queue') RETURNING id`,
        ).get(item.title, item.description ?? null, item.workspace, item.project, item.agent_context, item.type) as { id: number })
      }
      const body = { created: created.length, objectives: created }
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
    }
    calls.push(call)
    if (u.endsWith('/pending')) {
      const base = u.slice(0, u.lastIndexOf('/pending'))
      const key = Object.keys(pending).find((k) => base === k || base.startsWith(k)) ?? base
      if (failPending.some((f) => u.startsWith(f))) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' } as unknown as Response
      }
      return { ok: true, status: 200, json: async () => ({ items: pending[key] ?? [] }), text: async () => '' } as unknown as Response
    }
    if (u.endsWith('/sync')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' } as unknown as Response
    }
    throw new Error(`Unexpected fetch: ${u}`)
  })
  return { fn, calls }
}

const EXAMPLE2_ENV = { EXAMPLE2_PLATFORM_BASE_URL: 'https://app.example2.ai/', EXAMPLE2_INTERNAL_API_SECRET: 'example2-secret' }
const WS_ENV = { WS_DEV_FEEDBACK_INTERNAL_SECRET: 'ws-secret', WS_DEV_FEEDBACK_ANON_KEY: 'ws-anon', WS_DEV_FEEDBACK_BASE_URL: WS_BASE }

function insertBridged(source: string, uuid: string, status: string, extra: { summary?: string; pr?: string; lastKnown?: string | null } = {}) {
  return (getDb().prepare(
    `INSERT INTO objectives (title, dev_feedback_uuid, dev_feedback_source, workspace, project, status, last_session_summary, pr_url, last_known_kanban_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  ).get(`[bug] ${source} ${uuid}`, uuid, source, source, source === 'example2' ? 'example3-platform' : 'example-project-platform',
    status, extra.summary ?? null, extra.pr ?? null, extra.lastKnown ?? null) as { id: number }).id
}

describe('instance list', () => {
  it('has exactly example2 + example-project', () => {
    expect(DEV_FEEDBACK_INSTANCES.map((i) => i.workspace)).toEqual(['example2', 'example-project'])
  })
  it('example2 instance keeps the pre-712905 env names, paths, project, agent', () => {
    expect(EXAMPLE2_INSTANCE).toMatchObject({
      workspace: 'example2',
      project: 'example3-platform',
      agentContext: 'cto',
      baseUrlEnv: 'EXAMPLE2_PLATFORM_BASE_URL',
      secretEnv: 'EXAMPLE2_INTERNAL_API_SECRET',
      pendingPath: '/api/internal/dev-feedback/pending',
      syncPath: '/api/internal/dev-feedback/sync',
      statusPushIncludesId: false,
    })
    expect(EXAMPLE2_INSTANCE.defaultBaseUrl).toBeUndefined()
    expect(EXAMPLE2_INSTANCE.bearerEnv).toBeUndefined()
  })
  it('example-project instance points at the dev-feedback-internal contract endpoints', () => {
    const r = resolveInstance(WEIGHT_SUPPLY_INSTANCE, WS_ENV)!
    expect(`${r.baseUrl}${r.def.pendingPath}`).toBe(`${WS_BASE}/pending`)
    expect(`${r.baseUrl}${r.def.syncPath}`).toBe(`${WS_BASE}/sync`)
    expect(r.def).toMatchObject({ workspace: 'example-project', project: 'example-project-platform', agentContext: 'cto', secretEnv: 'WS_DEV_FEEDBACK_INTERNAL_SECRET', baseUrlEnv: 'WS_DEV_FEEDBACK_BASE_URL', bearerEnv: 'WS_DEV_FEEDBACK_ANON_KEY' })
    expect(r.headers).toEqual({ Authorization: 'Bearer ws-anon', apikey: 'ws-anon' })
  })
  it('WS_DEV_FEEDBACK_BASE_URL is trimmed; anon key is optional', () => {
    const r = resolveInstance(WEIGHT_SUPPLY_INSTANCE, { WS_DEV_FEEDBACK_INTERNAL_SECRET: 's', WS_DEV_FEEDBACK_BASE_URL: 'https://x.test/fn/' })!
    expect(r.baseUrl).toBe('https://x.test/fn')
    expect(r.headers).toEqual({})
  })
})

describe('runDevFeedbackBridge — example2 regression', () => {
  it('PASS A hits the same example2 URLs/headers/payload and creates a example2 objective', async () => {
    const { fn, calls } = makeMultiFetch({ 'https://app.example2.ai': [MOCK_ITEM] })
    vi.stubGlobal('fetch', fn)
    try {
      const res = await runDevFeedbackBridge({ ...EXAMPLE2_ENV }, { workspace: 'example2' })
      expect(res.ok).toBe(true)
      expect(res.instances).toEqual([expect.objectContaining({ workspace: 'example2', status: 'ran' })])
      expect(res.summary).toContain('intake: 1 created, 1 synced')

      expect(calls[0].url).toBe('https://app.example2.ai/api/internal/dev-feedback/pending')
      expect(calls[0].headers).toEqual({ 'x-internal-secret': 'example2-secret' })
      const sync = calls.find((c) => c.url === 'https://app.example2.ai/api/internal/dev-feedback/sync')!
      expect(sync.headers).toEqual({ 'Content-Type': 'application/json', 'x-internal-secret': 'example2-secret' })
      const obj = getDb().prepare(`SELECT id, workspace, project, agent_context, dev_feedback_source FROM objectives WHERE dev_feedback_uuid = ?`).get(MOCK_ITEM.id) as any
      expect(obj).toMatchObject({ workspace: 'example2', project: 'example3-platform', agent_context: 'cto', dev_feedback_source: 'example2' })
      expect(sync.body).toEqual({ id: MOCK_ITEM.id, cc_objective_id: obj.id, kanban_status: 'working' })
      // No call ever went to the WS platform.
      expect(calls.some((c) => c.url.startsWith(WS_BASE))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('PASS B review → waiting carries fix_summary + pr_url and NO id (historic example2 payload)', async () => {
    const id = insertBridged('example2', 'g-review', 'review', { summary: 'Fixed it', pr: 'https://github.com/EXAMPLE2/example3-platform/pull/1', lastKnown: 'working' })
    const { fn, calls } = makeMultiFetch({})
    vi.stubGlobal('fetch', fn)
    try {
      await runDevFeedbackBridge({ ...EXAMPLE2_ENV }, { workspace: 'example2' })
      const sync = calls.find((c) => c.url.endsWith('/sync') && c.body.cc_objective_id === id)!
      expect(sync.url).toBe('https://app.example2.ai/api/internal/dev-feedback/sync')
      expect(sync.body).toEqual({ cc_objective_id: id, kanban_status: 'waiting', fix_summary: 'Fixed it', pr_url: 'https://github.com/EXAMPLE2/example3-platform/pull/1' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('runDevFeedbackBridge — example-project instance', () => {
  it('PASS A: pending → example-project objective → sync working with id (contract shape + auth headers)', async () => {
    const { fn, calls } = makeMultiFetch({ [WS_BASE]: [WS_ITEM] })
    vi.stubGlobal('fetch', fn)
    try {
      const res = await runDevFeedbackBridge({ ...WS_ENV }, { workspace: 'example-project' })
      expect(res.ok).toBe(true)
      expect(res.summary).toContain('[dev-feedback-bridge:example-project] run complete — intake: 1 created, 1 synced')

      expect(calls[0]).toMatchObject({ url: `${WS_BASE}/pending`, method: 'GET' })
      expect(calls[0].headers).toEqual({ Authorization: 'Bearer ws-anon', apikey: 'ws-anon', 'x-internal-secret': 'ws-secret' })

      const obj = getDb().prepare(`SELECT id, title, description, workspace, project, agent_context, dev_feedback_source FROM objectives WHERE dev_feedback_uuid = ?`).get(WS_ITEM.id) as any
      expect(obj).toMatchObject({ title: '[bug] Checkout total wrong', workspace: 'example-project', project: 'example-project-platform', agent_context: 'cto', dev_feedback_source: 'example-project' })
      expect(obj.description).toContain('**Submitted by:** Test Admin <test-admin@weightsupply.com>')
      expect(obj.description).toContain(`**Screenshot:** ${WS_ITEM.screenshot_url}`)

      const sync = calls.find((c) => c.url === `${WS_BASE}/sync`)!
      expect(sync.method).toBe('POST')
      expect(sync.headers['x-internal-secret']).toBe('ws-secret')
      expect(sync.headers.Authorization).toBe('Bearer ws-anon')
      expect(sync.body).toEqual({ id: WS_ITEM.id, cc_objective_id: obj.id, kanban_status: 'working' })
      expect(calls.some((c) => c.url.includes('example2'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('PASS B mapping: review → waiting (+id, fix_summary, pr_url), done → done, queue → working, cancelled → no push', async () => {
    const review = insertBridged('example-project', 'w-review', 'review', { summary: 'Shipping now added', pr: 'https://github.com/Example-Project/example-project-platform/pull/9', lastKnown: 'working' })
    const done = insertBridged('example-project', 'w-done', 'done', { lastKnown: 'waiting' })
    const queued = insertBridged('example-project', 'w-queue', 'queue', { lastKnown: null })
    const cancelled = insertBridged('example-project', 'w-cancel', 'cancelled', { lastKnown: 'working' })
    const { fn, calls } = makeMultiFetch({})
    vi.stubGlobal('fetch', fn)
    try {
      await runDevFeedbackBridge({ ...WS_ENV }, { workspace: 'example-project' })
      const byObj = (id: number) => calls.find((c) => c.url === `${WS_BASE}/sync` && c.body.cc_objective_id === id)?.body
      expect(byObj(review)).toEqual({ id: 'w-review', cc_objective_id: review, kanban_status: 'waiting', fix_summary: 'Shipping now added', pr_url: 'https://github.com/Example-Project/example-project-platform/pull/9' })
      expect(byObj(done)).toEqual({ id: 'w-done', cc_objective_id: done, kanban_status: 'done' })
      expect(byObj(queued)).toEqual({ id: 'w-queue', cc_objective_id: queued, kanban_status: 'working' })
      expect(byObj(cancelled)).toBeUndefined()
      const lk = getDb().prepare(`SELECT last_known_kanban_status s FROM objectives WHERE id = ?`)
      expect((lk.get(review) as any).s).toBe('waiting')
      expect((lk.get(cancelled) as any).s).toBe('working')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('runDevFeedbackBridge — cross-instance isolation', () => {
  it('the same uuid from both platforms yields two objectives, each pushed only to its own platform', async () => {
    const shared = '00000000-0000-4000-8000-000000000abc'
    const pending: Record<string, object[]> = { 'https://app.example2.ai': [{ ...MOCK_ITEM, id: shared }], [WS_BASE]: [{ ...WS_ITEM, id: shared }] }
    const { fn, calls } = makeMultiFetch(pending)
    vi.stubGlobal('fetch', fn)
    try {
      const res = await runDevFeedbackBridge({ ...EXAMPLE2_ENV, ...WS_ENV })
      expect(res.ok).toBe(true)
      const rows = getDb().prepare(`SELECT id, dev_feedback_source, workspace FROM objectives WHERE dev_feedback_uuid = ? ORDER BY dev_feedback_source`).all(shared) as any[]
      expect(rows.map((r) => [r.dev_feedback_source, r.workspace])).toEqual([['example2', 'example2'], ['example-project', 'example-project']])
      // Platforms now have cc_objective_id → nothing pending. Move both to review;
      // a second run must push each only to its own platform.
      for (const k of Object.keys(pending)) pending[k] = []
      getDb().prepare(`UPDATE objectives SET status = 'review' WHERE dev_feedback_uuid = ?`).run(shared)
      calls.length = 0
      await runDevFeedbackBridge({ ...EXAMPLE2_ENV, ...WS_ENV })
      const g = rows.find((r) => r.dev_feedback_source === 'example2').id
      const w = rows.find((r) => r.dev_feedback_source === 'example-project').id
      const syncs = calls.filter((c) => c.url.endsWith('/sync'))
      expect(syncs.filter((c) => c.body.cc_objective_id === g).map((c) => c.url)).toEqual(['https://app.example2.ai/api/internal/dev-feedback/sync'])
      expect(syncs.filter((c) => c.body.cc_objective_id === w).map((c) => c.url)).toEqual([`${WS_BASE}/sync`])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('DB enforces uniqueness per (source, uuid)', () => {
    insertBridged('example-project', 'dup-uuid', 'queue')
    expect(() => insertBridged('example-project', 'dup-uuid', 'queue')).toThrow(/UNIQUE/)
    expect(() => insertBridged('example2', 'dup-uuid', 'queue')).not.toThrow()
  })
})

describe('runDevFeedbackBridge — skip / filter / error isolation', () => {
  it('example-project with no secret is cleanly skipped with a log naming the env; example2 still runs', async () => {
    const { fn, calls } = makeMultiFetch({ 'https://app.example2.ai': [] })
    vi.stubGlobal('fetch', fn)
    const logSpy = vi.spyOn(console, 'log')
    try {
      const res = await runDevFeedbackBridge({ ...EXAMPLE2_ENV })
      expect(res.ok).toBe(true)
      const ws = res.instances.find((i) => i.workspace === 'example-project')!
      expect(ws.status).toBe('skipped')
      expect(ws.missingEnv).toEqual(['WS_DEV_FEEDBACK_BASE_URL', 'WS_DEV_FEEDBACK_INTERNAL_SECRET'])
      expect(ws.summary).toContain('MISSING required env vars: WS_DEV_FEEDBACK_BASE_URL, WS_DEV_FEEDBACK_INTERNAL_SECRET')
      expect(logSpy.mock.calls.some((c) => String(c[0]).includes('WS_DEV_FEEDBACK_INTERNAL_SECRET'))).toBe(true)
      expect(res.instances.find((i) => i.workspace === 'example2')!.status).toBe('ran')
      expect(calls.some((c) => c.url.startsWith(WS_BASE))).toBe(false)
    } finally {
      logSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })

  it('?workspace filter runs only that instance; unknown workspace throws', async () => {
    const { fn, calls } = makeMultiFetch({})
    vi.stubGlobal('fetch', fn)
    try {
      const res = await runDevFeedbackBridge({ ...EXAMPLE2_ENV, ...WS_ENV }, { workspace: 'example-project' })
      expect(res.instances.map((i) => i.workspace)).toEqual(['example-project'])
      expect(calls.every((c) => c.url.startsWith(WS_BASE))).toBe(true)
      await expect(runDevFeedbackBridge({}, { workspace: 'nope' })).rejects.toThrow(/unknown dev-feedback workspace 'nope'/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('one instance failing does not stop the other; ok=false', async () => {
    const { fn } = makeMultiFetch({ [WS_BASE]: [] }, ['https://app.example2.ai'])
    vi.stubGlobal('fetch', fn)
    try {
      const res = await runDevFeedbackBridge({ ...EXAMPLE2_ENV, ...WS_ENV })
      expect(res.ok).toBe(false)
      expect(res.instances.find((i) => i.workspace === 'example2')).toMatchObject({ status: 'error' })
      expect(res.instances.find((i) => i.workspace === 'example2')!.error).toContain('→ 500: boom')
      expect(res.instances.find((i) => i.workspace === 'example-project')).toMatchObject({ status: 'ran' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('runDevFeedbackBridgeOnce with empty env skips both instances with loud per-instance lines', async () => {
    const out = await runDevFeedbackBridgeOnce({})
    expect(out).toContain('[dev-feedback-bridge:example2] MISSING required env vars: EXAMPLE2_PLATFORM_BASE_URL, EXAMPLE2_INTERNAL_API_SECRET')
    expect(out).toContain('[dev-feedback-bridge:example-project] MISSING required env vars: WS_DEV_FEEDBACK_BASE_URL, WS_DEV_FEEDBACK_INTERNAL_SECRET')
  })
})
