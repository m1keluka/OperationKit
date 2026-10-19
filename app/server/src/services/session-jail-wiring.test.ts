/**
 * Flag routing for SESSION_ISOLATION, exercised through the REAL spawn entry
 * point (`spawnInTmux`) rather than a re-implementation of it. Only the two
 * process-spawning edges are faked: `execSync` (tmux) and `execFileSync`
 * (docker). Everything else — script generation, path planning, the fail-closed
 * branch — is the shipped code.
 *
 * The three properties under test:
 *   1. flag unset / `tmux`  → `tmux new-session` runs, docker is never touched.
 *   2. flag `docker`        → `docker run` with the proven isolation argv runs,
 *                             and `tmux new-session` is NEVER executed on the host.
 *   3. flag `docker` + docker failure → THROWS. No fallback to unsandboxed tmux.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execSyncCalls: string[] = []
const execFileSyncCalls: Array<{ file: string; argv: string[] }> = []
let dockerRunResult: () => string = () => 'abc123def456\n'

vi.mock('child_process', () => ({
  execSync: (cmd: string) => { execSyncCalls.push(String(cmd)); return Buffer.from('') },
  execFileSync: (file: string, argv: string[]) => {
    execFileSyncCalls.push({ file, argv })
    return dockerRunResult()
  },
}))
vi.mock('node:child_process', () => ({
  execFile: () => undefined,
  execSync: (cmd: string) => { execSyncCalls.push(String(cmd)); return Buffer.from('') },
  execFileSync: (file: string, argv: string[]) => {
    execFileSyncCalls.push({ file, argv })
    return dockerRunResult()
  },
}))

let tmp: string
let originalIsolation: string | undefined
let originalScriptDir: string | undefined
let originalJailHomeRoot: string | undefined

function spawnOpts(root: string) {
  return {
    sessionId: 'cc-709080-1756400000000',
    objectiveId: 709080,
    homeDir: path.join(root, 'home'),
    workdir: path.join(root, 'worktree'),
    worktreeRoot: path.join(root, 'worktree'),
    prompt: 'do the thing',
    jsonlPath: path.join(root, 'transcripts', 'session.jsonl'),
    logPath: path.join(root, 'transcripts', 'session.log'),
    env: { CC_ACTING_USER_ID: '1', SOME_SECRET: 'value' },
  }
}

/** Fresh module graph so TMUX_SCRIPT_DIR / JAIL_HOME_ROOT pick up this test's env. */
async function loadSpawn() {
  vi.resetModules()
  return (await import('./session-tmux.js')).spawnInTmux
}

beforeEach(() => {
  execSyncCalls.length = 0
  execFileSyncCalls.length = 0
  dockerRunResult = () => 'abc123def456\n'
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-wiring-'))
  fs.mkdirSync(path.join(tmp, 'home'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'worktree'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'transcripts'), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'transcripts', 'session.jsonl'), '{"type":"prompt"}\n')
  fs.writeFileSync(path.join(tmp, 'transcripts', 'session.log'), 'header\n')
  originalIsolation = process.env.SESSION_ISOLATION
  originalScriptDir = process.env.CC_SCRIPT_DIR
  originalJailHomeRoot = process.env.CC_JAIL_HOME_ROOT
  process.env.CC_SCRIPT_DIR = path.join(tmp, 'cc-scripts')
  process.env.CC_JAIL_HOME_ROOT = path.join(tmp, 'jail-homes')
  delete process.env.SESSION_ISOLATION
})

afterEach(() => {
  if (originalIsolation === undefined) delete process.env.SESSION_ISOLATION
  else process.env.SESSION_ISOLATION = originalIsolation
  if (originalScriptDir === undefined) delete process.env.CC_SCRIPT_DIR
  else process.env.CC_SCRIPT_DIR = originalScriptDir
  if (originalJailHomeRoot === undefined) delete process.env.CC_JAIL_HOME_ROOT
  else process.env.CC_JAIL_HOME_ROOT = originalJailHomeRoot
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('SESSION_ISOLATION unset / tmux → existing spawnInTmux path (live droplet default)', () => {
  it('spawns host tmux and never invokes docker when the flag is unset', async () => {
    const spawnInTmux = await loadSpawn()
    const name = spawnInTmux(spawnOpts(tmp))
    expect(name).toBe('cc-709080-1756400000000')
    expect(execSyncCalls.some((c) => c.includes('tmux new-session -d -s'))).toBe(true)
    expect(execSyncCalls.some((c) => c.includes('runuser -u ccuser'))).toBe(true)
    expect(execFileSyncCalls).toEqual([])
    expect(execSyncCalls.join(' ')).not.toContain('docker')
    // Wrapper script + prompt stay in the shared script dir; transcripts stay real files.
    expect(fs.existsSync(path.join(tmp, 'cc-scripts', 'cc-709080-1756400000000.sh'))).toBe(true)
    expect(fs.lstatSync(path.join(tmp, 'transcripts', 'session.jsonl')).isSymbolicLink()).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'jail-homes'))).toBe(false)
  })

  it('behaves identically for the explicit `tmux` value', async () => {
    process.env.SESSION_ISOLATION = 'tmux'
    const spawnInTmux = await loadSpawn()
    spawnInTmux(spawnOpts(tmp))
    expect(execSyncCalls.some((c) => c.includes('tmux new-session -d -s'))).toBe(true)
    expect(execFileSyncCalls).toEqual([])
  })
})

