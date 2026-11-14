import { describe, it, expect } from 'vitest'
import type { SecretSummary } from '@operationkit/shared'
import { SCOPE_HINTS, SCOPE_HINTS_CREATE, SCOPE_LABELS, scopeDescription } from './scope'
import { scopeSummary } from '../session-viewer/ChatSecretRequest'

/**
 * obj 900758 — the UI says "Workspace", never "Organization" / "Org". Only the
 * DISPLAY strings changed: the wire values stay `global` / `workspace` / `user` /
 * `workspace_user`, which is what the keys of these records are.
 */
const ORG_WORDING = /\bOrgs?\b|organi[sz]ation/i

describe('Secrets scope labels use "Workspace" (obj 900758)', () => {
  it('labels the workspace scopes "Workspace" and "Workspace + User"', () => {
    expect(SCOPE_LABELS).toEqual({
      global: 'Everywhere',
      workspace: 'Workspace',
      user: 'User',
      workspace_user: 'Workspace + User',
    })
  })

  it('keeps the stored scope values unchanged', () => {
    expect(Object.keys(SCOPE_LABELS).sort()).toEqual(['global', 'user', 'workspace', 'workspace_user'])
  })

  it('has no organization wording in any label or hint', () => {
    const copy = [
      ...Object.values(SCOPE_LABELS),
      ...Object.values(SCOPE_HINTS),
      ...Object.values(SCOPE_HINTS_CREATE),
    ]
    for (const line of copy) expect(line).not.toMatch(ORG_WORDING)
    expect(SCOPE_HINTS.workspace).toBe('Applies to everyone working inside this workspace.')
    expect(SCOPE_HINTS_CREATE.workspace).toContain('selected workspace(s)')
  })

  it('describes a row\'s scope in workspace terms', () => {
    const name = (slug: string | null) => (slug === 'example' ? 'Example Growth' : slug ?? '—')
    const user = (id: number | null) => `user-${id}`
    const row = (scopeType: SecretSummary['scopeType']) =>
      ({ scopeType, workspace: 'example', userId: 7 }) as unknown as SecretSummary
    expect(scopeDescription(row('global'), name, user)).toBe('everywhere (every workspace)')
    expect(scopeDescription(row('workspace'), name, user)).toBe('the Example Growth workspace')
  })

  it('words the in-chat scope line in workspace terms', () => {
    expect(scopeSummary('global', 'example')).toBe('Everywhere (every workspace)')
    expect(scopeSummary('workspace_user', '')).toBe('Only me in this workspace')
    expect(scopeSummary('workspace', '')).toBe('this workspace secrets')
  })
})
