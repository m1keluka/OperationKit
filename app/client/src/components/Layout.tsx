import { useState, useRef, useEffect, useMemo, Fragment, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import { Check, Moon, Sun } from 'lucide-react'
import { useBoardTheme } from '../preview/BoardShell'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from '../context/nav'
import { useWorkspaces } from '../hooks/useWorkspaces'
import type { Workspace } from '@command-center/shared'
import { CommandPalette } from './CommandPalette'
import { AlertBell } from './AlertBell'
import { NavIcon, type NavIconName } from './nav-icons'

interface LayoutProps {
  children: ReactNode
  /** Selected workspace slugs. An empty array means "All Workspaces". */
  selectedWorkspaces: Workspace[]
  onWorkspacesChange: (ws: Workspace[]) => void
}

/* ─────────────────────────────────────────────────────────────────────────
   Navigation IA (W17)
   ----------------------------------------------------------------------------
   ONE source of truth: NAV_GROUPS. Sections are grouped by *kind* so the
   structure stays coherent as sections are added:

     • primary — Board, Jarvis, Jobs
     • more    — Content, Docs, Dashboard. Settings lives in the user menu.
       Unfinished surfaces (Contacts, Strategies, Development, Notes, Status,
       Feed) stay routed + ⌘K-able but are not in the chrome.

   Each item declares its permission `gate` (preserved exactly from the prior
   nav) and a `mobile` placement. Both viewports render from this same model:

     • Mobile bottom bar — at most 5 hits: the four `mobile:'tab'` items
       (Board, Jarvis, Contacts, Docs) + a grouped "More" overflow holding
       every `mobile:'more'` item. ≤5 tabs is a hard constraint (390px).
     • Desktop top bar — has more room, so the Work / Automation / Directory
       groups render inline (hairline-separated) and the System group collapses
       into a single "System ▾" overflow — the desktop counterpart of "More".

   Same grouping, different overflow threshold per viewport = responsive IA.
   ───────────────────────────────────────────────────────────────────────── */

type NavGate = 'jarvis' | 'admin'

interface NavItem {
  href: string
  label: string
  icon: NavIconName
  aliases: string[]
  gate?: NavGate
  mobile: 'tab' | 'more'
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
      { href: '/',       label: 'Board',  icon: 'board',  aliases: [],                    mobile: 'tab' },
      { href: '/jarvis', label: 'Jarvis', icon: 'jarvis', aliases: ['/mentor', '/assistant'], gate: 'jarvis', mobile: 'tab' },
      { href: '/jobs',   label: 'Jobs',   icon: 'jobs',   aliases: [],                    gate: 'admin', mobile: 'tab' },
    ],
  },
  {
    id: 'more',
    label: 'More',
    items: [
      { href: '/archive',   label: 'Archive',   icon: 'archive',   aliases: [],                        mobile: 'more' },
      { href: '/granola',   label: 'Content',   icon: 'content',   aliases: [],         gate: 'admin', mobile: 'more' },
      { href: '/docs',      label: 'Docs',      icon: 'docs',      aliases: [],                        mobile: 'more' },
      { href: '/dashboard', label: 'Dashboard', icon: 'dashboard', aliases: ['/costs'], gate: 'admin', mobile: 'more' },
    ],
  },
]

// Desktop overflow (the counterpart of mobile "More").
const DESKTOP_MENU_GROUP = 'more'

// One Settings entry in the user menu. Tabs inside /settings cover You / Secrets / Org.
const SETTINGS_NAV: { href: string; label: string; always?: boolean }[] = [
  { href: '/settings', label: 'Settings', always: true },
]

// Parked surfaces: still in the app, not in the chrome. ⌘K is the back door.
const PALETTE_ONLY: { href: string; label: string; gate?: NavGate }[] = [
  { href: '/contacts',    label: 'Contacts' },
  { href: '/strategies',  label: 'Strategies',  gate: 'admin' },
  { href: '/development', label: 'Development', gate: 'admin' },
  { href: '/loops',       label: 'Notes',       gate: 'admin' },
  { href: '/status',      label: 'Status' },
  { href: '/feed',        label: 'Feed',        gate: 'admin' },
]

