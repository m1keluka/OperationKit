import { useEffect, useRef, type ReactNode } from 'react'

interface ThreadDrawerProps {
  open: boolean
  onClose: () => void
  children: ReactNode
}

/**
 * Slide-over "recents" drawer for the mentor chat. On all sizes it overlays the
 * conversation (the chat stays a focused single column), dismissible by Esc,
 * backdrop click, or the close button. Keeps focus management reasonable by
 * moving focus into the panel on open and restoring it on close.
 */
export function ThreadDrawer({ open, onClose, children }: ThreadDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    // Move focus into the panel so Esc/Tab behave and screen readers land here.
    const t = window.setTimeout(() => panelRef.current?.focus(), 0)

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('keydown', onKey)
      restoreFocusRef.current?.focus?.()
    }
  }, [open, onClose])

  return (
    <div
      className={`fixed inset-0 z-40 sm:absolute ${open ? '' : 'pointer-events-none'}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/50 transition-opacity duration-base ease-out ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Recent chats"
        tabIndex={-1}
        className={`absolute inset-y-0 left-0 flex w-[85%] max-w-xs flex-col border-r border-line bg-surface-1 shadow-drawer outline-none transition-transform duration-base ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <span className="font-display text-sm font-semibold text-fg-0">Recents</span>
          <button
            onClick={onClose}
            aria-label="Close recents"
            className="grid h-8 w-8 place-items-center rounded-md text-fg-3 transition-colors hover:bg-surface-2 hover:text-fg-0"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  )
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  )
}
