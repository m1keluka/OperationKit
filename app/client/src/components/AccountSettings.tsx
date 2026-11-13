/**
 * Settings → API & MCP (obj-2200 / W1; renamed from "You" in the sprint 4b
 * settings reorg, obj 900496 — see docs/settings/SPRINT-4B-REORG.md).
 *
 * Per-user surface — renders for EVERY authenticated user (not admin-gated).
 *
 * Order (obj 900745, Operator's 2026-11-12 walkthrough — the old order buried the
 * keys under the setup prompt):
 *   1. a two-line "which key?" legend (agent key vs API key),
 *   2. "Agent keys" (MCP — a scoped tool connection for one bot),
 *   3. "Agent webhooks" (attached to agent keys, so it sits next to them),
 *   4. "API key" (the REST API — full access, acts as you),
 *   5. "Connect a coding agent" (one copy-paste setup prompt, obj 900681),
 *   6. the API-docs reference (REST curl example + live spec links; the MCP JSON
 *      snippet that duplicated the setup prompt is gone).
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

        <div data-testid="key-kinds" className="max-w-prose space-y-2 text-[12.5px] leading-relaxed text-fg-2">
          <p>Two kinds of key reach the board from outside the browser. Pick by who is calling:</p>
          <dl className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border border-line bg-surface-1 p-3">
              <dt className="font-medium text-fg-0">Agent key — for a bot (MCP)</dt>
              <dd className="mt-1 text-[12px] text-fg-2">
                A scoped tool connection for one agent (Claude Code, Cursor, Grok Bot, any MCP client). It is its own
                identity and can only reach the workspaces and board actions you tick.
              </dd>
            </div>
            <div className="rounded-md border border-line bg-surface-1 p-3">
              <dt className="font-medium text-fg-0">API key — for your scripts (REST)</dt>
              <dd className="mt-1 text-[12px] text-fg-2">
                Full REST access that acts as you everywhere. One per person. Do not hand it to a bot; give the bot
                an agent key instead.
              </dd>
            </div>
          </dl>
        </div>

        <AgentKeysSection />

        <AgentWebhooksSection />

        <div className="mt-6">
          <ApiKeySection />
        </div>

        <CodingAgentSetup />

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
