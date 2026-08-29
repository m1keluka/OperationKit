import { describe, it, expect } from 'vitest'
import { parseConnectScope } from './index.js'

// obj 700082 — the kanban socket is scoped at CONNECT time from the `?workspace=`
// query param so an admin viewing a single workspace never receives other
// workspaces' broadcasts during the pre-`set_view_scope` race window. This proves
// the param parsing that feeds `client.viewedWorkspace` at connection time.
describe('parseConnectScope (obj 700082 connect-time view scope)', () => {
  it('extracts a single-workspace scope from the upgrade URL', () => {
    expect(parseConnectScope('/ws?workspace=example2')).toBe('example2')
  })

  it("treats 'all' as unscoped (see everything, back-compat)", () => {
    expect(parseConnectScope('/ws?workspace=all')).toBeUndefined()
  })

  it('returns undefined when no workspace param is present', () => {
    expect(parseConnectScope('/ws')).toBeUndefined()
    expect(parseConnectScope('/ws?foo=bar')).toBeUndefined()
  })

  it('handles missing/empty/odd urls without throwing', () => {
    expect(parseConnectScope(undefined)).toBeUndefined()
    expect(parseConnectScope('')).toBeUndefined()
    expect(parseConnectScope('/ws?workspace=')).toBeUndefined()
  })

  it('decodes percent-encoded workspace slugs', () => {
    expect(parseConnectScope('/ws?workspace=example-project')).toBe('example-project')
    expect(parseConnectScope('/ws?workspace=example%2Dshop')).toBe('example-shop')
  })
})
