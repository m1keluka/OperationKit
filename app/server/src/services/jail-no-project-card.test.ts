/**
 * obj 900038 — END TO END through the real `spawnInTmux`: a card with NO
 * project (agent `general`) must start in the sandbox instead of dying at `cd`.
 *
 * Only the two process-spawning edges are faked (`execSync` for tmux,
 * `execFileSync` for docker), exactly like session-jail-wiring.test.ts. The
 * mount planning, the wrapper generation and the permission handling under test
 * are all the shipped code.
 *
 * Reproduced failure: the card resolved its workdir to the operator home
 * (/opt/operationkit/state/home on the Example OVH install, mode 0750 root:root),
 * that path was bound at /workspace, and the jail uid could not enter it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execSyncCalls: string[] = []
const execFileSyncCalls: Array<{ file: string; argv: string[] }> = []

vi.mock('child_process', () => ({
  execSync: (cmd: string) => { execSyncCalls.push(String(cmd)); return Buffer.from('') },
  execFileSync: (file: string, argv: string[]) => {
    execFileSyncCalls.push({ file, argv })
    return 'deadbeefcafe\n'
  },
}))
vi.mock('node:child_process', () => ({
  execFile: () => undefined,
  execSync: (cmd: string) => { execSyncCalls.push(String(cmd)); return Buffer.from('') },
  execFileSync: (file: string, argv: string[]) => {
    execFileSyncCalls.push({ file, argv })
    return 'deadbeefcafe\n'
  },
}))

const SID = 'cc-900038-1762000000000'
const OBJ = 900038

let tmp: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ['SESSION_ISOLATION', 'CC_SCRIPT_DIR', 'CC_JAIL_HOME_ROOT', 'CC_JAIL_SCRATCH_ROOT', 'USER_HOME']

/** A no-project card: NO worktreeRoot, and a workdir that is the operator home. */
function noProjectSpawnOpts(root: string, workdir: string) {
  return {
    sessionId: SID,
    objectiveId: OBJ,
    homeDir: path.join(root, 'acct-home'),
    workdir,
    // worktreeRoot deliberately ABSENT — this is what a no-project card looks like.
    prompt: 'answer the question',
    jsonlPath: path.join(root, 'transcripts', `${SID}.jsonl`),
    logPath: path.join(root, 'transcripts', `${SID}.log`),
    env: { CC_ACTING_USER_ID: '1', ANTHROPIC_API_KEY: 'sk-ant-leak-me-not-0123456789' },
  }
}

async function loadSpawn() {
  vi.resetModules()
  return (await import('./session-tmux.js')).spawnInTmux
}

function mounts(argv: string[]): string[] {
  return argv.filter((a, i, all) => all[i - 1] === '--mount')
}

