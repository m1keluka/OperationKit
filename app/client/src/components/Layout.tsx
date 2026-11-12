import { useState, useRef, useEffect, useMemo, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react'
import { Moon, Sun } from 'lucide-react'
import { useBoardTheme } from '../preview/BoardShell'
import { useBranding } from '../hooks/useBranding'
import { BrandLogo } from './BrandLogo'
import { useAuth } from '../context/AuthContext'
import { useNavigate } from '../context/nav'
import { useWorkspaces, invalidateWorkspacesCache } from '../hooks/useWorkspaces'
import { api } from '../lib/api'
import { OrgSwitcher } from './OrgSwitcher'
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
  /**
   * Page-scroll mode (obj 900680): the DOCUMENT scrolls instead of <main>.
   * The shell grows with its content, both top bars stick to the top, and
   * <main> no longer clips. Routes opt in through usesPageScroll() in
   * lib/routes.ts. Off = the fixed-height shell the board needs.
   */
  pageScroll?: boolean
}

/* ─────────────────────────────────────────────────────────────────────────
   Navigation IA (Sprint 4a, obj 900495)
   ----------------------------------------------------------------------------
   Two places, one model each:

     • NAV_GROUPS — the primary bar: Bots (when the chat page is in the build),
       Board, Context (the knowledge base), Workflows (formerly Jobs; obj 900675). The desktop top bar and the 390px bottom
       bar render the same ≤4 items. There is no "More" group any more.
     • ACCOUNT_MENU — the avatar dropdown, the same menu on desktop and mobile:
       one flat list — Settings for everyone, then System and Agents for global
       admins, then Log out. obj 900686 dropped Archive (the board's own Archive
       button already gets you there) and the "Admin" sub-heading, which made a
       two-item menu read as a form. The old → new table is
       docs/navigation/sprint-4a-navigation.md.

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
      // obj 900675: labels renamed (Knowledge base → Context, Jobs → Workflows). The URLs stay
      // /knowledge and /jobs — they are bookmarks and deep-link targets.
      { href: '/knowledge', label: 'Context',        icon: 'docs',  aliases: ['/docs'] },
      // Worst case (admin) is Bots, Board, Context, Workflows = 4 tabs at 390px.
      { href: JOBS_ROUTE,   label: 'Workflows',      icon: 'jobs',  aliases: [],        gate: 'admin' },
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
  /** 'admin' rows are shown to global admins only. */
  section: 'account' | 'admin'
}

export const ACCOUNT_MENU: AccountMenuItem[] = [
  { href: '/settings',   label: 'Settings', icon: 'config',    aliases: [],                          section: 'account' },
  { href: SYSTEM_ROUTE,  label: 'System',   icon: 'dashboard', aliases: [...LEGACY_SYSTEM_ROUTES],    section: 'admin' },
  { href: AGENTS_ROUTE,  label: 'Agents & Skills', icon: 'system',    aliases: ['/agent-templates'],         section: 'admin' },
]


/**
 * Pages that read the org selection, and so show the top-bar org switcher
 * (obj 900666): the board family plus Knowledge, Jobs and Agents.
 */
export function isOrgScopedPath(path: string): boolean {
  return path === '/' || path === '/archive'
    || /^\/w\/[\w-]+\/?$/.test(path)
    || /^\/o\/\d+\/?$/.test(path)
    || path === '/knowledge' || path.startsWith('/knowledge/')
    || path === JOBS_ROUTE || path === AGENTS_ROUTE
}

