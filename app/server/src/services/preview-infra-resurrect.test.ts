import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

// Real SQLite, same discipline as pr-linkage.test.ts: exercises the actual schema
// (objectives.blocked_reason) rather than mocking the DB layer. `gh`/network/session
// start are all injected fakes.
const TMP_DB = path.join(os.tmpdir(), `cc-preview-resurrect-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.HARNESS_REPO = 'your-org/operationkit'

const { initDb, getDb } = await import('../db/index.js')
const {
  isPreviewInfraBlockedFindings,
  PREVIEW_INFRA_MARKER,
  PREVIEW_INFRA_RESURRECT_CAP,
  ensurePreviewInfraResurrectTable,
  countPreviewInfraResurrectAttempts,
  recordPreviewInfraResurrectAttempt,
  selectPreviewInfraBlockedCandidates,
  resurrectPreviewInfraBlockedObjectives,
} = await import('./preview-infra-resurrect.js')
const { PR_LINKAGE_REPO } = await import('./pr-linkage.js')

const REPO = PR_LINKAGE_REPO

function makeObjective(over: Partial<Objective> = {}): Objective {
  const db = getDb()
  const r = db
    .prepare(
      "INSERT INTO objectives (title, description, status, agent_context, workspace) VALUES (?, '', 'queue', 'cto', 'operator')",
    )
    .run(over.title ?? 'Test objective')
  const id = Number(r.lastInsertRowid)
  db.prepare(
    `UPDATE objectives SET
        status = ?, project = ?, type = ?, pr_url = ?, pr_number = ?,
        ai_review_verdict = ?, blocked_reason = ?
      WHERE id = ?`,
  ).run(
    over.status ?? 'review',
    over.project ?? 'operationkit',
    over.type ?? 'project',
    over.pr_url ?? `https://github.com/${REPO}/pull/${over.pr_number ?? 1}`,
    over.pr_number ?? 1,
    over.ai_review_verdict ?? 'blocked',
    over.blocked_reason === undefined ? 'preview-infra' : over.blocked_reason,
    id,
  )
  return db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective
}

beforeAll(() => {
  initDb()
})

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM objectives')
  db.exec('DROP TABLE IF EXISTS preview_infra_resurrect_attempts')
})

describe('isPreviewInfraBlockedFindings', () => {
  it('matches findings that open with the exact marker', () => {
    expect(isPreviewInfraBlockedFindings(`${PREVIEW_INFRA_MARKER} pr-583.cc.example.com 502-bad-gateway`)).toBe(true)
  })

  it('tolerates leading whitespace', () => {
    expect(isPreviewInfraBlockedFindings(`  \n${PREVIEW_INFRA_MARKER} pr-1.cc.example.com timeout`)).toBe(true)
  })

  it('is false for ordinary blocked findings (no marker)', () => {
    expect(isPreviewInfraBlockedFindings('Could not log in — test credentials rejected.')).toBe(false)
  })

  it('is false for null/undefined/empty', () => {
    expect(isPreviewInfraBlockedFindings(null)).toBe(false)
    expect(isPreviewInfraBlockedFindings(undefined)).toBe(false)
    expect(isPreviewInfraBlockedFindings('')).toBe(false)
  })

  it('does not match the marker appearing mid-findings (only a LEADING marker counts)', () => {
    expect(isPreviewInfraBlockedFindings(`Login failed. ${PREVIEW_INFRA_MARKER} noted later.`)).toBe(false)
  })
})

describe('attempt counter', () => {
  it('starts at zero and increments per record', () => {
    const db = getDb()
    const obj = makeObjective({ pr_number: 10 })
    expect(countPreviewInfraResurrectAttempts(db, obj.id)).toBe(0)
    recordPreviewInfraResurrectAttempt(db, obj.id, 10, 'pr-10.cc.example.com', 'still-down')
    expect(countPreviewInfraResurrectAttempts(db, obj.id)).toBe(1)
    recordPreviewInfraResurrectAttempt(db, obj.id, 10, 'pr-10.cc.example.com', 'still-down')
    expect(countPreviewInfraResurrectAttempts(db, obj.id)).toBe(2)
  })

  it('is idempotent to call ensure twice (CREATE TABLE IF NOT EXISTS)', () => {
    const db = getDb()
    ensurePreviewInfraResurrectTable(db)
    ensurePreviewInfraResurrectTable(db)
  })
})

