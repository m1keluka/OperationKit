import { describe, it, expect } from 'vitest'
import {
  JAIL_NAME_PREFIX,
  JAIL_WORKSPACE_PATH,
  JAIL_HOME_PATH,
  DEFAULT_JAIL_IMAGE,
  FORBIDDEN_RUN_FLAGS,
  jailName,
  jailImage,
  jailEnabled,
  resolveIsolationMode,
  buildJailRunArgv,
  buildJailExecArgv,
  buildJailDestroyArgv,
  buildJailAttachCommand,
  renderEnvFile,
  createSessionJailSync,
  destroyJailSync,
} from './session-jail'

const base = {
  objectiveId: 709080,
  sessionId: 'cc-709080-1756400000000',
  worktreePath: '/tmp/cc-worktree-709080',
  homePath: '/tmp/cc-jail-homes/cc-709080-1756400000000',
  image: 'debian:bookworm-slim',
}

/** Values following a `--mount` flag, in order. */
function mounts(argv: string[]): string[] {
  return argv.filter((a, i, all) => all[i - 1] === '--mount')
}

describe('session-jail argv contract', () => {
  it('names the container ok-jail-<objectiveId> and labels it', () => {
    expect(jailName(709080)).toBe('ok-jail-709080')
    expect(JAIL_NAME_PREFIX).toBe('ok-jail-')
    const argv = buildJailRunArgv(base)
    expect(argv).toContain('ok-jail-709080')
    expect(argv).toContain('ok.objective=709080')
    expect(argv).toContain(`ok.session=${base.sessionId}`)
  })

  it('sets --restart no (sessions are one-shot)', () => {
    const argv = buildJailRunArgv(base)
    expect(argv[argv.indexOf('--restart') + 1]).toBe('no')
  })

  it('never mounts the docker socket', () => {
    const argv = buildJailRunArgv(base).join(' ')
    expect(argv).not.toContain('docker.sock')
    expect(argv).not.toContain('/var/run')
  })

  it('never mounts anything from the operator or ccuser homes', () => {
    const argv = buildJailRunArgv(base).join(' ')
    expect(argv).not.toContain('/home/mike')
    expect(argv).not.toContain('/home/ccuser-')
  })

  it('mounts exactly the worktree at /workspace and the session HOME at /home/jailuser', () => {
    expect(mounts(buildJailRunArgv(base))).toEqual([
      `type=bind,source=/tmp/cc-worktree-709080,target=${JAIL_WORKSPACE_PATH},bind-propagation=rprivate`,
      `type=bind,source=/tmp/cc-jail-homes/cc-709080-1756400000000,target=${JAIL_HOME_PATH},bind-propagation=rprivate`,
    ])
    expect(JAIL_WORKSPACE_PATH).toBe('/workspace')
    expect(JAIL_HOME_PATH).toBe('/home/jailuser')
  })

  it('adds no third mount even when an env file is supplied', () => {
    const argv = buildJailRunArgv({ ...base, envFilePath: '/tmp/cc-jail-homes/x/.cc/s.env' })
    expect(mounts(argv)).toHaveLength(2)
    expect(argv[argv.indexOf('--env-file') + 1]).toBe('/tmp/cc-jail-homes/x/.cc/s.env')
  })

  it('drops all capabilities and forbids privilege escalation', () => {
    const argv = buildJailRunArgv(base)
    expect(argv[argv.indexOf('--cap-drop') + 1]).toBe('ALL')
    expect(argv[argv.indexOf('--security-opt') + 1]).toBe('no-new-privileges')
    expect(argv).toContain('--read-only')
  })

  it('carries none of the jail-defeating flags', () => {
    const argv = buildJailRunArgv({ ...base, envFilePath: '/tmp/x.env' })
    for (const flag of FORBIDDEN_RUN_FLAGS) expect(argv).not.toContain(flag)
    expect(argv).not.toContain('--cap-add')
  })

  it('runs as a non-root user and rejects a root override', () => {
    const argv = buildJailRunArgv(base)
    expect(argv[argv.indexOf('--user') + 1]).toBe('1000:1000')
    expect(argv[argv.indexOf('--user') + 1]).not.toBe('0:0')
    expect(buildJailRunArgv({ ...base, user: '1001:1001' })).toContain('1001:1001')
    expect(() => buildJailRunArgv({ ...base, user: '0:0' })).toThrow(/non-root/)
    expect(() => buildJailRunArgv({ ...base, user: 'root' })).toThrow(/non-root/)
  })

  it('rejects ids that could escape into other docker arguments', () => {
    for (const bad of ['../evil', 'a b', '-rm', '', 'a/b']) {
      expect(() => buildJailRunArgv({ ...base, objectiveId: bad })).toThrow()
      expect(() => buildJailRunArgv({ ...base, sessionId: bad })).toThrow()
    }
  })

  it('rejects relative host paths', () => {
    expect(() => buildJailRunArgv({ ...base, worktreePath: 'relative/dir' })).toThrow()
    expect(() => buildJailRunArgv({ ...base, homePath: 'relative/home' })).toThrow()
  })

  it('starts the workdir at /workspace and appends the command after the image', () => {
    const argv = buildJailRunArgv({ ...base, command: ['bash', '-lc', 'tmux new-session'] })
    expect(argv[argv.indexOf('-w') + 1]).toBe(JAIL_WORKSPACE_PATH)
    expect(argv.slice(argv.indexOf(base.image))).toEqual([base.image, 'bash', '-lc', 'tmux new-session'])
  })

  it('builds exec, destroy and attach against the same name', () => {
    expect(buildJailExecArgv(709080, 'ls /workspace')).toEqual(['exec', 'ok-jail-709080', 'sh', '-lc', 'ls /workspace'])
    expect(buildJailDestroyArgv(709080)).toEqual(['rm', '-f', 'ok-jail-709080'])
    expect(buildJailAttachCommand(709080, base.sessionId))
      .toBe(`docker exec -it ok-jail-709080 tmux attach-session -t ${base.sessionId}`)
  })
})

