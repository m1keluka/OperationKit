import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// obj 79 — the OVH #59 / #64 bug end to end through the REAL poll loop:
// a jailed worker (SESSION_ISOLATION=docker) must stay `working` WITH its
// session_id while its jail runs, and move on only when the jail session
// actually finishes. Before the fix the first poll after spawn saw no host tmux,
// recorded "ended on account", flipped the card to review and nulled session_id.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jail-lifecycle-'))
const JAIL_HOMES = path.join(DIR, 'jail-homes')
const TRANSCRIPTS = path.join(DIR, 'transcripts')
fs.mkdirSync(JAIL_HOMES, { recursive: true })
fs.mkdirSync(TRANSCRIPTS, { recursive: true })
process.env.CC_JAIL_HOME_ROOT = JAIL_HOMES
process.env.TRANSCRIPT_DIR = TRANSCRIPTS
process.env.DB_PATH = path.join(DIR, 'test.db')

// No host tmux server and no gh/git: every shell-out fails fast, like a jail host.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execSync: vi.fn(() => { throw new Error('not available in test') }),
  }
})
vi.mock('../ws/index.js', () => ({ broadcast: vi.fn() }))

const deaths: string[] = []
const starts: number[] = []
vi.mock('./session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./session-manager.js')>()
  return {
    ...actual,
    // recordSessionEnd / lease release live behind this — count calls instead.
    handleSessionDeath: vi.fn((sid: string) => {
      deaths.push(sid)
      return { limitHit: false, spendCapHit: false, overloaded: false, turnsExhausted: false, authFailed: false, authReason: null, toolCalls: 1, accountId: null }
    }),
    startSession: vi.fn(async (o: { id: number }) => { starts.push(o.id); return `cc-${o.id}-respawn` }),
    spawnReviewerSession: vi.fn(async () => 'cc-review-x'),
    sendFollowUp: vi.fn(async () => undefined),
    sweepOrphanWorkerTmux: vi.fn(),
  }
})
vi.mock('./session-intel-pipeline.js', () => ({ queueExtraction: vi.fn() }))

const { initDb, getDb } = await import('../db/index.js')
const tmux = await import('./session-tmux.js')
const { pollActiveSessions } = await import('./poller-loop.js')

const J = (o: unknown) => JSON.stringify(o)
const toolUse = J({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } })
const answerOnly = J({ type: 'assistant', message: { content: [{ type: 'text', text: 'The answer is 42.' }] } })
const resultOk = (text = 'done') => J({ type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: 120_000, session_id: 's', uuid: `r-${text}` })

function jailTranscript(sid: string, lines: string[]): void {
  const dir = path.join(JAIL_HOMES, sid, '.cc')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `${sid}.jsonl`)
  fs.writeFileSync(p, lines.join('\n') + '\n')
  const canonical = path.join(TRANSCRIPTS, `${sid}.jsonl`)
  fs.rmSync(canonical, { force: true })
  fs.symlinkSync(p, canonical)
}

function seedWorking(sid: string): number {
  const r = getDb().prepare(
    `INSERT INTO objectives (title, agent_context, workspace, status, session_id, type, create_pr, skip_ai_review)
     VALUES ('jail card', 'general', 'example', 'working', ?, 'task', 0, 1)`,
  ).run(sid)
  return Number(r.lastInsertRowid)
}
const row = (id: number) =>
  getDb().prepare('SELECT status, session_id FROM objectives WHERE id = ?').get(id) as { status: string; session_id: string | null }

let running = new Set<string>()
let dockerFails = false

beforeAll(() => {
  initDb()
  tmux.__setJailPsRunnerForTests(() => {
    if (dockerFails) throw new Error('Cannot connect to the Docker daemon')
    return [...running].join('\n')
  })
})
afterAll(() => {
  tmux.__setJailPsRunnerForTests(null)
  try { getDb().close() } catch {}
  fs.rmSync(DIR, { recursive: true, force: true })
})
beforeEach(() => {
  process.env.SESSION_ISOLATION = 'docker'
  running = new Set()
  dockerFails = false
  deaths.length = 0
  starts.length = 0
  tmux.resetTmuxListCache()
  getDb().prepare('DELETE FROM objectives').run()
})
afterEach(() => { delete process.env.SESSION_ISOLATION })

describe('jailed worker through pollActiveSessions', () => {
  it('stays working with its session_id while the jail runs; moves to review only after it finishes', async () => {
    const sid = 'cc-59-100'
    jailTranscript(sid, [toolUse])
    running.add(sid)
    const id = seedWorking(sid)

    await pollActiveSessions()
    expect(row(id)).toEqual({ status: 'working', session_id: sid })
    expect(deaths).toEqual([]) // no "ended on account", no lease release

    // A transient docker failure mid-run must not end it either.
    dockerFails = true
    tmux.resetTmuxListCache()
    await pollActiveSessions()
    expect(row(id)).toEqual({ status: 'working', session_id: sid })
    expect(deaths).toEqual([])

    // The jail session finishes: result written, container exits.
    dockerFails = false
    jailTranscript(sid, [toolUse, resultOk()])
    running.delete(sid)
    tmux.resetTmuxListCache()
    await pollActiveSessions()
    expect(row(id).status).toBe('review')
    expect(deaths).toEqual([sid]) // completion handling ran exactly once
    expect(starts).toEqual([])    // and it was not mistaken for a no-op spawn
  })

  it('an answer-only jailed session (0 tool calls) completes to review — no noop_respawn', async () => {
    const sid = 'cc-64-200'
    jailTranscript(sid, [answerOnly, resultOk('The answer is 42.')])
    const id = seedWorking(sid)

    await pollActiveSessions()
    expect(row(id).status).toBe('review')
    expect(starts).toEqual([]) // never re-spawned
    const log = getDb().prepare("SELECT title FROM activity_log WHERE objective_id = ? AND title LIKE 'noop_spawn%'").all(id)
    expect(log).toEqual([])
  })

  it('a jailed spawn that produced nothing is still treated as a no-op spawn (re-spawned)', async () => {
    const sid = 'cc-64-300'
    jailTranscript(sid, [J({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '', session_id: 's', uuid: 'e1' })])
    const id = seedWorking(sid)

    await pollActiveSessions()
    expect(starts).toEqual([id])
  })
})
