import { describe, it, expect } from 'vitest'
import { compileDesignFollowUp, extractPreviewUrls, isHttpUrl, type DesignPin } from './designReview'

describe('isHttpUrl', () => {
  it('accepts http(s) and rejects other schemes', () => {
    expect(isHttpUrl('https://ws-landing-preview.vercel.app')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('extractPreviewUrls', () => {
  it('pulls http(s) links and skips GitHub', () => {
    const urls = extractPreviewUrls(
      'See https://site-2026-git-main.vercel.app/process and https://github.com/your-org/example/pull/19',
    )
    expect(urls).toEqual(['https://site-2026-git-main.vercel.app/process'])
  })
  it('dedupes and strips trailing punctuation', () => {
    expect(extractPreviewUrls('https://a.example/x.', 'https://a.example/x')).toEqual(['https://a.example/x'])
  })
})

describe('compileDesignFollowUp', () => {
  it('returns empty when there are no pins', () => {
    expect(compileDesignFollowUp([])).toBe('')
  })
  it('formats comments and text edits for the session', () => {
    const pins: DesignPin[] = [
      { id: '1', kind: 'comment', selector: 'h1.hero', tag: 'h1', text: 'Buy-side', note: 'Make this smaller' },
      { id: '2', kind: 'text', selector: 'p.lede', tag: 'p', text: 'old', note: '', before: 'old lede', after: 'new lede' },
    ]
    const out = compileDesignFollowUp(pins)
    expect(out).toContain('## Design review')
    expect(out).toContain('h1.hero')
    expect(out).toContain('Make this smaller')
    expect(out).toContain('From: "old lede"')
    expect(out).toContain('To: "new lede"')
  })
})
