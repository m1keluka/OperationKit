import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// obj 900510 — the startup sweep (state-poller.ts) used to flip a 'working'
// objective straight to 'review' with NO call to the usage-extraction pipeline,
// so a session that died in the gap of a backend restart (self-deploy is this
// project's own normal workflow) landed in review with total_tokens=0, $0 cost,
// and no last_session_summary — indistinguishable from a legitimate pending
// human review. sweepZeroTokenReview is the backstop: any row that is already in
// `review` carrying that all-zero signature gets a visible `blocked` verdict
// instead of silence, regardless of which code path produced it.

// SAFETY: bind the DB to a per-process temp FILE BEFORE importing db/index.
const TMP_DB = path.join(os.tmpdir(), `cc-zerotoken-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { selectZeroTokenReviewCandidates, applyZeroTokenReviewBlock } = await import('./poller-hygiene.js')

function seedObjective(overrides: Partial<{
  status: string
  total_tokens: number
  total_cost_usd: number
  last_session_summary: string | null
  ai_review_verdict: string | null
  delegate_mode: number
  session_id: string | null
}>): number {
  const o = {
    status: 'review',
    total_tokens: 0,
    total_cost_usd: 0,
    last_session_summary: null,
    ai_review_verdict: null,
    delegate_mode: 0,
    session_id: 'cc-zt-1',
    ...overrides,
  }
  const r = getDb().prepare(
    `INSERT INTO objectives
       (title, agent_context, workspace, status, session_id, total_tokens, total_cost_usd,
        last_session_summary, ai_review_verdict, delegate_mode)
     VALUES ('zero-token victim', 'cto', 'example', ?, ?, ?, ?, ?, ?, ?)`
  ).run(o.status, o.session_id, o.total_tokens, o.total_cost_usd, o.last_session_summary, o.ai_review_verdict, o.delegate_mode)
  return Number(r.lastInsertRowid)
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
afterAll(() => {
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})
beforeEach(() => { getDb().prepare('DELETE FROM objectives').run() })

describe('selectZeroTokenReviewCandidates', () => {
  it('matches a review row with 0 tokens, $0 cost, no summary, no verdict', () => {
    const id = seedObjective({})
    const rows = selectZeroTokenReviewCandidates(getDb())
    expect(rows.map(r => r.id)).toContain(id)
  })

  it('does NOT match a row that has real tokens recorded', () => {
    const id = seedObjective({ total_tokens: 12345 })
    const rows = selectZeroTokenReviewCandidates(getDb())
    expect(rows.map(r => r.id)).not.toContain(id)
  })

  it('does NOT match a row that has a summary even with 0 tokens (e.g. a pure-answer card)', () => {
    const id = seedObjective({ last_session_summary: 'Answered the question, no tools needed.' })
    const rows = selectZeroTokenReviewCandidates(getDb())
    expect(rows.map(r => r.id)).not.toContain(id)
  })

  it('does NOT match a row that already has a verdict (idempotent — never re-touches)', () => {
    const id = seedObjective({ ai_review_verdict: 'pass' })
    const rows = selectZeroTokenReviewCandidates(getDb())
    expect(rows.map(r => r.id)).not.toContain(id)
  })

  it('does NOT match a delegator (orchestration is its deliverable, not tokens)', () => {
    const id = seedObjective({ delegate_mode: 1 })
    const rows = selectZeroTokenReviewCandidates(getDb())
    expect(rows.map(r => r.id)).not.toContain(id)
  })

  it('does NOT match a working (not yet review) objective', () => {
    const id = seedObjective({ status: 'working' })
    const rows = selectZeroTokenReviewCandidates(getDb())
    expect(rows.map(r => r.id)).not.toContain(id)
  })
})

describe('applyZeroTokenReviewBlock', () => {
  it('stamps a visible blocked verdict + reason on a matching row', () => {
    const id = seedObjective({})
    applyZeroTokenReviewBlock(getDb())
    const row = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as { ai_review_verdict: string | null; ai_review_findings: string | null }
    expect(row.ai_review_verdict).toBe('blocked')
    expect(row.ai_review_findings).toMatch(/0 recorded tokens/)
  })

  it('is a no-op for a genuinely reviewed row', () => {
    const id = seedObjective({ total_tokens: 500, total_cost_usd: 0.01, last_session_summary: 'Did real work.' })
    applyZeroTokenReviewBlock(getDb())
    const row = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as { ai_review_verdict: string | null }
    expect(row.ai_review_verdict).toBeNull()
  })

  it('logs an activity_log row for the block (operator visibility)', () => {
    seedObjective({})
    applyZeroTokenReviewBlock(getDb())
    const log = getDb().prepare("SELECT * FROM activity_log WHERE event_type = 'milestone' AND title = 'zero_token_review_blocked'").get()
    expect(log).toBeTruthy()
  })
})
