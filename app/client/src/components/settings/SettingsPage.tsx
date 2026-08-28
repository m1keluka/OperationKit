/**
 * One Settings app: You (identity) | Secrets | Org | Agents | Platform.
 * Replaces the split Account / Secrets / Test Credentials / Config surfaces.
 */
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { PageContainer, PageHeader, Tabs } from '../ui'
import type { TabItem } from '../ui'

const YOU = 'you'
const SECRETS = 'secrets'
const ORG = 'org'
const AGENTS = 'agents'
const PLATFORM = 'platform'

const TAB_COPY: Record<string, string> = {
  [YOU]: 'GitHub, Google Workspace, your assistant, and personal secrets.',
  [SECRETS]: 'Organization and shared secrets, plus reviewer test credentials.',
  [ORG]: 'Organizations and users.',
  [AGENTS]: 'Agents, skills, and who can use them.',
  [PLATFORM]: 'Host cron jobs.',
}

export function SettingsPage() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const isGlobalAdmin = user?.role === 'admin'
  const canSecrets = isGlobalAdmin || (user?.workspaces?.some(w => w.role === 'admin') ?? false)

  const tabs: TabItem[] = [
    { key: YOU, label: 'You' },
    ...(canSecrets ? [{ key: SECRETS, label: 'Secrets' }] : []),
    ...(isGlobalAdmin
      ? [
          { key: ORG, label: 'Org' },
          { key: AGENTS, label: 'Agents' },
          { key: PLATFORM, label: 'Platform' },
        ]
      : []),
  ]

  const segment = location.pathname.split('/')[2] || YOU
  const allowed = new Set(tabs.map(t => t.key))
  // Old bookmarks: Account (Google OAuth still lands here) and Test Credentials.
  if (segment === 'account') {
    return <Navigate to={{ pathname: '/settings/you', search: location.search }} replace />
  }
  if (segment === 'test-credentials') {
    return <Navigate to="/settings/secrets" replace />
  }
  if (!allowed.has(segment)) {
    return <Navigate to="/settings/you" replace />
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Settings"
        description={TAB_COPY[segment] || 'Your Command Center settings.'}
      />
      <div className="mb-5">
        <Tabs items={tabs} value={segment} onChange={key => navigate(`/settings/${key}`)} />
      </div>
      <Outlet />
    </PageContainer>
  )
}
