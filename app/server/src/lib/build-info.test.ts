import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { __resetBuildInfoForTests, buildCommit, initBuildInfo, resolveCommit } from './build-info.js'

describe('resolveCommit', () => {
  it('prefers the GIT_SHA build arg, shortened to 12 chars', () => {
    expect(resolveCommit({ GIT_SHA: '4212DE2ABCDEF0123456789' }, () => { throw new Error('no git') })).toBe('4212de2abcde')
  })
  it('falls back to git when the build arg is missing or a placeholder', () => {
    expect(resolveCommit({ GIT_SHA: 'unknown' }, () => 'f391704aaaabbbbccccdddd\n')).toBe('f391704aaaab')
    expect(resolveCommit({}, () => 'f391704')).toBe('f391704')
  })
  it('returns null when nothing is known', () => {
    expect(resolveCommit({}, () => { throw new Error('not a repo') })).toBeNull()
    expect(resolveCommit({}, () => 'fatal: not a git repository')).toBeNull()
  })
})

/**
 * obj 900368 — the pin is the point.
 *
 * `/api/health` is the first probe in every deploy runbook, and on a live-checkout
 * install its answer used to come from `git rev-parse HEAD` run at FIRST REQUEST.
 * A process that booted on A and had the checkout moved to B underneath it would
 * answer "B" while still executing A — `tsx` does not hot-reload. These assert the
 * frozen-at-boot behaviour that makes the probe trustworthy.
 */
describe('initBuildInfo — the running commit is pinned at boot', () => {
  beforeEach(() => { __resetBuildInfoForTests() })
  afterAll(() => { __resetBuildInfoForTests() })

  it('resolves once and then freezes: moving the checkout cannot change the answer', () => {
    let head = 'aaaaaaaaaaaa0000'
    const git = () => head
    expect(resolveCommit({}, git)).toBe('aaaaaaaaaaaa')
    // Boot pins it...
    process.env.GIT_SHA = 'aaaaaaaaaaaa0000'
    expect(initBuildInfo()).toBe('aaaaaaaaaaaa')
    // ...the checkout then fast-forwards under a process that never restarted.
    head = 'bbbbbbbbbbbb1111'
    process.env.GIT_SHA = 'bbbbbbbbbbbb1111'
    // The answer must NOT move: this process is still running the old module graph.
    expect(buildCommit()).toBe('aaaaaaaaaaaa')
    delete process.env.GIT_SHA
  })

  it('is idempotent — a second call cannot re-point a live process at newer code', () => {
    process.env.GIT_SHA = 'cccccccccccc2222'
    expect(initBuildInfo()).toBe('cccccccccccc')
    process.env.GIT_SHA = 'dddddddddddd3333'
    expect(initBuildInfo()).toBe('cccccccccccc')
    expect(buildCommit()).toBe('cccccccccccc')
    delete process.env.GIT_SHA
  })

  it('an unknowable commit pins as null rather than retrying on every request', () => {
    delete process.env.GIT_SHA
    // Nothing to assert about the git fallback here beyond it not throwing; the
    // contract is that whatever boot decided is what every later read returns.
    const pinned = initBuildInfo()
    expect(buildCommit()).toBe(pinned)
  })
})
