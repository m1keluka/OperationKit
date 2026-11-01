// obj 64 (Part A) — integration: sendFollowUp's respawn path honours the
// resumed-session history cap. Under the cap it natively resumes (`--resume`);
// at/over it, it spawns a FRESH session seeded with the DB summary, writes the
// chain-reset marker, records `fresh_seeded_after_cap` in session_starts, mirrors
// it onto the card (objectives.last_start_reason) and logs an activity row.
// Spawn/seat layers are mocked; the DB, prompt assembly and cap logic are real.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-resume-cap-int-'))
const TRANSCRIPTS = path.join(TMP, 'transcripts')
const SEAT_HOME = path.join(TMP, 'seat-home')
const WORKDIR = path.join(TMP, 'workdir')
fs.mkdirSync(TRANSCRIPTS, { recursive: true })
fs.mkdirSync(WORKDIR, { recursive: true })
process.env.DB_PATH = path.join(TMP, 'test.db')
process.env.TRANSCRIPT_DIR = TRANSCRIPTS
delete process.env.CC_RESUME_CAP_TOKENS
delete process.env.CC_RESUME_CAP_ROUNDS
delete process.env.CC_RESUME_CAP_ENABLED

const spawnInTmux = vi.fn((_opts: Record<string, unknown>) => 'tmux-test')
vi.mock('./session-tmux.js', () => ({ spawnInTmux: (o: Record<string, unknown>) => spawnInTmux(o) }))

const SEAT = { id: 'seat-1', label: 'Seat 1', homeDir: SEAT_HOME, activeSessions: [] as string[] }
vi.mock('./account-router.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordSessionStart: () => {},
  enqueueSession: () => {},
  getAccountForSession: () => null,
  getRouterStatus: () => ({ accounts: [{ ...SEAT, available: true }], queue: [], earliestReset: null }),
  chooseFollowUpAccount: () => ({ account: SEAT, rerouted: false }),
  getAccountById: () => SEAT,
  seatCount: () => 1,
}))
vi.mock('./seat-pool.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), seatKind: () => 'claude' }))
vi.mock('./seat-assign.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordSessionSeat: () => {},
  seatSignIn: () => ({ env: {}, mount: null }),
}))
vi.mock('./session-manager.js', () => {
  class BranchLeaseConflictError extends Error {}
  class SessionLeaseConflictError extends Error {}
  return {
    startSession: vi.fn(),
    ensureUser: () => {},
    ensureObjectiveMemoryDir: () => {},
    reapPredecessorSessions: () => {},
    emitSessionLeaseConflictWarning: () => {},
    BranchLeaseConflictError,
    SessionLeaseConflictError,
  }
})
vi.mock('./prompt-builder.js', async () => {
  const hist = await import('./prompt-builder-history.js')
  return {
    buildPrompt: () => 'BASE PROMPT',
    buildObjectiveHistory: () => 'FULL FLATTENED HISTORY',
    assembleFlattenedFollowUpPrompt: hist.assembleFlattenedFollowUpPrompt,
    resolveWorkdir: () => WORKDIR,
  }
})
vi.mock('./session-worktree.js', () => ({
  computeIsolation: () => null,
  ensureWorktree: () => null,
  ensureWorktreeHookAssets: () => undefined,
}))
vi.mock('./session-spawn-env.js', () => ({ buildSpawnEnv: () => ({}) }))
vi.mock('./session-control.js', () => ({ isSessionActive: () => false }))
vi.mock('./objective-session-claim.js', () => ({ claimObjectiveSession: () => ({ outcome: 'claimed' }) }))

const { initDb, getDb } = await import('../db/index.js')
const { sendFollowUp } = await import('./session-followup.js')
const { logSessionStart, noteStartReason } = await import('./session-start-reasons.js')
const { activeSessions } = await import('./session-registry.js')

const CLAUDE_ID = 'claude-conv-1'

function makeCard(): { id: number; sessionId: string; jsonl: string } {
  const db = getDb()
  const id = Number(
    db
      .prepare(
        `INSERT INTO objectives (title, description, completion_goal, status, workspace, agent_context, last_session_summary, pr_url, branch_name)
         VALUES ('Long card', 'Do the long thing.', 'Long thing done', 'working', 'example', 'general', 'Half way there.', 'https://github.com/o/r/pull/9', 'cc/obj-long')`,
      )
      .run().lastInsertRowid,
  )
  const sessionId = `cc-${id}-1000`
  const jsonl = path.join(TRANSCRIPTS, `${sessionId}.jsonl`)
  fs.writeFileSync(jsonl, JSON.stringify({ type: 'system', subtype: 'init', session_id: CLAUDE_ID }) + '\n')
  db.prepare('UPDATE objectives SET session_id = ? WHERE id = ?').run(sessionId, id)
  db.prepare(
    "INSERT INTO session_runtime (session_id, claude_session_id, account_id, updated_at) VALUES (?, ?, 'seat-1', datetime('now'))",
  ).run(sessionId, CLAUDE_ID)
  return { id, sessionId, jsonl }
}

function addResultTokens(jsonl: string, tokens: number): void {
  fs.appendFileSync(jsonl, JSON.stringify({ type: 'result', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: tokens }, total_cost_usd: 0 }) + '\n')
}

function objective(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never
}

