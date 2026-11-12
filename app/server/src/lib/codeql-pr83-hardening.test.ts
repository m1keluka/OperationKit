// Regression tests for the CodeQL findings raised on public OperationKit sync PR #83
// (obj 900726). Each block pins the fixed behaviour AND that the input class that made
// the old code quadratic / under-escaped now completes or escapes correctly.
import { describe, it, expect } from 'vitest'
import { hasSecretTemplate } from '../../../shared/flow/validate.js'
import { trimTrailingSlashes } from '../services/shared-oauth-app.js'
import { stripTags, htmlToText } from '../services/agent-chat/web-tools.js'
import { mdCell } from '../services/flow-builder.js'
import { md } from '../services/integration-builder.js'
import { resolveTemplates, type FlowEvalScope } from './flow-eval.js'

const OLD_SECRET_RE = /\{\{[^}]*\bsecrets\s*\./

describe('hasSecretTemplate (js/polynomial-redos in shared/flow/validate.ts)', () => {
  const cases = [
    '{{ secrets.API_KEY }}',
    'Bearer {{secrets.X}}',
    '{{ x }} then {{ secrets . y }}',
    '{{ {{ secrets.k',
    '{{ inputs.secrets.k }}',
    '{{ mysecrets.k }}',
    '{{ x }} secrets.k',
    '{{ inputs.a }}',
    'no template here secrets.k',
    '{{ secrets }}',
    '{{',
    '',
  ]
  it.each(cases)('agrees with the old regex on %j', (s) => {
    expect(hasSecretTemplate(s)).toBe(OLD_SECRET_RE.test(s))
  })
  it('is linear on many unclosed `{{` (old regex was quadratic)', () => {
    const evil = '{{'.repeat(200_000) + 'x'
    const t0 = Date.now()
    expect(hasSecretTemplate(evil)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe('trimTrailingSlashes (js/polynomial-redos in shared-oauth-app.ts)', () => {
  it('matches .replace(/\\/+$/, "")', () => {
    for (const s of ['https://a.example/', 'https://a.example///', 'https://a.example', '///', '', 'a/b']) {
      expect(trimTrailingSlashes(s)).toBe(s.replace(/\/+$/, ''))
    }
  })
  it('is linear on many slashes followed by a non-slash', () => {
    const evil = '/'.repeat(200_000) + 'x'
    const t0 = Date.now()
    expect(trimTrailingSlashes(evil)).toBe(evil)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe('stripTags (js/incomplete-multi-character-sanitization in web-tools.ts)', () => {
  it('leaves no tag behind when tags are nested to rebuild one', () => {
    expect(stripTags('<scr<b>ipt>alert(1)</scr</b>ipt>')).not.toMatch(/[<>]/)
    expect(stripTags('a <b>bold</b> c')).toBe('a bold c')
  })
  it('link labels in htmlToText carry no angle brackets', () => {
    const { text } = htmlToText('<p><a href="https://x.example/">click <<b>i>me</a></p>')
    expect(text).toContain('(https://x.example/)')
    expect(text).not.toMatch(/[<>]/)
  })
})

describe('markdown cell escaping (js/incomplete-sanitization in flow/integration builders)', () => {
  for (const [name, fn] of [['mdCell', mdCell], ['md', md]] as const) {
    it(`${name} escapes backslashes before pipes`, () => {
      // Old code turned `a\|b` into `a\\|b`, which renders as `a\` + a column break.
      expect(fn('a\\|b')).toBe('a\\\\\\|b')
      expect(fn('x|y\r\nz')).toBe('x\\|y z')
    })
  }
})

describe('renderTemplateString exact-template check (js/incorrect-suffix-check in flow-eval.ts)', () => {
  const scope: FlowEvalScope = { trigger: { payload: { n: 5 } }, steps: {}, now: () => new Date(0) }
  it('a single `{{ expr }}` keeps the value type', () => {
    expect(resolveTemplates(' {{ trigger.payload.n }} ', scope)).toBe(5)
  })
  it('text around templates still renders to a string', () => {
    expect(resolveTemplates('n={{ trigger.payload.n }}', scope)).toBe('n=5')
    expect(resolveTemplates('{{ trigger.payload.n }}}}', scope)).toBe('5}}')
  })
})
