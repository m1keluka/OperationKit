import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  brandName, brandingDir, findLogo, findAsset,
} from './branding.js'
import {
  resolveBrandName, resolveBrandTokens, envLockedFields, DEFAULT_BRAND_NAME, DEFAULT_TOKENS,
  writeBrandingConfig, resetBrandingConfig, brandingConfigPath, explicitTokenFields,
  LEGACY_DEFAULT_TOKENS, hexOrUndefined,
} from '../services/branding-config.js'
import { deriveAccent, contrastRatio, NEUTRAL_GROUNDS, neutralGroundsFor } from '@operationkit/shared'

describe('branding (obj 719935, extended obj 900494)', () => {
  afterEach(() => resetBrandingConfig())

  it('defaults the name to Operation Kit and trims a configured one', () => {
    expect(brandName({})).toBe('Operation Kit')
    expect(brandName({ OK_BRAND_NAME: '  Example Capital OS ' })).toBe('Example Capital OS')
    expect(resolveBrandName({})).toBe(DEFAULT_BRAND_NAME)
  })
  it('keeps uploaded logos next to the database', () => {
    expect(brandingDir({ DB_PATH: '/srv/data/cc.db' })).toBe('/srv/data/branding')
  })
  it('finds an svg or png logo in a data dir, else falls back to the shipped default', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'))
    // No admin upload yet — falls back to the shipped OK default wordmark/icon.
    expect(findLogo(dir)).not.toBeNull()
    fs.writeFileSync(path.join(dir, 'wordmark.png'), 'x')
    expect(findAsset('wordmark', dir)?.type).toBe('image/png')
    fs.rmSync(dir, { recursive: true })
  })
  it('resolves default OK v1.0 tokens with no overrides', () => {
    expect(resolveBrandTokens({})).toEqual(DEFAULT_TOKENS)
  })
  it('env vars win over the config file, and are reported as locked', () => {
    writeBrandingConfig({ tokens: { accent: '#111111' } }, {})
    expect(resolveBrandTokens({}).accent).toBe('#111111')
    expect(resolveBrandTokens({ OK_BRAND_ACCENT: '#222222' }).accent).toBe('#222222')
    expect(envLockedFields({ OK_BRAND_ACCENT: '#222222' })).toContain('accent')
  })
  it('rejects a non-hex accent value and keeps the previous one', () => {
    writeBrandingConfig({ tokens: { accent: '#333333' } }, {})
    writeBrandingConfig({ tokens: { accent: 'javascript:alert(1)' } }, {})
    expect(resolveBrandTokens({}).accent).toBe('#333333')
  })
  it('resets to defaults by deleting the config file', () => {
    writeBrandingConfig({ name: 'Acme OS' }, {})
    expect(resolveBrandName({})).toBe('Acme OS')
    resetBrandingConfig()
    expect(resolveBrandName({})).toBe(DEFAULT_BRAND_NAME)
    expect(fs.existsSync(brandingConfigPath())).toBe(false)
  })
})

