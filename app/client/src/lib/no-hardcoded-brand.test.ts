/**
 * White-label guard (obj 900543). Anything a client user can see must come
 * from the branding module (useBranding / BrandLogo), never a literal product
 * name or a hardcoded logo glyph. Comments are ignored; the shipped default
 * lives in exactly one place (hooks/useBranding.ts DEFAULT_BRAND_NAME).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const ALLOW = new Set([
  path.join('hooks', 'useBranding.ts'), // the single default-brand constant
])
// Case-sensitive on purpose: the public mirror renames the npm scope to
// `@operationkit/*` (scripts/oss-genericize.sh), which is a package name, not UI text.
const BRAND = /Operation\s?Kit|Command Center/

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(tsx?|css)$/.test(e.name) && !/\.test\.|\.fixture\./.test(e.name) ? [p] : []
  })
}

/** Strip // and block comments (incl. JSX {/* *\/}) so prose about the brand in comments doesn't count. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

describe('no hardcoded brand in user-facing client code', () => {
  const files = walk(SRC)

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('has no literal product name outside the branding module', () => {
    const hits: string[] = []
    for (const f of files) {
      const rel = path.relative(SRC, f)
      if (ALLOW.has(rel)) continue
      stripComments(fs.readFileSync(f, 'utf8')).split('\n').forEach((line, i) => {
        if (BRAND.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(hits).toEqual([])
  })

  it('the header renders the branding logo, not a hardcoded mark', () => {
    const layout = fs.readFileSync(path.join(SRC, 'components', 'Layout.tsx'), 'utf8')
    expect(layout).toContain('<BrandLogo')
    expect(layout).not.toMatch(/aria-label="[^"]*"[^>]*>›<\/a>/)
  })

  it('index.html paints a neutral placeholder, not a brand glyph or a default favicon', () => {
    const html = fs.readFileSync(path.resolve(SRC, '..', 'index.html'), 'utf8')
    expect(html).not.toContain('&#8250;')
    expect(html).toContain('href="/api/branding/favicon"')
  })
})
