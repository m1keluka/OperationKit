import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { brandName, brandingDir, findLogo } from './branding.js'

describe('branding (obj 719935)', () => {
  it('defaults the name and trims a configured one', () => {
    expect(brandName({})).toBe('OperationKit')
    expect(brandName({ OK_BRAND_NAME: '  Example Capital OS ' })).toBe('Example Capital OS')
  })
  it('keeps the logo next to the database', () => {
    expect(brandingDir({ DB_PATH: '/srv/data/cc.db' })).toBe('/srv/data/branding')
  })
  it('finds an svg or png logo, else null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-'))
    expect(findLogo(dir)).toBeNull()
    fs.writeFileSync(path.join(dir, 'logo.png'), 'x')
    expect(findLogo(dir)?.type).toBe('image/png')
    fs.rmSync(dir, { recursive: true })
  })
})
