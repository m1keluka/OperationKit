/**
 * Settings → API & MCP → "Connect a coding agent" (obj 900681).
 *
 * Operator's ask (Operation Kit Feedback, 7:44–8:32): a really simple copy-paste
 * prompt you drop into Claude Code (or any coding agent) and it connects
 * itself, the way getleaves.io's integrations page works. Two steps on screen:
 * make an agent key, copy one prompt. The agent does the config editing and
 * proves the connection with `whoami`.
 *
 * The key VALUE never goes into the prompt. The prompt points at the env var
 * `CC_AGENT_KEY` and tells the agent to ask for it to be exported, never pasted
 * into chat. Purely presentational: no key scope, default or permission
 * changes here.
 */
import { useMemo, useState } from 'react'
// Direct module paths (not the '../ui' barrel) so suites that mock the barrel
// with only Modal/useConfirm (e.g. AccountSettings.google.test.tsx) still render this card.
import { Card, CardHeader, CardBody } from '../ui/Card'
import { CopyButton } from '../ui/CopyButton'
import { Tabs } from '../ui/Tabs'
import { useBranding } from '../../hooks/useBranding'

export type CodingAgent = 'claude-code' | 'cursor' | 'codex' | 'other'

export const CODING_AGENTS: { key: CodingAgent; label: string }[] = [
  { key: 'claude-code', label: 'Claude Code' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'codex', label: 'Codex' },
  { key: 'other', label: 'Other agent' },
]

const SERVER_NAME = 'command-center'
const KEY_ENV = 'CC_AGENT_KEY'

/** The install step, in the agent's own config format. */
function installStep(agent: CodingAgent, mcpUrl: string): string {
  switch (agent) {
    case 'claude-code':
      return (
        `Run this in my terminal (it reads the key from $${KEY_ENV}):\n\n` +
        `claude mcp add --transport http --scope user ${SERVER_NAME} ${mcpUrl} \\\n` +
        `  --header "Authorization: Bearer $${KEY_ENV}"\n\n` +
        `Then tell me to restart Claude Code (or run /mcp) so the new server loads.`
      )
    case 'cursor':
      return (
        `Add this entry under "mcpServers" in ~/.cursor/mcp.json (create the file if it does not exist, ` +
        `keep any servers already in it):\n\n` +
        JSON.stringify(
          { mcpServers: { [SERVER_NAME]: { url: mcpUrl, headers: { Authorization: `Bearer \${env:${KEY_ENV}}` } } } },
          null,
          2,
        ) +
        `\n\nThen tell me to reload Cursor's MCP servers (Settings → MCP).`
      )
    case 'codex':
      return (
        `Add this to ~/.codex/config.toml (keep everything already in it):\n\n` +
        `[mcp_servers.${SERVER_NAME}]\n` +
        `url = "${mcpUrl}"\n` +
        `bearer_token_env_var = "${KEY_ENV}"\n\n` +
        `Then tell me to restart Codex so the new server loads.`
      )
    case 'other':
      return (
        `Add a remote MCP server to your MCP config:\n` +
        `- name: ${SERVER_NAME}\n` +
        `- transport: Streamable HTTP\n` +
        `- URL: ${mcpUrl}\n` +
        `- header: Authorization: Bearer <value of $${KEY_ENV}>\n\n` +
        `If your client only speaks stdio, bridge it with:\n` +
        `npx -y mcp-remote ${mcpUrl} --header "Authorization:Bearer \${${KEY_ENV}}"`
      )
  }
}

/** The whole copy-paste prompt. Exported for tests. */
export function buildSetupPrompt(agent: CodingAgent, origin: string, brandName: string): string {
  const mcpUrl = `${origin}/api/mcp`
  return [
    `Connect yourself to my ${brandName} (${origin}) over MCP, so you can read and work my board and knowledge base.`,
    ``,
    `1. Key. I have an agent key in the environment variable ${KEY_ENV}. Check it is set without printing it ` +
      `(e.g. test -n "$${KEY_ENV}" && echo set). If it is not set, stop and ask me to create one at ` +
      `${origin}/settings/api-mcp (Agent keys) and export it as ${KEY_ENV}. Never ask me to paste the key into chat, ` +
      `and never write the key itself into a file you show me.`,
    ``,
    `2. Install. ${installStep(agent, mcpUrl)}`,
    ``,
    `3. Verify. Call the "whoami" tool on the ${SERVER_NAME} server and tell me the key name, workspaces and scopes ` +
      `it reports. Then call "get_attention" and summarise anything that needs me.`,
    ``,
    `Reference if you need it: ${origin}/api/openapi.json (full API) and ${origin}/api/agent (discovery).`,
  ].join('\n')
}

export function CodingAgentSetup() {
  const origin = useMemo(
    () => (typeof window !== 'undefined' ? window.location.origin : 'https://<your-install-host>'),
    [],
  )
  const { name: brandName } = useBranding()
  const [agent, setAgent] = useState<CodingAgent>('claude-code')
  const prompt = useMemo(() => buildSetupPrompt(agent, origin, brandName), [agent, origin, brandName])
  const agentLabel = CODING_AGENTS.find(a => a.key === agent)?.label ?? 'your agent'

  return (
    <Card inset className="mb-6" aria-labelledby="coding-agent-setup-heading" data-testid="coding-agent-setup">
      <CardHeader title="Connect a coding agent" eyebrow="Quick setup" />
      <CardBody className="space-y-4">
        <ol className="max-w-prose list-decimal space-y-1 pl-5 text-[12.5px] leading-relaxed text-fg-2">
          <li>
            Create an agent key in <span className="text-fg-1">Agent keys</span> below and set it in your terminal as{' '}
            <code className="font-mono text-fg-1">export {KEY_ENV}=cc_live_…</code>
          </li>
          <li>Copy this prompt and paste it into {agentLabel}. It sets itself up and checks the connection.</li>
        </ol>

        <Tabs
          items={CODING_AGENTS.map(a => ({ key: a.key, label: a.label }))}
          value={agent}
          onChange={k => setAgent(k as CodingAgent)}
        />

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 id="coding-agent-setup-heading" className="text-[13px] font-semibold text-fg-0">
              Setup prompt for {agentLabel}
            </h3>
            <CopyButton value={prompt} label="Copy prompt" />
          </div>
          <pre
            data-testid="coding-agent-prompt"
            className="max-h-80 max-w-full overflow-auto whitespace-pre-wrap rounded-md border border-line bg-surface-1 p-3 font-mono text-[12px] leading-relaxed text-fg-1"
          >
            <code>{prompt}</code>
          </pre>
          <p className="text-[12px] text-fg-3">
            The prompt never contains your key. It reads <code className="font-mono">{KEY_ENV}</code> from your
            environment.
          </p>
        </div>
      </CardBody>
    </Card>
  )
}
