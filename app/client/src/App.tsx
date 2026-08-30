import { useState, useEffect, lazy, Suspense } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate as useRouterNavigate, useParams } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Layout } from './components/Layout'
import { LoginPage } from './components/LoginPage'
import { PageTransition } from './components/PageTransition'
import { RouteFallback } from './components/RouteFallback'
import { NavContext, useNavigate } from './context/nav'
import { BoardShell, BoardThemeProvider } from './preview/BoardShell'
import { PreviewBoard } from './preview/PreviewBoard'
import { PreviewArchive } from './preview/PreviewArchive'
import { PreviewWorkspace } from './preview/PreviewWorkspace'
import type { Workspace } from '@operationkit/shared'

// Route-level code-splitting (obj 700585): the board is the landing surface
// and stays eager. Every secondary route is lazy-loaded so its code — most
// importantly the heavy BlockNote editor pulled in by DocsPage — no longer
// weighs down the initial bundle that blocks first paint.
const Dashboard = lazy(() => import('./components/Dashboard').then(m => ({ default: m.Dashboard })))
const MentorPage = lazy(() => import('./components/MentorPage').then(m => ({ default: m.MentorPage })))
const ProjectFeed = lazy(() => import('./components/ProjectFeed').then(m => ({ default: m.ProjectFeed })))
const DocsPage = lazy(() => import('./components/DocsPage').then(m => ({ default: m.DocsPage })))
const ContactsPage = lazy(() => import('./components/ContactsPage').then(m => ({ default: m.ContactsPage })))
const StatusPage = lazy(() => import('./components/StatusPage').then(m => ({ default: m.StatusPage })))
const SettingsPage = lazy(() => import('./components/settings/SettingsPage').then(m => ({ default: m.SettingsPage })))
const SettingsSecrets = lazy(() => import('./components/settings/SettingsSecrets').then(m => ({ default: m.SettingsSecrets })))
const SettingsOrg = lazy(() => import('./components/settings/SettingsOrg').then(m => ({ default: m.SettingsOrg })))
const SettingsAgents = lazy(() => import('./components/settings/SettingsAgents').then(m => ({ default: m.SettingsAgents })))
const SettingsPlatform = lazy(() => import('./components/settings/SettingsPlatform').then(m => ({ default: m.SettingsPlatform })))
const AccountSettings = lazy(() => import('./components/AccountSettings').then(m => ({ default: m.AccountSettings })))
const LoopsPage = lazy(() => import('./components/LoopsPage').then(m => ({ default: m.LoopsPage })))
const GranolaPage = lazy(() => import('./components/GranolaPage').then(m => ({ default: m.GranolaPage })))
const JobsBoard = lazy(() => import('./components/JobsBoard').then(m => ({ default: m.JobsBoard })))
const StrategiesPage = lazy(() => import('./components/StrategiesPage').then(m => ({ default: m.StrategiesPage })))
const StrategyDetailPage = lazy(() => import('./components/StrategyDetailPage').then(m => ({ default: m.StrategyDetailPage })))
const DevelopmentPage = lazy(() => import('./components/DevelopmentPage').then(m => ({ default: m.DevelopmentPage })))
/**
 * Extract /w/<workspace> from a pathname. Returns null when not a workspace path.
 * Slugs are validated lexically only — the server (via /api/workspaces and
 * scoped queries) is the source of truth for which slugs actually exist.
 */
function PreviewObjectiveRedirect() {
  const { id } = useParams()
  return <Navigate to={`/o/${id ?? ''}`} replace />
}

function workspaceFromPath(pathname: string): Workspace | null {
  const match = pathname.match(/^\/w\/([a-z0-9][a-z0-9-]{0,40})\/?$/)
  if (!match) return null
  return match[1] as Workspace
}

function NotFound() {
  const navigate = useNavigate()
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-lg font-semibold text-fg-0">Page not found</h1>
      <p className="text-sm text-fg-3">No route matches this URL.</p>
      <a
        href="/"
        onClick={e => { e.preventDefault(); navigate('/') }}
        className="mt-2 text-sm text-accent hover:underline"
      >
        Back to the board
      </a>
    </div>
  )
}

