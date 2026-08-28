import { useEffect, useState, useRef } from 'react'
import { NavIcon } from './nav-icons'

interface PaletteItem {
  label: string
  hint?: string
  onSelect: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  items: PaletteItem[]
}

/* ─────────────────────────────────────────────────────────
   ⌘K command palette — desktop only (§09 Layout)
   Quiet text-driven shortcut surface. Esc / click-outside
   closes. Enter picks the highlighted item.
   ───────────────────────────────────────────────────────── */
export function CommandPalette({ open, onClose, items }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  if (!open) return null

  const filtered = query.trim()
    ? items.filter(i => i.label.toLowerCase().includes(query.toLowerCase()))
    : items

  const safeCursor = Math.min(cursor, Math.max(0, filtered.length - 1))

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor(c => Math.min(filtered.length - 1, c + 1)); return }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor(c => Math.max(0, c - 1)); return }
    if (e.key === 'Enter')     {
      e.preventDefault()
      const item = filtered[safeCursor]
      if (item) { item.onSelect(); onClose() }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-surface-0/70 p-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="cc-toast-in w-full max-w-lg overflow-hidden rounded-lg border border-line bg-surface-2 shadow-float"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
          <NavIcon name="search" className="h-4 w-4 text-fg-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setCursor(0) }}
            onKeyDown={handleKeyDown}
            placeholder="Jump to…"
            className="flex-1 bg-transparent text-sm text-fg-0 placeholder-fg-3 outline-none"
          />
          <span className="font-mono text-[10.5px] text-fg-3">esc</span>
        </div>
        <ul role="listbox" className="max-h-[40vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-3 text-sm text-fg-3">No matches</li>
          ) : filtered.map((item, i) => (
            <li
              key={item.label}
              role="option"
              aria-selected={i === safeCursor}
              onMouseEnter={() => setCursor(i)}
              onClick={() => { item.onSelect(); onClose() }}
              className={`flex cursor-pointer items-center justify-between px-3 py-2 text-sm transition-colors duration-fast ease-out ${
                i === safeCursor ? 'bg-surface-3 text-fg-0' : 'text-fg-1 hover:bg-surface-3'
              }`}
            >
              <span>{item.label}</span>
              {item.hint && <span className="font-mono text-[10.5px] text-fg-3">{item.hint}</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
