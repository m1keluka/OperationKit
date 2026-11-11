import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// obj 79 — jail-aware session liveness (SESSION_ISOLATION=docker). A jailed
// session's tmux lives inside `ok-jail-<id>`, invisible to the host `tmux ls`;
// before this fix getSessionState called it dead seconds after spawn.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jail-liveness-'))
const JAIL_HOMES = path.join(DIR, 'jail-homes')
const TRANSCRIPTS = path.join(DIR, 'transcripts')
fs.mkdirSync(JAIL_HOMES, { recursive: true })
fs.mkdirSync(TRANSCRIPTS, { recursive: true })
process.env.CC_JAIL_HOME_ROOT = JAIL_HOMES
process.env.TRANSCRIPT_DIR = TRANSCRIPTS
process.env.DB_PATH = path.join(DIR, 'test.db')

// No host tmux server: every host `tmux` call fails, exactly like a jail-mode host.
const hostTmuxCalls: string[] = []
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return {
    ...actual,
    execSync: vi.fn((cmd: string) => {
      if (String(cmd).startsWith('tmux')) {
        hostTmuxCalls.push(String(cmd))
        throw new Error('no server running on /tmp/tmux-0/default')
      }
      return actual.execSync(cmd)
    }),
  }
})

const tmux = await import('./session-tmux.js')
const { getSessionState } = await import('./session-control.js')

const J = (o: unknown) => JSON.stringify(o)
const assistantToolUse = J({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } })
const resultOk = J({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's', uuid: 'r1' })

/** Write a transcript where the jail writes it: <JAIL_HOMES>/<sid>/.cc/<sid>.jsonl, plus the canonical symlink. */
function jailTranscript(sid: string, lines: string[], { link = true } = {}): void {
  const dir = path.join(JAIL_HOMES, sid, '.cc')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `${sid}.jsonl`)
  fs.writeFileSync(p, lines.join('\n') + '\n')
  const canonical = path.join(TRANSCRIPTS, `${sid}.jsonl`)
  fs.rmSync(canonical, { force: true })
  if (link) fs.symlinkSync(p, canonical)
}

let running = new Set<string>()
let dockerFails = false
let dockerCalls = 0
const fakeDocker = () => {
  dockerCalls++
  if (dockerFails) throw new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')
  return [...running].join('\n') + (running.size ? '\n' : '')
}

beforeAll(() => { tmux.__setJailPsRunnerForTests(fakeDocker) })
afterAll(() => {
  tmux.__setJailPsRunnerForTests(null)
  fs.rmSync(DIR, { recursive: true, force: true })
})
beforeEach(() => {
  process.env.SESSION_ISOLATION = 'docker'
  running = new Set()
  dockerFails = false
  dockerCalls = 0
  hostTmuxCalls.length = 0
  tmux.resetTmuxListCache()
})
afterEach(() => { delete process.env.SESSION_ISOLATION })

