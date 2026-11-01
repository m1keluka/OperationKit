// obj 64 (Part A) — resumed-session history cap: config, threshold boundary,
// chain measurement, and the deterministic seeded summary.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-resume-cap-'))
process.env.DB_PATH = path.join(TMP, 'test.db')

const { initDb, getDb } = await import('../db/index.js')
const rc = await import('./resume-cap.js')
const { logSessionStart } = await import('./session-start-reasons.js')

const CFG = { enabled: true, tokens: 40_000_000, rounds: 12 }

function result(tokens: number): string {
  return JSON.stringify({ type: 'result', usage: { input_tokens: tokens, output_tokens: 0 }, total_cost_usd: 0 })
}

beforeAll(() => {
  initDb()
})
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})
beforeEach(() => {
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'resume_cap_%'").run()
})

describe('resolveResumeCapConfig', () => {
  it('defaults to 40M tokens / 12 rounds, enabled', () => {
    expect(rc.resolveResumeCapConfig(getDb(), {})).toEqual({ enabled: true, tokens: 40_000_000, rounds: 12 })
  })
  it('reads settings, and env overrides settings', () => {
    const db = getDb()
    db.prepare("INSERT INTO settings (key, value) VALUES ('resume_cap_tokens', '1000'), ('resume_cap_rounds', '3')").run()
    expect(rc.resolveResumeCapConfig(db, {})).toEqual({ enabled: true, tokens: 1000, rounds: 3 })
    expect(rc.resolveResumeCapConfig(db, { CC_RESUME_CAP_TOKENS: '5', CC_RESUME_CAP_ROUNDS: '7' })).toEqual({ enabled: true, tokens: 5, rounds: 7 })
  })
  it('can be disabled by setting or env; garbage values fall back to defaults', () => {
    const db = getDb()
    db.prepare("INSERT INTO settings (key, value) VALUES ('resume_cap_enabled', '0'), ('resume_cap_tokens', 'abc')").run()
    const cfg = rc.resolveResumeCapConfig(db, {})
    expect(cfg.enabled).toBe(false)
    expect(cfg.tokens).toBe(40_000_000)
    expect(rc.resolveResumeCapConfig(db, { CC_RESUME_CAP_ENABLED: '1' }).enabled).toBe(true)
  })
})

describe('decideResumeCap — threshold boundary', () => {
  it('tokens: one below the cap resumes, AT the cap is capped', () => {
    expect(rc.decideResumeCap({ tokens: 39_999_999, rounds: 0 }, CFG).capped).toBe(false)
    const d = rc.decideResumeCap({ tokens: 40_000_000, rounds: 0 }, CFG)
    expect(d).toMatchObject({ capped: true, trigger: 'tokens' })
  })
  it('rounds: 11 resumes resumes, 12 is capped (whichever comes first)', () => {
    expect(rc.decideResumeCap({ tokens: 10, rounds: 11 }, CFG).capped).toBe(false)
    expect(rc.decideResumeCap({ tokens: 10, rounds: 12 }, CFG)).toMatchObject({ capped: true, trigger: 'rounds' })
  })
  it('tokens trigger wins when both are over', () => {
    expect(rc.decideResumeCap({ tokens: 50_000_000, rounds: 20 }, CFG).trigger).toBe('tokens')
  })
  it('disabled config never caps; a 0 threshold disables just that trigger', () => {
    expect(rc.decideResumeCap({ tokens: 1e12, rounds: 1e6 }, { ...CFG, enabled: false }).capped).toBe(false)
    expect(rc.decideResumeCap({ tokens: 1e12, rounds: 1 }, { ...CFG, tokens: 0 }).capped).toBe(false)
    expect(rc.decideResumeCap({ tokens: 1, rounds: 1e6 }, { ...CFG, rounds: 0 }).capped).toBe(false)
  })
})

