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
        // (light + dark via [data-theme]). Surfaces, text and hairlines are
        // NEUTRAL; the only brand colour is `accent` (obj 900750). An install
        // re-brands by setting the accent (OK_BRAND_ACCENT / config/branding.json
        // / Settings > Branding) + a logo — never by editing this file.
        // See docs/branding.md.
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
          inset: 'var(--surface-inset)',
          field: 'var(--surface-field)',
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
        // the ONE brand accent — default Ultramarine, configurable per install.
        // Use it for primary actions, links, focus and the selected-item bar
        // only — never as a page / card / sidebar fill.
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
        // semantic status colours (meaning, never brand)
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        info: 'var(--info)',
        // older names for the same semantic triad
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
        success: 'var(--t-success)',
        warning: 'var(--t-warning)',
        danger: 'var(--t-danger)',
        info: 'var(--t-info)',
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
      borderColor: withAlpha({
        DEFAULT: 'var(--line)',
        // Accent BORDERS (focus, selected option, drag-over) use the readable
        // accent text tone so they stay visible on the dark neutral ground.
        accent: { DEFAULT: 'var(--accent-text)', hover: 'var(--accent-text)', press: 'var(--accent-text)', fg: 'var(--accent-fg)' },
      }),
      ringColor: withAlpha({ accent: 'var(--focus-ring)' }),
      outlineColor: withAlpha({ accent: 'var(--focus-ring)' }),
      fontFamily: {
        // obj 900750: one neutral UI face everywhere (the platform system
        // stack, as GitHub uses) — nothing brand-specific to swap on a
        // white-label install. `brand`/`display` are kept as aliases so
        // existing classes keep working. JetBrains Mono = machine data.
        brand: 'var(--font-ui)',
        display: 'var(--font-ui)',
        sans: 'var(--font-ui)',
        mono: 'var(--font-mono)',
      },
      borderRadius: {
        // obj 900750: tighter, enterprise-crisp radii (GitHub uses 6px).
        xs: '3px',
        sm: '4px',
        md: '6px',   // controls
        lg: '8px',   // cards, tables
        xl: '12px',  // modals
      },
      boxShadow: {
        // §03 — cards never carry shadow; these are overlay-only. Theme-aware
        // (index.css): soft neutral grey in light, a hairline + deep black in dark.
        pop: 'var(--shadow-pop)',
        float: 'var(--shadow-float)',
        drawer: 'var(--shadow-drawer)',
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
