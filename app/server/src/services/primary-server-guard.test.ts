import { describe, it, expect } from 'vitest'
import { looksLikeWorktreePath, shouldRefusePrimaryBind } from './primary-server-guard.js'

describe('looksLikeWorktreePath', () => {
  it('matches harness session worktree paths', () => {
    expect(looksLikeWorktreePath('/tmp/cc-wt-2386-provenance/app/server/src/index.ts')).toBe(true)
    expect(looksLikeWorktreePath('file:///tmp/cc-worktree-1029/app/server/src/index.ts')).toBe(true)
    expect(looksLikeWorktreePath('/home/operator/projects/cc-wt-foo/app')).toBe(true)
  })
  it('does NOT match the canonical deployed checkout', () => {
    expect(looksLikeWorktreePath('file:///app/server/src/index.ts')).toBe(false)
    expect(looksLikeWorktreePath('/home/operator/projects/command-center-infra/app/server/src/index.ts')).toBe(false)
  })
})

describe('shouldRefusePrimaryBind', () => {
  const fromWorktree = {
    port: 3002,
    moduleUrl: 'file:///tmp/cc-wt-x/app/server/src/index.ts',
    cwd: '/tmp/cc-wt-x/app/server',
  }
  it('REFUSES the primary port from a worktree (the 13h-zombie scenario)', () => {
    expect(shouldRefusePrimaryBind(fromWorktree)).toBe(true)
  })
  it('ALLOWS the primary port from the deployed checkout', () => {
    expect(shouldRefusePrimaryBind({ port: 3002, moduleUrl: 'file:///app/server/src/index.ts', cwd: '/app' })).toBe(false)
  })
  it('ALLOWS a non-primary (throwaway) port even from a worktree', () => {
    expect(shouldRefusePrimaryBind({ ...fromWorktree, port: 3097 })).toBe(false)
  })
  it('REFUSES when only the cwd indicates a worktree (loader from /app)', () => {
    expect(
      shouldRefusePrimaryBind({ port: 3002, moduleUrl: 'file:///app/server/src/index.ts', cwd: '/tmp/cc-wt-x/app/server' }),
    ).toBe(true)
  })
})
