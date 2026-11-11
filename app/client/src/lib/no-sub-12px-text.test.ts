/**
 * 12px text floor (obj 900543, QA r2 #3 / r3 #6). No client text may be set
 * below 12px — not via a Tailwind arbitrary size (`text-[11px]`), a stock
 * Tailwind size under 12px (`text-[10px]`, `text-2xs`), nor a raw CSS
 * `font-size`. Meta lines, eyebrows and small caps all sit on this floor.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.(tsx?|css)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, '')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

/** Every px size under 12 found in one file, as `line: snippet`. */
export function subFloorSizes(src: string): string[] {
  const hits: string[] = []
  stripComments(src).split('\n').forEach((line, i) => {
    const re = /text-\[(\d+(?:\.\d+)?)px\]|font-size:\s*(\d+(?:\.\d+)?)px|fontSize:\s*['"]?(\d+(?:\.\d+)?)(?:px)?['"]?/g
    for (const m of line.matchAll(re)) {
      const px = parseFloat(m[1] ?? m[2] ?? m[3])
      if (px < 12) hits.push(`${i + 1}: ${m[0]}`)
    }
  })
  return hits
}

describe('12px text floor', () => {
  it('the matcher catches each form and ignores 12px+', () => {
    expect(subFloorSizes('<b className="text-[11px]">')).toHaveLength(1)
    expect(subFloorSizes('.x { font-size: 10.5px; }')).toHaveLength(1)
    expect(subFloorSizes("style={{ fontSize: 11 }}")).toHaveLength(1)
    expect(subFloorSizes('.y { font-size: 12px } <i className="text-[12.5px]">')).toHaveLength(0)
  })

  it('no client source sets text below 12px', () => {
    const files = walk(SRC)
    expect(files.length).toBeGreaterThan(50)
    const bad = files.flatMap(f => subFloorSizes(fs.readFileSync(f, 'utf8')).map(h => `${path.relative(SRC, f)}:${h}`))
    expect(bad).toEqual([])
  })
})