describe('chain measurement', () => {
  it('sums result-event tokens only AFTER the last chain_reset marker', () => {
    const before = [result(30_000_000), result(20_000_000)].join('\n')
    expect(rc.chainTokensFromContent(before + '\n')).toBe(50_000_000)
    const marker = JSON.stringify({ type: 'chain_reset', reason: 'fresh_seeded_after_cap' })
    expect(rc.chainTokensFromContent(`${before}\n${marker}\n${result(1_000)}\n`)).toBe(1_000)
    expect(rc.chainTokensFromContent(`${before}\n${marker}\n`)).toBe(0)
  })

  it('counts resumes of the session id after its last fresh-seeded start', () => {
    const db = getDb()
    const sid = 'cc-9001-1'
    for (let i = 0; i < 5; i++) logSessionStart(db, { objectiveId: 9001, sessionId: sid, kind: 'resume', reason: { reason: 'follow_up' } })
    logSessionStart(db, { objectiveId: 9001, sessionId: 'cc-9001-other', kind: 'resume', reason: { reason: 'follow_up' } })
    logSessionStart(db, { objectiveId: 9001, sessionId: sid, kind: 'attach', reason: { reason: 'follow_up' } })
    expect(rc.chainRounds(db, sid)).toBe(5)
    logSessionStart(db, { objectiveId: 9001, sessionId: sid, kind: 'spawn', reason: { reason: rc.FRESH_SEEDED_REASON } })
    expect(rc.chainRounds(db, sid)).toBe(0)
    logSessionStart(db, { objectiveId: 9001, sessionId: sid, kind: 'resume', reason: { reason: 'follow_up' } })
    expect(rc.chainRounds(db, sid)).toBe(1)
  })

  it('markChainReset + postResetSessionId: only the post-reset conversation is resumable', () => {
    const file = path.join(TMP, 'cc-9002-1.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'OLD' }) + '\n' + result(45_000_000) + '\n')
    expect(rc.postResetSessionId(file)).toBeUndefined()
    rc.markChainReset(file, rc.decideResumeCap({ tokens: 45_000_000, rounds: 0 }, CFG))
    expect(rc.postResetSessionId(file)).toBeNull()
    expect(rc.chainTokens(file)).toBe(0)
    fs.appendFileSync(file, JSON.stringify({ type: 'system', subtype: 'init', session_id: 'NEW' }) + '\n' + result(10) + '\n')
    expect(rc.postResetSessionId(file)).toBe('NEW')
    expect(rc.chainTokens(file)).toBe(10)
  })
})

describe('buildSeededSummary — deterministic, DB-only', () => {
  function seedCard(): number {
    const db = getDb()
    const id = Number(
      db
        .prepare(
          `INSERT INTO objectives (title, description, completion_goal, status, workspace, agent_context, last_session_summary,
             ai_review_verdict, ai_review_findings, pr_url, branch_name, needs_secret)
           VALUES ('Ship the widget', 'Build the widget end to end.', 'Widget merged and live', 'working', 'example', 'general',
             'Implemented API; UI half done.', 'fail', 'P1: missing tests for the API', 'https://github.com/o/r/pull/7',
             'cc/obj-widget', '[{"name":"STRIPE_KEY","reason":"payments"}]')`,
        )
        .run().lastInsertRowid,
    )
    db.prepare("INSERT INTO objectives (title, status, workspace, agent_context, parent_id) VALUES ('Write API tests', 'queue', 'example', 'general', ?)").run(id)
    db.prepare("INSERT INTO objectives (title, status, workspace, agent_context, parent_id) VALUES ('Design review', 'done', 'example', 'general', ?)").run(id)
    return id
  }

  it('carries goal, state, open TODOs, branch/PR, last review findings, last summary and task rows', () => {
    const id = seedCard()
    const s = rc.buildSeededSummary(getDb(), { id })
    expect(s).toContain(`#${id} — Ship the widget`)
    expect(s).toContain('Build the widget end to end.')
    expect(s).toContain('Widget merged and live')
    expect(s).toContain('Status: working')
    expect(s).toMatch(/## Open TODOs[\s\S]*\[queue\] Write API tests/)
    expect(s).toMatch(/## Open TODOs[\s\S]*address the last AI review \(verdict: fail\)/)
    expect(s).toContain('waiting on secret STRIPE_KEY')
    expect(s).not.toMatch(/## Open TODOs[^#]*Design review/)
    expect(s).toContain('Branch: cc/obj-widget')
    expect(s).toContain('PR: https://github.com/o/r/pull/7')
    expect(s).toContain('P1: missing tests for the API')
    expect(s).toContain('Implemented API; UI half done.')
    expect(s).toMatch(/## Task rows[\s\S]*\[done\] Design review/)
  })

  it('is deterministic (same rows → identical text) and clips huge fields', () => {
    const id = seedCard()
    getDb().prepare('UPDATE objectives SET last_session_summary = ? WHERE id = ?').run('x'.repeat(20_000), id)
    const a = rc.buildSeededSummary(getDb(), { id })
    const b = rc.buildSeededSummary(getDb(), { id })
    expect(a).toBe(b)
    expect(a).toContain('[truncated 16000 chars]')
    expect(a.length).toBeLessThan(12_000)
  })

  it('assembleSeededFollowUpPrompt wraps the seed and keeps the follow-up last', () => {
    const d = rc.decideResumeCap({ tokens: 41_000_000, rounds: 3 }, CFG)
    const p = rc.assembleSeededFollowUpPrompt('BASE', 'SEED', 'please continue', d)
    expect(p.startsWith('BASE')).toBe(true)
    expect(p).toContain('<card_summary>\nSEED\n</card_summary>')
    expect(p).toContain('41.0M tokens (cap 40.0M)')
    expect(p.trimEnd().endsWith('please continue')).toBe(true)
  })
})
