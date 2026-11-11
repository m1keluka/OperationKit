/**
 * Settings → API & MCP (obj-2200 / W1; renamed from "You" in the sprint 4b
 * settings reorg, obj 900496 — see docs/settings/SPRINT-4B-REORG.md).
 *
 * Per-user surface — renders for EVERY authenticated user (not admin-gated).
 * Cards: "API key" (the API — full access, acts as you), "Agent keys" (MCP —
 * scoped, per-bot access), "Agent webhooks", an API-docs + copy-paste
 * reference, an Integrations pointer card, and "My Secrets". GitHub and
 * Google Workspace moved to Settings → Integrations (obj 720115, renamed
 * from Connectors in obj 900496); a pointer card links there.
 */
import { useNavigate } from '../context/nav'
import { ApiKeySection } from './account-settings/ApiKeySection'
import { AgentKeysSection } from './account-settings/AgentKeysSection'
import { AgentWebhooksSection } from './account-settings/AgentWebhooksSection'
import { ApiMcpDocs } from './account-settings/ApiMcpDocs'
import { MySecretsSection } from './account-settings/MySecretsSection'

function IntegrationsPointer() {
  const navigate = useNavigate()
  return (
    <section className="mt-6 rounded-lg border border-line bg-surface-2 p-5">
      <h2 className="text-base font-semibold text-fg-0">GitHub and Google Workspace</h2>
      <p className="mt-1 text-xs text-fg-3">
        Linking your GitHub and Google accounts now lives in Integrations, together with who can use them.
      </p>
      <a
        href="/settings/integrations"
        onClick={e => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          e.preventDefault()
          navigate('/settings/integrations')
        }}
        className="mt-3 inline-flex min-h-[44px] items-center rounded-md border border-line bg-surface-1 px-4 text-[13px] font-medium text-fg-1 transition-colors duration-fast ease-out hover:border-line-strong hover:bg-surface-3 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:min-h-[36px]"
      >
        Open Integrations
      </a>
    </section>
  )
}

export function AccountSettings({ embedded = false }: { embedded?: boolean }) {
  const body = (
    <>
        {!embedded && (
        <div className="mb-5">
          <h1 className="text-xl font-semibold text-fg-0">API & MCP</h1>
          <p className="mt-1 text-xs text-fg-3">Your personal settings.</p>
        </div>
        )}

        <p className="mb-4 max-w-prose text-[12.5px] leading-relaxed text-fg-2">
          Two ways to reach the board from outside the browser: <span className="text-fg-1">the API</span> (plain
          REST) and <span className="text-fg-1">MCP</span> (a tool-calling connection an agent uses directly).
        </p>

        <p className="mb-2 max-w-prose text-[12px] leading-relaxed text-fg-3">
          <span className="font-medium text-fg-1">The API</span> — one key, full REST access, acts as you
          everywhere. Good for scripts and the legacy integration path; for a bot, prefer a scoped agent key below.
        </p>
        <ApiKeySection />

        <p className="mb-2 mt-6 max-w-prose text-[12px] leading-relaxed text-fg-3">
          <span className="font-medium text-fg-1">MCP</span> — one named, scoped key per agent (Grok Bot, Claude,
          any MCP client), limited to the workspaces and board actions you grant it. This is how an outside agent
          connects directly, instead of sharing your full-access key.
        </p>
        <AgentKeysSection />

        <AgentWebhooksSection />

        <ApiMcpDocs />

        <IntegrationsPointer />

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
