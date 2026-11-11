import { describe, it, expect } from 'vitest'
import { ghExecEnv } from './state-poller.js'

// Objective 1234, root cause #3: the Node server runs as root with HOME=/root and no
// gh auth in its default config dir, so `gh api` (postHarnessStatus) failed with
// "not logged into any GitHub hosts" — the gating harness/test-agent status never
// posted even after the worker committed, opened a PR, and the reviewer PASSed.
// Sessions authenticate via GH_CONFIG_DIR=/etc/gh; ghExecEnv() makes the server's own
// gh calls do the same. These tests lock that contract.
describe('ghExecEnv (server-side gh auth for harness status)', () => {
  it('defaults GH_CONFIG_DIR to /etc/gh when unset', () => {
    const env = ghExecEnv({ PATH: '/usr/bin', HOME: '/root' })
    expect(env.GH_CONFIG_DIR).toBe('/etc/gh')
  })

  it('honors an explicitly set GH_CONFIG_DIR (env override)', () => {
    const env = ghExecEnv({ GH_CONFIG_DIR: '/custom/gh', HOME: '/root' })
    expect(env.GH_CONFIG_DIR).toBe('/custom/gh')
  })

  it('falls back to /etc/gh when GH_CONFIG_DIR is present but empty', () => {
    const env = ghExecEnv({ GH_CONFIG_DIR: '', HOME: '/root' })
    expect(env.GH_CONFIG_DIR).toBe('/etc/gh')
  })

  it('preserves the rest of the base environment', () => {
    const env = ghExecEnv({ PATH: '/usr/bin', HOME: '/root', GH_TOKEN: 'x' })
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/root')
    expect(env.GH_TOKEN).toBe('x')
  })

  it('does not mutate the base environment object', () => {
    const base = { PATH: '/usr/bin' }
    ghExecEnv(base)
    expect('GH_CONFIG_DIR' in base).toBe(false)
  })
})
