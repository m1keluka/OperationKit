import type { Config } from 'tailwindcss'

/**
 * Every theme colour is a CSS custom property, and Tailwind 3 cannot apply an
 * opacity modifier to a bare `var(--x)` — so `bg-accent/10`,
 * `border-status-done/25` etc. (260+ uses) silently generated NO CSS, which
 * left tints missing and borders falling back to the text colour (the harsh
 * white outlines on dark). Wrapping each colour in color-mix with
 * <alpha-value> makes every modifier work in both themes (obj 900543).
 */
function alpha(cssVar: string): string {
  return `color-mix(in srgb, ${cssVar} calc(<alpha-value> * 100%), transparent)`
}
function withAlpha<T>(v: T): T {
  if (typeof v === 'string') return (v.startsWith('var(') ? alpha(v) : v) as T
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, withAlpha(x)])) as T
  }
  return v
}

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: withAlpha({
        // Every color below resolves a CSS custom property defined in index.css
        // (default = Operation Kit brand, light + dark via [data-theme]). A
        // fresh install re-brands by changing those custom properties
        // (OK_BRAND_ACCENT / config/branding.json / Settings > Branding) —
        // never by editing this file. See docs/branding.md.
        surface: {
          0: 'var(--surface-0)',
          1: 'var(--surface-1)',
          2: 'var(--surface-2)',
          3: 'var(--surface-3)',
          4: 'var(--surface-4)',
          DEFAULT: 'var(--surface-0)',
          raised: 'var(--surface-1)',
          overlay: 'var(--surface-2)',
          selected: 'var(--surface-selected)',
        },
        fg: {
          0: 'var(--fg-0)',
          1: 'var(--fg-1)',
          2: 'var(--fg-2)',
          3: 'var(--fg-3)',
        },
        line: {
          DEFAULT: 'var(--line)',
          soft: 'var(--line-soft)',
          strong: 'var(--line-strong)',
        },
        // legacy alias: `border-border`, `border-border-hover` still resolve.
        border: {
          DEFAULT: 'var(--line)',
          hover: 'var(--line-strong)',
        },
        // the one accent — default Ultramarine, configurable per install.
        accent: {
          DEFAULT: 'var(--accent)',
          hover: 'var(--accent-hover)',
          press: 'var(--accent-press)',
          fg: 'var(--accent-fg)',
        },
        // §04 status pipeline — collapsed to one accent + status green/amber.
        // human = accent (needs-you), done = verify-green; machine states stay cool.
        status: {
          planning: 'var(--st-planning)',
          queue: 'var(--st-queue)',
          working: 'var(--st-working)',
          ai: 'var(--st-ai)',
          review: 'var(--st-review)',
          human: 'var(--st-human)',
          done: 'var(--st-done)',
          cancelled: 'var(--st-cancelled)',
        },
        // §04 orthogonal flags — red/caution is reserved for `blocked` only.
        flag: {
          blocked: 'var(--ok-alarm)',
          live: 'var(--ok-verify)',
        },
        // semantic status triad (color carries meaning)
        signal: {
          verify: 'var(--ok-verify)',
          amber: 'var(--ok-amber)',
          alarm: 'var(--ok-alarm)',
        },
        // §05 agent identity — desaturated on purpose; routes don't compete with status.
        agent: {
          cto: 'var(--agent-cto)',
          cmo: 'var(--agent-cmo)',
          coo: 'var(--agent-coo)',
          cfo: 'var(--agent-cfo)',
          general: 'var(--agent-general)',
        },
      }),
      // Accent-coloured TEXT and outlines use --accent-text: identical to the
      // accent on light, lifted on dark so it stays ≥ AA on Ink (obj 900543).
      textColor: withAlpha({
        signal: { verify: 'var(--t-verify)', amber: 'var(--t-amber)', alarm: 'var(--t-alarm)' },
        flag: { blocked: 'var(--t-alarm)', live: 'var(--t-verify)' },
        agent: { cto: 'var(--t-agent-cto)', cmo: 'var(--t-agent-cmo)', coo: 'var(--t-agent-coo)', cfo: 'var(--t-agent-cfo)', general: 'var(--t-agent-general)' },
        status: {
          planning: 'var(--t-planning)', queue: 'var(--t-queue)', working: 'var(--t-working)', ai: 'var(--t-ai)',
          review: 'var(--t-review)', human: 'var(--t-human)', done: 'var(--t-done)', cancelled: 'var(--t-cancelled)',
        },
        accent: {
          DEFAULT: 'var(--accent-text)',
          hover: 'var(--accent-text)',
          press: 'var(--accent-text)',
          fg: 'var(--accent-fg)',
        },
      }),
      // A bare `border` (no colour class) used Tailwind's gray-200 — a near-white
      // hairline on dark. Default it to the theme's line token instead.
      borderColor: { DEFAULT: 'var(--line)' },
      ringColor: withAlpha({ accent: 'var(--focus-ring)' }),
      outlineColor: withAlpha({ accent: 'var(--focus-ring)' }),
      fontFamily: {
        // Brand 1.0 type (operationkit-site tokens.css): Unbounded = brand/page
        // titles only, Familjen Grotesk = all UI + body, JetBrains Mono = machine data.
        brand: ['Unbounded', 'Familjen Grotesk', 'system-ui', 'sans-serif'],
        display: ['Familjen Grotesk', 'system-ui', '-apple-system', 'sans-serif'],
        sans: ['Familjen Grotesk', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        xs: '4px',
        sm: '6px',
        md: '8px',   // controls (brand --ok-radius-control)
        lg: '10px',
        xl: '14px',  // cards (brand --ok-radius-card)
      },
      boxShadow: {
        // §03 — cards never carry shadow; these are overlay-only.
        pop: '0 1px 2px rgba(22,22,58,.14)',
        float: '0 16px 40px -12px rgba(22,22,58,.32), 0 2px 8px rgba(22,22,58,.12)',
        drawer: '-18px 0 48px -16px rgba(22,22,58,.35)',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(.22,.61,.36,1)',
        inout: 'cubic-bezier(.45,0,.25,1)',
      },
      transitionDuration: {
        fast: '110ms',
        base: '150ms',
        slow: '240ms',
      },
      maxWidth: {
        prose: '64ch',
      },
    },
  },
  plugins: [],
} satisfies Config
