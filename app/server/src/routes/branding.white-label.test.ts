/**
 * White-label rules for the branding module (obj 900543). A client install
 * with its own name or any uploaded mark must never be served the shipped
 * default marks, an upload must be cache-busted, the very first HTML paint
 * must carry the install's own name/favicon, and "Powered by" is OFF unless
 * explicitly enabled.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { findAsset, isWhiteLabeled, resolveAsset, monogramSvg, renderBrandedIndex } from './branding.js'
import { resetBrandingConfig, resolvePoweredBy, writeBrandingConfig, envLockedFields } from '../services/branding-config.js'

function tmpDataDir(): { env: NodeJS.ProcessEnv; dir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'))
  const env = { DB_PATH: path.join(root, 'cc.db') } as NodeJS.ProcessEnv
  const dir = path.join(root, 'branding')
  fs.mkdirSync(dir, { recursive: true })
  return { env, dir }
}

describe('white-label branding (obj 900543)', () => {
  afterEach(() => resetBrandingConfig())

  it('a pristine install is not white-labeled and gets the shipped default marks', () => {
    const { env, dir } = tmpDataDir()
    expect(isWhiteLabeled(env, dir)).toBe(false)
    expect(resolveAsset('wordmark', env, dir)).not.toBeNull()
    expect(resolveAsset('icon', env, dir)).not.toBeNull()
  })

  it('a custom brand name alone suppresses every shipped default mark', () => {
    const { dir } = tmpDataDir()
    const env = { DB_PATH: path.join(path.dirname(dir), 'cc.db'), OK_BRAND_NAME: 'Northwind Ops' } as NodeJS.ProcessEnv
    expect(isWhiteLabeled(env, dir)).toBe(true)
    for (const slot of ['wordmark', 'wordmark-dark', 'icon', 'favicon'] as const) {
      expect(resolveAsset(slot, env, dir)).toBeNull()
    }
  })

  it('uploading only an icon white-labels the install: no default wordmark, icon doubles as favicon', () => {
    const { env, dir } = tmpDataDir()
    fs.writeFileSync(path.join(dir, 'icon.png'), 'png-bytes')
    expect(isWhiteLabeled(env, dir)).toBe(true)
    expect(resolveAsset('wordmark', env, dir)).toBeNull()
    expect(resolveAsset('icon', env, dir)?.file).toBe(path.join(dir, 'icon.png'))
    expect(resolveAsset('favicon', env, dir)?.file).toBe(path.join(dir, 'icon.png'))
    // the default-falling-back lookup is unchanged for back-compat callers
    expect(findAsset('wordmark', dir)).not.toBeNull()
    expect(findAsset('wordmark', dir, false)).toBeNull()
  })

  it('generates a monogram favicon from the brand name + accent, escaping input', () => {
    const svg = monogramSvg('northwind', '#0F766E', '#FFFFFF')
    expect(svg).toContain('fill="#0F766E"')
    expect(svg).toContain('>N</text>')
    expect(monogramSvg('<script>', '#000', '#fff')).not.toContain('<script>')
  })

  it('serves index.html with the install name and the branded favicon route', () => {
    const html = '<head><link rel="icon" href="data:image/svg+xml,xyz" /><title>Operation Kit</title></head>'
    const out = renderBrandedIndex(html, { OK_BRAND_NAME: 'Northwind <Ops>' } as NodeJS.ProcessEnv)
    expect(out).toContain('<title>Northwind &lt;Ops&gt;</title>')
    expect(out).toContain('<link rel="icon" href="/api/branding/favicon" />')
    expect(out).not.toContain('Operation Kit')
  })

  it('"Powered by" is off by default; config or env can turn it on; env locks it', () => {
    expect(resolvePoweredBy({})).toBe(false)
    writeBrandingConfig({ powered_by: true }, {})
    expect(resolvePoweredBy({})).toBe(true)
    expect(resolvePoweredBy({ OK_BRAND_POWERED_BY: '0' })).toBe(false)
    expect(resolvePoweredBy({ OK_BRAND_POWERED_BY: 'true' })).toBe(true)
    expect(envLockedFields({ OK_BRAND_POWERED_BY: '1' })).toContain('powered_by')
  })

  it('keeps powered_by when a later save only changes the name', () => {
    writeBrandingConfig({ powered_by: true }, {})
    writeBrandingConfig({ name: 'Acme OS' }, {})
    expect(resolvePoweredBy({})).toBe(true)
  })
})
