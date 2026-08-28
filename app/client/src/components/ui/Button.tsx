import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from './cn'

/* Button — token-bound action primitive. Three variants:
     primary   = Signal Orange fill + white fg (the one accent; primary actions only)
     secondary = surface-1 + hairline, lifts to line-strong on hover
     ghost     = transparent, fg-1 text, subtle surface on hover
   Sizes meet the 44px mobile hit-target at `md`+ via min-h. */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-press border border-transparent',
  secondary:
    'bg-surface-1 text-fg-1 border border-line hover:border-line-strong hover:text-fg-0 hover:bg-surface-3',
  ghost:
    'bg-transparent text-fg-1 border border-transparent hover:bg-surface-2 hover:text-fg-0',
  danger:
    'bg-transparent text-signal-alarm border border-signal-alarm/30 hover:bg-signal-alarm/10',
}
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
        'inline-flex select-none items-center justify-center rounded-md font-medium tracking-[-0.01em]',
        'transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANT[variant],
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
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
})
