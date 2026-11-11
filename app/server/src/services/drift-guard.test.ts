import { describe, it, expect } from 'vitest'
import { analyzeDrift, type GitState } from './drift-guard.js'

function state(partial: Partial<GitState>): GitState {
  return { porcelain: '', leftRight: '0\t0', fetchOk: true, ok: true, ...partial }
}

describe('analyzeDrift — dirty served paths', () => {
  it('flags a modified file under app/server/src as drift', () => {
    const r = analyzeDrift(state({ porcelain: ' M app/server/src/index.ts' }))
    expect(r.drifted).toBe(true)
    expect(r.dirtyServedFiles).toEqual(['app/server/src/index.ts'])
    expect(r.reasons.join(' ')).toMatch(/SERVED paths/)
  })

  it('flags an UNTRACKED new file under a served path (live-but-unbacked)', () => {
    const r = analyzeDrift(state({ porcelain: '?? app/client/src/NewFeature.tsx' }))
    expect(r.drifted).toBe(true)
    expect(r.dirtyServedFiles).toEqual(['app/client/src/NewFeature.tsx'])
  })

  it('flags staged-and-modified (XY = "MM") served files', () => {
    const r = analyzeDrift(state({ porcelain: 'MM app/shared/types.ts' }))
    expect(r.drifted).toBe(true)
    expect(r.dirtyServedFiles).toEqual(['app/shared/types.ts'])
  })

  it('detects each served prefix', () => {
    const porcelain = [
      ' M app/server/src/a.ts',
      ' M app/client/src/b.tsx',
      ' M app/shared/c.ts',
      ' M app/client/dist/d.js',
    ].join('\n')
    const r = analyzeDrift(state({ porcelain }))
    expect(r.dirtyServedFiles).toHaveLength(4)
    expect(r.drifted).toBe(true)
  })

  it('handles renamed served files (takes the destination path)', () => {
    const r = analyzeDrift(state({ porcelain: 'R  app/server/src/old.ts -> app/server/src/new.ts' }))
    expect(r.dirtyServedFiles).toEqual(['app/server/src/new.ts'])
    expect(r.drifted).toBe(true)
  })
})

describe('analyzeDrift — harmless untracked exclusion (MUST NOT false-trigger)', () => {
  it('ignores untracked scratch scripts outside served paths', () => {
    const r = analyzeDrift(state({ porcelain: '?? scripts/seed-foo.mjs\n?? scripts/tmp.log' }))
    expect(r.drifted).toBe(false)
    expect(r.dirtyServedFiles).toEqual([])
  })

  it('ignores modified non-served tracked files (e.g. README, package-lock)', () => {
    const r = analyzeDrift(state({ porcelain: ' M README.md\n M package-lock.json\n?? notes.txt' }))
    expect(r.drifted).toBe(false)
  })

  it('does NOT match a path that merely contains a served substring elsewhere', () => {
    const r = analyzeDrift(state({ porcelain: '?? docs/app/server/src-notes.md' }))
    expect(r.drifted).toBe(false)
    expect(r.dirtyServedFiles).toEqual([])
  })

  it('a totally clean tree is not drift', () => {
    const r = analyzeDrift(state({ porcelain: '', leftRight: '0\t0' }))
    expect(r.drifted).toBe(false)
    expect(r.reasons).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('mixes harmless untracked with one served edit → flags only the served edit', () => {
    const porcelain = '?? scripts/x.mjs\n M app/server/src/y.ts\n?? out.json'
    const r = analyzeDrift(state({ porcelain }))
    expect(r.drifted).toBe(true)
    expect(r.dirtyServedFiles).toEqual(['app/server/src/y.ts'])
  })
})

describe('analyzeDrift — ahead/behind origin/main', () => {
  it('flags AHEAD (unpushed commits)', () => {
    const r = analyzeDrift(state({ leftRight: '0\t1' }))
    expect(r.drifted).toBe(true)
    expect(r.ahead).toBe(1)
    expect(r.behind).toBe(0)
    expect(r.reasons.join(' ')).toMatch(/AHEAD/)
  })

  it('flags BEHIND (serving stale code)', () => {
    const r = analyzeDrift(state({ leftRight: '3\t0' }))
    expect(r.drifted).toBe(true)
    expect(r.behind).toBe(3)
    expect(r.ahead).toBe(0)
    expect(r.reasons.join(' ')).toMatch(/BEHIND/)
  })

  it('flags diverged (both ahead and behind)', () => {
    const r = analyzeDrift(state({ leftRight: '2\t5' }))
    expect(r.drifted).toBe(true)
    expect(r.behind).toBe(2)
    expect(r.ahead).toBe(5)
  })

  it('notes stale-origin caveat when fetch failed and divergent', () => {
    const r = analyzeDrift(state({ leftRight: '0\t1', fetchOk: false }))
    expect(r.drifted).toBe(true)
    expect(r.reasons.join(' ')).toMatch(/fetch failed/)
  })

  it('clean + in-sync = no drift even when fetch failed', () => {
    const r = analyzeDrift(state({ leftRight: '0\t0', fetchOk: false }))
    expect(r.drifted).toBe(false)
  })
})

describe('analyzeDrift — inconclusive', () => {
  it('git-unqueryable state is inconclusive, not "clean"', () => {
    const r = analyzeDrift(state({ ok: false }))
    expect(r.ok).toBe(false)
    expect(r.drifted).toBe(false)
    expect(r.reasons.join(' ')).toMatch(/inconclusive/)
  })
})
