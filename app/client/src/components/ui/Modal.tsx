import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from './cn'

/* ─────────────────────────────────────────────────────────
   Modal — the ONE overlay wrapper for the platform (audit OK-4/OK-29).
   Retrofits the existing motion vocabulary onto every hard-cutting
   overlay: backdrop fades in (`cc-backdrop-in`), the panel enters with
   the shipped keyframes — `center` scales/fades from 0.97 (`cc-pop-in`),
   `sheet` slides up on mobile (`cc-sheet-in`) / in from the right on
   desktop (`cc-drawer-in`). Esc closes, body scroll locks, focus restores
   to the trigger on close. All motion is reduced-motion guarded in index.css.

   This is a presentation wrapper only — colours/spacing come from tokens;
   it does NOT own confirm semantics (see ConfirmDialog).
   ───────────────────────────────────────────────────────── */

type Variant = 'center' | 'sheet'

// Tab-focusable elements within the dialog (for the focus trap + initial focus).
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function Modal({
  open,
  onClose,
  children,
  variant = 'center',
  labelledBy,
  describedBy,
  className,
  panelClassName,
  closeOnBackdrop = true,
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  variant?: Variant
  labelledBy?: string
  describedBy?: string
  className?: string
  /** Extra classes on the panel (sizing, etc.). */
  panelClassName?: string
  closeOnBackdrop?: boolean
}) {
  const restoreRef = useRef<HTMLElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  // Latest-ref for onClose: parents pass inline closures, so onClose's identity
  // changes on every parent re-render. Reading it through a ref keeps the
  // focus/scroll-lock effect below from depending on that identity — otherwise
  // the effect tears down + re-runs on every parent re-render (the state-poller
  // re-renders the board every ~3s for any live session), yanking focus out of
  // the field the user is in and breaking dropdowns. See obj 700071.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  // Esc to close + body scroll lock + focus capture/restore.
  useEffect(() => {
    if (!open) return
    restoreRef.current = (document.activeElement as HTMLElement) ?? null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
        return
      }
      // Focus trap: keep Tab / Shift+Tab cycling inside the dialog so focus
      // never escapes to the page behind it (which is not inert).
      if (e.key === 'Tab') {
        const panel = panelRef.current
        if (!panel) return
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>(FOCUSABLE),
        ).filter((el) => el.offsetParent !== null)
        if (focusables.length === 0) {
          e.preventDefault()
          panel.focus()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement as HTMLElement | null
        if (e.shiftKey) {
          if (active === first || active === panel || !panel.contains(active)) {
            e.preventDefault()
            last.focus()
          }
        } else if (active === last || active === panel || !panel.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)

    // Initial focus: honour an explicit [data-autofocus] target, else the first
    // focusable element, else the panel — so focus always lands on something
    // useful and inside the dialog (fixes ConfirmDialog's defeated autoFocus).
    const t = window.setTimeout(() => {
      const panel = panelRef.current
      if (!panel) return
      const target =
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        panel.querySelector<HTMLElement>(FOCUSABLE) ??
        panel
      target.focus()
    }, 0)

    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      window.clearTimeout(t)
      restoreRef.current?.focus?.()
    }
  }, [open])

  if (!open) return null

  const isSheet = variant === 'sheet'

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 z-50 flex',
        isSheet ? 'items-end justify-center sm:items-stretch sm:justify-end' : 'items-center justify-center p-4',
        className,
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
    >
      {/* Backdrop */}
      <div
        className="cc-backdrop-in absolute inset-0 bg-surface-0/70 backdrop-blur-[1px]"
        onClick={closeOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />
      {/* Panel */}
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'relative z-[1] outline-none',
          isSheet
            ? 'cc-sheet-in sm:cc-drawer-in max-h-[88vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface-1 shadow-float sm:h-full sm:max-h-none sm:w-[440px] sm:rounded-none sm:rounded-l-2xl sm:border-y-0 sm:border-r-0'
            : 'cc-pop-in max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-xl border border-line bg-surface-1 shadow-float',
          panelClassName,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  )
}
