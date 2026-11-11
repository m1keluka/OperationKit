import { describe, it, expect } from 'vitest'
import { resolveWorktreeChownTarget } from './session-worktree.js'
import { JAIL_UID, JAIL_GID } from './jail-workspace.js'

// obj 900510: ensureWorktree used to chown every freshly-created worktree to
// the literal `ccuser:ccuser` OS account unconditionally. That is correct for
// tmux-mode sessions (which run `runuser -u ccuser`), but a jailed session
// (SESSION_ISOLATION=docker) bind-mounts that same worktree into a sibling
// container that runs as JAIL_UID:JAIL_GID (default 1000:1000) — a different
// OS identity. resolveJailWorkspace's `worktree` branch hands the bind source
// through with no ownership fix of its own (unlike its `scratch` branch), so
// the jail uid got `Permission denied` on every Edit/Write: zero tool calls,
// zero tokens, dead session in seconds — exactly the symptom #900499 hit.
describe('resolveWorktreeChownTarget (obj 900510)', () => {
  it('chowns to the ccuser OS account in default/tmux mode (SESSION_ISOLATION unset)', () => {
    expect(resolveWorktreeChownTarget({})).toBe('ccuser:ccuser')
  })

  it('chowns to the ccuser OS account when SESSION_ISOLATION=tmux explicitly', () => {
    expect(resolveWorktreeChownTarget({ SESSION_ISOLATION: 'tmux' })).toBe('ccuser:ccuser')
  })

  it('chowns to the jail uid:gid (JAIL_UID/JAIL_GID — default 1000:1000) when SESSION_ISOLATION=docker', () => {
    expect(resolveWorktreeChownTarget({ SESSION_ISOLATION: 'docker' })).toBe(`${JAIL_UID}:${JAIL_GID}`)
  })

  it('ignores a garbage SESSION_ISOLATION value and falls back to ccuser (tmux)', () => {
    expect(resolveWorktreeChownTarget({ SESSION_ISOLATION: 'bogus' })).toBe('ccuser:ccuser')
  })
})
