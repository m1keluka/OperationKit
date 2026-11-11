import { describe, it, expect } from 'vitest'
import { sandboxClaudeAuthEnv, sandboxAuthConfigured } from './sandbox-claude-auth.js'
import { resolveHostPathMap, toHostPath, buildJailRunArgv } from './session-jail.js'

describe('sandbox Claude credential (obj 719935)', () => {
  it('is ignored unless the jail is on', () => {
    expect(sandboxClaudeAuthEnv({ SESSION_JAIL_CLAUDE_OAUTH_TOKEN: 'sk-ant-oat-x' })).toEqual({})
    expect(sandboxAuthConfigured({ SESSION_ISOLATION: 'tmux', SESSION_JAIL_CLAUDE_OAUTH_TOKEN: 'sk-ant-oat-x' })).toBe(false)
  })
  it('passes the setup token as CLAUDE_CODE_OAUTH_TOKEN, preferring it over an API key', () => {
    expect(sandboxClaudeAuthEnv({ SESSION_ISOLATION: 'docker', SESSION_JAIL_CLAUDE_OAUTH_TOKEN: ' tok ', SESSION_JAIL_ANTHROPIC_API_KEY: 'key' }))
      .toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' })
  })
  it('falls back to ANTHROPIC_API_KEY', () => {
    expect(sandboxClaudeAuthEnv({ SESSION_ISOLATION: 'docker', SESSION_JAIL_ANTHROPIC_API_KEY: 'key' })).toEqual({ ANTHROPIC_API_KEY: 'key' })
    expect(sandboxAuthConfigured({ SESSION_ISOLATION: 'docker' })).toBe(false)
  })
})

describe('jail host-path translation (obj 719935)', () => {
  const env = { SESSION_JAIL_HOST_PATH_MAP: '/tmp=/opt/ok/state/tmp,/app/data=/opt/ok/state/data,/home/app=/opt/ok/state/home/' }
  const map = resolveHostPathMap(env)
  it('rewrites by longest whole-segment prefix', () => {
    expect(toHostPath('/tmp/cc-worktree-7', map)).toBe('/opt/ok/state/tmp/cc-worktree-7')
    expect(toHostPath('/home/app/ai-workspace', map)).toBe('/opt/ok/state/home/ai-workspace')
    expect(toHostPath('/tmpfoo/x', map)).toBe('/tmpfoo/x')
    expect(toHostPath('/srv/other', map)).toBe('/srv/other')
  })
  it('is identity when unset, and fails closed on a relative entry', () => {
    expect(resolveHostPathMap({})).toEqual([])
    expect(() => resolveHostPathMap({ SESSION_JAIL_HOST_PATH_MAP: 'tmp=/x' })).toThrow()
  })
  it('the docker run argv binds the HOST paths', () => {
    const argv = buildJailRunArgv({ objectiveId: 7, sessionId: 'cc-7-1', worktreePath: '/tmp/cc-worktree-7', homePath: '/tmp/cc-jail-homes/cc-7-1', hostPathMap: map })
    const mounts = argv.filter((_, i) => argv[i - 1] === '--mount')
    expect(mounts[0]).toContain('source=/opt/ok/state/tmp/cc-worktree-7,')
    expect(mounts[1]).toContain('source=/opt/ok/state/tmp/cc-jail-homes/cc-7-1,')
  })
})
