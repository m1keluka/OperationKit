import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 900547 — ONE follow-up to a card in review / blocked / working-with-a-dead
// worker must wake it the first time. The route flips the card to `working`,
// answers, and respawns on the next tick. In that window the card is `working`
// with no live process and a transcript whose last turn ended in `result`, so
// the poller's getSessionState read 'review': it routed the card straight back
// to review and ran the death cleanup on the session being respawned (jail mode:
// deleting the HOME the new run writes into). The message showed in the thread,
// the card never visibly started, and the owner had to send it again (card
// #900412, 2026-11-10: follow_up starts at 17:21:34, 17:30:30, 17:31:26, 17:31:32
// with no new transcript output). The poll loop skips any session in
// `overloadRetryPending`; the route must hold the session there until its spawn
// has returned, and release it afterwards.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-msgwake-test-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-msgwake'
process.env.TRANSCRIPT_DIR = TMP
process.env.CC_RESPAWN_HOLD_GRACE_MS = '150'

const state = vi.hoisted(() => ({ session: 'review' as 'working' | 'review' | 'dead' }))
const seenBySpawn = vi.hoisted(() => ({ pollerSkipped: [] as boolean[], status: [] as string[] }))
const probe = vi.hoisted(() => ({
  isHeld: (_sid: string): boolean => false,
  statusOf: (_id: number): string => '',
}))
const sendFollowUp = vi.hoisted(() =>
  vi.fn((sid: string, _message: string, objective: { id: number }, _opts?: unknown) => {
    // What a poll tick landing just before this spawn returns would see.
    seenBySpawn.pollerSkipped.push(probe.isHeld(sid))
    seenBySpawn.status.push(probe.statusOf(objective.id))
    return sid
  }),
)
vi.mock('../services/session-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/session-manager.js')>()),
  getSessionState: () => state.session,
  sendFollowUp,
  stopSession: vi.fn(async () => {}),
}))