beforeAll(() => {
  initDb()
  // A resumable transcript for the claude conversation, recorded under WORKDIR
  // (claudeConversationExists is cwd-scoped).
  const proj = path.join(SEAT_HOME, '.claude', 'projects', 'p')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, `${CLAUDE_ID}.jsonl`), JSON.stringify({ cwd: WORKDIR }) + '\n')
})
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})
beforeEach(() => {
  spawnInTmux.mockClear()
  activeSessions.clear()
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'resume_cap_%'").run()
})

describe('sendFollowUp + resume cap', () => {
  it('under the cap: native --resume, plain follow-up text, no marker', () => {
    const { id, sessionId, jsonl } = makeCard()
    addResultTokens(jsonl, 39_999_999)
    sendFollowUp(sessionId, 'keep going', objective(id))
    const opts = spawnInTmux.mock.calls[0][0]
    expect(opts.resumeSessionId).toBe(CLAUDE_ID)
    expect(opts.prompt).toBe('keep going')
    expect(fs.readFileSync(jsonl, 'utf-8')).not.toContain('chain_reset')
    const row = getDb().prepare('SELECT kind, reason FROM session_starts WHERE session_id = ? ORDER BY id DESC').get(sessionId)
    expect(row).toMatchObject({ kind: 'resume' })
  })

  it('at the token cap: fresh session seeded with the DB summary, start reason + card + activity recorded', () => {
    const { id, sessionId, jsonl } = makeCard()
    addResultTokens(jsonl, 25_000_000)
    addResultTokens(jsonl, 15_000_000) // = 40M exactly → capped
    noteStartReason(id, 'ai_review_fail', 'reviewer')
    sendFollowUp(sessionId, 'fix the review findings', objective(id))

    const opts = spawnInTmux.mock.calls[0][0]
    expect(opts.resumeSessionId).toBeUndefined()
    const prompt = String(opts.prompt)
    expect(prompt.startsWith('BASE PROMPT')).toBe(true)
    expect(prompt).toContain('<card_summary>')
    expect(prompt).toContain(`#${id} — Long card`)
    expect(prompt).toContain('Branch: cc/obj-long')
    expect(prompt).toContain('Half way there.')
    expect(prompt).not.toContain('FULL FLATTENED HISTORY')
    expect(prompt.trimEnd().endsWith('fix the review findings')).toBe(true)

    expect(fs.readFileSync(jsonl, 'utf-8')).toContain('"type":"chain_reset"')

    const start = getDb()
      .prepare('SELECT kind, reason, actor, detail FROM session_starts WHERE session_id = ? ORDER BY id DESC')
      .get(sessionId) as { kind: string; reason: string; actor: string; detail: string }
    expect(start).toMatchObject({ kind: 'spawn', reason: 'fresh_seeded_after_cap', actor: 'reviewer' })
    expect(start.detail).toContain('trigger=tokens')
    expect(start.detail).toContain('wake=ai_review_fail')

    const card = getDb().prepare('SELECT last_start_reason, last_start_at FROM objectives WHERE id = ?').get(id) as { last_start_reason: string; last_start_at: string }
    expect(card.last_start_reason).toBe('fresh_seeded_after_cap')
    expect(card.last_start_at).toBeTruthy()

    const act = getDb().prepare("SELECT event_type, objective_id FROM activity_log WHERE event_type = 'decision' AND json_extract(metadata, '$.kind') = 'resume_capped' AND objective_id = ?").get(id)
    expect(act).toBeTruthy()
  })

  it('after a capped restart the old over-cap conversation is never resumed again', () => {
    const { id, sessionId, jsonl } = makeCard()
    addResultTokens(jsonl, 50_000_000)
    sendFollowUp(sessionId, 'one', objective(id))
    expect(spawnInTmux.mock.calls[0][0].resumeSessionId).toBeUndefined()
    // The fresh process died before emitting init; runtime row still names the old conversation.
    activeSessions.clear()
    sendFollowUp(sessionId, 'two', objective(id))
    const second = spawnInTmux.mock.calls[1][0]
    expect(second.resumeSessionId).toBeUndefined()
    expect(String(second.prompt)).toContain('FULL FLATTENED HISTORY') // under cap again → normal fallback, not the 50M resume
  })

  it('round cap (setting resume_cap_rounds=3): resumes until 3 prior resumes, then starts fresh', () => {
    const { id, sessionId } = makeCard()
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('resume_cap_rounds', '3')").run()
    for (let i = 0; i < 2; i++) logSessionStart(getDb(), { objectiveId: id, sessionId, kind: 'resume', reason: { reason: 'follow_up' } })
    sendFollowUp(sessionId, 'r3', objective(id)) // 2 prior resumes < 3 → resume
    expect(spawnInTmux.mock.calls[0][0].resumeSessionId).toBe(CLAUDE_ID)
    activeSessions.clear()
    sendFollowUp(sessionId, 'r4', objective(id)) // 3 prior resumes ≥ 3 → fresh
    expect(spawnInTmux.mock.calls[1][0].resumeSessionId).toBeUndefined()
    const start = getDb().prepare('SELECT reason, detail FROM session_starts WHERE session_id = ? ORDER BY id DESC').get(sessionId) as { reason: string; detail: string }
    expect(start.reason).toBe('fresh_seeded_after_cap')
    expect(start.detail).toContain('trigger=rounds')
  })

  it('disabled via setting: an over-cap chain still resumes natively', () => {
    const { id, sessionId, jsonl } = makeCard()
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('resume_cap_enabled', '0')").run()
    addResultTokens(jsonl, 90_000_000)
    sendFollowUp(sessionId, 'go', objective(id))
    expect(spawnInTmux.mock.calls[0][0].resumeSessionId).toBe(CLAUDE_ID)
  })
})
