/**
 * The pin is only worth having if it cannot drift. The versions live in two
 * files that are built by two different toolchains — browser-pins.ts (what the
 * running server tells sessions to launch) and app/Dockerfile (what is actually
 * installed into the image). If they disagree, the image ships one Chromium and
 * the MCP config asks npx for another, which silently re-introduces the
 * unpinned download this change removed. So: assert they agree, in CI.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  PLAYWRIGHT_VERSION,
  PLAYWRIGHT_MCP_VERSION,
  CHROMIUM_VERSION,
  KNOWN_VULNERABLE_PLAYWRIGHT_BELOW,
} from './browser-pins.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dockerfile = fs.readFileSync(path.resolve(here, '../../../Dockerfile'), 'utf8')

const SEMVER = /^\d+\.\d+\.\d+$/

function arg(name: string): string | null {
  const m = new RegExp(`^ARG\\s+${name}=(\\S+)\\s*$`, 'm').exec(dockerfile)
  return m ? m[1] : null
}

describe('card browser version pins', () => {
  it('declares concrete versions, never a floating tag', () => {
    expect(PLAYWRIGHT_VERSION).toMatch(SEMVER)
    expect(PLAYWRIGHT_MCP_VERSION).toMatch(SEMVER)
    expect(CHROMIUM_VERSION).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
    for (const v of [PLAYWRIGHT_VERSION, PLAYWRIGHT_MCP_VERSION]) {
      expect(v).not.toMatch(/latest|next|alpha|beta|\^|~|\*/)
    }
  })

  it('agrees with the ARGs app/Dockerfile actually installs', () => {
    expect(arg('PLAYWRIGHT_VERSION')).toBe(PLAYWRIGHT_VERSION)
    expect(arg('PLAYWRIGHT_MCP_VERSION')).toBe(PLAYWRIGHT_MCP_VERSION)
  })

  it('never reintroduces an unpinned global install in the image', () => {
    expect(dockerfile).not.toMatch(/npm install -g playwright[\s@]*(@playwright\/mcp)?\s*\\?\s*$/m)
    expect(dockerfile).not.toMatch(/@playwright\/mcp@latest/)
  })

  it('makes the Chromium sandbox helper setuid root for the non-root session user', () => {
    expect(dockerfile).toMatch(/chmod 4755 "\$s"/)
    expect(dockerfile).toMatch(/chrome_sandbox/)
  })

  it('is at or above the first release whose Chromium carries the Chrome 157 security fixes', () => {
    const cmp = (a: string, b: string) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
      }
      return 0
    }
    expect(cmp(PLAYWRIGHT_VERSION, KNOWN_VULNERABLE_PLAYWRIGHT_BELOW)).toBeGreaterThanOrEqual(0)
    // Chromium 157.0.8103.38 is the Chrome stable security release of
    // 2026-11-03; anything we pin must be at least that build.
    expect(cmp(CHROMIUM_VERSION, '157.0.8103.38')).toBeGreaterThanOrEqual(0)
  })
})
