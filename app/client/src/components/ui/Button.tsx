import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

/* Button — token-bound action primitive (obj 900750: GitHub-style). Variants:
     primary   = accent fill + accent-fg text (the one brand accent; primary
                 actions only; install-configurable — see docs/branding.md)
     secondary = neutral raised surface + hairline (the default button)
     ghost     = transparent, fg-1 text, neutral hover fill
     danger    = neutral button with danger text; tints red on hover
   Sizes meet the 44px mobile hit-target at `md`+ via min-h. */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-press border border-transparent shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)]',
  secondary:
    'bg-surface-2 text-fg-0 border border-line shadow-[0_1px_0_rgba(31,35,40,0.04)] hover:border-line-strong hover:bg-surface-3 active:bg-surface-4',
  ghost:
    'bg-transparent text-fg-1 border border-transparent hover:bg-surface-3 hover:text-fg-0 active:bg-surface-4',
  danger:
    'bg-surface-2 text-danger border border-line hover:border-danger/40 hover:bg-danger/10 active:bg-danger/15',
}
/* Standard disabled token (QA r3 #2): a disabled control of ANY variant reads as
   a muted neutral — surface-3 + hairline + fg-3 — never a faded accent (a 45%
   accent fill reads as a lavender block). Ghost stays transparent (no box
   appears on a disabled toolbar icon). A loading button keeps its variant. */
export const DISABLED =
  'disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-3 disabled:text-fg-3 disabled:shadow-none'
const DISABLED_GHOST = 'disabled:cursor-not-allowed disabled:text-fg-3'
const disabledFor = (v: Variant) => (v === 'ghost' ? DISABLED_GHOST : DISABLED)

const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12.5px] gap-1.5',
  md: 'min-h-[44px] sm:min-h-[36px] px-4 text-[13px] gap-2',
}

/* Spinner — token-bound loading glyph. Reduced-motion safe (`.cc-spin`
   freezes the rotation; the ring still reads as a pending affordance). */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'cc-spin h-3.5 w-3.5 shrink-0 rounded-full border-2 border-current border-t-transparent',
        className,
      )}
      aria-hidden="true"
    />
  )
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  leftIcon?: ReactNode
  /** Pending state: shows a spinner, disables the control (kills double-submit),
      sets aria-busy. Keeps the label so width stays stable — no layout shift (audit OK-7). */
  loading?: boolean
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', leftIcon, loading, disabled, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center whitespace-nowrap justify-center rounded-md font-medium tracking-[-0.01em]',
        'transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface-0',
        VARIANT[variant],
        loading ? 'disabled:cursor-wait' : disabledFor(variant),
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : leftIcon && <span className="shrink-0">{leftIcon}</span>}
      {children}
    </button>
  )
})

/* IconButton — square, icon-only action. 44px tap target on mobile. */
interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  label: string
  children: ReactNode
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { variant = 'ghost', label, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cn(
        'inline-grid min-h-[44px] min-w-[44px] place-items-center rounded-md sm:min-h-[34px] sm:min-w-[34px]',
        'transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        VARIANT[variant],
        disabledFor(variant),
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})
