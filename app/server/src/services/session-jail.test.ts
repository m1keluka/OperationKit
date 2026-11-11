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
  resolveJailNetwork,
  resolveJailCcUpstream,
  buildJailCcForwarderPrefix,
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
    expect(argv).not.toContain('/home/operator')
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

// ── obj 900113: jailed sessions must reach the app at localhost:3002 ──────────
describe('session-jail CC reachability (obj 900113)', () => {
  it('joins SESSION_JAIL_NETWORK when given, default bridge otherwise', () => {
    expect(buildJailRunArgv(base)).not.toContain('--network')
    const argv = buildJailRunArgv({ ...base, network: 'ok-jails' })
    expect(argv[argv.indexOf('--network') + 1]).toBe('ok-jails')
    // still never host networking
    for (const f of FORBIDDEN_RUN_FLAGS) expect(argv).not.toContain(f)
  })

  it('refuses namespace-sharing or default networks', () => {
    for (const bad of ['host', 'none', 'bridge', 'default', 'container:command-center', 'a b', '']) {
      if (bad === '') { expect(resolveJailNetwork({ SESSION_JAIL_NETWORK: bad })).toBe(''); continue }
      expect(() => resolveJailNetwork({ SESSION_JAIL_NETWORK: bad }), bad).toThrow()
      expect(() => buildJailRunArgv({ ...base, network: bad }), bad).toThrow()
    }
    expect(resolveJailNetwork({ SESSION_JAIL_NETWORK: ' ok-jails ' })).toBe('ok-jails')
    expect(resolveJailNetwork({})).toBe('')
  })

  it('resolves the forwarder upstream (default command-center:3002)', () => {
    expect(resolveJailCcUpstream({})).toEqual({ host: 'command-center', port: 3002 })
    expect(resolveJailCcUpstream({ SESSION_JAIL_CC_UPSTREAM: 'cc.internal:8080' })).toEqual({ host: 'cc.internal', port: 8080 })
    for (const bad of ['command-center', 'x:0', 'x:99999', 'a;b:1', 'http://x:1']) {
      expect(() => resolveJailCcUpstream({ SESSION_JAIL_CC_UPSTREAM: bad }), bad).toThrow()
    }
  })

  it('builds a backgrounded loopback forwarder that is a single safe shell word', () => {
    const p = buildJailCcForwarderPrefix({ host: 'command-center', port: 3002 })
    expect(p.startsWith("node -e '")).toBe(true)
    expect(p.endsWith('& ')).toBe(true)
    expect(p).toContain('n.connect(3002,"command-center")')
    expect(p).toContain('.listen(3002,"127.0.0.1")')
    // exactly the opening and closing quote of the -e word
    expect(p.split("'").length - 1).toBe(2)
    expect(() => buildJailCcForwarderPrefix({ host: "x'; rm -rf /", port: 1 })).toThrow()
  })

  it('the forwarder really splices localhost:3002 to the upstream', async () => {
    const net = await import('node:net')
    const { spawn } = await import('node:child_process')
    // stand-in "command-center" on an ephemeral port
    const upstream = net.createServer((s) => s.end('pong-from-cc'))
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()))
    const port = (upstream.address() as { port: number }).port
    const prefix = buildJailCcForwarderPrefix({ host: '127.0.0.1', port })
    // `& ` → run in the foreground of our own shell, then probe it
    const js = prefix.slice("node -e '".length, prefix.indexOf("' >"))
    // Port 3002 may be taken on a dev box; rewrite only the LISTEN port for the test.
    const testJs = js.replace('.listen(3002,', '.listen(0,').replace(
      '.listen(0,"127.0.0.1")', '.listen(0,"127.0.0.1",function(){console.log(this.address().port)})')
    const child = spawn(process.execPath, ['-e', testJs], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      const listenPort = await new Promise<number>((res, rej) => {
        child.stdout.once('data', (d) => res(Number(String(d).trim())))
        child.once('exit', (c) => rej(new Error(`forwarder exited ${c}`)))
      })
      const got = await new Promise<string>((res, rej) => {
        let buf = ''
        const c = net.connect(listenPort, '127.0.0.1')
        c.on('data', (d) => { buf += d })
        c.on('end', () => res(buf))
        c.on('error', rej)
      })
      expect(got).toBe('pong-from-cc')
    } finally {
      child.kill()
      upstream.close()
    }
  })
})
