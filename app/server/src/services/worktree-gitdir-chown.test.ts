import { describe, it, expect } from 'vitest'
import { isPrivateWorktreeGitDir } from './session-manager.js'

// Objective 1234: `git worktree add` creates a private admin gitdir at
// <repo>/.git/worktrees/<name>/ holding index/HEAD/logs. ensureWorktree must
// chown THAT (so the ccuser session can write index.lock and commit) but must
// NEVER chown the shared common <repo>/.git (which would hand the whole repo to
// ccuser). isPrivateWorktreeGitDir is the guard that distinguishes them.

describe('isPrivateWorktreeGitDir (chown safety guard, obj 1234)', () => {
  it('TRUE for a per-worktree private admin gitdir (safe to chown)', () => {
    expect(
      isPrivateWorktreeGitDir('/home/operator/projects/command-center-infra/.git/worktrees/cc-worktree-1234'),
    ).toBe(true)
  })

  it('FALSE for the shared common .git dir (must never be chowned)', () => {
    expect(isPrivateWorktreeGitDir('/home/operator/projects/command-center-infra/.git')).toBe(false)
  })

  it('FALSE for a bare-repo style git dir without a worktrees segment', () => {
    expect(isPrivateWorktreeGitDir('/home/operator/projects/command-center-infra/.git/')).toBe(false)
  })

  it('FALSE for empty / null / undefined (rev-parse failure → skip the chown)', () => {
    expect(isPrivateWorktreeGitDir('')).toBe(false)
    expect(isPrivateWorktreeGitDir(null)).toBe(false)
    expect(isPrivateWorktreeGitDir(undefined)).toBe(false)
  })
})
