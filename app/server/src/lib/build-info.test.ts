import { describe, expect, it } from 'vitest'
import { resolveCommit } from './build-info.js'

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
