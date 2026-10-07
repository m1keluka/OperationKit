/**
 * Converts Claude's --mcp-config JSON to native Grok / Codex config files.
 * Claude gets `--mcp-config <json>`; Grok reads `.grok/config.toml` (project-
 * scoped, CWD-relative); Codex reads `$CODEX_HOME/<name>.config.toml` via
 * `--profile <name>`. This module bridges the three formats so all engines
 * receive the same session MCP servers (Google Workspace overlay, Playwright
 * reviewer config, etc.) without modifying shared user-scope configs.
 *
 * Jail mode: callers must check jailEnabled() and skip these helpers — the
 * generated files live in /tmp/cc-scripts or the worktree, neither of which
 * is mounted inside the jail container. Fail-closed behavior is unchanged.
 */
import fs from 'fs'
import path from 'path'

interface McpServerDef {
  command?: string
  url?: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfigJson {
  mcpServers: Record<string, McpServerDef>
}

/** Parse Claude --mcp-config JSON; returns null on any error. */
function parseMcpJson(mcpConfigPath: string): McpConfigJson | null {
  try {
    const raw = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8')) as McpConfigJson
    if (!raw.mcpServers || typeof raw.mcpServers !== 'object') return null
    return raw
  } catch {
    return null
  }
}

/**
 * Render one MCP server definition to TOML entries.
 * Grok and Codex both use [mcp_servers.<name>] (plural).
 */
function serverToToml(name: string, def: McpServerDef): string {
  const lines: string[] = [`[mcp_servers.${name}]`]
  if (def.command) lines.push(`command = ${JSON.stringify(def.command)}`)
  if (def.url) lines.push(`url = ${JSON.stringify(def.url)}`)
  if (def.args && def.args.length > 0) {
    const argsItems = def.args.map(a => JSON.stringify(a)).join(', ')
    lines.push(`args = [${argsItems}]`)
  }
  lines.push('enabled = true')
  if (def.env && Object.keys(def.env).length > 0) {
    lines.push(`[mcp_servers.${name}.env]`)
    for (const [k, v] of Object.entries(def.env)) {
      lines.push(`${k} = ${JSON.stringify(v)}`)
    }
  }
  return lines.join('\n')
}

function mcpJsonToToml(mcpServers: Record<string, McpServerDef>): string {
  return Object.entries(mcpServers)
    .map(([name, def]) => serverToToml(name, def))
    .join('\n\n')
}

/**
 * Write a Grok project-scoped MCP config to `<workdir>/.grok/config.toml`.
 * Grok discovers this as a project config when spawned with CWD=workdir.
 * Returns the path written, or undefined if there are no servers to write
 * (mcpConfigPath absent, unreadable, or has no mcpServers entries).
 */
export function writeGrokMcpConfig(
  workdir: string,
  mcpConfigPath: string | undefined,
): string | undefined {
  if (!mcpConfigPath) return undefined
  const parsed = parseMcpJson(mcpConfigPath)
  if (!parsed || Object.keys(parsed.mcpServers).length === 0) return undefined
  const toml = mcpJsonToToml(parsed.mcpServers)
  const grokDir = path.join(workdir, '.grok')
  try {
    fs.mkdirSync(grokDir, { recursive: true })
    const configPath = path.join(grokDir, 'config.toml')
    fs.writeFileSync(configPath, toml + '\n')
    return configPath
  } catch (err) {
    console.warn('[session-harness-mcp] writeGrokMcpConfig failed:', (err as Error).message)
    return undefined
  }
}

/**
 * Write a Codex profile config to `<codexHomeDir>/<profileName>.config.toml`.
 * Codex loads it as an additive overlay when spawned with `--profile <profileName>`,
 * so existing base servers (playwright, n8n-mcp, apify, getleads) are preserved.
 * Returns the profile name to pass as --profile, or undefined if nothing to write.
 */
export function writeCodexMcpProfile(
  codexHomeDir: string,
  profileName: string,
  mcpConfigPath: string | undefined,
): string | undefined {
  if (!mcpConfigPath) return undefined
  const parsed = parseMcpJson(mcpConfigPath)
  if (!parsed || Object.keys(parsed.mcpServers).length === 0) return undefined
  const toml = mcpJsonToToml(parsed.mcpServers)
  const profilePath = path.join(codexHomeDir, `${profileName}.config.toml`)
  try {
    fs.mkdirSync(codexHomeDir, { recursive: true })
    fs.writeFileSync(profilePath, toml + '\n')
    return profileName
  } catch (err) {
    console.warn('[session-harness-mcp] writeCodexMcpProfile failed:', (err as Error).message)
    return undefined
  }
}

/**
 * Write a small rules file for Grok mapping Claude tool-name vocabulary to
 * Grok equivalents. Passed via `--rules <path>` so grok appends it to the
 * system prompt. Covers the commonest mismatches so skills that reference
 * `mcp__google-workspace__*`, `mcp__playwright__*`, or Claude's `Bash` tool
 * still work on Grok without a full SKILL.md rewrite.
 * Returns the path written, or undefined on error.
 */
export function writeGrokVocabShim(scriptDir: string, sessionId: string): string | undefined {
  const content = [
    '## Harness Vocabulary',
    '',
    'When instructions reference Claude Code tool names, use these Grok equivalents:',
    '- `mcp__google-workspace__*` → call the `google-workspace` MCP server tools',
    '- `mcp__playwright__*` → call the `playwright` MCP server tools',
    '- `mcp__<server>__<tool>` → call the named MCP server tool directly',
    "- Claude `Bash` tool → use your shell execution tool (Grok's equivalent)",
    '- Claude `Read`/`Write`/`Edit` tools → use your file read/write tools',
  ].join('\n')
  const shimPath = path.join(scriptDir, `${sessionId}.grok-rules.md`)
  try {
    fs.mkdirSync(scriptDir, { recursive: true })
    fs.writeFileSync(shimPath, content)
    return shimPath
  } catch (err) {
    console.warn('[session-harness-mcp] writeGrokVocabShim failed:', (err as Error).message)
    return undefined
  }
}
