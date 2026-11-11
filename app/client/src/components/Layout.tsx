import { useState, useRef, useEffect, useMemo, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import { Check, Moon, Sun } from 'lucide-react'
import { useBoardTheme } from '../preview/BoardShell'
import { useBranding } from '../hooks/useBranding'
import { BrandLogo } from './BrandLogo'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from '../context/nav'
import { useWorkspaces } from '../hooks/useWorkspaces'
import type { Workspace } from '@operationkit/shared'
import { CommandPalette } from './CommandPalette'
import { AlertBell } from './AlertBell'
import { NavIcon, type NavIconName } from './nav-icons'
import { HAS_CHAT_PAGE } from '../lib/optional-pages'
import { SYSTEM_ROUTE, LEGACY_SYSTEM_ROUTES, AGENTS_ROUTE, JOBS_ROUTE, agentsTabRoute } from '../lib/routes'

interface LayoutProps {
  children: ReactNode
  /** Selected workspace slugs. An empty array means "All Workspaces". */
  selectedWorkspaces: Workspace[]
  onWorkspacesChange: (ws: Workspace[]) => void
}

/* ─────────────────────────────────────────────────────────────────────────
   Navigation IA (Sprint 4a, obj 900495)
   ----------------------------------------------------------------------------
   Two places, one model each:

     • NAV_GROUPS — the primary bar: Bots (when the chat page is in the build),
       Board, Knowledge base, Jobs. The desktop top bar and the 390px bottom
       bar render the same ≤4 items. There is no "More" group any more.
     • ACCOUNT_MENU — the avatar dropdown, the same menu on desktop and mobile:
       Settings and Archive for everyone, then an Admin section (System,
       Agents) for global admins. Everything that used to sit under "More"
       lives here; the old → new table is docs/navigation/sprint-4a-navigation.md.

   The unfinished surfaces (Contacts, Strategies, Development, Notes, Status,
   Feed) were removed in obj 900543; their old URLs redirect to the board
   (REMOVED_ROUTES in lib/routes.ts).
   ───────────────────────────────────────────────────────────────────────── */

type NavGate = 'admin' | 'chat'

interface NavItem {
  href: string
  label: string
  /** Shorter label for the 390px bottom bar, where the tabs share the width. */
  shortLabel?: string
  icon: NavIconName
  aliases: string[]
  gate?: NavGate
}

interface NavGroup {
  id: string
  label: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    id: 'primary',
    label: 'Work',
    items: [
      // Talking to a bot is how most people use the product, so it leads. Gated on the page being in
      // the build. The href stays /chat (obj 900327): the label was renamed, the URL is a bookmark.
      { href: '/chat',      label: 'Bots',           icon: 'chat',  aliases: [],        gate: 'chat' },
      { href: '/',          label: 'Board',          icon: 'board', aliases: [] },
      { href: '/knowledge', label: 'Knowledge base', shortLabel: 'Knowledge', icon: 'docs', aliases: ['/docs'] },
      // Worst case (admin) is Bots, Board, Knowledge base, Jobs = 4 tabs at 390px.
      { href: JOBS_ROUTE,   label: 'Jobs',           icon: 'jobs',  aliases: [],        gate: 'admin' },
    ],
  },
]

/** One row of the avatar dropdown. */
export interface AccountMenuItem {
  href: string
  label: string
  icon: NavIconName
  /** Other paths that should light this row up (old URLs that redirect here). */
  aliases: string[]
  /** 'admin' rows render under an "Admin" label, for global admins only. */
  section: 'account' | 'admin'
}

export const ACCOUNT_MENU: AccountMenuItem[] = [
  { href: '/settings',   label: 'Settings', icon: 'config',    aliases: [],                          section: 'account' },
  { href: '/archive',    label: 'Archive',  icon: 'archive',   aliases: [],                          section: 'account' },
  { href: SYSTEM_ROUTE,  label: 'System',   icon: 'dashboard', aliases: [...LEGACY_SYSTEM_ROUTES],    section: 'admin' },
  { href: AGENTS_ROUTE,  label: 'Agents',   icon: 'system',    aliases: ['/agent-templates'],         section: 'admin' },
]


