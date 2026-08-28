import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'
import { promisify } from 'util'

/**
 * Regression test for the defect that made the PR-health watchdog inert in production:
 * the Command Center server runs as root and its `gh` has no auth in the default env, so
 * every `gh pr list` from buildDefaultDeps came back "To get started with GitHub CLI,
 * please run: gh auth login" and the live sweep returned prsScanned:0 with one error per
 * repo. Sessions (and state-poller / external-remediation / ci-feedback-bridge) all
 * authenticate via GH_CONFIG_DIR=/etc/gh; the watchdog must too.
 *
 * This test injects a FAKE execFile via a module mock — it never spawns a process and
 * never reaches real GitHub — and asserts the options the watchdog's exec passes down
 * carry GH_CONFIG_DIR. Without the fix, `opts.env` is undefined and this fails.
 */

const calls: Array<{ file: string; args: string[]; opts: { env?: NodeJS.ProcessEnv } }> = []

vi.mock('child_process', () => {
  const execFile = (
    file: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv },
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    calls.push({ file, args, opts })
    cb(null, '[]', '')
    return undefined as never
  }
  // Make promisify(execFile) resolve to { stdout, stderr } like the real one does.
  ;(execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args: string[],
    opts: { env?: NodeJS.ProcessEnv },
  ) => {
    calls.push({ file, args, opts })
    return Promise.resolve({ stdout: '[]', stderr: '' })
  }
  return { execFile, execSync: () => '', spawn: () => ({ on: () => {} }) }
})

describe('pr-health-watchdog gh auth (buildDefaultDeps)', () => {
  beforeEach(() => { calls.length = 0 })

  it('routes its gh exec through an env carrying GH_CONFIG_DIR=/etc/gh', async () => {
    const { buildDefaultDeps } = await import('./pr-health-watchdog.js')
    const deps = await buildDefaultDeps({} as Database)

    await deps.exec('gh', ['pr', 'list', '--repo', 'your-org/command-center-infra'])

    const ghCall = calls.find(c => c.file === 'gh')
    expect(ghCall, 'the watchdog exec should have shelled out to gh').toBeTruthy()
    expect(ghCall!.opts.env, 'exec must pass an explicit env, not inherit root\'s unauthenticated one').toBeTruthy()
    expect(ghCall!.opts.env!.GH_CONFIG_DIR).toBe('/etc/gh')
  })

  it('still honours an injected fake exec from WatchdogDeps (tests never reach GitHub)', async () => {
    const { buildDefaultDeps } = await import('./pr-health-watchdog.js')
    const fake = vi.fn(async () => '[]')
    const deps = await buildDefaultDeps({} as Database, { exec: fake })

    await deps.exec('gh', ['pr', 'list'])

    expect(fake).toHaveBeenCalledOnce()
    expect(calls.find(c => c.file === 'gh')).toBeUndefined()
  })
})
