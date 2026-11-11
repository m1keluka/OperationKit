import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  brandName, brandingDir, findLogo, findAsset,
} from './branding.js'
import {
  resolveBrandName, resolveBrandTokens, envLockedFields, DEFAULT_BRAND_NAME, DEFAULT_TOKENS,
  writeBrandingConfig, resetBrandingConfig, brandingConfigPath,
} from '../services/branding-config.js'

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