describe('single-accent white-label (obj 900750)', () => {
  afterEach(() => resetBrandingConfig())

  it('derives hover / pressed / text-on-accent from a custom accent', () => {
    const t = resolveBrandTokens({ OK_BRAND_ACCENT: '#E11D48' })
    expect(t.accent).toBe('#E11D48')
    // never the default brand's shades next to a custom accent
    expect(t.accentHover).not.toBe(DEFAULT_TOKENS.accentHover)
    expect(t.accentPress).not.toBe(DEFAULT_TOKENS.accentPress)
    expect(t.accentHover).toBe(deriveAccent('#E11D48').hover)
    expect(t.accentPress).toBe(deriveAccent('#E11D48').press)
  })

  it('picks a dark text-on-accent for a light accent and white for a dark one', () => {
    expect(resolveBrandTokens({ OK_BRAND_ACCENT: '#FFC400' }).accentFg).toBe('#1F2328')
    expect(resolveBrandTokens({ OK_BRAND_ACCENT: '#1565C0' }).accentFg).toBe('#FFFFFF')
    for (const a of ['#FFC400', '#16A34A', '#EA580C', '#1565C0', '#7C3AED']) {
      const t = resolveBrandTokens({ OK_BRAND_ACCENT: a })
      expect(contrastRatio(t.accentFg, a)).toBeGreaterThanOrEqual(2.9)
    }
  })

  it('an explicit shade still wins over the derived one', () => {
    const t = resolveBrandTokens({ OK_BRAND_ACCENT: '#E11D48', OK_BRAND_ACCENT_HOVER: '#123456' })
    expect(t.accentHover).toBe('#123456')
    expect(explicitTokenFields({ OK_BRAND_ACCENT: '#E11D48', OK_BRAND_ACCENT_HOVER: '#123456' }))
      .toEqual(['accent', 'accentHover'])
  })

  it('a config-file accent alone is enough; clearing an override returns it to derived', () => {
    writeBrandingConfig({ tokens: { accent: '#0D9488', accentHover: '#000000' } }, {})
    expect(resolveBrandTokens({}).accentHover).toBe('#000000')
    writeBrandingConfig({ tokens: { accentHover: '' } }, {})
    expect(resolveBrandTokens({}).accentHover).toBe(deriveAccent('#0D9488').hover)
    expect(explicitTokenFields({})).toEqual(['accent'])
  })

  it('every derived accent text colour clears AA on EVERY neutral ground (incl. hover, pressed, selected) in both themes', () => {
    // The ground list must cover the hover / pressed / selected rows, not just page + card.
    expect(neutralGroundsFor('light')).toEqual(expect.arrayContaining([NEUTRAL_GROUNDS.light.hover, NEUTRAL_GROUNDS.light.pressed, NEUTRAL_GROUNDS.light.selected]))
    expect(neutralGroundsFor('dark')).toEqual(expect.arrayContaining([NEUTRAL_GROUNDS.dark.hover, NEUTRAL_GROUNDS.dark.pressed, NEUTRAL_GROUNDS.dark.selected]))
    expect(neutralGroundsFor('light')).not.toContain(NEUTRAL_GROUNDS.light.ink)
    for (const a of ['#2B2BE8', '#FFC400', '#16A34A', '#EA580C', '#E11D48', '#0D9488', '#7C3AED', '#38BDF8', '#000000', '#FFFFFF', '#808080']) {
      const d = deriveAccent(a)
      for (const g of neutralGroundsFor('light')) expect(contrastRatio(d.textLight, g)).toBeGreaterThanOrEqual(4.5)
      for (const g of neutralGroundsFor('dark')) expect(contrastRatio(d.textDark, g)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('selected rows stay distinguishable from hover in both themes', () => {
    expect(contrastRatio(NEUTRAL_GROUNDS.light.selected, NEUTRAL_GROUNDS.light.hover)).toBeGreaterThanOrEqual(1.1)
    expect(contrastRatio(NEUTRAL_GROUNDS.dark.selected, NEUTRAL_GROUNDS.dark.hover)).toBeGreaterThanOrEqual(1.1)
  })

  it('accepts only strict #rgb / #rrggbb hex', () => {
    for (const ok of ['#abc', '#ABCDEF', ' #123456 ']) expect(hexOrUndefined(ok)).toBe(ok.trim())
    for (const bad of ['#abcd', '#abcde', '#abcdeff', '#abcdef12', 'abcdef', '#ggg', 'red', '', undefined]) expect(hexOrUndefined(bad)).toBeUndefined()
    // An 8-digit (alpha) env value is rejected, so the default is used.
    expect(resolveBrandTokens({ OK_BRAND_ACCENT: '#E11D4880' }).accent).toBe(DEFAULT_TOKENS.accent)
  })

  describe('legacy config/branding.json (pre-obj-900750 panel saved all 8 tokens)', () => {
    const LEGACY_FILE = {
      name: 'Acme',
      tokens: {
        accent: '#2B2BE8', accentHover: '#2727C9', accentPress: '#2323A9', accentFg: '#F3F0E8',
        verify: '#0B7643', verifyOnDark: '#63D18F', caution: '#BD321B', cautionOnDark: '#F47D67',
      },
    }
    const writeRaw = (obj: unknown) => {
      fs.mkdirSync(path.dirname(brandingConfigPath()), { recursive: true })
      fs.writeFileSync(brandingConfigPath(), JSON.stringify(obj))
    }

    it('treats the old shipped defaults as unset: resolves to the current defaults, nothing pinned', () => {
      writeRaw(LEGACY_FILE)
      expect(resolveBrandTokens({})).toEqual(DEFAULT_TOKENS)
      expect(explicitTokenFields({})).toEqual(['accent'])
    })

    it('changing ONLY the accent re-derives hover / pressed / text-on-accent despite the legacy values', () => {
      writeRaw({ ...LEGACY_FILE, tokens: { ...LEGACY_FILE.tokens, accent: '#0D9488' } })
      const t = resolveBrandTokens({})
      const d = deriveAccent('#0D9488')
      expect(t.accent).toBe('#0D9488')
      expect(t.accentHover).toBe(d.hover)
      expect(t.accentPress).toBe(d.press)
      expect(t.accentFg).toBe(d.fg)
      expect(t.accentFg).not.toBe('#F3F0E8')
      expect(t.verify).toBe(DEFAULT_TOKENS.verify)
      expect(t.cautionOnDark).toBe(DEFAULT_TOKENS.cautionOnDark)
    })

    it('matches legacy values case-insensitively', () => {
      writeRaw({ tokens: { accent: '#0D9488', accentFg: '#f3f0e8', verify: '#0b7643' } })
      expect(resolveBrandTokens({}).accentFg).toBe(deriveAccent('#0D9488').fg)
      expect(resolveBrandTokens({}).verify).toBe(DEFAULT_TOKENS.verify)
    })

    it('keeps a value the admin deliberately customised', () => {
      writeRaw({ tokens: { ...LEGACY_FILE.tokens, accent: '#0D9488', accentHover: '#123456', verify: '#00AA00' } })
      const t = resolveBrandTokens({})
      expect(t.accentHover).toBe('#123456')
      expect(t.verify).toBe('#00AA00')
      expect(explicitTokenFields({}).sort()).toEqual(['accent', 'accentHover', 'verify'])
    })

    it('the next Save rewrites the file without the legacy defaults', () => {
      writeRaw(LEGACY_FILE)
      writeBrandingConfig({ tokens: { accent: '#7C3AED' } }, {})
      const onDisk = JSON.parse(fs.readFileSync(brandingConfigPath(), 'utf-8'))
      expect(onDisk.name).toBe('Acme')
      expect(onDisk.tokens).toEqual({ accent: '#7C3AED' })
      for (const v of Object.values(LEGACY_DEFAULT_TOKENS)) expect(JSON.stringify(onDisk)).not.toContain(v as string)
    })

    it('never filters env vars, even when they hold a legacy value', () => {
      expect(resolveBrandTokens({ OK_BRAND_ACCENT_FG: '#F3F0E8' }).accentFg).toBe('#F3F0E8')
    })
  })

  // config/ is stripped from the public OSS mirror (scripts/oss-strip-paths.txt
  // `prefix:config/`), so the example only exists in the private repo.
  const examplePath = path.join(path.dirname(brandingConfigPath()), 'branding.json.example')
  it.skipIf(!fs.existsSync(examplePath))('the checked-in example sets only name + accent', () => {
    const example = JSON.parse(fs.readFileSync(examplePath, 'utf-8'))
    expect(Object.keys(example).filter(k => !k.startsWith('_')).sort()).toEqual(['name', 'tokens'])
    expect(Object.keys(example.tokens)).toEqual(['accent'])
  })
})
