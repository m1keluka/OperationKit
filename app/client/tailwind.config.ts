import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
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
      },
      fontFamily: {
        // Mission Control split: Geist = display/UI, Inter = body, Geist Mono = machine data.
        display: ['Geist', 'Inter Tight', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['Geist Mono', 'JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        xs: '4px',
        sm: '6px',
        md: '8px',
        lg: '11px',
        xl: '14px',
      },
      boxShadow: {
        // §03 — cards never carry shadow; these are overlay-only.
        pop: '0 1px 2px rgba(0,0,0,.4)',
        float: '0 12px 34px -8px rgba(0,0,0,.55), 0 2px 8px rgba(0,0,0,.4)',
        drawer: '-18px 0 48px -16px rgba(0,0,0,.6)',
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