describe('SESSION_ISOLATION=docker → createSessionJail path', () => {
  it('docker-runs the jail with the proven isolation argv and no host tmux', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    const spawnInTmux = await loadSpawn()
    const name = spawnInTmux(spawnOpts(tmp))
    expect(name).toBe('cc-709080-1756400000000')

    const runCall = execFileSyncCalls.find((c) => c.argv[0] === 'run')
    expect(runCall).toBeDefined()
    expect(runCall!.file).toBe('docker')
    const argv = runCall!.argv

    // Isolation contract, asserted on the ACTUAL wired argv.
    expect(argv).toContain('ok-jail-709080')
    expect(argv[argv.indexOf('--cap-drop') + 1]).toBe('ALL')
    expect(argv[argv.indexOf('--security-opt') + 1]).toBe('no-new-privileges')
    expect(argv[argv.indexOf('--user') + 1]).toBe('1000:1000')
    expect(argv[argv.indexOf('--restart') + 1]).toBe('no')
    const flat = argv.join(' ')
    expect(flat).not.toContain('docker.sock')
    expect(flat).not.toContain('/var/run')
    expect(flat).not.toContain('/home/operator')
    expect(flat).not.toContain('/home/ccuser-')
    for (const bad of ['--privileged', '--pid=host', '--network=host', '--net=host', '--ipc=host', '--userns=host']) {
      expect(argv).not.toContain(bad)
    }
    // Exactly two binds: the worktree and this session's own HOME.
    expect(argv.filter((a, i, all) => all[i - 1] === '--mount')).toEqual([
      `type=bind,source=${path.join(tmp, 'worktree')},target=/workspace,bind-propagation=rprivate`,
      `type=bind,source=${path.join(tmp, 'jail-homes', 'cc-709080-1756400000000')},target=/home/jailuser,bind-propagation=rprivate`,
    ])
    // tmux runs INSIDE the jail, not on the host.
    expect(argv.join(' ')).toContain('tmux new-session -d -s')
    expect(execSyncCalls.some((c) => c.includes('tmux new-session'))).toBe(false)

    // Env is handed over via --env-file inside the HOME bind, not a third mount.
    const envFile = argv[argv.indexOf('--env-file') + 1]
    expect(envFile.startsWith(path.join(tmp, 'jail-homes'))).toBe(true)
    expect(fs.readFileSync(envFile, 'utf8')).toContain('SOME_SECRET=value')

    // Wrapper script lives in the HOME bind and references container-side paths only.
    const script = fs.readFileSync(
      path.join(tmp, 'jail-homes', 'cc-709080-1756400000000', '.cc', 'cc-709080-1756400000000.sh'),
      'utf8',
    )
    expect(script).toContain('cd "/workspace"')
    expect(script).toContain('/home/jailuser/.cc/')
    expect(script).not.toContain('/home/operator')
  })

  it('FAILS CLOSED: a docker-run failure throws and never falls back to host tmux', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    dockerRunResult = () => {
      const e = new Error('spawn docker ENOENT') as Error & { stderr: string }
      e.stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'
      throw e
    }
    const spawnInTmux = await loadSpawn()
    expect(() => spawnInTmux(spawnOpts(tmp))).toThrow(/refusing to fall back to unsandboxed tmux/)
    expect(execSyncCalls.some((c) => c.includes('tmux new-session'))).toBe(false)
  })

  it('FAILS CLOSED: no objectiveId means no jail name, so no spawn at all', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    const spawnInTmux = await loadSpawn()
    const { objectiveId: _drop, ...noId } = spawnOpts(tmp)
    expect(() => spawnInTmux(noId)).toThrow(/no objectiveId/)
    expect(execSyncCalls.some((c) => c.includes('tmux new-session'))).toBe(false)
    expect(execFileSyncCalls.some((c) => c.argv[0] === 'run')).toBe(false)
  })
})
