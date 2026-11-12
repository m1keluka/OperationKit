import { describe, it, expect, vi } from 'vitest'

// Layout pulls in the board theme provider and branding; only the pure path
// rule is under test here.
vi.mock('../preview/BoardShell', () => ({ useBoardTheme: () => ({ theme: 'light', toggleTheme: () => {} }) }))

import { isOrgScopedPath } from './Layout'

describe('isOrgScopedPath — where the top-bar org switcher shows (obj 900666)', () => {
  it.each(['/', '/w/acme', '/o/42', '/archive', '/knowledge', '/knowledge/setup', '/jobs', '/agents'])(
    'shows on %s (the page reads the org selection)', path => {
      expect(isOrgScopedPath(path)).toBe(true)
    },
  )
  it.each(['/settings', '/settings/org', '/system', '/chat'])(
    'hides on %s (the page ignores it)', path => {
      expect(isOrgScopedPath(path)).toBe(false)
    },
  )
})