describe('selectPreviewInfraBlockedCandidates', () => {
  it('finds a review-status, blocked, preview-infra-reason, same-repo objective', () => {
    const db = getDb()
    const obj = makeObjective({ pr_number: 20 })
    const rows = selectPreviewInfraBlockedCandidates(db, REPO)
    expect(rows.map(r => r.id)).toContain(obj.id)
  })

  it('excludes a blocked objective with a non-infra blocked_reason', () => {
    const db = getDb()
    makeObjective({ pr_number: 21, blocked_reason: null })
    const rows = selectPreviewInfraBlockedCandidates(db, REPO)
    expect(rows.length).toBe(0)
  })

  it('excludes a pass-verdict objective even if blocked_reason is somehow set', () => {
    const db = getDb()
    makeObjective({ pr_number: 22, ai_review_verdict: 'pass' })
    const rows = selectPreviewInfraBlockedCandidates(db, REPO)
    expect(rows.length).toBe(0)
  })

  it('excludes an objective from a different repo', () => {
    const db = getDb()
    makeObjective({ pr_number: 23, pr_url: 'https://github.com/Some-Org/other-repo/pull/23', project: 'other-repo' })
    const rows = selectPreviewInfraBlockedCandidates(db, REPO)
    expect(rows.length).toBe(0)
  })
})

describe('resurrectPreviewInfraBlockedObjectives', () => {
  it('resurrects to working on a healthy probe, spawning a fresh session', async () => {
    const db = getDb()
    const obj = makeObjective({ pr_number: 30, status: 'review' })
    let startedWith: Objective | null = null
    const decisions = await resurrectPreviewInfraBlockedObjectives(
      db,
      {
        probe: async () => ({ ok: true, httpCode: 200 }),
        startWorkingSession: async (o) => {
          startedWith = o
          return 'sess-recovered-1'
        },
      },
      REPO,
    )
    expect(decisions).toEqual([{ objectiveId: obj.id, prNumber: 30, host: 'pr-30.cc.example.com', outcome: 'resurrected' }])
    expect((startedWith as unknown as Objective | null)?.id).toBe(obj.id)
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
    expect(updated.status).toBe('working')
    expect(updated.session_id).toBe('sess-recovered-1')
    expect(countPreviewInfraResurrectAttempts(db, obj.id)).toBe(1)
  })

  it('leaves the objective alone and counts the attempt when the probe is still unhealthy', async () => {
    const db = getDb()
    const obj = makeObjective({ pr_number: 31, status: 'review' })
    let started = false
    const decisions = await resurrectPreviewInfraBlockedObjectives(
      db,
      {
        probe: async () => ({ ok: false, httpCode: 502 }),
        startWorkingSession: async () => { started = true; return 'sess-x' },
      },
      REPO,
    )
    expect(decisions).toEqual([{ objectiveId: obj.id, prNumber: 31, host: 'pr-31.cc.example.com', outcome: 'still-down' }])
    expect(started).toBe(false)
    const unchanged = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
    expect(unchanged.status).toBe('review')
    expect(unchanged.ai_review_verdict).toBe('blocked')
    expect(countPreviewInfraResurrectAttempts(db, obj.id)).toBe(1)
  })

  it('stops probing once the per-PR cap is reached, without ever calling probe', async () => {
    const db = getDb()
    const obj = makeObjective({ pr_number: 32, status: 'review' })
    for (let i = 0; i < PREVIEW_INFRA_RESURRECT_CAP; i++) {
      recordPreviewInfraResurrectAttempt(db, obj.id, 32, 'pr-32.cc.example.com', 'still-down')
    }
    let probeCalled = false
    const decisions = await resurrectPreviewInfraBlockedObjectives(
      db,
      {
        probe: async () => { probeCalled = true; return { ok: true, httpCode: 200 } },
        startWorkingSession: async () => 'sess-should-not-run',
      },
      REPO,
    )
    expect(probeCalled).toBe(false)
    expect(decisions).toEqual([{ objectiveId: obj.id, prNumber: 32, host: 'pr-32.cc.example.com', outcome: 'cap-exhausted' }])
    const unchanged = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective
    expect(unchanged.status).toBe('review')
  })

  it('never throws when the probe fn itself rejects, and records probe-error', async () => {
    const db = getDb()
    const obj = makeObjective({ pr_number: 33, status: 'review' })
    const decisions = await resurrectPreviewInfraBlockedObjectives(
      db,
      {
        probe: async () => { throw new Error('ECONNRESET') },
        startWorkingSession: async () => 'sess-y',
      },
      REPO,
    )
    expect(decisions).toEqual([{ objectiveId: obj.id, prNumber: 33, host: 'pr-33.cc.example.com', outcome: 'probe-error' }])
    expect(countPreviewInfraResurrectAttempts(db, obj.id)).toBe(1)
  })

  it('skips the write if the objective changed state between select and resurrect (race with a human)', async () => {
    const db = getDb()
    const obj = makeObjective({ pr_number: 34, status: 'review' })
    let started = false
    const decisions = await resurrectPreviewInfraBlockedObjectives(
      db,
      {
        probe: async () => {
          // Simulate a human reopening the card mid-probe.
          db.prepare("UPDATE objectives SET status = 'working', ai_review_verdict = NULL WHERE id = ?").run(obj.id)
          return { ok: true, httpCode: 200 }
        },
        startWorkingSession: async () => { started = true; return 'sess-z' },
      },
      REPO,
    )
    expect(started).toBe(false)
    expect(decisions).toEqual([])
  })
})
