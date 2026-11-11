import { DEFAULT_BRAND_NAME, useBrandingState, type Branding } from '../hooks/useBranding'
import { cn } from './ui/cn'

export type BrandMarkChoice =
  | { kind: 'wordmark'; src: string }
  | { kind: 'icon'; src: string }
  | { kind: 'monogram'; letter: string }

/**
 * Which mark to show for this install (obj 900543) — the single rule every
 * brand surface (desktop + mobile topbar, sign-in screens, Branding preview)
 * goes through, so nothing hardcodes a logo:
 *   1. the uploaded wordmark (its dark variant on the dark theme, if any)
 *   2. else the uploaded / shipped icon, next to the brand name
 *   3. else a monogram of the brand name on the install's accent
 * The server stops sending the shipped default marks once an install is
 * white-labeled (own name or any upload), so rule 3 — never the default
 * mark — is what a renamed install without uploads gets.
 */
export function pickBrandMark(b: Branding, theme: 'light' | 'dark', opts: { allowWordmark?: boolean } = {}): BrandMarkChoice {
  const allowWordmark = opts.allowWordmark ?? true
  const wordmark = theme === 'dark' ? (b.wordmark_dark_url || b.wordmark_url) : b.wordmark_url
  if (allowWordmark && wordmark) return { kind: 'wordmark', src: wordmark }
  if (b.icon_url) return { kind: 'icon', src: b.icon_url }
  return { kind: 'monogram', letter: (b.name.trim()[0] || '•').toUpperCase() }
}

function currentTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

const SIZES = {
  sm: { box: 'h-7 w-7 text-[13px]', word: 'h-6 max-w-[150px]', name: 'max-w-[200px] text-[14px]' },
  md: { box: 'h-8 w-8 text-[15px]', word: 'h-7 max-w-[200px]', name: 'text-[16px]' },
  lg: { box: 'h-11 w-11 text-[20px]', word: 'h-10 max-w-[260px]', name: 'text-[22px]' },
} as const

/** The install's logo lockup. `showName` adds the brand name beside an icon
 * or monogram (a wordmark already contains it). */
export function BrandLogo({
  theme,
  size = 'sm',
  showName = true,
  allowWordmark = true,
  branding: override,
  className,
}: {
  theme?: 'light' | 'dark'
  size?: keyof typeof SIZES
  showName?: boolean
  allowWordmark?: boolean
  /** Render a specific (e.g. draft) branding instead of the live one. */
  branding?: Branding
  className?: string
}) {
  const live = useBrandingState()
  const branding = override ?? live.branding
  const loaded = override ? true : live.loaded
  const sz = SIZES[size]
  if (!loaded) {
    // Neutral placeholder until /api/branding answers — never the default brand.
    return <span data-testid="brand-logo-pending" aria-hidden="true" className={cn('inline-block rounded-md bg-surface-3', sz.box, className)} />
  }
  const mark = pickBrandMark(branding, theme ?? currentTheme(), { allowWordmark })
  const name = branding.name || DEFAULT_BRAND_NAME
  return (
    <span data-testid="brand-logo" data-mark={mark.kind} className={cn('inline-flex min-w-0 items-center gap-2', className)}>
      {mark.kind === 'wordmark' && (
        <img src={mark.src} alt={name} className={cn('w-auto object-contain object-left', sz.word)} />
      )}
      {mark.kind === 'icon' && (
        <img src={mark.src} alt={showName ? '' : name} className={cn('shrink-0 rounded-md object-contain', sz.box)} />
      )}
      {mark.kind === 'monogram' && (
        <span
          aria-hidden={showName ? 'true' : undefined}
          aria-label={showName ? undefined : name}
          className={cn('grid shrink-0 place-items-center rounded-md bg-accent font-brand font-bold leading-none text-accent-fg', sz.box)}
        >
          {mark.letter}
        </span>
      )}
      {mark.kind !== 'wordmark' && showName && (
        <span className={cn('truncate font-brand font-semibold leading-none tracking-[-0.01em] text-fg-0', sz.name)}>{name}</span>
      )}
    </span>
  )
}
