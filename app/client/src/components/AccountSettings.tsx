/**
 * Settings → You (obj-2200 / W1).
 *
 * Per-user surface — renders for EVERY authenticated user (not admin-gated).
 * Cards: "API key", "Agent keys" and "My Secrets". GitHub and Google Workspace
 * moved to Settings → Connectors (obj 720115); a pointer card links there.
 */
import { useNavigate } from '../context/nav'
import { ApiKeySection } from './account-settings/ApiKeySection'
import { AgentKeysSection } from './account-settings/AgentKeysSection'
import { MySecretsSection } from './account-settings/MySecretsSection'

function ConnectorsPointer() {
  const navigate = useNavigate()
  return (
    <section className="mt-6 rounded-lg border border-line bg-surface-2 p-5">
      <h2 className="text-base font-semibold text-fg-0">GitHub and Google Workspace</h2>
      <p className="mt-1 text-xs text-fg-3">
        Linking your GitHub and Google accounts now lives in Connectors, together with who can use them.
      </p>
      <a
        href="/settings/connectors"
        onClick={e => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          e.preventDefault()
          navigate('/settings/connectors')
        }}
        className="mt-3 inline-flex min-h-[44px] items-center rounded-md border border-line bg-surface-1 px-4 text-[13px] font-medium text-fg-1 transition-colors duration-fast ease-out hover:border-line-strong hover:bg-surface-3 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[36px]"
      >
        Open Connectors
      </a>
    </section>
  )
}

export function AccountSettings({ embedded = false }: { embedded?: boolean }) {
  const body = (
    <>
        {!embedded && (
        <div className="mb-5">
          <h1 className="text-xl font-semibold text-fg-0">Account</h1>
          <p className="mt-1 text-xs text-fg-3">Your personal settings.</p>
        </div>
        )}

        <ApiKeySection />

        <AgentKeysSection />

        <ConnectorsPointer />

        <MySecretsSection />
    </>
  )

  if (embedded) {
    return <div className="max-w-3xl">{body}</div>
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto">
        {body}
      </div>
    </div>
  )
}
