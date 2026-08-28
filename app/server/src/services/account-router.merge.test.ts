import { describe, it, expect } from 'vitest'
import { mergeAccountRecords, type AccountSlot } from './account-router.js'

function slot(over: Partial<AccountSlot> & Pick<AccountSlot, 'id' | 'label'>): AccountSlot {
  return {
    priority: 0,
    homeDir: `/home/ccuser-${over.id}`,
    sessionsToday: 0,
    tokensToday: 0,
    costToday: 0,
    lastRateLimit: null,
    rateLimitResetsAt: null,
    activeSessions: [],
    usageLog: [],
    ...over,
  }
}

const defaults = [
  slot({ id: 'a', label: 'Primary (personal)', priority: 10 }),
  slot({ id: 'b', label: 'Secondary' }),
]

describe('mergeAccountRecords — operator names stick', () => {
  it('keeps customLabel across a reload that would otherwise reset label to Primary/Secondary', () => {
    const saved = [
      slot({ id: 'a', label: 'Primary (personal)', customLabel: 'Mike Max' }),
      slot({ id: 'b', label: 'Secondary', customLabel: 'Ava Team' }),
    ]
    const merged = mergeAccountRecords(defaults, saved)
    expect(merged.find(a => a.id === 'a')?.customLabel).toBe('Mike Max')
    expect(merged.find(a => a.id === 'b')?.customLabel).toBe('Ava Team')
    // Built-in label is restored as the fallback, not the display name.
    expect(merged.find(a => a.id === 'a')?.label).toBe('Primary (personal)')
  })

  it('promotes a saved.label that drifted off the default into customLabel (pre-customLabel renames)', () => {
    const saved = [slot({ id: 'a', label: 'Mike personal' })]
    const merged = mergeAccountRecords(defaults, saved)
    expect(merged.find(a => a.id === 'a')?.customLabel).toBe('Mike personal')
  })

  it('keeps extra slots created via Add Account', () => {
    const saved = [
      slot({ id: 'a', label: 'Primary (personal)' }),
      slot({ id: 'h', label: 'Ava Max', customLabel: 'Ava Max', homeDir: '/app/data/cc-accounts/h' }),
    ]
    const merged = mergeAccountRecords(defaults, saved)
    expect(merged.map(a => a.id)).toEqual(['a', 'b', 'h'])
    expect(merged.find(a => a.id === 'h')?.customLabel).toBe('Ava Max')
    expect(merged.find(a => a.id === 'h')?.homeDir).toBe('/app/data/cc-accounts/h')
  })

  it('keeps a renamed Grok overlay slot across reload', () => {
    const saved = [
      slot({ id: 'a', label: 'Primary (personal)' }),
      slot({ id: 'grok', label: 'Grok (xAI)', customLabel: 'xAI SuperGrok', kind: 'grok', homeDir: '/app/data/cc-accounts/grok' }),
    ]
    const merged = mergeAccountRecords(defaults, saved)
    expect(merged.find(a => a.id === 'grok')?.customLabel).toBe('xAI SuperGrok')
    expect(merged.find(a => a.id === 'grok')?.kind).toBe('grok')
  })
})
