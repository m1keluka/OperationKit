/**
 * `mcp` node credentials + calls (obj 900639, card B3 of docs/design/WORKFLOWS.md §4.4 / §7.4 / §7.5).
 *
 * An `mcp` node names a `connector` and a `tool`. The engine asks a
 * {@link FlowMcpResolver} for a connection IN THE RUN'S WORKSPACE (the
 * `flow_runs.workspace` copied from `flow_definitions.workspace`, which is NOT
 * NULL) — never the triggering user's, never "any workspace".
 *
 * The host resolver uses the per-workspace MCP connections of Sprint 7.8
 * (services/workspace-mcp-servers.ts, Settings → Integrations → "Connect an MCP
 * server"). That is where a catalog `dcr_mcp` connector from connectors/registry.ts
 * becomes a usable connection: the row carries `catalog_id` = the registry id,
 * and its credential lives in the secrets store at THAT workspace's scope. A node
 * may name the connection by its slug or by that registry id.
 *
 * A connector that is not connected AND enabled in the run's workspace —
 * including one that exists, connected, only in another workspace — resolves to
 * the same `forbidden` (HTTP-403-equivalent) problem, without saying whether it
 * exists elsewhere. The call itself goes through `callServerTool`, which
 * re-checks `row.workspace === workspace` before reading the credential, so the
 * scope is enforced twice. No credential value is ever returned to the engine:
 * it gets a `call()` function, not a token.
 */
import type { FlowEffect } from '../../../shared/flow/types.js'
import type { LlmProblem as FlowProblemShape } from './flow-llm.js'

export interface FlowMcpConnection {
  /** Effect from the connector's tool annotation, when known. The node's own `effect` wins. */
  effect?: FlowEffect
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
}

export type FlowMcpResolution =
  | { ok: true; connection: FlowMcpConnection }
  | { ok: false; problem: FlowProblemShape }

export interface FlowMcpResolver {
  resolve(args: { workspace: string; connector: string; tool: string }): Promise<FlowMcpResolution>
}

/** The 403-equivalent every out-of-workspace / disabled / unknown connector gets. */
export function connectorForbidden(workspace: string, connector: string, nodeId?: string): FlowProblemShape {
  return {
    type: 'forbidden',
    status: 403,
    title: `connector "${connector}" is not enabled for workspace "${workspace}"`,
    detail: 'An mcp node can only use a connection that is connected and enabled in its own flow\'s workspace (Settings → Integrations).',
    ...(nodeId ? { node_id: nodeId } : {}),
    retryable: false,
  }
}

/**
 * Normalise an MCP `tools/call` result into a step output. `structuredContent`
 * wins; otherwise text content that is one JSON value is parsed; otherwise the
 * joined text. `isError: true` throws (the engine records `mcp_tool_error`).
 */
export class McpToolCallError extends Error {}

export function mcpResultToOutput(result: unknown): unknown {
  const r = (result ?? {}) as { content?: unknown; structuredContent?: unknown; isError?: unknown }
  const texts = Array.isArray(r.content)
    ? r.content.filter((c): c is { type: 'text'; text: string } => !!c && (c as { type?: unknown }).type === 'text' && typeof (c as { text?: unknown }).text === 'string').map((c) => c.text)
    : []
  const joined = texts.join('\n')
  if (r.isError === true) throw new McpToolCallError(joined.slice(0, 500) || 'the MCP tool reported an error')
  if (r.structuredContent !== undefined) return r.structuredContent
  if (texts.length === 0) return result ?? null
  try { return JSON.parse(joined) } catch { return joined }
}

/** Host resolver over workspace MCP connections. Lazy imports keep the engine free of db/index.ts. */
export function createWorkspaceMcpResolver(): FlowMcpResolver {
  return {
    async resolve({ workspace, connector, tool }) {
      const svc = await import('./workspace-mcp-servers.js')
      const { McpClientError } = await import('../mcp-servers/mcp-client.js')
      if (!workspace) return { ok: false, problem: connectorForbidden(workspace, connector) }
      const row = svc.listServerRows(workspace).find((r) =>
        (r.slug === connector || r.catalog_id === connector) && Number(r.enabled) !== 0 && r.status === 'connected')
      if (!row || row.workspace !== workspace) return { ok: false, problem: connectorForbidden(workspace, connector) }
      if (!svc.enabledToolsOf(row).some((t) => t.name === tool)) {
        return {
          ok: false,
          problem: {
            type: 'forbidden', status: 403, retryable: false,
            title: `tool "${tool}" is not available on connector "${connector}" in workspace "${workspace}"`,
            detail: 'The tool does not exist on that MCP server or was turned off in Settings → Integrations.',
          },
        }
      }
      const serverId = row.id
      return {
        ok: true,
        connection: {
          async call(t, args) {
            try {
              return await svc.callServerTool(workspace, serverId, t, args)
            } catch (err) {
              if (err instanceof svc.McpServerInputError) {
                throw Object.assign(new Error(err.message), { flowProblem: connectorForbidden(workspace, connector) })
              }
              if (err instanceof McpClientError) {
                const retryable = err.kind === 'unreachable' || err.kind === 'server_error'
                throw Object.assign(new Error(err.message), {
                  flowProblem: { type: `mcp_${err.kind}`, title: `MCP call to "${connector}" failed: ${err.message}`, retryable },
                })
              }
              throw err
            }
          },
        },
      }
    },
  }
}
