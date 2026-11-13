/**
 * Settings → Secrets — the ONE place for every secret (obj 900681).
 *
 * Sub-tabs split by WHO the secret belongs to, not by where it used to live:
 *   - Mine             every signed-in user; their own `user`-scoped secrets
 *                      (was "My Secrets" on API & MCP).
 *   - Shared           workspace / global admins; the cross-scope store
 *                      (organization, Command Center, and per-user rows).
 *   - Test credentials workspace / global admins; reviewer login bundles.
 *
 * Admins land on Shared (their usual job); everyone else lands on Mine, which
 * is the only sub-tab they get. `?view=mine|shared|test` deep-links a sub-tab.
 * See docs/settings/API-MCP-SECRETS-CLEANUP.md for the structure decision.
 */
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { Tabs } from '../ui'
import type { TabItem } from '../ui'
import { SecretsPage } from '../SecretsPage'
import { TestCredentialsPage } from '../TestCredentialsPage'
import { MySecretsSection } from '../account-settings/MySecretsSection'
import { canManageSharedSecrets } from '../../lib/secretsAccess'
import { SecurityStrip } from '../secrets/SecurityStrip'

export { canManageSharedSecrets }

type View = 'mine' | 'shared' | 'test'

export function SettingsSecrets() {
  const { user } = useAuth()
  const [params, setParams] = useSearchParams()
  const isAdmin = canManageSharedSecrets(user)

  const items: TabItem[] = isAdmin
    ? [
        { key: 'shared', label: 'Shared' },
        { key: 'mine', label: 'Mine' },
        { key: 'test', label: 'Test credentials' },
      ]
    : [{ key: 'mine', label: 'Mine' }]

  const requested = params.get('view') as View | null
  const view: View = requested && items.some(i => i.key === requested) ? requested : isAdmin ? 'shared' : 'mine'

  function select(key: string) {
    const next = new URLSearchParams(params)
    next.set('view', key)
    setParams(next, { replace: true })
  }

  return (
    <div>
      {items.length > 1 && (
        <div className="mb-4">
          <Tabs items={items} value={view} onChange={select} />
        </div>
      )}
      {view === 'mine' && (
        <div className="max-w-3xl [&>section]:mt-0">
          {/* Same three promises as Shared (obj 900749): your own secrets are just as write-only. */}
          <SecurityStrip />
          <MySecretsSection />
        </div>
      )}
      {view === 'shared' && <SecretsPage embedded />}
      {view === 'test' && <TestCredentialsPage embedded />}
    </div>
  )
}
