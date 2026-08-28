// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import type { Objective } from '@command-center/shared'
import {
  ALL_PROJECTS,
  UNASSIGNED_PROJECT,
  matchesProjectFilter,
  loadProjectSelection,
  saveProjectSelection,
} from './projectFilter'

const obj = (project_id: number | null) => ({ project_id }) as Objective

describe('matchesProjectFilter (obj 708826)', () => {
  it('"All projects" shows everything', () => {
    expect(matchesProjectFilter(obj(null), ALL_PROJECTS)).toBe(true)
    expect(matchesProjectFilter(obj(3), ALL_PROJECTS)).toBe(true)
  })

  it('a project id shows only that project’s objectives', () => {
    expect(matchesProjectFilter(obj(3), 3)).toBe(true)
    expect(matchesProjectFilter(obj(4), 3)).toBe(false)
    expect(matchesProjectFilter(obj(null), 3)).toBe(false)
  })

  it('"No project" shows only unassigned objectives', () => {
    expect(matchesProjectFilter(obj(null), UNASSIGNED_PROJECT)).toBe(true)
    expect(matchesProjectFilter(obj(3), UNASSIGNED_PROJECT)).toBe(false)
  })
})

describe('project selection persistence (obj 708826)', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a project id across a "refresh"', () => {
    saveProjectSelection('example', 12)
    expect(loadProjectSelection('example')).toBe(12)
  })

  it('round-trips the sentinels', () => {
    saveProjectSelection('example', ALL_PROJECTS)
    expect(loadProjectSelection('example')).toBe(ALL_PROJECTS)
    saveProjectSelection('example', UNASSIGNED_PROJECT)
    expect(loadProjectSelection('example')).toBe(UNASSIGNED_PROJECT)
  })

  it('is scoped per organization, so switching orgs resets to the default', () => {
    saveProjectSelection('example', 12)
    // A different org key has nothing stored -> caller falls back to All projects.
    expect(loadProjectSelection('example2')).toBeNull()
    // …and the original org still remembers its folder when you switch back.
    expect(loadProjectSelection('example')).toBe(12)
  })

  it('treats a garbage stored value as "nothing stored"', () => {
    localStorage.setItem('cc-project-filter:example', 'not-a-project')
    expect(loadProjectSelection('example')).toBeNull()
  })
})
