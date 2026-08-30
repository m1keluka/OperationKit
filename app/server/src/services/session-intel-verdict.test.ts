import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { buildSummaryPrompt } from './session-intel-summary.js'
import type { DeterministicIntel } from './session-intel-parse.js'
import type { Objective } from '@operationkit/shared'

// Regression coverage for the 06-20 verdict-grounded-summarizer fix (obj 913,
// re-landed by obj 2162). The bug: generateSummary never received the review's
// authoritative verdict, so the isReview block forced outcome=success and the
// model free-generated a narrative off the build-heavy objective.description —
// inverting a FAIL verdict into a success story (obj 2066) and, with nothing
// pinning it to the verdict, leaking pass→failed the other way (obj 2079).

const intel: DeterministicIntel = {
  filesCreated: [],
  filesModified: [],
  commandsRun: 0,
  toolCalls: 3,
  errors: [],
  exitCode: 0,
  totalTokens: 0,
  totalCost: 0,
  startedAt: '2026-06-27T00:00:00Z',
  endedAt: '2026-06-27T00:00:42Z',
  durationMs: 42000,
  skillsUsed: [],
  agentsInvoked: [],
  subagentsSpawned: [],
  modelUsage: {},
  dailyUsage: [],
  truncatedByUsageLimit: false,
}

// A build-heavy description is exactly what tricked the summarizer into
// narrating a fail as "provisioned … all requirements met".
const objective = {
  id: 2066,
  title: 'Provision shared non-prod Supabase test DB',
  description:
    'Provision a shared non-prod Supabase cloud test database, fully migrated with schema parity, and verify all six deliverable requirements are met.',
} as unknown as Objective

describe('buildSummaryPrompt — verdict grounding for review sessions', () => {
  it('a FAIL verdict pins the summary to "did not meet" and forbids a success narrative', () => {
    const p = buildSummaryPrompt(intel, objective, true, 'fail')
    expect(p).toContain('THE REVIEWER\'S AUTHORITATIVE VERDICT FOR THIS SESSION WAS: "fail"')
    expect(p).toContain('DID NOT meet the acceptance criteria')
    expect(p).toContain('This verdict is ground truth')
    // The exact inversion phrasing the bug produced must be actively disallowed.
    expect(p).toContain('Do NOT describe the underlying work as accomplished')
  })

  it('a PASS verdict states the criteria were met', () => {
    const p = buildSummaryPrompt(intel, objective, true, 'pass')
    expect(p).toContain('WAS: "pass"')
    expect(p).toContain('MET the criteria')
  })

  it('with no verdict (null) the grounding block is absent — old behavior preserved', () => {
    const p = buildSummaryPrompt(intel, objective, true, null)
    expect(p).not.toContain('AUTHORITATIVE VERDICT')
    // The pre-existing isReview guidance still stands.
    expect(p).toContain('This is an AI-REVIEW session')
  })

  it('non-review sessions never get review guidance regardless of verdict', () => {
    const p = buildSummaryPrompt(intel, objective, false, null)
    expect(p).not.toContain('This is an AI-REVIEW session')
    expect(p).not.toContain('AUTHORITATIVE VERDICT')
  })
})

describe('verdict lookup SQL — exactly what the call site runs', () => {
  // Mirrors the query added at the extraction call site: pick the latest
  // iteration's verdict, mapping only pass/fail/blocked (pending → null).
  const SQL =
    'SELECT verdict FROM objective_reviews WHERE objective_id = ? ORDER BY iteration DESC LIMIT 1'

  function setup() {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE objective_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      objective_id INTEGER NOT NULL,
      iteration INTEGER NOT NULL,
      verdict TEXT NOT NULL CHECK(verdict IN ('pass','fail','blocked','pending'))
    );`)
    return db
  }

  function lookup(db: Database.Database, oid: number): 'pass' | 'fail' | 'blocked' | null {
    const v = db.prepare(SQL).get(oid) as { verdict?: string } | undefined
    if (v?.verdict === 'pass' || v?.verdict === 'fail' || v?.verdict === 'blocked') return v.verdict
    return null
  }

  it('returns the latest iteration verdict — a fail review resolves to "fail" (obj 2066 shape)', () => {
    const db = setup()
    db.prepare('INSERT INTO objective_reviews (objective_id, iteration, verdict) VALUES (?,?,?)').run(2066, 1, 'fail')
    db.prepare('INSERT INTO objective_reviews (objective_id, iteration, verdict) VALUES (?,?,?)').run(2066, 2, 'fail')
    expect(lookup(db, 2066)).toBe('fail')
    db.close()
  })

  it('a later PASS iteration wins over an earlier FAIL', () => {
    const db = setup()
    db.prepare('INSERT INTO objective_reviews (objective_id, iteration, verdict) VALUES (?,?,?)').run(2079, 1, 'fail')
    db.prepare('INSERT INTO objective_reviews (objective_id, iteration, verdict) VALUES (?,?,?)').run(2079, 2, 'pass')
    expect(lookup(db, 2079)).toBe('pass')
    db.close()
  })

  it('a pending verdict resolves to null (grounding block omitted)', () => {
    const db = setup()
    db.prepare('INSERT INTO objective_reviews (objective_id, iteration, verdict) VALUES (?,?,?)').run(999, 1, 'pending')
    expect(lookup(db, 999)).toBeNull()
    db.close()
  })

  it('no review rows → null', () => {
    const db = setup()
    expect(lookup(db, 12345)).toBeNull()
    db.close()
  })
})

// End-to-end proof that the fix closes the exact 2066 inversion: a fail verdict
// on a build-heavy objective yields a prompt that (a) names the fail verdict as
// ground truth and (b) forbids the "was provisioned / all requirements met"
// narrative the bug produced.
describe('closes the obj-2066 inversion', () => {
  it('fail verdict prompt cannot license a "provisioned / requirements met" story', () => {
    const p = buildSummaryPrompt(intel, objective, true, 'fail')
    expect(p).toContain('a fail means it was not')
    expect(p).toContain('the verdict wins')
  })
})
