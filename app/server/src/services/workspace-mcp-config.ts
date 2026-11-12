/**
 * Render workspace MCP servers into each engine's session config
 * (Sprint 7.8, obj 900620). Pure functions plus one file writer, so the
 * isolation and rendering rules are unit-testable without spawning anything.
 *
 *   Claude — `--mcp-config` JSON: `{ type: 'http'|'sse', url, headers }`. Header
 *            values are `${CC_MCP_TOKEN_<id>}` references the CLI expands from
 *            the session env, so the token never lands in the config file.
 *            Per-tool opt-outs become `--disallowedTools mcp__<key>__<tool>`.
 *   Codex  — TOML `[mcp_servers.<key>]` with `url`, `bearer_token_env_var` or
 *            `env_http_headers` (env var NAMES, not values) and `disabled_tools`.
 *   Grok   — same TOML shape (session-harness-mcp.ts renders both).
 *
 * The descriptor itself (`WorkspaceMcpSpawnServer[]`) carries no secret; it is
 * produced by services/workspace-mcp-servers.ts `spawnEnvFor(workspace)`.
 */
import fs from 'fs'
import path from 'path'
import type { WorkspaceMcpSpawnServer } from './workspace-mcp-servers.js'

export interface ClaudeRemoteServer {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

/**
 * Add workspace servers to a Claude `mcpServers` map. An existing entry with
 * the same key (Playwright, Google Workspace) always wins — a workspace server
 * can never replace a server the platform itself configured.
 */
export function mergeWorkspaceServers(
  mcpServers: Record<string, unknown>,
  servers: WorkspaceMcpSpawnServer[],
): Record<string, unknown> {
  const out = { ...mcpServers }
  for (const s of servers) {
    if (Object.prototype.hasOwnProperty.call(out, s.key)) continue
    const entry: ClaudeRemoteServer = { type: s.type, url: s.url }
    if (Object.keys(s.headers ?? {}).length > 0) entry.headers = { ...s.headers }
    out[s.key] = entry
  }
  return out
}

/** `mcp__<key>__<tool>` for every tool an admin turned off. */
export function claudeDisallowedTools(servers: WorkspaceMcpSpawnServer[]): string[] {
  const out: string[] = []
  for (const s of servers) for (const t of s.disabled_tools ?? []) out.push(`mcp__${s.key}__${t}`)
  return out
}

/** TOML for Codex / Grok. Values are env var names, never credentials. */
export function workspaceServersToToml(servers: WorkspaceMcpSpawnServer[]): string {
  return servers
    .map(s => {
      const lines = [`[mcp_servers.${s.key}]`, `url = ${JSON.stringify(s.url)}`]
      if (s.bearer_env) lines.push(`bearer_token_env_var = ${JSON.stringify(s.bearer_env)}`)
      if (s.disabled_tools?.length) lines.push(`disabled_tools = [${s.disabled_tools.map(t => JSON.stringify(t)).join(', ')}]`)
      lines.push('enabled = true')
      if (s.env_headers && Object.keys(s.env_headers).length > 0) {
        lines.push(`[mcp_servers.${s.key}.env_http_headers]`)
        for (const [h, envName] of Object.entries(s.env_headers)) lines.push(`${JSON.stringify(h)} = ${JSON.stringify(envName)}`)
      }
      return lines.join('\n')
    })
    .join('\n\n')
}

/**
 * Write (or extend) a Claude `--mcp-config` file with the workspace servers.
 * `basePath` is an existing config to merge into (may equal `outPath`).
 * Returns the path written, or `basePath` unchanged when there is nothing to
 * add or the write fails (a spawn never fails on this).
 */
export function writeWorkspaceMcpConfig(opts: {
  outPath: string
  basePath?: string
  servers: WorkspaceMcpSpawnServer[]
  mode?: number
}): string | undefined {
  if (opts.servers.length === 0) return opts.basePath
  let mcpServers: Record<string, unknown> = {}
  if (opts.basePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(opts.basePath, 'utf8')) as { mcpServers?: Record<string, unknown> }
      mcpServers = parsed.mcpServers ?? {}
    } catch { /* start fresh */ }
  }
  try {
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true })
    fs.writeFileSync(opts.outPath, JSON.stringify({ mcpServers: mergeWorkspaceServers(mcpServers, opts.servers) }, null, 2))
    if (opts.mode !== undefined) fs.chmodSync(opts.outPath, opts.mode)
    return opts.outPath
  } catch (err) {
    console.warn('[workspace-mcp] writing MCP config failed:', (err as Error).message)
    return opts.basePath
  }
}