export function Layout({ children, selectedWorkspaces, onWorkspacesChange }: LayoutProps) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { slugs: wsSlugs, labelOf, shortOf } = useWorkspaces()
  const currentPath = window.location.pathname

  // Intercept plain left-clicks on nav anchors → in-app navigation (no reload).
  // Modified clicks (cmd/ctrl/shift/alt) and non-primary buttons fall through to
  // the real <a href> so middle/cmd-click still opens a new tab and URLs stay
  // shareable. Closes any open overflow menus on a successful in-app nav.
  const onNavClick = (href: string) => (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented) return
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(href)
    setSystemMenuOpen(false)
    setMobileMoreOpen(false)
    setUserMenuOpen(false)
  }
  const isAdmin = user?.role === 'admin'
  const { theme, toggleTheme } = useBoardTheme()
  const showWorkspace =
    currentPath === '/' || currentPath === '/feed' || currentPath === '/archive'
    || /^\/w\/[\w-]+\/?$/.test(currentPath)
    || /^\/o\/\d+\/?$/.test(currentPath)

  const canUseJarvis = useMemo(() => {
    if (isAdmin) return true
    return user?.workspaces?.some(w => w.can_use_jarvis) ?? false
  }, [isAdmin, user?.workspaces])

  const canSeeSettings = useMemo(() => {
    if (isAdmin) return true
    return user?.workspaces?.some(w => w.role === 'admin') ?? false
  }, [isAdmin, user?.workspaces])

  // Settings entries the caller may actually see: always-on (e.g. Account) for
  // everyone, admin-gated ones only when canSeeSettings. The "Settings" section
  // renders whenever this is non-empty.
  const visibleSettingsNav = useMemo(
    () => SETTINGS_NAV.filter(item => item.always || canSeeSettings),
    [canSeeSettings],
  )

  // Apply permission gating once, against the single nav model.
  const gatePass = (item: NavItem) => {
    if (item.gate === 'admin') return isAdmin
    if (item.gate === 'jarvis') return canUseJarvis
    return true
  }

  // Gate-filtered groups (drop empty groups). Everything below derives from this.
  const groups = useMemo(
    () =>
      NAV_GROUPS
        .map(g => ({ ...g, items: g.items.filter(gatePass) }))
        .filter(g => g.items.length > 0),
    [isAdmin, canUseJarvis]
  )

  const allItems = useMemo(() => groups.flatMap(g => g.items), [groups])

  // Desktop: inline groups vs. the System overflow menu.
  const inlineGroups = useMemo(() => groups.filter(g => g.id !== DESKTOP_MENU_GROUP), [groups])
  const systemGroup = useMemo(() => groups.find(g => g.id === DESKTOP_MENU_GROUP) ?? null, [groups])

  // Mobile: ≤4 fixed tabs + a grouped "More" overflow with the rest.
  const mobileTabs = useMemo(() => allItems.filter(i => i.mobile === 'tab'), [allItems])
  const mobileMoreGroups = useMemo(
    () =>
      groups
        .map(g => ({ ...g, items: g.items.filter(i => i.mobile === 'more') }))
        .filter(g => g.items.length > 0),
    [groups]
  )

  const isActive = (item: NavItem) => {
    if (item.href === '/') return currentPath === '/' || /^\/w\//.test(currentPath) || /^\/o\//.test(currentPath)
    if (item.href === '/settings') return currentPath.startsWith('/settings')
    if (item.href === '/development') return currentPath.startsWith('/development')
    if (item.href === '/strategies') return currentPath === '/strategies' || currentPath.startsWith('/strategy/')
    return currentPath === item.href || item.aliases.includes(currentPath)
  }

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
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const [systemMenuOpen, setSystemMenuOpen] = useState(false)
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const userMenuMobileRef = useRef<HTMLDivElement>(null)
  const mobileMoreRef = useRef<HTMLDivElement>(null)
  const systemMenuRef = useRef<HTMLDivElement>(null)
  const wsRef = useRef<HTMLDivElement>(null)
  const wsMobileRef = useRef<HTMLDivElement>(null)

  // Outside-click handler
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const t = e.target as Node
      if (userMenuRef.current && !userMenuRef.current.contains(t) && userMenuMobileRef.current && !userMenuMobileRef.current.contains(t)) setUserMenuOpen(false)
      if (mobileMoreRef.current && !mobileMoreRef.current.contains(t)) setMobileMoreOpen(false)
      if (systemMenuRef.current && !systemMenuRef.current.contains(t)) setSystemMenuOpen(false)
      if (wsRef.current && !wsRef.current.contains(t) && wsMobileRef.current && !wsMobileRef.current.contains(t)) setWsDropdownOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
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

  // ⌘K palette lists the FULL gated nav set (every group, incl. items that live
  // under the System / More overflows) plus account settings.
  const paletteItems = useMemo(() => {
    const items = allItems.map(n => ({
      label: n.label,
      hint: n.href,
      onSelect: () => { navigate(n.href) },
    }))
    items.push({ label: 'Settings', hint: '/settings', onSelect: () => { navigate('/settings') } })
    if (canSeeSettings) {
      items.push({ label: 'Secrets', hint: '/settings/secrets', onSelect: () => { navigate('/settings/secrets') } })
    }
    if (isAdmin) {
      items.push(
        { label: 'Org settings', hint: '/settings/org', onSelect: () => { navigate('/settings/org') } },
        { label: 'Agents', hint: '/settings/agents', onSelect: () => { navigate('/settings/agents') } },
      )
    }
    for (const extra of PALETTE_ONLY) {
      if (extra.gate === 'admin' && !isAdmin) continue
      if (extra.gate === 'jarvis' && !canUseJarvis) continue
      items.push({ label: extra.label, hint: extra.href, onSelect: () => { navigate(extra.href) } })
    }
    return items
  }, [allItems, canSeeSettings, isAdmin, canUseJarvis, navigate])

  const systemActive = systemGroup?.items.some(isActive) ?? false

  return (
    // overflow-x-hidden: platform-wide guarantee that no route can introduce a
    // horizontal scrollbar at 390px (the W8 mobile-clean shell constraint).
    <div className="flex h-full flex-col overflow-x-hidden bg-surface-0">
      {/* ── Desktop top bar ── */}
      <header className="hidden items-center justify-between border-b border-line bg-surface-1 px-5 py-2 sm:flex">
        {/* Left: brand + grouped primary nav */}
        <div className="flex items-center gap-0.5">
          <a href="/" aria-label="OperationKit" onClick={onNavClick('/')} className="mr-2 text-[20px] font-bold leading-none tracking-tight text-accent">›</a>
          {inlineGroups.map((group, gi) => (
            <Fragment key={group.id}>
              {gi > 0 && <span aria-hidden className="mx-1.5 h-4 w-px bg-line" />}
              {group.items.map(item => {
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
            </Fragment>
          ))}

          {/* System overflow — desktop counterpart of mobile "More" */}
          {systemGroup && (
            <>
              <span aria-hidden className="mx-1.5 h-4 w-px bg-line" />
              <div ref={systemMenuRef} className="relative">
                <button
                  onClick={() => setSystemMenuOpen(o => !o)}
                  aria-haspopup="menu"
                  aria-expanded={systemMenuOpen}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium outline-none transition-colors duration-fast ease-out focus-visible:ring-2 focus-visible:ring-accent/60 ${
                    systemActive || systemMenuOpen ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:bg-surface-2 hover:text-fg-0'
                  }`}
                >
                  <NavIcon name="system" variant={systemActive ? 'solid' : 'outline'} className="h-3.5 w-3.5" />
                  {systemGroup.label}
                  <NavIcon name="chevron" className="h-3 w-3 text-fg-3" />
                </button>
                {systemMenuOpen && (
                  <div role="menu" className="absolute left-0 top-full z-50 mt-1.5 w-48 rounded-md border border-line bg-surface-1 py-1 shadow-pop">
                    {systemGroup.items.map(item => {
                      const active = isActive(item)
                      return (
                        <a
                          key={item.href}
                          href={item.href}
                          onClick={onNavClick(item.href)}
                          role="menuitem"
                          aria-current={active ? 'page' : undefined}
                          className={`flex items-center gap-2 px-3 py-1.5 text-sm outline-none transition-colors duration-fast ease-out focus-visible:bg-surface-3 ${
                            active ? 'bg-surface-3 text-fg-0' : 'text-fg-1 hover:bg-surface-2 hover:text-fg-0'
                          }`}
                        >
                          <NavIcon name={item.icon} variant={active ? 'solid' : 'outline'} className="h-4 w-4 text-fg-3" />
                          {item.label}
                        </a>
                      )
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Center: ⌘K trigger + workspace dropdown */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaletteOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-fg-2 outline-none transition-colors duration-fast ease-out hover:border-line-strong hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label="Open command palette"
          >
            <NavIcon name="search" className="h-3.5 w-3.5" />
            <span>Jump to…</span>
            <span className="font-mono text-[10.5px] text-fg-3">⌘K</span>
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

        {/* Right: alerts + user menu (account only — navigation lives in the bar) */}
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
              className="inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg-2 outline-none transition-colors duration-fast ease-out hover:bg-surface-2 hover:text-fg-0 focus-visible:ring-2 focus-visible:ring-accent/60"
            >
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/15 text-[11px] font-medium text-accent">
                {user.username[0].toUpperCase()}
              </div>
              <span className="hidden lg:inline">{user.username}</span>
              <NavIcon name="chevron" className="h-3 w-3 text-fg-3" />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1.5 w-48 rounded-md border border-line bg-surface-1 py-1 shadow-pop">
                <div className="border-b border-line-soft px-3 py-2">
                  <div className="text-sm font-medium text-fg-0">{user.username}</div>
                  {isAdmin && (
                    <span className="mt-0.5 inline-block rounded-sm bg-status-review/20 px-1.5 py-0.5 text-[10px] text-status-review">admin</span>
                  )}
                </div>
                {visibleSettingsNav.map(item => (
                      <a
                        key={item.href}
                        href={item.href}
                        onClick={onNavClick(item.href)}
                        className={`block px-3 py-1.5 text-sm transition-colors duration-fast ease-out ${
                          currentPath.startsWith(item.href) ? 'bg-surface-3 text-fg-0' : 'text-fg-1 hover:bg-surface-2 hover:text-fg-0'
                        }`}
                      >
                        {item.label}
                      </a>
                    ))}
                    {visibleSettingsNav.length > 0 && <div className="my-1 border-t border-line-soft" />}
                <button
                  onClick={() => { logout(); setUserMenuOpen(false) }}
                  className="w-full px-3 py-1.5 text-left text-sm text-fg-1 transition-colors duration-fast ease-out hover:bg-surface-2 hover:text-fg-0"
                >
                  Logout
                </button>
              </div>
            )}
          </div>
          </div>
        )}
      </header>

      {/* ── Mobile top bar (minimal) ── */}
      <header className="flex items-center justify-between border-b border-line bg-surface-1 px-3 py-2 sm:hidden"
        style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' }}
      >
        <a href="/" aria-label="OperationKit" onClick={onNavClick('/')} className="text-[20px] font-bold leading-none tracking-tight text-accent">›</a>

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
              className="flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-[11px] font-medium text-accent"
            >
              {user.username[0].toUpperCase()}
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 top-full z-50 mt-1.5 w-44 rounded-md border border-line bg-surface-1 py-1 shadow-pop">
                <div className="border-b border-line-soft px-3 py-2">
                  <div className="text-sm font-medium text-fg-0">{user.username}</div>
                </div>
                {visibleSettingsNav.map(item => (
                      <a
                        key={item.href}
                        href={item.href}
                        onClick={onNavClick(item.href)}
                        className={`block px-3 py-2 text-sm ${
                          currentPath.startsWith(item.href) ? 'bg-surface-3 text-fg-0' : 'text-fg-1 hover:bg-surface-2 hover:text-fg-0'
                        }`}
                      >
                        {item.label}
                      </a>
                    ))}
                    {visibleSettingsNav.length > 0 && <div className="my-1 border-t border-line-soft" />}
                <button
                  onClick={() => { logout(); setUserMenuOpen(false) }}
                  className="w-full px-3 py-2 text-left text-sm text-fg-1 hover:bg-surface-2 hover:text-fg-0"
                >
                  Logout
                </button>
              </div>
            )}
          </div>
          </div>
        )}
      </header>

      {/* ── Main content ── */}
      <main className="flex-1 overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0">{children}</main>

      {/* ── Mobile bottom tab bar (≤5 hits: ≤4 tabs + More) ── */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-40 border-t border-line bg-surface-1 sm:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-stretch">
          {mobileTabs.map(item => {
            const active = isActive(item)
            return (
              <a
                key={item.href}
                href={item.href}
                onClick={onNavClick(item.href)}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors duration-fast ease-out ${
                  active ? 'text-accent' : 'text-fg-2'
                }`}
                style={{ minHeight: 44 }}
              >
                <NavIcon name={item.icon} variant={active ? 'solid' : 'outline'} className="h-5 w-5" />
                <span className="text-[11px] font-medium">{item.label}</span>
              </a>
            )
          })}
          {mobileMoreGroups.length > 0 && (
            <div ref={mobileMoreRef} className="relative flex-1">
              <button
                onClick={() => setMobileMoreOpen(!mobileMoreOpen)}
                aria-haspopup="menu"
                aria-expanded={mobileMoreOpen}
                className={`flex w-full flex-col items-center justify-center gap-0.5 py-2 transition-colors duration-fast ease-out ${
                  mobileMoreGroups.some(g => g.items.some(isActive)) || mobileMoreOpen ? 'text-accent' : 'text-fg-2'
                }`}
                style={{ minHeight: 44 }}
              >
                <NavIcon name="more" className="h-5 w-5" />
                <span className="text-[11px] font-medium">More</span>
              </button>
              {mobileMoreOpen && (
                <div role="menu" className="absolute bottom-full right-1 z-50 mb-2 w-52 overflow-hidden rounded-md border border-line bg-surface-1 py-1 shadow-float">
                  {mobileMoreGroups.map((group, gi) => (
                    <Fragment key={group.id}>
                      {gi > 0 && <div className="my-1 border-t border-line-soft" />}
                      <div className="px-3 pb-0.5 pt-1 text-[10px] uppercase tracking-wider text-fg-3">{group.label}</div>
                      {group.items.map(item => {
                        const active = isActive(item)
                        return (
                          <a
                            key={item.href}
                            href={item.href}
                            onClick={onNavClick(item.href)}
                            role="menuitem"
                            aria-current={active ? 'page' : undefined}
                            className={`flex items-center gap-2.5 px-3 text-sm transition-colors duration-fast ease-out ${
                              active ? 'bg-surface-3 text-fg-0' : 'text-fg-1 hover:bg-surface-2 hover:text-fg-0'
                            }`}
                            style={{ minHeight: 44 }}
                          >
                            <NavIcon name={item.icon} variant={active ? 'solid' : 'outline'} className="h-4 w-4 text-fg-3" />
                            {item.label}
                          </a>
                        )
                      })}
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          )}
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
