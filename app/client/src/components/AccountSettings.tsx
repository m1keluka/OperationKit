/**
 * Settings → API & MCP (obj-2200 / W1; renamed from "You" in the sprint 4b
 * settings reorg, obj 900496 — see docs/settings/SPRINT-4B-REORG.md).
 *
 * Per-user surface — renders for EVERY authenticated user (not admin-gated).
 * Cards: "Connect a coding agent" (one copy-paste setup prompt, obj 900681),
 * "API key" (the API — full access, acts as you), "Agent keys" (MCP —
 * scoped, per-bot access), "Agent webhooks", and an API-docs reference.
 *
 * obj 900681 (Operator's Operation Kit Feedback, 7:21–7:44): this page is only
 * about reaching the board from outside. The GitHub / Google Workspace pointer
 * card is gone (those live in Settings → Integrations, the next tab over), and
 * "My Secrets" moved to Settings → Secrets → Mine. See
 * docs/settings/API-MCP-SECRETS-CLEANUP.md.
 */
import { ApiKeySection } from './account-settings/ApiKeySection'
import { AgentKeysSection } from './account-settings/AgentKeysSection'
import { AgentWebhooksSection } from './account-settings/AgentWebhooksSection'
import { ApiMcpDocs } from './account-settings/ApiMcpDocs'
import { CodingAgentSetup } from './account-settings/CodingAgentSetup'

export function AccountSettings({ embedded = false }: { embedded?: boolean }) {
  const body = (
    <>
        {!embedded && (
        <div className="mb-5">
          <h1 className="text-xl font-semibold text-fg-0">API & MCP</h1>
          <p className="mt-1 text-xs text-fg-3">Your personal settings.</p>
        </div>
        )}

        <CodingAgentSetup />

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
