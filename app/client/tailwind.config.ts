import type { Config } from 'tailwindcss'

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // §01 surfaces — Mission Control cool-carbon ramp (5 deliberate steps) +
        // legacy DEFAULT/raised/overlay aliases so unmigrated pages keep working.
        surface: {
          0: '#0c0f14',
          1: '#12161d',
          2: '#161b22',
          3: '#1e242d',
          4: '#28303b',
          DEFAULT: '#0c0f14',
          raised: '#12161d',
          overlay: '#161b22',
        },
        // §01 text scale
        fg: {
          0: '#f3f5f7',
          1: '#c2c8d2',
          2: '#8a93a3',
          3: '#5b6472',
        },
        // §01 hairlines — Vercel-style ladder
        line: {
          DEFAULT: '#222936',
          soft: '#1b212b',
          strong: '#2c3543',
        },
        // legacy alias: `border-border`, `border-border-hover` still resolve.
        border: {
          DEFAULT: '#222936',
          hover: '#2c3543',
        },
        // §01 accent — Signal Orange (the one accent); supersedes the retired warm accent.
        accent: {
          DEFAULT: '#ff5a1f',
          hover: '#ff6f3c',
          press: '#d9430d',
          fg: '#ffffff',
        },
        // §04 status pipeline — collapsed to one accent + status green/amber.
        // human = accent (needs-you), done = verify-green; machine states stay cool.
        status: {
          planning: '#9b8cf0',
          queue: '#8b8a84',
          working: '#5b9df0',
          ai: '#46c2b6',
          review: '#e0a458',
          human: '#ff5a1f',
          done: '#1fb877',
          // obj 700595 — soft-retire. Muted, desaturated slate: reads as
          // inactive/retired, deliberately distinct from `done` green and the
          // warmer `queue` gray (cancelled ≠ completed). Light enough to clear
          // WCAG AA (6.7:1 on surface-0) since it also renders as label text.
          cancelled: '#9a97a6',
        },
        // §04 orthogonal flags — red is reserved for `blocked` only.
        flag: {
          blocked: '#e5564b',
          live: '#1fb877',
        },
        // semantic status triad (color carries meaning)
        signal: {
          verify: '#1fb877',
          amber: '#e6a700',
          alarm: '#e5564b',
        },
        // §05 agent identity — desaturated on purpose; routes don't compete with status.
        agent: {
          cto: '#6F9AD8',
          cmo: '#D389B0',
          coo: '#6FB58C',
          cfo: '#D6A24E',
          general: '#8C8A92',
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
