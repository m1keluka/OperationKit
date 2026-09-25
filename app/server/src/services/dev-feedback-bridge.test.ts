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
      `INSERT INTO objectives (title, dev_feedback_uuid, workspace, project, agent_context, type, status)
       VALUES ('[bug] Login button broken', ?, 'example2', 'example3-platform', 'cto', 'task', 'queue') RETURNING id`,
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
      `INSERT INTO objectives (title, dev_feedback_uuid, workspace, project, status, last_session_summary, pr_url, last_known_kanban_status)
       VALUES ('[bug] Status push test', 'push-test-uuid-001', 'example2', 'example3-platform', 'review', 'Fixed the login bug', 'https://github.com/EXAMPLE2/example3-platform/pull/999', 'working') RETURNING id`,
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
      `INSERT INTO objectives (title, dev_feedback_uuid, workspace, project, status, last_known_kanban_status)
       VALUES ('[bug] No-change test', 'nochange-uuid-001', 'example2', 'example3-platform', 'working', 'working') RETURNING id`,
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
      `INSERT INTO objectives (title, dev_feedback_uuid, workspace, project, status, last_known_kanban_status)
       VALUES ('[bug] Cancelled test', 'cancelled-uuid-001', 'example2', 'example3-platform', 'cancelled', 'working') RETURNING id`,
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
      `INSERT INTO objectives (title, dev_feedback_uuid, workspace, project, status, last_session_summary, pr_url, last_known_kanban_status)
       VALUES ('[bug] Waiting payload test', 'waiting-payload-uuid', 'example2', 'example3-platform', 'review', 'Summary of fix', 'https://github.com/EXAMPLE2/example3-platform/pull/123', null) RETURNING id`,
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
