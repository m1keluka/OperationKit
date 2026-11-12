/**
 * One Settings app: Models | API & MCP | Integrations | Secrets | Org |
 * Branding | Email.
 *
 * Agents & Skills is NOT a Settings tab (obj 900684): it was a second copy of
 * the registry that already lives on the Agents & Skills page (/agents). The old
 * /settings/agents-skills URL redirects there (LEGACY_REDIRECTS in lib/routes.ts).
 *
 * Sprint 4b reorg (obj 900496): renamed from the earlier You / Connectors /
 * Secrets / Seats / Org / Agents / Platform set — see
 * docs/settings/SPRINT-4B-REORG.md for the why. Old bookmarks still work via
 * the redirects below.
 *
 * obj 900686: the Platform tab is gone. '/settings/platform' has redirected to
 * Jobs since obj 900495 (LEGACY_REDIRECTS), so the tab was only a link to Jobs.
 * Its last piece, the queue auto-start switch, now lives on the Jobs page.
 */
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { PageContainer, PageHeader, Tabs } from '../ui'
import type { TabItem } from '../ui'
import { BuildFooter } from './BuildFooter'
import { canManageSharedSecrets } from '../../lib/secretsAccess'

const MODELS = 'models'
const API_MCP = 'api-mcp'
const INTEGRATIONS = 'integrations'
const SECRETS = 'secrets'
const ORG = 'org'
const BRANDING = 'branding'
const EMAIL = 'email'

const TAB_COPY: Record<string, string> = {
  [MODELS]: 'Subscription seats, API-key providers, and which model runs by default.',
  [API_MCP]: 'Connect a coding agent, your API key, MCP agent keys, and webhooks.',
  [INTEGRATIONS]: 'Accounts agents can work in for you, like GitHub and Google Workspace.',
  [SECRETS]: 'Your own secrets, shared organization secrets, and reviewer test credentials.',
  [ORG]: 'Organizations and users.',
  [BRANDING]: 'Logo, colors, and name shown across the app.',
  [EMAIL]: 'Outbound mail and onboarding notifications.',
}

export function SettingsPage() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const isGlobalAdmin = user?.role === 'admin'
  const canSharedSecrets = canManageSharedSecrets(user)

  const tabs: TabItem[] = [
    ...(isGlobalAdmin ? [{ key: MODELS, label: 'Models' }] : []),
    { key: API_MCP, label: 'API & MCP' },
    { key: INTEGRATIONS, label: 'Integrations' },
    // Everyone gets Secrets since obj 900681: "Mine" (personal secrets, folded in
    // from API & MCP) is for every user; the Shared / Test credentials sub-tabs
    // stay admin-only inside SettingsSecrets.
    { key: SECRETS, label: 'Secrets' },
    ...(isGlobalAdmin
      ? [
          { key: ORG, label: 'Org' },
          { key: BRANDING, label: 'Branding' },
          { key: EMAIL, label: 'Email' },
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
    <PageContainer width="wide" scroll="page">
      <PageHeader
        title="Settings"
        description={
          segment === SECRETS && !canSharedSecrets
            ? 'Your own secrets. Stored encrypted; never shown again after you save them.'
            : TAB_COPY[segment] || 'Your settings.'
        }
      />
      <div className="mb-5">
        <Tabs items={tabs} value={segment} onChange={key => navigate(`/settings/${key}`)} />
      </div>
      <Outlet />
      <BuildFooter />
    </PageContainer>
  )
}