describe('jail liveness — tmuxSessionAlive with SESSION_ISOLATION=docker', () => {
  it('alive: the jail container for the session is running', () => {
    running.add('cc-59-1')
    expect(tmux.tmuxSessionAlive('cc-59-1')).toBe(true)
    expect(tmux.jailSessionAlive('cc-59-1')).toBe(true)
  })

  it('dead: docker answered and no running jail carries the session', () => {
    fs.mkdirSync(path.join(JAIL_HOMES, 'cc-59-2'), { recursive: true })
    expect(tmux.tmuxSessionAlive('cc-59-2')).toBe(false)
    expect(tmux.jailSessionAlive('cc-59-2')).toBe(false)
  })

  it('docker error is fail-safe: a jailed session (jail HOME exists) is NOT marked dead', () => {
    fs.mkdirSync(path.join(JAIL_HOMES, 'cc-64-1'), { recursive: true })
    dockerFails = true
    expect(tmux.jailSessionAlive('cc-64-1')).toBeNull()
    expect(tmux.tmuxSessionAlive('cc-64-1')).toBe(true)
  })

  it('docker error does not resurrect a session that was never jailed on this host', () => {
    dockerFails = true
    expect(tmux.tmuxSessionAlive('cc-never-jailed-1')).toBe(false)
  })

  it('cache TTL: one docker ps per TTL window, refreshed after it expires', () => {
    running.add('cc-70-1')
    const t0 = 1_000_000
    expect(tmux.jailSessionAlive('cc-70-1', t0)).toBe(true)
    running.delete('cc-70-1')
    // Within the TTL: served from the snapshot, docker not re-asked.
    expect(tmux.jailSessionAlive('cc-70-1', t0 + tmux.JAIL_LIST_TTL_MS - 1)).toBe(true)
    expect(dockerCalls).toBe(1)
    // After the TTL: re-asked, sees the container gone.
    expect(tmux.jailSessionAlive('cc-70-1', t0 + tmux.JAIL_LIST_TTL_MS)).toBe(false)
    expect(dockerCalls).toBe(2)
  })

  it('a docker failure is never cached — the next call asks again', () => {
    dockerFails = true
    const t0 = 2_000_000
    expect(tmux.jailSessionAlive('cc-71-1', t0)).toBeNull()
    dockerFails = false
    running.add('cc-71-1')
    expect(tmux.jailSessionAlive('cc-71-1', t0 + 1)).toBe(true)
    expect(dockerCalls).toBe(2)
  })

  it('a host tmux session of the same name still counts (spawned before the flag flipped)', () => {
    // Host tmux is down in this suite, so this only proves the host path is still consulted.
    expect(tmux.tmuxSessionAlive('cc-80-1')).toBe(false)
    expect(hostTmuxCalls.length).toBeGreaterThan(0)
  })

  it('uses a token-free docker ps filtered on running jails by the ok.session label', () => {
    expect(tmux.JAIL_PS_ARGV).toEqual([
      'ps', '--filter', 'label=ok.session', '--filter', 'status=running', '--format', '{{.Label "ok.session"}}',
    ])
  })
})

describe('non-jail mode is unchanged', () => {
  it('SESSION_ISOLATION unset → docker is never consulted, host tmux decides', () => {
    delete process.env.SESSION_ISOLATION
    running.add('cc-90-1')
    expect(tmux.tmuxSessionAlive('cc-90-1')).toBe(false) // no host tmux → dead, as before
    expect(dockerCalls).toBe(0)
  })
})

describe('getSessionState for a jailed session', () => {
  it('jail alive + no result yet → working (was: dead → review + session_id nulled)', () => {
    jailTranscript('cc-59-10', [assistantToolUse])
    running.add('cc-59-10')
    expect(getSessionState('cc-59-10')).toBe('working')
  })

  it('jail alive + transient docker error + no result → working, never dead', () => {
    jailTranscript('cc-59-11', [assistantToolUse])
    dockerFails = true
    expect(getSessionState('cc-59-11')).toBe('working')
  })

  it('jail finished (container gone) + result → review', () => {
    jailTranscript('cc-59-12', [assistantToolUse, resultOk])
    expect(getSessionState('cc-59-12')).toBe('review')
  })

  it('jail alive + trailing result (tmux not exited yet) → review', () => {
    jailTranscript('cc-59-13', [assistantToolUse, resultOk])
    running.add('cc-59-13')
    expect(getSessionState('cc-59-13')).toBe('review')
  })

  it('reads the jail-home bind when the canonical transcript symlink is missing', () => {
    jailTranscript('cc-59-14', [assistantToolUse, resultOk], { link: false })
    expect(fs.existsSync(path.join(TRANSCRIPTS, 'cc-59-14.jsonl'))).toBe(false)
    expect(tmux.resolveSessionTranscript(path.join(TRANSCRIPTS, 'cc-59-14.jsonl'), 'cc-59-14'))
      .toBe(path.join(JAIL_HOMES, 'cc-59-14', '.cc', 'cc-59-14.jsonl'))
    // Container gone; result found through the jail-home bind → review, not dead.
    expect(getSessionState('cc-59-14')).toBe('review')
  })

  it('jail gone + no result → dead (a crashed jail is still detected)', () => {
    jailTranscript('cc-59-15', [assistantToolUse])
    expect(getSessionState('cc-59-15')).toBe('dead')
  })
})
