/**
 * Settings → API & MCP → docs + copy-paste prompts (sprint 4b, obj 900496).
 *
 * Purely presentational: links to the live API contract instead of forking a
 * stale copy of it, plus an MCP config snippet and a REST curl example an
 * agent (or the person pasting into one) can copy straight in. Does not
 * change any key scope, default, or permission.
 */
import { useMemo } from 'react'
// Direct module paths (not the '../ui' barrel) so suites that mock the barrel
// with only Modal/useConfirm (e.g. AccountSettings.google.test.tsx) still render this card.
import { Card, CardHeader, CardBody } from '../ui/Card'
import { CopyButton } from '../ui/CopyButton'

function Snippet({ code }: { code: string }) {
  return (
    <pre className="max-w-full overflow-x-auto rounded-md border border-line bg-surface-1 p-3 font-mono text-[12px] leading-relaxed text-fg-1">
      <code>{code}</code>
    </pre>
  )
}

export function ApiMcpDocs() {
  const origin = useMemo(() => (typeof window !== 'undefined' ? window.location.origin : 'https://<your-install-host>'), [])

  const mcpConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            'command-center': {
              command: 'npx',
              args: ['-y', 'mcp-remote', `${origin}/api/mcp`, '--header', 'Authorization:Bearer ${CC_AGENT_KEY}'],
            },
          },
        },
        null,
        2,
      ),
    [origin],
  )

  const curlExample = `curl -s ${origin}/api/agent/attention \\\n  -H "Authorization: Bearer cc_live_…"`

  const setupPrompt =
    `Add this MCP server (${origin}) to your config (the token is one of my agent keys from ` +
    `Settings → API & MCP → Agent keys, not pasted here):\n\n${mcpConfig}\n\n` +
    `Set CC_AGENT_KEY in your environment to the key value, then call the "whoami" tool to confirm it connected.`

  return (
    <Card inset className="mt-6" aria-labelledby="api-mcp-docs-heading">
      <CardHeader title="API docs" eyebrow="Reference" />
      <CardBody className="space-y-5">
        <p className="max-w-prose text-[12.5px] leading-relaxed text-fg-2">
          The full, current contract lives at <code className="font-mono text-fg-1">GET /api/openapi.json</code>{' '}
          (live machine spec — never stale) and{' '}
          <a
            href="https://github.com/your-org/operationkit/blob/main/docs/api/README.md"
            target="_blank"
            rel="noreferrer"
            className="text-accent-hover underline-offset-2 hover:text-accent hover:underline"
          >
            docs/api/README.md
          </a>{' '}
          (auth, scopes, the agent loop, every REST route and its MCP tool). A portable prompt for handing an agent
          this whole API in one shot is{' '}
          <a
            href="https://github.com/your-org/operationkit/blob/main/docs/api/AGENT-PROMPT.md"
            target="_blank"
            rel="noreferrer"
            className="text-accent-hover underline-offset-2 hover:text-accent hover:underline"
          >
            docs/api/AGENT-PROMPT.md
          </a>
          .
        </p>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-fg-0">MCP config — copy-paste for your agent</h3>
            <CopyButton value={mcpConfig} label="Copy JSON" />
          </div>
          <p className="text-[12px] text-fg-3">
            One connector, one URL (<code className="font-mono">/api/mcp</code>) for board + knowledge-base tools.
            Swap in a named agent key from Agent keys below — the legacy full-access key is read-only over MCP.
          </p>
          <Snippet code={mcpConfig} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-fg-0">REST — copy-paste curl example</h3>
            <CopyButton value={curlExample} label="Copy curl" />
          </div>
          <p className="text-[12px] text-fg-3">
            Every call: <code className="font-mono">Authorization: Bearer cc_live_…</code>. This one reads the
            cards that need a decision (<code className="font-mono">board:read</code>).
          </p>
          <Snippet code={curlExample} />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-fg-0">“Have your agent set this up” prompt</h3>
            <CopyButton value={setupPrompt} label="Copy prompt" />
          </div>
          <p className="text-[12px] text-fg-3">
            Paste this into Claude / Grok / whatever agent you're setting up — it hands the agent the MCP config and
            tells it how to verify the connection, without you touching JSON by hand.
          </p>
          <Snippet code={setupPrompt} />
        </div>
      </CardBody>
    </Card>
  )
}
