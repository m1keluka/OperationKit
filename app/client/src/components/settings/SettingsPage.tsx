/**
 * One Settings app: Models | API & MCP | Integrations | Secrets | Org |
 * Agents & Skills | Branding | Email | Platform.
 *
 * Sprint 4b reorg (obj 900496): renamed from the earlier You / Connectors /
 * Secrets / Seats / Org / Agents / Platform set — see
 * docs/settings/SPRINT-4B-REORG.md for the why. Old bookmarks still work via
 * the redirects below.
 */
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { PageContainer, PageHeader, Tabs } from '../ui'
import type { TabItem } from '../ui'
import { BuildFooter } from './BuildFooter'

const MODELS = 'models'
const API_MCP = 'api-mcp'
const INTEGRATIONS = 'integrations'
const SECRETS = 'secrets'
const ORG = 'org'
// Path is 'agents-skills', not 'agents': 4a's LEGACY_REDIRECTS claims
// '/settings/agents' as a redirect into the unified Agents hub (/agents),
// so this explanatory tab lives at a distinct segment to avoid colliding
// with that route.
const AGENTS = 'agents-skills'
const BRANDING = 'branding'
const EMAIL = 'email'
const PLATFORM = 'platform'

const TAB_COPY: Record<string, string> = {
  [MODELS]: 'Subscription seats, API-key providers, and which model runs by default.',
  [API_MCP]: 'Your API key, MCP access for agents, and webhooks.',
  [INTEGRATIONS]: 'Accounts agents can work in for you, like GitHub and Google Workspace.',
  [SECRETS]: 'Organization and shared secrets, plus reviewer test credentials.',
  [ORG]: 'Organizations and users.',
  [AGENTS]: 'Agents, skills, tools, and who can use them.',
  [BRANDING]: 'Logo, colors, and name shown across the app.',
  [EMAIL]: 'Outbound mail and onboarding notifications.',
  [PLATFORM]: 'Host cron jobs.',
}

export function SettingsPage() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const isGlobalAdmin = user?.role === 'admin'
  const canSecrets = isGlobalAdmin || (user?.workspaces?.some(w => w.role === 'admin') ?? false)

  const tabs: TabItem[] = [
    ...(isGlobalAdmin ? [{ key: MODELS, label: 'Models' }] : []),
    { key: API_MCP, label: 'API & MCP' },
    { key: INTEGRATIONS, label: 'Integrations' },
    ...(canSecrets ? [{ key: SECRETS, label: 'Secrets' }] : []),
    ...(isGlobalAdmin
      ? [
          { key: ORG, label: 'Org' },
          { key: AGENTS, label: 'Agents & Skills' },
          { key: BRANDING, label: 'Branding' },
          { key: EMAIL, label: 'Email' },
          { key: PLATFORM, label: 'Platform' },
        ]
      : []),
  ]

  const segment = location.pathname.split('/')[2] || API_MCP
  const allowed = new Set(tabs.map(t => t.key))
  // Old bookmarks from before the sprint 4b reorg (obj 900496), plus the
  // older Account/Test-credentials ones from before that.
  if (segment === 'account' || segment === 'you') {
    return <Navigate to={{ pathname: `/settings/${API_MCP}`, search: location.search }} replace />
  }
  if (segment === 'connectors') {
    return <Navigate to={{ pathname: `/settings/${INTEGRATIONS}`, search: location.search }} replace />
  }
  if (segment === 'seats') {
    return <Navigate to={{ pathname: `/settings/${MODELS}`, search: location.search }} replace />
  }
  if (segment === 'test-credentials') {
    return <Navigate to={`/settings/${SECRETS}`} replace />
  }
  if (!allowed.has(segment)) {
    return <Navigate to={`/settings/${tabs[0]?.key ?? API_MCP}`} replace />
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        title="Settings"
        description={TAB_COPY[segment] || 'Your settings.'}
      />
      <div className="mb-5">
        <Tabs items={tabs} value={segment} onChange={key => navigate(`/settings/${key}`)} />
      </div>
      <Outlet />
      <BuildFooter />
    </PageContainer>
  )
}
