import { Navigate } from 'react-router-dom'

/** @deprecated Use /settings. Kept so leftover imports still resolve. */
export function ConfigPage() {
  return <Navigate to="/settings/org" replace />
}
