/**
 * Accent derivation for white-labeling (obj 900750).
 *
 * The UI is neutral (GitHub-style greys) in both themes; the install's brand
 * is ONE accent colour. Everything else an accent needs — hover / pressed
 * shades, a readable text-on-accent colour, and an accent TEXT colour that
 * stays legible on the light and dark neutral grounds — is derived from that
 * single hex here, so re-branding is "set the accent, upload a logo".
 *
 * Shared by the server (branding-config fills unset hover/press/fg from the
 * accent) and the client (applyBrandTokens sets the per-theme accent-text
 * tokens), so both sides always agree. Pure, dependency-free colour math.
 */

type RGB = [number, number, number]

/** Neutral grounds the accent has to read on (mirror index.css). Every
 * surface an accent-coloured link, icon or selected-row marker can sit on is
 * listed — page/card grounds, hover (surface-3), pressed (surface-4) and the
 * selected row (surface-selected) — so the derived accent text clears 4.5:1
 * on all of them. `ink` is the text colour (the lift target), not a ground. */
export const NEUTRAL_GROUNDS = {
  light: { canvas: '#ffffff', subtle: '#f6f8fa', hover: '#eef1f4', pressed: '#e6eaef', selected: '#e1e6eb', ink: '#1f2328' },
  dark: { canvas: '#0d1117', subtle: '#151b23', raised: '#181f28', hover: '#212830', pressed: '#2a313c', selected: '#2d3540', ink: '#f0f6fc' },
} as const

/** The grounds of a theme the derived accent text must clear 4.5:1 on. */
export function neutralGroundsFor(theme: 'light' | 'dark'): string[] {
  return Object.entries(NEUTRAL_GROUNDS[theme]).filter(([k]) => k !== 'ink').map(([, v]) => v)
}

export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim())
  if (!m) return null
  let h = m[1]
  if (h.length === 3) h = h.split('').map(c => c + c).join('')
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)) as RGB
}

export function toHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** sRGB mix: `p` of `a` + `1-p` of `b` (same maths as CSS color-mix in srgb). */
export function mixHex(a: string, b: string, p: number): string {
  const A = parseHex(a), B = parseHex(b)
  if (!A || !B) return a
  return toHex(A.map((v, i) => v * p + B[i] * (1 - p)) as RGB)
}

export function relativeLuminance(hex: string): number {
  const c = parseHex(hex)
  if (!c) return 0
  const [r, g, b] = c.map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

/** Mixes `color` toward `target` in 5% steps until it reaches `min` contrast on
 * EVERY ground (or hits the target). Keeps as much of the hue as possible. */
function liftUntil(color: string, target: string, grounds: string[], min: number, startAt = 1): string {
  for (let p = startAt; p >= 0; p -= 0.05) {
    const c = mixHex(color, target, p)
    if (grounds.every(g => contrastRatio(c, g) >= min)) return c
  }
  return target.toUpperCase()
}

export interface DerivedAccent {
  /** Hover fill: a touch darker than the accent (both themes). */
  hover: string
  /** Pressed fill: darker again. */
  press: string
  /** Text/icon colour ON the accent fill — white or near-black, whichever reads. */
  fg: string
  /** Accent-coloured text/links/icons on the LIGHT neutral grounds (≥ 4.5:1). */
  textLight: string
  /** Accent-coloured text/links/icons on the DARK neutral grounds (≥ 4.5:1). */
  textDark: string
}

const WHITE = '#FFFFFF'
const NEAR_BLACK = '#1F2328'

/** Everything an install's single accent needs, derived from that one hex. */
export function deriveAccent(accent: string): DerivedAccent {
  const base = parseHex(accent) ? toHex(parseHex(accent)!) : '#2B2BE8'
  const L = NEUTRAL_GROUNDS.light
  // Pick the on-accent foreground with the higher contrast; prefer white when
  // it clears 4.5:1 (it reads crisper on saturated fills, like GitHub's buttons).
  const fg = contrastRatio(WHITE, base) >= 4.5 || contrastRatio(WHITE, base) >= contrastRatio(NEAR_BLACK, base)
    ? WHITE
    : NEAR_BLACK
  return {
    hover: mixHex(base, '#000000', 0.88),
    press: mixHex(base, '#000000', 0.78),
    fg,
    textLight: liftUntil(base, L.ink, neutralGroundsFor('light'), 4.5),
    textDark: liftUntil(base, '#ffffff', neutralGroundsFor('dark'), 4.5, 0.8),
  }
}
