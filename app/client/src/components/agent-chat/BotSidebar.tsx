import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  FolderInput,
  FolderPlus,
  Mail,
  MailOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
} from 'lucide-react'
import { api } from '../../lib/api'
import { Button, IconButton, Modal, SearchInput, Toast, cn, useConfirm } from '../ui'
import { copyText } from '../ui/CopyButton'
import { AgentAvatar } from './ChatItems'
import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu'
import { botState, buildSidebarView, shortTime, type SidebarFilter } from './sidebar-model'
import type { BotSidebarApi } from './useBotSidebar'
import type { AgentsResponse, ChatAgentInfo, SidebarBot, SidebarSection } from './types'

/* The Bots sidebar (obj 900798).

   Layout, top to bottom:
     header       "Bots" + New section
     filter       search box + chips (All · Unread · Pinned · <sections> · Hidden)
     pinned rail  large avatars for the bots you pinned, one click away
     sections     your named groups, in your order, then "Other bots"
     rows         avatar · name · time · last-message preview · unread dot

   Every arrangement here (pins, sections, hidden, read state) is the
   person's OWN and is stored server-side per person (useBotSidebar). Only the
   two bot-wide actions in the menu — Rename and Delete — change the bot for
   everyone, so only an admin sees them, behind the same signed-in-admin gate
   as the bot's model and tools; Delete always asks first.

   Styling is token-only (surface-*, fg-*, line, accent), so light/dark and a
   white-label accent come for free; there is no product-specific chrome. */

type MenuState =
  | { kind: 'bot'; agent: ChatAgentInfo; anchor: MenuAnchor; trigger: HTMLElement | null }
  | { kind: 'section'; section: SidebarSection; anchor: MenuAnchor; trigger: HTMLElement | null }

type DialogState =
  | { kind: 'new-section'; thenMove?: string }
  | { kind: 'rename-section'; section: SidebarSection }
  | { kind: 'rename-bot'; agent: ChatAgentInfo }

const LONG_PRESS_MS = 500

/** Anchor a menu at a trigger button's bottom-right corner. */
function anchorFor(el: HTMLElement): MenuAnchor {
  const r = el.getBoundingClientRect()
  return { x: Math.max(0, r.right - 240), y: r.bottom + 4 }
}

/** Long-press on touch opens the menu (iOS Safari fires no contextmenu event). */
function useLongPress(open: (anchor: MenuAnchor, el: HTMLElement) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => cancel, [])
  return {
    fired,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      fired.current = false
      if (e.pointerType !== 'touch') return
      const el = e.currentTarget
      const at = { x: e.clientX, y: e.clientY }
      cancel()
      timer.current = setTimeout(() => {
        fired.current = true
        open(at, el)
      }, LONG_PRESS_MS)
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  }
}

function UnreadDot({ className, label }: { className?: string; label: string }) {
  return (
    <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full bg-accent', className)} role="img" aria-label={label} />
  )
}

// ── one bot ──

function previewFor(a: ChatAgentInfo, b: SidebarBot): string {
  const m = b.last_message
  if (!m) return a.description || 'No messages yet'
  const where = m.thread_title ? `${m.thread_title} · ` : ''
  return `${where}${m.role === 'user' ? 'You: ' : ''}${m.preview || '…'}`
}

function BotRow({
  agent,
  entry,
  active,
  onPick,
  onMenu,
}: {
  agent: ChatAgentInfo
  entry: SidebarBot
  active: boolean
  onPick: () => void
  onMenu: (anchor: MenuAnchor, trigger: HTMLElement) => void
}) {
  const press = useLongPress(onMenu)
  const time = entry.last_message ? shortTime(entry.last_message.created_at) : ''
  return (
    <li className="group relative" data-bot={agent.slug}>
      <button
        onClick={() => {
          if (press.fired.current) return
          onPick()
        }}
        onContextMenu={(e: ReactMouseEvent<HTMLButtonElement>) => {
          e.preventDefault()
          const kb = e.clientX === 0 && e.clientY === 0
          onMenu(kb ? anchorFor(e.currentTarget) : { x: e.clientX, y: e.clientY }, e.currentTarget)
        }}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerLeave={press.onPointerLeave}
        onPointerCancel={press.onPointerCancel}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex min-h-[56px] w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-fast',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          active ? 'bg-surface-3' : 'hover:bg-surface-2',
        )}
      >
        <AgentAvatar agent={agent} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-[14px] text-fg-0', entry.unread ? 'font-semibold' : 'font-medium')}>{agent.name}</span>
            {time && (
              <span
                className={cn(
                  'shrink-0 text-[12px] tabular-nums transition-opacity duration-fast group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0',
                  entry.unread ? 'text-fg-1' : 'text-fg-3',
                )}
              >
                {time}
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', entry.unread ? 'text-fg-1' : 'text-fg-2')}>{previewFor(agent, entry)}</span>
            {entry.unread && (
              <UnreadDot
                label={entry.unread_count > 0 ? `${entry.unread_count} unread` : 'Marked unread'}
              />
            )}
          </span>
        </span>
      </button>
      <button
        type="button"
        aria-label={`Actions for ${agent.name}`}
        aria-haspopup="menu"
        onClick={e => onMenu(anchorFor(e.currentTarget), e.currentTarget)}
        className={cn(
          'absolute right-1.5 top-2 grid h-7 w-7 place-items-center rounded-md text-fg-2 transition-opacity duration-fast',
          'hover:bg-surface-4 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          'opacity-0 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100',
        )}
      >
        <MoreHorizontal className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
      </button>
    </li>
  )
}

