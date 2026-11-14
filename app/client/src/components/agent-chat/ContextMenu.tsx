import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../ui'

/* A small floating menu for the Bots sidebar (obj 900798): a bot's
   right-click / "⋯" menu and a section's "⋯" menu.

   - Opens at a point (the pointer, or the trigger's corner) and is clamped
     into the viewport, so it never opens off-screen at 390px.
   - A submenu ("Move to section") REPLACES the list in place with a Back row
     instead of flying out sideways: a fly-out has nowhere to go on a phone.
   - Keyboard: focus starts on the first item; ↑/↓/Home/End move, → opens a
     submenu, ← / Escape goes back, Escape at the top closes and returns focus
     to whatever opened it, Tab closes. Clicking outside closes. */

export interface MenuItem {
  key: string
  label: string
  icon?: ReactNode
  onSelect?: () => void
  /** Opens this list in place of the current one. */
  submenu?: MenuItem[]
  danger?: boolean
  disabled?: boolean
  /** A short reason shown under the label (e.g. why it is disabled). */
  hint?: string
  /** Muted text at the right edge (e.g. the id Copy ID copies). */
  detail?: string
  /** A tick: the current choice in a submenu. */
  checked?: boolean
  /** A hairline above this item. */
  separator?: boolean
}

export interface MenuAnchor {
  x: number
  y: number
}

const MARGIN = 8

export function ContextMenu({
  label,
  items,
  anchor,
  onClose,
}: {
  /** The menu's accessible name, e.g. "Actions for Dev Bot". */
  label: string
  items: MenuItem[]
  anchor: MenuAnchor
  /** `restoreFocus` is true when the person closed it with Escape or by picking an item. */
  onClose: (restoreFocus: boolean) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [stack, setStack] = useState<{ title: string; items: MenuItem[] }[]>([])
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const current = stack.length ? stack[stack.length - 1] : null
  const list = current ? current.items : items

  // Clamp into the viewport once the menu has a size (and again per submenu).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth || 240
    const h = el.offsetHeight || 0
    const vw = window.innerWidth || 1024
    const vh = window.innerHeight || 768
    setPos({
      left: Math.max(MARGIN, Math.min(anchor.x, vw - w - MARGIN)),
      top: Math.max(MARGIN, Math.min(anchor.y, vh - h - MARGIN)),
    })
  }, [anchor.x, anchor.y, stack.length])

  // Focus the first usable item whenever a list opens.
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
    first?.focus()
  }, [stack.length])

  // Outside click / scroll / resize closes, without stealing focus back.
  useEffect(() => {
    const onDown = (e: Event) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) onClose(false)
    }
    const onScroll = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return
      onClose(false)
    }
    const onResize = () => onClose(false)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose])

  const back = () => setStack(s => s.slice(0, -1))

  const choose = (item: MenuItem) => {
    if (item.disabled) return
    if (item.submenu) {
      setStack(s => [...s, { title: item.label, items: item.submenu! }])
      return
    }
    onClose(true)
    item.onSelect?.()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])]
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const go = (n: number) => buttons[(n + buttons.length) % buttons.length]?.focus()
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        go(i + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        go(i < 0 ? -1 : i - 1)
        break
      case 'Home':
        e.preventDefault()
        go(0)
        break
      case 'End':
        e.preventDefault()
        go(-1)
        break
      case 'ArrowLeft':
        if (current) {
          e.preventDefault()
          back()
        }
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        if (current) back()
        else onClose(true)
        break
      case 'Tab':
        onClose(false)
        break
    }
  }

  const row = (item: MenuItem, onActivate: () => void, extra?: ReactNode) => (
    <div key={item.key}>
      {item.separator && <div role="separator" className="my-1 h-px bg-line-soft" />}
      <button
        type="button"
        role="menuitem"
        disabled={item.disabled}
        aria-haspopup={item.submenu ? 'menu' : undefined}
        onClick={onActivate}
        onKeyDown={e => {
          if (e.key === 'ArrowRight' && item.submenu) {
            e.preventDefault()
            onActivate()
          }
        }}
        className={cn(
          'flex min-h-[40px] w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[13px] transition-colors duration-fast sm:min-h-[34px]',
          'focus-visible:outline-none focus:bg-surface-3',
          item.danger ? 'text-danger hover:bg-danger/10 focus:bg-danger/10' : 'text-fg-1 hover:bg-surface-3 hover:text-fg-0',
          'disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent',
        )}
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center text-current opacity-80" aria-hidden="true">
          {item.checked ? <Check className="h-4 w-4" strokeWidth={2} /> : item.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.label}</span>
          {item.hint && <span className="block truncate text-[12px] text-fg-3">{item.hint}</span>}
        </span>
        {item.detail && <span className="max-w-[96px] shrink-0 truncate font-mono text-[12px] text-fg-3">{item.detail}</span>}
        {extra}
      </button>
    </div>
  )

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={current ? `${label}: ${current.title}` : label}
      onKeyDown={onKeyDown}
      onContextMenu={e => e.preventDefault()}
      style={{ position: 'fixed', left: pos?.left ?? anchor.x, top: pos?.top ?? anchor.y, visibility: pos ? 'visible' : 'hidden' }}
      className="z-[60] max-h-[min(70vh,420px)] w-[240px] overflow-y-auto rounded-lg border border-line bg-surface-1 p-1 shadow-pop cc-pop-in"
    >
      {current &&
        row({ key: '__back', label: current.title, icon: <ChevronLeft className="h-4 w-4" strokeWidth={1.8} /> }, back)}
      {current && <div role="separator" className="my-1 h-px bg-line-soft" />}
      {list.map(item =>
        row(
          item,
          () => choose(item),
          item.submenu ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-3" strokeWidth={1.8} aria-hidden="true" /> : undefined,
        ),
      )}
    </div>,
    document.body,
  )
}