const { getDb, initDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { overloadRetryPending } = await import('../services/session-death.js')
const { isOverloadRetryPending } = await import('../services/session-auto-resume.js')

let server: http.Server
let baseUrl: string
let cookie: string
let objId: number
let sessionId: string
let jsonl: string

async function postMessage(message: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/objectives/${objId}/message`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  return { status: res.status, json: await res.json() }
}
const tick = () => new Promise(r => setTimeout(r, 20))

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'casey', 'x', 'admin')`).run()
  const r = db.prepare(
    `INSERT INTO objectives (title, agent_context, workspace, created_by, status) VALUES ('Ryan Issue', 'general', 'ws', 1, 'review')`,
  ).run()
  objId = Number(r.lastInsertRowid)
  sessionId = `cc-${objId}-1794250748302`
  jsonl = path.join(TMP, `${sessionId}.jsonl`)
  // The card's worker ran before: resolveFollowUpSessionId finds it here once
  // the poller has nulled objectives.session_id.
  db.prepare(
    `INSERT INTO session_intel (session_id, objective_id, started_at, ended_at) VALUES (?, ?, datetime('now', '-1 hour'), datetime('now', '-50 minutes'))`,
  ).run(sessionId, objId)
  probe.isHeld = (sid: string) => isOverloadRetryPending(sid)
  probe.statusOf = (id: number) => (db.prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  cookie = `token=${jwt.sign({ id: 1, username: 'casey', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  sendFollowUp.mockClear()
  seenBySpawn.pollerSkipped = []
  seenBySpawn.status = []
  overloadRetryPending.clear()
  // The previous turn finished: its `result` is the last event in the transcript.
  fs.writeFileSync(jsonl, JSON.stringify({ type: 'result', result: 'Done.' }) + '\n')
})

describe('one follow-up wakes a parked card the first time (obj 900547)', () => {
  for (const [label, status, sessionCol, liveState] of [
    ['review, session_id cleared by the poller', 'review', null, 'review'],
    ['blocked (review + has_blockers)', 'review', null, 'review'],
    ['working, worker already dead (poller has not routed it yet)', 'working', 'self', 'review'],
  ] as const) {
    it(`${label}: card shows working and the poller is held off until the respawn returns`, async () => {
      state.session = liveState
      getDb()
        .prepare('UPDATE objectives SET status = ?, session_id = ?, has_blockers = ?, blocked_reason = ? WHERE id = ?')
        .run(status, sessionCol === 'self' ? sessionId : null, label.startsWith('blocked') ? 1 : 0, label.startsWith('blocked') ? 'needs owner input' : null, objId)

      const r = await postMessage('ok great does the language on the site match what Operator said exactly?')
      expect(r.status).toBe(200)
      expect(r.json.status).toBe('working')
      expect(r.json.followup_queued).toBeUndefined()
      await tick()

      // Exactly ONE respawn for ONE message, addressed to the card's worker.
      expect(sendFollowUp).toHaveBeenCalledTimes(1)
      expect(sendFollowUp.mock.calls[0][0]).toBe(sessionId)
      // While it was in flight the card was `working` and the poll loop's skip
      // predicate held: no tick could re-read the pre-spawn state as "finished".
      expect(seenBySpawn.status).toEqual(['working'])
      expect(seenBySpawn.pollerSkipped).toEqual([true])
      // The hold outlives the spawn by a short grace (a jailed run takes a moment
      // to appear in the liveness snapshots), then lifts so the poller tracks the
      // new run normally.
      expect(isOverloadRetryPending(sessionId)).toBe(true)
      await new Promise(r => setTimeout(r, 250))
      expect(isOverloadRetryPending(sessionId)).toBe(false)

      // The owner sees the bubble in the thread.
      const events = fs.readFileSync(jsonl, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(events.at(-1)).toMatchObject({ type: 'followup', sender: { username: 'casey' } })
    })
  }

  it('a failed respawn releases the hold and reverts the card', async () => {
    state.session = 'review'
    getDb().prepare("UPDATE objectives SET status = 'review', session_id = NULL WHERE id = ?").run(objId)
    sendFollowUp.mockImplementationOnce(() => { throw new Error('spawn failed') })
    const r = await postMessage('hello?')
    expect(r.json.status).toBe('working')
    await tick()
    expect(isOverloadRetryPending(sessionId)).toBe(false)
    expect((getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(objId) as { status: string }).status).toBe('review')
  })

  it('never cuts short a real 529 backoff already pending on the same session', async () => {
    state.session = 'review'
    getDb().prepare("UPDATE objectives SET status = 'review', session_id = NULL WHERE id = ?").run(objId)
    overloadRetryPending.add(sessionId)
    await postMessage('still there?')
    await tick()
    expect(isOverloadRetryPending(sessionId)).toBe(true)
  })
})

describe('liveness snapshot is dropped after a respawn (obj 900547)', () => {
  it('a docker-ps snapshot taken before the spawn does not hide the new jail', async () => {
    const tmux = await import('../services/session-tmux.js')
    let running: string[] = []
    tmux.__setJailPsRunnerForTests(() => running.join('\n'))
    try {
      const t0 = Date.now()
      expect(tmux.jailSessionAlive(sessionId, t0)).toBe(false) // pre-spawn tick
      running = [sessionId] // the respawn started the jail
      // Without invalidation the cached pre-spawn snapshot answers for 2s.
      expect(tmux.jailSessionAlive(sessionId, t0 + 500)).toBe(false)
      tmux.invalidateSessionLivenessCache() // what sendFollowUp now does after spawnInTmux
      expect(tmux.jailSessionAlive(sessionId, t0 + 500)).toBe(true)
    } finally {
      tmux.__setJailPsRunnerForTests(null)
    }
  })

  it('sendFollowUp invalidates the snapshot right after spawnInTmux', () => {
    const src = fs.readFileSync(new URL('../services/session-followup.ts', import.meta.url), 'utf8')
    const spawnAt = src.indexOf('const tmuxName = spawnInTmux(')
    const invalidateAt = src.indexOf('invalidateSessionLivenessCache()', spawnAt)
    expect(spawnAt).toBeGreaterThan(0)
    expect(invalidateAt).toBeGreaterThan(spawnAt)
    expect(invalidateAt).toBeLessThan(src.indexOf('return sessionId\n}', spawnAt))
  })
})
