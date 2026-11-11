/**
 * Theme guard (obj 900543). Light and dark only work if every colour comes from
 * the theme tokens (tailwind.config.ts → index.css). Two things silently break a
 * page in one mode:
 *  - raw Tailwind palette classes (`text-gray-400`, `bg-red-500/10`, `text-white`)
 *    which ignore `<html data-theme>`;
 *  - `dark:` variants, which never fire: the theme lives on `data-theme`, not a
 *    `.dark` class, so the light-mode half is all that ever renders.
 * Data-driven colours (project/label colours passed via `style`) are fine.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const PALETTE =
  /(?:^|[\s"'`])(?:[a-z-]+:)*(?:bg|text|border|ring|from|to|via|divide|placeholder|fill|stroke|outline|decoration|shadow)-(?:gray|zinc|slate|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?:\/\d+)?(?=[\s"'`]|$)/gm
const DARK_VARIANT = /(?:^|[\s"'`])dark:[a-z]/gm

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.tsx?$/.test(e.name) && !/\.test\.|\.fixture\.|Fixture\./.test(e.name) ? [p] : []
  })
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

describe('every colour comes from the theme tokens', () => {
  const files = walk(SRC)

  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('no raw Tailwind palette colour classes', () => {
    const hits = files.flatMap(f => {
      const m = stripComments(fs.readFileSync(f, 'utf8')).match(PALETTE) ?? []
      return m.map(x => `${path.relative(SRC, f)}: ${x.trim()}`)
    })
    expect(hits).toEqual([])
  })

  it('no dark: variants (the theme is data-theme, they never apply)', () => {
    const hits = files.flatMap(f => {
      const m = stripComments(fs.readFileSync(f, 'utf8')).match(DARK_VARIANT) ?? []
      return m.map(x => `${path.relative(SRC, f)}: ${x.trim()}`)
    })
    expect(hits).toEqual([])
  })
})
