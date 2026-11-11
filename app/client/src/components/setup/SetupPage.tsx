/**
 * /setup (obj 900497) — admin-only home for the onboarding checklist.
 * /setup/email now redirects into the real settings panel (Sprint 4b's
 * settings sidebar is merged, so the panel no longer needs a standalone copy
 * here — see Settings → Email, app/client/src/components/settings/SettingsEmail.tsx).
 */
import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { PageContainer, PageHeader } from '../ui'
import { SetupChecklist } from './SetupChecklist'

export function SetupPage() {
  const { user } = useAuth()
  const { pathname } = useLocation()
  if (user?.role !== 'admin') return <Navigate to="/" replace />

  if (pathname.startsWith('/setup/email')) {
    return <Navigate to="/settings/email" replace />
  }

  return (
    <PageContainer width="default">
      <PageHeader title="Setup" description="Three steps to get this workspace ready." />
      <SetupChecklist />
    </PageContainer>
  )
}

export default SetupPage
