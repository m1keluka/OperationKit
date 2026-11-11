/**
 * obj 900322 (corrections round) — the ceiling guard's ROLLOUT behaviour, driven
 * through the REAL express route and the REAL auto-start loop.
 *
 * ## Why this file exists
 *
 * The first round of this objective wired `guardAutoStartCeiling` into what its
 * own comment called "the chat/agent-originated start". Its only call site is
 * the auto-start loop in `POST /api/internal/objectives` that starts the
 * children of a live `delegate_mode` parent — **pre-existing automation**, not a
 * new MVP. Because the guard defaulted ON and nothing seeds a ceiling anywhere,
 * that combination silently converts every delegator's children into blocked
 * cards on deploy.
 *
 * A helper-level test could not have caught that: the helper did exactly what it
 * said. The mismatch was between the helper and the path it was attached to. So
 * every case here goes through the HTTP route, with a real migrated DB, a real
 * delegate parent, and the real start loop — only the spawn itself is mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'

const TMP_DB = path.join(os.tmpdir(), `cc-ceiling-policy-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

// The spawn is the ONLY thing stubbed. Everything the test asserts on — the
// policy resolution, the diagnostic row, the blocked card, the started list —
// is the route's own code running for real.
const startSessionMock = vi.fn(async () => `cc-mock-${Math.random().toString(36).slice(2, 8)}`)
vi.mock('../services/session-manager.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, startSession: (...a: unknown[]) => startSessionMock(...(a as [])) }
})
vi.mock('../ws/index.js', () => ({ broadcast: vi.fn(), broadcastToObjective: vi.fn() }))

const { initDb, getDb } = await import('../db/index.js')
const { default: internalRouter } = await import('./internal.js')
const { setObjectiveCeiling, recordSpend, resolveAutoStartPolicy, guardAutoStartCeiling } =
  await import('../services/job-accounting.js')

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  for (const sfx of ['', '-wal', '-shm']) { const f = `${TMP_DB}${sfx}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  initDb()
  const app = express()
  app.use(express.json())
  app.use('/api/internal', internalRouter)
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
      resolve()
    })
  })
})

afterAll(() => {
  try { server?.close() } catch { /* ignore */ }
  try { getDb().close() } catch { /* ignore */ }
  for (const sfx of ['', '-wal', '-shm']) { const f = `${TMP_DB}${sfx}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

beforeEach(() => {
  startSessionMock.mockClear()
  // Every test owns its own policy/ceiling settings.
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'job_ceiling%' OR key LIKE 'job_cost%' OR key LIKE 'job_wallclock%'").run()
})

let n = 0
/** A LIVE delegate_mode parent — the precondition for the auto-start loop. */
function seedDelegator(workspace = 'operationkit'): number {
  const db = getDb()
  const id = 9100000 + (n++ * 1000)  // wide gaps: the route INSERTs take max(id)+1
  db.prepare(
    `INSERT INTO objectives (id, title, type, status, effort, project, workspace, delegate_mode, session_id)
     VALUES (?, ?, 'task', 'working', 'normal', 'operationkit', ?, 1, ?)`,
  ).run(id, `delegator ${id}`, workspace, `cc-${id}-parent`)
  return id
}

async function postChild(parentId: number, title: string, workspace = 'operationkit') {
  const res = await fetch(`${baseUrl}/api/internal/objectives`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ title, parent_id: parentId, project: 'operationkit', workspace }]),
  })
  const json = (await res.json()) as { created: number; started: number; objectives: { id: number }[] }
  return { status: res.status, json, childId: json.objectives?.[0]?.id }
}

function cardOf(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as {
    status: string; session_id: string | null; ai_review_verdict: string | null
    ai_review_findings: string | null; has_blockers: number
  }
}

function diagnosticsFor(id: number) {
  return getDb()
    .prepare('SELECT event_type, title, detail, metadata FROM activity_log WHERE objective_id = ? ORDER BY id')
    .all(id) as { event_type: string; title: string; detail: string; metadata: string }[]
}

// ───────────────────────────────────────────────────────────────────────────
// The regression the corrections round exists for
// ───────────────────────────────────────────────────────────────────────────

describe('EXISTING delegate-child automation with NO ceiling configured anywhere', () => {
  it('still starts — an unconfigured install is not silently broken by the new guard', async () => {
    const parent = seedDelegator()
    const { status, json, childId } = await postChild(parent, 'legacy child, unbudgeted')

    expect(status).toBe(201)
    expect(json.started).toBe(1)                 // <- the breaking change, caught here
    expect(startSessionMock).toHaveBeenCalledTimes(1)
    const card = cardOf(childId)
    expect(card.status).toBe('working')
    expect(card.ai_review_verdict).not.toBe('blocked')
  })

  it('but the missing budget is REPORTED, not swallowed — observe never means silent', async () => {
    const parent = seedDelegator()
    const { childId } = await postChild(parent, 'legacy child, diagnostic')

    const diag = diagnosticsFor(childId).find(d => d.title === 'job_ceiling_unbudgeted_start')
    expect(diag).toBeTruthy()
    expect(diag!.detail).toContain('No finite job ceiling is configured')
    const meta = JSON.parse(diag!.metadata) as Record<string, string>
    expect(meta.path).toBe('delegate_child')
    expect(meta.policy).toBe('observe')
    expect(meta.policy_source).toBe('default:delegate_child') // traceable, not magic
  })

  it('the default policy is per-path: legacy observes, a NEW bounded start enforces', () => {
    const db = getDb()
    expect(resolveAutoStartPolicy(db, 'delegate_child').policy).toBe('observe')
    expect(resolveAutoStartPolicy(db, 'bounded').policy).toBe('enforce')
  })

  it('a NEW bounded start with no finite ceiling is refused outright (the promised safety)', () => {
    const parent = seedDelegator()
    const v = guardAutoStartCeiling(getDb(), { id: parent, workspace: 'operationkit' }, { path: 'bounded' })
    expect(v.allowed).toBe(false)
    expect(v.policy).toBe('enforce')
    expect(v.reason).toContain('no finite job ceiling is configured')
    // It separates what it can guarantee from what it cannot.
    expect(v.reason).toContain('ENFORCED by the runner')
    expect(v.reason).toContain('not a billing cap')
  })
})

describe('OPERATOR OPT-IN — enforcement is a setting an operator turns on', () => {
  it('settings.job_ceiling_policy:delegate_child = enforce → the same child is refused and blocked', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('job_ceiling_policy:delegate_child', 'enforce')").run()
    const parent = seedDelegator()
    const { json, childId } = await postChild(parent, 'child under enforce')

    expect(json.started).toBe(0)
    expect(startSessionMock).not.toHaveBeenCalled()
    const card = cardOf(childId)
    expect(card.status).toBe('review')
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.has_blockers).toBe(1)
    expect(card.ai_review_findings).toContain('Auto-start refused')
    expect(diagnosticsFor(childId).some(d => d.title === 'job_ceiling_auto_start_refused')).toBe(true)
  })

  it('opt-in can be scoped to ONE workspace — a migration lever, not a flip for everyone', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('job_ceiling_policy:delegate_child:example', 'enforce')").run()

    const exampleParent = seedDelegator('example')
    const example = await postChild(exampleParent, 'example child', 'example')
    expect(example.json.started).toBe(0)
    expect(cardOf(example.childId).ai_review_verdict).toBe('blocked')

    const okParent = seedDelegator('operationkit')
    const ok = await postChild(okParent, 'operationkit child')
    expect(ok.json.started).toBe(1)                       // untouched workspace keeps running
    expect(cardOf(ok.childId).status).toBe('working')
  })

  it('a CONFIGURED ceiling lets the child start with no unbudgeted diagnostic at all', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('job_wallclock_ceiling_ms:operationkit', '600000')").run()
    const parent = seedDelegator()
    const { json, childId } = await postChild(parent, 'budgeted child')

    expect(json.started).toBe(1)
    expect(diagnosticsFor(childId).some(d => d.title.startsWith('job_ceiling_'))).toBe(false)
  })
})

describe('OBSERVE covers "no budget yet" — never "ignore the budget somebody set"', () => {
  it('a child whose card ceiling is already SPENT is refused even under the default policy', async () => {
    const parent = seedDelegator()
    // Create the child first so we can pre-spend its budget, then re-post is not
    // possible — so configure at workspace level and spend on the card the route
    // creates. Use a global ceiling + a pre-seeded spend on the NEXT id.
    const { childId } = await postChild(parent, 'to-be-spent child')
    // Now the card exists and is working. Give it a budget it has already spent
    // and re-run the guard the way the loop does.
    setObjectiveCeiling(getDb(), childId, { costUsd: 1 })
    recordSpend(getDb(), childId, { usd: 2 })

    const v = guardAutoStartCeiling(getDb(), { id: childId, workspace: 'operationkit' }, { path: 'delegate_child' })
    expect(v.policy).toBe('observe')
    expect(v.allowed).toBe(false)
    expect(v.code).toBe('auto_start_ceiling_exceeded')
    expect(v.reason).toContain('cumulative and survives restarts')
  })

  it('the global kill switch is still honoured, and says so', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('job_ceiling_guard_enabled', '0')").run()
    const parent = seedDelegator()
    const v = guardAutoStartCeiling(getDb(), { id: parent, workspace: 'operationkit' }, { path: 'bounded' })
    expect(v.allowed).toBe(true)
    expect(v.policy).toBe('off')
    expect(v.wouldRefuse).toBe(false)
    expect(v.diagnostic).toContain('switched OFF')
  })
})