beforeEach(() => {
  execSyncCalls.length = 0
  execFileSyncCalls.length = 0
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jail-noproject-'))
  for (const d of ['acct-home', 'transcripts', 'operator-home']) {
    fs.mkdirSync(path.join(tmp, d), { recursive: true })
  }
  fs.writeFileSync(path.join(tmp, 'transcripts', `${SID}.jsonl`), '{"type":"prompt"}\n')
  fs.writeFileSync(path.join(tmp, 'transcripts', `${SID}.log`), 'header\n')
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  process.env.CC_SCRIPT_DIR = path.join(tmp, 'cc-scripts')
  process.env.CC_JAIL_HOME_ROOT = path.join(tmp, 'jail-homes')
  process.env.CC_JAIL_SCRATCH_ROOT = path.join(tmp, 'jail-scratch')
  process.env.USER_HOME = path.join(tmp, 'operator-home')
  process.env.SESSION_ISOLATION = 'docker'
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]!
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a no-project card in the sandbox (obj 900038)', () => {
  it('binds a per-card scratch dir at /workspace, NEVER the bare operator home', async () => {
    const operatorHome = path.join(tmp, 'operator-home')
    const spawnInTmux = await loadSpawn()
    expect(spawnInTmux(noProjectSpawnOpts(tmp, operatorHome))).toBe(SID)

    const run = execFileSyncCalls.find(c => c.argv[0] === 'run')
    expect(run).toBeDefined()
    const m = mounts(run!.argv)
    expect(m).toHaveLength(2) // still exactly two binds: /workspace and HOME

    const workspaceBind = m.find(x => x.includes('target=/workspace'))!
    expect(workspaceBind).toContain(`source=${path.join(tmp, 'jail-scratch', String(OBJ))},`)
    // The regression this test exists for.
    expect(workspaceBind).not.toContain(`source=${operatorHome},`)
  })

  it('creates that scratch dir on the host, and it is not world-readable', async () => {
    const spawnInTmux = await loadSpawn()
    spawnInTmux(noProjectSpawnOpts(tmp, path.join(tmp, 'operator-home')))
    const scratch = path.join(tmp, 'jail-scratch', String(OBJ))
    expect(fs.statSync(scratch).isDirectory()).toBe(true)
    expect(fs.statSync(scratch).mode & 0o004).toBe(0)
  })

  it('falls back to scratch when the workdir exists but the jail uid cannot enter it', async () => {
    // Mode 0700 owned by THIS uid: a different uid (the jail's) cannot enter.
    // When the suite happens to run as uid 1000 this is traversable, so the
    // assertion is on "not the un-enterable dir", which holds either way.
    const locked = path.join(tmp, 'locked')
    fs.mkdirSync(locked, { mode: 0o700 })
    fs.chmodSync(locked, 0o700)
    const spawnInTmux = await loadSpawn()
    spawnInTmux(noProjectSpawnOpts(tmp, locked))
    const run = execFileSyncCalls.find(c => c.argv[0] === 'run')!
    const workspaceBind = mounts(run.argv).find(x => x.includes('target=/workspace'))!
    const isJailUid = typeof process.getuid === 'function' && process.getuid() === 1000
    if (isJailUid) expect(workspaceBind).toContain(`source=${locked},`)
    else expect(workspaceBind).toContain(path.join(tmp, 'jail-scratch', String(OBJ)))
  })

  it('a card WITH a worktree still binds its worktree — no regression', async () => {
    const wt = path.join(tmp, 'worktree')
    fs.mkdirSync(wt, { recursive: true })
    const spawnInTmux = await loadSpawn()
    spawnInTmux({ ...noProjectSpawnOpts(tmp, path.join(tmp, 'operator-home')), worktreeRoot: wt })
    const run = execFileSyncCalls.find(c => c.argv[0] === 'run')!
    const workspaceBind = mounts(run.argv).find(x => x.includes('target=/workspace'))!
    expect(workspaceBind).toContain(`source=${wt},`)
    expect(fs.existsSync(path.join(tmp, 'jail-scratch', String(OBJ)))).toBe(false)
  })

  it('the wrapper it generates logs before it cds, and fails loudly if the cd fails', async () => {
    const spawnInTmux = await loadSpawn()
    spawnInTmux(noProjectSpawnOpts(tmp, path.join(tmp, 'operator-home')))
    const script = fs.readFileSync(path.join(tmp, 'jail-homes', SID, '.cc', `${SID}.sh`), 'utf8')
    expect(script.indexOf('[wrapper] Starting at')).toBeLessThan(script.indexOf('if ! cd "$CC_WORKDIR"'))
    expect(script).toContain('STARTUP-FAILURE')
    expect(script).toContain('exit 78')
  })

  it('leaves NO --env-file on disk once `docker run` has returned', async () => {
    const spawnInTmux = await loadSpawn()
    spawnInTmux(noProjectSpawnOpts(tmp, path.join(tmp, 'operator-home')))
    const run = execFileSyncCalls.find(c => c.argv[0] === 'run')!
    const envFile = run.argv[run.argv.indexOf('--env-file') + 1]
    expect(envFile).toContain(SID)
    expect(fs.existsSync(envFile)).toBe(false)
  })

  it('the jail home it created is not world-readable and holds no stray secret copy', async () => {
    const spawnInTmux = await loadSpawn()
    spawnInTmux(noProjectSpawnOpts(tmp, path.join(tmp, 'operator-home')))
    const home = path.join(tmp, 'jail-homes', SID)
    for (const d of [home, path.join(home, '.cc')]) {
      const mode = fs.statSync(d).mode & 0o777
      expect(mode).not.toBe(0o777)
      expect(mode & 0o004).toBe(0)
    }
    // The wrapper legitimately still carries the exports while the session runs;
    // what must NOT exist is a second, independent plaintext dump (the env file).
    const files = fs.readdirSync(path.join(home, '.cc'))
    expect(files.filter(f => f.endsWith('.env'))).toEqual([])
  })
})
