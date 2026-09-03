/**
 * session-jail — sibling-container sandbox for a single Command Center session.
 *
 * Wired behind `SESSION_ISOLATION` (obj 709080 / parent 708982). The flag is
 * OFF by default: unset or `tmux` keeps today's `spawnInTmux` path byte-for-byte.
 * Only `SESSION_ISOLATION=docker` routes a spawn through `createSessionJail`,
 * and that path is fail-closed — a docker failure throws and the session fails.
 * There is no fallback to unsandboxed tmux.
 *
 * The isolation contract below was proven live on GitHub Actions ubuntu-latest
 * by `scripts/session-jail-proof.sh` (obj 709076, PASS=7 FAIL=0) before it was
 * wired here. Changing the argv means re-running that proof.
 *
 * The contract (frozen by PRD §6.2):
 *   - name        `ok-jail-<objectiveId>`
 *   - labels      `ok.objective=<objectiveId>`, `ok.session=<sessionId>`
 *   - restart     `no` — sessions are one-shot; the state poller owns retries
 *   - mounts      ONLY the session's own worktree at /workspace (rw, rprivate)
 *                 and its own per-session HOME at /home/jailuser (rw, rprivate).
 *                 Nothing else from /home/operator. In particular NO
 *                 /var/run/docker.sock and no sibling `ccuser-*` home.
 *   - user        non-root (default uid:gid 1000:1000 = `jailuser`)
 *   - caps        --cap-drop ALL --security-opt no-new-privileges
 *                 never --privileged / --pid=host / --network=host
 *   - network     default bridge; outbound is allowed. This is NOT a network
 *                 jail and must not be described as one.
 *
 * Why a sibling container at all: worktrees + worktree-guard.sh only constrain
 * Claude's Edit/Write tools. A plain `bash` in the shared container still sees
 * the host bind-mounts and (for root) the docker socket. Per-process env
 * scoping cannot drop a mount, so the boundary has to be a separate container.
 */

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const JAIL_NAME_PREFIX = 'ok-jail-'

/** Container-side paths. Frozen by PRD §6.2 — do not drift. */
export const JAIL_WORKSPACE_PATH = '/workspace'
export const JAIL_HOME_PATH = '/home/jailuser'

/**
 * Default image. Deliberately a LOCAL tag, not a registry ref: pushing to
 * ghcr.io is a Mike-reserved open question (PRD §9), so prod code must not
 * imply a pull. Built from `app/jail/Dockerfile`. Override with
 * `SESSION_JAIL_IMAGE`; pin by digest in any real deployment.
 */
export const DEFAULT_JAIL_IMAGE = 'ok-jail:local'

/** Flags that would defeat the jail. Asserted against in the unit tests. */
export const FORBIDDEN_RUN_FLAGS = [
  '--privileged',
  '--pid=host',
  '--network=host',
  '--net=host',
  '--ipc=host',
  '--userns=host',
] as const

export type IsolationMode = 'tmux' | 'docker'

/**
 * Resolve the spawn isolation mode from an env bag.
 *
 * Deliberately NOT a `config.ts` constant: a source-code default of `docker`
 * would silently change Mike's live droplet on the next deploy (PRD §6.6).
 * Unset / empty / `tmux` / anything unrecognised → `tmux` (today's path).
 * OSS and client installs opt in via `.env.example`, a documentation default.
 */
export function resolveIsolationMode(env: NodeJS.ProcessEnv = process.env): IsolationMode {
  return (env.SESSION_ISOLATION || '').trim().toLowerCase() === 'docker' ? 'docker' : 'tmux'
}

/** True when this process should jail spawns. */
export function jailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveIsolationMode(env) === 'docker'
}

export function jailImage(env: NodeJS.ProcessEnv = process.env): string {
  return env.SESSION_JAIL_IMAGE || DEFAULT_JAIL_IMAGE
}

export interface CreateJailOpts {
  /** Objective id. Becomes `ok-jail-<objectiveId>` and the `ok.objective` label. */
  objectiveId: string | number
  /** Session id. Becomes the `ok.session` label and the in-jail tmux session name. */
  sessionId: string
  /** Absolute host path bind-mounted rw at /workspace. The session's worktree. */
  worktreePath: string
  /** Absolute host path bind-mounted rw at /home/jailuser. Per-session HOME. */
  homePath: string
  /** Already-scoped env (output of buildSpawnEnv). Written to an --env-file. */
  env?: Record<string, string>
  /** Host path of the env file to write/pass. Required when `env` is given. */
  envFilePath?: string
  /** Image to run. Defaults to SESSION_JAIL_IMAGE / ok-jail:local. */
  image?: string
  /** Non-root uid:gid inside the jail. Default 1000:1000. */
  user?: string
  /** Command + args run as PID 1 inside the jail. Defaults to the image entrypoint. */
  command?: string[]
}

export interface JailHandle {
  containerId: string
  containerName: string
  sessionId: string
  /** The exact command the terminal bridge runs to attach a PTY. */
  attach(): string
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

function assertJailId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
    throw new Error(`invalid jail id: ${JSON.stringify(id)}`)
  }
}

function assertAbsolute(label: string, dir: string): void {
  if (!dir.startsWith('/') || dir.includes('\0')) {
    throw new Error(`${label} must be an absolute host path, got ${JSON.stringify(dir)}`)
  }
}

export function jailName(id: string | number): string {
  const s = String(id)
  assertJailId(s)
  return `${JAIL_NAME_PREFIX}${s}`
}

/**
 * Build the full `docker run` argv (without the leading "docker").
 * Pure — no side effects — so the isolation contract is unit-testable.
 */
