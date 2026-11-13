import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('renderMarkdown fenced blocks (obj 900750)', () => {
  it('does not leave blank-line <br/>s around a code block', () => {
    const html = renderMarkdown('Before:\n\n```bash\necho hi\n```\n\nAfter.')
    expect(html).toContain('<pre')
    expect(html).not.toMatch(/(<br\/>)+<div class="relative group/)
    expect(html).not.toMatch(/<\/div>(<br\/>)+/)
    expect(html).toContain('After.')
  })

  it('keeps ordinary line breaks in prose', () => {
    expect(renderMarkdown('one\ntwo')).toContain('<br/>')
  })
})
