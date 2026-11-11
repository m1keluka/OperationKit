import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync, spawnSync } from 'child_process'

// obj 900547 — #900543 died twice (2026-11-11 05:11:00 / 05:18:39 UTC) seconds
// after its worker booted a scratch Command Center inside its own jail for
// screenshots. The scratch server's state poller ran sweepOrphanWorkerTmux() on
// its first tick: `tmux ls` in the jail lists the worker's OWN session
// (cc-900543-1794373470759), the scratch server's temp DB has no such objective,
// so it was "an orphan" and got killed — taking the worker with it.

// Isolated DB + isolated tmux server for this file.
const TMP_DB = path.join(os.tmpdir(), `cc-scratch-guard-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMUX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-scratch-tmux-'))
process.env.TMUX_TMPDIR = TMUX_DIR
delete process.env.TMUX

const { initDb, getDb } = await import('../db/index.js')
const { sweepOrphanWorkerTmux, selectOrphanWorkerSessions } = await import('./session-manager.js')
const { decideScratch, isSessionAncestor, looksLikeSessionPath, selectSelfTmuxSessions, readAncestors } = await import('./scratch-instance.js')

const HAS_TMUX = spawnSync('tmux', ['-V']).status === 0

function tmuxHas(name: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', name], { env: process.env }).status === 0
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
afterAll(() => {
  try { execSync('tmux kill-server 2>/dev/null') } catch { /* none */ }
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMUX_DIR, { recursive: true, force: true })
})
beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  try { execSync('tmux kill-server 2>/dev/null') } catch { /* none */ }
})

describe.skipIf(!HAS_TMUX)('sweepOrphanWorkerTmux on a scratch DB (the #900543 kill)', () => {
  it('does NOT kill a worker tmux session for an objective this DB has never heard of', () => {
    // The jail: one tmux session, the worker's own. Temp DB: empty.
    execSync(`tmux new-session -d -s cc-900543-1794373470759 'sleep 60'`)
    expect(tmuxHas('cc-900543-1794373470759')).toBe(true)

    sweepOrphanWorkerTmux()

    // Before obj 900547 this session was killed here.
    expect(tmuxHas('cc-900543-1794373470759')).toBe(true)
  })

  it('still reaps a genuine orphan the DB knows (host behaviour unchanged)', () => {
    getDb().prepare(
      `INSERT INTO objectives (id, title, agent_context, workspace, status, session_id)
       VALUES (777001, 'moved on', 'cto', 'example', 'review', 'cc-777001-2')`,
    ).run()
    execSync(`tmux new-session -d -s cc-777001-1 'sleep 60'`)
    sweepOrphanWorkerTmux()
    expect(tmuxHas('cc-777001-1')).toBe(false)
  })

  it('keeps the live session of a working objective', () => {
    getDb().prepare(
      `INSERT INTO objectives (id, title, agent_context, workspace, status, session_id)
       VALUES (777002, 'live', 'cto', 'example', 'working', 'cc-777002-5')`,
    ).run()
    execSync(`tmux new-session -d -s cc-777002-5 'sleep 60'`)
    sweepOrphanWorkerTmux()
    expect(tmuxHas('cc-777002-5')).toBe(true)
  })
})

describe('selectOrphanWorkerSessions guard', () => {
  it('never selects a protected (self) session or an unknown objective', () => {
    const names = ['cc-1-1', 'cc-2-1', 'cc-3-1']
    const out = selectOrphanWorkerSessions(names, [], undefined, {
      protectedNames: new Set(['cc-1-1']),
      objectiveKnown: (id) => id !== 2,
    })
    expect(out).toEqual(['cc-3-1'])
  })
  it('without a guard behaves exactly as before', () => {
    expect(selectOrphanWorkerSessions(['cc-1-1', 'cc-2-1'], ['cc-2-1'])).toEqual(['cc-1-1'])
  })
})

describe('selectSelfTmuxSessions', () => {
  it('matches the session whose pane pid is one of our ancestors', () => {
    const panes = [
      { session: 'cc-900543-1794373470759', panePid: 18 },
      { session: 'cc-5-5', panePid: 99 },
    ]
    expect([...selectSelfTmuxSessions(panes, [4100, 27, 18, 12, 1])]).toEqual(['cc-900543-1794373470759'])
  })
  it('readAncestors walks /proc up to pid 1 on Linux', () => {
    if (process.platform !== 'linux') return
    const anc = readAncestors()
    expect(anc.length).toBeGreaterThan(0)
    expect(anc[0].pid).toBe(process.ppid)
  })
})

describe('decideScratch', () => {
  const host = { env: {} as NodeJS.ProcessEnv, cwd: '/app', moduleUrl: 'file:///app/server/src/index.ts', ancestorCmdlines: ['sh /app/entrypoint.sh', 'tini -- /app/entrypoint.sh'] }

  it('the real host (container entrypoint, /app) is NOT scratch', () => {
    expect(decideScratch(host)).toEqual({ scratch: false, reason: null })
  })

  it('the exact #900543 launch is scratch: env -i, fresh HOME, NODE_ENV=production, jail cwd', () => {
    const v = decideScratch({
      env: { PATH: '/usr/bin', HOME: '/home/jailuser/work/run/home', NODE_ENV: 'production', PORT: '3912' },
      cwd: '/home/jailuser/obj900543-JZCW/repo/app/server',
      moduleUrl: 'file:///home/jailuser/obj900543-JZCW/repo/app/server/src/index.ts',
      ancestorCmdlines: ['/bin/bash -c ...', 'claude --print --output-format stream-json', 'bash /home/jailuser/.cc/cc-900543-1794373470759.sh'],
    })
    expect(v.scratch).toBe(true)
  })

  it('is scratch from process ancestry alone (env scrubbed, neutral cwd)', () => {
    const v = decideScratch({ ...host, cwd: '/srv/x', moduleUrl: 'file:///srv/x/index.ts', ancestorCmdlines: ['node x', '/usr/local/bin/claude --print'] })
    expect(v.scratch).toBe(true)
    expect(v.reason).toMatch(/session process/)
  })

  it('is scratch when it inherited a worker env', () => {
    expect(decideScratch({ ...host, env: { CC_OBJECTIVE_ID: '900543' } }).scratch).toBe(true)
    expect(decideScratch({ ...host, env: { CC_WORKTREE_ROOT: '/workspace' } }).scratch).toBe(true)
  })

  it('honours explicit markers and the host override', () => {
    expect(decideScratch({ ...host, env: { CC_SCRATCH_SERVER: '1' } }).scratch).toBe(true)
    expect(decideScratch({ ...host, env: { OK_SCRATCH: 'true' } }).scratch).toBe(true)
    expect(decideScratch({ ...host, env: { NODE_ENV: 'test' } }).scratch).toBe(true)
    expect(decideScratch({ ...host, env: { CC_HOST_INSTANCE: '1', CC_OBJECTIVE_ID: '9' }, ancestorCmdlines: ['claude'] }).scratch).toBe(false)
  })

  it('is scratch inside a worker tmux session', () => {
    expect(decideScratch({ ...host, env: { TMUX: '/tmp/tmux-1/default,12,0' }, tmuxSessionName: 'cc-900543-1' }).scratch).toBe(true)
  })

  it('path + ancestor matchers', () => {
    expect(looksLikeSessionPath('/tmp/cc-worktree-900543/app')).toBe(true)
    expect(looksLikeSessionPath('/home/jailuser/work')).toBe(true)
    expect(looksLikeSessionPath('/app/server')).toBe(false)
    expect(isSessionAncestor('tmux new-session -d -s cc-900543-1794373470759 bash x.sh')).toBe(true)
    expect(isSessionAncestor('node /usr/local/bin/tsx server/src/index.ts')).toBe(false)
  })
})
