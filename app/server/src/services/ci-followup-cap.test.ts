import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-cifollowupcap-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const {
  checkCiFollowupCap,
  recordCiFollowup,
  noteCiFollowupCapExhausted,
  ciFollowupCapPerPr,
  ensureCiFollowupTable,
  DEFAULT_CI_FOLLOWUP_CAP,
} = await import('./ci-followup-cap.js')
const { applyGateHandback } = await import('./ci-green-gate.js')

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

const REPO = 'your-org/operationkit'
const NOW = new Date('2026-10-12T12:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000)

beforeEach(() => {
  const db = getDb()
  ensureCiFollowupTable(db)
  db.exec('DELETE FROM ci_followup_log')
  db.exec("DELETE FROM settings WHERE key = 'ci_followup_cap_per_pr'")
  db.exec("DELETE FROM objectives WHERE title LIKE 'capobj%'")
})

function insertObjective(id: number): void {
  getDb().prepare(`INSERT INTO objectives (id, title, status, session_id, project) VALUES (?, ?, 'working', ?, 'operationkit')`)
    .run(id, `capobj ${id}`, `cc-${id}-1`)
}

describe('ci-followup-cap', () => {
  it('defaults to a cap of 3', () => {
    expect(DEFAULT_CI_FOLLOWUP_CAP).toBe(3)
    expect(ciFollowupCapPerPr(getDb())).toBe(3)
  })

  it('allows while under the cap', () => {
    const db = getDb()
    const key = { repo: REPO, prNumber: 10, objectiveId: 1, source: 'ci-feedback-bridge', now: NOW }
    expect(checkCiFollowupCap(db, key)).toMatchObject({ allowed: true, count: 0, cap: 3 })
    recordCiFollowup(db, key)
    recordCiFollowup(db, key)
    expect(checkCiFollowupCap(db, key)).toMatchObject({ allowed: true, count: 2, cap: 3 })
  })

  it('blocks at the cap', () => {
    const db = getDb()
    const key = { repo: REPO, prNumber: 11, objectiveId: 1, source: 'ci-feedback-bridge', now: NOW }
    for (let i = 0; i < 3; i++) recordCiFollowup(db, key)
    expect(checkCiFollowupCap(db, key)).toMatchObject({ allowed: false, count: 3, cap: 3 })
  })

  it('counts across different sources for the same PR (repo case-insensitive)', () => {
    const db = getDb()
    recordCiFollowup(db, { repo: REPO, prNumber: 12, source: 'ci-feedback-bridge', now: NOW })
    recordCiFollowup(db, { repo: REPO.toLowerCase(), prNumber: 12, source: 'external-remediation', now: NOW })
    recordCiFollowup(db, { repo: REPO, prNumber: 12, source: 'ci-green-gate', now: NOW })
    const r = checkCiFollowupCap(db, { repo: REPO, prNumber: 12, source: 'pr-health-watchdog', now: NOW })
    expect(r).toMatchObject({ allowed: false, count: 3 })
  })

  it('keeps different PRs (and same number in different repos) independent', () => {
    const db = getDb()
    for (let i = 0; i < 3; i++) recordCiFollowup(db, { repo: REPO, prNumber: 13, source: 'ci-green-gate', now: NOW })
    expect(checkCiFollowupCap(db, { repo: REPO, prNumber: 13, source: 'x', now: NOW }).allowed).toBe(false)
    expect(checkCiFollowupCap(db, { repo: REPO, prNumber: 14, source: 'x', now: NOW })).toMatchObject({ allowed: true, count: 0 })
    expect(checkCiFollowupCap(db, { repo: 'EXAMPLE2/example3-platform', prNumber: 13, source: 'x', now: NOW })).toMatchObject({ allowed: true, count: 0 })
  })

  it('expires follow-ups older than the 30-day rolling window', () => {
    const db = getDb()
    recordCiFollowup(db, { repo: REPO, prNumber: 15, source: 'a', now: daysAgo(31) })
    recordCiFollowup(db, { repo: REPO, prNumber: 15, source: 'a', now: daysAgo(40) })
    recordCiFollowup(db, { repo: REPO, prNumber: 15, source: 'a', now: daysAgo(29) })
    recordCiFollowup(db, { repo: REPO, prNumber: 15, source: 'b', now: daysAgo(1) })
    expect(checkCiFollowupCap(db, { repo: REPO, prNumber: 15, source: 'a', now: NOW })).toMatchObject({ allowed: true, count: 2 })
  })

  it('honors settings.ci_followup_cap_per_pr and ignores garbage', () => {
    const db = getDb()
    for (let i = 0; i < 3; i++) recordCiFollowup(db, { repo: REPO, prNumber: 16, source: 'a', now: NOW })
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ci_followup_cap_per_pr', '5')").run()
    expect(checkCiFollowupCap(db, { repo: REPO, prNumber: 16, source: 'a', now: NOW })).toMatchObject({ allowed: true, count: 3, cap: 5 })
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'ci_followup_cap_per_pr'").run()
    expect(checkCiFollowupCap(db, { repo: REPO, prNumber: 16, source: 'a', now: NOW })).toMatchObject({ allowed: false, cap: 1 })
    db.prepare("UPDATE settings SET value = 'nope' WHERE key = 'ci_followup_cap_per_pr'").run()
    expect(ciFollowupCapPerPr(db)).toBe(3)
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'ci_followup_cap_per_pr'").run()
    expect(ciFollowupCapPerPr(db)).toBe(3)
  })

  it('noteCiFollowupCapExhausted escalates ONCE per PR (activity_log + has_blockers)', () => {
    const db = getDb()
    insertObjective(990001)
    const key = { repo: REPO, prNumber: 17, objectiveId: 990001, source: 'ci-green-gate', now: NOW }
    expect(noteCiFollowupCapExhausted(db, key, { count: 3, cap: 3 })).toBe(true)
    expect(noteCiFollowupCapExhausted(db, key, { count: 3, cap: 3 })).toBe(false)
    const logs = db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE objective_id = 990001 AND event_type = 'blocker'").get() as { n: number }
    expect(logs.n).toBe(1)
    const row = db.prepare('SELECT has_blockers FROM objectives WHERE id = 990001').get() as { has_blockers: number }
    expect(row.has_blockers).toBe(1)
    // 'blocked' notes never count toward the sent cap
    expect(checkCiFollowupCap(db, key).count).toBe(0)
  })
})

describe('ci-green-gate handback consults the shared cap', () => {
  const holdResult = (prNumber: number) => ({
    decision: {
      action: 'hold' as const, reason: 'red', failingRequired: ['gate'], missingRequired: [], advisoryRed: [],
      requiredChecks: ['gate'], requiredSource: 'ruleset' as const, holdCount: 1, waitedMinutes: 0,
    },
    blocked: true, handback: 'CI is red: gate', repo: REPO, prNumber, prUrl: null,
  })

  it('respawns under the cap and records it; parks in review (no respawn) once at cap', () => {
    const db = getDb()
    insertObjective(990002)
    const obj = { id: 990002, pr_number: 18, session_id: 'cc-990002-1' }
    let sends = 0
    const deps = { sendFollowUp: () => { sends++; return `cc-990002-${sends + 1}` } }
    for (let i = 0; i < 3; i++) {
      db.prepare("UPDATE objectives SET status = 'working' WHERE id = 990002").run()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(applyGateHandback(db, obj, holdResult(18) as any, deps)).toBe('working')
    }
    expect(sends).toBe(3)
    db.prepare("UPDATE objectives SET status = 'working' WHERE id = 990002").run()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(applyGateHandback(db, obj, holdResult(18) as any, deps)).toBe('review')
    expect(sends).toBe(3)
  })
})