export function Layout({ children, selectedWorkspaces, onWorkspacesChange }: LayoutProps) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { slugs: wsSlugs, labelOf, shortOf } = useWorkspaces()
  const currentPath = window.location.pathname

  // Intercept plain left-clicks on nav anchors → in-app navigation (no reload).
  // Modified clicks (cmd/ctrl/shift/alt) and non-primary buttons fall through to
  // the real <a href> so middle/cmd-click still opens a new tab and URLs stay
  // shareable. Closes any open menus on a successful in-app nav.
  const onNavClick = (href: string) => (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented) return
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(href)
    setUserMenuOpen(false)
  }
  const isAdmin = user?.role === 'admin'
  const { theme, toggleTheme } = useBoardTheme()
  const brandName = useBranding().name
  const showWorkspace =
    currentPath === '/' || currentPath === '/archive'
    || /^\/w\/[\w-]+\/?$/.test(currentPath)
    || /^\/o\/\d+\/?$/.test(currentPath)

  const canSeeSettings = useMemo(() => {
    if (isAdmin) return true
    return user?.workspaces?.some(w => w.role === 'admin') ?? false
  }, [isAdmin, user?.workspaces])

  // Apply permission gating once, against the single nav model.
  const gatePass = (item: NavItem) => {
    if (item.gate === 'admin') return isAdmin
    if (item.gate === 'chat') return HAS_CHAT_PAGE
    return true
  }

  const navItems = useMemo(
    () => NAV_GROUPS.flatMap(g => g.items.filter(gatePass)),
    [isAdmin]
  )

  // Avatar dropdown rows the caller may see: account rows for everyone, the
  // Admin section for global admins only (same gate the items had under "More").
  const accountRows = useMemo(() => ACCOUNT_MENU.filter(i => i.section === 'account'), [])
  const adminRows = useMemo(() => (isAdmin ? ACCOUNT_MENU.filter(i => i.section === 'admin') : []), [isAdmin])

  const isActive = (item: NavItem) => {
    if (item.href === '/') return currentPath === '/' || /^\/w\//.test(currentPath) || /^\/o\//.test(currentPath)
    return currentPath === item.href || item.aliases.includes(currentPath)
  }
  const isMenuActive = (item: AccountMenuItem) =>
    currentPath === item.href || currentPath.startsWith(item.href + '/') || item.aliases.includes(currentPath)
  const menuActive = [...accountRows, ...adminRows].some(isMenuActive)

  const availableWorkspaces = useMemo(() => {
    if (isAdmin) return ['all', ...wsSlugs] as Workspace[]
    const userWs = (user?.workspaces?.map(w => w.workspace) || []) as Workspace[]
    return userWs.length > 1 ? ['all' as Workspace, ...userWs] : userWs
  }, [isAdmin, user?.workspaces, wsSlugs])

  const hideWorkspaceSelector = availableWorkspaces.length <= 1

  // Toggleable workspace options (the 'all' sentinel is rendered separately).
  const wsOptions = useMemo(
    () => availableWorkspaces.filter(w => w !== 'all'),
    [availableWorkspaces],
  )
  const isAllSelected = selectedWorkspaces.length === 0
  const selectionLabel = isAllSelected
    ? shortOf('all')
    : selectedWorkspaces.length === 1
      ? shortOf(selectedWorkspaces[0])
      : selectedWorkspaces.length === 2
        ? selectedWorkspaces.map(shortOf).join(' + ')
        : `${selectedWorkspaces.length} spaces`

  function toggleWorkspace(ws: Workspace) {
    const next = selectedWorkspaces.includes(ws)
      ? selectedWorkspaces.filter(w => w !== ws)
      : [...selectedWorkspaces, ws]
    onWorkspacesChange(next)
  }
  function selectAllWorkspaces() {
    onWorkspacesChange([])
    setWsDropdownOpen(false)
  }

  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const userMenuMobileRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<HTMLDivElement>(null)
  const wsMobileRef = useRef<HTMLDivElement>(null)

  // Outside-click + Escape close the open menus.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const t = e.target as Node
      if (userMenuRef.current && !userMenuRef.current.contains(t) && userMenuMobileRef.current && !userMenuMobileRef.current.contains(t)) setUserMenuOpen(false)
      if (wsRef.current && !wsRef.current.contains(t) && wsMobileRef.current && !wsMobileRef.current.contains(t)) setWsDropdownOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setUserMenuOpen(false); setWsDropdownOpen(false) }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [])

  // ⌘K / Ctrl+K — desktop only via media-query gate; we still listen everywhere
  // but the palette UI is hidden under <sm anyway.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen(o => !o)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // ⌘K palette lists the full gated nav set: primary bar, avatar menu, settings, parked pages.
  const paletteItems = useMemo(() => {
    const items = [...navItems, ...accountRows, ...adminRows].map(n => ({
      label: n.label,
      hint: n.href,
      onSelect: () => { navigate(n.href) },
    }))
    items.push({ label: 'Settings', hint: '/settings', onSelect: () => { navigate('/settings') } })
    items.push({ label: 'Integrations', hint: '/settings/integrations', onSelect: () => { navigate('/settings/integrations') } })
    if (canSeeSettings) {
      items.push({ label: 'Secrets', hint: '/settings/secrets', onSelect: () => { navigate('/settings/secrets') } })
    }
    if (isAdmin) {
      items.push(
        { label: 'Org settings', hint: '/settings/org', onSelect: () => { navigate('/settings/org') } },
        { label: 'Agent registry', hint: agentsTabRoute('registry'), onSelect: () => { navigate(agentsTabRoute('registry')) } },
        { label: 'Agent templates', hint: agentsTabRoute('templates'), onSelect: () => { navigate(agentsTabRoute('templates')) } },
      )
    }
    return items
  }, [navItems, accountRows, adminRows, canSeeSettings, isAdmin, navigate])

  // The avatar dropdown body — identical on desktop and mobile (rowClass sets the touch height).
  const renderAccountMenu = (rowClass: string) => (
    <>
      {accountRows.map(item => (
        <AccountMenuRow key={item.href} item={item} active={isMenuActive(item)} rowClass={rowClass} onClick={onNavClick(item.href)} />
      ))}
      {adminRows.length > 0 && (
        <>
          <div className="my-1 border-t border-line-soft" />
          <div className="px-3 pb-0.5 pt-1 text-[12px] uppercase tracking-[0.12em] text-fg-3 font-semibold tracking-[0.06em]">Admin</div>
          {adminRows.map(item => (
            <AccountMenuRow key={item.href} item={item} active={isMenuActive(item)} rowClass={rowClass} onClick={onNavClick(item.href)} />
          ))}
        </>
      )}
      <div className="my-1 border-t border-line-soft" />
      <button
        role="menuitem"
        onClick={() => { logout(); setUserMenuOpen(false) }}
        className={`w-full px-3 text-left text-sm text-fg-1 outline-none transition-colors duration-fast ease-out hover:bg-surface-2 hover:text-fg-0 focus-visible:bg-surface-2 ${rowClass}`}
      >
        Log out
      </button>
    </>
  )

  return (
    // overflow-x-hidden: platform-wide guarantee that no route can introduce a
    // horizontal scrollbar at 390px (the W8 mobile-clean shell constraint).
    <div className="flex h-full flex-col overflow-x-hidden bg-surface-0">
      {/* ── Desktop top bar ── */}
      <header className="hidden items-center justify-between border-b border-line bg-surface-0 px-5 py-2 sm:flex">
        {/* Left: brand + primary nav */}
        <nav aria-label="Primary" className="flex items-center gap-0.5">
          <a href="/" aria-label={`${brandName} home`} onClick={onNavClick('/')} className="mr-3 flex min-w-0 items-center rounded-md">
            <BrandLogo theme={theme} size="sm" />
          </a>
          {navItems.map(item => {
            const active = isActive(item)
            return (
              <a
                key={item.href}
                href={item.href}
                onClick={onNavClick(item.href)}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent/60 ${
                  active ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:bg-surface-2 hover:text-fg-0'
                }`}
              >
                <NavIcon name={item.icon} variant={active ? 'solid' : 'outline'} className="h-3.5 w-3.5" />
                {item.label}
              </a>
            )
          })}
        </nav>

        {/* Center: ⌘K trigger + workspace dropdown */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaletteOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-fg-2 outline-none transition-colors duration-fast ease-out hover:border-line-strong hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label="Open command palette"
          >
            <NavIcon name="search" className="h-3.5 w-3.5" />
            <span>Jump to…</span>
            <span className="font-mono text-[12px] text-fg-3">⌘K</span>
          </button>
          {showWorkspace && !hideWorkspaceSelector && (
            <div ref={wsRef} className="relative">
              <button
                onClick={() => setWsDropdownOpen(!wsDropdownOpen)}
                className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-fg-1 outline-none transition-colors duration-fast ease-out hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <span className="font-medium text-accent">{selectionLabel}</span>
                <NavIcon name="chevron" className="h-3 w-3 text-fg-3" />
              </button>
              {wsDropdownOpen && (
                <div className="absolute left-1/2 top-full z-50 mt-1.5 w-52 -translate-x-1/2 rounded-md border border-line bg-surface-1 py-1 shadow-pop">
                  <button
                    onClick={selectAllWorkspaces}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors duration-fast ease-out ${
                      isAllSelected ? 'bg-surface-3 text-fg-0' : 'text-fg-1 hover:bg-surface-2 hover:text-fg-0'
                    }`}
                  >
                    <span>{labelOf('all')}</span>
                    {isAllSelected && <Check className="h-3.5 w-3.5 text-accent" />}
                  </button>
                  <div className="my-1 border-t border-line-soft" />
                  {wsOptions.map(ws => {
                    const selected = selectedWorkspaces.includes(ws)
                    return (
                      <button
                        key={ws}
                        onClick={() => toggleWorkspace(ws)}
                        aria-pressed={selected}
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors duration-fast ease-out ${
                          selected ? 'bg-surface-3 text-fg-0' : 'text-fg-1 hover:bg-surface-2 hover:text-fg-0'
                        }`}
                      >
                        <span>{labelOf(ws)}</span>
                        {selected && <Check className="h-3.5 w-3.5 text-accent" />}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: notifications, theme, avatar menu (Settings, Archive, Admin → System / Agents) */}
        {user && (
          <div className="flex items-center gap-1">
            <AlertBell />
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-2 outline-none transition-colors duration-fast ease-out hover:bg-surface-2 hover:text-fg-0 focus-visible:ring-2 focus-visible:ring-accent/60"
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            >
              {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </button>
          <div ref={userMenuRef} className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              aria-label="Account menu"
              className={`inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent/60 ${
                menuActive || userMenuOpen ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:bg-surface-2 hover:text-fg-0'
              }`}
            >
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/10 text-[12px] font-medium text-accent">
                {user.username[0].toUpperCase()}
              </div>
              <span className="hidden lg:inline">{user.username}</span>
              <NavIcon name="chevron" className="h-3 w-3 text-fg-3" />
            </button>
            {userMenuOpen && (
              <div role="menu" className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-md border border-line bg-surface-1 py-1 shadow-pop">
                <div className="border-b border-line-soft px-3 py-2">
                  <div className="text-sm font-medium text-fg-0">{user.username}</div>
                  {isAdmin && (
                    <span className="mt-0.5 inline-block rounded-sm bg-status-review/20 px-1.5 py-0.5 text-[12px] text-status-review">admin</span>
                  )}
                </div>
                <div className="pt-1">{renderAccountMenu('py-1.5')}</div>
              </div>
            )}
          </div>
          </div>
        )}
      </header>

      {/* ── Mobile top bar (minimal) ── */}
      <header className="flex items-center justify-between border-b border-line bg-surface-0 px-3 py-2 sm:hidden"
        style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' }}
      >
        <a href="/" aria-label={`${brandName} home`} onClick={onNavClick('/')} className="flex min-w-0 items-center rounded-md">
          <BrandLogo theme={theme} size="sm" showName={false} allowWordmark={false} />
        </a>

        {showWorkspace && !hideWorkspaceSelector && (
          <div ref={wsMobileRef} className="relative">
            <button
              onClick={() => setWsDropdownOpen(!wsDropdownOpen)}
              className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-2.5 py-1 text-sm text-fg-1"
            >
              <span className="font-medium text-accent">{selectionLabel}</span>
              <NavIcon name="chevron" className="h-3 w-3 text-fg-3" />
            </button>
            {wsDropdownOpen && (
              <div className="absolute left-1/2 top-full z-50 mt-1 w-48 -translate-x-1/2 rounded-md border border-line bg-surface-1 py-1 shadow-pop">
                <button
                  onClick={selectAllWorkspaces}
                  className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                    isAllSelected ? 'bg-surface-3 text-fg-0' : 'text-fg-1 hover:bg-surface-2 hover:text-fg-0'
                  }`}
                >
                  <span>{labelOf('all')}</span>
                  {isAllSelected && <Check className="h-3.5 w-3.5 text-accent" />}
                </button>
                <div className="my-1 border-t border-line-soft" />
                {wsOptions.map(ws => {
                  const selected = selectedWorkspaces.includes(ws)
                  return (
                    <button
                      key={ws}
                      onClick={() => toggleWorkspace(ws)}
                      aria-pressed={selected}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm ${
                        selected ? 'bg-surface-3 text-fg-0' : 'text-fg-1 hover:bg-surface-2 hover:text-fg-0'
                      }`}
                    >
                      <span>{labelOf(ws)}</span>
                      {selected && <Check className="h-3.5 w-3.5 text-accent" />}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {user && (
          <div className="flex items-center gap-1">
            <AlertBell />
            <button
              type="button"
              onClick={toggleTheme}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-2"
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
            >
              {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
            </button>
          <div ref={userMenuMobileRef} className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-haspopup="menu"
              aria-expanded={userMenuOpen}
              aria-label="Account menu"
              className={`flex h-7 w-7 items-center justify-center rounded-full text-[12px] font-medium text-accent ${
                menuActive || userMenuOpen ? 'bg-accent/25 ring-1 ring-accent/50' : 'bg-accent/15'
              }`}
            >
              {user.username[0].toUpperCase()}
            </button>
            {userMenuOpen && (
              <div role="menu" className="absolute right-0 top-full z-50 mt-1.5 w-56 rounded-md border border-line bg-surface-1 py-1 shadow-pop">
                <div className="border-b border-line-soft px-3 py-2">
                  <div className="text-sm font-medium text-fg-0">{user.username}</div>
                  {isAdmin && (
                    <span className="mt-0.5 inline-block rounded-sm bg-status-review/20 px-1.5 py-0.5 text-[12px] text-status-review">admin</span>
                  )}
                </div>
                <div className="pt-1">{renderAccountMenu('min-h-[44px]')}</div>
              </div>
            )}
          </div>
          </div>
        )}
      </header>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0">{children}</main>

      {/* ── Mobile bottom tab bar (≤4 tabs; the rest lives in the avatar menu) ── */}
      <nav
        aria-label="Primary"
        className="fixed bottom-0 left-0 right-0 z-40 border-t border-line bg-surface-1 sm:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-stretch">
          {navItems.map(item => {
            const active = isActive(item)
            return (
              <a
                key={item.href}
                href={item.href}
                onClick={onNavClick(item.href)}
                aria-current={active ? 'page' : undefined}
                aria-label={item.shortLabel ? item.label : undefined}
                className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors duration-fast ease-out ${
                  active ? 'text-accent' : 'text-fg-2'
                }`}
                style={{ minHeight: 44 }}
              >
                <NavIcon name={item.icon} variant={active ? 'solid' : 'outline'} className="h-5 w-5" />
                <span className="text-[12px] font-medium">{item.shortLabel ?? item.label}</span>
              </a>
            )
          })}
        </div>
      </nav>

      {/* ⌘K palette — desktop only via the CSS gate; on mobile it never appears
          because the only entry point is the keyboard shortcut. */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
      />
    </div>
  )
}

function AccountMenuRow({
  item,
  active,
  rowClass,
  onClick,
}: {
  item: AccountMenuItem
  active: boolean
  rowClass: string
  onClick: (e: ReactMouseEvent<HTMLAnchorElement>) => void
}) {
  return (
    <a
      href={item.href}
      onClick={onClick}
      role="menuitem"
      aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2.5 px-3 text-sm outline-none transition-colors duration-fast ease-out focus-visible:bg-surface-2 ${rowClass} ${
        active ? 'bg-surface-3 text-fg-0' : 'text-fg-1 hover:bg-surface-2 hover:text-fg-0'
      }`}
    >
      <NavIcon name={item.icon} variant={active ? 'solid' : 'outline'} className="h-4 w-4 text-fg-3" />
      {item.label}
    </a>
  )
}