function PinnedTile({
  agent,
  entry,
  active,
  onPick,
  onMenu,
}: {
  agent: ChatAgentInfo
  entry: SidebarBot
  active: boolean
  onPick: () => void
  onMenu: (anchor: MenuAnchor, trigger: HTMLElement) => void
}) {
  const press = useLongPress(onMenu)
  return (
    <li className="min-w-0">
      <button
        onClick={() => {
          if (press.fired.current) return
          onPick()
        }}
        onContextMenu={e => {
          e.preventDefault()
          const kb = e.clientX === 0 && e.clientY === 0
          onMenu(kb ? anchorFor(e.currentTarget) : { x: e.clientX, y: e.clientY }, e.currentTarget)
        }}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerLeave={press.onPointerLeave}
        onPointerCancel={press.onPointerCancel}
        aria-current={active ? 'page' : undefined}
        aria-label={`${agent.name}${entry.unread ? ' (unread)' : ''} — pinned`}
        title={agent.name}
        className="group flex w-full flex-col items-center gap-1.5 rounded-xl px-1 pb-1.5 pt-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <span className="relative">
          <AgentAvatar
            agent={agent}
            size="xl"
            className={cn(
              'transition-transform duration-fast group-hover:-translate-y-px',
              active && 'ring-2 ring-accent ring-offset-2 ring-offset-surface-1',
            )}
          />
          {entry.unread && <UnreadDot label="unread" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 ring-2 ring-surface-1" />}
        </span>
        <span className={cn('block w-full truncate text-center text-[12px]', active || entry.unread ? 'text-fg-0' : 'text-fg-2', entry.unread && 'font-semibold')}>
          {agent.name}
        </span>
      </button>
    </li>
  )
}

// ── a name prompt: new section, rename section, rename bot ──

function NameDialog({
  title,
  label,
  initial,
  hint,
  maxLength,
  confirmLabel,
  onSubmit,
  onClose,
  extra,
}: {
  title: string
  label: string
  initial: string
  hint?: string
  maxLength: number
  confirmLabel: string
  onSubmit: (value: string) => Promise<boolean>
  onClose: () => void
  extra?: { label: string; onClick: () => Promise<boolean> }
}) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    setBusy(true)
    const ok = await onSubmit(value.trim())
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Modal open onClose={onClose} labelledBy="bot-sidebar-dialog-title" panelClassName="w-full max-w-sm">
      <form className="p-5" onSubmit={e => void submit(e)}>
        <h2 id="bot-sidebar-dialog-title" className="font-display text-[15px] font-semibold tracking-[-0.01em] text-fg-0">
          {title}
        </h2>
        <label htmlFor="bot-sidebar-dialog-input" className="mt-4 block text-[12.5px] font-medium text-fg-1">
          {label}
        </label>
        <input
          id="bot-sidebar-dialog-input"
          data-autofocus
          autoFocus
          value={value}
          maxLength={maxLength}
          onChange={e => setValue(e.target.value)}
          className="mt-1.5 min-h-[44px] w-full rounded-md border border-line bg-surface-field px-3 text-[14px] text-fg-0 focus:border-accent focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent sm:min-h-[38px]"
        />
        {hint && <p className="mt-1.5 text-[12px] leading-relaxed text-fg-2">{hint}</p>}
        <div className="mt-5 flex items-center gap-2">
          {extra && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                const ok = await extra.onClick()
                setBusy(false)
                if (ok) onClose()
              }}
            >
              {extra.label}
            </Button>
          )}
          <span className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ── the sidebar ──