export function Layout({ children, selectedWorkspaces, onWorkspacesChange, pageScroll = false }: LayoutProps) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const { workspaces: orgRecords, loading: orgsLoading, refresh: refreshOrgs, shortOf } = useWorkspaces()
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
  // The org switcher sits in the top bar next to "Jump to" and scopes the
  // whole app (obj 900666). It shows on every page that reads the selection:
  // the board family (/, /w/<org>, /o/<id>, /archive) plus Knowledge, Jobs
  // and Agents, which take the single selected org from App.tsx. Settings and
  // admin pages do not read it, so a control there would do nothing.
  const showWorkspace = isOrgScopedPath(currentPath)

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

  // Organizations this caller may switch between. Admins see every org; a
  // member only the ones they belong to.
  const orgChoices = useMemo(() => {
    const memberSlugs = new Set((user?.workspaces ?? []).map(w => w.workspace))
    return (orgRecords ?? [])
      .filter(w => isAdmin || memberSlugs.has(w.slug))
      .map(w => ({ slug: w.slug, label: w.name || w.slug, short: shortOf(w.slug) }))
    // shortOf reads orgRecords, which is already a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgRecords, isAdmin, user?.workspaces])
  // A member of exactly one org has nothing to switch to. Admins always get the
  // switcher — it is also where they create an organization (obj 900197 was
  // the bug where it vanished for an admin with a single org).
  const hideWorkspaceSelector = !isAdmin && orgChoices.length <= 1
  const createOrg = async (name: string, slug: string) => {
    await api.post('/admin/workspaces', { slug, name })
    // The roster is cached process-wide; drop it so the new org appears.
    invalidateWorkspacesCache()
    await refreshOrgs()
  }
  const orgSwitcherProps = {
    organizations: orgChoices,
    selected: selectedWorkspaces as string[],
    onChange: (next: string[]) => onWorkspacesChange(next as Workspace[]),
    canCreate: isAdmin,
    onCreate: createOrg,
    loading: orgsLoading,
  }

  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const userMenuMobileRef = useRef<HTMLDivElement>(null)

  // Outside-click + Escape close the open menus.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const t = e.target as Node
      if (userMenuRef.current && !userMenuRef.current.contains(t) && userMenuMobileRef.current && !userMenuMobileRef.current.contains(t)) setUserMenuOpen(false)
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setUserMenuOpen(false)
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
      {adminRows.map(item => (
        <AccountMenuRow key={item.href} item={item} active={isMenuActive(item)} rowClass={rowClass} onClick={onNavClick(item.href)} />
      ))}
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
    // In page-scroll mode it is overflow-x-clip instead: same guarantee, but
    // clip does not make this div a scroll container, so the document scrolls
    // and the sticky top bars stick to the viewport.
    <div
      data-scroll-mode={pageScroll ? 'page' : 'container'}
      className={pageScroll
        ? 'flex min-h-full flex-col overflow-x-clip bg-surface-0'
        : 'flex h-full flex-col overflow-x-hidden bg-surface-0'}
    >
      {/* ── Desktop top bar ── */}
      <header className={`${pageScroll ? 'sticky top-0 z-30 ' : ''}hidden items-center justify-between border-b border-line bg-surface-0 px-5 py-2 sm:flex`}>
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

        {/* Center: ⌘K "Jump to page" + the global org switcher (obj 900666).
            "Jump to" goes to PAGES; finding a CARD is the board's "Search
            cards" (/). Both labels say which is which. */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPaletteOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-fg-2 outline-none transition-colors duration-fast ease-out hover:border-line-strong hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-accent/60"
            aria-label="Jump to a page (command palette)"
            title="Jump to a page or setting. To find a card, use Search cards on the board (/)."
          >
            <NavIcon name="search" className="h-3.5 w-3.5" />
            <span>Jump to page…</span>
            <span className="font-mono text-[12px] text-fg-3">⌘K</span>
          </button>
          {showWorkspace && !hideWorkspaceSelector && (
            <OrgSwitcher {...orgSwitcherProps} triggerClassName="text-xs" />
          )}
        </div>

        {/* Right: notifications, theme, avatar menu (Settings, then System / Agents for admins) */}
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
      <header className={`${pageScroll ? 'sticky top-0 z-30 ' : ''}flex items-center justify-between border-b border-line bg-surface-0 px-3 py-2 sm:hidden`}
        style={{ paddingTop: 'calc(0.5rem + env(safe-area-inset-top))' }}
      >
        <a href="/" aria-label={`${brandName} home`} onClick={onNavClick('/')} className="flex min-w-0 items-center rounded-md">
          <BrandLogo theme={theme} size="sm" showName={false} allowWordmark={false} />
        </a>

        {showWorkspace && !hideWorkspaceSelector && (
          <OrgSwitcher {...orgSwitcherProps} triggerClassName="text-xs py-1 max-w-[11rem]" />
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
      <main className={`flex-1 ${pageScroll ? '' : 'overflow-hidden '}pb-[calc(3.5rem+env(safe-area-inset-bottom))] sm:pb-0`}>{children}</main>

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

