import { describe, it, expect } from 'vitest'
import { filesFromIntel, mergeAttachments, type TouchedFile } from './touchedFiles'
import type { SessionIntel } from '@operationkit/shared'

function intel(over: Partial<SessionIntel> & Pick<SessionIntel, 'session_id'>): SessionIntel {
  return {
    id: 1,
    objective_id: 1,
    account_id: null,
    started_at: '2026-08-25T10:00:00Z',
    ended_at: '2026-08-25T10:05:00Z',
    duration_ms: 0,
    total_tokens: 0,
    total_cost_usd: 0,
    files_created: [],
    files_modified: [],
    commands_run: 0,
    tool_calls: 0,
    errors: [],
    exit_code: 0,
    summary: null,
    decisions: [],
    blockers: [],
    follow_ups: [],
    skills_used: [],
    agents_invoked: [],
    subagents_spawned: [],
    model_usage: {},
    outcome: 'success',
    extraction_status: 'summarized',
    created_at: '2026-08-25T10:05:00Z',
    ...over,
  }
}

describe('filesFromIntel', () => {
  it('orders by recency and last write wins', () => {
    const rows = [
      intel({
        session_id: 's1',
        ended_at: '2026-08-25T10:00:00Z',
        files_created: ['app/server/src/a.ts'],
        files_modified: ['app/client/src/App.tsx'],
      }),
      intel({
        session_id: 's2',
        ended_at: '2026-08-25T12:00:00Z',
        files_modified: ['app/client/src/App.tsx', 'app/server/src/b.ts'],
      }),
    ]
    const files = filesFromIntel(rows)
    expect(files.map(f => f.path)).toEqual([
      'app/client/src/App.tsx',
      'app/server/src/b.ts',
      'app/server/src/a.ts',
    ])
    expect(files[0].kind).toBe('modified')
    expect(files[0].sessionId).toBe('s2')
  })

  it('parses JSON-string file lists from sqlite', () => {
    const files = filesFromIntel([
      intel({
        session_id: 's1',
        files_modified: JSON.stringify(['foo/bar.ts']) as unknown as string[],
      }),
    ])
    expect(files).toHaveLength(1)
    expect(files[0].name).toBe('bar.ts')
  })
})

describe('mergeAttachments', () => {
  it('keeps dated session files ahead of undated uploads', () => {
    const session: TouchedFile[] = [{
      path: 'src/a.ts', name: 'a.ts', lastTouchedAt: '2026-08-25T12:00:00Z', kind: 'modified',
    }]
    const merged = mergeAttachments(session, [{ name: 'shot.png', path: '/tmp/shot.png' }])
    expect(merged[0].name).toBe('a.ts')
    expect(merged[1].kind).toBe('attachment')
  })
})