describe('renderEnvFile', () => {
  it('emits KEY=value lines and strips newline injection', () => {
    expect(renderEnvFile({ A: '1', B: 'x\ny' })).toBe('A=1\nB=x y\n')
  })
  it('drops keys that are not valid shell identifiers', () => {
    expect(renderEnvFile({ 'BAD-KEY': '1', OK: '2' })).toBe('OK=2\n')
  })
})

describe('SESSION_ISOLATION flag resolution', () => {
  it('defaults to tmux when unset, empty, or tmux', () => {
    for (const v of [undefined, '', '   ', 'tmux', 'TMUX']) {
      expect(resolveIsolationMode({ SESSION_ISOLATION: v } as NodeJS.ProcessEnv)).toBe('tmux')
      expect(jailEnabled({ SESSION_ISOLATION: v } as NodeJS.ProcessEnv)).toBe(false)
    }
    expect(resolveIsolationMode({} as NodeJS.ProcessEnv)).toBe('tmux')
  })

  it('only `docker` opts in; an unrecognised value stays on the old path', () => {
    expect(resolveIsolationMode({ SESSION_ISOLATION: 'docker' } as NodeJS.ProcessEnv)).toBe('docker')
    expect(resolveIsolationMode({ SESSION_ISOLATION: ' Docker ' } as NodeJS.ProcessEnv)).toBe('docker')
    expect(resolveIsolationMode({ SESSION_ISOLATION: 'podman' } as NodeJS.ProcessEnv)).toBe('tmux')
  })

  it('has no registry default — the image tag is local unless overridden', () => {
    expect(DEFAULT_JAIL_IMAGE).toBe('ok-jail:local')
    expect(DEFAULT_JAIL_IMAGE).not.toContain('ghcr.io')
    expect(jailImage({} as NodeJS.ProcessEnv)).toBe('ok-jail:local')
    expect(jailImage({ SESSION_JAIL_IMAGE: 'ok-jail@sha256:abc' } as NodeJS.ProcessEnv)).toBe('ok-jail@sha256:abc')
  })
})

describe('createSessionJailSync fail-closed', () => {
  it('returns a handle carrying the attach command on success', () => {
    const handle = createSessionJailSync(base, () => 'deadbeefcafebabe0000\n')
    expect(handle.containerName).toBe('ok-jail-709080')
    expect(handle.containerId).toBe('deadbeefcafe')
    expect(handle.attach()).toBe(`docker exec -it ok-jail-709080 tmux attach-session -t ${base.sessionId}`)
  })

  it('THROWS when docker run fails — never falls back to unsandboxed tmux', () => {
    expect(() =>
      createSessionJailSync(base, () => {
        const e = new Error('spawn docker ENOENT') as Error & { stderr: string }
        e.stderr = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'
        throw e
      }),
    ).toThrow(/refusing to fall back to unsandboxed tmux/)
  })

  it('THROWS when docker run prints no container id', () => {
    expect(() => createSessionJailSync(base, () => '   \n')).toThrow(/refusing to fall back to unsandboxed tmux/)
  })
})

describe('destroyJailSync', () => {
  it('is a NO-OP when SESSION_ISOLATION is unset or tmux', () => {
    const calls: string[][] = []
    expect(destroyJailSync(709080, {} as NodeJS.ProcessEnv, (a) => { calls.push(a); return '' })).toBe(false)
    expect(destroyJailSync(709080, { SESSION_ISOLATION: 'tmux' } as NodeJS.ProcessEnv, (a) => { calls.push(a); return '' })).toBe(false)
    expect(calls).toEqual([])
  })

  it('runs an idempotent `docker rm -f` when the flag is docker', () => {
    const calls: string[][] = []
    const env = { SESSION_ISOLATION: 'docker' } as NodeJS.ProcessEnv
    expect(destroyJailSync(709080, env, (a) => { calls.push(a); return '' })).toBe(true)
    expect(calls).toEqual([['rm', '-f', 'ok-jail-709080']])
    // already gone → swallowed, still reports it ran
    expect(destroyJailSync(709080, env, () => { throw new Error('No such container') })).toBe(true)
  })
})
