import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { NEUTRAL_GROUNDS } from '@operationkit/shared'
import { brandingSavePayload } from './BrandingPanel'
import { DEFAULT_BRANDING } from '../../hooks/useBranding'

// obj 900750 review fixes: the accent must be the ONE brand lever. A Save must
// not freeze defaults into config/branding.json, and the live preview must
// re-derive every accent-dependent token from the DRAFT accent.

const SRC = path.resolve(__dirname, '..', '..')
const css = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const saved = DEFAULT_BRANDING.tokens
const none = new Set<string>()

describe('brandingSavePayload', () => {
  it('an untouched Save sends no accent / status colour and clears every Auto shade', () => {
    expect(brandingSavePayload({ ...saved }, saved, none, none)).toEqual({
      accentHover: '', accentPress: '', accentFg: '',
    })
  })

  it('changing only the accent sends the accent, never the four status colours', () => {
    const out = brandingSavePayload({ ...saved, accent: '#0D9488' }, saved, none, none)
    expect(out.accent).toBe('#0D9488')
    for (const k of ['verify', 'verifyOnDark', 'caution', 'cautionOnDark']) expect(out).not.toHaveProperty(k)
  })

  it('sends a status colour only when the admin changed it (case-insensitive compare)', () => {
    const out = brandingSavePayload({ ...saved, verify: '#00AA00', caution: saved.caution.toLowerCase() }, saved, none, none)
    expect(out.verify).toBe('#00AA00')
    expect(out).not.toHaveProperty('caution')
  })

  it('sends pinned shades as values and never sends env-locked fields', () => {
    const t = { ...saved, accent: '#0D9488', accentHover: '#123456', verify: '#00AA00' }
    const out = brandingSavePayload(t, saved, new Set(['accentHover']), new Set(['accent', 'verify', 'accentFg']))
    expect(out).toEqual({ accentHover: '#123456', accentPress: '' })
  })
})

describe('LivePreview scope (.brand-scope)', () => {
  const index = css('index.css')
  const block = (selector: string) => {
    const at = index.indexOf(`${selector} {`)
    expect(at, `${selector} block missing`).toBeGreaterThan(-1)
    return index.slice(at, index.indexOf('}', at))
  }

  it('re-declares the accent-derived tokens on the preview element, light and dark', () => {
    const light = block('.brand-scope')
    for (const v of ['--accent-text', '--accent-line', '--accent-tint', '--focus-ring', '--success', '--danger', '--t-success', '--t-danger']) {
      expect(light).toMatch(new RegExp(`${v}:`))
    }
    expect(light).toMatch(/--accent-text:\s*var\(--brand-accent-text,/)
    const dark = block(':root[data-theme="dark"] .brand-scope')
    expect(dark).toMatch(/--accent-text:\s*var\(--brand-accent-text-dark,/)
    for (const v of ['--accent-line', '--accent-tint', '--success', '--danger']) expect(dark).toMatch(new RegExp(`${v}:`))
  })

  it('the preview wrapper carries the scope class', () => {
    expect(css('components/settings/BrandingPanel.tsx')).toMatch(/style=\{style\} className="brand-scope /)
  })
})

describe('neutral grounds mirror index.css', () => {
  const index = css('index.css')
  const light = index.slice(index.indexOf(':root {'), index.indexOf(':root[data-theme="dark"] {'))
  const dark = index.slice(index.indexOf(':root[data-theme="dark"] {'))
  const v = (src: string, name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(src)?.[1]?.toLowerCase()
  const grayLight = (n: string) => v(light, `--gray-${n}`)

  it('hover / pressed / selected grounds used for the accent-text check match the CSS', () => {
    expect(v(light, '--surface-selected')).toBe(NEUTRAL_GROUNDS.light.selected)
    expect(grayLight('100')).toBe(NEUTRAL_GROUNDS.light.hover)
    expect(grayLight('150')).toBe(NEUTRAL_GROUNDS.light.pressed)
    expect(v(dark, '--surface-selected')).toBe(NEUTRAL_GROUNDS.dark.selected)
    expect(v(dark, '--surface-3')).toBe(NEUTRAL_GROUNDS.dark.hover)
    expect(v(dark, '--surface-4')).toBe(NEUTRAL_GROUNDS.dark.pressed)
  })
})

describe('field + docs styling', () => {
  it('read-only fields are excluded from the editable field surface and edit-focus border', () => {
    const index = css('index.css')
    expect(index).toMatch(/\[class\*="bg-surface"\]:not\(:disabled\):not\(\[readonly\]\)/)
    expect(index).toMatch(/\[class\*="bg-transparent"\], \[readonly\]\)\):focus/)
  })

  it('docs links use the AA accent text, and the dark editor shadow stays dark', () => {
    const docs = css('components/docs-page.css')
    expect(docs).toMatch(/\.docs-editor a \{\s*color: var\(--accent-text\)/)
    expect(docs).not.toMatch(/--bn-colors-shadow:[^;]*--ok-ink/)
    expect(docs).not.toMatch(/var\(--accent-hover/)
  })
})