export function BotSidebar({
  data,
  active,
  onPick,
  isAdmin,
  onDemo,
  demoBusy,
  sidebar,
  onAgentChanged,
  onAgentDeleted,
}: {
  data: AgentsResponse
  active: string | null
  onPick: (slug: string) => void
  isAdmin: boolean
  onDemo: (on: boolean) => void
  demoBusy: boolean
  sidebar: BotSidebarApi
  /** A bot was renamed: merge it into the page's list. */
  onAgentChanged: (a: ChatAgentInfo) => void
  /** A bot was deleted for everyone: reload the list (and leave its page). */
  onAgentDeleted: (slug: string) => void
}) {
  const { state } = sidebar
  const [filter, setFilter] = useState<SidebarFilter>('all')
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [toast, setToast] = useState<{ tone: 'info' | 'alarm'; text: string } | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const sections = useMemo(() => [...(state?.sections ?? [])].sort((a, b) => a.position - b.position || a.id - b.id), [state?.sections])
  // A filter pointing at a section that was deleted falls back to All.
  useEffect(() => {
    if (filter.startsWith('section:') && !sections.some(s => `section:${s.id}` === filter)) setFilter('all')
  }, [filter, sections])
  const view = useMemo(() => buildSidebarView(data.agents, state, filter, query), [data.agents, state, filter, query])

  // Hook errors surface as the same toast as the menu's own messages.
  useEffect(() => {
    if (sidebar.error) setToast({ tone: 'alarm', text: sidebar.error })
  }, [sidebar.error])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => {
      setToast(null)
      sidebar.setError(null)
    }, 3500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast])

  const closeMenu = useCallback(
    (restore: boolean) => {
      setMenu(m => {
        if (restore && m?.trigger?.isConnected) setTimeout(() => m.trigger?.focus(), 0)
        return null
      })
    },
    [],
  )

  const renameBot = async (a: ChatAgentInfo, name: string | null): Promise<boolean> => {
    try {
      const r = await api.put<{ agent: ChatAgentInfo }>(`/agent-chat/agents/${encodeURIComponent(a.slug)}/config`, { name })
      onAgentChanged(r.agent)
      setToast({ tone: 'info', text: name ? `Renamed to ${r.agent.name}` : `Back to ${r.agent.name}` })
      return true
    } catch (e) {
      setToast({ tone: 'alarm', text: e instanceof Error && e.message ? e.message : 'Could not rename this bot' })
      return false
    }
  }

  const deleteBot = async (a: ChatAgentInfo) => {
    const ok = await confirm({
      title: `Delete ${a.name} for everyone?`,
      message: `${a.name} leaves every person's Bots list and its scheduled wakes stop. Its agent folder is moved to .deleted/ on the server, so an admin can bring it back. Everyone's chat history with it is kept.`,
      confirmLabel: 'Delete bot',
      danger: true,
    })
    if (!ok) return
    try {
      await api.del(`/agent-chat/agents/${encodeURIComponent(a.slug)}`)
      setToast({ tone: 'info', text: `${a.name} was deleted` })
      onAgentDeleted(a.slug)
      void sidebar.refresh()
    } catch (e) {
      setToast({ tone: 'alarm', text: e instanceof Error && e.message ? e.message : 'Could not delete this bot' })
    }
  }

  const botMenuItems = (a: ChatAgentInfo): MenuItem[] => {
    const b = botState(state, a.slug)
    const pinnedCount = Object.values(state?.bots ?? {}).filter(x => x.pinned).length
    const atPinCap = !b.pinned && !!state && pinnedCount >= state.max_pins
    const pinnedOrder = view.rail.map(x => x.slug)
    const pinIndex = pinnedOrder.indexOf(a.slug)
    const moveItems: MenuItem[] = [
      ...sections.map(s => ({
        key: `to-${s.id}`,
        label: s.name,
        checked: b.section_id === s.id,
        onSelect: () => void sidebar.moveTo(a.slug, s.id),
      })),
      { key: 'to-none', label: 'Other bots (no section)', checked: b.section_id === null, onSelect: () => void sidebar.moveTo(a.slug, null), separator: sections.length > 0 },
      { key: 'to-new', label: 'New section…', icon: <Plus className="h-4 w-4" strokeWidth={1.8} />, onSelect: () => setDialog({ kind: 'new-section', thenMove: a.slug }) },
    ]
    const builtinOrDemo = a.source === 'builtin' || a.source === 'demo'
    return [
      b.pinned
        ? { key: 'unpin', label: 'Unpin', icon: <PinOff className="h-4 w-4" strokeWidth={1.8} />, onSelect: () => void sidebar.setPinned(a.slug, false) }
        : {
            key: 'pin',
            label: 'Pin to top',
            icon: <Pin className="h-4 w-4" strokeWidth={1.8} />,
            disabled: atPinCap,
            hint: atPinCap ? `Up to ${state?.max_pins} pins — unpin one first` : undefined,
            onSelect: () => void sidebar.setPinned(a.slug, true),
          },
      ...(b.pinned && pinIndex > 0
        ? [{ key: 'pin-left', label: 'Move pin left', icon: <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />, onSelect: () => void sidebar.movePin(a.slug, -1) }]
        : []),
      ...(b.pinned && pinIndex >= 0 && pinIndex < pinnedOrder.length - 1
        ? [{ key: 'pin-right', label: 'Move pin right', icon: <ArrowRight className="h-4 w-4" strokeWidth={1.8} />, onSelect: () => void sidebar.movePin(a.slug, 1) }]
        : []),
      { key: 'move', label: 'Move to section', icon: <FolderInput className="h-4 w-4" strokeWidth={1.8} />, submenu: moveItems },
      b.unread
        ? { key: 'read', label: 'Mark as read', icon: <MailOpen className="h-4 w-4" strokeWidth={1.8} />, onSelect: () => void sidebar.markRead(a.slug) }
        : { key: 'unread', label: 'Mark as unread', icon: <Mail className="h-4 w-4" strokeWidth={1.8} />, onSelect: () => void sidebar.markUnread(a.slug) },
      ...(isAdmin
        ? [{ key: 'rename', label: 'Rename…', icon: <Pencil className="h-4 w-4" strokeWidth={1.8} />, onSelect: () => setDialog({ kind: 'rename-bot', agent: a }) }]
        : []),
      {
        key: 'copy',
        label: 'Copy ID',
        icon: <Copy className="h-4 w-4" strokeWidth={1.8} />,
        detail: a.slug,
        onSelect: () =>
          void copyText(a.slug).then(ok => setToast(ok ? { tone: 'info', text: `Copied ${a.slug}` } : { tone: 'alarm', text: 'Could not copy — your browser blocked it' })),
      },
      b.hidden
        ? { key: 'show', label: 'Show in sidebar', icon: <Eye className="h-4 w-4" strokeWidth={1.8} />, onSelect: () => void sidebar.setHidden(a.slug, false) }
        : {
            key: 'hide',
            label: 'Hide from sidebar',
            icon: <EyeOff className="h-4 w-4" strokeWidth={1.8} />,
            onSelect: () =>
              void sidebar.setHidden(a.slug, true).then(ok => ok && setToast({ tone: 'info', text: `${a.name} is hidden — find it under the Hidden filter` })),
          },
      ...(isAdmin
        ? [
            {
              key: 'delete',
              label: 'Delete…',
              icon: <Trash2 className="h-4 w-4" strokeWidth={1.8} />,
              danger: true,
              separator: true,
              disabled: builtinOrDemo,
              hint: builtinOrDemo ? (a.source === 'demo' ? 'Turn the demo off instead' : 'Ships with the app — hide it instead') : undefined,
              onSelect: () => void deleteBot(a),
            },
          ]
        : []),
    ]
  }

  const sectionMenuItems = (s: SidebarSection): MenuItem[] => {
    const i = sections.findIndex(x => x.id === s.id)
    return [
      { key: 'rename', label: 'Rename section…', icon: <Pencil className="h-4 w-4" strokeWidth={1.8} />, onSelect: () => setDialog({ kind: 'rename-section', section: s }) },
      { key: 'up', label: 'Move up', icon: <ArrowUp className="h-4 w-4" strokeWidth={1.8} />, disabled: i <= 0, onSelect: () => void sidebar.moveSection(s.id, -1) },
      {
        key: 'down',
        label: 'Move down',
        icon: <ArrowDown className="h-4 w-4" strokeWidth={1.8} />,
        disabled: i < 0 || i >= sections.length - 1,
        onSelect: () => void sidebar.moveSection(s.id, 1),
      },
      {
        key: 'delete',
        label: 'Delete section…',
        icon: <Trash2 className="h-4 w-4" strokeWidth={1.8} />,
        danger: true,
        separator: true,
        hint: 'Its bots move to Other bots',
        onSelect: () =>
          void (async () => {
            const ok = await confirm({
              title: `Delete the section "${s.name}"?`,
              message: 'Only the section goes. Its bots move to Other bots — none are deleted or hidden.',
              confirmLabel: 'Delete section',
              danger: true,
            })
            if (ok) await sidebar.deleteSection(s.id)
          })(),
      },
    ]
  }

  const openBotMenu = (a: ChatAgentInfo) => (anchor: MenuAnchor, trigger: HTMLElement) => setMenu({ kind: 'bot', agent: a, anchor, trigger })

  const chips: { key: SidebarFilter; label: string; count?: number }[] = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread', count: view.counts.unread },
    { key: 'pinned', label: 'Pinned', count: view.counts.pinned },
    ...sections.map(s => ({ key: `section:${s.id}` as SidebarFilter, label: s.name })),
    ...(view.counts.hidden > 0 || filter === 'hidden' ? [{ key: 'hidden' as SidebarFilter, label: 'Hidden', count: view.counts.hidden }] : []),
  ]

  const emptyText =
    query.trim() !== ''
      ? `No bots match "${query.trim()}"`
      : filter === 'unread'
        ? "You're all caught up"
        : filter === 'pinned'
          ? 'Nothing pinned yet — open a bot\'s menu and pick Pin to top'
          : filter === 'hidden'
            ? 'No hidden bots'
            : filter.startsWith('section:')
              ? 'No bots in this section yet — move one here from its menu'
              : 'Every bot is hidden — see the Hidden filter'

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-2 px-4 pb-1 pt-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-[18px] font-semibold tracking-[-0.02em] text-fg-0">Bots</h1>
          <p className="mt-0.5 text-[12.5px] text-fg-2">One ongoing conversation with each bot.</p>
        </div>
        <IconButton label="New section" onClick={() => setDialog({ kind: 'new-section' })} className="h-8 w-8">
          <FolderPlus className="h-[18px] w-[18px]" strokeWidth={1.7} aria-hidden="true" />
        </IconButton>
      </div>

      <div role="search" aria-label="Filter bots" className="space-y-2 px-3 pb-2 pt-1">
        <SearchInput
          aria-label="Filter bots by name or message"
          placeholder="Filter bots"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              setQuery('')
            }
          }}
          className="bg-surface-2"
        />
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]" aria-label="Show">
          {chips.map(c => {
            const on = filter === c.key
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(c.key)}
                className={cn(
                  'flex min-h-[32px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12.5px] transition-colors duration-fast sm:min-h-[28px]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  on ? 'border-transparent bg-fg-0 text-surface-0' : 'border-line text-fg-2 hover:border-line-strong hover:text-fg-0',
                )}
              >
                {c.label}
                {!!c.count && c.count > 0 && <span className={cn('tabular-nums', on ? 'opacity-70' : 'text-fg-3')}>{c.count}</span>}
              </button>
            )
          })}
        </div>
      </div>

      <nav aria-label="Bots" className="flex-1 overflow-y-auto px-2 pb-3">
        {view.rail.length > 0 && (
          <section aria-label="Pinned bots" className="px-1 pb-2 pt-1">
            <ul className="grid grid-cols-4 gap-x-1 gap-y-2">
              {view.rail.map(a => (
                <PinnedTile
                  key={a.slug}
                  agent={a}
                  entry={botState(state, a.slug)}
                  active={a.slug === active}
                  onPick={() => onPick(a.slug)}
                  onMenu={openBotMenu(a)}
                />
              ))}
            </ul>
          </section>
        )}

        {view.groups.map(g => {
          const collapsed = !!g.section?.collapsed && filter === 'all' && !query.trim()
          const unreadIn = g.agents.filter(a => botState(state, a.slug).unread).length
          return (
            <section key={g.key} aria-label={g.title ?? 'Bots'} className={cn(g.title && 'mt-2 first:mt-0')}>
              {g.title && (
                <div className="group/section flex items-center gap-1 px-1.5 pb-1 pt-2">
                  {g.section ? (
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() => void sidebar.setCollapsed(g.section!.id, !g.section!.collapsed)}
                      onContextMenu={e => {
                        e.preventDefault()
                        setMenu({ kind: 'section', section: g.section!, anchor: { x: e.clientX, y: e.clientY }, trigger: e.currentTarget })
                      }}
                      className="flex min-h-[28px] min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                    >
                      <ChevronDown
                        className={cn('h-3.5 w-3.5 shrink-0 text-fg-3 transition-transform duration-fast', collapsed && '-rotate-90')}
                        strokeWidth={2}
                        aria-hidden="true"
                      />
                      <span className="truncate text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-2">{g.title}</span>
                      {collapsed && unreadIn > 0 && <UnreadDot label={`${unreadIn} unread in this section`} className="h-1.5 w-1.5" />}
                    </button>
                  ) : (
                    <h2 className="flex min-h-[28px] min-w-0 flex-1 items-center px-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-2">
                      {g.title}
                    </h2>
                  )}
                  {g.section && (
                    <button
                      type="button"
                      aria-label={`Actions for the section ${g.title}`}
                      aria-haspopup="menu"
                      onClick={e => setMenu({ kind: 'section', section: g.section!, anchor: anchorFor(e.currentTarget), trigger: e.currentTarget })}
                      className="grid h-7 w-7 place-items-center rounded-md text-fg-3 opacity-0 transition-opacity duration-fast hover:bg-surface-3 hover:text-fg-0 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 group-hover/section:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <MoreHorizontal className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
              {!collapsed &&
                (g.agents.length > 0 ? (
                  <ul className="space-y-px">
                    {g.agents.map(a => (
                      <BotRow
                        key={a.slug}
                        agent={a}
                        entry={botState(state, a.slug)}
                        active={a.slug === active}
                        onPick={() => onPick(a.slug)}
                        onMenu={openBotMenu(a)}
                      />
                    ))}
                  </ul>
                ) : (
                  g.section && <p className="px-3 pb-1 text-[12px] text-fg-3">Empty — move a bot here from its menu.</p>
                ))}
            </section>
          )
        })}

        {view.empty && <p className="px-3 py-6 text-center text-[13px] text-fg-2">{emptyText}</p>}
      </nav>

      {isAdmin && (
        <div className="border-t border-line-soft px-4 py-3">
          <button
            onClick={() => onDemo(!data.demo)}
            disabled={demoBusy}
            className="min-h-[44px] w-full rounded-md px-2 text-left text-[12.5px] text-fg-2 transition-colors duration-fast hover:bg-surface-3 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-45"
          >
            {data.demo ? 'Demo bot is on — turn it off' : 'Turn on the demo bot (sample inbox + calendar)'}
          </button>
        </div>
      )}

      {menu?.kind === 'bot' && (
        <ContextMenu label={`Actions for ${menu.agent.name}`} items={botMenuItems(menu.agent)} anchor={menu.anchor} onClose={closeMenu} />
      )}
      {menu?.kind === 'section' && (
        <ContextMenu label={`Actions for the section ${menu.section.name}`} items={sectionMenuItems(menu.section)} anchor={menu.anchor} onClose={closeMenu} />
      )}

      {dialog?.kind === 'new-section' && (
        <NameDialog
          title="New section"
          label="Section name"
          initial=""
          hint="Group bots the way you work, e.g. Development or Marketing. Only you see your sections."
          maxLength={40}
          confirmLabel="Add section"
          onClose={() => setDialog(null)}
          onSubmit={async name => {
            const s = await sidebar.createSection(name)
            if (s && dialog.thenMove) await sidebar.moveTo(dialog.thenMove, s.id)
            return !!s
          }}
        />
      )}
      {dialog?.kind === 'rename-section' && (
        <NameDialog
          title="Rename section"
          label="Section name"
          initial={dialog.section.name}
          maxLength={40}
          confirmLabel="Save"
          onClose={() => setDialog(null)}
          onSubmit={name => sidebar.renameSection(dialog.section.id, name)}
        />
      )}
      {dialog?.kind === 'rename-bot' && (
        <NameDialog
          title={`Rename ${dialog.agent.name}`}
          label="Bot name"
          initial={dialog.agent.name}
          hint={`Renames the bot for everyone on this install. Its ID (${dialog.agent.slug}) and link stay the same.`}
          maxLength={60}
          confirmLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={name => renameBot(dialog.agent, name)}
          extra={
            dialog.agent.file_name && dialog.agent.file_name !== dialog.agent.name
              ? { label: `Reset to "${dialog.agent.file_name}"`, onClick: () => renameBot(dialog.agent, null) }
              : undefined
          }
        />
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-4 z-[70] sm:bottom-4">
          <Toast tone={toast.tone} onDismiss={() => setToast(null)}>
            {toast.text}
          </Toast>
        </div>
      )}
      {confirmDialog}
    </div>
  )
}