function AppContent() {
  const { user, loading } = useAuth()
  const location = useLocation()
  const routerNavigate = useRouterNavigate()
  const pathname = location.pathname

  // The board can show one OR several workspaces at once. Empty array = All.
  const [selectedWorkspaces, setSelectedWorkspaces] = useState<Workspace[]>(() => {
    const fromPath = workspaceFromPath(window.location.pathname)
    if (fromPath) return [fromPath]

    let initial: Workspace[] = []
    const storedMulti = localStorage.getItem('cc-workspaces')
    if (storedMulti) {
      try {
        const arr = JSON.parse(storedMulti)
        if (Array.isArray(arr)) initial = arr.filter((w): w is Workspace => typeof w === 'string')
      } catch { /* ignore malformed store */ }
    } else {
      const legacy = localStorage.getItem('cc-workspace')
      if (legacy && legacy !== 'all') initial = [legacy as Workspace]
    }

    // Members can only ever see their own workspaces — clamp the restored
    // selection and never leave them on an empty (= "all") set.
    if (user?.role !== 'admin' && user?.workspaces?.length) {
      const allowed = user.workspaces.map(w => w.workspace)
      initial = initial.filter(w => allowed.includes(w))
      if (initial.length === 0) initial = [allowed[0] as Workspace]
    }
    return initial
  })

  useEffect(() => {
    const fromPath = workspaceFromPath(pathname)
    if (fromPath) setSelectedWorkspaces([fromPath])
  }, [pathname])

  // After auth resolves, clamp non-admin users to their own organisations.
  // The useState initialiser above runs when user is still null (AuthContext
  // fetches /api/auth/me in a useEffect), so the member-clamp logic there is
  // dead code on first load.  This effect fires once user is known and
  // corrects selectedWorkspaces: a member is never left on the empty "all"
  // set and is always pinned to the orgs they belong to.
  // Admins are untouched — they keep their stored multi-select or All.
  useEffect(() => {
    if (!user || user.role === 'admin') return
    const allowed = (user.workspaces ?? []).map(w => w.workspace)
    if (!allowed.length) return
    setSelectedWorkspaces(prev => {
      // Don't override an explicit /w/<slug> path selection (already clamped
      // by the pathname effect above).
      const fromPath = workspaceFromPath(window.location.pathname)
      if (fromPath) return prev
      const clamped = prev.filter(w => allowed.includes(w))
      if (clamped.length > 0 && clamped.length === prev.length) return prev // no change
      const next: Workspace[] = clamped.length > 0 ? clamped : [allowed[0] as Workspace]
      // Persist the resolved selection so page reloads read the right slot.
      localStorage.setItem('cc-workspaces', JSON.stringify(next))
      localStorage.setItem('cc-workspace', next.length === 1 ? next[0] : 'all')
      return next
    })
  }, [user])

  // In-app navigation — react-router, no full document reload. Layout / ⌘K still
  // call NavContext.navigate so existing consumers do not change.
  function navigate(href: string) {
    if (href === pathname) return
    routerNavigate(href)
  }

  function handleWorkspacesChange(next: Workspace[]) {
    setSelectedWorkspaces(next)
    localStorage.setItem('cc-workspaces', JSON.stringify(next))
    localStorage.setItem('cc-workspace', next.length === 1 ? next[0] : 'all')
    // A single workspace maps to /w/<slug>; "all" or a multi-select combination
    // falls back to / so the view stays bookmarkable.
    if (pathname === '/' || workspaceFromPath(pathname)) {
      const target = next.length === 1 ? `/w/${next[0]}` : '/'
      if (pathname !== target) routerNavigate(target)
    }
  }

  // Non-board surfaces still take a single workspace (or 'all').
  const workspace: Workspace = selectedWorkspaces.length === 1 ? selectedWorkspaces[0] : 'all'

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-fg-2">Loading...</div>
      </div>
    )
  }

  if (!user) {
    return <LoginPage />
  }

  const isBoardPath = pathname === '/' || workspaceFromPath(pathname) !== null
    || /^\/o\/\d+\/?$/.test(pathname)
    || pathname === '/archive'

  // Route key for the page transition. All board paths (/, /w/<ws>) share one
  // key so switching workspace re-renders the board in place (prop change, not
  // remount) — preserving its WebSocket — while distinct routes animate.
  // All /development paths share one route key so opening the drawer (which
  // pushes /development/DEV-<id>) does not remount the board mid-interaction.
  const routeKey = pathname === '/archive'
    ? 'archive'
    : isBoardPath
    ? 'board'
    : pathname.startsWith('/development')
      ? 'development'
      : pathname.startsWith('/settings')
        ? 'settings'
        : pathname

  return (
    <NavContext.Provider value={navigate}>
    <BoardThemeProvider>
    <Layout selectedWorkspaces={selectedWorkspaces} onWorkspacesChange={handleWorkspacesChange}>
      <PageTransition routeKey={routeKey}>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<BoardShell><PreviewBoard workspaces={selectedWorkspaces} /></BoardShell>} />
          <Route path="/w/:ws" element={<BoardShell><PreviewBoard workspaces={selectedWorkspaces} /></BoardShell>} />
          <Route path="/archive" element={<BoardShell><PreviewArchive workspaces={selectedWorkspaces} /></BoardShell>} />
          <Route path="/o/:id" element={<BoardShell><PreviewWorkspace workspaces={selectedWorkspaces} /></BoardShell>} />
          <Route path="/preview/o/:id" element={<PreviewObjectiveRedirect />} />
          <Route path="/preview" element={<Navigate to="/" replace />} />
          <Route path="/preview/*" element={<Navigate to="/" replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/config" element={<Navigate to="/settings/org" replace />} />
          <Route path="/mentor" element={<MentorPage />} />
          <Route path="/assistant" element={<MentorPage />} />
          <Route path="/feed" element={<ProjectFeed workspace={workspace} />} />
          <Route path="/development/*" element={<DevelopmentPage workspace={workspace} />} />
          <Route path="/feedback" element={<Navigate to="/development" replace />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/status" element={<StatusPage />} />
          <Route path="/costs" element={<Navigate to="/dashboard" replace />} />
          <Route path="/loops" element={<LoopsPage />} />
          <Route path="/granola" element={<GranolaPage />} />
          <Route path="/jobs" element={<JobsBoard workspace={workspace} />} />
          <Route path="/strategies" element={<StrategiesPage workspace={workspace} />} />
          <Route path="/strategy/:id" element={<StrategyDetailPage workspace={workspace} />} />
          <Route path="/settings" element={<SettingsPage />}>
            <Route index element={<Navigate to="you" replace />} />
            <Route path="you" element={<AccountSettings embedded />} />
            <Route path="secrets" element={<SettingsSecrets />} />
            <Route path="org" element={<SettingsOrg />} />
            <Route path="agents" element={<SettingsAgents />} />
            <Route path="platform" element={<SettingsPlatform />} />
            <Route path="account" element={<Navigate to="/settings/you" replace />} />
            <Route path="test-credentials" element={<Navigate to="/settings/secrets" replace />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      </PageTransition>
    </Layout>
    </BoardThemeProvider>
    </NavContext.Provider>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <AppContent />
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  )
}