export function buildJailRunArgv(opts: CreateJailOpts): string[] {
  const {
    objectiveId,
    sessionId,
    worktreePath,
    homePath,
    envFilePath,
    image = DEFAULT_JAIL_IMAGE,
    user = '1000:1000',
    command,
  } = opts
  const name = jailName(objectiveId)
  assertJailId(sessionId)
  assertAbsolute('worktreePath', worktreePath)
  assertAbsolute('homePath', homePath)
  if (envFilePath) assertAbsolute('envFilePath', envFilePath)
  if (!image) throw new Error('image is required')
  if (user.split(':')[0] === '0' || user === 'root') {
    throw new Error('jail user must be non-root')
  }

  const argv = [
    'run',
    '-d',
    '--name', name,
    '--label', `ok.objective=${objectiveId}`,
    '--label', `ok.session=${sessionId}`,
    '--restart', 'no',
    '--user', user,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m',
    '--mount', `type=bind,source=${worktreePath},target=${JAIL_WORKSPACE_PATH},bind-propagation=rprivate`,
    '--mount', `type=bind,source=${homePath},target=${JAIL_HOME_PATH},bind-propagation=rprivate`,
  ]
  if (envFilePath) argv.push('--env-file', envFilePath)
  argv.push('-w', JAIL_WORKSPACE_PATH, image)
  if (command?.length) argv.push(...command)
  return argv
}

export function buildJailExecArgv(id: string | number, command: string): string[] {
  return ['exec', jailName(id), 'sh', '-lc', command]
}

export function buildJailDestroyArgv(id: string | number): string[] {
  return ['rm', '-f', jailName(id)]
}

/**
 * The attach string the terminal bridge runs instead of `tmux attach`.
 * tmux lives INSIDE the jail; docker.sock stays in the control plane.
 */
export function buildJailAttachCommand(id: string | number, sessionId: string): string {
  assertJailId(sessionId)
  return `docker exec -it ${jailName(id)} tmux attach-session -t ${sessionId}`
}

/** Serialise a scoped env bag to docker `--env-file` format (KEY=value, one per line). */
export function renderEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    // docker --env-file has no quoting/escaping; a newline would inject a var.
    .map(([k, v]) => `${k}=${String(v ?? '').replace(/[\r\n]+/g, ' ')}`)
    .join('\n') + '\n'
}

/** Injectable synchronous docker runner (tests substitute a fake). */
export type SyncDockerRunner = (argv: string[]) => string

const defaultSyncRunner: SyncDockerRunner = (argv) =>
  execFileSync('docker', argv, { encoding: 'utf8', timeout: 60_000 })

/**
 * Start the jail. FAIL-CLOSED: any docker failure throws. There is deliberately
 * no `catch` that falls back to unsandboxed tmux — a session that asked for a
 * sandbox and did not get one must not run.
 */
export function createSessionJailSync(
  opts: CreateJailOpts,
  runner: SyncDockerRunner = defaultSyncRunner,
): JailHandle {
  const image = opts.image || jailImage()
  const argv = buildJailRunArgv({ ...opts, image })

  if (opts.env && opts.envFilePath) {
    fs.mkdirSync(path.dirname(opts.envFilePath), { recursive: true })
    fs.writeFileSync(opts.envFilePath, renderEnvFile(opts.env), { mode: 0o600 })
  }

  let out: string
  try {
    out = runner(argv)
  } catch (err) {
    // Fail closed. Surface docker's stderr so the operator sees *why*.
    const e = err as { stderr?: Buffer | string; message?: string }
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? ''
    throw new Error(
      `session-jail: docker run failed for ${jailName(opts.objectiveId)} — ` +
      `refusing to fall back to unsandboxed tmux (SESSION_ISOLATION=docker). ` +
      `${(stderr || e.message || '').trim()}`,
    )
  }

  const containerId = out.trim().split('\n').pop()?.trim() || ''
  if (!containerId) {
    throw new Error(
      `session-jail: docker run returned no container id for ${jailName(opts.objectiveId)} — ` +
      `refusing to fall back to unsandboxed tmux.`,
    )
  }
  return {
    containerId: containerId.slice(0, 12),
    containerName: jailName(opts.objectiveId),
    sessionId: opts.sessionId,
    attach: () => buildJailAttachCommand(opts.objectiveId, opts.sessionId),
  }
}

/** Async form of the PRD §6.8 contract. Same fail-closed semantics. */
export async function createSessionJail(opts: CreateJailOpts): Promise<JailHandle> {
  return createSessionJailSync(opts)
}

function run(argv: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('docker', argv, { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
        ? ((err as unknown as { code: number }).code)
        : err
          ? 1
          : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

export async function execInJail(id: string | number, command: string): Promise<ExecResult> {
  return run(buildJailExecArgv(id, command))
}

/**
 * Idempotent `docker rm -f ok-jail-<id>`.
 *
 * NO-OP when SESSION_ISOLATION is unset/tmux: on Mike's live droplet no jail was
 * ever created, and shelling out to `docker rm` on every session stop would be
 * both pointless and noisy. Returns whether it actually ran.
 */
export function destroyJailSync(
  id: string | number,
  env: NodeJS.ProcessEnv = process.env,
  runner: SyncDockerRunner = defaultSyncRunner,
): boolean {
  if (!jailEnabled(env)) return false
  try {
    runner(buildJailDestroyArgv(id))
  } catch {
    // Already gone / never existed — `docker rm -f` on a missing name is not an error we care about.
  }
  return true
}

export async function destroyJail(id: string | number): Promise<void> {
  if (!jailEnabled()) return
  await run(buildJailDestroyArgv(id))
}

/** Back-compat alias used by the proof-era tests/scripts. */
export const destroySessionJail = destroyJail
