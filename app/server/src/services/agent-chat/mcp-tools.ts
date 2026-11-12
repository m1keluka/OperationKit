// ── Workspace MCP servers as chat tools (obj 900620) ──
//
// An agent whose file lists `mcp` under `tools:` gets every ENABLED tool of
// every CONNECTED MCP server in the chat's workspace, named
// `mcp__<server-slug>__<tool>` (the same names a card session sees). Servers
// of any other workspace are never listed, and the call path re-checks the
// workspace (services/workspace-mcp-servers.ts `callServerTool`), so a model
// that invents a tool name cannot reach another workspace's server.
import type { ChatAgent } from './agent-defs.js'
import type { ToolSpec, ToolOutcome } from './tools.js'
import { agentHasTool, ToolUseError } from './tools.js'
import { callServerTool, enabledToolsOf, listServerRows } from '../workspace-mcp-servers.js'

export interface McpToolTarget {
  serverId: number
  serverName: string
  tool: string
}

export interface McpToolSet {
  specs: ToolSpec[]
  targets: Map<string, McpToolTarget>
}

const MAX_TOOLS = 128
const MAX_RESULT_CHARS = 20_000

/** Chat function names must match ^[A-Za-z0-9_-]{1,64}$ for every provider. */
export function chatFunctionName(slug: string, tool: string): string {
  return `mcp__${slug}__${tool}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

export function mcpToolSetFor(agent: Pick<ChatAgent, 'tools'>, workspace: string | null | undefined): McpToolSet {
  const out: McpToolSet = { specs: [], targets: new Map() }
  // agentHasTool, not tools.includes: an "all tools" bot (obj 900671) gets MCP too.
  if (!agentHasTool(agent, 'mcp')) return out
  for (const row of listServerRows(workspace)) {
    if (Number(row.enabled) === 0 || row.status !== 'connected') continue
    for (const t of enabledToolsOf(row)) {
      if (out.specs.length >= MAX_TOOLS) return out
      const name = chatFunctionName(row.slug, t.name)
      if (out.targets.has(name)) continue
      const schema = t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : {}
      out.targets.set(name, { serverId: row.id, serverName: row.name, tool: t.name })
      out.specs.push({
        type: 'function',
        function: {
          name,
          description: `[${row.name} MCP] ${t.description || t.name}`.slice(0, 1000),
          parameters: { type: 'object', properties: {}, ...schema },
        },
      })
    }
  }
  return out
}

export async function runMcpTool(
  workspace: string,
  set: McpToolSet,
  fnName: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const target = set.targets.get(fnName)
  if (!target) throw new ToolUseError(`Tool "${fnName}" is not allowed for this agent.`)
  let result: unknown
  try {
    result = await callServerTool(workspace, target.serverId, target.tool, args)
  } catch (err) {
    throw new ToolUseError(`${target.serverName}: ${(err as Error).message}`.slice(0, 500))
  }
  let text = JSON.stringify(result ?? null)
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]`
  return { result: { output: text }, summary: `Used ${target.tool} on ${target.serverName}` }
}
