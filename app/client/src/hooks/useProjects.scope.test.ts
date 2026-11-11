import { describe, it, expect } from 'vitest'
import { scopeToQuery, soleWorkspaceOf, ALL_ORGS } from './useProjects'

/**
 * obj 900197. The board's project filter used to exist only in a single-org
 * view; these two pure helpers are what let the same hook serve an org, a
 * multi-select, or the whole All-Organizations board — so they are the part
 * worth pinning down.
 */
describe('scopeToQuery', () => {
  it('returns null (no fetch) when there is no org context', () => {
    expect(scopeToQuery(null)).toBeNull()
    expect(scopeToQuery('all')).toBeNull()
    expect(scopeToQuery([])).toBeNull()
  })

  it('passes a single org straight through', () => {
    expect(scopeToQuery('example')).toBe('example')
  })

  it('joins a multi-select into one comma list', () => {
    expect(scopeToQuery(['example', 'operationkit'])).toBe('example,operationkit')
  })

  it('de-duplicates and drops empties so the URL stays well-formed', () => {
    expect(scopeToQuery(['example', '', 'example', 'ops'])).toBe('example,ops')
  })

  it('asks the server for every accessible org on the All view', () => {
    expect(scopeToQuery(ALL_ORGS)).toBe(ALL_ORGS)
  })

  it('is stable across array identities — a re-render must not refetch', () => {
    expect(scopeToQuery(['example', 'ops'])).toBe(scopeToQuery(['example', 'ops']))
  })
})

describe('soleWorkspaceOf', () => {
  it('resolves the org a create should target', () => {
    expect(soleWorkspaceOf('example')).toBe('example')
    expect(soleWorkspaceOf(['example'])).toBe('example')
  })

  it('is null when the scope spans zero or many orgs, so create must ask', () => {
    expect(soleWorkspaceOf(null)).toBeNull()
    expect(soleWorkspaceOf('all')).toBeNull()
    expect(soleWorkspaceOf(ALL_ORGS)).toBeNull()
    expect(soleWorkspaceOf(['example', 'ops'])).toBeNull()
    expect(soleWorkspaceOf([])).toBeNull()
  })
})
