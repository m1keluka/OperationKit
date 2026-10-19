// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DRAFT_TTL_MS,
  MAX_DRAFTS,
  MAX_DRAFT_CHARS,
  draftKey,
  dropDraft,
  pruneDrafts,
  readDraft,
  writeDraft,
} from './composerDrafts'

/** Minimal in-memory Storage — the client test env has no jsdom/localStorage. */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() { return map.size },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, v) },
    removeItem: (k: string) => { map.delete(k) },
    clear: () => { map.clear() },
  } as Storage
}

const NOW = 1_700_000_000_000

describe('draftKey', () => {
  it('namespaces by surface so session 7 and mentor 7 never collide', () => {
    expect(draftKey('session', 7)).not.toBe(draftKey('mentor', 7))
    expect(draftKey('session', 7)).toBe('cc.draft.session.7')
  })
})

describe('write/read round trip', () => {
  it('returns the text typed into the box', () => {
    const s = fakeStorage()
    writeDraft(s, 'k', 'half-written thought', NOW)
    expect(readDraft(s, 'k', NOW)).toBe('half-written thought')
  })

  it('preserves whitespace and newlines inside a non-empty draft', () => {
    const s = fakeStorage()
    writeDraft(s, 'k', 'line one\n\n  indented', NOW)
    expect(readDraft(s, 'k', NOW)).toBe('line one\n\n  indented')
  })

  it('treats an empty or whitespace-only draft as a deletion', () => {
    const s = fakeStorage()
    writeDraft(s, 'k', 'typed', NOW)
    writeDraft(s, 'k', '   \n ', NOW)
    expect(s.getItem('k')).toBeNull()
    expect(readDraft(s, 'k', NOW)).toBe('')
  })

  it('refuses to persist an oversized paste rather than risk the storage quota', () => {
    const s = fakeStorage()
    writeDraft(s, 'k', 'x'.repeat(MAX_DRAFT_CHARS + 1), NOW)
    expect(s.getItem('k')).toBeNull()
  })

  it('returns empty for missing, corrupt, and wrong-shaped entries', () => {
    const s = fakeStorage()
    expect(readDraft(s, 'missing', NOW)).toBe('')
    s.setItem('bad', 'not json')
    expect(readDraft(s, 'bad', NOW)).toBe('')
    s.setItem('shape', JSON.stringify({ text: 42, at: NOW }))
    expect(readDraft(s, 'shape', NOW)).toBe('')
  })

  it('expires a draft older than the TTL and reclaims its key', () => {
    const s = fakeStorage()
    writeDraft(s, 'k', 'stale', NOW)
    expect(readDraft(s, 'k', NOW + DRAFT_TTL_MS + 1)).toBe('')
    expect(s.getItem('k')).toBeNull()
  })

  it('is a no-op when storage is unavailable', () => {
    expect(() => writeDraft(null, 'k', 'x', NOW)).not.toThrow()
    expect(readDraft(null, 'k', NOW)).toBe('')
    expect(() => dropDraft(null, 'k')).not.toThrow()
    expect(pruneDrafts(null, NOW)).toBe(0)
  })

  it('survives a storage that throws (quota exceeded / disabled)', () => {
    const s = { ...fakeStorage(), setItem: () => { throw new Error('QuotaExceededError') } } as unknown as Storage
    expect(() => writeDraft(s, 'k', 'x', NOW)).not.toThrow()
  })
})

describe('dropDraft', () => {
  it('forgets one conversation without touching the others', () => {
    const s = fakeStorage()
    writeDraft(s, draftKey('mentor', 1), 'a', NOW)
    writeDraft(s, draftKey('mentor', 2), 'b', NOW)
    dropDraft(s, draftKey('mentor', 1))
    expect(readDraft(s, draftKey('mentor', 1), NOW)).toBe('')
    expect(readDraft(s, draftKey('mentor', 2), NOW)).toBe('b')
  })
})

describe('pruneDrafts', () => {
  it('sweeps expired drafts and leaves fresh ones alone', () => {
    const s = fakeStorage()
    writeDraft(s, draftKey('session', 1), 'old', NOW - DRAFT_TTL_MS - 1)
    writeDraft(s, draftKey('session', 2), 'fresh', NOW)
    expect(pruneDrafts(s, NOW)).toBe(1)
    expect(readDraft(s, draftKey('session', 1), NOW)).toBe('')
    expect(readDraft(s, draftKey('session', 2), NOW)).toBe('fresh')
  })

  it('caps retained drafts, dropping the oldest first', () => {
    const s = fakeStorage()
    for (let i = 0; i < MAX_DRAFTS + 5; i++) {
      writeDraft(s, draftKey('session', i), `d${i}`, NOW - (MAX_DRAFTS + 5 - i) * 1000)
    }
    expect(pruneDrafts(s, NOW)).toBe(5)
    expect(readDraft(s, draftKey('session', 0), NOW)).toBe('')
    expect(readDraft(s, draftKey('session', 4), NOW)).toBe('')
    expect(readDraft(s, draftKey('session', 5), NOW)).toBe('d5')
    expect(readDraft(s, draftKey('session', MAX_DRAFTS + 4), NOW)).toBe(`d${MAX_DRAFTS + 4}`)
  })

  it('ignores non-draft keys entirely', () => {
    const s = fakeStorage()
    s.setItem('cc.board.showDone', '1')
    s.setItem('cc-project-filter:example', 'all')
    writeDraft(s, draftKey('session', 1), 'old', NOW - DRAFT_TTL_MS - 1)
    pruneDrafts(s, NOW)
    expect(s.getItem('cc.board.showDone')).toBe('1')
    expect(s.getItem('cc-project-filter:example')).toBe('all')
  })

  it('reclaims unparseable draft keys', () => {
    const s = fakeStorage()
    s.setItem('cc.draft.session.junk', '{{{')
    expect(pruneDrafts(s, NOW)).toBe(1)
    expect(s.getItem('cc.draft.session.junk')).toBeNull()
  })
})
