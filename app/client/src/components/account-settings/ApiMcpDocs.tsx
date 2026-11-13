/**
 * Settings → API & MCP → API docs reference (sprint 4b, obj 900496).
 *
 * Purely presentational: links to the live API contract instead of forking a
 * stale copy of it, plus a REST curl example an agent (or the person pasting
 * into one) can copy straight in. Does not change any key scope, default, or
 * permission.
 *
 * obj 900745 (Operator's 2026-11-12 walkthrough):
 *   - The "MCP config — copy-paste for your agent" JSON snippet is gone. It
 *     duplicated the Quick setup prompt in CodingAgentSetup.tsx, which already
 *     carries the MCP install step for every client (including the
 *     `npx mcp-remote` stdio bridge under "Other agent").
 *   - Links resolve on THIS install: the live spec and discovery doc are built
 *     from window.location.origin. The prose docs point at the real public
 *     repo (PUBLIC_DOCS_BASE in hooks/useBranding.ts). They used to be hard-coded to the private
 *     upstream repo, which the OSS genericizer rewrites to the non-existent
 *     github.com/your-org/operationkit on public installs.
 */
import { useMemo, type ReactNode } from 'react'
// Direct module paths (not the '../ui' barrel) so suites that mock the barrel
// with only Modal/useConfirm (e.g. AccountSettings.google.test.tsx) still render this card.
import { Card, CardHeader, CardBody } from '../ui/Card'
import { CopyButton } from '../ui/CopyButton'
import { PUBLIC_DOCS_BASE } from '../../hooks/useBranding'

/** Every link the card renders. Exported for tests. */
export function apiDocLinks(origin: string) {
  return {
    spec: `${origin}/api/openapi.json`,
    discovery: `${origin}/api/agent`,
    readme: `${PUBLIC_DOCS_BASE}/docs/api/README.md`,
    agentPrompt: `${PUBLIC_DOCS_BASE}/docs/api/AGENT-PROMPT.md`,
  }
}

const LINK = 'text-accent-hover underline-offset-2 hover:text-accent hover:underline'

function Snippet({ code }: { code: string }) {
  return (
    <pre className="max-w-full overflow-x-auto rounded-md border border-line bg-surface-1 p-3 font-mono text-[12px] leading-relaxed text-fg-1">
      <code>{code}</code>
    </pre>
  )
}

function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK}>
      {children}
    </a>
  )
}

export function ApiMcpDocs() {
  const origin = useMemo(() => (typeof window !== 'undefined' ? window.location.origin : 'https://<your-install-host>'), [])
  const links = useMemo(() => apiDocLinks(origin), [origin])

  const curlExample = `curl -s ${origin}/api/agent/attention \\\n  -H "Authorization: Bearer cc_live_…"`

  return (
    <Card inset className="mt-6" aria-labelledby="api-mcp-docs-heading" data-testid="api-mcp-docs">
      <CardHeader title="API docs" eyebrow="Reference" />
      <CardBody className="space-y-5">
        <p className="max-w-prose text-[12.5px] leading-relaxed text-fg-2">
          The full, current contract for this install is the live spec at{' '}
          <DocLink href={links.spec}><code className="font-mono">{links.spec}</code></DocLink> (never stale) and
          the discovery doc at <DocLink href={links.discovery}><code className="font-mono">{links.discovery}</code></DocLink>.
          The guide (auth, scopes, the agent loop, every REST route and its MCP tool) is{' '}
          <DocLink href={links.readme}>docs/api/README.md</DocLink>, and a portable prompt for handing an agent this
          whole API in one shot is <DocLink href={links.agentPrompt}>docs/api/AGENT-PROMPT.md</DocLink>.
        </p>

        <p className="max-w-prose text-[12px] text-fg-3">
          Connecting an agent over MCP? Use the setup prompt in <span className="text-fg-1">Connect a coding agent</span>{' '}
          above — one URL (<code className="font-mono">{origin}/api/mcp</code>) for board and knowledge-base tools,
          with a named agent key.
        </p>

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
      </CardBody>
    </Card>
  )
}
