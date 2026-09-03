// @vitest-environment jsdom
/**
 * Tests the member-workspace-clamp useEffect introduced in App.tsx (obj 708893).
 *
 * The bug: the useState initialiser in AppContent ran when user was still null
 * (AuthContext fetches /api/auth/me in a useEffect), so the member clamp was
 * dead code on first load.  The fix adds a dedicated useEffect that fires once
 * user resolves and clamps selectedWorkspaces to the member's allowed orgs.
 *
 * We test the effect in a minimal harness that contains the exact same logic,
 * verifying the observable outcome (localStorage changes + rendered workspace).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useState, useEffect } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { User, Workspace } from '@operationkit/shared'

async function flush() {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
    await Promise.resolve()
  }
}

// ── Helpers mirroring App.tsx ─────────────────────────────────────────────────

function workspaceFromPath(pathname: string): Workspace | null {
  const match = pathname.match(/^\/w\/([a-z0-9][a-z0-9-]{0,40})\/?$/)
  if (!match) return null
  return match[1] as Workspace
}

/**
 * Minimal harness containing ONLY the selectedWorkspaces state + the
 * member-clamp useEffect from App.tsx.  This isolates the effect's behaviour
 * for testing without pulling in the full component tree.
 */
function ClampHarness({
  initialUser,
  initial = [],
  onSelected,
}: {
  initialUser: User | null
  initial?: Workspace[]
  onSelected?: (ws: Workspace[]) => void
}) {
  const [user, setUser] = useState<User | null>(initialUser)
  const [selected, setSelected] = useState<Workspace[]>(initial)

  // Exact copy of the member-clamp effect from App.tsx
  useEffect(() => {
    if (!user || user.role === 'admin') return
    const allowed = (user.workspaces ?? []).map(w => w.workspace)
    if (!allowed.length) return
    setSelected(prev => {
      const fromPath = workspaceFromPath(window.location.pathname)
      if (fromPath) return prev
      const clamped = prev.filter(w => allowed.includes(w))
      if (clamped.length > 0 && clamped.length === prev.length) return prev
      const next: Workspace[] = clamped.length > 0 ? clamped : [allowed[0] as Workspace]
      localStorage.setItem('cc-workspaces', JSON.stringify(next))
      localStorage.setItem('cc-workspace', next.length === 1 ? next[0] : 'all')
      return next
    })
  }, [user])

  // Expose selected as JSON for inspection + fire callback for assertions.
  useEffect(() => {
    onSelected?.(selected)
  }, [selected, onSelected])

  return (
    <div>
      <div data-testid="selected">{JSON.stringify(selected)}</div>
      <button
        data-testid="resolve"
        onClick={() => {
          const member: User = {
            id: 2,
            username: 'ava',
            role: 'member',
            workspaces: [{ workspace: 'example', role: 'member' }],
            created_at: '2026-01-01T00:00:00Z',
          }
          setUser(member)
        }}
      >
        resolve user
      </button>
    </div>
  )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('App.tsx — member-workspace clamp effect (obj 708893)', () => {
  let container: HTMLElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  function getSelected(): Workspace[] {
    const el = container.querySelector('[data-testid="selected"]') as HTMLElement
    return JSON.parse(el?.textContent ?? '[]') as Workspace[]
  }

  function click(testId: string) {
    const el = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement
    flushSync(() => el?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  }

  it('a non-admin with one org is clamped to that org after auth resolves', async () => {
    // Initially: user = null, selectedWorkspaces = []
    flushSync(() => root.render(<ClampHarness initialUser={null} />))
    await flush()
    expect(getSelected()).toEqual([])

    // Auth resolves: member with one org 'example'
    click('resolve')
    await flush()

    expect(getSelected()).toEqual(['example'])
    expect(localStorage.getItem('cc-workspaces')).toBe('["example"]')
    expect(localStorage.getItem('cc-workspace')).toBe('example')
  })

  it('a member with an invalid stored selection is clamped to their own org', async () => {
    // Simulates a user who had 'example2' stored but is only a member of 'example'
    flushSync(() => root.render(
      <ClampHarness initialUser={null} initial={['example2' as Workspace]} />
    ))
    await flush()
    expect(getSelected()).toEqual(['example2'])

    click('resolve')
    await flush()

    // 'example2' is not in ['example'] → clamped to ['example']
    expect(getSelected()).toEqual(['example'])
  })

  it('a member already on the correct org is not unnecessarily re-set', async () => {
    flushSync(() => root.render(
      <ClampHarness initialUser={null} initial={['example' as Workspace]} />
    ))
    await flush()
    click('resolve')
    await flush()

    // Already correct — selection stays, localStorage write does NOT fire.
    expect(getSelected()).toEqual(['example'])
    // The effect exits early (clamped.length === prev.length) so localStorage is clean.
    expect(localStorage.getItem('cc-workspaces')).toBeNull()
  })

  it('admin is unaffected — selectedWorkspaces stays as initialised', async () => {
    const admin: User = {
      id: 1,
      username: 'mike',
      role: 'admin',
      workspaces: [],
      created_at: '2026-01-01T00:00:00Z',
    }
    // Start with admin already resolved — effect should NOT clamp.
    flushSync(() => root.render(
      <ClampHarness initialUser={admin} initial={[]} />
    ))
    await flush()

    // Admin stays on [] (All orgs) — no clamp fires.
    expect(getSelected()).toEqual([])
    expect(localStorage.getItem('cc-workspaces')).toBeNull()
  })
})
